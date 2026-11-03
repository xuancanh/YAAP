/**
 * OrgProjectsService — the middle level of the work graph
 * (docs/work-tracking.md): goal / key result → **project** → task.
 *
 * A project has one lead (an agent or a person), moves one or more key
 * results, carries a short brief (problem, hypothesis, done-when, MVP),
 * dates and milestones, an appetite in days and USD, a roadmap lane (Now /
 * Next / Later) and an owner-written health stream. Every org task belongs
 * to one: the placement rule (`place`, bound into OrgTasksService) puts an
 * orphan in its unit's **Unsorted** project and retro work in the unit's
 * **Operating improvements** project, whose open tasks are capped.
 *
 * The controls, all model-free and every threshold a tunable
 * (work-tunables.ts):
 *
 *  - **the bet** — moving a project to Now is the CEO's decision: an agent's
 *    request becomes a `project_now` card (boundary row `project_bet`);
 *  - **health cadence** — the lead of a Now project posts a health update
 *    (on track / at risk with its ask / off track with its reason) every
 *    `work.updateCadenceDays`; past the due day the chief chases, past the
 *    grace the project shows **Update missing** to the CEO;
 *  - **the appetite circuit breaker** — at `work.appetiteWarnShare` of the
 *    appetite the lead must post; at 100% new claims in the project pause
 *    (`claimGate`) and a decision — extend, cut scope or kill — goes to the
 *    lead's manager chain: a decision task for an agent manager (who may
 *    extend within `work.extendShare` alone), a `project_appetite` card for
 *    the CEO when the lead is the chief, a person, or reports to nobody.
 *
 * Reads for the SPA: `roadmap` (Timeline and Now / Next / Later), `page`
 * (the project page: brief, KRs, milestones, progress and hill, health
 * history, budget burn, forecast, tasks by status, blockers, decisions,
 * files) and `portfolio` (Home's exception summary and the "since you last
 * looked" digest of project changes).
 */
import { BadRequestException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { orgApprovals, orgDecisions, orgProjectUpdates, taskTransitions } from '../database/schema';
import { newId, nowIso } from '../common/ids.util';
import { currentAccountId } from '../accounts/account-context';
import { AgentsService } from '../agents/agents.service';
import { HeartbeatService } from '../chats/heartbeat.service';
import { taskLabel, taskRef } from '../common/task-keys';
import { OrgService, type Organization, type OrgProject, type ProjectCreate, type ProjectPatch } from './org.service';
import { OrgTasksService, type OrgTask } from './org-tasks.service';
import { OrgApprovalsService, type OrgApproval } from './org-approvals.service';
import { OrgAuditService } from './org-audit.service';
import { OrgUnitsService } from './org-units.service';
import { OrgDecisionsService } from './org-decisions.service';
import { holderAgent } from './decision-routing';
import { parseBlockedOn, describeBlockedOn } from './blocked-on';
import { workTunable } from './work-tunables';
import {
  PROJECT_HEALTH, SYSTEM_PROJECT_TITLES, forecastFrom, inferredHill, parseIdList, parseMilestones, parseProjectBrief, parseSteps, progressOf,
  type Forecast, type Milestone, type ProjectHealth, type ProjectKind, type TaskSource,
} from './work-model';

const DAY_MS = 86_400_000;
const OPEN = new Set(['backlog', 'waiting', 'todo', 'claimed', 'in_progress', 'in_review', 'blocked']);
const ACTIVE_OPEN = new Set(['todo', 'claimed', 'in_progress', 'in_review', 'blocked', 'waiting']);

export type UpdateState = 'none' | 'fresh' | 'due' | 'missing';

/** One row of the roadmap and of the portfolio. */
export interface ProjectSummary {
  id: string; key: string | null; title: string; kind: string; status: string; lane: string; rank: number;
  unitId: string | null; unitName: string | null;
  lead: { kind: 'agent' | 'person' | 'none'; id: string | null; name: string };
  goalIds: string[]; goals: Array<{ id: string; title: string; kind: string; parentGoalId: string | null }>;
  startDate: string | null; targetDate: string | null; milestones: Milestone[];
  progress: { done: number; total: number; pct: number };
  hill: number | null; hillInferred: boolean;
  health: string; healthReason: string; healthAsk: string; healthAt: string | null;
  update: { state: UpdateState; dueAt: string | null; cadenceDays: number };
  appetite: { days: number; usd: number; spentUsd: number; usdShare: number | null; daysUsed: number | null; daysShare: number | null; tripped: boolean; breakerAt: string | null };
  blocked: number; late: boolean; overBudget: boolean;
  forecast: Forecast;
  briefOk: boolean;
}

export interface ProjectPage {
  project: ProjectSummary & { brief: ReturnType<typeof parseProjectBrief>; createdAt: string; createdBy: string; updateCadenceDays: number | null };
  updates: Array<typeof orgProjectUpdates.$inferSelect>;
  tasks: Array<Pick<OrgTask, 'id' | 'key' | 'title' | 'status' | 'assigneeAgentId' | 'assigneeHumanId' | 'source' | 'dueAt' | 'doneAt' | 'startedAt' | 'updatedAt' | 'unitId'> & { assigneeName: string; blockedOn: ReturnType<typeof parseBlockedOn>; blockedText: string; steps: { done: number; total: number } }>;
  blockers: Array<{ taskId: string; key: string | null; title: string; kind: string; text: string; since: string }>;
  decisions: Array<{ id: string; kind: string; title: string; status: string; at: string; via: 'card' | 'log' }>;
  files: Array<{ path: string; taskId: string }>;
  burn: Array<{ day: string; usd: number }>;
  throughput: Array<{ week: string; done: number }>;
}

export interface Portfolio {
  generatedAt: string;
  counts: { now: number; next: number; later: number; atRisk: number; offTrack: number; updateMissing: number; overBudget: number; late: number };
  exceptions: Array<{ projectId: string; key: string | null; title: string; kinds: Array<'off_track' | 'at_risk' | 'update_missing' | 'over_budget' | 'late' | 'tripped'>; detail: string; leadName: string }>;
  digest: Array<{ at: string; projectId: string; key: string | null; title: string; kind: 'health' | 'lane' | 'done' | 'milestone' | 'created' | 'breaker' | 'target'; text: string }>;
  doneByProject: Array<{ projectId: string; key: string | null; title: string; done: number }>;
  /** The projects in Now, in rank order (Home's roadmap snapshot). */
  nowProjects: Array<{ projectId: string; key: string | null; title: string; health: '' | 'on_track' | 'at_risk' | 'off_track'; progress: { done: number; total: number; pct: number }; targetDate: string | null; late: boolean; blocked: number; leadName: string }>;
}

@Injectable()
export class OrgProjectsService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly org: OrgService,
    private readonly tasks: OrgTasksService,
    private readonly approvals: OrgApprovalsService,
    private readonly audit: OrgAuditService,
    private readonly agents: AgentsService,
    @Optional() private readonly units?: OrgUnitsService,
    @Optional() heartbeat?: HeartbeatService,
    /** Optional: decision routing (docs/owners-seat.md §7) — who "the manager" is
     *  for blockedOn: manager and who decides a tripped appetite. */
    @Optional() private readonly decisions?: OrgDecisionsService,
  ) {
    if (decisions) {
      tasks.setManagerResolver(async (orgId, t) => {
        if (!t.assigneeAgentId) return null;
        const r = await decisions.routeDecision(orgId, t.assigneeAgentId, 'escalation', { taskId: t.id });
        return holderAgent(r.holder);
      });
    }
    tasks.setPlacer((orgId, input) => this.place(orgId, input));
    tasks.setClaimGate((orgId, task) => this.claimGate(orgId, task));
    approvals.onApply('project_now', async (orgId, payload) => this.applyBet(orgId, String(payload.projectId ?? ''), payload));
    approvals.onApply('project_appetite', async (orgId, payload, a, note) => this.applyAppetite(orgId, String(payload.projectId ?? ''), { decision: 'extend', extendDays: Number(payload.extendDays ?? 0), extendUsd: Number(payload.extendUsd ?? 0), note: note ?? '' }, `user`, a));
    approvals.onApply('project_kill', async (orgId, payload, _a, note) => this.applyAppetite(orgId, String(payload.projectId ?? ''), { decision: 'kill', note: note ?? '' }, 'user'));
    approvals.onDecided(async ({ orgId, approval, decision, note }) => {
      // A task blocked on this card moves again (blockedOn: decision / ceo);
      // a rejected escalation keeps its task blocked, as before.
      if (!(approval.kind === 'escalation' && decision !== 'approve')) await this.tasks.decisionMade(orgId, approval.id, note).catch(() => undefined);
      if (approval.kind === 'project_appetite' && decision !== 'approve') {
        const payload = JSON.parse(approval.payload || '{}') as Record<string, unknown>;
        await this.applyAppetite(orgId, String(payload.projectId ?? ''), { decision: decision === 'revise' ? 'cut_scope' : 'kill', note }, 'user', approval).catch(() => undefined);
      }
    });
    heartbeat?.addReasonProvider({ name: 'projects', reasons: (agentId, ctx) => this.heartbeatReasons(agentId, ctx.now) });
    heartbeat?.addContextProvider({ name: 'projects', context: (agentId, ctx) => this.heartbeatContext(agentId, ctx.now) });
  }

  // ---- reads ----

  async list(orgId: string, opts: { includeSystem?: boolean } = {}): Promise<OrgProject[]> {
    const rows = await this.org.projects(orgId);
    return (opts.includeSystem ? rows : rows.filter((p) => p.kind === 'project')).sort((a, b) => laneOrder(a.lane) - laneOrder(b.lane) || a.rank - b.rank || a.createdAt.localeCompare(b.createdAt));
  }

  /** A project by key (P-3, any case), id or id prefix, or title. */
  async resolve(orgId: string, ref: string): Promise<OrgProject> {
    const q = (ref ?? '').trim();
    if (!q) throw new BadRequestException('project is required (its key, e.g. P-3)');
    const all = await this.org.projects(orgId);
    const hit = all.filter((p) => p.id === q || (p.key ?? '').toLowerCase() === q.toLowerCase() || (q.length >= 6 && p.id.startsWith(q)));
    if (hit.length === 1) return hit[0];
    const byTitle = all.filter((p) => p.title.toLowerCase() === q.toLowerCase());
    if (byTitle.length === 1) return byTitle[0];
    throw new BadRequestException(`no single project matches "${q}" — projects: ${all.filter((p) => p.kind === 'project').slice(0, 20).map((p) => `${p.key} ${p.title}`).join('; ') || 'none yet'}`);
  }

  // ---- system projects and placement ----

  /** The unit's Unsorted / Operating improvements project, created on first use. */
  async systemProject(orgId: string, unitId: string | null, kind: Exclude<ProjectKind, 'project'>): Promise<OrgProject | null> {
    let unit = unitId;
    if (!unit && this.units) unit = (await this.units.rootUnit(orgId).catch(() => null))?.id ?? null;
    const all = await this.org.projects(orgId);
    const hit = all.find((p) => p.kind === kind && p.unitId === unit);
    if (hit) return hit;
    const u = this.units && unit ? await this.units.get(orgId, unit).catch(() => null) : null;
    return this.org.addProject(orgId, {
      title: SYSTEM_PROJECT_TITLES[kind], kind, unitId: unit, ownerAgentId: u?.leadAgentId ?? null, lane: 'now', status: 'active',
      brief: kind === 'unsorted'
        ? { problem: 'Tasks that arrived without a project.', done_when: 'Empty: every task here is placed under the project it serves (or closed) within the orphan grace.' }
        : { problem: 'Retro and postmortem actions: work about how the company works.', hypothesis: 'A few chosen improvements at a time beat a long list of unpicked ones.', done_when: 'Each action is done, or expired and dropped.' },
    }, 'system');
  }

  /** Every task gets a project (bound into OrgTasksService.create). */
  async place(orgId: string, input: { projectId: string | null; parentTaskId: string | null; unitId: string | null; source: TaskSource; assigneeAgentId: string | null }): Promise<{ projectId: string | null; demote?: string }> {
    let project = input.projectId ? await this.org.project(orgId, input.projectId).catch(() => null) : null;
    if (!project) project = await this.systemProject(orgId, input.unitId, input.source === 'retro' ? 'operating' : 'unsorted');
    if (!project) return { projectId: input.projectId };
    if (project.kind === 'operating' && input.assigneeAgentId) {
      const org = await this.org.get(orgId);
      const cap = workTunable(org, 'work.operatingWipCap');
      const open = (await this.tasks.list(orgId, { projectId: project.id })).filter((t) => ACTIVE_OPEN.has(t.status)).length;
      if (open >= cap) return { projectId: project.id, demote: `Operating improvements holds ${open} open task(s), its cap is ${cap} (work.operatingWipCap): this one waits as a proposal` };
    }
    return { projectId: project.id };
  }

  // ---- create / update (agents propose, the CEO bets) ----

  /**
   * Create a project. A person (the CEO, a board member) creates it as
   * given — default Now and active. An agent's project starts as a
   * proposal (or `shaped` when the brief and appetite are filled), in Next
   * or Later; asking for Now becomes a `project_now` card. An agent's
   * project names at least one key result (or objective) it moves.
   */
  async create(orgId: string, input: ProjectCreate & { why?: string }, actor: string): Promise<{ project: OrgProject; card: OrgApproval | null; note: string }> {
    const agent = isAgentActor(actor);
    const goalIds = [...new Set([...(input.goalIds ?? []), ...(input.goalId ? [input.goalId] : [])])];
    if (agent && goalIds.length === 0) throw new BadRequestException('a project names the key result(s) it moves (goalIds): every project answers "why" — org_intent lists them');
    const goals = await this.org.goals(orgId);
    for (const id of goalIds) if (!goals.some((g) => g.id === id)) throw new BadRequestException(`goal ${id} is not a goal of this organization`);
    const wantsNow = (input.lane ?? (agent ? 'next' : 'now')) === 'now';
    let lead = input.ownerAgentId ?? null;
    // A roadmap item is owned by a Program Manager when the company has one
    // (docs/work-tracking.md "Project teams"); else the proposer leads it.
    if (!lead && !input.leadHumanId && (input.kind ?? 'project') === 'project') lead = await this.programManagerFor(orgId);
    if (!lead && !input.leadHumanId) lead = agent ? actorAgent(actor) : null;
    if (lead) { const m = await this.org.member(orgId, lead); if (!m || m.status === 'terminated') throw new BadRequestException('the lead must be a member of this organization'); }
    const brief = parseProjectBrief(input.brief ?? {});
    const shaped = Boolean(brief.problem && brief.done_when && ((input.appetiteDays ?? 0) > 0 || (input.appetiteUsd ?? 0) > 0));
    const unitId = input.unitId ?? (lead && this.units ? (await this.units.ledBy(orgId, lead).catch(() => null))?.id ?? (await this.units.unitForAssignee(orgId, lead).catch(() => null))?.id ?? null : null);
    const project = await this.org.addProject(orgId, {
      ...input, goalIds, ownerAgentId: lead, unitId, kind: 'project',
      lane: agent ? (wantsNow ? 'next' : input.lane ?? 'next') : input.lane ?? 'now',
      status: agent ? (shaped ? 'shaped' : 'proposed') : input.status ?? (wantsNow ? 'active' : 'shaped'),
      startDate: input.startDate ?? (!agent && wantsNow ? nowIso().slice(0, 10) : null),
    }, actor);
    let card: OrgApproval | null = null;
    let note = agent ? `Project ${project.key} "${project.title}" created as ${project.status} in ${project.lane}.` : `Project ${project.key} created.`;
    if (agent && wantsNow) { card = await this.proposeBet(orgId, project, actor, input.why ?? ''); note += ` Moving it to Now is the CEO's bet: proposed as card ${card.id.slice(0, 8)}.`; }
    return { project, card, note };
  }

  /** The company's Program Manager with the fewest open projects (title
   *  "Program Manager", the catalog's role:ops-pm), or null when it has none. */
  async programManagerFor(orgId: string): Promise<string | null> {
    const pms = (await this.org.members(orgId)).filter((m) => m.status === 'active' && /\bprogram(me)? manager\b/i.test(m.title));
    if (pms.length === 0) return null;
    const open = (await this.org.projects(orgId)).filter((p) => p.kind === 'project' && p.status !== 'done' && p.status !== 'cancelled');
    const load = (id: string) => open.filter((p) => p.ownerAgentId === id).length;
    return [...pms].sort((a, b) => load(a.agentId) - load(b.agentId) || (a.joinedAt < b.joinedAt ? -1 : 1))[0].agentId;
  }

  /** The bet card (boundary row project_bet): the CEO moves a project to Now. */
  async proposeBet(orgId: string, p: OrgProject, actor: string, why: string): Promise<OrgApproval> {
    const pending = (await this.approvals.pending(orgId)).find((a) => a.kind === 'project_now' && (JSON.parse(a.payload || '{}') as { projectId?: string }).projectId === p.id);
    if (pending) return pending;
    const d = await this.org.boundaryDecide(orgId, { kind: 'project_bet', key: p.id, summary: `move ${p.key} to Now` }, actor);
    if (d.outcome === 'refuse') throw new BadRequestException(d.reason);
    const brief = parseProjectBrief(p.brief);
    return this.approvals.create(orgId, {
      kind: 'project_now', requestedBy: actor, recommendation: why.slice(0, 600) || brief.hypothesis.slice(0, 600),
      payload: { projectId: p.id, projectKey: p.key, title: p.title, brief, goalIds: parseIdList(p.goalIds), appetiteDays: p.appetiteDays, appetiteUsd: p.appetiteUsd, targetDate: p.targetDate, boundary: d.verdict, boundaryRule: d.rule.id },
      card: { recommendedAction: 'approve' },
    });
  }

  /**
   * Change a project. A person changes anything. An agent — the lead, its
   * manager chain or the chief — edits the brief, dates, milestones, lead,
   * key results and Next/Later; Now becomes a bet card, cancelling a Now
   * project a `project_kill` card, and a raised appetite the
   * `project_appetite` path (its manager within `work.extendShare`).
   */
  async update(orgId: string, ref: string, patch: ProjectPatch & { why?: string }, actor: string): Promise<{ project: OrgProject; card: OrgApproval | null; note: string }> {
    const p = await this.resolve(orgId, ref);
    const agent = isAgentActor(actor);
    if (agent) await this.requireSteward(orgId, p, actor);
    const rest: ProjectPatch = { ...patch };
    delete (rest as { why?: string }).why;
    let card: OrgApproval | null = null;
    const notes: string[] = [];
    if (agent) {
      if (rest.lane === 'now' && p.lane !== 'now') { delete rest.lane; card = await this.proposeBet(orgId, p, actor, patch.why ?? ''); notes.push(`moving it to Now is the CEO's bet: card ${card.id.slice(0, 8)}`); }
      if (rest.status === 'cancelled' && p.lane === 'now' && p.status !== 'cancelled') {
        delete rest.status;
        const d = await this.org.boundaryDecide(orgId, { kind: 'project_kill', key: p.id, summary: `kill ${p.key}` }, actor);
        if (d.outcome === 'refuse') throw new BadRequestException(d.reason);
        card = await this.approvals.create(orgId, { kind: 'project_kill', requestedBy: actor, recommendation: (patch.why ?? '').slice(0, 600), payload: { projectId: p.id, projectKey: p.key, title: p.title, boundary: d.verdict, boundaryRule: d.rule.id }, card: { recommendedAction: 'approve' } });
        notes.push(`killing a Now project is the CEO's call: card ${card.id.slice(0, 8)}`);
      }
      if (rest.status === 'active' && p.lane !== 'now') { delete rest.status; notes.push('a project becomes active when the CEO moves it to Now'); }
      const moreDays = rest.appetiteDays !== undefined && rest.appetiteDays !== null && rest.appetiteDays > p.appetiteDays && p.lane === 'now';
      const moreUsd = rest.appetiteUsd !== undefined && rest.appetiteUsd !== null && rest.appetiteUsd > p.appetiteUsd && p.lane === 'now';
      if (moreDays || moreUsd) {
        const r = await this.decideAppetite(orgId, p.id, { decision: 'extend', extendDays: moreDays ? rest.appetiteDays! - p.appetiteDays : 0, extendUsd: moreUsd ? rest.appetiteUsd! - p.appetiteUsd : 0, note: patch.why ?? '' }, actor);
        delete rest.appetiteDays; delete rest.appetiteUsd;
        notes.push(r.note);
        card = r.card ?? card;
      }
    }
    if (rest.lane === 'now' && p.lane !== 'now') { rest.status = rest.status ?? 'active'; rest.startDate = rest.startDate ?? p.startDate ?? nowIso().slice(0, 10); }
    // Out of Now, an active bet goes back to shaped (it is no longer being worked).
    if (rest.lane && rest.lane !== 'now' && p.lane === 'now' && p.status === 'active' && rest.status === undefined) rest.status = 'shaped';
    if (rest.ownerAgentId) { const m = await this.org.member(orgId, rest.ownerAgentId); if (!m || m.status === 'terminated') throw new BadRequestException('the lead must be a member of this organization'); }
    const project = Object.keys(rest).length ? await this.org.updateProject(orgId, p.id, rest, actor) : p;
    if (project.status === 'done' && p.status !== 'done') await this.audit.append(orgId, { actor, action: 'project_done', refType: 'project', refId: p.id, payload: { key: p.key } });
    return { project, card, note: `Project ${project.key} updated${notes.length ? ` — ${notes.join('; ')}` : ''}.` };
  }

  /** May this agent steer the project: its lead, the lead's manager chain, the unit lead, or the chief. */
  private async requireSteward(orgId: string, p: OrgProject, actor: string): Promise<void> {
    const org = await this.org.get(orgId);
    const me = actorAgent(actor);
    if (actor === 'chief' || me === org.chiefOfStaffAgentId) return;
    if (me && p.ownerAgentId === me) return;
    if (me && p.ownerAgentId && (await this.managerChain(orgId, p.ownerAgentId)).includes(me)) return;
    if (me && p.unitId && this.units && (await this.units.get(orgId, p.unitId).catch(() => null))?.leadAgentId === me) return;
    throw new BadRequestException(`refused: only the lead of ${p.key} (${await this.leadName(p)}), its managers or the chief of staff change it — propose a change to them (org_task_comment) instead`);
  }

  /** The agent ids above `agentId`, nearest first (the CEO is not in it). */
  async managerChain(orgId: string, agentId: string): Promise<string[]> {
    const members = await this.org.members(orgId);
    const out: string[] = [];
    let cur = members.find((m) => m.agentId === agentId)?.reportsToAgentId ?? null;
    for (let i = 0; cur && i < 12 && !out.includes(cur); i++) { out.push(cur); cur = members.find((m) => m.agentId === cur)?.reportsToAgentId ?? null; }
    return out;
  }

  // ---- milestones ----

  async addMilestone(orgId: string, ref: string, input: { name: string; date?: string | null }, actor: string): Promise<OrgProject> {
    const p = await this.resolve(orgId, ref);
    if (isAgentActor(actor)) await this.requireSteward(orgId, p, actor);
    const list = parseMilestones(p.milestones);
    const n = list.reduce((m, x) => Math.max(m, Number(/^m(\d+)$/.exec(x.id)?.[1] ?? 0)), 0);
    return this.org.updateProject(orgId, p.id, { milestones: [...list, { id: `m${n + 1}`, name: input.name, date: input.date ?? null, done: false }] }, actor);
  }

  async setMilestone(orgId: string, ref: string, milestone: string, patch: { name?: string; date?: string | null; done?: boolean }, actor: string): Promise<OrgProject> {
    const p = await this.resolve(orgId, ref);
    if (isAgentActor(actor)) await this.requireSteward(orgId, p, actor);
    const list = parseMilestones(p.milestones);
    const q = milestone.trim().toLowerCase();
    const m = list.find((x) => x.id === q || x.name.toLowerCase() === q) ?? (/^[0-9]+$/.test(q) ? list[Number(q) - 1] : undefined);
    if (!m) throw new BadRequestException(`no milestone "${milestone}" on ${p.key} — milestones: ${list.map((x) => `${x.id} ${x.name}`).join('; ') || 'none'}`);
    if (patch.name !== undefined) m.name = patch.name;
    if (patch.date !== undefined) m.date = patch.date;
    if (patch.done !== undefined) { m.done = patch.done; m.doneAt = patch.done ? nowIso() : null; }
    const out = await this.org.updateProject(orgId, p.id, { milestones: list }, actor);
    if (patch.done) await this.audit.append(orgId, { actor, action: 'project_milestone', refType: 'project', refId: p.id, payload: { milestone: m.name } });
    return out;
  }

  // ---- health updates ----

  /**
   * The lead's health call (Linear-style): on track; at risk with the ask
   * (the support needed); off track with the reason. "Unknown, still
   * investigating" is a legitimate reason. The diff since the previous
   * update is computed, not written: target date, scope, tasks done, spend
   * against appetite, milestones.
   */
  async postUpdate(orgId: string, ref: string, input: { health: string; reason?: string; ask?: string; body?: string; hill?: number | null }, actor: string, now = new Date()): Promise<typeof orgProjectUpdates.$inferSelect> {
    const p = await this.resolve(orgId, ref);
    const health = String(input.health ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (!(PROJECT_HEALTH as readonly string[]).includes(health)) throw new BadRequestException(`health must be one of ${PROJECT_HEALTH.join(', ')}`);
    const reason = (input.reason ?? '').trim().slice(0, 600);
    const ask = (input.ask ?? '').trim().slice(0, 600);
    if (health !== 'on_track' && !reason) throw new BadRequestException(`an ${health.replace('_', ' ')} update needs its reason ("unknown, still investigating" is a fine answer)`);
    if (health === 'at_risk' && !ask) throw new BadRequestException('an at-risk update names its ask: the support needed and from whom');
    if (isAgentActor(actor)) {
      const me = actorAgent(actor);
      const org = await this.org.get(orgId);
      if (p.ownerAgentId !== me && !(me === org.chiefOfStaffAgentId && (!p.ownerAgentId || p.ownerAgentId === me))) throw new BadRequestException(`refused: the health call on ${p.key} is its lead's (${await this.leadName(p)}) — the chief drafts and chases, the lead decides`);
    }
    const hill = input.hill === undefined || input.hill === null ? null : Math.min(1, Math.max(0, Number(input.hill)));
    const prev = (await this.updates(orgId, p.id)).at(0) ?? null;
    const diff = await this.diffSince(orgId, p, prev, now);
    const row = { id: newId(), accountId: currentAccountId(), orgId, projectId: p.id, health, reason, ask, body: (input.body ?? '').slice(0, 4_000), hill, diff: JSON.stringify(diff), by: actor.slice(0, 80), createdAt: now.toISOString() };
    await this.db.insert(orgProjectUpdates).values(row);
    await this.org.updateProject(orgId, p.id, { health, healthReason: reason, healthAsk: ask, healthAt: row.createdAt, ...(hill !== null ? { hill } : {}) }, actor);
    await this.audit.append(orgId, { actor, action: 'project_health', refType: 'project', refId: p.id, payload: { key: p.key, health, reason: reason.slice(0, 200), ask: ask.slice(0, 200) } });
    return row;
  }

  updates(orgId: string, projectId: string, limit = 50) {
    return this.db.select().from(orgProjectUpdates).where(and(eq(orgProjectUpdates.orgId, orgId), eq(orgProjectUpdates.projectId, projectId))).orderBy(desc(orgProjectUpdates.createdAt)).limit(limit);
  }

  private async diffSince(orgId: string, p: OrgProject, prev: typeof orgProjectUpdates.$inferSelect | null, now: Date): Promise<Record<string, unknown>> {
    const since = prev?.createdAt ?? p.createdAt;
    const tasks = await this.tasks.list(orgId, { projectId: p.id });
    const spent = (await this.spendByProject(orgId)).get(p.id) ?? 0;
    const prevDiff = prev ? (JSON.parse(prev.diff || '{}') as Record<string, unknown>) : {};
    const prog = progressOf(tasks);
    return {
      since, targetDate: p.targetDate, targetDateWas: prevDiff.targetDate ?? null,
      done: tasks.filter((t) => t.doneAt && t.doneAt >= since).length,
      scope: prog.total, scopeWas: prevDiff.scope ?? null,
      spentUsd: Math.round(spent * 100) / 100, appetiteUsd: p.appetiteUsd, appetiteDays: p.appetiteDays,
      blocked: tasks.filter((t) => t.status === 'blocked').length,
      aged: tasks.filter((t) => OPEN.has(t.status) && now.getTime() - Date.parse(t.updatedAt) > 7 * DAY_MS).length,
      milestonesDone: parseMilestones(p.milestones).filter((m) => m.done && (m.doneAt ?? '') >= since).map((m) => m.name),
      progressPct: prog.pct,
    };
  }

  // ---- cadence ----

  cadenceDays(org: Organization, p: OrgProject): number { return p.updateCadenceDays ?? workTunable(org, 'work.updateCadenceDays'); }

  /** Whether a health update is owed: only an active project in Now of kind
   *  `project` owes one. `due` from the due day, `missing` past the grace. */
  updateState(org: Organization, p: OrgProject, now: Date): { state: UpdateState; dueAt: string | null; cadenceDays: number } {
    const cadenceDays = this.cadenceDays(org, p);
    if (p.kind !== 'project' || p.lane !== 'now' || p.status !== 'active') return { state: 'none', dueAt: null, cadenceDays };
    const last = Date.parse(p.healthAt ?? (p.startDate ? `${p.startDate}T00:00:00.000Z` : p.createdAt));
    const due = (Number.isFinite(last) ? last : now.getTime()) + cadenceDays * DAY_MS;
    const grace = workTunable(org, 'work.updateMissingGraceDays') * DAY_MS;
    const state: UpdateState = now.getTime() >= due + grace ? 'missing' : now.getTime() >= due ? 'due' : 'fresh';
    return { state, dueAt: new Date(due).toISOString(), cadenceDays };
  }

  // ---- the appetite circuit breaker ----

  /** USD spent per project (all runs on its tasks). */
  async spendByProject(orgId: string): Promise<Map<string, number>> {
    const res = await this.db.execute(sql`SELECT t."projectId" AS "projectId", COALESCE(SUM(r."usd"), 0) AS usd FROM org_runs r JOIN org_tasks t ON t."id" = r."taskId" WHERE r."orgId" = ${orgId} AND t."projectId" IS NOT NULL GROUP BY t."projectId"`);
    const rows = ((res as { rows?: unknown[] }).rows ?? []) as Array<{ projectId: string; usd: number | string }>;
    return new Map(rows.map((r) => [r.projectId, Number(r.usd) || 0]));
  }

  appetiteOf(p: OrgProject, spentUsd: number, now: Date): ProjectSummary['appetite'] {
    const start = p.startDate ? Date.parse(`${p.startDate}T00:00:00.000Z`) : NaN;
    const daysUsed = Number.isFinite(start) && p.lane === 'now' ? Math.max(0, Math.floor((now.getTime() - start) / DAY_MS)) : null;
    return {
      days: p.appetiteDays, usd: p.appetiteUsd, spentUsd: Math.round(spentUsd * 10_000) / 10_000,
      usdShare: p.appetiteUsd > 0 ? spentUsd / p.appetiteUsd : null,
      daysUsed, daysShare: p.appetiteDays > 0 && daysUsed !== null ? daysUsed / p.appetiteDays : null,
      tripped: Boolean(p.breakerAt), breakerAt: p.breakerAt ?? null,
    };
  }

  /**
   * Check one project's appetite and act once: at the warn share the lead
   * is asked for an update (an inbox event; the heartbeat lists it); at
   * 100% the breaker trips — claims pause and the decision goes to the
   * lead's manager chain. Returns the state after.
   */
  async checkBreaker(orgId: string, projectId: string, now = new Date()): Promise<{ tripped: boolean; warned: boolean }> {
    const p = await this.org.project(orgId, projectId);
    if (p.kind !== 'project' || p.lane !== 'now' || ['done', 'cancelled'].includes(p.status)) return { tripped: Boolean(p.breakerAt), warned: false };
    const org = await this.org.get(orgId);
    const a = this.appetiteOf(p, (await this.spendByProject(orgId)).get(p.id) ?? 0, now);
    const share = Math.max(a.usdShare ?? 0, a.daysShare ?? 0);
    if (p.breakerAt) return { tripped: true, warned: false };
    if (share >= 1) {
      await this.org.updateProject(orgId, p.id, { breakerAt: now.toISOString() }, 'system');
      await this.audit.append(orgId, { actor: 'system', action: 'project_breaker', refType: 'project', refId: p.id, payload: { key: p.key, spentUsd: a.spentUsd, appetiteUsd: p.appetiteUsd, daysUsed: a.daysUsed, appetiteDays: p.appetiteDays } });
      await this.raiseAppetiteDecision(org, await this.org.project(orgId, p.id), a);
      return { tripped: true, warned: false };
    }
    if (share >= workTunable(org, 'work.appetiteWarnShare') && !p.appetiteWarnedAt) {
      await this.org.updateProject(orgId, p.id, { appetiteWarnedAt: now.toISOString() }, 'system');
      if (p.ownerAgentId) await this.agents.addEvent(p.ownerAgentId, { kind: 'info', title: `${p.key} "${p.title}" used ${Math.round(share * 100)}% of its appetite — post a health update`.slice(0, 200), body: describeAppetite(a), payload: JSON.stringify({ orgId, projectId: p.id }), origin: 'org' }).catch(() => undefined);
      return { tripped: false, warned: true };
    }
    return { tripped: false, warned: false };
  }

  /** Who decides a tripped project: the lead's manager (an agent) — a
   *  decision task on its board; the CEO when the lead is the chief, a
   *  person, or reports to nobody — a `project_appetite` card. */
  private async raiseAppetiteDecision(org: Organization, p: OrgProject, a: ProjectSummary['appetite']): Promise<void> {
    const lead = p.ownerAgentId;
    // Decision routing (docs/owners-seat.md §7): the lead's direct manager first.
    // An agent manager gets a decision task; a person or the CEO a card the router places.
    const routed = lead && this.decisions ? await this.decisions.routeDecision(org.id, lead, 'project_appetite', { projectId: p.id }).catch(() => null) : null;
    const manager = routed ? holderAgent(routed.holder) : lead && lead !== org.chiefOfStaffAgentId ? (await this.managerChain(org.id, lead))[0] ?? null : null;
    const extendUsd = p.appetiteUsd > 0 ? Math.round(p.appetiteUsd * 0.5 * 100) / 100 : 0;
    const extendDays = p.appetiteDays > 0 ? Math.max(1, Math.round(p.appetiteDays * 0.5)) : 0;
    if (!manager) {
      await this.approvals.create(org.id, {
        kind: 'project_appetite', requestedBy: lead && routed ? `agent:${lead}` : 'system', recommendation: `${describeAppetite(a)}. ${workTunable(org, 'work.breakerDefaultExtend') >= 1 ? 'The default is to extend.' : 'The default is to cancel (the circuit breaker).'}`,
        payload: { projectId: p.id, projectKey: p.key, title: p.title, spentUsd: a.spentUsd, appetiteUsd: p.appetiteUsd, daysUsed: a.daysUsed, appetiteDays: p.appetiteDays, extendUsd, extendDays, health: p.health, healthReason: p.healthReason },
        card: { recommendedAction: workTunable(org, 'work.breakerDefaultExtend') >= 1 ? 'approve' : 'deny', alternatives: ['Approve: extend by the amount shown', 'Reject: kill the project (cancel its open tasks)', 'Revise: cut scope — finish what fits a small extension'] },
      });
      return;
    }
    const existing = (await this.tasks.list(org.id, { projectId: p.id })).find((t) => t.assigneeAgentId === manager && t.source === 'escalation' && t.title.startsWith('Appetite reached:') && OPEN.has(t.status));
    if (existing) return;
    const unit = this.units ? await this.units.ledBy(org.id, manager).catch(() => null) : null;
    await this.tasks.create(org.id, {
      title: `Appetite reached: ${p.key} ${p.title}`.slice(0, 200), projectId: p.id, assigneeAgentId: manager, status: 'todo', createdBy: 'system', source: 'escalation', unitId: unit?.id ?? null,
      brief: {
        outcome: `A decision on ${p.key} "${p.title}": extend its appetite, cut its scope, or kill it.`,
        context: `${describeAppetite(a)}. New task claims in the project are paused until you decide. Lead: ${await this.leadName(p)}. Latest health: ${p.health || 'none'}${p.healthReason ? ` — ${p.healthReason}` : ''}.`,
        constraints: `Decide with org_project_appetite (extend | cut_scope | kill). You may extend by up to ${Math.round(workTunable(org, 'work.extendShare') * 100)}% of the original appetite alone (work.extendShare); more goes to the CEO as a card. ${workTunable(org, 'work.breakerDefaultExtend') >= 1 ? 'This company extends by default.' : 'The circuit breaker cancels by default: extend only with a reason.'}`,
        done_when: 'org_project_appetite was called; the project is extended, cut or killed.',
      },
    });
  }

  /** The claim gate (bound into OrgTasksService.claimBlocker). */
  async claimGate(orgId: string, task: OrgTask): Promise<string | null> {
    if (!task.projectId || task.source === 'escalation') return null;
    const p = await this.org.project(orgId, task.projectId).catch(() => null);
    if (!p) return null;
    if (p.status === 'cancelled') return `project ${p.key} was cancelled`;
    if (p.status === 'paused') return `project ${p.key} is paused`;
    if (!p.breakerAt) await this.checkBreaker(orgId, p.id).catch(() => undefined);
    const after = await this.org.project(orgId, p.id);
    return after.breakerAt ? `project ${p.key} used up its appetite (circuit breaker since ${after.breakerAt.slice(0, 16).replace('T', ' ')}): new claims wait for its extend / cut scope / kill decision` : null;
  }

  /**
   * Decide a tripped (or to-be-extended) project. `extend` adds days / USD
   * (a manager within `work.extendShare` of the original appetite alone;
   * beyond it, or the chief deciding its own project, a card for the CEO);
   * `cut_scope` grants a small extension and asks the lead to cancel or move
   * out what does not fit; `kill` cancels the project and its open tasks
   * (a person, or an approved `project_kill` card).
   */
  async decideAppetite(orgId: string, ref: string, input: { decision: 'extend' | 'cut_scope' | 'kill'; extendDays?: number; extendUsd?: number; note?: string }, actor: string): Promise<{ project: OrgProject; card: OrgApproval | null; note: string }> {
    const p = await this.resolve(orgId, ref);
    const org = await this.org.get(orgId);
    if (!['extend', 'cut_scope', 'kill'].includes(input.decision)) throw new BadRequestException('decision must be extend, cut_scope or kill');
    if (isAgentActor(actor)) {
      const me = actorAgent(actor) ?? org.chiefOfStaffAgentId;
      const chain = p.ownerAgentId ? await this.managerChain(orgId, p.ownerAgentId) : [];
      if (!me || !chain.includes(me)) throw new BadRequestException(`refused: ${p.key}'s appetite is decided by its lead's manager chain (${chain.length ? (await Promise.all(chain.map((id) => this.agentName(id)))).join(' → ') : 'the CEO'})`);
      const share = workTunable(org, 'work.extendShare');
      const beyond = input.decision === 'kill'
        || (input.extendUsd ?? 0) > p.appetiteUsd * share + 1e-9 || (input.extendDays ?? 0) > Math.ceil(p.appetiteDays * share)
        || p.ownerAgentId === org.chiefOfStaffAgentId;
      const d = await this.org.boundaryDecide(orgId, { kind: input.decision === 'kill' ? 'project_kill' : 'project_appetite', key: p.id, withinEnvelope: !beyond, summary: `${input.decision.replace('_', ' ')} ${p.key}` }, actor);
      if (d.outcome === 'refuse') throw new BadRequestException(d.reason);
      if (d.outcome !== 'proceed') {
        const card = await this.approvals.create(orgId, {
          kind: input.decision === 'kill' ? 'project_kill' : 'project_appetite', requestedBy: actor, recommendation: (input.note ?? '').slice(0, 600),
          payload: { projectId: p.id, projectKey: p.key, title: p.title, extendUsd: input.extendUsd ?? 0, extendDays: input.extendDays ?? 0, boundary: d.verdict, boundaryRule: d.rule.id },
          card: { recommendedAction: 'approve' },
        });
        return { project: p, card, note: `${input.decision === 'kill' ? 'Killing' : 'Extending'} ${p.key} beyond your share is the CEO's decision: card ${card.id.slice(0, 8)}` };
      }
    }
    const project = await this.applyAppetite(orgId, p.id, input, actor);
    return { project: project as unknown as OrgProject, card: null, note: `${p.key}: ${input.decision.replace('_', ' ')} applied` };
  }

  /** Apply an appetite decision (no gating: a person, an approved card, or a manager within its share). */
  async applyAppetite(orgId: string, projectId: string, input: { decision: 'extend' | 'cut_scope' | 'kill'; extendDays?: number; extendUsd?: number; note?: string }, actor: string, card?: OrgApproval): Promise<Record<string, unknown>> {
    const p = await this.org.project(orgId, projectId);
    void card;
    if (input.decision === 'kill') {
      await this.org.updateProject(orgId, p.id, { status: 'cancelled', lane: 'later', breakerAt: null }, actor);
      let cancelled = 0;
      for (const t of (await this.tasks.list(orgId, { projectId: p.id })).filter((x) => OPEN.has(x.status))) {
        await this.tasks.update(orgId, t.id, { status: 'cancelled' }, actor).catch(() => undefined);
        cancelled++;
      }
      await this.audit.append(orgId, { actor, action: 'project_kill', refType: 'project', refId: p.id, payload: { key: p.key, cancelled, note: (input.note ?? '').slice(0, 300) } });
      return { projectId: p.id, killed: true, cancelled };
    }
    const smallUsd = p.appetiteUsd > 0 ? Math.round(p.appetiteUsd * 0.2 * 100) / 100 : 0;
    const smallDays = p.appetiteDays > 0 ? Math.max(1, Math.round(p.appetiteDays * 0.2)) : 0;
    const addUsd = input.decision === 'cut_scope' ? Math.max(input.extendUsd ?? 0, smallUsd) : Math.max(0, input.extendUsd ?? 0) || (input.extendDays ? 0 : Math.round(p.appetiteUsd * 0.5 * 100) / 100);
    const addDays = input.decision === 'cut_scope' ? Math.max(input.extendDays ?? 0, smallDays) : Math.max(0, Math.round(input.extendDays ?? 0)) || (input.extendUsd ? 0 : Math.round(p.appetiteDays * 0.5));
    const after = await this.org.updateProject(orgId, p.id, { appetiteUsd: p.appetiteUsd + addUsd, appetiteDays: p.appetiteDays + addDays, breakerAt: null, appetiteWarnedAt: null }, actor);
    await this.audit.append(orgId, { actor, action: input.decision === 'cut_scope' ? 'project_cut_scope' : 'project_extend', refType: 'project', refId: p.id, payload: { key: p.key, addUsd, addDays, note: (input.note ?? '').slice(0, 300) } });
    // The decision task (if any) is done.
    for (const t of (await this.tasks.list(orgId, { projectId: p.id })).filter((x) => x.source === 'escalation' && x.title.startsWith('Appetite reached:') && OPEN.has(x.status))) {
      await this.tasks.update(orgId, t.id, { status: 'done' }, actor).catch(() => undefined);
    }
    if (input.decision === 'cut_scope' && p.ownerAgentId) {
      await this.agents.addEvent(p.ownerAgentId, { kind: 'info', title: `Cut scope on ${p.key} "${p.title}"`.slice(0, 200), body: `Extended by ${addDays ? `${addDays} day(s)` : ''}${addDays && addUsd ? ' and ' : ''}${addUsd ? `$${addUsd.toFixed(2)}` : ''} to finish what fits. Cancel or move out the tasks that do not (org_task_update / org_link_task), then post a health update.${input.note ? ` Note: ${input.note}` : ''}`.slice(0, 1_000), payload: JSON.stringify({ orgId, projectId: p.id }), origin: 'org' }).catch(() => undefined);
    }
    return { projectId: p.id, appetiteUsd: after.appetiteUsd, appetiteDays: after.appetiteDays, decision: input.decision };
  }

  /** An approved bet: the project moves to Now and starts. */
  async applyBet(orgId: string, projectId: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const p = await this.org.project(orgId, projectId);
    const patch: ProjectPatch = { lane: 'now', status: 'active', startDate: p.startDate ?? nowIso().slice(0, 10) };
    if (typeof payload.appetiteDays === 'number' && payload.appetiteDays > 0 && !p.appetiteDays) patch.appetiteDays = payload.appetiteDays;
    if (typeof payload.appetiteUsd === 'number' && payload.appetiteUsd > 0 && !p.appetiteUsd) patch.appetiteUsd = payload.appetiteUsd;
    const after = await this.org.updateProject(orgId, p.id, patch, 'user');
    if (after.ownerAgentId) await this.agents.addEvent(after.ownerAgentId, { kind: 'info', title: `The CEO moved ${after.key} "${after.title}" to Now`.slice(0, 200), body: 'Break it into tasks under the project (org_create_task with projectId), set milestones, and post a health update on its cadence.', payload: JSON.stringify({ orgId, projectId: p.id }), origin: 'org' }).catch(() => undefined);
    return { projectId: p.id, lane: after.lane, status: after.status };
  }

  /** Move a task to another project (its lead, the task owner's head, the chief; a person any). */
  async linkTask(orgId: string, taskRefStr: string, projectRef: string, actor: string): Promise<OrgTask> {
    const t = await this.tasks.byPrefix(orgId, taskRefStr);
    const p = await this.resolve(orgId, projectRef);
    if (['done', 'cancelled'].includes(p.status)) throw new BadRequestException(`project ${p.key} is ${p.status}`);
    if (isAgentActor(actor)) {
      const me = actorAgent(actor);
      const org = await this.org.get(orgId);
      const from = t.projectId ? await this.org.project(orgId, t.projectId).catch(() => null) : null;
      const ok = actor === 'chief' || me === org.chiefOfStaffAgentId || t.assigneeAgentId === me || p.ownerAgentId === me || from?.ownerAgentId === me
        || (t.assigneeAgentId && me ? (await this.managerChain(orgId, t.assigneeAgentId)).includes(me) : false);
      if (!ok) throw new BadRequestException(`refused: ${taskRef(t)} is moved by its owner, its manager, either project's lead or the chief`);
    }
    return this.tasks.update(orgId, t.id, { projectId: p.id }, actor);
  }

  // ---- views ----

  private async names(): Promise<Map<string, string>> { return new Map((await this.agents.list()).map((a) => [a.id, a.name])); }
  private async agentName(id: string): Promise<string> { return (await this.agents.get(id).catch(() => null))?.name ?? id.slice(0, 8); }
  private async leadName(p: OrgProject): Promise<string> { return p.ownerAgentId ? this.agentName(p.ownerAgentId) : p.leadHumanId ? 'a person' : 'nobody'; }

  /** Summaries of every project (system ones on request), with the derived signals. */
  async summaries(orgId: string, now = new Date(), opts: { includeSystem?: boolean } = {}): Promise<ProjectSummary[]> {
    const org = await this.org.get(orgId);
    const projects = await this.list(orgId, { includeSystem: opts.includeSystem });
    const tasks = await this.tasks.list(orgId);
    const goals = await this.org.goals(orgId);
    const spend = await this.spendByProject(orgId);
    const names = await this.names();
    const units = this.units ? new Map((await this.units.units(orgId)).map((u) => [u.id, u.parentUnitId === null ? 'Company' : u.name])) : new Map<string, string>();
    const doneAts = (await this.db.select({ taskId: taskTransitions.taskId, at: taskTransitions.at }).from(taskTransitions).where(and(eq(taskTransitions.orgId, orgId), eq(taskTransitions.toStatus, 'done'))));
    const doneAtsByTask = new Map<string, string[]>();
    for (const d of doneAts) { const l = doneAtsByTask.get(d.taskId) ?? []; l.push(d.at); doneAtsByTask.set(d.taskId, l); }
    const minSamples = workTunable(org, 'work.forecastMinSamples');
    // The company's throughput feeds every project's forecast when a project's own history is short.
    const companyDone = doneAts.map((d) => d.at);
    return projects.map((p): ProjectSummary => {
      const mine = tasks.filter((t) => t.projectId === p.id);
      const prog = progressOf(mine);
      const ap = this.appetiteOf(p, spend.get(p.id) ?? 0, now);
      const goalIds = parseIdList(p.goalIds);
      const late = Boolean(p.targetDate && p.targetDate < now.toISOString().slice(0, 10) && !['done', 'cancelled'].includes(p.status));
      const own = mine.flatMap((t) => doneAtsByTask.get(t.id) ?? []);
      const remaining = mine.filter((t) => OPEN.has(t.status)).length;
      const forecast = own.length >= minSamples ? forecastFrom(own, remaining, now, { minSamples }) : forecastFrom(companyDone, remaining, now, { minSamples: Math.max(minSamples, minSamples * 2) });
      if (forecast.state === 'range' && own.length < minSamples) forecast.note = `From the company's throughput (${forecast.samples} done in the window; the project's own history is ${own.length}). ${forecast.note.replace(/^From [^;]+; /, '')}`;
      const brief = parseProjectBrief(p.brief);
      return {
        id: p.id, key: p.key, title: p.title, kind: p.kind, status: p.status, lane: p.lane, rank: p.rank, unitId: p.unitId, unitName: p.unitId ? units.get(p.unitId) ?? null : null,
        lead: p.ownerAgentId ? { kind: 'agent', id: p.ownerAgentId, name: names.get(p.ownerAgentId) ?? p.ownerAgentId.slice(0, 8) } : p.leadHumanId ? { kind: 'person', id: p.leadHumanId, name: 'a person' } : { kind: 'none', id: null, name: 'nobody' },
        goalIds, goals: goalIds.map((id) => goals.find((g) => g.id === id)).filter((g): g is NonNullable<typeof g> => Boolean(g)).map((g) => ({ id: g.id, title: g.title, kind: g.kind, parentGoalId: g.parentGoalId })),
        startDate: p.startDate, targetDate: p.targetDate, milestones: parseMilestones(p.milestones),
        progress: prog, hill: p.hill ?? inferredHill(mine), hillInferred: p.hill === null || p.hill === undefined,
        health: p.health, healthReason: p.healthReason, healthAsk: p.healthAsk, healthAt: p.healthAt,
        update: this.updateState(org, p, now), appetite: ap,
        blocked: mine.filter((t) => t.status === 'blocked').length, late,
        overBudget: Boolean((ap.usdShare ?? 0) >= 1 || (ap.daysShare ?? 0) >= 1),
        forecast, briefOk: Boolean(brief.problem && brief.done_when),
      };
    });
  }

  /** The roadmap: projects with the goal tree and units to group them by. */
  async roadmap(orgId: string, now = new Date()): Promise<{ generatedAt: string; today: string; projects: ProjectSummary[]; goals: Array<{ id: string; title: string; kind: string; parentGoalId: string | null; status: string; dueAt: string | null }>; units: Array<{ id: string; name: string; parentUnitId: string | null }>; system: ProjectSummary[] }> {
    const all = await this.summaries(orgId, now, { includeSystem: true });
    const goals = (await this.org.goals(orgId)).filter((g) => g.status !== 'abandoned').map((g) => ({ id: g.id, title: g.title, kind: g.kind, parentGoalId: g.parentGoalId, status: g.status, dueAt: g.dueAt }));
    const units = this.units ? (await this.units.units(orgId)).map((u) => ({ id: u.id, name: u.parentUnitId === null ? 'Company' : u.name, parentUnitId: u.parentUnitId })) : [];
    return { generatedAt: now.toISOString(), today: now.toISOString().slice(0, 10), projects: all.filter((p) => p.kind === 'project'), goals, units, system: all.filter((p) => p.kind !== 'project') };
  }

  /** The project page. */
  async page(orgId: string, ref: string, now = new Date()): Promise<ProjectPage> {
    const p = await this.resolve(orgId, ref);
    const summary = (await this.summaries(orgId, now, { includeSystem: true })).find((x) => x.id === p.id);
    if (!summary) throw new NotFoundException(`project ${ref}`);
    const tasks = await this.tasks.list(orgId, { projectId: p.id });
    const names = await this.names();
    const all = await this.tasks.list(orgId);
    const byId = new Map(all.map((t) => [t.id, t]));
    const nameOf = (kind: string, r: string) => (kind === 'task' ? (byId.get(r) ? taskLabel(byId.get(r)!) : r.slice(0, 8)) : names.get(r) ?? r.slice(0, 8));
    const order = ['in_progress', 'claimed', 'in_review', 'blocked', 'waiting', 'todo', 'backlog', 'done', 'cancelled'];
    const rows = tasks.slice().sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || b.updatedAt.localeCompare(a.updatedAt)).map((t) => {
      const b = parseBlockedOn(t.blockedOn);
      const steps = parseSteps(t.steps).filter((x) => !x.dropped);
      return {
        id: t.id, key: t.key, title: t.title, status: t.status, assigneeAgentId: t.assigneeAgentId, assigneeHumanId: t.assigneeHumanId, source: t.source, dueAt: t.dueAt, doneAt: t.doneAt, startedAt: t.startedAt, updatedAt: t.updatedAt, unitId: t.unitId,
        assigneeName: t.assigneeAgentId ? names.get(t.assigneeAgentId) ?? '' : t.assigneeHumanId ? 'a person' : 'unassigned',
        blockedOn: t.status === 'blocked' || t.status === 'waiting' ? b : null, blockedText: t.status === 'blocked' && b ? describeBlockedOn(b, nameOf as never) : '',
        steps: { done: steps.filter((x) => x.done).length, total: steps.length },
      };
    });
    const blockers = tasks.filter((t) => t.status === 'blocked').map((t) => {
      const b = parseBlockedOn(t.blockedOn);
      return { taskId: t.id, key: t.key, title: t.title, kind: b?.kind ?? 'external', text: b ? describeBlockedOn(b, nameOf as never) : 'blocked (no reason recorded)', since: b?.since || t.updatedAt };
    });
    const cards = (await this.db.select().from(orgApprovals).where(eq(orgApprovals.orgId, orgId))).filter((a) => {
      const pl = JSON.parse(a.payload || '{}') as { projectId?: string; taskId?: string };
      return pl.projectId === p.id || (pl.taskId ? tasks.some((t) => t.id === pl.taskId) : false);
    });
    const logged = (await this.db.select().from(orgDecisions).where(eq(orgDecisions.orgId, orgId))).filter((d) => (d.refType === 'project' && d.refId === p.id) || (d.refType === 'task' && tasks.some((t) => t.id === d.refId)) || (d.approvalId ? cards.some((c) => c.id === d.approvalId) : false));
    const decisions = [
      ...cards.map((a) => ({ id: a.id, kind: a.kind, title: a.kind.replace(/_/g, ' '), status: a.status, at: a.decidedAt ?? a.createdAt, via: 'card' as const })),
      ...logged.map((d) => ({ id: d.id, kind: 'decision', title: d.title, status: 'decided', at: d.createdAt, via: 'log' as const })),
    ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 40);
    // Files the project's tasks touched: their file scopes.
    const files = tasks.flatMap((t) => { try { return (JSON.parse(t.fileScope || '[]') as string[]).map((path) => ({ path, taskId: t.id })); } catch { return []; } }).slice(0, 40);
    const burnRes = await this.db.execute(sql`SELECT SUBSTRING(r."startedAt", 1, 10) AS day, COALESCE(SUM(r."usd"), 0) AS usd FROM org_runs r JOIN org_tasks t ON t."id" = r."taskId" WHERE r."orgId" = ${orgId} AND t."projectId" = ${p.id} GROUP BY 1 ORDER BY 1`);
    const burn = (((burnRes as { rows?: unknown[] }).rows ?? []) as Array<{ day: string; usd: number | string }>).map((r) => ({ day: String(r.day), usd: Number(r.usd) || 0 }));
    const weeks = new Map<string, number>();
    for (const t of tasks.filter((x) => x.doneAt)) { const wk = weekOf(t.doneAt!); weeks.set(wk, (weeks.get(wk) ?? 0) + 1); }
    return {
      project: { ...summary, brief: parseProjectBrief(p.brief), createdAt: p.createdAt, createdBy: p.createdBy, updateCadenceDays: p.updateCadenceDays },
      updates: await this.updates(orgId, p.id), tasks: rows, blockers, decisions, files, burn,
      throughput: [...weeks.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([week, done]) => ({ week, done })),
    };
  }

  /** Home's portfolio for the CEO: exceptions first, then the digest of
   *  project changes since `since` and what got done, by project. */
  async portfolio(orgId: string, since: string, now = new Date()): Promise<Portfolio> {
    const list = await this.summaries(orgId, now);
    const live = list.filter((p) => !['done', 'cancelled'].includes(p.status));
    const counts = {
      now: live.filter((p) => p.lane === 'now').length, next: live.filter((p) => p.lane === 'next').length, later: live.filter((p) => p.lane === 'later').length,
      atRisk: live.filter((p) => p.health === 'at_risk').length, offTrack: live.filter((p) => p.health === 'off_track').length,
      updateMissing: live.filter((p) => p.update.state === 'missing').length, overBudget: live.filter((p) => p.overBudget).length, late: live.filter((p) => p.late).length,
    };
    const exceptions: Portfolio['exceptions'] = [];
    for (const p of live) {
      const kinds: Portfolio['exceptions'][number]['kinds'] = [];
      if (p.health === 'off_track') kinds.push('off_track');
      if (p.health === 'at_risk') kinds.push('at_risk');
      if (p.update.state === 'missing') kinds.push('update_missing');
      if (p.appetite.tripped) kinds.push('tripped');
      else if (p.overBudget) kinds.push('over_budget');
      if (p.late) kinds.push('late');
      if (kinds.length === 0) continue;
      const detail = [
        p.health !== 'on_track' && p.healthReason ? p.healthReason : '',
        p.healthAsk ? `Ask: ${p.healthAsk}` : '',
        p.update.state === 'missing' ? `no health update since ${p.healthAt ? p.healthAt.slice(0, 10) : 'it started'}` : '',
        p.appetite.usdShare !== null && p.appetite.usdShare >= 1 ? `spent $${p.appetite.spentUsd.toFixed(2)} of $${p.appetite.usd.toFixed(2)}` : '',
        p.appetite.daysShare !== null && p.appetite.daysShare >= 1 ? `${p.appetite.daysUsed} of ${p.appetite.days} day(s)` : '',
        p.late ? `target ${p.targetDate} passed` : '',
      ].filter(Boolean).join(' · ');
      exceptions.push({ projectId: p.id, key: p.key, title: p.title, kinds, detail, leadName: p.lead.name });
    }
    const rank = (k: Portfolio['exceptions'][number]['kinds'][number]) => ['off_track', 'tripped', 'update_missing', 'at_risk', 'over_budget', 'late'].indexOf(k);
    exceptions.sort((a, b) => Math.min(...a.kinds.map(rank)) - Math.min(...b.kinds.map(rank)));
    const byId = new Map(list.map((p) => [p.id, p]));
    const digest: Portfolio['digest'] = [];
    for (const r of (await this.audit.list(orgId, { limit: 400 })).filter((x) => x.refType === 'project' && x.createdAt >= since)) {
      const p = byId.get(r.refId);
      if (!p) continue;
      const pl = JSON.parse(r.payload || '{}') as Record<string, unknown>;
      const push = (kind: Portfolio['digest'][number]['kind'], text: string) => digest.push({ at: r.createdAt, projectId: p.id, key: p.key, title: p.title, kind, text });
      if (r.action === 'project_health') push('health', `${String(pl.health ?? '').replace('_', ' ')}${pl.reason ? `: ${String(pl.reason)}` : ''}`);
      else if (r.action === 'project_create') push('created', `created in ${String(pl.lane ?? 'later')}`);
      else if (r.action === 'project_breaker') push('breaker', 'used up its appetite: claims paused');
      else if (r.action === 'project_milestone') push('milestone', `milestone done: ${String(pl.milestone ?? '')}`);
      else if (r.action === 'project_done') push('done', 'marked done');
      else if (r.action === 'project_kill') push('lane', 'killed');
      else if (r.action === 'project_extend' || r.action === 'project_cut_scope') push('breaker', r.action === 'project_extend' ? 'appetite extended' : 'scope cut, small extension');
      else if (r.action === 'project_update' && typeof pl.lane === 'string') push('lane', `moved to ${pl.lane}`);
      else if (r.action === 'project_update' && 'targetDate' in pl) push('target', `target date → ${String(pl.targetDate ?? 'none')}`);
    }
    digest.sort((a, b) => b.at.localeCompare(a.at));
    const tasks = await this.tasks.list(orgId);
    const doneBy = new Map<string, number>();
    for (const t of tasks.filter((x) => x.status === 'done' && x.doneAt && x.doneAt >= since && x.projectId)) doneBy.set(t.projectId!, (doneBy.get(t.projectId!) ?? 0) + 1);
    const allProjects = new Map((await this.org.projects(orgId)).map((p) => [p.id, p]));
    const doneByProject = [...doneBy.entries()].map(([id, done]) => ({ projectId: id, key: allProjects.get(id)?.key ?? null, title: allProjects.get(id)?.title ?? '', done })).sort((a, b) => b.done - a.done);
    const nowProjects: Portfolio['nowProjects'] = live.filter((p) => p.lane === 'now' && p.kind === 'project').sort((a, b) => a.rank - b.rank).map((p) => ({
      projectId: p.id, key: p.key, title: p.title, health: (['on_track', 'at_risk', 'off_track'].includes(p.health) ? p.health : '') as Portfolio['nowProjects'][number]['health'],
      progress: p.progress, targetDate: p.targetDate, late: p.late, blocked: p.blocked, leadName: p.lead.name,
    }));
    return { generatedAt: now.toISOString(), counts, exceptions, digest: digest.slice(0, 30), doneByProject, nowProjects };
  }

  // ---- the heartbeat (docs/work-tracking.md "Health cadence") ----

  /** Why a member's heartbeat opens for its projects: a health update due,
   *  an appetite warning, an appetite decision it owes, orphans in a unit it
   *  leads past the grace, a task paused for circular behaviour in its
   *  project; for the chief, every Update missing to chase. Model-free. */
  async heartbeatReasons(agentId: string, now: Date): Promise<string[]> {
    const out: string[] = [];
    for (const m of (await this.org.membershipsOf(agentId)).filter((x) => x.status === 'active')) {
      const org = await this.org.get(m.orgId).catch(() => null);
      if (!org || org.status !== 'active') continue;
      const projects = await this.org.projects(org.id);
      const isChief = org.chiefOfStaffAgentId === agentId;
      for (const p of projects.filter((x) => x.ownerAgentId === agentId && x.kind === 'project')) {
        await this.checkBreaker(org.id, p.id, now).catch(() => undefined);
        const u = this.updateState(org, p, now);
        if (u.state === 'due' || u.state === 'missing') out.push(`project ${p.key} "${p.title}" is ${u.state === 'missing' ? 'MISSING its' : 'due a'} health update (org_project_update: on_track | at_risk with the ask | off_track with the reason; cadence ${u.cadenceDays} day(s))`);
        const fresh = await this.org.project(org.id, p.id);
        if (fresh.appetiteWarnedAt && !fresh.breakerAt && (!fresh.healthAt || fresh.healthAt < fresh.appetiteWarnedAt)) out.push(`project ${p.key} passed ${Math.round(workTunable(org, 'work.appetiteWarnShare') * 100)}% of its appetite: post a health update (org_project_update)`);
      }
      // An appetite decision this member owes (a decision task is listed by the org provider; the card path is the CEO's).
      for (const p of projects.filter((x) => x.breakerAt && x.ownerAgentId && x.ownerAgentId !== agentId)) {
        if ((await this.managerChain(org.id, p.ownerAgentId!))[0] === agentId) out.push(`project ${p.key} "${p.title}" used up its appetite: decide with org_project_appetite (extend | cut_scope | kill)`);
      }
      // Orphans past the grace in a unit this member leads (the chief: any).
      const grace = workTunable(org, 'work.orphanGraceHours') * 3_600_000;
      const unsorted = projects.filter((p) => p.kind === 'unsorted' && (isChief || p.ownerAgentId === agentId));
      if (unsorted.length) {
        const tasks = await this.tasks.list(org.id);
        for (const u of unsorted) {
          const stale = tasks.filter((t) => t.projectId === u.id && OPEN.has(t.status) && now.getTime() - Date.parse(t.createdAt) >= grace);
          if (stale.length) out.push(`${stale.length} task(s) in ${u.key} Unsorted wait to be placed under the project they serve (org_link_task; or org_create_project): ${stale.slice(0, 4).map((t) => taskRef(t)).join(', ')}`);
        }
      }
      if (isChief) {
        for (const p of projects.filter((x) => x.kind === 'project' && x.ownerAgentId !== agentId)) {
          const u = this.updateState(org, p, now);
          if (u.state === 'missing') out.push(`Update missing on ${p.key} "${p.title}" (lead ${await this.leadName(p)}): chase the lead; draft the diff for them`);
        }
      }
      // Tasks paused for circular behaviour in projects this member leads.
      const paused = (await this.tasks.list(org.id)).filter((t) => t.wakesPausedAt && projects.some((p) => p.id === t.projectId && (p.ownerAgentId === agentId || (isChief && !p.ownerAgentId))));
      for (const t of paused.slice(0, 3)) out.push(`task ${taskRef(t)} "${t.title}" is paused: its owner repeated the same failed approach — rebrief it (org_task_comment), reassign it or cancel it`);
    }
    return out;
  }

  /** The heartbeat context: the projects this member leads and its health duty. */
  async heartbeatContext(agentId: string, now: Date): Promise<string | null> {
    const lines: string[] = [];
    for (const m of (await this.org.membershipsOf(agentId)).filter((x) => x.status === 'active')) {
      const org = await this.org.get(m.orgId).catch(() => null);
      if (!org) continue;
      const mine = (await this.org.projects(org.id)).filter((p) => p.ownerAgentId === agentId && p.kind === 'project' && !['done', 'cancelled'].includes(p.status));
      if (mine.length === 0) continue;
      lines.push(`Your project health duty: you lead ${mine.map((p) => {
        const u = this.updateState(org, p, now);
        return `${p.key} "${p.title}" (${p.lane}, ${p.health ? p.health.replace('_', ' ') : 'no update yet'}${u.dueAt ? `, next update due ${u.dueAt.slice(0, 10)}` : ''})`;
      }).join('; ')}. Post an honest health update on each Now project every ${workTunable(org, 'work.updateCadenceDays')} day(s) with org_project_update; at risk names its ask, off track its reason; "unknown, still investigating" is acceptable — never invent a story.`);
    }
    return lines.length ? lines.join('\n') : null;
  }

  /** The roadmap as the model reads it (org_projects). */
  async describeForModel(orgId: string, now = new Date()): Promise<string> {
    const list = await this.summaries(orgId, now);
    if (list.length === 0) return 'No projects yet. Propose one with org_create_project (a lead, the key result it moves, a brief, an appetite); moving it to Now is the CEO\'s bet.';
    return list.map((p) => `${p.key} [${p.lane}/${p.status}] "${p.title}" — lead ${p.lead.name}; ${p.progress.done}/${p.progress.total} done; health ${p.health ? p.health.replace('_', ' ') : 'none'}${p.update.state === 'missing' ? ' (UPDATE MISSING)' : p.update.state === 'due' ? ' (update due)' : ''}${p.targetDate ? `; target ${p.targetDate}` : ''}${p.appetite.usd || p.appetite.days ? `; appetite ${describeAppetite(p.appetite)}` : ''}${p.appetite.tripped ? ' — BREAKER TRIPPED' : ''}${p.goals.length ? `; moves ${p.goals.map((g) => g.title.slice(0, 50)).join(', ')}` : ''}`).join('\n');
  }
}

// ---- helpers ----

function laneOrder(l: string): number { return l === 'now' ? 0 : l === 'next' ? 1 : 2; }
function isAgentActor(actor: string): boolean { return actor === 'chief' || actor.startsWith('agent:'); }
function actorAgent(actor: string): string | null { return actor.startsWith('agent:') ? actor.slice(6) : null; }
function weekOf(iso: string): string {
  const d = new Date(iso); const day = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}
export function describeAppetite(a: ProjectSummary['appetite']): string {
  const parts: string[] = [];
  if (a.usd > 0) parts.push(`$${a.spentUsd.toFixed(2)} of $${a.usd.toFixed(2)}`);
  if (a.days > 0) parts.push(`${a.daysUsed ?? 0} of ${a.days} day(s)`);
  return parts.length ? parts.join(', ') : 'no appetite set';
}
export type { ProjectHealth };
