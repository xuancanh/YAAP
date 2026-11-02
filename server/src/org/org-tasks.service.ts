/**
 * OrgTasksService — the shared board (docs/autonomous-company.md §4.1/§4.2).
 *
 * Every unit of agent work is a task with exactly one owner. The claim is a
 * single conditional UPDATE … RETURNING, so two runs racing the same task
 * get one winner and one empty result (no model call for the loser).
 * Assignment, a comment on an owned task, a review request and an approval
 * decision emit an OrgWakeEvent on the TriggerBus; mentions and group
 * messages emit nothing. Review rounds are capped at 3, then the task
 * escalates to the user as an approval card and stays there.
 */
import { BadRequestException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { orgTasks, orgRuns, orgMessages, orgApprovals } from '../database/schema';
import { newId, nowIso } from '../common/ids.util';
import { actorId, currentAccountId } from '../accounts/account-context';
import { FollowsService, followerFromActor, orgTaskTarget, type FollowActivity, type Follower, type FollowReason } from '../follows/follows.service';
import { TriggerBus, OrgWakeReason } from '../chats/trigger-bus';
import { OrgAuditService } from './org-audit.service';
import { OrgService } from './org.service';
import { OrgUnitsService } from './org-units.service';
import { AgentsService } from '../agents/agents.service';
import { normalizeChecks, parseChecks, type Check } from './org-checks';

export type OrgTask = typeof orgTasks.$inferSelect;
export type OrgRun = typeof orgRuns.$inferSelect;
export type OrgMessage = typeof orgMessages.$inferSelect;

/** `waiting` (item 31, C4): assigned but a task it depends on is not done
 *  yet; it cannot be claimed and moves to todo (with a wake) when the last
 *  dependency is done. */
export const TASK_STATUSES = ['backlog', 'waiting', 'todo', 'claimed', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled'] as const;
export type TaskStatus = typeof TASK_STATUSES[number];
export const REVIEW_ROUND_CAP = 3;
const TASK_LIMIT = 500;

export interface TaskBrief { outcome: string; context: string; constraints: string; done_when: string }

/** Executable acceptance (docs/sensing.md §3, item 27): what running a
 *  task's checks before review concluded. `none` = the task has no checks
 *  (or no gate is bound); `pass` accepts it without a model unless
 *  `alsoReview`; `fail` sends it back to the owner with `detail`, counting a
 *  review round; `error` falls through to the normal review with a note. */
export interface AcceptanceVerdict { outcome: 'none' | 'pass' | 'fail' | 'error'; detail: string; alsoReview: boolean }
export type AcceptanceGate = (orgId: string, task: OrgTask) => Promise<AcceptanceVerdict>;

/** How a done task was verified, for the board (docs/sensing.md §3). */
export function verificationOf(t: Pick<OrgTask, 'status' | 'acceptedBy'>): 'check' | 'review' | 'none' | null {
  if (t.status !== 'done') return null;
  return t.acceptedBy === 'check' ? 'check' : t.acceptedBy === 'review' ? 'review' : 'none';
}

/** Task classes (docs/company-vision.md §7, item 23): the six the routing
 *  table and the cost roll-up name; a brief may name another slug
 *  (`class: outreach` in constraints) and it is kept as given. */
export const TASK_CLASSES = ['triage', 'research', 'synthesis', 'review', 'ops', 'general'] as const;
export type TaskClass = typeof TASK_CLASSES[number] | string;
const CLASS_RE = /^[a-z][a-z0-9_-]{0,23}$/;

/** The one shared heuristic: `class:`/`type:` in constraints wins, then a
 *  deterministic keyword match on title, constraints and outcome; `general`
 *  otherwise. Item 20 used it for cycle time per class; item 23 stores the
 *  result on the task at creation. No model. */
export function deriveTaskClass(task: { title: string; brief: string | Partial<TaskBrief> | undefined }): string {
  const b = parseBrief(task.brief as string | Record<string, unknown> | undefined);
  const hay = `${task.title} ${b.constraints} ${b.outcome}`.toLowerCase();
  const m = /\b(class|type):\s*([a-z][a-z0-9_-]*)/.exec(b.constraints.toLowerCase());
  if (m && CLASS_RE.test(m[2])) return m[2];
  if (/\b(triage|sort|label|classify)\b/.test(hay)) return 'triage';
  if (/\b(review|check|audit|verify|proofread)\b/.test(hay)) return 'review';
  if (/\b(research|investigate|find|survey|compare|sources?)\b/.test(hay)) return 'research';
  if (/\b(write|draft|synthesi[sz]e|summari[sz]e|compose|report)\b/.test(hay)) return 'synthesis';
  if (/\b(deploy|configure|monitor|maintain|migrate|backup|ops)\b/.test(hay)) return 'ops';
  return 'general';
}

/** Validate a creator-given class (a lowercase slug). */
export function normalizeTaskClass(v: unknown): string | null {
  const c = String(v ?? '').trim().toLowerCase();
  if (!c) return null;
  if (!CLASS_RE.test(c)) throw new BadRequestException(`class must be a lowercase slug (${TASK_CLASSES.join(', ')} or another)`);
  return c;
}

/** Task ids a task depends on (org_tasks.dependsOn). */
export function parseDeps(raw: string | null | undefined): string[] {
  try { const v = JSON.parse(raw || '[]') as unknown; return Array.isArray(v) ? v.map(String).filter(Boolean) : []; } catch { return []; }
}

/** Statuses that count against a member's WIP limit (capacity.wipPerMember). */
export const WIP_STATUSES = ['todo', 'claimed', 'in_progress', 'blocked'] as const;

/** Whether a dependency graph would contain a cycle if `taskId` depended on
 *  `deps`. Pure: `edges` maps every task id to its dependsOn. */
export function wouldCycle(taskId: string, deps: string[], edges: Map<string, string[]>): string[] | null {
  const seen = new Set<string>();
  const path: string[] = [];
  const visit = (id: string): boolean => {
    if (id === taskId) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    path.push(id);
    for (const d of edges.get(id) ?? []) if (visit(d)) return true;
    path.pop();
    return false;
  };
  for (const d of deps) { path.length = 0; if (visit(d)) return [taskId, ...path, taskId]; }
  return null;
}

/** A listener told when a task is accepted (by check or by review), for
 *  harvesting golden-set cases (docs/evals.md §1). */
export type AcceptedListener = (ev: { orgId: string; task: OrgTask; by: 'check' | 'review'; rounds: number }) => Promise<void> | void;

/** Extra fields the board API shows per task (expected duration, item 31). */
export type BoardAnnotator = (orgId: string, rows: OrgTask[]) => Promise<Map<string, Record<string, unknown>>>;

export function parseBrief(raw: string | Record<string, unknown> | undefined): TaskBrief {
  let v: Record<string, unknown> = {};
  if (typeof raw === 'string') { try { v = JSON.parse(raw || '{}') as Record<string, unknown>; } catch { v = {}; } }
  else if (raw && typeof raw === 'object') v = raw;
  const s = (k: string) => (typeof v[k] === 'string' ? (v[k] as string).slice(0, 4_000) : '');
  return { outcome: s('outcome'), context: s('context'), constraints: s('constraints'), done_when: s('done_when') };
}

@Injectable()
export class OrgTasksService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly org: OrgService,
    private readonly audit: OrgAuditService,
    @Optional() private readonly bus?: TriggerBus,
    /** Optional: without it tasks carry no unit (docs/group-chat.md §7). */
    @Optional() private readonly units?: OrgUnitsService,
    /** Optional: addressed inbox events for human employees (item 24). */
    @Optional() private readonly agents?: AgentsService,
    /** Optional: task follows (docs/follows.md) — creator, owner, assignee,
     *  reviewer and commenters follow; changes reach the other followers. */
    @Optional() public follows?: FollowsService,
  ) {}

  private acceptanceGate?: AcceptanceGate;

  // ---- follows (docs/follows.md) ----

  private async followTarget(orgId: string, t: Pick<OrgTask, 'id' | 'title'>) {
    const org = await this.org.get(orgId).catch(() => null);
    return org ? orgTaskTarget(org.workspaceId, t.id, t.title) : null;
  }

  /** Auto-follow; never throws, never resubscribes an unfollow. */
  private async autoFollow(orgId: string, t: Pick<OrgTask, 'id' | 'title'>, who: Follower | null, reason: Exclude<FollowReason, 'manual'>): Promise<void> {
    if (!this.follows || !who) return;
    const target = await this.followTarget(orgId, t);
    if (target) await this.follows.autoFollow(target, who, reason);
  }

  /** Activity on a task for its followers (never the actor). */
  private async track(orgId: string, t: Pick<OrgTask, 'id' | 'title'>, act: FollowActivity): Promise<void> {
    if (!this.follows) return;
    const target = await this.followTarget(orgId, t);
    if (target) await this.follows.recordActivity(target, act);
  }

  /** A status change as follow activity: blocked, review requested and
   *  reopened need the followers; done and cancelled close the target. */
  private async trackStatus(orgId: string, t: OrgTask, previous: string, actor: Follower | null, opts: { detail?: string; alreadyWoken?: string[] } = {}): Promise<void> {
    if (previous === t.status) return;
    const closed = (s: string) => s === 'done' || s === 'cancelled';
    const reopened = closed(previous) && !closed(t.status);
    const detail = opts.detail ?? (t.status === 'blocked' ? parseList(t.blockers).at(-1) ?? '' : '');
    await this.track(orgId, t, {
      actor,
      summary: `moved to ${t.status.replace(/_/g, ' ')}${detail ? `: ${detail}` : ''}`,
      attention: t.status === 'blocked' ? `blocked${detail ? `: ${detail}` : ''}` : t.status === 'in_review' ? 'review requested' : reopened ? 'reopened' : null,
      alreadyWoken: opts.alreadyWoken,
      closed: closed(t.status) ? true : reopened ? false : undefined,
    });
  }

  /** OrgSensingService binds the check runner here (docs/sensing.md §3). */
  setAcceptanceGate(gate: AcceptanceGate | undefined): void { this.acceptanceGate = gate; }

  /** The task's checks, parsed. */
  checksOf(t: Pick<OrgTask, 'checks'>): Check[] { return parseChecks(t.checks); }

  // ---- capacity (docs/autonomous-org-first-principles.md C4, item 31) ----

  private readonly acceptedListeners: AcceptedListener[] = [];
  private annotator?: BoardAnnotator;

  /** Be told when a task is accepted (OrgEvalsService harvests golden cases). */
  onAccepted(fn: AcceptedListener): () => void {
    this.acceptedListeners.push(fn);
    return () => { const i = this.acceptedListeners.indexOf(fn); if (i >= 0) this.acceptedListeners.splice(i, 1); };
  }

  private async accepted(orgId: string, taskId: string, by: 'check' | 'review', rounds: number): Promise<void> {
    const task = await this.get(orgId, taskId);
    for (const fn of this.acceptedListeners) await Promise.resolve(fn({ orgId, task, by, rounds })).catch(() => undefined);
    await this.releaseDependants(orgId, taskId);
  }

  /** OrgCapacityService binds the expected-duration annotator for the board. */
  setBoardAnnotator(fn: BoardAnnotator | undefined): void { this.annotator = fn; }

  /** Board rows with their extra fields (`waitingOn`, `expected`). */
  async annotate(orgId: string, rows: OrgTask[]): Promise<Array<OrgTask & Record<string, unknown>>> {
    const extra = this.annotator ? await this.annotator(orgId, rows).catch(() => new Map<string, Record<string, unknown>>()) : new Map<string, Record<string, unknown>>();
    const all = rows.some((t) => parseDeps(t.dependsOn).length) ? await this.list(orgId) : rows;
    const done = new Set(all.filter((t) => t.status === 'done').map((t) => t.id));
    return rows.map((t) => ({ ...t, waitingOn: parseDeps(t.dependsOn).filter((d) => !done.has(d)), ...(extra.get(t.id) ?? {}) }));
  }

  /** The member's open tasks (the WIP count). */
  async openTasksOf(orgId: string, agentId: string): Promise<OrgTask[]> {
    return (await this.list(orgId)).filter((t) => t.assigneeAgentId === agentId && (WIP_STATUSES as readonly string[]).includes(t.status));
  }

  /** Refuse an assignment beyond the member's WIP limit (agents only; the
   *  chief may override with a reason, which is audited). Humans are not
   *  bound. Throws with the member's open list. */
  async checkWip(orgId: string, agentId: string, opts: { actor: string; override?: string; taskId?: string; limit: number }): Promise<void> {
    if (!(opts.actor === 'chief' || opts.actor.startsWith('agent:'))) return;
    const open = (await this.openTasksOf(orgId, agentId)).filter((t) => t.id !== opts.taskId);
    if (open.length < opts.limit) return;
    if (opts.override && opts.override.trim()) {
      if (opts.actor !== 'chief') throw new BadRequestException('only the chief of staff may override the WIP limit');
      await this.audit.append(orgId, { actor: opts.actor, action: 'wip_override', refType: 'agent', refId: agentId, payload: { open: open.length, limit: opts.limit, taskId: opts.taskId ?? null, reason: opts.override.slice(0, 300) } });
      return;
    }
    throw new BadRequestException(`refused: the member already holds ${open.length} open task(s), the WIP limit is ${opts.limit} (capacity.wipPerMember) — open: ${open.slice(0, 10).map((t) => `[${t.id.slice(0, 8)}] ${t.title} (${t.status})`).join('; ')}. Finish or hand back one first${opts.actor === 'chief' ? ', or pass override with a reason' : ''}.`);
  }

  /** Resolve and validate dependencies for a task: known ids (or 8-char
   *  prefixes) of this org, no self-dependency, no cycle. */
  async resolveDeps(orgId: string, taskId: string | null, raw: unknown): Promise<string[]> {
    if (raw === undefined || raw === null || raw === '') return [];
    const list = Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? (() => { try { const v = JSON.parse(raw) as unknown; return Array.isArray(v) ? v.map(String) : [raw]; } catch { return raw.split(',').map((x) => x.trim()); } })() : [];
    const all = await this.list(orgId);
    const out: string[] = [];
    for (const ref of list.filter(Boolean).slice(0, 20)) {
      const hits = all.filter((t) => t.id === ref || t.id.startsWith(ref));
      if (hits.length !== 1) throw new BadRequestException(`dependency "${ref}" matches ${hits.length} tasks`);
      if (hits[0].id === taskId) throw new BadRequestException('a task cannot depend on itself');
      if (!out.includes(hits[0].id)) out.push(hits[0].id);
    }
    if (taskId) {
      const edges = new Map(all.map((t) => [t.id, parseDeps(t.dependsOn)]));
      const cycle = wouldCycle(taskId, out, edges);
      if (cycle) throw new BadRequestException(`refused: that dependency makes a cycle (${cycle.map((id) => id.slice(0, 8)).join(' → ')})`);
    }
    return out;
  }

  /** Dependencies of a task that are not done yet. */
  async unmetDeps(orgId: string, t: Pick<OrgTask, 'dependsOn'>): Promise<OrgTask[]> {
    const deps = parseDeps(t.dependsOn);
    if (deps.length === 0) return [];
    return (await this.list(orgId)).filter((x) => deps.includes(x.id) && x.status !== 'done');
  }

  /** Why a member may not claim this task now: unmet dependencies or its WIP
   *  limit of active (claimed, in progress) tasks. Null = it may. */
  async claimBlocker(orgId: string, t: OrgTask, agentId: string, wipLimit: number): Promise<string | null> {
    const unmet = await this.unmetDeps(orgId, t);
    if (unmet.length) return `waiting on ${unmet.map((x) => `[${x.id.slice(0, 8)}] ${x.title}`).join(', ')}`;
    const active = (await this.list(orgId)).filter((x) => x.assigneeAgentId === agentId && x.id !== t.id && ['claimed', 'in_progress'].includes(x.status));
    if (active.length >= wipLimit) return `wip: ${active.length} active task(s), limit ${wipLimit}`;
    return null;
  }

  /** A task is done: dependants whose every dependency is now done leave
   *  `waiting` for todo and their assignee is woken (TriggerBus). */
  async releaseDependants(orgId: string, doneTaskId: string): Promise<string[]> {
    const all = await this.list(orgId);
    const done = new Set(all.filter((t) => t.status === 'done').map((t) => t.id));
    const released: string[] = [];
    for (const t of all.filter((x) => x.status === 'waiting' && parseDeps(x.dependsOn).includes(doneTaskId))) {
      if (!parseDeps(t.dependsOn).every((d) => done.has(d))) continue;
      const next = t.assigneeAgentId || t.assigneeHumanId ? 'todo' : 'backlog';
      await this.db.update(orgTasks).set({ status: next, updatedAt: nowIso() }).where(eq(orgTasks.id, t.id));
      await this.audit.append(orgId, { actor: 'system', action: 'task_unblocked', refType: 'task', refId: t.id, payload: { by: doneTaskId, status: next } });
      if (t.assigneeAgentId && next === 'todo' && await this.org.isActive(orgId)) this.emitWake(orgId, t.id, t.assigneeAgentId, 'dependency');
      released.push(t.id);
    }
    return released;
  }

  // ---- tasks ----

  /** The board, optionally one unit's: `unitId` alone is that unit's own
   *  tasks; with `rollUp` the units below it are included too. */
  async list(orgId: string, opts: { projectId?: string; status?: string; unitId?: string; rollUp?: boolean } = {}): Promise<OrgTask[]> {
    const conds = [eq(orgTasks.orgId, orgId)];
    if (opts.projectId) conds.push(eq(orgTasks.projectId, opts.projectId));
    if (opts.status) conds.push(eq(orgTasks.status, opts.status));
    const rows = await this.db.select().from(orgTasks).where(and(...conds));
    if (!opts.unitId) return rows;
    const scope = new Set(opts.rollUp && this.units ? await this.units.subtree(orgId, opts.unitId) : [opts.unitId]);
    const root = this.units ? await this.units.rootUnit(orgId).catch(() => null) : null;
    return rows.filter((t) => scope.has(t.unitId ?? root?.id ?? ''));
  }

  async get(orgId: string, taskId: string): Promise<OrgTask> {
    const t = (await this.db.select().from(orgTasks).where(and(eq(orgTasks.orgId, orgId), eq(orgTasks.id, taskId))).limit(1)).at(0);
    if (!t) throw new NotFoundException(`task ${taskId}`);
    return t;
  }

  /** Resolve a task by id or 8-char prefix (what the model sees on the board). */
  async byPrefix(orgId: string, idOrPrefix: string): Promise<OrgTask> {
    const p = (idOrPrefix ?? '').trim();
    if (!p) throw new BadRequestException('taskId is required');
    const all = (await this.list(orgId)).filter((t) => t.id === p || t.id.startsWith(p));
    if (all.length !== 1) throw new BadRequestException(`task id "${p}" matches ${all.length} tasks`);
    return all[0];
  }

  async create(orgId: string, input: {
    title: string; brief?: Partial<TaskBrief> | string; projectId?: string | null; parentTaskId?: string | null;
    status?: TaskStatus; assigneeAgentId?: string | null; reviewerAgentId?: string | null; fileScope?: string[];
    createdBy?: string;
    /** Group chat linkage (docs/group-chat.md §3): the message this task was made from. */
    channelId?: string | null; messageId?: string | null;
    /** Units (docs/group-chat.md §7): named explicitly, or defaulted by the rule. */
    unitId?: string | null;
    /** Capital (docs/company-vision.md §7): the task class; derived from the brief when absent. */
    class?: string | null;
    /** Executable acceptance (docs/sensing.md §3): model-free checks run before review. */
    checks?: unknown;
    /** Capacity (item 31): task ids this one waits on, and its deadline (ISO). */
    dependsOn?: unknown;
    dueAt?: string | null;
  }): Promise<OrgTask> {
    const org = await this.org.get(orgId);
    const title = (input.title ?? '').trim().slice(0, 200);
    if (!title) throw new BadRequestException('task title is required');
    if ((await this.list(orgId)).length >= TASK_LIMIT) throw new BadRequestException(`task limit (${TASK_LIMIT}) reached — close or cancel tasks first`);
    if (input.projectId) await this.org.project(orgId, input.projectId);
    if (input.parentTaskId) await this.get(orgId, input.parentTaskId);
    let status: TaskStatus = input.status ?? (input.assigneeAgentId ? 'todo' : 'backlog');
    if (!TASK_STATUSES.includes(status)) throw new BadRequestException(`status must be one of ${TASK_STATUSES.join(', ')}`);
    if (input.assigneeAgentId) {
      const m = await this.org.member(orgId, input.assigneeAgentId);
      if (!m || m.status !== 'active') throw new BadRequestException('assignee must be an active member of this organization');
    }
    const brief = parseBrief(typeof input.brief === 'string' ? input.brief : (input.brief as Record<string, unknown> | undefined));
    let checks: Check[];
    try { checks = normalizeChecks(input.checks ?? (input.brief && typeof input.brief === 'object' ? (input.brief as Record<string, unknown>).checks : undefined)); } catch (err) { throw new BadRequestException(err instanceof Error ? err.message : String(err)); }
    const dependsOn = await this.resolveDeps(orgId, null, input.dependsOn);
    const dueAt = normalizeDue(input.dueAt);
    if (status === 'todo' && dependsOn.length && (await this.unmetDeps(orgId, { dependsOn: JSON.stringify(dependsOn) })).length) status = 'waiting';
    let unitId: string | null = null;
    let unitExplicit = 0;
    if (this.units) {
      if (input.unitId) { unitId = (await this.units.get(orgId, input.unitId)).id; unitExplicit = 1; }
      else unitId = await this.units.defaultUnitId(orgId, { assigneeAgentId: input.assigneeAgentId, createdBy: input.createdBy }).catch(() => null);
    }
    const now = nowIso();
    const row: OrgTask = {
      id: newId(), accountId: currentAccountId(), orgId, projectId: input.projectId ?? null, parentTaskId: input.parentTaskId ?? null,
      title, brief: JSON.stringify(brief), status,
      assigneeAgentId: input.assigneeAgentId ?? null, assigneeHumanId: null, claimedBy: null, claimedAt: null,
      reviewerAgentId: input.reviewerAgentId ?? null, reviewerHumanId: null, reviewRounds: 0,
      blockers: '[]', fileScope: JSON.stringify((input.fileScope ?? []).map(String).slice(0, 20)),
      noProgressCount: 0, lastRunAt: null, createdBy: input.createdBy ?? 'user',
      channelId: input.channelId ?? null, messageId: input.messageId ?? null,
      unitId, unitExplicit,
      class: normalizeTaskClass(input.class) ?? deriveTaskClass({ title, brief }),
      checks: JSON.stringify(checks), acceptedBy: '',
      dependsOn: JSON.stringify(dependsOn), dueAt,
      createdAt: now, updatedAt: now,
    };
    await this.db.insert(orgTasks).values(row);
    await this.audit.append(orgId, { actor: row.createdBy, action: 'task_create', refType: 'task', refId: row.id, payload: { title, status, assigneeAgentId: row.assigneeAgentId, projectId: row.projectId, parentTaskId: row.parentTaskId, unitId, class: row.class, ...(checks.length ? { checks: checks.length } : {}), ...(dependsOn.length ? { dependsOn } : {}), ...(dueAt ? { dueAt } : {}) } });
    if (row.assigneeAgentId && status === 'todo' && org.status === 'active') this.emitWake(orgId, row.id, row.assigneeAgentId, 'assignment');
    await this.autoFollow(orgId, row, followerFromActor(row.createdBy, actorId()), 'started');
    if (row.assigneeAgentId) await this.autoFollow(orgId, row, { kind: 'agent', id: row.assigneeAgentId }, 'assignee');
    if (row.reviewerAgentId) await this.autoFollow(orgId, row, { kind: 'agent', id: row.reviewerAgentId }, 'reviewer');
    return row;
  }

  async update(orgId: string, taskId: string, patch: {
    title?: string; brief?: Partial<TaskBrief>; status?: TaskStatus; blockers?: string[]; projectId?: string | null;
    reviewerAgentId?: string | null; fileScope?: string[]; noProgressCount?: number; lastRunAt?: string | null; claimedBy?: string | null; claimedAt?: string | null; reviewRounds?: number;
    /** Move the task to another unit board (pins it there). */
    unitId?: string;
    /** Change the owner without waking anyone or changing the status (the
     *  standup's "blocked needs an owner" rule, docs/company-vision.md §3);
     *  `assign` is the path that wakes. */
    assigneeAgentId?: string | null;
    /** Capital (docs/company-vision.md §7): reclassify the task. */
    class?: string;
    /** Executable acceptance (docs/sensing.md §3): replace the checks. */
    checks?: unknown;
    /** Capacity (item 31): replace the dependencies (cycles refused) or the deadline. */
    dependsOn?: unknown;
    dueAt?: string | null;
  }, actor = 'user'): Promise<OrgTask> {
    const t = await this.get(orgId, taskId);
    const set: Record<string, unknown> = { updatedAt: nowIso() };
    let deps = parseDeps(t.dependsOn);
    if (patch.dependsOn !== undefined) { deps = await this.resolveDeps(orgId, taskId, patch.dependsOn); set.dependsOn = JSON.stringify(deps); }
    if (patch.dueAt !== undefined) set.dueAt = normalizeDue(patch.dueAt);
    if (patch.checks !== undefined) {
      try { set.checks = JSON.stringify(normalizeChecks(patch.checks)); } catch (err) { throw new BadRequestException(err instanceof Error ? err.message : String(err)); }
    }
    if (patch.assigneeAgentId !== undefined) {
      if (patch.assigneeAgentId) { const m = await this.org.member(orgId, patch.assigneeAgentId); if (!m || m.status !== 'active') throw new BadRequestException('assignee must be an active member of this organization'); }
      set.assigneeAgentId = patch.assigneeAgentId;
    }
    if (patch.class !== undefined) { const c = normalizeTaskClass(patch.class); if (c) set.class = c; }
    if (patch.unitId !== undefined && this.units) { set.unitId = (await this.units.get(orgId, patch.unitId)).id; set.unitExplicit = 1; }
    if (patch.title !== undefined) { const title = patch.title.trim().slice(0, 200); if (!title) throw new BadRequestException('title cannot be empty'); set.title = title; }
    if (patch.brief !== undefined) set.brief = JSON.stringify({ ...parseBrief(t.brief), ...parseBrief(patch.brief as Record<string, unknown>) });
    if (patch.status !== undefined) {
      if (!TASK_STATUSES.includes(patch.status)) throw new BadRequestException(`status must be one of ${TASK_STATUSES.join(', ')}`);
      set.status = patch.status;
      // A task with an unmet dependency waits instead of becoming todo (C4).
      if (patch.status === 'todo' && deps.length && (await this.unmetDeps(orgId, { dependsOn: JSON.stringify(deps) })).length) set.status = 'waiting';
      // A status set by hand is not a verification: done that way reads `none`.
      if (patch.status !== t.status) set.acceptedBy = '';
      // Leaving the active states releases the claim so the next wake can claim again.
      if (['todo', 'backlog', 'done', 'cancelled', 'blocked'].includes(patch.status)) { set.claimedBy = null; set.claimedAt = null; }
    }
    if (patch.blockers !== undefined) set.blockers = JSON.stringify(patch.blockers.map(String).slice(0, 20));
    if (patch.projectId !== undefined) { if (patch.projectId) await this.org.project(orgId, patch.projectId); set.projectId = patch.projectId; }
    if (patch.reviewerAgentId !== undefined) set.reviewerAgentId = patch.reviewerAgentId;
    if (patch.fileScope !== undefined) set.fileScope = JSON.stringify(patch.fileScope.map(String).slice(0, 20));
    if (patch.noProgressCount !== undefined) set.noProgressCount = patch.noProgressCount;
    if (patch.lastRunAt !== undefined) set.lastRunAt = patch.lastRunAt;
    if (patch.claimedBy !== undefined) set.claimedBy = patch.claimedBy;
    if (patch.claimedAt !== undefined) set.claimedAt = patch.claimedAt;
    if (patch.reviewRounds !== undefined) set.reviewRounds = patch.reviewRounds;
    // New or changed dependencies: todo ↔ waiting follows them.
    if (patch.dependsOn !== undefined && patch.status === undefined) {
      const unmet = deps.length ? (await this.unmetDeps(orgId, { dependsOn: JSON.stringify(deps) })).length : 0;
      if (t.status === 'todo' && unmet) set.status = 'waiting';
      else if (t.status === 'waiting' && !unmet) set.status = t.assigneeAgentId || t.assigneeHumanId ? 'todo' : 'backlog';
    }
    await this.db.update(orgTasks).set(set).where(eq(orgTasks.id, taskId));
    const { updatedAt: _u, ...logged } = set; void _u;
    if (Object.keys(logged).length > 0) await this.audit.append(orgId, { actor, action: 'task_update', refType: 'task', refId: taskId, payload: logged });
    // A task that just became blocked is a board event the autonomous chief reviews (docs/group-chat.md §5).
    if (patch.status === 'blocked' && t.status !== 'blocked') this.bus?.emitOrgBoard({ orgId, kind: 'blocked', refId: taskId, detail: `"${t.title}" is blocked${patch.blockers?.length ? `: ${patch.blockers.at(-1)}` : ''}` });
    const updated = await this.get(orgId, taskId);
    if (updated.status === 'done' && t.status !== 'done') await this.releaseDependants(orgId, taskId);
    if (t.status === 'waiting' && updated.status === 'todo' && updated.assigneeAgentId && await this.org.isActive(orgId)) this.emitWake(orgId, taskId, updated.assigneeAgentId, 'dependency');
    // Status back into the originating channel thread (docs/group-chat.md §3),
    // or into the unit channel when the task did not come from a message (§7).
    if (patch.status !== undefined && patch.status !== t.status && (updated.channelId || updated.unitId)) {
      this.bus?.emitTaskStatus({ source: 'org', taskId, title: updated.title, status: updated.status, previous: t.status, channelId: updated.channelId, messageId: updated.messageId, agentId: updated.assigneeAgentId, unitId: updated.unitId });
    }
    if (patch.assigneeAgentId && patch.assigneeAgentId !== t.assigneeAgentId) await this.autoFollow(orgId, updated, { kind: 'agent', id: patch.assigneeAgentId }, 'assignee');
    if (patch.reviewerAgentId && patch.reviewerAgentId !== t.reviewerAgentId) await this.autoFollow(orgId, updated, { kind: 'agent', id: patch.reviewerAgentId }, 'reviewer');
    await this.trackStatus(orgId, updated, t.status, followerFromActor(actor, actorId()), { alreadyWoken: t.status === 'waiting' && updated.status === 'todo' && updated.assigneeAgentId ? [updated.assigneeAgentId] : undefined });
    return updated;
  }

  /** Assign (or re-assign) a task to an active member and wake them. A task
   *  in backlog moves to todo; a claimed task is released first. */
  async assign(orgId: string, taskId: string, agentId: string, actor = 'user'): Promise<OrgTask> {
    const t = await this.get(orgId, taskId);
    const m = await this.org.member(orgId, agentId);
    if (!m || m.status !== 'active') throw new BadRequestException('assignee must be an active member of this organization');
    if (['done', 'cancelled'].includes(t.status)) throw new BadRequestException(`task is ${t.status}`);
    // The board follows the assignee unless the unit was named explicitly (docs/group-chat.md §7).
    const unitId = this.units && !t.unitExplicit ? await this.units.defaultUnitId(orgId, { assigneeAgentId: agentId }).catch(() => t.unitId) : t.unitId;
    const waiting = (await this.unmetDeps(orgId, t)).length > 0;
    await this.db.update(orgTasks).set({ assigneeAgentId: agentId, assigneeHumanId: null, status: waiting ? 'waiting' : 'todo', claimedBy: null, claimedAt: null, noProgressCount: 0, unitId, updatedAt: nowIso() }).where(eq(orgTasks.id, taskId));
    await this.audit.append(orgId, { actor, action: 'task_assign', refType: 'task', refId: taskId, payload: { agentId, previous: t.assigneeAgentId ?? t.assigneeHumanId, unitId, ...(waiting ? { waiting: true } : {}) } });
    if (!waiting && await this.org.isActive(orgId)) this.emitWake(orgId, taskId, agentId, 'assignment');
    await this.autoFollow(orgId, t, { kind: 'agent', id: agentId }, 'assignee');
    if (agentId !== t.assigneeAgentId) await this.track(orgId, t, { actor: followerFromActor(actor, actorId()), summary: `assigned to ${(await this.agents?.get(agentId).catch(() => null))?.name ?? 'an agent'}`, alreadyWoken: [agentId] });
    return this.get(orgId, taskId);
  }

  /** Hybrid staff (docs/company-vision.md §4, item 24): assign a task to a
   *  human employee. Mutually exclusive with an agent assignee; no wake (a
   *  person is not woken) but an addressed inbox event the push and channel
   *  sweeps deliver, and the board lands on the unit of their manager. */
  async assignHuman(orgId: string, taskId: string, memberAccountId: string, actor = 'user'): Promise<OrgTask> {
    const t = await this.get(orgId, taskId);
    const h = await this.org.employee(orgId, memberAccountId);
    if (!h) throw new BadRequestException('assignee must be a human employee of this organization (POST …/humans with role employee)');
    if (['done', 'cancelled'].includes(t.status)) throw new BadRequestException(`task is ${t.status}`);
    // The board: the unit their manager leads, else the one the manager sits in.
    const unitId = this.units && !t.unitExplicit && h.reportsToAgentId
      ? ((await this.units.ledBy(orgId, h.reportsToAgentId).catch(() => null)) ?? (await this.units.unitForAssignee(orgId, h.reportsToAgentId).catch(() => null)))?.id ?? t.unitId
      : t.unitId;
    await this.db.update(orgTasks).set({ assigneeAgentId: null, assigneeHumanId: memberAccountId, status: 'todo', claimedBy: null, claimedAt: null, noProgressCount: 0, unitId, updatedAt: nowIso() }).where(eq(orgTasks.id, taskId));
    await this.audit.append(orgId, { actor, action: 'task_assign_human', refType: 'task', refId: taskId, payload: { memberAccountId, previous: t.assigneeAgentId ?? t.assigneeHumanId, unitId } });
    await this.notifyHuman(orgId, memberAccountId, { kind: 'org_task', title: `Task assigned to you: ${t.title}`.slice(0, 200), body: parseBrief(t.brief).outcome, payload: { orgId, taskId, action: 'assigned' } });
    await this.autoFollow(orgId, t, { kind: 'user', id: memberAccountId }, 'assignee');
    await this.track(orgId, t, { actor: followerFromActor(actor, actorId()), summary: 'assigned to a person', alreadyNotified: [memberAccountId] });
    return this.get(orgId, taskId);
  }

  /** The task cards of one human: tasks they own or are asked to review (item 24). */
  async tasksOfHuman(orgId: string, memberAccountId: string): Promise<{ assigned: OrgTask[]; reviewing: OrgTask[] }> {
    const rows = await this.list(orgId);
    const open = (t: OrgTask) => !['done', 'cancelled'].includes(t.status);
    return { assigned: rows.filter((t) => t.assigneeHumanId === memberAccountId && open(t)), reviewing: rows.filter((t) => t.reviewerHumanId === memberAccountId && t.status === 'in_review') };
  }

  /** An addressed inbox event for a human of the org (the owner's events are
   *  the account's own, '' addressee), pushed to their channels. */
  private async notifyHuman(orgId: string, memberAccountId: string, ev: { kind: string; title: string; body?: string; payload: Record<string, unknown> }): Promise<void> {
    const org = await this.org.get(orgId).catch(() => null);
    if (!org?.chiefOfStaffAgentId || !this.agents) return;
    await this.agents.addEvent(org.chiefOfStaffAgentId, {
      kind: ev.kind, title: ev.title, body: (ev.body ?? '').slice(0, 400), payload: JSON.stringify(ev.payload), origin: 'user', channel: true,
      forMemberAccountId: memberAccountId === currentAccountId() ? '' : memberAccountId,
    }).catch(() => undefined);
  }

  /** The atomic claim: one UPDATE guarded by status and claimedBy IS NULL.
   *  Returns the claimed row, or null when another run holds it. */
  async claim(orgId: string, taskId: string, agentId: string, runId: string): Promise<OrgTask | null> {
    const now = nowIso();
    const res = await this.db.execute(sql`
      UPDATE org_tasks SET "status" = 'claimed', "claimedBy" = ${runId}, "claimedAt" = ${now}, "updatedAt" = ${now}
      WHERE "id" = ${taskId} AND "orgId" = ${orgId} AND "assigneeAgentId" = ${agentId}
        AND "status" IN ('todo') AND "claimedBy" IS NULL
      RETURNING *
    `);
    const rows = ((res as { rows?: unknown[] }).rows ?? (Array.isArray(res) ? res : [])) as OrgTask[];
    const row = rows[0] ?? null;
    if (row) await this.audit.append(orgId, { actor: `agent:${agentId}`, action: 'task_claim', refType: 'task', refId: taskId, payload: { runId } });
    return row;
  }

  /** Release a claim held by `runId` (run ended without finishing). */
  async release(orgId: string, taskId: string, runId: string, toStatus: TaskStatus = 'todo'): Promise<void> {
    await this.db.execute(sql`
      UPDATE org_tasks SET "status" = ${toStatus}, "claimedBy" = NULL, "claimedAt" = NULL, "updatedAt" = ${nowIso()}
      WHERE "id" = ${taskId} AND "orgId" = ${orgId} AND "claimedBy" = ${runId}
    `);
  }

  // ---- comments and the group log (org_messages) ----

  /** A comment on a task. Wakes the task's owner only when the author is
   *  somebody else (the user, the chief, a reviewer) — never on a mention,
   *  never the author itself, never anyone else named in the text. */
  async comment(orgId: string, taskId: string, input: { text: string; fromAgentId?: string | null; runId?: string | null; wake?: boolean; system?: boolean }): Promise<OrgMessage> {
    const t = await this.get(orgId, taskId);
    const text = (input.text ?? '').trim().slice(0, 8_000);
    if (!text) throw new BadRequestException('comment text is required');
    const row: OrgMessage = { id: newId(), accountId: currentAccountId(), orgId, taskId, fromAgentId: input.fromAgentId ?? null, runId: input.runId ?? null, text, createdAt: nowIso() };
    await this.db.insert(orgMessages).values(row);
    await this.audit.append(orgId, { actor: input.fromAgentId ? `agent:${input.fromAgentId}` : 'user', action: 'task_comment', refType: 'task', refId: taskId, payload: { chars: text.length } });
    const owner = t.assigneeAgentId;
    const wake = input.wake ?? true;
    let woke = false;
    if (wake && owner && owner !== (input.fromAgentId ?? null) && !['done', 'cancelled'].includes(t.status) && await this.org.isActive(orgId)) {
      this.emitWake(orgId, taskId, owner, 'comment');
      woke = true;
    }
    // Follows: the commenter follows (a person's comment is one that wakes;
    // the null-author lines the system writes with wake: false are not), and
    // every other follower hears of it — attention for an agent it names.
    const by: Follower | null = input.fromAgentId ? { kind: 'agent', id: input.fromAgentId } : input.wake !== false && !input.system ? { kind: 'user', id: actorId() } : null;
    await this.autoFollow(orgId, t, by, 'commented');
    await this.track(orgId, t, { actor: by, summary: `commented: ${text}`, mentionText: text, alreadyWoken: woke && owner ? [owner] : undefined });
    return row;
  }

  /** A message in the group log. Attributed; wakes nobody (§6). */
  async post(orgId: string, input: { text: string; fromAgentId?: string | null; runId?: string | null }): Promise<OrgMessage> {
    await this.org.get(orgId);
    const text = (input.text ?? '').trim().slice(0, 8_000);
    if (!text) throw new BadRequestException('message text is required');
    const row: OrgMessage = { id: newId(), accountId: currentAccountId(), orgId, taskId: null, fromAgentId: input.fromAgentId ?? null, runId: input.runId ?? null, text, createdAt: nowIso() };
    await this.db.insert(orgMessages).values(row);
    await this.audit.append(orgId, { actor: input.fromAgentId ? `agent:${input.fromAgentId}` : 'user', action: 'message', refType: 'org', refId: orgId, payload: { chars: text.length } });
    return row;
  }

  async messages(orgId: string, opts: { taskId?: string | null; limit?: number } = {}): Promise<OrgMessage[]> {
    const conds = [eq(orgMessages.orgId, orgId)];
    if (opts.taskId) conds.push(eq(orgMessages.taskId, opts.taskId));
    const rows = await this.db.select().from(orgMessages).where(and(...conds)).orderBy(desc(orgMessages.createdAt)).limit(Math.min(500, opts.limit ?? 200));
    return opts.taskId === undefined ? rows.filter((r) => r.taskId === null).reverse() : rows.reverse();
  }

  // ---- review ----

  /** Move to in_review and pick a reviewer when none is set: a different
   *  member than the assignee, preferring one whose provider/model family
   *  differs (§4.6 layer two), falling back to the chief. */
  async requestReview(orgId: string, taskId: string, input: { note?: string; fromAgentId?: string | null; runId?: string | null; agentModels?: Map<string, { provider: string; model: string }>; reviewerHumanId?: string | null }): Promise<OrgTask> {
    const t = await this.get(orgId, taskId);
    if (['done', 'cancelled'].includes(t.status)) throw new BadRequestException(`task is ${t.status}`);
    const org = await this.org.get(orgId);
    // Executable acceptance (docs/sensing.md §3): the checks run first and,
    // when they settle it, no reviewer — model or human — is asked.
    let checkNote = '';
    if (this.acceptanceGate && this.checksOf(t).length > 0) {
      const verdict = await this.acceptanceGate(orgId, t).catch((err: unknown): AcceptanceVerdict => ({ outcome: 'error', detail: err instanceof Error ? err.message : String(err), alsoReview: false }));
      const by = input.fromAgentId ? `agent:${input.fromAgentId}` : 'user';
      if (verdict.outcome === 'pass' && !verdict.alsoReview) {
        if (input.note) await this.comment(orgId, taskId, { text: `Review requested: ${input.note}`, fromAgentId: input.fromAgentId ?? null, runId: input.runId ?? null, wake: false });
        await this.db.update(orgTasks).set({ status: 'done', acceptedBy: 'check', claimedBy: null, claimedAt: null, updatedAt: nowIso() }).where(eq(orgTasks.id, taskId));
        await this.audit.append(orgId, { actor: 'check', action: 'review_accept', refType: 'task', refId: taskId, payload: { by: 'check', requestedBy: by, rounds: t.reviewRounds } });
        await this.comment(orgId, taskId, { text: `Accepted by check: ${verdict.detail}`.slice(0, 8_000), fromAgentId: null, wake: false });
        await this.accepted(orgId, taskId, 'check', t.reviewRounds);
        const done = await this.get(orgId, taskId);
        await this.trackStatus(orgId, done, t.status, followerFromActor(by, actorId()), { detail: 'accepted by check' });
        if (done.channelId || done.unitId) this.bus?.emitTaskStatus({ source: 'org', taskId, title: done.title, status: 'done', previous: t.status, channelId: done.channelId, messageId: done.messageId, agentId: done.assigneeAgentId, unitId: done.unitId });
        return done;
      }
      if (verdict.outcome === 'fail') {
        await this.audit.append(orgId, { actor: 'check', action: 'checks_failed', refType: 'task', refId: taskId, payload: { requestedBy: by, detail: verdict.detail.slice(0, 600) } });
        return this.review(orgId, taskId, { verdict: 'request_changes', note: `checks failed — ${verdict.detail}`, byAgentId: null, byCheck: true });
      }
      checkNote = verdict.outcome === 'pass' ? `All checks passed (${verdict.detail}); done_when also has text a reviewer judges.` : `Checks could not run (${verdict.detail}); review by judgment.`;
    }
    if (checkNote) await this.comment(orgId, taskId, { text: checkNote.slice(0, 8_000), fromAgentId: null, wake: false });
    // A review by a human employee (item 24): an approval-like `human_review`
    // card addressed to them; no agent reviewer is woken.
    const humanReviewer = input.reviewerHumanId ?? t.reviewerHumanId;
    if (humanReviewer) {
      if (!(await this.org.employee(orgId, humanReviewer))) throw new BadRequestException('reviewerHumanId must be a human employee of this organization');
      await this.db.update(orgTasks).set({ status: 'in_review', reviewerHumanId: humanReviewer, reviewerAgentId: null, claimedBy: null, claimedAt: null, updatedAt: nowIso() }).where(eq(orgTasks.id, taskId));
      if (input.note) await this.comment(orgId, taskId, { text: `Review requested: ${input.note}`, fromAgentId: input.fromAgentId ?? null, runId: input.runId ?? null, wake: false });
      const pending = (await this.db.select().from(orgApprovals).where(and(eq(orgApprovals.orgId, orgId), eq(orgApprovals.kind, 'human_review'), eq(orgApprovals.status, 'pending'))))
        .find((a) => (JSON.parse(a.payload) as { taskId?: string }).taskId === taskId);
      if (!pending) {
        await this.db.insert(orgApprovals).values({
          id: newId(), accountId: currentAccountId(), orgId, kind: 'human_review',
          payload: JSON.stringify({ taskId, title: t.title, reviewerHumanId: humanReviewer, assigneeAgentId: t.assigneeAgentId, note: input.note ?? '' }),
          requestedBy: input.fromAgentId ? `agent:${input.fromAgentId}` : 'user', recommendation: (input.note ?? '').slice(0, 600), status: 'pending', decidedAt: null, decidedBy: '', decisionNote: '', expiresAt: null, createdAt: nowIso(),
        });
      }
      await this.audit.append(orgId, { actor: input.fromAgentId ? `agent:${input.fromAgentId}` : 'user', action: 'review_request', refType: 'task', refId: taskId, payload: { reviewerHumanId: humanReviewer } });
      await this.notifyHuman(orgId, humanReviewer, { kind: 'org_review', title: `Review requested: ${t.title}`.slice(0, 200), body: input.note, payload: { orgId, taskId, action: 'review' } });
      await this.autoFollow(orgId, t, { kind: 'user', id: humanReviewer }, 'reviewer');
      const inReview = await this.get(orgId, taskId);
      await this.track(orgId, inReview, { actor: input.fromAgentId ? { kind: 'agent', id: input.fromAgentId } : { kind: 'user', id: actorId() }, summary: `review requested${input.note ? `: ${input.note}` : ''}`, attention: 'review requested', alreadyNotified: [humanReviewer] });
      return inReview;
    }
    let reviewer = t.reviewerAgentId;
    if (!reviewer || reviewer === t.assigneeAgentId) {
      const candidates = (await this.org.members(orgId)).filter((m) => m.status === 'active' && m.agentId !== t.assigneeAgentId);
      const mine = t.assigneeAgentId ? input.agentModels?.get(t.assigneeAgentId) : undefined;
      const differentFamily = candidates.find((m) => {
        const theirs = input.agentModels?.get(m.agentId);
        return mine && theirs && familyOf(theirs) !== familyOf(mine);
      });
      reviewer = differentFamily?.agentId ?? candidates.find((m) => m.agentId === org.chiefOfStaffAgentId)?.agentId ?? candidates[0]?.agentId ?? null;
    }
    await this.db.update(orgTasks).set({ status: 'in_review', reviewerAgentId: reviewer, claimedBy: null, claimedAt: null, updatedAt: nowIso() }).where(eq(orgTasks.id, taskId));
    if (input.note) await this.comment(orgId, taskId, { text: `Review requested: ${input.note}`, fromAgentId: input.fromAgentId ?? null, runId: input.runId ?? null, wake: false });
    await this.audit.append(orgId, { actor: input.fromAgentId ? `agent:${input.fromAgentId}` : 'user', action: 'review_request', refType: 'task', refId: taskId, payload: { reviewerAgentId: reviewer } });
    if (reviewer && await this.org.isActive(orgId)) this.emitWake(orgId, taskId, reviewer, 'review');
    if (reviewer) await this.autoFollow(orgId, t, { kind: 'agent', id: reviewer }, 'reviewer');
    const inReview = await this.get(orgId, taskId);
    await this.trackStatus(orgId, inReview, t.status === 'in_review' ? '' : t.status, input.fromAgentId ? { kind: 'agent', id: input.fromAgentId } : { kind: 'user', id: actorId() }, { detail: input.note ?? '', alreadyWoken: reviewer ? [reviewer] : undefined });
    return inReview;
  }

  /** The reviewer's verdict. `accept` → done; `request_changes` → back to
   *  todo with the note, reviewRounds++ and the owner woken; after
   *  REVIEW_ROUND_CAP rounds the task escalates to the user instead (an
   *  `escalation` approval card) and stays blocked; `escalate` does that
   *  at once. Self-review is refused. */
  private readonly reviewListeners: ReviewVerdictListener[] = [];

  /** Be told of every review verdict (the trust ledger, docs/actions-and-trust.md §6:
   *  an accepted task is a clean outcome for its assignee, changes requested a rejection). */
  onReviewVerdict(fn: ReviewVerdictListener): () => void {
    this.reviewListeners.push(fn);
    return () => { const i = this.reviewListeners.indexOf(fn); if (i >= 0) this.reviewListeners.splice(i, 1); };
  }

  async review(orgId: string, taskId: string, input: { verdict: 'accept' | 'request_changes' | 'escalate'; note?: string; byAgentId?: string | null; runId?: string | null; byCheck?: boolean }): Promise<OrgTask> {
    const t = await this.get(orgId, taskId);
    const actor = input.byCheck ? 'check' : input.byAgentId ? `agent:${input.byAgentId}` : 'user';
    if (input.byAgentId && input.byAgentId === t.assigneeAgentId) throw new BadRequestException('a task cannot be reviewed by its own assignee');
    for (const fn of this.reviewListeners) await Promise.resolve(fn({ orgId, taskId, assigneeAgentId: t.assigneeAgentId, verdict: input.verdict, byAgentId: input.byAgentId ?? null })).catch(() => undefined);
    if (input.verdict === 'accept') {
      await this.db.update(orgTasks).set({ status: 'done', acceptedBy: 'review', claimedBy: null, claimedAt: null, updatedAt: nowIso() }).where(eq(orgTasks.id, taskId));
      await this.audit.append(orgId, { actor, action: 'review_accept', refType: 'task', refId: taskId, payload: { rounds: t.reviewRounds } });
      if (input.note) await this.comment(orgId, taskId, { text: `Accepted: ${input.note}`, fromAgentId: input.byAgentId ?? null, runId: input.runId ?? null, wake: false });
      await this.accepted(orgId, taskId, 'review', t.reviewRounds);
      const done = await this.get(orgId, taskId);
      await this.trackStatus(orgId, done, t.status, input.byAgentId ? { kind: 'agent', id: input.byAgentId } : input.byCheck ? null : { kind: 'user', id: actorId() }, { detail: `accepted${input.note ? `: ${input.note}` : ''}` });
      return done;
    }
    const rounds = t.reviewRounds + 1;
    if (input.verdict === 'escalate' || rounds > REVIEW_ROUND_CAP) {
      await this.escalate(orgId, taskId, input.verdict === 'escalate' ? (input.note ?? 'escalated by reviewer') : `review round cap (${REVIEW_ROUND_CAP}) reached: ${input.note ?? ''}`.trim(), actor);
      return this.get(orgId, taskId);
    }
    await this.db.update(orgTasks).set({ status: 'todo', reviewRounds: rounds, claimedBy: null, claimedAt: null, updatedAt: nowIso() }).where(eq(orgTasks.id, taskId));
    await this.audit.append(orgId, { actor, action: 'review_request_changes', refType: 'task', refId: taskId, payload: { rounds } });
    await this.comment(orgId, taskId, { text: `Changes requested (round ${rounds}/${REVIEW_ROUND_CAP}): ${input.note ?? ''}`.trim(), fromAgentId: input.byAgentId ?? null, runId: input.runId ?? null, wake: true, system: input.byCheck });
    return this.get(orgId, taskId);
  }

  /** Block the task with an owner and put it in front of the user as an
   *  `escalation` approval. The chief is the default owner. */
  async escalate(orgId: string, taskId: string, reason: string, actor: string): Promise<OrgTask> {
    const t = await this.get(orgId, taskId);
    const org = await this.org.get(orgId);
    const blockers = [...parseList(t.blockers), `escalated: ${reason}`.slice(0, 300)].slice(-20);
    await this.db.update(orgTasks).set({ status: 'blocked', blockers: JSON.stringify(blockers), claimedBy: null, claimedAt: null, updatedAt: nowIso() }).where(eq(orgTasks.id, taskId));
    const pending = (await this.db.select().from(orgApprovals).where(and(eq(orgApprovals.orgId, orgId), eq(orgApprovals.kind, 'escalation'), eq(orgApprovals.status, 'pending'))))
      .find((a) => (JSON.parse(a.payload) as { taskId?: string }).taskId === taskId);
    if (!pending) {
      await this.db.insert(orgApprovals).values({
        id: newId(), accountId: currentAccountId(), orgId, kind: 'escalation',
        payload: JSON.stringify({ taskId, title: t.title, reason, ownerAgentId: org.chiefOfStaffAgentId, assigneeAgentId: t.assigneeAgentId }),
        requestedBy: actor, recommendation: '', status: 'pending', decidedAt: null, decisionNote: '', expiresAt: null, createdAt: nowIso(),
      });
    }
    await this.audit.append(orgId, { actor, action: 'task_escalate', refType: 'task', refId: taskId, payload: { reason: reason.slice(0, 300) } });
    this.bus?.emitOrgBoard({ orgId, kind: 'escalation', refId: taskId, detail: `"${t.title}" escalated: ${reason.slice(0, 200)}` });
    const blocked = await this.get(orgId, taskId);
    await this.trackStatus(orgId, blocked, t.status, followerFromActor(actor, actorId()), { detail: `escalated: ${reason.slice(0, 200)}` });
    return blocked;
  }

  /**
   * The escalation chain below the CEO (decision 4 of
   * docs/autonomous-skills-review.md §4): a member raises a task to the
   * member above it — a specialist to its head, a head to the chief. The
   * task blocks with the reason on its timeline; the target gets one open
   * `Escalation:` task on its board per escalated task (a repeat is a
   * comment on it that wakes it again) and an inbox event. No approval card
   * and no board event for the chief: the CEO path is `escalate`.
   */
  async escalateTo(orgId: string, taskId: string, input: { toAgentId: string; toName: string; reason: string; actor: string; fromAgentId: string; runId?: string | null }): Promise<{ task: OrgTask; escalation: OrgTask; reused: boolean }> {
    const t = await this.get(orgId, taskId);
    const reason = input.reason.slice(0, 300);
    const blockers = [...parseList(t.blockers), `escalated to ${input.toName}: ${reason}`.slice(0, 300)].slice(-20);
    await this.db.update(orgTasks).set({ status: 'blocked', blockers: JSON.stringify(blockers), claimedBy: null, claimedAt: null, updatedAt: nowIso() }).where(eq(orgTasks.id, taskId));
    await this.comment(orgId, t.id, { text: `Escalated to ${input.toName}: ${reason}`, fromAgentId: input.fromAgentId, runId: input.runId ?? null });
    const open = (await this.list(orgId)).find((x) => x.parentTaskId === t.id && x.assigneeAgentId === input.toAgentId && x.title.startsWith('Escalation:') && !['done', 'cancelled'].includes(x.status));
    let escalation: OrgTask;
    if (open) {
      await this.comment(orgId, open.id, { text: `Escalated again: ${reason}`, fromAgentId: input.fromAgentId, runId: input.runId ?? null, wake: true });
      escalation = open;
    } else {
      const unit = this.units ? await this.units.ledBy(orgId, input.toAgentId).catch(() => null) : null;
      escalation = await this.create(orgId, {
        title: `Escalation: ${t.title}`.slice(0, 200),
        brief: {
          outcome: `A decision or an unblock for task [${t.id.slice(0, 8)}] "${t.title}".`,
          context: `Escalated by its ${t.assigneeAgentId === input.fromAgentId ? 'owner' : 'reviewer or lead'}: ${reason}`,
          constraints: 'Decide within your own authority; take it higher with org_escalate (a head: to the chief, or to the CEO for a decision only the CEO can make) rather than deciding beyond it.',
          done_when: `Task [${t.id.slice(0, 8)}] can move again: your answer is on its timeline (org_task_comment) and it is unblocked, reassigned or escalated further.`,
        },
        parentTaskId: t.id, assigneeAgentId: input.toAgentId, status: 'todo', createdBy: input.actor, unitId: unit?.id ?? null,
      });
    }
    await this.agents?.addEvent(input.toAgentId, { kind: 'escalation', title: `Escalation: ${t.title}`.slice(0, 200), body: reason, payload: JSON.stringify({ orgId, taskId: t.id, escalationTaskId: escalation.id }), origin: 'org' }).catch(() => undefined);
    await this.audit.append(orgId, { actor: input.actor, action: 'task_escalate', refType: 'task', refId: taskId, payload: { reason, to: input.toAgentId, escalationTaskId: escalation.id } });
    const blocked = await this.get(orgId, taskId);
    await this.trackStatus(orgId, blocked, t.status, { kind: 'agent', id: input.fromAgentId }, { detail: `escalated to ${input.toName}: ${reason}` });
    return { task: blocked, escalation, reused: Boolean(open) };
  }

  // ---- runs ----

  async startRun(orgId: string, input: { taskId: string; agentId: string; sessionId?: string | null; wakeReason: OrgWakeReason; reservedUsd?: number }): Promise<OrgRun> {
    const row: OrgRun = {
      id: newId(), accountId: currentAccountId(), orgId, taskId: input.taskId, agentId: input.agentId, sessionId: input.sessionId ?? null,
      wakeReason: input.wakeReason, status: 'running', outcome: '', tokensIn: 0, tokensOut: 0, usd: 0, reservedUsd: input.reservedUsd ?? 0,
      startedAt: nowIso(), endedAt: null,
    };
    await this.db.insert(orgRuns).values(row);
    return row;
  }

  async endRun(runId: string, patch: Partial<Pick<OrgRun, 'status' | 'outcome' | 'tokensIn' | 'tokensOut' | 'usd' | 'sessionId'>>): Promise<void> {
    await this.db.update(orgRuns).set({ ...patch, endedAt: nowIso() }).where(eq(orgRuns.id, runId));
  }

  async getRun(runId: string): Promise<OrgRun | null> {
    return (await this.db.select().from(orgRuns).where(eq(orgRuns.id, runId)).limit(1)).at(0) ?? null;
  }

  runs(orgId: string, opts: { taskId?: string; limit?: number } = {}): Promise<OrgRun[]> {
    const conds = [eq(orgRuns.orgId, orgId)];
    if (opts.taskId) conds.push(eq(orgRuns.taskId, opts.taskId));
    return this.db.select().from(orgRuns).where(and(...conds)).orderBy(desc(orgRuns.startedAt)).limit(Math.min(500, opts.limit ?? 100));
  }

  /** Runs still marked running for a task (one-run-per-task guard). */
  async runningRuns(orgId: string, taskId?: string): Promise<OrgRun[]> {
    const conds = [eq(orgRuns.orgId, orgId), eq(orgRuns.status, 'running')];
    if (taskId) conds.push(eq(orgRuns.taskId, taskId));
    return this.db.select().from(orgRuns).where(and(...conds));
  }

  // ---- model-facing text ----

  /** The board as the model reads it: bounded, one line per task. */
  async boardForModel(orgId: string, agentNames: Map<string, string>, opts: { assigneeAgentId?: string } = {}): Promise<string> {
    const tasks = (await this.list(orgId)).filter((t) => !opts.assigneeAgentId || t.assigneeAgentId === opts.assigneeAgentId);
    if (tasks.length === 0) return 'The board is empty.';
    const order = Object.fromEntries(TASK_STATUSES.map((s, i) => [s, i])) as Record<string, number>;
    return tasks
      .filter((t) => t.status !== 'cancelled')
      .sort((a, b) => (order[a.status] - order[b.status]) || (a.createdAt < b.createdAt ? -1 : 1))
      .slice(0, 120)
      .map((t) => {
        const b = parseBrief(t.brief);
        const who = t.assigneeAgentId ? agentNames.get(t.assigneeAgentId) ?? t.assigneeAgentId.slice(0, 8) : t.assigneeHumanId ? `human ${t.assigneeHumanId.slice(0, 8)}` : 'unassigned';
        const deps = parseDeps(t.dependsOn);
        return `[${t.id.slice(0, 8)}] (${t.status}) ${t.title} — owner: ${who}${t.reviewRounds ? ` · review round ${t.reviewRounds}` : ''}${t.dueAt ? ` · due ${t.dueAt.slice(0, 16).replace('T', ' ')}` : ''}${deps.length ? ` · depends on ${deps.map((d) => d.slice(0, 8)).join(', ')}` : ''}${b.outcome ? ` · outcome: ${b.outcome.slice(0, 100)}` : ''}`;
      })
      .join('\n');
  }

  private emitWake(orgId: string, taskId: string, agentId: string, reason: OrgWakeReason): void {
    this.bus?.emitOrgWake({ orgId, taskId, agentId, reason });
  }
}

export type ReviewVerdictListener = (ev: { orgId: string; taskId: string; assigneeAgentId: string | null; verdict: 'accept' | 'request_changes' | 'escalate'; byAgentId: string | null }) => unknown;

/** Model family for the different-family reviewer rule: the provider, plus
 *  the leading token of the model id so two agents on one provider but on
 *  claude-haiku vs claude-opus still count as different families. */
export function familyOf(x: { provider: string; model: string }): string {
  const m = (x.model || '').toLowerCase().replace(/^.*\//, '');
  const head = m.match(/^(claude-(?:opus|sonnet|haiku)|gpt-\d+(?:\.\d+)?(?:-(?:mini|nano))?|o\d|gemini-[\d.]+-(?:pro|flash)|deepseek-\w+|[a-z]+)/)?.[1] ?? m;
  return `${x.provider}:${head}`;
}

/** A deadline as ISO, or null; refuses what is not a date. */
export function normalizeDue(v: string | null | undefined): string | null {
  if (v === undefined || v === null || v === '') return null;
  const ms = Date.parse(String(v));
  if (!Number.isFinite(ms)) throw new BadRequestException(`dueAt "${String(v).slice(0, 40)}" is not a date`);
  return new Date(ms).toISOString();
}

function parseList(raw: string): string[] {
  try { const v = JSON.parse(raw || '[]') as unknown; return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
}
