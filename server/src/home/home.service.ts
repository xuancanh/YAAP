/**
 * HomeService — the owner's mission control (docs/home.md): one aggregate
 * over the services that already own each fact. Nothing here decides,
 * writes company state or calls a model; it reads, ranks and summarises.
 *
 * Every section is computed independently: a failing source lands in
 * `partial` and the rest of the page still renders. Org sources are
 * optional so a workspace without a company (or an install with
 * COMPANIES_ENABLED=false) gets the simpler Home.
 *
 * The only write is the visit record ("since you were last here"): one
 * app_settings row per workspace and person, `home.visit:<ws>:<actor>`,
 * holding the start of the previous session. A visit within
 * SESSION_GAP_MS of the last one continues that session.
 */
import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, gte, inArray } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { appSettings, chatTurns, orgUnits } from '../database/schema';
import { actorId } from '../accounts/account-context';
import { AgentsService } from '../agents/agents.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { spendStatus } from '../workspaces/spend.util';
import { WorkspaceFs } from '../files/workspace-fs.service';
import { ActionsService } from '../actions/actions.service';
import { UsageService } from '../usage/usage.module';
import { ProviderHealthService } from '../ai/provider-health';
import { cronMatches } from '../chats/cron.util';
import { OrgService, type Organization } from '../org/org.service';
import { OrgTasksService, type OrgTask } from '../org/org-tasks.service';
import { OrgApprovalsService, summarize, type OrgApproval } from '../org/org-approvals.service';
import { OrgAuditService } from '../org/org-audit.service';
import { OrgBriefService } from '../org/org-brief.service';
import { OrgIntentService, type IntentNode } from '../org/org-intent.service';
import { OrgSloService } from '../org/org-slo.service';
import { OrgSignalsService } from '../org/org-signals.service';
import { OrgAuditorService } from '../org/org-auditor.service';
import { OrgMeetingsService } from '../org/org-meetings.service';
import { OrgCapitalService } from '../org/org-capital.service';
import { OrgIncidentsService } from '../org/org-incidents.service';
import { OrgRuntimeService } from '../org/org-runtime.service';
import type {
  HomeActivity, HomeAgent, HomeArtifact, HomeData, HomeGoal, HomeHealth, HomeKeyResult, HomeNeed, HomeRecap, HomeRecapItem, HomeSpend, HomeUpcoming,
} from './home.types';
import { collapseRoutine, describeRun, loopNameOf, mergeUpcoming, runTitle, type RunCall } from './home-activity';
import { agentStatuses, sortTeam, toHomeAgent } from './agent-status';

const DAY_MS = 24 * 60 * 60_000;
/** A visit within this of the previous one continues the same session. */
export const SESSION_GAP_MS = 30 * 60_000;
/** How many Needs-you cards the page carries (the Inbox has the rest). */
export const NEEDS_LIMIT = 12;
const ACTIVITY_LIMIT = 40;
const ARTIFACT_LIMIT = 8;

type AgentRow = Awaited<ReturnType<AgentsService['list']>>[number];
type Rag = 'red' | 'amber' | 'green' | 'grey';

const safe = <T,>(raw: string | null | undefined, fallback: T): T => { try { return raw ? (JSON.parse(raw) as T) : fallback; } catch { return fallback; } };
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const SEVERITY_RANK: Record<HomeNeed['severity'], number> = { critical: 0, high: 1, normal: 2 };

/** RAG from the model-free assessment: at risk is red; behind or low confidence amber; on pace green. */
export function ragOf(n: { atRisk: number | boolean; pace?: string; confidence: number | null }): Rag {
  if (n.atRisk) return 'red';
  if (n.pace === 'behind' || (n.confidence !== null && n.confidence < 0.5)) return 'amber';
  if (n.pace === 'onPace' || (n.confidence !== null && n.confidence >= 0.5)) return 'green';
  return 'grey';
}

/** The next minute a five-field cron matches, within a week; null otherwise. */
export function nextCronFire(expr: string, from: Date): Date | null {
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  for (let i = 0; i < 7 * 24 * 60; i++) {
    d.setMinutes(d.getMinutes() + 1);
    if (cronMatches(expr, d)) return d;
  }
  return null;
}

/** Sort the Needs-you list: severity first, then the nearest deadline, then the oldest ask. */
export function rankNeeds(needs: HomeNeed[]): HomeNeed[] {
  return needs.slice().sort((a, b) =>
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
    || (a.deadline ?? '9999').localeCompare(b.deadline ?? '9999')
    || a.createdAt.localeCompare(b.createdAt));
}

@Injectable()
export class HomeService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly workspaces: WorkspacesService,
    private readonly agents: AgentsService,
    @Optional() private readonly config?: ConfigService,
    @Optional() private readonly fs?: WorkspaceFs,
    @Optional() private readonly actions?: ActionsService,
    @Optional() private readonly usage?: UsageService,
    @Optional() private readonly providerHealth?: ProviderHealthService,
    @Optional() private readonly org?: OrgService,
    @Optional() private readonly tasks?: OrgTasksService,
    @Optional() private readonly approvals?: OrgApprovalsService,
    @Optional() private readonly audit?: OrgAuditService,
    @Optional() private readonly brief?: OrgBriefService,
    @Optional() private readonly intent?: OrgIntentService,
    @Optional() private readonly slo?: OrgSloService,
    @Optional() private readonly signals?: OrgSignalsService,
    @Optional() private readonly auditor?: OrgAuditorService,
    @Optional() private readonly meetings?: OrgMeetingsService,
    @Optional() private readonly capital?: OrgCapitalService,
    @Optional() private readonly incidents?: OrgIncidentsService,
    @Optional() private readonly runtime?: OrgRuntimeService,
  ) {}

  private companiesEnabled(): boolean { return this.config?.get<boolean>('companiesEnabled') !== false; }

  // ---- the visit ("since you were last here") ----

  private visitKey(workspaceId: string): string { return `home.visit:${workspaceId}:${actorId()}`; }

  /** The start of the window to summarise, and records this visit. */
  async touchVisit(workspaceId: string, now = new Date()): Promise<{ since: string; firstVisit: boolean }> {
    const key = this.visitKey(workspaceId);
    const row = (await this.db.select().from(appSettings).where(eq(appSettings.key, key)).limit(1)).at(0);
    const prev = safe<{ since?: string; at?: string }>(row?.value, {});
    const nowIso = now.toISOString();
    let since: string;
    if (!prev.at) since = new Date(now.getTime() - DAY_MS).toISOString();
    else if (now.getTime() - Date.parse(prev.at) > SESSION_GAP_MS) since = prev.at;
    else since = prev.since ?? prev.at;
    const value = JSON.stringify({ since, at: nowIso });
    if (row) await this.db.update(appSettings).set({ value }).where(eq(appSettings.key, key));
    else await this.db.insert(appSettings).values({ key, value });
    return { since, firstVisit: !prev.at };
  }

  // ---- the aggregate ----

  async home(workspaceId: string, opts: { since?: string; now?: Date } = {}): Promise<HomeData> {
    const now = opts.now ?? new Date();
    const ws = await this.workspaces.get(workspaceId); // 404s for a workspace we cannot see
    const visit = opts.since && !Number.isNaN(Date.parse(opts.since))
      ? { since: new Date(opts.since).toISOString(), firstVisit: false }
      : await this.touchVisit(workspaceId, now);
    const since = visit.since;
    const partial: string[] = [];
    const attempt = async <T,>(section: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
      try { return await fn(); } catch { partial.push(section); return fallback; }
    };

    const agents = await this.agents.list({ workspaceId });
    const names = new Map(agents.map((a) => [a.id, a.name]));
    const org = this.companiesEnabled() && this.org ? await this.org.byWorkspace(workspaceId).catch(() => null) : null;
    const orgOn = Boolean(org && ws.orgMode !== 'off');
    const orgTasks = org && this.tasks ? await this.tasks.list(org.id).catch(() => [] as OrgTask[]) : [];
    const members = org ? await this.org!.members(org.id).catch(() => []) : [];

    const [needs, recap, goals, team, activity, spend, health, upcoming, artifacts] = await Promise.all([
      attempt('needs', () => this.needs(workspaceId, orgOn ? org : null, agents, names, now), [] as HomeNeed[]),
      attempt('recap', () => this.recap(workspaceId, orgOn ? org : null, agents, orgTasks, names, since), emptyRecap()),
      attempt('goals', () => (orgOn && org && this.intent ? this.goals(org.id, now) : Promise.resolve([] as HomeGoal[])), [] as HomeGoal[]),
      attempt('team', () => this.team(workspaceId, org, orgOn, agents, orgTasks, members, now), [] as HomeAgent[]),
      attempt('activity', () => this.activity(workspaceId, orgOn ? org : null, agents, orgTasks, names, now), [] as HomeActivity[]),
      attempt('spend', () => this.spend(workspaceId, orgOn ? org : null, ws, now), emptySpend()),
      attempt('health', () => this.health(workspaceId, orgOn ? org : null), { status: 'ok', openIncidents: [], providers: [], audit: null } as HomeHealth),
      attempt('upcoming', () => this.upcoming(orgOn ? org : null, agents, orgTasks, now), [] as HomeUpcoming[]),
      attempt('artifacts', () => this.artifacts(workspaceId), [] as HomeArtifact[]),
    ]);

    const ranked = rankNeeds(needs);
    const chief = org?.chiefOfStaffAgentId ?? ws.chiefOfStaffAgentId ?? null;
    return {
      workspaceId, generatedAt: now.toISOString(), since, firstVisit: visit.firstVisit,
      company: org && orgOn ? {
        orgId: org.id, name: org.name, mode: ws.orgMode as 'off' | 'supervised' | 'autonomous', status: org.status as 'active' | 'paused',
        chiefAgentId: chief, chiefName: chief ? names.get(chief) ?? null : null, memberCount: members.filter((m) => m.status !== 'terminated').length,
      } : null,
      headline: { tasksDone: recap.tasksDone, needsYou: ranked.length, todayUsd: spend.todayUsd, monthUsd: spend.monthUsd, monthCapUsd: spend.monthCapUsd },
      needs: ranked.slice(0, NEEDS_LIMIT),
      recap, goals, team, activity, spend, health, upcoming, artifacts, partial,
    };
  }

  // ---- 2. needs you ----

  private async needs(workspaceId: string, org: Organization | null, agents: AgentRow[], names: Map<string, string>, now: Date): Promise<HomeNeed[]> {
    const out: HomeNeed[] = [];
    const nameOf = (actor: string) => {
      if (!actor) return '';
      if (actor === 'user') return 'You';
      if (actor === 'chief' && org?.chiefOfStaffAgentId) return names.get(org.chiefOfStaffAgentId) ?? 'Chief of staff';
      return names.get(actor) ?? names.get(actor.replace(/^agent:/, '')) ?? actor;
    };
    const coveredActions = new Set<string>();
    if (org && this.approvals) {
      await this.approvals.expireStale(org.id, now).catch(() => 0);
      for (const a of await this.approvals.pending(org.id)) {
        const payload = safe<Record<string, unknown>>(a.payload, {});
        if (typeof payload.actionId === 'string') coveredActions.add(payload.actionId);
        out.push(approvalNeed(a, payload, nameOf(a.requestedBy), now));
      }
    }
    if (org && this.capital) {
      for (const p of await this.capital.plans(org.id, { status: 'pending' })) {
        out.push({
          id: `plan:${p.id}`, kind: 'plan', subkind: p.trigger, title: clip(p.summary || 'An autonomous plan', 160),
          detail: `${safe<unknown[]>(p.actions, []).length} action(s), estimated $${p.estimateUsd.toFixed(2)}. It applies on its own unless you veto it.`,
          severity: p.applyAt && Date.parse(p.applyAt) - now.getTime() < 15 * 60_000 ? 'high' : 'normal', createdAt: p.createdAt,
          deadline: p.applyAt, defaultAction: 'apply', recommendation: '', recommendedAction: '', reversibility: '', confidence: null,
          requestedBy: org.chiefOfStaffAgentId ? names.get(org.chiefOfStaffAgentId) ?? 'Chief of staff' : 'Chief of staff',
          ref: { planId: p.id }, actions: ['veto', 'apply_now'],
        });
      }
    }
    if (this.actions) {
      const held = [...await this.actions.list(workspaceId, { status: 'held', limit: 50 }), ...await this.actions.list(workspaceId, { status: 'staged', limit: 50 })];
      for (const r of held) {
        const keys = safe<{ approvalId?: string; why?: string }>(r.keys, {});
        if (coveredActions.has(r.id) || keys.approvalId) continue; // the org card above carries it
        out.push({
          id: `action:${r.id}`, kind: 'held_action', subkind: r.class, title: `${r.status === 'staged' ? 'Send staged' : 'Run held'} ${r.tool}`,
          detail: clip(keys.why || r.note || r.input, 240), severity: 'high', createdAt: r.createdAt, deadline: null, defaultAction: '',
          recommendation: '', recommendedAction: '', reversibility: '', confidence: null, requestedBy: r.agentId ? names.get(r.agentId) ?? '' : '',
          ref: { actionId: r.id, agentId: r.agentId ?? undefined, sessionId: r.sessionId }, actions: ['approve', 'reject'],
        });
      }
    }
    if (org && this.incidents) {
      for (const i of (await this.incidents.list(org.id, { limit: 50 })).filter((x) => x.status === 'open')) {
        out.push({
          id: `incident:${i.id}`, kind: 'incident', subkind: i.kind, title: i.title, detail: clip(i.detail, 240),
          severity: i.severity === 'critical' ? 'critical' : i.severity === 'major' ? 'high' : 'normal', createdAt: i.openedAt, deadline: null, defaultAction: '',
          recommendation: '', recommendedAction: '', reversibility: '', confidence: null, requestedBy: i.agentId ? names.get(i.agentId) ?? '' : i.detectedBy,
          ref: { incidentId: i.id, agentId: i.agentId ?? undefined }, actions: [],
        });
      }
    }
    if (org && this.signals) {
      const mine = (await this.signals.list(org.id, { status: 'open' })).filter((s) => (s.addresseeKind === 'ceo' || s.addresseeKind === 'owner') && s.severity !== 'info');
      for (const s of mine.slice(0, 20)) {
        out.push({
          id: `signal:${s.id}`, kind: 'signal', subkind: s.kind, title: s.title, detail: clip(s.detail, 240),
          severity: s.severity === 'critical' ? 'critical' : 'normal', createdAt: s.createdAt, deadline: null, defaultAction: '',
          recommendation: '', recommendedAction: '', reversibility: '', confidence: null, requestedBy: 'Assurance',
          ref: { signalId: s.id }, actions: ['ack'],
        });
      }
    }
    // Background actions an agent queued for approval (no company needed).
    for (const a of agents) {
      for (const e of (await this.agents.listEvents(a.id, 30)).filter((x) => x.kind === 'action_pending')) {
        const p = safe<{ tool?: string }>(e.payload, {});
        out.push({
          id: `event:${e.id}`, kind: 'queued_action', subkind: p.tool ?? 'action', title: e.title, detail: clip(e.body, 240), severity: 'normal',
          createdAt: e.createdAt, deadline: null, defaultAction: '', recommendation: '', recommendedAction: '', reversibility: '', confidence: null,
          requestedBy: a.name, ref: { agentId: a.id, eventId: e.id, sessionId: e.sessionId ?? undefined }, actions: ['approve', 'dismiss'],
        });
      }
    }
    return out;
  }

  // ---- 3. since you were last here ----

  private async recap(workspaceId: string, org: Organization | null, agents: AgentRow[], orgTasks: OrgTask[], names: Map<string, string>, since: string): Promise<HomeRecap> {
    const recap = emptyRecap();
    if (org) {
      recap.tasksDone = orgTasks.filter((t) => t.status === 'done' && t.updatedAt >= since).length;
      recap.tasksBlocked = orgTasks.filter((t) => t.status === 'blocked').length;
    } else {
      for (const a of agents) {
        const ts = await this.agents.listTasks(a.id);
        recap.tasksDone += ts.filter((t) => t.status === 'done' && t.updatedAt >= since).length;
        recap.tasksBlocked += ts.filter((t) => t.status === 'blocked').length;
      }
    }
    if (org) {
      const decisions: HomeRecapItem[] = [];
      const people: HomeRecapItem[] = [];
      if (this.audit) {
        for (const r of (await this.audit.list(org.id, { limit: 300 })).filter((x) => x.createdAt >= since)) {
          const p = safe<{ summary?: string; reason?: string; name?: string; title?: string; agentId?: string; approvalKind?: string; kind?: string }>(r.payload, {});
          const ref = r.refType && r.refId ? { type: r.refType, id: r.refId } : null;
          const who = names.get(r.refId) ?? 'a member';
          if (r.action === 'member_add') people.push({ at: r.createdAt, kind: 'hire', title: `${who} joined${p.title ? ` as ${p.title}` : ''}`, detail: '', ref });
          else if (r.action === 'member_pause') people.push({ at: r.createdAt, kind: 'pause', title: `${who} was paused`, detail: r.actor === 'user' ? 'by you' : `by ${names.get(r.actor) ?? r.actor}`, ref });
          else if (r.action === 'member_terminate') people.push({ at: r.createdAt, kind: 'terminate', title: `${who} left the company`, detail: '', ref });
          if (r.action.startsWith('auto_')) {
            decisions.push({ at: r.createdAt, kind: 'auto', title: `${r.action.slice(5).replace(/_/g, ' ')}: ${p.summary ?? ''}`.trim(), detail: p.reason ?? '', ref });
          } else if (r.action === 'approval_default') {
            decisions.push({ at: r.createdAt, kind: 'default', title: p.summary || 'Decided by default at your deadline', detail: '', ref: { type: 'approval', id: r.refId } });
          } else if (r.action === 'delegated_decision') {
            decisions.push({ at: r.createdAt, kind: 'delegate', title: p.summary || 'Decided by your delegate', detail: p.reason ?? '', ref: { type: 'approval', id: r.refId } });
          }
        }
      }
      if (this.meetings) {
        for (const d of (await this.meetings.decisions(org.id, { limit: 50 })).filter((x) => x.createdAt >= since && x.decidedBy !== 'user')) {
          decisions.push({ at: d.createdAt, kind: 'decision', title: d.title, detail: clip(d.decision, 200), ref: { type: 'decision', id: d.id } });
        }
      }
      decisions.sort((a, b) => b.at.localeCompare(a.at));
      people.sort((a, b) => b.at.localeCompare(a.at));
      recap.decisionsCount = decisions.length;
      recap.decisions = decisions.slice(0, 8);
      recap.people = people.slice(0, 8);
      if (this.brief) { const b = await this.brief.latest(org.id).catch(() => null); recap.brief = b ? { at: b.at, text: b.text } : null; }
      if (this.slo) { const p = await this.slo.pulse(org.id).catch(() => null); recap.pulse = p ? { score: p.score, breaches: p.breaches.length } : null; }
    }
    if (this.fs) recap.artifactsChanged = (await this.fs.recent(workspaceId, 500)).filter((f) => f.updatedAt >= since).length;
    return recap;
  }

  // ---- 4. goals ----

  private async goals(orgId: string, now: Date): Promise<HomeGoal[]> {
    const tree = await this.intent!.intentTree(orgId, { now });
    const objectives: IntentNode[] = [];
    const walk = (nodes: IntentNode[]) => { for (const n of nodes) { if (n.kind === 'objective') objectives.push(n); walk(n.children as IntentNode[]); } };
    walk(tree);
    const goals = objectives.filter((o) => o.status !== 'done' && o.status !== 'cancelled' && o.status !== 'achieved').map((o): HomeGoal => {
      const krs = (o.children as IntentNode[]).filter((c) => c.kind === 'key_result').map((k): HomeKeyResult => ({
        id: k.id, title: k.title, currentValue: k.currentValue, targetValue: k.targetValue, unitLabel: k.unitLabel, progress: k.progress,
        confidence: k.confidence, atRisk: Boolean(k.atRisk), atRiskReason: k.atRiskReason, rag: ragOf(k), dueAt: k.dueAt,
      }));
      const atRisk = Boolean(o.atRisk) || krs.some((k) => k.atRisk);
      const rag: Rag = atRisk ? 'red' : krs.some((k) => k.rag === 'amber') ? 'amber' : ragOf(o);
      return {
        id: o.id, title: o.title, ownerName: o.ownerName ?? null, progress: o.progress, confidence: o.confidence, atRisk,
        atRiskReason: o.atRiskReason || krs.find((k) => k.atRisk)?.atRiskReason || '', rag, dueAt: o.dueAt, keyResults: krs,
      };
    });
    const order: Record<Rag, number> = { red: 0, amber: 1, grey: 2, green: 3 };
    return goals.sort((a, b) => order[a.rag] - order[b.rag] || a.progress - b.progress);
  }

  // ---- 5. team ----

  /** The shared per-agent status (agent-status.ts), as Home's tiles in Home's order. */
  private async team(workspaceId: string, org: Organization | null, orgOn: boolean, agents: AgentRow[], orgTasks: OrgTask[], members: Array<{ agentId: string; status: string; title: string }>, now: Date): Promise<HomeAgent[]> {
    const list = await agentStatuses({ db: this.db, agents: this.agents, providerHealth: this.providerHealth, tasks: this.tasks }, { workspaceId, org, orgOn, agents, orgTasks, members, now });
    return sortTeam(list.map(toHomeAgent));
  }

  // ---- 6. activity ----

  private async activity(workspaceId: string, org: Organization | null, agents: AgentRow[], orgTasks: OrgTask[], names: Map<string, string>, now: Date): Promise<HomeActivity[]> {
    const out: HomeActivity[] = [];
    const horizon = new Date(now.getTime() - 7 * DAY_MS).toISOString();
    const nameOf = (id: string | null | undefined) => (id ? names.get(id) ?? '' : '');
    if (org) {
      for (const t of orgTasks.filter((x) => (x.status === 'done' || x.status === 'blocked') && x.updatedAt >= horizon)) {
        out.push({ id: `task:${t.id}:${t.status}`, at: t.updatedAt, kind: 'task', title: `${t.status === 'done' ? 'Done' : 'Blocked'}: ${t.title}`, detail: t.status === 'blocked' ? clip(t.blockers, 160) : '', actor: nameOf(t.assigneeAgentId), ref: { type: 'task', id: t.id } });
      }
      if (this.audit) {
        for (const r of (await this.audit.list(org.id, { limit: 200 })).filter((x) => x.createdAt >= horizon)) {
          const p = safe<{ summary?: string; reason?: string; title?: string; kind?: string; via?: string }>(r.payload, {});
          const actor = r.actor === 'user' ? 'You' : nameOf(r.actor) || r.actor;
          if (r.action === 'member_add') {
            out.push({ id: `audit:${r.id}`, at: r.createdAt, kind: 'hire', title: `${nameOf(r.refId) || 'A member'} joined${p.title ? ` as ${p.title}` : ''}`, detail: '', actor, ref: { type: 'agent', id: r.refId } });
          } else if (r.action === 'member_pause' || r.action === 'member_terminate') {
            out.push({ id: `audit:${r.id}`, at: r.createdAt, kind: 'hire', title: `${nameOf(r.refId) || 'A member'} ${r.action === 'member_pause' ? 'was paused' : 'left the company'}`, detail: '', actor, ref: { type: 'agent', id: r.refId } });
          } else if (/^approval_(approved|rejected|revision_requested)$/.test(r.action) || r.action.startsWith('auto_')) {
            const verb = r.action.startsWith('auto_') ? r.action.slice(5).replace(/_/g, ' ') : `${r.action.slice(9).replace(/_/g, ' ')} ${p.kind ? String(p.kind).replace(/_/g, ' ') : ''}`.trim();
            out.push({ id: `audit:${r.id}`, at: r.createdAt, kind: 'decision', title: p.summary ? `${verb}: ${p.summary}` : verb.charAt(0).toUpperCase() + verb.slice(1), detail: p.reason ?? '', actor: p.via === 'default' ? 'Default' : actor, ref: r.refType && r.refId ? { type: r.refType, id: r.refId } : null });
          }
        }
      }
      if (this.meetings) {
        for (const m of (await this.meetings.list(org.id, { status: 'done', limit: 20 })).filter((x) => (x.endedAt ?? x.createdAt) >= horizon)) {
          out.push({ id: `meeting:${m.id}`, at: m.endedAt ?? m.createdAt, kind: 'meeting', title: `Held: ${m.title}`, detail: clip(safe<{ summary?: string }>(m.minutes, {}).summary ?? '', 200), actor: nameOf(m.facilitatorAgentId), ref: { type: 'meeting', id: m.id } });
        }
      }
      if (this.incidents) {
        for (const i of (await this.incidents.list(org.id, { limit: 50 })).filter((x) => x.openedAt >= horizon || (x.resolvedAt ?? '') >= horizon)) {
          const resolved = i.status === 'resolved' && i.resolvedAt;
          out.push({ id: `incident:${i.id}:${i.status}`, at: resolved ? i.resolvedAt! : i.openedAt, kind: 'incident', title: `${resolved ? 'Resolved' : 'Incident'}: ${i.title}`, detail: resolved ? clip(i.resolution, 160) : i.severity, actor: nameOf(i.agentId), ref: { type: 'incident', id: i.id } });
        }
      }
    } else {
      for (const a of agents) {
        for (const t of (await this.agents.listTasks(a.id)).filter((x) => (x.status === 'done' || x.status === 'blocked') && x.updatedAt >= horizon)) {
          out.push({ id: `atask:${t.id}`, at: t.updatedAt, kind: 'task', title: `${t.status === 'done' ? 'Done' : 'Blocked'}: ${t.title}`, detail: '', actor: a.name, ref: { type: 'agent', id: a.id } });
        }
      }
    }
    // Agent events. A loop run (the heartbeat, mostly) is news only when it
    // did something: those stand alone, described by what they did; the
    // routine ones collapse into one line per agent per day.
    const runEvents: Array<{ agent: AgentRow; e: Awaited<ReturnType<AgentsService['listEvents']>>[number] }> = [];
    for (const a of agents) {
      for (const e of (await this.agents.listEvents(a.id, 120)).filter((x) => x.createdAt >= horizon && ['loop_run', 'loop_error', 'brief', 'action_done', 'action_failed', 'budget_stop'].includes(x.kind))) {
        if (e.kind === 'loop_run') { runEvents.push({ agent: a, e }); continue; }
        out.push({ id: `event:${e.id}`, at: e.createdAt, kind: 'agent', title: e.title, detail: clip(e.body, 160), actor: a.name, ref: { type: 'agent', id: a.id } });
      }
    }
    const callsOf = await this.runCalls(runEvents.map((r) => r.e), horizon);
    const routine: Parameters<typeof collapseRoutine>[0] = [];
    const taskRef = (id: string | null) => {
      if (!id) return null;
      const t = orgTasks.find((x) => x.id === id || x.id.startsWith(id));
      return t ? { type: 'task', id: t.id } : null;
    };
    for (const { agent: a, e } of runEvents) {
      const loop = loopNameOf(e.title);
      const s = describeRun(callsOf.get(e.id) ?? []);
      if (s.notable) {
        out.push({ id: `event:${e.id}`, at: e.createdAt, kind: 'agent', title: runTitle(loop, s), detail: clip(e.body, 160), actor: a.name, ref: taskRef(s.taskId) ?? { type: 'agent', id: a.id }, loop });
      } else {
        routine.push({ agentId: a.id, agentName: a.name, loop, run: { id: `event:${e.id}`, at: e.createdAt, title: e.title, detail: clip(e.body, 160) } });
      }
    }
    out.push(...collapseRoutine(routine));
    if (this.fs) {
      for (const f of (await this.fs.recent(workspaceId, 15)).filter((x) => x.updatedAt >= horizon)) {
        out.push({ id: `file:${f.path}:${f.version}`, at: f.updatedAt, kind: 'file', title: `${f.version > 1 ? 'Edited' : 'Created'} ${f.path}`, detail: `version ${f.version}`, actor: f.updatedBy.name, ref: { type: 'file', id: f.path } });
      }
    }
    return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, ACTIVITY_LIMIT);
  }

  // ---- 7. spend & health ----

  private async spend(workspaceId: string, org: Organization | null, ws: Awaited<ReturnType<WorkspacesService['get']>>, now: Date): Promise<HomeSpend> {
    const out = emptySpend();
    const today = now.toISOString().slice(0, 10);
    if (org && this.runtime) {
      const tree = await this.runtime.spendTree(org.id, now);
      out.monthUsd = tree.company.usd;
      out.monthCapUsd = tree.company.monthlyUsd || null;
      out.todayUsd = tree.series.find((d: { day: string; usd: number }) => d.day === today)?.usd ?? 0;
      if (this.capital) {
        const f = await this.capital.forecast(org.id, now).catch(() => null);
        if (f) { out.projectedUsd = f.company.projectedUsd; out.forecastState = f.company.state as HomeSpend['forecastState']; }
      }
    }
    if (this.usage) {
      // Chat, loop and channel turns: the ledger outside org runs.
      const u = await this.usage.workspaceUsage(workspaceId, now.getUTCDate(), now);
      const todayChat = u.series.find((d) => d.day === today)?.usd ?? 0;
      out.todayUsd = (out.todayUsd ?? 0) + todayChat;
      if (!org) out.monthUsd = u.totals.usd;
    }
    const st = spendStatus(ws, now);
    out.tokens = st.budgetTokens > 0 ? { spent: st.spentTokens, budget: st.budgetTokens, over: st.over } : null;
    return out;
  }

  private async health(workspaceId: string, org: Organization | null): Promise<HomeHealth> {
    const providers = (this.providerHealth?.list(workspaceId) ?? []).map((p) => ({ provider: p.provider, state: p.state, lastError: clip(p.lastError, 200) }));
    const out: HomeHealth = { status: providers.length ? 'degraded' : 'ok', openIncidents: [], providers, audit: null };
    if (!org) return out;
    if (this.incidents) {
      const open = (await this.incidents.list(org.id, { limit: 100 })).filter((r) => r.status !== 'resolved');
      out.openIncidents = open.map((r) => ({ id: r.id, title: r.title, severity: r.severity, status: r.status, openedAt: r.openedAt }));
      if (open.some((r) => r.severity !== 'minor')) out.status = 'incident';
      else if (open.length) out.status = 'degraded';
    }
    if (this.auditor) {
      const last = (await this.auditor.list(org.id, 5)).find((a) => a.status !== 'running');
      if (last) {
        const findings = safe<Array<{ severity?: string; title?: string }>>(last.findings, []);
        const rank: Record<string, number> = { critical: 0, high: 1, major: 1, warn: 2, medium: 2, low: 3, info: 4 };
        out.audit = {
          id: last.id, at: last.endedAt ?? last.startedAt, status: last.status, findings: findings.length,
          top: findings.slice().sort((a, b) => (rank[a.severity ?? ''] ?? 5) - (rank[b.severity ?? ''] ?? 5)).slice(0, 3).map((f) => ({ severity: f.severity ?? '', title: clip(f.title ?? '', 140) })),
          summary: clip(last.summary, 240),
        };
      }
    }
    return out;
  }

  // ---- 8. coming up ----

  private async upcoming(org: Organization | null, agents: AgentRow[], orgTasks: OrgTask[], now: Date): Promise<HomeUpcoming[]> {
    const out: HomeUpcoming[] = [];
    const nowIso = now.toISOString();
    const week = new Date(now.getTime() + 7 * DAY_MS).toISOString();
    if (org) {
      if (this.meetings) {
        for (const m of await this.meetings.list(org.id, { status: 'scheduled', limit: 20 })) {
          if (m.scheduledFor && m.scheduledFor >= nowIso) out.push({ id: `meeting:${m.id}`, at: m.scheduledFor, kind: 'meeting', title: m.title, detail: m.kind.replace(/_/g, ' '), ref: { type: 'meeting', id: m.id } });
        }
        // Every unit gets the default cadences, so a company of two units has
        // two weekly reviews at the same minute: one row, naming both units.
        const units = new Map((await this.db.select({ id: orgUnits.id, name: orgUnits.name, parentUnitId: orgUnits.parentUnitId }).from(orgUnits).where(eq(orgUnits.orgId, org.id)))
          .map((u) => [u.id, u.parentUnitId === null ? 'Company' : u.name]));
        for (const c of (await this.meetings.cadences(org.id)).filter((x) => x.enabled && x.nextRunAt && x.nextRunAt >= nowIso && x.nextRunAt <= week)) {
          const unit = units.get(c.unitId);
          out.push({ id: `ritual:${c.id}`, at: c.nextRunAt!, kind: 'ritual', title: titleOfRitual(c.kind), detail: unit ?? '', cron: c.cron, units: unit ? [unit] : [], ref: null });
        }
      }
      for (const t of orgTasks.filter((x) => x.dueAt && x.dueAt <= week && x.status !== 'done' && x.status !== 'cancelled')) {
        out.push({ id: `task:${t.id}`, at: t.dueAt!, kind: 'deadline', title: t.title, detail: t.dueAt! < nowIso ? 'overdue' : t.status.replace(/_/g, ' '), ref: { type: 'task', id: t.id } });
      }
      if (this.approvals) {
        for (const a of (await this.approvals.pending(org.id)).filter((x) => x.deadline && x.deadline <= week)) {
          out.push({ id: `approval:${a.id}`, at: a.deadline!, kind: 'decision', title: summarize(a.kind, safe(a.payload, {})), detail: a.defaultAction ? `defaults to ${a.defaultAction}` : 'decision due', ref: { type: 'approval', id: a.id } });
        }
      }
      if (this.capital) {
        for (const p of await this.capital.plans(org.id, { status: 'pending' })) {
          if (p.applyAt) out.push({ id: `plan:${p.id}`, at: p.applyAt, kind: 'plan', title: clip(p.summary || 'Autonomous plan', 120), detail: 'applies unless vetoed', ref: { type: 'plan', id: p.id } });
        }
      }
    }
    for (const a of agents) {
      for (const l of safe<Array<{ name: string; cron?: string; enabled?: boolean }>>(a.loops, [])) {
        if (l.enabled === false || !l.cron) continue;
        const at = nextCronFire(l.cron, now);
        if (at && at.toISOString() <= new Date(now.getTime() + DAY_MS).toISOString()) {
          out.push({ id: `loop:${a.id}:${l.name}`, at: at.toISOString(), kind: 'loop', title: `${a.name}: ${l.name}`, detail: '', cron: l.cron, ref: { type: 'agent', id: a.id } });
        }
      }
    }
    return mergeUpcoming(out.sort((a, b) => a.at.localeCompare(b.at))).slice(0, 12);
  }

  private runCalls(events: Array<{ id: string; sessionId: string | null; createdAt: string }>, horizon: string): Promise<Map<string, RunCall[]>> {
    return loopRunCalls(this.db, events, horizon);
  }

  // ---- 9. recent artifacts ----

  private async artifacts(workspaceId: string): Promise<HomeArtifact[]> {
    if (!this.fs) return [];
    return (await this.fs.recent(workspaceId, ARTIFACT_LIMIT)).map((f) => ({ path: f.path, version: f.version, size: f.size, updatedAt: f.updatedAt, updatedBy: f.updatedBy }));
  }
}

/** The tool calls of each loop run: the run's turn is the latest turn of its
 *  loop session that started before the run was recorded. Shared with the
 *  agent overview (overview.service.ts). */
export async function loopRunCalls(db: DrizzleDb, events: Array<{ id: string; sessionId: string | null; createdAt: string }>, horizon: string): Promise<Map<string, RunCall[]>> {
  const out = new Map<string, RunCall[]>();
  const sessions = [...new Set(events.map((e) => e.sessionId).filter((x): x is string => Boolean(x)))];
  if (sessions.length === 0) return out;
  const turns = await db.select({ sessionId: chatTurns.sessionId, createdAt: chatTurns.createdAt, toolCalls: chatTurns.toolCalls })
    .from(chatTurns).where(and(inArray(chatTurns.sessionId, sessions), gte(chatTurns.createdAt, horizon)));
  const bySession = new Map<string, typeof turns>();
  for (const t of turns) { const l = bySession.get(t.sessionId) ?? []; l.push(t); bySession.set(t.sessionId, l); }
  for (const l of bySession.values()) l.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const e of events) {
    const turn = e.sessionId ? bySession.get(e.sessionId)?.find((t) => t.createdAt <= e.createdAt) : undefined;
    if (turn) out.set(e.id, safe<RunCall[]>(turn.toolCalls, []));
  }
  return out;
}

function emptyRecap(): HomeRecap {
  return { tasksDone: 0, tasksBlocked: 0, decisions: [], decisionsCount: 0, people: [], artifactsChanged: 0, brief: null, pulse: null };
}
function emptySpend(): HomeSpend {
  return { todayUsd: null, monthUsd: null, monthCapUsd: null, projectedUsd: null, forecastState: null, tokens: null };
}

const RITUALS: Record<string, string> = { planning: 'Planning', standup: 'Standup', weekly_review: 'Weekly review', retro: 'Retro', board: 'Board meeting', adhoc: 'Meeting' };
function titleOfRitual(kind: string): string { return RITUALS[kind] ?? kind; }

/** An org approval as a decision card. Two-key cards are held actions; escalations are their own kind. */
function approvalNeed(a: OrgApproval, payload: Record<string, unknown>, requestedBy: string, now: Date): HomeNeed {
  const deadlineSoon = a.deadline ? Date.parse(a.deadline) - now.getTime() < 6 * 60 * 60_000 : false;
  const kind: HomeNeed['kind'] = a.kind === 'escalation' ? 'escalation' : a.kind === 'two_key' ? 'held_action' : 'approval';
  return {
    id: `approval:${a.id}`, kind, subkind: a.kind, title: summarize(a.kind, payload),
    detail: clip(typeof payload.reason === 'string' ? payload.reason : typeof payload.why === 'string' ? payload.why : '', 240),
    severity: a.kind === 'escalation' || a.kind === 'two_key' || deadlineSoon ? 'high' : 'normal',
    createdAt: a.createdAt, deadline: a.deadline ?? a.expiresAt ?? null, defaultAction: (a.defaultAction ?? '') as HomeNeed['defaultAction'],
    recommendation: a.recommendation ?? '', recommendedAction: a.recommendedAction ?? '', reversibility: a.reversibility ?? '', confidence: a.confidence ?? null,
    requestedBy, ref: { approvalId: a.id, actionId: typeof payload.actionId === 'string' ? payload.actionId : undefined, taskId: typeof payload.taskId === 'string' ? payload.taskId : undefined },
    actions: ['approve', 'reject'],
  };
}
