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
import { currentAccountId } from '../accounts/account-context';
import { TriggerBus, OrgWakeReason } from '../chats/trigger-bus';
import { OrgAuditService } from './org-audit.service';
import { OrgService } from './org.service';
import { OrgUnitsService } from './org-units.service';

export type OrgTask = typeof orgTasks.$inferSelect;
export type OrgRun = typeof orgRuns.$inferSelect;
export type OrgMessage = typeof orgMessages.$inferSelect;

export const TASK_STATUSES = ['backlog', 'todo', 'claimed', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled'] as const;
export type TaskStatus = typeof TASK_STATUSES[number];
export const REVIEW_ROUND_CAP = 3;
const TASK_LIMIT = 500;

export interface TaskBrief { outcome: string; context: string; constraints: string; done_when: string }

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
  ) {}

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
  }): Promise<OrgTask> {
    const org = await this.org.get(orgId);
    const title = (input.title ?? '').trim().slice(0, 200);
    if (!title) throw new BadRequestException('task title is required');
    if ((await this.list(orgId)).length >= TASK_LIMIT) throw new BadRequestException(`task limit (${TASK_LIMIT}) reached — close or cancel tasks first`);
    if (input.projectId) await this.org.project(orgId, input.projectId);
    if (input.parentTaskId) await this.get(orgId, input.parentTaskId);
    const status: TaskStatus = input.status ?? (input.assigneeAgentId ? 'todo' : 'backlog');
    if (!TASK_STATUSES.includes(status)) throw new BadRequestException(`status must be one of ${TASK_STATUSES.join(', ')}`);
    if (input.assigneeAgentId) {
      const m = await this.org.member(orgId, input.assigneeAgentId);
      if (!m || m.status !== 'active') throw new BadRequestException('assignee must be an active member of this organization');
    }
    const brief = parseBrief(typeof input.brief === 'string' ? input.brief : (input.brief as Record<string, unknown> | undefined));
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
      assigneeAgentId: input.assigneeAgentId ?? null, claimedBy: null, claimedAt: null,
      reviewerAgentId: input.reviewerAgentId ?? null, reviewRounds: 0,
      blockers: '[]', fileScope: JSON.stringify((input.fileScope ?? []).map(String).slice(0, 20)),
      noProgressCount: 0, lastRunAt: null, createdBy: input.createdBy ?? 'user',
      channelId: input.channelId ?? null, messageId: input.messageId ?? null,
      unitId, unitExplicit,
      class: normalizeTaskClass(input.class) ?? deriveTaskClass({ title, brief }),
      createdAt: now, updatedAt: now,
    };
    await this.db.insert(orgTasks).values(row);
    await this.audit.append(orgId, { actor: row.createdBy, action: 'task_create', refType: 'task', refId: row.id, payload: { title, status, assigneeAgentId: row.assigneeAgentId, projectId: row.projectId, parentTaskId: row.parentTaskId, unitId, class: row.class } });
    if (row.assigneeAgentId && status === 'todo' && org.status === 'active') this.emitWake(orgId, row.id, row.assigneeAgentId, 'assignment');
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
  }, actor = 'user'): Promise<OrgTask> {
    const t = await this.get(orgId, taskId);
    const set: Record<string, unknown> = { updatedAt: nowIso() };
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
    await this.db.update(orgTasks).set(set).where(eq(orgTasks.id, taskId));
    const { updatedAt: _u, ...logged } = set; void _u;
    if (Object.keys(logged).length > 0) await this.audit.append(orgId, { actor, action: 'task_update', refType: 'task', refId: taskId, payload: logged });
    // A task that just became blocked is a board event the autonomous chief reviews (docs/group-chat.md §5).
    if (patch.status === 'blocked' && t.status !== 'blocked') this.bus?.emitOrgBoard({ orgId, kind: 'blocked', refId: taskId, detail: `"${t.title}" is blocked${patch.blockers?.length ? `: ${patch.blockers.at(-1)}` : ''}` });
    const updated = await this.get(orgId, taskId);
    // Status back into the originating channel thread (docs/group-chat.md §3),
    // or into the unit channel when the task did not come from a message (§7).
    if (patch.status !== undefined && patch.status !== t.status && (updated.channelId || updated.unitId)) {
      this.bus?.emitTaskStatus({ source: 'org', taskId, title: updated.title, status: updated.status, previous: t.status, channelId: updated.channelId, messageId: updated.messageId, agentId: updated.assigneeAgentId, unitId: updated.unitId });
    }
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
    await this.db.update(orgTasks).set({ assigneeAgentId: agentId, status: 'todo', claimedBy: null, claimedAt: null, noProgressCount: 0, unitId, updatedAt: nowIso() }).where(eq(orgTasks.id, taskId));
    await this.audit.append(orgId, { actor, action: 'task_assign', refType: 'task', refId: taskId, payload: { agentId, previous: t.assigneeAgentId, unitId } });
    if (await this.org.isActive(orgId)) this.emitWake(orgId, taskId, agentId, 'assignment');
    return this.get(orgId, taskId);
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
  async comment(orgId: string, taskId: string, input: { text: string; fromAgentId?: string | null; runId?: string | null; wake?: boolean }): Promise<OrgMessage> {
    const t = await this.get(orgId, taskId);
    const text = (input.text ?? '').trim().slice(0, 8_000);
    if (!text) throw new BadRequestException('comment text is required');
    const row: OrgMessage = { id: newId(), accountId: currentAccountId(), orgId, taskId, fromAgentId: input.fromAgentId ?? null, runId: input.runId ?? null, text, createdAt: nowIso() };
    await this.db.insert(orgMessages).values(row);
    await this.audit.append(orgId, { actor: input.fromAgentId ? `agent:${input.fromAgentId}` : 'user', action: 'task_comment', refType: 'task', refId: taskId, payload: { chars: text.length } });
    const owner = t.assigneeAgentId;
    const wake = input.wake ?? true;
    if (wake && owner && owner !== (input.fromAgentId ?? null) && !['done', 'cancelled'].includes(t.status) && await this.org.isActive(orgId)) {
      this.emitWake(orgId, taskId, owner, 'comment');
    }
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
  async requestReview(orgId: string, taskId: string, input: { note?: string; fromAgentId?: string | null; runId?: string | null; agentModels?: Map<string, { provider: string; model: string }> }): Promise<OrgTask> {
    const t = await this.get(orgId, taskId);
    if (['done', 'cancelled'].includes(t.status)) throw new BadRequestException(`task is ${t.status}`);
    let reviewer = t.reviewerAgentId;
    const org = await this.org.get(orgId);
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
    return this.get(orgId, taskId);
  }

  /** The reviewer's verdict. `accept` → done; `request_changes` → back to
   *  todo with the note, reviewRounds++ and the owner woken; after
   *  REVIEW_ROUND_CAP rounds the task escalates to the user instead (an
   *  `escalation` approval card) and stays blocked; `escalate` does that
   *  at once. Self-review is refused. */
  async review(orgId: string, taskId: string, input: { verdict: 'accept' | 'request_changes' | 'escalate'; note?: string; byAgentId?: string | null; runId?: string | null }): Promise<OrgTask> {
    const t = await this.get(orgId, taskId);
    const actor = input.byAgentId ? `agent:${input.byAgentId}` : 'user';
    if (input.byAgentId && input.byAgentId === t.assigneeAgentId) throw new BadRequestException('a task cannot be reviewed by its own assignee');
    if (input.verdict === 'accept') {
      await this.db.update(orgTasks).set({ status: 'done', claimedBy: null, claimedAt: null, updatedAt: nowIso() }).where(eq(orgTasks.id, taskId));
      await this.audit.append(orgId, { actor, action: 'review_accept', refType: 'task', refId: taskId, payload: { rounds: t.reviewRounds } });
      if (input.note) await this.comment(orgId, taskId, { text: `Accepted: ${input.note}`, fromAgentId: input.byAgentId ?? null, runId: input.runId ?? null, wake: false });
      return this.get(orgId, taskId);
    }
    const rounds = t.reviewRounds + 1;
    if (input.verdict === 'escalate' || rounds > REVIEW_ROUND_CAP) {
      await this.escalate(orgId, taskId, input.verdict === 'escalate' ? (input.note ?? 'escalated by reviewer') : `review round cap (${REVIEW_ROUND_CAP}) reached: ${input.note ?? ''}`.trim(), actor);
      return this.get(orgId, taskId);
    }
    await this.db.update(orgTasks).set({ status: 'todo', reviewRounds: rounds, claimedBy: null, claimedAt: null, updatedAt: nowIso() }).where(eq(orgTasks.id, taskId));
    await this.audit.append(orgId, { actor, action: 'review_request_changes', refType: 'task', refId: taskId, payload: { rounds } });
    await this.comment(orgId, taskId, { text: `Changes requested (round ${rounds}/${REVIEW_ROUND_CAP}): ${input.note ?? ''}`.trim(), fromAgentId: input.byAgentId ?? null, runId: input.runId ?? null, wake: true });
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
    return this.get(orgId, taskId);
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
        const who = t.assigneeAgentId ? agentNames.get(t.assigneeAgentId) ?? t.assigneeAgentId.slice(0, 8) : 'unassigned';
        return `[${t.id.slice(0, 8)}] (${t.status}) ${t.title} — owner: ${who}${t.reviewRounds ? ` · review round ${t.reviewRounds}` : ''}${b.outcome ? ` · outcome: ${b.outcome.slice(0, 100)}` : ''}`;
      })
      .join('\n');
  }

  private emitWake(orgId: string, taskId: string, agentId: string, reason: OrgWakeReason): void {
    this.bus?.emitOrgWake({ orgId, taskId, agentId, reason });
  }
}

/** Model family for the different-family reviewer rule: the provider, plus
 *  the leading token of the model id so two agents on one provider but on
 *  claude-haiku vs claude-opus still count as different families. */
export function familyOf(x: { provider: string; model: string }): string {
  const m = (x.model || '').toLowerCase().replace(/^.*\//, '');
  const head = m.match(/^(claude-(?:opus|sonnet|haiku)|gpt-\d+(?:\.\d+)?(?:-(?:mini|nano))?|o\d|gemini-[\d.]+-(?:pro|flash)|deepseek-\w+|[a-z]+)/)?.[1] ?? m;
  return `${x.provider}:${head}`;
}

function parseList(raw: string): string[] {
  try { const v = JSON.parse(raw || '[]') as unknown; return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
}
