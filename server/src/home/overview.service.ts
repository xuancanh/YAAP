/**
 * OverviewService — "what is this agent doing" and "what is the company
 * doing", docs/mission-control.md:
 *
 *  - `agent(agentId)`: the agent's page (header and Overview tab), `GET /api/agents/:id/overview`;
 *  - `missionControl(workspaceId)`: the org chart's mission control,
 *    `GET /api/workspaces/:id/org/mission-control`.
 *
 * Like Home it owns no state and decides nothing: it reads the services that
 * own each fact, and the per-agent status comes from the helper Home uses
 * (agent-status.ts), so the three screens always agree. Every section is
 * computed on its own; a failing source lands in `partial`.
 */
import { isClosedTask } from '../chats/work-log.service';
import { APPROVAL_TTL_MS } from '../chats/turn-loop.service';
import { Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, desc, eq, gte, isNull, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import { currentAccountId } from '../accounts/account-context';
import type { DrizzleDb } from '../database/database.module';
import { orgMessages, orgUnits } from '../database/schema';
import { AgentsService } from '../agents/agents.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { WorkspaceFs } from '../files/workspace-fs.service';
import { UsageService } from '../usage/usage.module';
import { ProviderHealthService } from '../ai/provider-health';
import { HeartbeatService } from '../chats/heartbeat.service';
import { liveTurns, type LiveTurn, type LiveTurnRegistry } from '../chats/live-turns';
import { FollowsService } from '../follows/follows.service';
import { TrustService } from '../actions/trust.service';
import { ACTION_CLASSES } from '../actions/action-classes';
import { OrgService, type Organization } from '../org/org.service';
import { OrgTasksService, type OrgTask } from '../org/org-tasks.service';
import { OrgApprovalsService, summarize } from '../org/org-approvals.service';
import { OrgIntentService, type IntentNode } from '../org/org-intent.service';
import { OrgRuntimeService } from '../org/org-runtime.service';
import { govTunable } from '../org/governance-tunables';
import { agentStatuses, fixHint, primaryError, type AgentRow, type AgentStatus } from './agent-status';
import { collapseRoutine, describeRun, loopNameOf, runTitle } from './home-activity';
import { loopRunCalls, nextCronFire, ragOf } from './home.service';
import type { HomeActivity } from './home.types';
import type {
  AgentOverview, MissionControl, MissionNode, NeedsYouItem, OverviewBlocked, OverviewCause, OverviewFollow, OverviewGoal, OverviewLive, OverviewStatus, OverviewTask, TeamTile,
  OverviewDecision,
} from './overview.types';
import { chainLine, parseChain } from '../org/decision-routing';

const DAY_MS = 24 * 60 * 60_000;
const RECENT_DAYS = 7;
const DONE_DAYS = 14;
const LIST_LIMIT = 10;

const safe = <T,>(raw: string | null | undefined, fallback: T): T => { try { return raw ? (JSON.parse(raw) as T) : fallback; } catch { return fallback; } };
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The live turn as the overviews carry it (the registry row minus its ids). */
function liveOf(t: LiveTurn | null): OverviewLive | null {
  return t ? { sessionId: t.sessionId, sessionName: t.sessionName, origin: t.origin, startedAt: t.startedAt, tool: t.tool, toolLabel: t.toolLabel, toolAt: t.toolAt, calls: t.calls } : null;
}

export function overviewStatus(s: AgentStatus): OverviewStatus {
  return {
    id: s.id, name: s.name, emoji: s.emoji, colors: s.colors, title: s.title, state: s.state, doing: s.doing, taskId: s.taskId,
    lastActiveAt: s.lastActiveAt, lastBeatAt: s.lastBeatAt, errors: s.errors, isChief: s.isChief,
    live: liveOf(s.live), doingSince: s.doingSince, waitingOnYou: s.waitingOnYou, blockedCount: s.blocked.length, open: s.open,
    lastRunAt: s.lastRunAt, memberStatus: s.memberStatus,
  };
}

function tile(s: AgentStatus): TeamTile {
  return { id: s.id, name: s.name, emoji: s.emoji, colors: s.colors, title: s.title, state: s.state, doing: s.doing, taskId: s.taskId, lastBeatAt: s.lastBeatAt, open: s.open, liveLabel: s.live?.toolLabel ?? '' };
}

@Injectable()
export class OverviewService {
  /** The live-turn registry; tests swap in their own. */
  live: LiveTurnRegistry = liveTurns;

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly workspaces: WorkspacesService,
    private readonly agents: AgentsService,
    @Optional() private readonly config?: ConfigService,
    @Optional() private readonly fs?: WorkspaceFs,
    @Optional() private readonly usage?: UsageService,
    @Optional() private readonly providerHealth?: ProviderHealthService,
    @Optional() private readonly heartbeat?: HeartbeatService,
    @Optional() private readonly follows?: FollowsService,
    @Optional() private readonly trust?: TrustService,
    @Optional() private readonly org?: OrgService,
    @Optional() private readonly tasks?: OrgTasksService,
    @Optional() private readonly approvals?: OrgApprovalsService,
    @Optional() private readonly intent?: OrgIntentService,
    @Optional() private readonly runtime?: OrgRuntimeService,
  ) {}

  private companiesEnabled(): boolean { return this.config?.get<boolean>('companiesEnabled') !== false; }

  /** The workspace's company and the facts every status needs. */
  private async context(workspaceId: string) {
    const ws = await this.workspaces.get(workspaceId); // 404s for a workspace we cannot see
    const agents = await this.agents.list({ workspaceId });
    const org = this.companiesEnabled() && this.org ? await this.org.byWorkspace(workspaceId).catch(() => null) : null;
    const orgOn = Boolean(org && ws.orgMode !== 'off');
    const company = orgOn ? org : null;
    const orgTasks = company && this.tasks ? await this.tasks.list(company.id).catch(() => [] as OrgTask[]) : [];
    const members = company ? await this.org!.members(company.id).catch(() => []) : [];
    const pending = company && this.approvals ? await this.approvals.pendingForOwner(company.id).catch(() => []) : [];
    const ceoEscalations = new Set(pending.filter((a) => a.kind === 'escalation').map((a) => safe<{ taskId?: string }>(a.payload, {}).taskId).filter((x): x is string => Boolean(x)));
    return { ws, agents, org: company, orgOn, orgTasks, members, pending, ceoEscalations };
  }

  private statuses(c: Awaited<ReturnType<OverviewService['context']>>, now: Date, keep?: string): Promise<AgentStatus[]> {
    // A terminated seat still has a page: its own status, outside the company.
    const members = keep ? c.members.filter((m) => !(m.agentId === keep && m.status === 'terminated')) : c.members;
    return agentStatuses(
      { db: this.db, agents: this.agents, providerHealth: this.providerHealth, tasks: this.tasks, live: this.live },
      { workspaceId: c.ws.id, org: c.org, orgOn: c.orgOn, agents: c.agents, orgTasks: c.orgTasks, members, ceoEscalations: c.ceoEscalations, now },
    );
  }

  // ---- the agent's page ----

  async agent(agentId: string, opts: { now?: Date } = {}): Promise<AgentOverview> {
    const now = opts.now ?? new Date();
    const agent = await this.agents.get(agentId);
    if (!agent.workspaceId) throw new NotFoundException(`agent ${agentId} has no workspace`);
    const c = await this.context(agent.workspaceId);
    const partial: string[] = [];
    const attempt = async <T,>(section: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
      try { return await fn(); } catch { partial.push(section); return fallback; }
    };
    const statuses = await this.statuses(c, now, agentId);
    const me = statuses.find((s) => s.id === agentId);
    if (!me) throw new NotFoundException(`agent ${agentId}`);
    const names = new Map(c.agents.map((a) => [a.id, a.name]));
    const member = c.members.find((m) => m.agentId === agentId && m.status !== 'terminated') ?? null;
    const recentFiles = this.fs ? await this.fs.recent(c.ws.id, 300).catch(() => []) : [];
    const myFiles = recentFiles.filter((f) => f.updatedBy.kind === 'agent' && f.updatedBy.id === agentId);
    const lastComments = new Map<string, OverviewTask['lastComment']>();
    const commentOf = async (t: OrgTask) => {
      if (!c.org || !this.tasks) return null;
      if (!lastComments.has(t.id)) {
        const m = (await this.tasks.messages(c.org.id, { taskId: t.id, limit: 1 }).catch(() => [])).at(-1);
        lastComments.set(t.id, m ? { at: m.createdAt, from: m.fromAgentId ? names.get(m.fromAgentId) ?? 'an agent' : 'You', text: clip(m.text, 280) } : null);
      }
      return lastComments.get(t.id)!;
    };
    const card = async (t: OrgTask, withComment = true): Promise<OverviewTask> => {
      const brief = safe<{ outcome?: string; done_when?: string }>(t.brief, {});
      const startedAt = t.claimedAt ?? null;
      const wrote = startedAt ? myFiles.filter((f) => f.updatedAt >= startedAt).map((f) => f.path) : [];
      return {
        id: t.id, key: t.key, source: 'org', title: t.title, status: t.status, outcome: brief.outcome ?? '', doneWhen: brief.done_when ?? '',
        startedAt, updatedAt: t.updatedAt, createdAt: t.createdAt, dueAt: t.dueAt,
        lastComment: withComment ? await commentOf(t) : null,
        files: [...new Set([...safe<string[]>(t.fileScope, []), ...wrote])].slice(0, 8),
        acceptedBy: t.acceptedBy ?? '', assigneeName: t.assigneeAgentId ? names.get(t.assigneeAgentId) ?? '' : '',
      };
    };
    const own = await this.agents.listTasks(agentId).catch(() => []);
    const ownCard = (t: (typeof own)[number]): OverviewTask => ({
      id: t.id, key: t.key, source: 'agent', title: t.title, status: t.status, outcome: t.note ?? '', doneWhen: '', startedAt: null, updatedAt: t.updatedAt, createdAt: t.createdAt,
      dueAt: null, lastComment: null, files: [], acceptedBy: '', assigneeName: agent.name,
    });
    const mine = c.orgTasks.filter((t) => t.assigneeAgentId === agentId);
    const byUrgency = (a: { dueAt: string | null; createdAt: string }, b: { dueAt: string | null; createdAt: string }) =>
      (a.dueAt ?? '9999').localeCompare(b.dueAt ?? '9999') || a.createdAt.localeCompare(b.createdAt);

    const tasksSection = await attempt('tasks', async () => {
      const nowTask = me.taskId ? mine.find((t) => t.id === me.taskId && t.status !== 'blocked') ?? c.orgTasks.find((t) => t.id === me.taskId && t.status === 'in_review' && t.reviewerAgentId === agentId) : undefined;
      const ownDoing = own.filter((t) => t.status === 'doing').sort((x, y) => y.updatedAt.localeCompare(x.updatedAt))[0];
      const blocked: OverviewBlocked[] = [];
      for (const b of me.blocked) { const t = mine.find((x) => x.id === b.taskId); if (t) blocked.push({ ...await card(t), blocker: b.blocker }); }
      for (const t of own.filter((x) => x.status === 'blocked')) blocked.push({ ...ownCard(t), blocker: { reason: t.note ?? '', waitsOn: { kind: 'unknown', id: null, name: '', taskId: null }, since: t.updatedAt } });
      const queued = mine.filter((t) => ['todo', 'waiting', 'claimed'].includes(t.status) && t.id !== nowTask?.id).sort(byUrgency);
      const queue = [...await Promise.all(queued.slice(0, LIST_LIMIT).map((t) => card(t, false))), ...own.filter((t) => t.status === 'todo').slice(0, LIST_LIMIT).map(ownCard)].slice(0, LIST_LIMIT);
      const reviews = await Promise.all(c.orgTasks.filter((t) => t.status === 'in_review' && t.reviewerAgentId === agentId && t.id !== nowTask?.id).slice(0, LIST_LIMIT).map((t) => card(t, false)));
      const horizon = new Date(now.getTime() - DONE_DAYS * DAY_MS).toISOString();
      const done = [
        ...await Promise.all(mine.filter((t) => t.status === 'done' && t.updatedAt >= horizon).map((t) => card(t, false))),
        ...own.filter((t) => t.status === 'done' && t.updatedAt >= horizon).map(ownCard),
      ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 8);
      return { now: nowTask ? await card(nowTask) : ownDoing ? ownCard(ownDoing) : null, blocked, queue, reviews, done };
    }, { now: null, blocked: [], queue: [], reviews: [], done: [] } as Pick<AgentOverview, 'now' | 'blocked' | 'queue' | 'reviews' | 'done'>);

    const [heartbeat, follows, recent, goals, health] = await Promise.all([
      attempt('heartbeat', async () => {
        if (!this.heartbeat) return null;
        const v = await this.heartbeat.view(agentId, now);
        return { enabled: v.enabled, cron: v.cron, nextDueAt: v.nextDueAt, lastBeatAt: v.lastBeatAt, lastRunAt: v.lastRunAt, lastReason: v.lastReason, runsToday: v.runsToday, dailyRunCap: v.dailyRunCap };
      }, null as AgentOverview['heartbeat']),
      attempt('follows', async (): Promise<OverviewFollow[]> => {
        if (!this.follows) return [];
        const rows = await this.follows.list({ kind: 'agent', id: agentId }, c.ws.id);
        return rows.filter((r) => (r.attentionAt && (!r.lastSeenAt || r.attentionAt > r.lastSeenAt)) || r.unseenCount > 0).slice(0, 8).map((r) => ({
          id: r.id, targetKind: r.targetKind, targetId: r.targetId, title: r.title, attention: r.attention ?? '', unseen: r.unseenCount, lastActivityAt: r.lastActivityAt ?? null, lastActorName: r.lastActorName ?? '',
        }));
      }, [] as OverviewFollow[]),
      attempt('recent', () => this.recent(agentId, agent.name, c.org, c.orgTasks, names, now), [] as HomeActivity[]),
      attempt('goals', () => this.goalsOf(agentId, c.org, now), [] as OverviewGoal[]),
      attempt('health', () => this.health(agentId, c.ws.id, c.org, me, now), { errors: me.errors, spend: { todayUsd: null, d30Usd: null, monthUsd: null, monthCapUsd: null, series: [] }, trust: [], wip: null } as AgentOverview['health']),
    ]);
    const needsYou = await attempt('needsYou', () => this.needsYou(agentId, c, mine), [] as NeedsYouItem[]);
    // Decisions for it as a manager (docs/owners-seat.md §7).
    const decisions = await attempt('decisions', async (): Promise<OverviewDecision[]> => {
      if (!c.org || !this.approvals) return [];
      const org = c.org;
      const held = (await this.approvals.list(org.id, { status: 'pending' })).filter((a) => a.holder === `agent:${agentId}`);
      const nameOfHolder = (h: string) => (h === 'ceo' ? 'CEO' : h === 'chief' ? names.get(org.chiefOfStaffAgentId ?? '') ?? 'Chief' : names.get(h.replace(/^agent:/, '')) ?? (h.startsWith('human:') ? 'a person' : h));
      return held.sort((x, y) => (x.createdAt < y.createdAt ? -1 : 1)).slice(0, LIST_LIMIT).map((a) => ({
        approvalId: a.id, kind: a.kind, title: summarize(a.kind, safe<Record<string, unknown>>(a.payload, {})), from: nameOfHolder(a.requestedBy),
        chainLine: chainLine(parseChain(a.chain), nameOfHolder, { you: `agent:${agentId}` }), reserved: a.reserved ?? '', urgency: a.urgency ?? 'normal', hopDeadline: a.hopDeadline ?? null, createdAt: a.createdAt,
      }));
    }, [] as OverviewDecision[]);
    const loudest = primaryError(me.errors);
    const cause: OverviewCause | null = loudest
      ? { kind: loudest.kind, message: loudest.message, at: loudest.at, sessionId: loudest.sessionId ?? null, taskId: loudest.taskId ?? null, fix: fixHint(loudest), rerunTurnId: null }
      : null;
    // The Work log's Rerun (docs/work-log.md): when the failing run is the
    // newest of a work session and it failed or stopped, it can run again.
    if (cause?.sessionId) {
      cause.rerunTurnId = await attempt('rerun', async () => {
        const res = await this.db.execute(sql`
          SELECT t."id", t."status", COALESCE(ot."status", atk."status") AS "taskStatus"
          FROM chat_turns t JOIN chat_sessions s ON s."id" = t."sessionId"
          LEFT JOIN org_tasks ot ON s."taskKind" = 'org' AND ot."id" = s."taskId"
          LEFT JOIN agent_tasks atk ON s."taskKind" = 'agent' AND atk."id" = s."taskId"
          WHERE t."sessionId" = ${cause.sessionId} AND s."kind" = 'work' AND s."accountId" = ${currentAccountId()}
          ORDER BY t."seq" DESC LIMIT 1`);
        const last = ((res as unknown as { rows?: Array<{ id: string; status: string; taskStatus: string | null }> }).rows ?? [])[0];
        return last && (last.status === 'error' || last.status === 'stopped') && !isClosedTask(last.taskStatus) ? last.id : null;
      }, null as string | null);
    }

    const loops = safe<Array<{ name: string; cron?: string; enabled?: boolean }>>(agent.loops, []);
    let nextLoop: AgentOverview['nextLoop'] = null;
    for (const l of loops) {
      if (l.enabled === false || !l.cron || l.name === 'heartbeat') continue;
      const at = nextCronFire(l.cron, now);
      if (at && (!nextLoop || at.toISOString() < nextLoop.at)) nextLoop = { name: l.name, at: at.toISOString(), cron: l.cron };
    }

    const reports = statuses.filter((s) => s.reportsToAgentId === agentId);
    const manager = me.reportsToAgentId ? statuses.find((s) => s.id === me.reportsToAgentId) ?? null : null;
    const team = await attempt('team', async () => {
      const unit = c.org ? (await this.db.select().from(orgUnits).where(and(eq(orgUnits.orgId, c.org.id), eq(orgUnits.leadAgentId, agentId), isNull(orgUnits.archivedAt))).limit(1)).at(0) : undefined;
      const humans = c.org && this.org ? (await this.org.humans(c.org.id)).filter((h) => h.role === 'employee' && h.reportsToAgentId === agentId) : [];
      return {
        manager: manager ? tile(manager) : null, reports: reports.map(tile),
        humans: humans.map((h) => ({ memberAccountId: h.memberAccountId, title: h.title })),
        unit: unit ? { id: unit.id, name: unit.parentUnitId === null ? 'Company' : unit.name, slug: unit.slug } : null,
      };
    }, { manager: manager ? tile(manager) : null, reports: reports.map(tile), humans: [], unit: null } as AgentOverview['team']);

    return {
      agentId, workspaceId: c.ws.id, generatedAt: now.toISOString(),
      agent: { id: agent.id, name: agent.name, emoji: agent.emoji, colors: agent.colors, title: me.title, role: agent.role ?? '', provider: agent.provider ?? '', model: agent.model ?? '', isChief: me.isChief, hasReports: reports.length > 0 },
      inCompany: Boolean(member),
      status: overviewStatus(me),
      cause, needsYou,
      heartbeat, nextLoop, ...tasksSection, follows,
      files: myFiles.slice(0, 8).map((f) => ({ path: f.path, version: f.version, updatedAt: f.updatedAt })),
      recent, goals, team, health, dashboard: agent.dashboard ?? '', partial, decisions,
    };
  }

  /** What waits on the owner: actions it queued and connections it asks to
   *  use (its inbox, as the caller may see it), and the company's pending
   *  cards about it: an escalation of one of its tasks, an approval it asked for. */
  private async needsYou(agentId: string, c: Awaited<ReturnType<OverviewService['context']>>, mine: OrgTask[]): Promise<NeedsYouItem[]> {
    const out: NeedsYouItem[] = [];
    for (const e of await this.agents.listEvents(agentId, 200)) {
      if (e.kind !== 'action_pending' && e.kind !== 'approval_request') continue;
      // A paused call waits only APPROVAL_TTL_MS; after that the turn loop has
      // denied it, so an old request is no longer something to answer.
      if (e.kind === 'approval_request' && Date.now() - Date.parse(e.createdAt) > APPROVAL_TTL_MS + 60_000) continue;
      out.push({ id: `event:${e.id}`, kind: e.kind === 'action_pending' ? 'action' : 'connection', title: e.title, detail: clip(e.body, 240), at: e.createdAt, eventId: e.id, approvalId: null, taskId: null, sessionId: e.sessionId || null });
    }
    const myTasks = new Map(mine.map((t) => [t.id, t]));
    for (const a of c.pending) {
      const payload = safe<Record<string, unknown> & { taskId?: string; reason?: string }>(a.payload, {});
      const task = typeof payload.taskId === 'string' ? myTasks.get(payload.taskId) : undefined;
      const asked = a.requestedBy === `agent:${agentId}` || (a.requestedBy === 'chief' && c.org?.chiefOfStaffAgentId === agentId);
      if (a.kind === 'escalation' ? !task : !asked) continue;
      out.push({
        id: `approval:${a.id}`, kind: a.kind === 'escalation' ? 'escalation' : 'approval',
        title: task ? `Escalated: ${task.title}` : clip(summarize(a.kind, payload), 200),
        detail: clip(typeof payload.reason === 'string' ? payload.reason : a.recommendation, 240),
        at: a.createdAt, eventId: null, approvalId: a.id, taskId: task?.id ?? null, sessionId: null,
      });
    }
    return out.sort((x, y) => x.at.localeCompare(y.at));
  }

  /** The agent's week: its loop runs (routine ones collapsed, as on Home), loud events and its task comments. */
  private async recent(agentId: string, agentName: string, org: Organization | null, orgTasks: OrgTask[], names: Map<string, string>, now: Date): Promise<HomeActivity[]> {
    const horizon = new Date(now.getTime() - RECENT_DAYS * DAY_MS).toISOString();
    const out: HomeActivity[] = [];
    const events = (await this.agents.listEvents(agentId, 120)).filter((x) => x.createdAt >= horizon);
    const runs = events.filter((e) => e.kind === 'loop_run');
    for (const e of events.filter((x) => ['loop_error', 'brief', 'action_done', 'action_failed', 'budget_stop', 'escalation'].includes(x.kind))) {
      out.push({ id: `event:${e.id}`, at: e.createdAt, kind: 'agent', title: e.title, detail: clip(e.body, 160), actor: agentName, ref: { type: 'agent', id: agentId } });
    }
    const callsOf = await loopRunCalls(this.db, runs, horizon);
    const taskRef = (id: string | null) => {
      if (!id) return null;
      const t = orgTasks.find((x) => x.id === id || x.id.startsWith(id));
      return t ? { type: 'task', id: t.id } : null;
    };
    const routine: Parameters<typeof collapseRoutine>[0] = [];
    for (const e of runs) {
      const loop = loopNameOf(e.title);
      const s = describeRun(callsOf.get(e.id) ?? []);
      if (s.notable) out.push({ id: `event:${e.id}`, at: e.createdAt, kind: 'agent', title: runTitle(loop, s), detail: clip(e.body, 160), actor: agentName, ref: taskRef(s.taskId) ?? { type: 'agent', id: agentId }, loop });
      else routine.push({ agentId, agentName, loop, run: { id: `event:${e.id}`, at: e.createdAt, title: e.title, detail: clip(e.body, 160) } });
    }
    out.push(...collapseRoutine(routine));
    if (org) {
      const mineMoved = orgTasks.filter((t) => t.assigneeAgentId === agentId && (t.status === 'done' || t.status === 'blocked') && t.updatedAt >= horizon);
      for (const t of mineMoved) out.push({ id: `task:${t.id}:${t.status}`, at: t.updatedAt, kind: 'task', title: `${t.status === 'done' ? 'Done' : 'Blocked'}: ${t.title}`, detail: '', actor: agentName, ref: { type: 'task', id: t.id } });
      // What it said: its comments on task timelines and its posts to the company log.
      const said = await this.db.select().from(orgMessages)
        .where(and(eq(orgMessages.orgId, org.id), eq(orgMessages.fromAgentId, agentId), gte(orgMessages.createdAt, horizon)))
        .orderBy(desc(orgMessages.createdAt)).limit(10);
      const titles = new Map(orgTasks.map((t) => [t.id, t.title]));
      for (const m of said) {
        const on = m.taskId ? titles.get(m.taskId) : null;
        out.push({ id: `message:${m.id}`, at: m.createdAt, kind: 'decision', title: on ? `Commented on "${clip(on, 80)}"` : 'Posted to the company log', detail: clip(m.text, 200), actor: names.get(agentId) ?? agentName, ref: m.taskId ? { type: 'task', id: m.taskId } : null });
      }
    }
    return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 30);
  }

  private async goalsOf(agentId: string, org: Organization | null, now: Date): Promise<OverviewGoal[]> {
    if (!org || !this.intent) return [];
    const out: OverviewGoal[] = [];
    const walk = (nodes: IntentNode[]) => {
      for (const n of nodes) {
        if (n.ownerAgentId === agentId && (n.kind === 'objective' || n.kind === 'key_result') && !['achieved', 'abandoned', 'done', 'cancelled'].includes(n.status)) {
          out.push({
            id: n.id, kind: n.kind, title: n.title, progress: n.progress, confidence: n.confidence ?? null, rag: ragOf(n), atRisk: Boolean(n.atRisk), atRiskReason: n.atRiskReason ?? '',
            currentValue: n.currentValue ?? null, targetValue: n.targetValue ?? null, unitLabel: n.unitLabel ?? '', dueAt: n.dueAt ?? null,
          });
        }
        walk(n.children as IntentNode[]);
      }
    };
    walk(await this.intent.intentTree(org.id, { now }));
    const order = { red: 0, amber: 1, grey: 2, green: 3 } as const;
    return out.sort((a, b) => order[a.rag] - order[b.rag] || a.progress - b.progress);
  }

  private async health(agentId: string, workspaceId: string, org: Organization | null, me: AgentStatus, now: Date): Promise<AgentOverview['health']> {
    const spend: AgentOverview['health']['spend'] = { todayUsd: null, d30Usd: null, monthUsd: null, monthCapUsd: null, series: [] };
    if (this.usage) {
      const u = await this.usage.agentUsage(agentId, 30, now);
      spend.d30Usd = u.totals.usd;
      spend.series = u.series.map((d) => ({ day: d.day, usd: d.usd }));
      spend.todayUsd = u.series.find((d) => d.day === now.toISOString().slice(0, 10))?.usd ?? 0;
    }
    if (org && this.tasks && this.org) {
      const month = now.toISOString().slice(0, 7);
      spend.monthUsd = (await this.tasks.runs(org.id, { limit: 500 })).filter((r) => r.agentId === agentId && r.startedAt.slice(0, 7) === month).reduce((s, r) => s + r.usd, 0);
      spend.monthCapUsd = (await this.org.budget(org.id, 'agent', agentId))?.monthlyUsd || null;
    }
    const trust: AgentOverview['health']['trust'] = [];
    if (this.trust) {
      for (const cls of ACTION_CLASSES) {
        const e = await this.trust.effective(workspaceId, agentId, cls).catch(() => null);
        if (e) trust.push({ actionClass: cls, effective: e.effective, ceiling: e.ceiling });
      }
    }
    return { errors: me.errors, spend, trust, wip: org && me.memberStatus ? { open: me.open, limit: govTunable(org, 'capacity.wipPerMember') } : null };
  }

  // ---- the org mission control ----

  async missionControl(workspaceId: string, opts: { now?: Date } = {}): Promise<MissionControl> {
    const now = opts.now ?? new Date();
    const c = await this.context(workspaceId);
    if (!c.org) throw new NotFoundException('this workspace runs no company');
    const org = c.org;
    const partial: string[] = [];
    const statuses = await this.statuses(c, now);
    const seated = new Map(c.members.filter((m) => m.status !== 'terminated').map((m) => [m.agentId, m]));
    const units = await this.db.select().from(orgUnits).where(and(eq(orgUnits.orgId, org.id), isNull(orgUnits.archivedAt))).catch(() => { partial.push('units'); return []; });
    const leads = new Map(units.map((u) => [u.leadAgentId, u.id]));

    // Spend: the same sources as Home — org runs this month against the envelopes, plus today's chat ledger.
    const today = now.toISOString().slice(0, 10);
    const perAgentToday = new Map<string, number>();
    const perAgentMonth = new Map<string, { usd: number; cap: number }>();
    let spendTodayUsd: number | null = null; let monthUsd: number | null = null; let monthCapUsd: number | null = null;
    try {
      if (this.runtime) {
        const tree = await this.runtime.spendTree(org.id, now);
        monthUsd = tree.company.usd; monthCapUsd = tree.company.monthlyUsd || null;
        spendTodayUsd = tree.series.find((d: { day: string; usd: number }) => d.day === today)?.usd ?? 0;
        for (const m of tree.members) perAgentMonth.set(m.agentId, { usd: m.usd, cap: m.monthlyUsd });
        const runsToday = (await this.tasks!.runs(org.id, { limit: 500 })).filter((r) => r.startedAt.slice(0, 10) === today);
        for (const r of runsToday) perAgentToday.set(r.agentId, (perAgentToday.get(r.agentId) ?? 0) + r.usd);
      }
      if (this.usage) {
        const u = await this.usage.workspaceUsage(workspaceId, 1, now);
        spendTodayUsd = (spendTodayUsd ?? 0) + (u.series.find((d) => d.day === today)?.usd ?? 0);
        for (const a of u.byAgent) perAgentToday.set(a.agentId, (perAgentToday.get(a.agentId) ?? 0) + a.usd);
      }
    } catch { partial.push('spend'); }

    const wipLimit = govTunable(org, 'capacity.wipPerMember');
    const nodes: MissionNode[] = statuses.filter((s) => seated.has(s.id)).map((s) => {
      const m = seated.get(s.id)!;
      return {
        ...overviewStatus(s), agentId: s.id, reportsToAgentId: m.reportsToAgentId ?? null, leadsUnitId: leads.get(s.id) ?? null,
        wip: { open: s.open, limit: wipLimit },
        spend: { todayUsd: perAgentToday.get(s.id) ?? 0, monthUsd: perAgentMonth.get(s.id)?.usd ?? 0, monthCapUsd: perAgentMonth.get(s.id)?.cap ?? 0 },
        waits: s.blocked.map((b) => ({ taskId: b.taskId, title: b.title, waitsOn: b.blocker.waitsOn, reason: b.blocker.reason, since: b.blocker.since })),
        liveLabel: s.live?.toolLabel ?? '',
      };
    });
    const edges = nodes.flatMap((n) => n.waits.filter((w) => w.waitsOn.kind === 'ceo' || (w.waitsOn.kind === 'agent' && w.waitsOn.id)).map((w) => ({ from: n.agentId, to: w.waitsOn.kind === 'ceo' ? 'ceo' : w.waitsOn.id!, taskId: w.taskId, title: w.title })));
    const count = (st: MissionNode['state']) => nodes.filter((n) => n.state === st).length;
    const openByUnit = new Map<string, number>();
    for (const t of c.orgTasks) if (t.unitId && !['done', 'cancelled'].includes(t.status)) openByUnit.set(t.unitId, (openByUnit.get(t.unitId) ?? 0) + 1);
    const humans = await this.org!.humans(org.id).catch(() => { partial.push('humans'); return []; });

    return {
      workspaceId, orgId: org.id, generatedAt: now.toISOString(),
      company: { name: org.name, status: org.status, mode: c.ws.orgMode, chiefAgentId: org.chiefOfStaffAgentId ?? null },
      totals: {
        working: count('working'), blocked: count('blocked'), idle: count('idle'), paused: count('paused'), error: count('error'),
        tasksInFlight: c.orgTasks.filter((t) => ['claimed', 'in_progress', 'in_review'].includes(t.status)).length,
        waitingOnYou: c.pending.length,
        spendTodayUsd, monthUsd, monthCapUsd,
      },
      units: units.map((u) => ({ id: u.id, name: u.parentUnitId === null ? 'Company' : u.name, slug: u.slug, leadAgentId: u.leadAgentId, parentUnitId: u.parentUnitId, openTasks: openByUnit.get(u.id) ?? 0 })),
      nodes,
      humans: humans.filter((h) => h.role === 'employee').map((h) => ({ id: h.id, memberAccountId: h.memberAccountId, title: h.title, reportsToAgentId: h.reportsToAgentId })),
      edges, partial,
    };
  }
}

export type { AgentRow };
