/**
 * OrgNextWorkService — a member pulls its next work (docs/work-tracking.md
 * "Pull next"). Model-free: it decides *what* to wake the member for, and the
 * runtime's ordinary task run does the work.
 *
 * When a task leaves its owner's hands — done or accepted, sent to review,
 * cancelled or abandoned, blocked — and when a reviewer finishes a review,
 * the member's pull is scheduled after `work.nextTaskDelaySeconds` (one per
 * member; later finishes in the window coalesce). The heartbeat runs the
 * same pull first on every beat (`OrgRuntimeService.bindNextWork`). The pull
 * walks the member's queue in order and wakes it for the first item it can
 * act on:
 *
 *   1. a review it owes (the task waits on it);
 *   2. its own to-do that was just unblocked (a blocker cleared, a
 *      dependency done);
 *   3. its own to-do, ranked by project lane (Now first), urgency (overdue,
 *      due soon), due date, project rank and age — claimed only when the WIP
 *      limit (`capacity.wipPerMember`) allows;
 *   4. nothing of its own: unassigned backlog in its unit or the projects it
 *      works on that fits its role. `work.selfAssign` (0 off · 1 unit ·
 *      2 project) says whether it takes it itself; otherwise it asks its
 *      manager on the task and in the manager's inbox, once a day per task;
 *   5. nothing at all: no wake, no model call.
 *
 * Gated like every wake: a paused org or member, quiet hours, the spend
 * stop, an exhausted agent or company envelope, a breaker-tripped project or
 * a task whose wakes are paused (the claim gate), and a run already queued
 * or running for the member (dedupe with the assignment, comment, review and
 * dependency wakes) all stop it. Loop guards: the task that just left the
 * member's hands is not pulled again for a while, a member never takes back
 * backlog work it gave up, a task self-assigned twice is left to a manager
 * (no ping-pong), breaker transitions (the system blocking a task) schedule
 * nothing, and `work.nextTaskMaxPerHour` caps the wakes.
 *
 * It also writes the heartbeat's "Your next work" section: what to do next
 * (top three, newly unblocked first) and what is blocked, on what, since when.
 */
import { Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { AgentsService } from '../agents/agents.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { isQuiet } from '../workspaces/quiet-hours';
import { spendStatus } from '../workspaces/spend.util';
import { HeartbeatService } from '../chats/heartbeat.service';
import type { OrgWakeReason } from '../chats/trigger-bus';
import { taskRef } from '../common/task-keys';
import { OrgService, type Organization } from './org.service';
import { OrgTasksService, parseBrief, parseDeps, type OrgTask, type TransitionEvent } from './org-tasks.service';
import { OrgRuntimeService } from './org-runtime.service';
import { OrgAuditService } from './org-audit.service';
import { OrgUnitsService } from './org-units.service';
import { urgencyOf } from './org-capacity.service';
import { govTunable } from './governance-tunables';
import { workTunable } from './work-tunables';
import { describeBlockedOn, parseBlockedOn } from './blocked-on';
import { ROLES } from './roles/catalog';

export type NextKind = 'review' | 'unblocked' | 'todo' | 'backlog';
export interface NextCandidate {
  kind: NextKind;
  task: OrgTask;
  /** Why it is next, in words (for the heartbeat section and the audit). */
  why: string;
  /** Backlog only: whether the member may take it itself (work.selfAssign). */
  selfAssign?: boolean;
}
export type PullOutcome = 'review' | 'claim' | 'self_assign' | 'ask_manager' | 'none' | `skipped:${string}`;
export interface PullResult { outcome: PullOutcome; taskId: string | null; why: string }

/** Statuses a task is "in the owner's hands" in, and the ones it leaves them for. */
const IN_HANDS = ['todo', 'claimed', 'in_progress'];
const LEAVES_HANDS = ['done', 'in_review', 'cancelled', 'blocked'];
/** How long the task that just left a member's hands is not pulled again. */
const LEFT_EXCLUSION_MS = 10 * 60_000;
/** A finish while the member's run is still going re-arms this many times. */
const MAX_REARMS = 20;
/** A manager is asked about one backlog task at most this often per member. */
const ASK_EVERY_MS = 24 * 3_600_000;
/** A backlog task self-assigned this many times is left to a manager. */
const SELF_ASSIGN_LIMIT = 2;
const LANE_ORDER: Record<string, number> = { now: 0, next: 1, later: 2 };
const STOP = new Set(['about', 'after', 'agent', 'agents', 'also', 'before', 'being', 'company', 'could', 'every', 'from', 'have', 'into', 'just', 'keep', 'make', 'more', 'most', 'must', 'only', 'other', 'over', 'should', 'some', 'such', 'than', 'that', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'very', 'want', 'what', 'when', 'where', 'which', 'while', 'will', 'with', 'within', 'work', 'would', 'your', 'yours', 'task', 'tasks', 'team', 'general']);

/** Lowercase word stems (first five letters of words of four or more) for the role match. Pure. */
export function stems(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of (text ?? '').toLowerCase().split(/[^a-z]+/)) if (w.length >= 4 && !STOP.has(w)) out.add(w.slice(0, 5));
  return out;
}

@Injectable()
export class OrgNextWorkService implements OnModuleDestroy {
  private readonly logger = new Logger(OrgNextWorkService.name);
  /** agentId → the scheduled pull (one per member). */
  private readonly pending = new Map<string, { orgId: string; timer: ReturnType<typeof setTimeout>; rearms: number }>();
  /** agentId → taskId → when it left the member's hands. */
  private readonly left = new Map<string, Map<string, number>>();
  /** agentId → when its next-work wakes were dispatched (the hourly cap). */
  private readonly dispatched = new Map<string, number[]>();
  /** `${agentId}:${taskId}` → when the manager was asked. */
  private readonly asked = new Map<string, number>();
  /** Test seam: overrides `work.nextTaskDelaySeconds`. */
  delayMs: number | null = null;

  constructor(
    private readonly org: OrgService,
    private readonly tasks: OrgTasksService,
    private readonly runtime: OrgRuntimeService,
    private readonly audit: OrgAuditService,
    private readonly agents: AgentsService,
    private readonly workspaces: WorkspacesService,
    @Optional() private readonly units?: OrgUnitsService,
    @Optional() heartbeat?: HeartbeatService,
  ) {
    tasks.onTransition((ev) => this.onTransition(ev));
    runtime.bindNextWork(async (org, agentId, now) => {
      const r = await this.pull(org.id, agentId, now, { source: 'heartbeat' });
      return r.outcome === 'review' || r.outcome === 'claim' || r.outcome === 'self_assign' ? r.taskId : null;
    });
    heartbeat?.addSectionProvider({ name: 'next-work', section: (agentId, ctx) => this.section(agentId, ctx.now) });
  }

  onModuleDestroy(): void {
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
  }

  // ---- scheduling on finish ----

  /** A status change: the owner (or the reviewer) whose hands it left gets a pull. */
  async onTransition(ev: TransitionEvent): Promise<void> {
    if (!this.runtime.enabled()) return;
    const t = await this.tasks.get(ev.orgId, ev.taskId).catch(() => null);
    if (!t) return;
    // A breaker (loop, no progress, budget stop) blocks as the system: nothing is pulled behind it.
    const breaker = ev.actor === 'system' && ev.to === 'blocked';
    if (t.assigneeAgentId && IN_HANDS.includes(ev.from) && LEAVES_HANDS.includes(ev.to) && !breaker) {
      await this.schedule(ev.orgId, t.assigneeAgentId, t.id);
    }
    if (ev.from === 'in_review' && ev.to !== 'in_review' && t.reviewerAgentId && t.reviewerAgentId !== t.assigneeAgentId) {
      await this.schedule(ev.orgId, t.reviewerAgentId, t.id);
    }
  }

  /** Schedule the member's pull; later finishes inside the window coalesce. */
  async schedule(orgId: string, agentId: string, leftTaskId: string | null): Promise<void> {
    if (leftTaskId) { const m = this.left.get(agentId) ?? new Map<string, number>(); m.set(leftTaskId, Date.now()); this.left.set(agentId, m); }
    if (this.pending.has(agentId)) return;
    const org = await this.org.get(orgId).catch(() => null);
    if (!org || org.status !== 'active') return;
    this.arm(orgId, agentId, 0, this.delayOf(org));
  }

  private delayOf(org: Organization): number {
    return this.delayMs ?? workTunable(org, 'work.nextTaskDelaySeconds') * 1_000;
  }

  private arm(orgId: string, agentId: string, rearms: number, ms: number): void {
    const timer = setTimeout(() => { void this.flush(agentId); }, ms);
    timer.unref?.();
    this.pending.set(agentId, { orgId, timer, rearms });
  }

  pendingAgents(): string[] { return [...this.pending.keys()]; }

  /** Run a scheduled pull now (the timer, or a test). A member whose run is
   *  still going (it finished the task inside that run) is re-armed. */
  async flush(agentId: string, now: Date = new Date()): Promise<PullResult | undefined> {
    const p = this.pending.get(agentId);
    if (!p) return undefined;
    this.pending.delete(agentId);
    clearTimeout(p.timer);
    const r = await this.pull(p.orgId, agentId, now, { source: 'finish' }).catch((err: unknown): PullResult => {
      this.logger.warn(`next-work pull for ${agentId} failed: ${err instanceof Error ? err.message : err}`);
      return { outcome: 'skipped:error', taskId: null, why: '' };
    });
    if (r.outcome === 'skipped:running' && p.rearms < MAX_REARMS) {
      const org = await this.org.get(p.orgId).catch(() => null);
      if (org) this.arm(p.orgId, agentId, p.rearms + 1, this.delayOf(org));
    }
    return r;
  }

  /** Fire every scheduled pull now (tests). */
  async flushAll(now: Date = new Date()): Promise<void> {
    for (const id of [...this.pending.keys()]) await this.flush(id, now);
  }

  // ---- the pull ----

  /** Decide the member's next work and wake it for it. Model-free. */
  async pull(orgId: string, agentId: string, now: Date = new Date(), opts: { source?: 'finish' | 'heartbeat' } = {}): Promise<PullResult> {
    const skip = (why: string): PullResult => ({ outcome: `skipped:${why}`, taskId: null, why });
    if (!this.runtime.enabled()) return skip('disabled');
    const org = await this.org.get(orgId).catch(() => null);
    if (!org || org.status !== 'active') return skip('paused');
    const member = await this.org.member(orgId, agentId);
    if (!member || member.status !== 'active') return skip('member_inactive');
    const ws = await this.workspaces.get(org.workspaceId).catch(() => null);
    if (ws && isQuiet(ws, now).quiet) return skip('quiet');
    if (ws && spendStatus(ws, now).over) return skip('spend_stop');
    // Dedupe: a wake already queued (assignment, comment, review, dependency) or a run going.
    if (this.runtime.hasPendingWakeFor(agentId, orgId)) return skip('pending');
    if ((await this.tasks.runningRuns(orgId)).some((r) => r.agentId === agentId)) return skip('running');
    const hourAgo = now.getTime() - 3_600_000;
    const recent = (this.dispatched.get(agentId) ?? []).filter((ms) => ms > hourAgo);
    this.dispatched.set(agentId, recent);
    if (recent.length >= workTunable(org, 'work.nextTaskMaxPerHour')) return skip('cap');
    if (!(await this.headroom(org, agentId))) return skip('budget');

    // The task that just left the member's hands is not pulled again for a
    // while, unless someone else moved it since (unblocked it, sent it back).
    const exclude = new Set<string>();
    for (const [id, at] of this.left.get(agentId) ?? new Map<string, number>()) {
      if (now.getTime() - at >= LEFT_EXCLUSION_MS) continue;
      const movedByOthers = (await this.tasks.transitions(orgId, id)).some((tr) => Date.parse(tr.at) >= at && tr.actor !== `agent:${agentId}`);
      if (!movedByOthers) exclude.add(id);
    }
    const candidates = await this.candidates(org, agentId, now, { exclude });
    const wip = govTunable(org, 'capacity.wipPerMember');
    for (const c of candidates) {
      if (c.kind === 'review') return this.dispatch(org, agentId, c, 'review', 'review', now, opts.source);
      if (c.kind === 'unblocked' || c.kind === 'todo') {
        const blocker = await this.tasks.claimBlocker(orgId, c.task, agentId, wip);
        if (blocker?.startsWith('wip')) return skip('wip');
        if (blocker) continue;
        return this.dispatch(org, agentId, c, 'next', 'claim', now, opts.source);
      }
      // Backlog: only with room under the WIP limit (open tasks of any kind count).
      if ((await this.tasks.openTasksOf(orgId, agentId)).length >= wip) return skip('wip');
      if (c.selfAssign) {
        await this.tasks.assign(orgId, c.task.id, agentId, `agent:${agentId}`);
        recent.push(now.getTime());
        await this.audit.append(orgId, { actor: `agent:${agentId}`, action: 'next_work_self_assign', refType: 'task', refId: c.task.id, payload: { agentId, why: c.why, source: opts.source ?? 'finish', mode: workTunable(org, 'work.selfAssign') } });
        return { outcome: 'self_assign', taskId: c.task.id, why: c.why };
      }
      if (await this.askManager(org, member, c, now)) return { outcome: 'ask_manager', taskId: c.task.id, why: c.why };
    }
    return { outcome: 'none', taskId: null, why: 'nothing to do' };
  }

  private async dispatch(org: Organization, agentId: string, c: NextCandidate, reason: OrgWakeReason, outcome: PullOutcome, now: Date, source = 'finish'): Promise<PullResult> {
    this.runtime.wake({ orgId: org.id, taskId: c.task.id, agentId, reason });
    (this.dispatched.get(agentId) ?? []).push(now.getTime());
    await this.audit.append(org.id, { actor: 'system', action: 'next_work', refType: 'task', refId: c.task.id, payload: { agentId, kind: c.kind, why: c.why.slice(0, 200), source } });
    return { outcome, taskId: c.task.id, why: c.why };
  }

  /** Whether the member's and the company's envelopes have room for one run. */
  private async headroom(org: Organization, agentId: string): Promise<boolean> {
    const month = new Date().toISOString().slice(0, 7);
    const estimate = await this.runtime.estimateUsd(await this.runtime.modelFor(agentId, org.workspaceId).catch(() => ''));
    const rows = (await this.org.budgets(org.id)).filter((b) => (b.scope === 'company' && b.refId === org.id) || (b.scope === 'agent' && b.refId === agentId));
    return rows.every((b) => b.monthlyUsd <= 0 || b.month !== month || b.spentUsd + b.reservedUsd + estimate <= b.monthlyUsd);
  }

  /** Ask the member's manager for a fitting backlog task, once a day per
   *  task: a comment on the task and, for an agent manager, an inbox event
   *  (it reaches the manager's heartbeat). Returns whether it asked. */
  private async askManager(org: Organization, member: { agentId: string; reportsToAgentId: string | null }, c: NextCandidate, now: Date): Promise<boolean> {
    const key = `${member.agentId}:${c.task.id}`;
    const last = this.asked.get(key) ?? Math.max(0, ...(await this.audit.list(org.id, { action: 'next_work_ask', refId: c.task.id, limit: 20 }))
      .filter((r) => { try { return (JSON.parse(r.payload) as { agentId?: string }).agentId === member.agentId; } catch { return false; } })
      .map((r) => Date.parse(r.createdAt)).filter(Number.isFinite));
    if (last && now.getTime() - last < ASK_EVERY_MS) return false;
    this.asked.set(key, now.getTime());
    const name = (await this.agents.get(member.agentId).catch(() => null))?.name ?? 'A member';
    const manager = member.reportsToAgentId;
    const managerName = manager ? (await this.agents.get(manager).catch(() => null))?.name ?? 'its manager' : 'the CEO';
    const mode = workTunable(org, 'work.selfAssign');
    const text = `${name} has no open work and could take this (${c.why}). ${managerName}: assign it with org_assign if it should take it${mode === 0 ? ' — in this company managers assign the work' : ''}.`;
    await this.tasks.comment(org.id, c.task.id, { text, fromAgentId: member.agentId, wake: false }).catch(() => undefined);
    if (manager) {
      await this.agents.addEvent(manager, { kind: 'info', title: `${name} is free and could take ${taskRef(c.task)} "${c.task.title}"`.slice(0, 200), body: `${text} Assign it (org_assign), or give ${name} other work.`, payload: JSON.stringify({ orgId: org.id, taskId: c.task.id, agentId: member.agentId }), origin: 'org' }).catch(() => undefined);
    }
    await this.audit.append(org.id, { actor: `agent:${member.agentId}`, action: 'next_work_ask', refType: 'task', refId: c.task.id, payload: { agentId: member.agentId, managerAgentId: manager, why: c.why.slice(0, 200) } });
    return true;
  }

  // ---- the queue ----

  /** The member's queue in pull order (model-free): reviews it owes, its
   *  newly unblocked to-do, its to-do by lane / urgency / due / rank / age,
   *  then fitting unassigned backlog. */
  async candidates(org: Organization, agentId: string, now: Date, opts: { exclude?: Set<string> } = {}): Promise<NextCandidate[]> {
    const exclude = opts.exclude ?? new Set<string>();
    const all = await this.tasks.list(org.id);
    const projects = new Map((await this.org.projects(org.id)).map((p) => [p.id, p]));
    const soon = govTunable(org, 'capacity.dueSoonHours');
    const laneOf = (t: OrgTask) => { const p = t.projectId ? projects.get(t.projectId) : undefined; return !p ? 1 : p.kind !== 'project' ? 0 : LANE_ORDER[p.lane] ?? 2; };
    const rank = (a: OrgTask, b: OrgTask) => (laneOf(a) - laneOf(b))
      || (urgencyOf(a, now, soon) - urgencyOf(b, now, soon))
      || ((a.dueAt ?? '9999') < (b.dueAt ?? '9999') ? -1 : (a.dueAt ?? '9999') > (b.dueAt ?? '9999') ? 1 : 0)
      || ((a.projectId ? projects.get(a.projectId)?.rank ?? 0 : 0) - (b.projectId ? projects.get(b.projectId)?.rank ?? 0 : 0))
      || (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0);
    const where = (t: OrgTask) => {
      const p = t.projectId ? projects.get(t.projectId) : undefined;
      const lane = !p ? '' : p.kind !== 'project' ? '' : ` (${p.lane === 'now' ? 'Now' : p.lane === 'next' ? 'Next' : 'Later'})`;
      const u = urgencyOf(t, now, soon);
      return `${p && p.kind === 'project' ? `project ${p.key ?? p.title}${lane}` : 'no project'}${u === 0 ? ', OVERDUE' : u === 1 ? ', due soon' : t.dueAt ? `, due ${t.dueAt.slice(0, 10)}` : ''}`;
    };
    const out: NextCandidate[] = [];

    for (const t of all.filter((x) => x.status === 'in_review' && x.reviewerAgentId === agentId && x.assigneeAgentId !== agentId && !exclude.has(x.id)).sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : 1))) {
      out.push({ kind: 'review', task: t, why: `you are its reviewer; waiting since ${t.updatedAt.slice(0, 16).replace('T', ' ')}` });
    }

    const mine = all.filter((x) => x.assigneeAgentId === agentId && x.status === 'todo' && !x.wakesPausedAt && !exclude.has(x.id));
    const lastMove = new Map<string, { from: string; at: string }>();
    if (mine.length) for (const tr of await this.tasks.transitions(org.id)) if (mine.some((m) => m.id === tr.taskId)) lastMove.set(tr.taskId, { from: tr.fromStatus, at: tr.at });
    const unblocked = (t: OrgTask) => ['blocked', 'waiting'].includes(lastMove.get(t.id)?.from ?? '');
    for (const t of mine.filter(unblocked).sort(rank)) out.push({ kind: 'unblocked', task: t, why: `unblocked ${lastMove.get(t.id)!.at.slice(0, 16).replace('T', ' ')} — what it waited on cleared; ${where(t)}` });
    for (const t of mine.filter((x) => !unblocked(x)).sort(rank)) out.push({ kind: 'todo', task: t, why: `your to-do; ${where(t)}` });

    // Backlog that fits: in the member's unit or a project it works on, and its role.
    const mode = workTunable(org, 'work.selfAssign');
    const member = await this.org.member(org.id, agentId);
    const agent = await this.agents.get(agentId).catch(() => null);
    const unitIds = new Set<string>();
    if (this.units) {
      const led = await this.units.ledBy(org.id, agentId).catch(() => null);
      if (led) unitIds.add(led.id);
      const home = await this.units.unitForAssignee(org.id, agentId).catch(() => null);
      if (home) unitIds.add(home.id);
    }
    const team = new Set<string>();
    for (const p of projects.values()) if (p.kind === 'project' && p.ownerAgentId === agentId) team.add(p.id);
    for (const x of all) if (x.assigneeAgentId === agentId && x.projectId && projects.get(x.projectId)?.kind === 'project') team.add(x.projectId);
    const role = (member?.title ?? '').toLowerCase();
    const roleText = [member?.title ?? '', agent?.role ?? '', (agent?.charter ?? '').slice(0, 400), ...(ROLES.find((r) => r.title.toLowerCase() === role)?.competencies ?? [])].join(' ');
    const roleStems = stems(roleText);
    const done = new Set(all.filter((x) => x.status === 'done').map((x) => x.id));
    const transitions = await this.tasks.transitions(org.id);
    const backlog: NextCandidate[] = [];
    for (const t of all.filter((x) => x.status === 'backlog' && !x.assigneeAgentId && !x.assigneeHumanId && !x.wakesPausedAt && !exclude.has(x.id))) {
      const p = t.projectId ? projects.get(t.projectId) : undefined;
      if (p && (p.kind === 'operating' || (p.kind === 'project' && p.status !== 'active') || p.breakerAt)) continue;
      if (parseDeps(t.dependsOn).some((d) => !done.has(d))) continue;
      const history = transitions.filter((tr) => tr.taskId === t.id);
      // Never take back what this member gave up; a task self-assigned twice is a manager's call.
      if (history.some((tr) => tr.actor === `agent:${agentId}` && ['backlog', 'cancelled'].includes(tr.toStatus))) continue;
      if (history.filter((tr) => tr.reason === 'assigned' && tr.actor.startsWith('agent:')).length >= SELF_ASSIGN_LIMIT) continue;
      const inUnit = this.units ? Boolean(t.unitId && unitIds.has(t.unitId)) : true;
      const inProject = Boolean(t.projectId && team.has(t.projectId));
      if (!inUnit && !inProject) continue;
      const b = parseBrief(t.brief);
      const matched = [...stems(`${t.title} ${b.outcome} ${t.class}`)].filter((x) => roleStems.has(x));
      if (matched.length === 0 && !inProject) continue;
      const may = mode >= 2 ? inUnit || inProject : mode >= 1 ? inUnit : false;
      backlog.push({ kind: 'backlog', task: t, selfAssign: may, why: `unassigned in ${inProject ? `project ${p?.key ?? p?.title ?? ''} you work on` : 'your unit\'s backlog'}${matched.length ? `, fits your role (${matched.slice(0, 3).join(', ')}…)` : ''}; ${where(t)}` });
    }
    out.push(...backlog.sort((a, b) => rank(a.task, b.task)));
    return out;
  }

  // ---- the heartbeat section ----

  /** "Your next work": the top of the queue (newly unblocked first) and the
   *  member's blocked work with what it waits on and since when. */
  async section(agentId: string, now: Date): Promise<{ title: string; text: string } | null> {
    const lines: string[] = [];
    const names = new Map((await this.agents.list().catch(() => [])).map((a) => [a.id, a.name]));
    for (const m of (await this.org.membershipsOf(agentId)).filter((x) => x.status === 'active')) {
      const org = await this.org.get(m.orgId).catch(() => null);
      if (!org || org.status !== 'active') continue;
      const all = await this.tasks.list(org.id);
      const byId = new Map(all.map((t) => [t.id, t]));
      const cands = await this.candidates(org, agentId, now);
      const ordered = [...cands.filter((c) => c.kind === 'unblocked'), ...cands.filter((c) => c.kind !== 'unblocked')].slice(0, 3);
      const verb = (c: NextCandidate) => (c.kind === 'review' ? 'review' : c.kind === 'unblocked' ? 'unblocked' : c.kind === 'todo' ? 'to do' : c.selfAssign ? 'backlog (you may take it)' : 'backlog (ask your manager for it)');
      if (ordered.length) lines.push(`Next (in this order):\n${ordered.map((c, i) => `${i + 1}. ${verb(c)} ${taskRef(c.task)} "${c.task.title.slice(0, 80)}" — ${c.why}`).join('\n')}`);
      const chase = workTunable(org, 'work.chaseAfterHours') * 3_600_000;
      const blocked = all.filter((t) => t.assigneeAgentId === agentId && (t.status === 'blocked' || t.status === 'waiting')).slice(0, 5).map((t) => {
        const b = parseBlockedOn(t.blockedOn);
        const deps = parseDeps(t.dependsOn).map((d) => byId.get(d)).filter((d): d is OrgTask => Boolean(d) && d!.status !== 'done');
        const what = b ? describeBlockedOn(b, (k, r) => (k === 'task' ? (byId.get(r) ? taskRef(byId.get(r)!) : r.slice(0, 8)) : names.get(r) ?? r.slice(0, 8))) : deps.length ? `waits on ${deps.map((d) => taskRef(d)).join(', ')}` : 'blocked';
        const since = b?.since || t.updatedAt;
        const age = now.getTime() - Date.parse(since);
        return `- ${taskRef(t)} "${t.title.slice(0, 70)}" ${what.slice(0, 160)} (since ${since.slice(0, 16).replace('T', ' ')}${age >= chase ? '; past the chase threshold: chase or escalate' : ''})`;
      });
      if (blocked.length) lines.push(`Blocked or waiting:\n${blocked.join('\n')}`);
    }
    if (lines.length === 0) return null;
    lines.push('After you finish or hand off a task you are woken for the next one; with nothing of your own, take fitting backlog only as the list says, and never invent work.');
    return { title: 'Your next work', text: lines.join('\n') };
  }
}
