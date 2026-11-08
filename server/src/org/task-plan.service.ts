/**
 * TaskPlanService — multi-session task execution (docs/task-execution.md).
 *
 * One task (a company task, or a big request in a chat) may be split by the
 * agent performing it into a **plan**: steps with dependencies, exit
 * criteria, a parallel-safe flag and a tier hint (task-plan-model.ts, the
 * process engine's model with one stage). The plan runs in one of three
 * modes:
 *
 *  - **single** — today's run; the plan is the agent's own checklist and
 *    each step is recorded with `task_step_result`;
 *  - **sequential** — the agent works the steps itself and, nearing its
 *    context ceiling or at a step boundary, writes a **handoff packet**
 *    (state, decisions, artifacts, open questions, next step): the task's
 *    next run continues in a fresh session re-grounded on the packet, the
 *    plan and the brief instead of a compacted history;
 *  - **orchestrated** — the session that owns the plan is the **master**:
 *    `task_step_run` starts a fresh **worker** session per ready step (same
 *    agent, same permissions and gates; only its step card, the outputs of
 *    the steps it depends on and the decision log), runs parallel-safe steps
 *    side by side up to the cap and the others one at a time, waits for
 *    them, checks each result against the step's exit criteria and hands the
 *    results back to the master, which verifies, revises and integrates.
 *
 * Guardrails (task-exec-tunables.ts, per company; the defaults outside one):
 * sessions, parallel workers, depth, steps, USD and tokens per plan; effort
 * scaling (a small task may not fan out); attempts per step; the idle-round
 * breaker across sessions; a second identical handoff is refused. A
 * company task's workers reserve and settle against the budget envelopes
 * like any run, run under the task's RunCtx (kill switch, loop breaker,
 * org tools) and count as one task for WIP — they are sessions, not board
 * tasks. Workers' turns are `loop` turns: outward actions go through the
 * action contract, trust and policy exactly as any background run's.
 *
 * Restart-safe: claiming a step is one conditional update; on boot the
 * recovery participant marks the sessions and steps a dead process left
 * running `interrupted`; the master's next `task_step_run` re-runs them,
 * resuming an interrupted worker in its own session (its history is there).
 * The org task's own interrupted turn is resumed by the existing recovery.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { orgTasks, taskPlanEntries, taskPlanSessions, taskPlanSteps, taskPlans } from '../database/schema';
import { newId, nowIso } from '../common/ids.util';
import { isDraining } from '../common/lifecycle';
import { ChatsRepository, type ChatSession } from '../chats/chats.repository';
import { TurnLoopService, type ToolExecCtx } from '../chats/turn-loop.service';
import { RestartRecoveryService } from '../chats/restart-recovery.service';
import { AgentsService } from '../agents/agents.service';
import { usdFor } from '../ai/pricing';
import { OrgService, type Organization } from './org.service';
import { OrgTasksService, parseBrief } from './org-tasks.service';
import { OrgRuntimeService, type RunCtx, type RunEndEvent } from './org-runtime.service';
import { parseRouting, tierModel, type ModelTier } from './org-routing';
import type { ModelTypeLike } from '../agent-types/model-resolution';
import { execTunables, type ExecTunables } from './task-exec-tunables';
import {
  checkExit, describeHandoff, diffPlan, effortRefusal, handoffSignature, normalizeHandoff, normalizePlan, planComplete, planText, readySteps,
  stepCardText, suggestMode, validatePlan, type HandoffPacket, type PlanStep, type PlanStepStatus, type SplitSignals, type TaskPlanDef,
} from './task-plan-model';
import { describeProblems } from './process-model';
import { taskRef } from '../common/task-keys';

export type TaskPlanRow = typeof taskPlans.$inferSelect;
export type TaskPlanStepRow = typeof taskPlanSteps.$inferSelect;
export type TaskPlanSessionRow = typeof taskPlanSessions.$inferSelect;
export type TaskPlanEntryRow = typeof taskPlanEntries.$inferSelect;

/** Fallback price when a model is unknown to the table: Sonnet-class list (as the runtime). */
const FALLBACK_PRICE = { input: 3, output: 15 };

/**
 * The one place a step's tier hint becomes a model. Automatic model
 * selection (agent-types/model-resolution.ts, org-routing.ts) plugs in
 * here: today a tier resolves through the company's routing table and the
 * agent's type exactly as a task class does; no tier inherits the master's
 * model; the CEO's pin on the agent always wins. '' = inherit.
 */
export function resolveStepModel(tier: ModelTier | undefined, opts: { provider: string; baseModel: string; pinned?: string; routing?: string | null; type?: ModelTypeLike | null }): string {
  if (opts.pinned) return opts.pinned;
  if (!tier) return '';
  return tierModel(parseRouting(opts.routing ?? null), tier, opts.provider, opts.baseModel, undefined, opts.type ?? null) || '';
}

const json = <T,>(raw: string | null | undefined, fallback: T): T => { try { return raw ? JSON.parse(raw) as T : fallback; } catch { return fallback; } };

/** Tools a worker may not call: the master owns the task's status, assignment, review and plan. */
const WORKER_REFUSED = new Set(['org_request_review', 'org_review', 'org_assign', 'org_create_task', 'task_plan']);

interface WorkerOutcome { stepId: string; status: PlanStepStatus; output: string; gaps: string[]; sessions: string[]; usd: number; tokens: number; error: string }

export interface PlanView {
  plan: { id: string; title: string; mode: string; dynamic: boolean; status: string; version: number; sessions: number; usd: number; tokensIn: number; tokensOut: number; taskId: string | null; orgId: string | null; rootSessionId: string; leadSessionId: string | null; note: string; caps: { maxSessions: number; maxParallel: number; maxDepth: number; planUsdCap: number; planTokenCap: number }; createdAt: string; updatedAt: string };
  steps: Array<PlanStep & { status: string; attempts: number; sessionId: string | null; output: string; criteria: Array<{ criterion: string; met: boolean; evidence: string }>; questions: string[]; artifacts: string[]; note: string; model: string; tokensIn: number; tokensOut: number; usd: number; startedAt: string | null; endedAt: string | null; ready: boolean }>;
  sessions: Array<{ sessionId: string; role: string; stepId: string | null; parentSessionId: string | null; depth: number; status: string; model: string; tokensIn: number; tokensOut: number; usd: number; error: string; startedAt: string; endedAt: string | null }>;
  decisions: Array<{ text: string; stepId: string | null; sessionId: string | null; proposed: boolean; createdAt: string }>;
  handoffs: Array<HandoffPacket & { stepId: string | null; fromSessionId: string | null; toSessionId: string | null; createdAt: string }>;
  versions: Array<{ version: number; reason: string; diff: string[]; createdAt: string }>;
}

@Injectable()
export class TaskPlanService {
  private readonly logger = new Logger(TaskPlanService.name);
  /** Worker sessions running in this process → their master's abort hook. */
  private readonly live = new Map<string, { planId: string; stepId: string }>();

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly repo: ChatsRepository,
    private readonly agents: AgentsService,
    private readonly org: OrgService,
    private readonly tasks: OrgTasksService,
    @Optional() private readonly turns?: TurnLoopService,
    @Optional() private readonly runtime?: OrgRuntimeService,
    @Optional() recovery?: RestartRecoveryService,
  ) {
    runtime?.bindTaskSession((_orgId, taskId) => this.leadSessionFor(taskId));
    runtime?.onRunEnd((ev) => this.afterRun(ev));
    recovery?.addParticipant({ name: 'task-plans', release: () => this.releaseInterrupted() });
  }

  // ---- reads ----

  async get(planId: string): Promise<TaskPlanRow | null> {
    return (await this.db.select().from(taskPlans).where(eq(taskPlans.id, planId)).limit(1))[0] ?? null;
  }
  async byScope(scopeKey: string): Promise<TaskPlanRow | null> {
    return (await this.db.select().from(taskPlans).where(eq(taskPlans.scopeKey, scopeKey)).limit(1))[0] ?? null;
  }
  async forTask(taskId: string): Promise<TaskPlanRow | null> { return this.byScope(`task:${taskId}`); }
  async steps(planId: string): Promise<TaskPlanStepRow[]> {
    return this.db.select().from(taskPlanSteps).where(eq(taskPlanSteps.planId, planId));
  }
  async sessionRows(planId: string): Promise<TaskPlanSessionRow[]> {
    return this.db.select().from(taskPlanSessions).where(eq(taskPlanSessions.planId, planId)).orderBy(asc(taskPlanSessions.startedAt));
  }
  async entries(planId: string, kind?: string): Promise<TaskPlanEntryRow[]> {
    return this.db.select().from(taskPlanEntries).where(kind ? and(eq(taskPlanEntries.planId, planId), eq(taskPlanEntries.kind, kind)) : eq(taskPlanEntries.planId, planId)).orderBy(asc(taskPlanEntries.createdAt));
  }
  /** The newest row of a session in any plan (a worker, a lead continuation, the master). */
  async sessionRow(sessionId: string): Promise<TaskPlanSessionRow | null> {
    const rows = await this.db.select().from(taskPlanSessions).where(eq(taskPlanSessions.sessionId, sessionId));
    return rows.sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0] ?? null;
  }

  /** The plan a session works on, and its part in it. A company task run's
   *  session belongs to the task's plan; a chat owns its own; a worker or a
   *  lead continuation is found by its session row. */
  async scopeOf(session: ChatSession): Promise<{ plan: TaskPlanRow | null; scopeKey: string; role: 'master' | 'lead' | 'worker'; depth: number; stepId: string | null; orgId: string | null; taskId: string | null }> {
    const row = await this.sessionRow(session.id);
    if (row && row.role === 'worker') {
      const plan = await this.get(row.planId);
      return { plan, scopeKey: plan?.scopeKey ?? '', role: 'worker', depth: row.depth, stepId: row.stepId, orgId: plan?.orgId ?? null, taskId: plan?.taskId ?? null };
    }
    const ctx = this.runtime?.runningCtx(session.id);
    const taskId = ctx?.taskId || (session.taskKind === 'org' ? session.taskId : null) || null;
    if (taskId) {
      const scopeKey = `task:${taskId}`;
      return { plan: await this.byScope(scopeKey), scopeKey, role: 'master', depth: 0, stepId: null, orgId: ctx?.orgId ?? (await this.db.select({ orgId: orgTasks.orgId }).from(orgTasks).where(eq(orgTasks.id, taskId)).limit(1))[0]?.orgId ?? null, taskId };
    }
    if (row) {
      const plan = await this.get(row.planId);
      return { plan, scopeKey: plan?.scopeKey ?? '', role: row.role === 'lead' ? 'lead' : 'master', depth: row.depth, stepId: null, orgId: plan?.orgId ?? null, taskId: plan?.taskId ?? null };
    }
    const scopeKey = `chat:${session.id}`;
    return { plan: await this.byScope(scopeKey), scopeKey, role: 'master', depth: 0, stepId: null, orgId: null, taskId: null };
  }

  /** The company whose tunables bind a plan: the task's, else the agent's own. */
  private async orgFor(orgId: string | null, agentId: string): Promise<Organization | null> {
    if (orgId) return this.org.get(orgId).catch(() => null);
    const m = (await this.org.membershipsOf(agentId).catch(() => [])).find((x) => x.status === 'active');
    return m ? this.org.get(m.orgId).catch(() => null) : null;
  }
  async tunablesFor(orgId: string | null, agentId: string): Promise<ExecTunables> {
    return execTunables(await this.orgFor(orgId, agentId));
  }
  private splitT(t: ExecTunables) {
    return { splitBriefChars: t['exec.splitBriefChars'], splitCriteria: t['exec.splitCriteria'], splitSteps: t['exec.splitSteps'], handoffAt: t['exec.handoffAt'], orchestrateMinSignals: t['exec.orchestrateMinSignals'] };
  }

  /** What the runtime knows about the task's size before anything is split. */
  async signals(session: ChatSession, scope: { orgId: string | null; taskId: string | null }): Promise<SplitSignals> {
    const pressure = session.tokenCeiling > 0 && session.ceilingKind !== 'spend' ? Math.min(1, (session.contextTokens ?? 0) / session.tokenCeiling) : 0;
    if (scope.orgId && scope.taskId) {
      const task = await this.tasks.get(scope.orgId, scope.taskId).catch(() => null);
      if (task) {
        const b = parseBrief(task.brief);
        const criteria = b.done_when.split(/\n|;|(?:^|\s)\d+[.)]\s|•/).map((x) => x.replace(/^[\s*-]+/, '').trim()).filter((x) => x.length > 3).length;
        return { briefChars: b.outcome.length + b.context.length + b.constraints.length + b.done_when.length, criteria, noProgress: task.noProgressCount, contextPressure: pressure, steps: 0 };
      }
    }
    const msgs = await this.repo.listMessages(session.id).catch(() => []);
    const last = [...msgs].reverse().find((m) => m.role === 'user');
    return { briefChars: last?.content.length ?? 0, criteria: 0, noProgress: 0, contextPressure: pressure, steps: 0 };
  }

  async suggestion(session: ChatSession): Promise<{ mode: string; reasons: string[]; score: number } | null> {
    const scope = await this.scopeOf(session);
    const t = await this.tunablesFor(scope.orgId, session.agentId!);
    return suggestMode(await this.signals(session, scope), this.splitT(t));
  }

  // ---- the plan: create, revise, review, decide ----

  /** task_plan: create or revise the plan (a new version), adopt decisions,
   *  review step results, close it. Returns the plan view or a refusal. */
  async plan(session: ChatSession, input: Record<string, unknown>): Promise<string> {
    const scope = await this.scopeOf(session);
    if (scope.role === 'worker') throw new Error('refused: a worker session works its step; the master owns the plan. Report with task_step_result.');
    const agentId = session.agentId!;
    const t = await this.tunablesFor(scope.orgId, agentId);
    let plan = scope.plan;
    const out: string[] = [];
    const hasSteps = Array.isArray(input.steps);
    const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, 600) : '';
    if (hasSteps || (input.mode !== undefined && plan) || (input.dynamic !== undefined && plan)) {
      const prev = plan ? json<TaskPlanDef | null>(plan.def, null) : null;
      const def = normalizePlan(input, prev);
      const problems = validatePlan(def, { maxSteps: t['exec.maxSteps'] });
      if (problems.length) throw new Error(`refused: the plan needs changes —\n${describeProblems(problems)}`);
      const sig = await this.signals(session, scope);
      const refusal = effortRefusal(def, sig, this.splitT(t));
      if (refusal) throw new Error(refusal);
      const rows = plan ? await this.steps(plan.id) : [];
      const byId = new Map(rows.map((r) => [r.stepId, r]));
      const keep = new Set(def.steps.map((s) => s.id));
      for (const r of rows) {
        if (keep.has(r.stepId)) continue;
        if (r.status === 'running') throw new Error(`refused: step ${r.stepId} is running in a worker; wait for its result before removing it.`);
        if (r.status === 'done') throw new Error(`refused: step ${r.stepId} is done and stays in the plan's history; keep it (or mark it skipped with review) instead of removing it.`);
      }
      for (const s of def.steps) {
        const r = byId.get(s.id);
        const before = prev?.steps.find((x) => x.id === s.id);
        if (r?.status === 'running' && before && JSON.stringify(before) !== JSON.stringify(s)) throw new Error(`refused: step ${s.id} is running in a worker; change it after its result.`);
      }
      const now = nowIso();
      const diff = diffPlan(prev, def);
      if (!plan) {
        const title = await this.titleFor(session, scope);
        const id = newId();
        await this.db.insert(taskPlans).values({ id, orgId: scope.orgId, workspaceId: session.workspaceId, agentId, taskId: scope.taskId, scopeKey: scope.scopeKey, rootSessionId: session.id, title, mode: def.mode, dynamic: def.dynamic ? 1 : 0, status: 'active', version: 1, def: JSON.stringify(def), createdAt: now, updatedAt: now }).onConflictDoNothing();
        plan = (await this.byScope(scope.scopeKey))!;
        if (plan.id === id) await this.db.insert(taskPlanSessions).values({ id: newId(), orgId: scope.orgId, planId: id, sessionId: session.id, role: 'master', depth: 0, status: 'running', model: session.model, startedAt: now });
        else return this.plan(session, input); // another call created it first: revise that one
      } else {
        await this.db.update(taskPlans).set({ def: JSON.stringify(def), mode: def.mode, dynamic: def.dynamic ? 1 : 0, version: sql`${taskPlans.version} + 1`, status: plan.status === 'blocked' ? 'active' : plan.status, idleRounds: 0, updatedAt: now }).where(eq(taskPlans.id, plan.id));
      }
      for (const r of rows) if (!keep.has(r.stepId)) await this.db.delete(taskPlanSteps).where(eq(taskPlanSteps.id, r.id));
      for (const s of def.steps) if (!byId.has(s.id)) await this.db.insert(taskPlanSteps).values({ id: newId(), orgId: plan.orgId, planId: plan.id, stepId: s.id, status: 'pending', updatedAt: now }).onConflictDoNothing();
      plan = (await this.get(plan.id))!;
      await this.entry(plan, 'version', { version: plan.version, reason: reason || (prev ? 'revised' : 'created'), diff, def }, { sessionId: session.id });
      out.push(prev ? `Plan revised to v${plan.version}: ${diff.join('; ')}.` : `Plan created (v1, ${def.mode}${def.dynamic ? ', dynamic' : ''}).`);
    }
    if (!plan) {
      const s = suggestMode(await this.signals(session, scope), this.splitT(t));
      return `No plan yet. Suggested mode: ${s.mode}${s.reasons.length ? ` (${s.reasons.join(', ')})` : ' (no sign this task needs splitting: just do it)'}. Create one with task_plan {mode, steps: [{id, title, goal, inputs, exit, dependsOn, parallel, tier}], reason}.`;
    }
    const decide = Array.isArray(input.decide) ? input.decide : typeof input.decide === 'string' ? [input.decide] : [];
    for (const d of decide.map((x) => String(x).trim().slice(0, 600)).filter(Boolean)) await this.entry(plan, 'decision', { text: d, proposed: false }, { sessionId: session.id });
    if (decide.length) out.push(`${decide.length} decision(s) recorded; every session from now on sees them.`);
    if (Array.isArray(input.review)) out.push(...await this.review(plan, input.review as Array<Record<string, unknown>>, session.id));
    if (input.status === 'done' || input.status === 'abandoned') {
      await this.db.update(taskPlans).set({ status: input.status, updatedAt: nowIso() }).where(eq(taskPlans.id, plan.id));
      await this.db.update(taskPlanSessions).set({ status: 'done', endedAt: nowIso() }).where(and(eq(taskPlanSessions.planId, plan.id), inArray(taskPlanSessions.role, ['master', 'lead']), eq(taskPlanSessions.status, 'running')));
      out.push(`Plan ${input.status}.`);
    }
    return [...out, await this.text(plan.id)].join('\n');
  }

  private async review(plan: TaskPlanRow, items: Array<Record<string, unknown>>, sessionId: string): Promise<string[]> {
    const out: string[] = [];
    const rows = new Map((await this.steps(plan.id)).map((r) => [r.stepId, r]));
    for (const it of items.slice(0, 20)) {
      const id = String(it.step ?? '').trim().toLowerCase();
      const r = rows.get(id);
      if (!r) { out.push(`review: no step "${id}"`); continue; }
      if (r.status === 'running') { out.push(`review: ${id} is still running`); continue; }
      const note = typeof it.note === 'string' ? it.note.trim().slice(0, 800) : '';
      const now = nowIso();
      if (it.verdict === 'accept') await this.db.update(taskPlanSteps).set({ status: 'done', endedAt: r.endedAt ?? now, updatedAt: now }).where(eq(taskPlanSteps.id, r.id));
      else if (it.verdict === 'skip') await this.db.update(taskPlanSteps).set({ status: 'skipped', note, endedAt: now, updatedAt: now }).where(eq(taskPlanSteps.id, r.id));
      else if (it.verdict === 'redo') await this.db.update(taskPlanSteps).set({ status: 'pending', attempts: 0, note, updatedAt: now }).where(eq(taskPlanSteps.id, r.id));
      else { out.push(`review: verdict for ${id} must be accept, redo or skip`); continue; }
      await this.entry(plan, 'event', { what: `review ${String(it.verdict)}`, note }, { stepId: id, sessionId });
      out.push(`review: ${id} ${String(it.verdict)}${note ? ` (${note.slice(0, 80)})` : ''}`);
    }
    return out;
  }

  private async titleFor(session: ChatSession, scope: { orgId: string | null; taskId: string | null }): Promise<string> {
    if (scope.orgId && scope.taskId) {
      const t = await this.tasks.get(scope.orgId, scope.taskId).catch(() => null);
      if (t) return `${taskRef(t)} ${t.title}`.slice(0, 120);
    }
    return (session.name || session.autoTitle || 'Chat request').slice(0, 120);
  }

  private async entry(plan: TaskPlanRow, kind: 'version' | 'decision' | 'handoff' | 'event', body: Record<string, unknown>, at: { stepId?: string | null; sessionId?: string | null } = {}): Promise<string> {
    const id = newId();
    await this.db.insert(taskPlanEntries).values({ id, orgId: plan.orgId, planId: plan.id, kind, stepId: at.stepId ?? null, sessionId: at.sessionId ?? null, body: JSON.stringify(body), createdAt: nowIso() });
    return id;
  }

  async decisions(planId: string): Promise<string[]> {
    return (await this.entries(planId, 'decision')).map((e) => { const b = json<{ text?: string; proposed?: boolean }>(e.body, {}); return `${b.text ?? ''}${b.proposed ? ' (proposed by a parallel step — adopt it with task_plan decide)' : ''}`; }).filter((x) => x.trim());
  }

  private defOf(plan: TaskPlanRow): TaskPlanDef { return json<TaskPlanDef>(plan.def, { mode: 'single', dynamic: false, steps: [] }); }

  private statusMap(rows: TaskPlanStepRow[]): Map<string, PlanStepStatus> {
    return new Map(rows.map((r) => [r.stepId, r.status as PlanStepStatus]));
  }

  /** The master's view of the plan as text. */
  async text(planId: string): Promise<string> {
    const plan = (await this.get(planId))!;
    const def = this.defOf(plan);
    const rows = await this.steps(plan.id);
    const byId = new Map(rows.map((r) => [r.stepId, r]));
    const t = await this.tunablesFor(plan.orgId, plan.agentId);
    const status = this.statusMap(rows);
    const lines = [planText({
      title: plan.title, version: plan.version, mode: def.mode, dynamic: def.dynamic, status: plan.status,
      steps: def.steps.map((s) => { const r = byId.get(s.id); return { step: s, status: (r?.status ?? 'pending') as PlanStepStatus, attempts: r?.attempts ?? 0, output: r?.output ?? '', usd: r?.usd ?? 0, note: r?.note ?? '', questions: json<string[]>(r?.questions, []) }; }),
      ready: plan.status === 'active' ? readySteps(def, status) : [],
      decisions: await this.decisions(plan.id),
      caps: { sessions: plan.sessions, maxSessions: t['exec.maxSessions'], usd: plan.usd, usdCap: t['exec.planUsdCap'], parallel: def.mode === 'orchestrated' ? t['exec.maxParallel'] : 1 },
    })];
    if (plan.status === 'blocked') lines.push(`Blocked: ${plan.note || 'the plan stopped'}. Revise it (task_plan steps / review redo), do the work yourself, or block the task with what it needs.`);
    else if (planComplete(def, status) && plan.status === 'active') lines.push('Every required step is done: integrate the outputs into the task\'s result, then close the plan (task_plan status: done) and finish the task as usual.');
    const interrupted = rows.filter((r) => r.status === 'interrupted').map((r) => r.stepId);
    if (interrupted.length) lines.push(`Interrupted by a restart: ${interrupted.join(', ')} — task_step_run resumes them in their own sessions.`);
    return lines.join('\n');
  }

  // ---- results and handoffs ----

  /** task_step_result: a worker reports its step, or the master records a
   *  step it did itself (single / sequential). Checked against the exit
   *  criteria: all met with evidence → done; otherwise failed with the gaps. */
  async stepResult(session: ChatSession, input: Record<string, unknown>): Promise<string> {
    const scope = await this.scopeOf(session);
    const plan = scope.plan;
    if (!plan) throw new Error('refused: there is no plan for this task — create one with task_plan first, or just finish the task.');
    const stepId = scope.role === 'worker' ? scope.stepId! : String(input.step ?? '').trim().toLowerCase();
    const def = this.defOf(plan);
    const step = def.steps.find((s) => s.id === stepId);
    if (!step) throw new Error(`refused: no step "${stepId}" — the plan has ${def.steps.map((s) => s.id).join(', ')}.`);
    const row = (await this.steps(plan.id)).find((r) => r.stepId === stepId)!;
    if (scope.role !== 'worker' && row.status === 'running' && row.sessionId !== session.id) throw new Error(`refused: step ${stepId} is running in a worker session; its result comes from there.`);
    if (scope.role === 'worker' && row.sessionId && row.sessionId !== session.id) throw new Error('refused: this step has moved to another session.');
    const { criteria, gaps } = checkExit(step.exit, input.criteria);
    const listOf = (v: unknown, n: number) => (Array.isArray(v) ? v.map((x) => String(x).trim().slice(0, 600)).filter(Boolean).slice(0, n) : typeof v === 'string' && v.trim() ? [v.trim().slice(0, 600)] : []);
    const output = typeof input.output === 'string' ? input.output.trim().slice(0, 6_000) : '';
    const done = gaps.length === 0 && Boolean(output);
    const now = nowIso();
    await this.db.update(taskPlanSteps).set({
      status: scope.role === 'worker' ? (done ? 'done' : 'failed') : (done ? 'done' : row.status === 'running' ? 'running' : 'failed'),
      output, criteria: JSON.stringify(criteria), artifacts: JSON.stringify(listOf(input.artifacts, 12)), questions: JSON.stringify(listOf(input.questions, 8)),
      sessionId: session.id, startedAt: row.startedAt ?? now, endedAt: done || scope.role === 'worker' ? now : row.endedAt, updatedAt: now,
      ...(scope.role !== 'worker' && row.attempts === 0 ? { attempts: 1 } : {}),
    }).where(eq(taskPlanSteps.id, row.id));
    for (const d of listOf(input.decisions, 8)) await this.entry(plan, 'decision', { text: d, proposed: scope.role === 'worker' && step.parallel }, { stepId, sessionId: session.id });
    if (scope.role === 'worker') await this.db.update(taskPlanSessions).set({ status: done ? 'done' : 'failed', error: done ? '' : `exit criteria not met: ${gaps.join(', ')}`.slice(0, 500) }).where(and(eq(taskPlanSessions.sessionId, session.id), eq(taskPlanSessions.planId, plan.id)));
    if (scope.role !== 'worker' && done) await this.markProgress(session);
    if (done) return `Recorded: step ${stepId} done.${scope.role === 'worker' ? ' End your turn now with one line; the master integrates.' : ''}`;
    return `Recorded as NOT done: ${!output ? 'no output; ' : ''}${gaps.length ? `criteria without "met" and evidence: ${gaps.join(', ')}` : ''}. ${scope.role === 'worker' ? 'Close the gaps and call task_step_result again, or end your turn and the master decides.' : 'Finish it, or revise the plan.'}`;
  }

  /** task_handoff: write the packet and continue in a fresh session — a
   *  worker's step continues in a new worker; a company task's next run
   *  continues in a new lead session. A chat's own session cannot hand off
   *  (the person is in it): its long work runs as steps. */
  async handoff(session: ChatSession, input: Record<string, unknown>): Promise<string> {
    const scope = await this.scopeOf(session);
    const plan = scope.plan;
    const packet = normalizeHandoff(input);
    if (!packet.state || !packet.next) throw new Error('refused: a handoff needs state (what is done, where it is) and next (the very next thing to do).');
    if (scope.role === 'master' && !scope.taskId) throw new Error('refused: this chat is the person\'s own session and cannot hand off. Run the remaining work as steps with task_step_run: each runs in a fresh session.');
    if (!plan) throw new Error('refused: create the plan first (task_plan {mode: "sequential", steps}), then hand off at a step boundary.');
    const t = await this.tunablesFor(plan.orgId, plan.agentId);
    if (plan.sessions + 1 > t['exec.maxSessions']) throw new Error(`refused: the plan has used its ${t['exec.maxSessions']} sessions (exec.maxSessions). Finish in this session, or block the task with what it needs.`);
    const sig = handoffSignature(packet);
    const prev = (await this.entries(plan.id, 'handoff')).filter((e) => (e.stepId ?? null) === (scope.role === 'worker' ? scope.stepId : null)).at(-1);
    if (prev && json<{ sig?: string }>(prev.body, {}).sig === sig) throw new Error('refused: this handoff says the same as the last one — no progress since. Change approach, or block the task (org_task_update status blocked) with what it needs.');
    if (scope.role === 'worker') {
      await this.entry(plan, 'handoff', { ...packet, sig, from: session.id, to: null }, { stepId: scope.stepId, sessionId: session.id });
      await this.db.update(taskPlanSessions).set({ status: 'handed_off', endedAt: nowIso() }).where(and(eq(taskPlanSessions.sessionId, session.id), eq(taskPlanSessions.planId, plan.id)));
      return 'Handed off: a fresh worker session continues this step from your packet. End your turn now.';
    }
    // A company task's lead: the next run continues in a fresh session linked to the task.
    const task = plan.orgId && plan.taskId ? await this.tasks.get(plan.orgId, plan.taskId).catch(() => null) : null;
    const part = (await this.sessionRows(plan.id)).filter((r) => r.role === 'lead' || r.role === 'master').length + 1;
    const org = plan.orgId ? await this.org.get(plan.orgId).catch(() => null) : null;
    const name = `Org · ${org?.name ?? 'company'} · ${(task?.title ?? plan.title).slice(0, 40)} · part ${part}`;
    const next = await this.repo.createSession({ workspaceId: session.workspaceId, agentId: session.agentId, name, kind: 'work', permissionMode: 'auto', taskKind: 'org', taskId: plan.taskId, model: session.model, autoArchiveDays: session.autoArchiveDays ?? null });
    const now = nowIso();
    await this.entry(plan, 'handoff', { ...packet, sig, from: session.id, to: next.id }, { sessionId: session.id });
    await this.db.update(taskPlanSessions).set({ status: 'handed_off', endedAt: now }).where(and(eq(taskPlanSessions.sessionId, session.id), eq(taskPlanSessions.planId, plan.id)));
    await this.db.insert(taskPlanSessions).values({ id: newId(), orgId: plan.orgId, planId: plan.id, sessionId: next.id, role: 'lead', parentSessionId: session.id, depth: 0, status: 'running', model: session.model, startedAt: now });
    await this.db.update(taskPlans).set({ leadSessionId: next.id, handoffPending: 1, sessions: sql`${taskPlans.sessions} + 1`, updatedAt: now }).where(eq(taskPlans.id, plan.id));
    await this.markProgress(session);
    return 'Handed off: the task\'s next run continues in a fresh session from your packet, the plan and the brief. End your turn now with one line.';
  }

  private async markProgress(session: ChatSession): Promise<void> {
    const ctx = this.runtime?.runningCtx(session.id);
    if (ctx) ctx.progress = true;
  }

  /** The session a company task's next owner run continues in (null = its own). */
  async leadSessionFor(taskId: string): Promise<string | null> {
    const plan = await this.forTask(taskId);
    return plan && plan.status !== 'done' && plan.status !== 'abandoned' ? plan.leadSessionId : null;
  }

  /** After a task run: a handoff written in it wakes the next run at once. */
  private async afterRun(ev: RunEndEvent): Promise<void> {
    if (ev.reviewer || ev.consulted || ev.status === 'killed' || ev.status === 'interrupted') return;
    const plan = await this.forTask(ev.taskId);
    if (!plan) return;
    await this.db.update(taskPlanSessions).set({ tokensIn: sql`${taskPlanSessions.tokensIn} + ${ev.tokensIn}`, tokensOut: sql`${taskPlanSessions.tokensOut} + ${ev.tokensOut}`, usd: sql`${taskPlanSessions.usd} + ${ev.usd}` })
      .where(and(eq(taskPlanSessions.planId, plan.id), eq(taskPlanSessions.sessionId, ev.sessionId), inArray(taskPlanSessions.role, ['master', 'lead'])));
    if (plan.handoffPending && plan.leadSessionId && plan.leadSessionId !== ev.sessionId && plan.status === 'active') {
      this.runtime?.wake({ orgId: ev.orgId, taskId: ev.taskId, agentId: ev.agentId, reason: 'rewake' });
    }
  }

  /** The packet a lead session continues from, once (cleared when read). */
  async pendingHandoffFor(plan: TaskPlanRow, sessionId: string): Promise<HandoffPacket | null> {
    const e = (await this.entries(plan.id, 'handoff')).filter((x) => json<{ to?: string }>(x.body, {}).to === sessionId).at(-1);
    if (!e) return null;
    if (plan.handoffPending && plan.leadSessionId === sessionId) await this.db.update(taskPlans).set({ handoffPending: 0 }).where(eq(taskPlans.id, plan.id));
    return normalizeHandoff(json<Record<string, unknown>>(e.body, {}));
  }

  // ---- the master runs steps in worker sessions ----

  /** task_step_run: run the named (or every ready) step in worker sessions
   *  and wait for them; parallel-safe steps side by side up to the cap. */
  async runSteps(session: ChatSession, input: Record<string, unknown>, exec?: ToolExecCtx): Promise<string> {
    if (!this.turns) throw new Error('worker sessions are not available here');
    const scope = await this.scopeOf(session);
    const plan = scope.plan;
    if (!plan) throw new Error('refused: there is no plan — create one with task_plan {mode: "orchestrated" | "sequential", steps}.');
    if (plan.status !== 'active') throw new Error(`refused: the plan is ${plan.status}${plan.note ? ` (${plan.note})` : ''}. Revise it with task_plan to go on.`);
    const def = this.defOf(plan);
    if (def.mode === 'single') throw new Error('refused: a single-session plan runs here, in this session — do the steps yourself and record each with task_step_result, or switch the plan to sequential or orchestrated with task_plan.');
    const t = await this.tunablesFor(plan.orgId, plan.agentId);
    if (scope.depth + 1 > t['exec.maxDepth']) throw new Error(`refused: worker sessions may not start further workers here (exec.maxDepth ${t['exec.maxDepth']}). Do the work in this session and report with task_step_result.`);
    if (isDraining()) throw new Error('the server is restarting — run the steps again in a moment');
    const rows = await this.steps(plan.id);
    const status = this.statusMap(rows);
    const ready = readySteps(def, status);
    const asked = Array.isArray(input.steps) ? input.steps.map((x) => String(x).trim().toLowerCase()).filter(Boolean) : [];
    if (def.dynamic && asked.length === 0) throw new Error(`refused: in a dynamic plan you choose the next step(s): task_step_run {steps: [...]}. Available now: ${ready.join(', ') || 'none'}.`);
    const notes: string[] = [];
    const wanted = (asked.length ? asked : ready).filter((id) => {
      if (!def.steps.some((s) => s.id === id)) { notes.push(`${id}: no such step`); return false; }
      if (!ready.includes(id)) { const s = def.steps.find((x) => x.id === id)!; notes.push(`${id}: ${status.get(id) === 'done' ? 'already done' : status.get(id) === 'running' ? 'already running' : `waiting on ${s.dependsOn.filter((d) => status.get(d) !== 'done' && status.get(d) !== 'skipped').join(', ') || 'nothing'}`}`); return false; }
      return true;
    });
    if (wanted.length === 0) return [notes.length ? `Nothing to run: ${notes.join('; ')}.` : 'Nothing to run.', await this.text(plan.id)].join('\n');
    // Claim each step (one conditional update; attempts count claims of a fresh or failed step).
    const claimed: PlanStep[] = [];
    for (const id of wanted) {
      const r = rows.find((x) => x.stepId === id)!;
      if (r.status === 'failed' && r.attempts >= t['exec.stepAttempts']) { notes.push(`${id}: failed ${r.attempts} time(s) (exec.stepAttempts) — revise it (task_plan review redo with a note, or new steps) or do it yourself`); continue; }
      const resume = r.status === 'interrupted';
      const won = await this.db.update(taskPlanSteps).set({ status: 'running', ...(resume ? {} : { attempts: sql`${taskPlanSteps.attempts} + 1` }), startedAt: nowIso(), endedAt: null, updatedAt: nowIso() })
        .where(and(eq(taskPlanSteps.id, r.id), inArray(taskPlanSteps.status, ['pending', 'failed', 'interrupted']))).returning({ id: taskPlanSteps.id });
      if (won.length) claimed.push(def.steps.find((s) => s.id === id)!);
      else notes.push(`${id}: claimed by another run`);
    }
    const parallelCap = def.mode === 'orchestrated' ? Math.max(1, t['exec.maxParallel']) : 1;
    const par = claimed.filter((s) => s.parallel);
    const seq = claimed.filter((s) => !s.parallel);
    const results: WorkerOutcome[] = [];
    const stops = new Set<string>();
    const onAbort = () => { for (const id of stops) this.turns?.stop(id); };
    exec?.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const queue = [...par];
      const lane = async () => { for (let s = queue.shift(); s; s = queue.shift()) results.push(await this.runWorker(plan.id, s, session, scope.depth + 1, t, stops, exec)); };
      await Promise.all(Array.from({ length: Math.min(parallelCap, par.length) }, lane));
      for (const s of seq) { if (exec?.signal?.aborted) break; results.push(await this.runWorker(plan.id, s, session, scope.depth + 1, t, stops, exec)); }
    } finally {
      exec?.signal?.removeEventListener('abort', onAbort);
    }
    // A step left claimed because the master stopped is pending again.
    for (const s of claimed) if (!results.some((r) => r.stepId === s.id)) await this.db.update(taskPlanSteps).set({ status: 'pending', updatedAt: nowIso() }).where(and(eq(taskPlanSteps.planId, plan.id), eq(taskPlanSteps.stepId, s.id), eq(taskPlanSteps.status, 'running')));
    // The no-progress breaker across sessions.
    const finished = results.filter((r) => r.status === 'done').length;
    const allInterrupted = results.length > 0 && results.every((r) => r.status === 'interrupted');
    const idle = finished > 0 ? 0 : allInterrupted ? plan.idleRounds : plan.idleRounds + 1;
    const blocked = idle >= t['exec.idleRounds'];
    await this.db.update(taskPlans).set({ idleRounds: idle, ...(blocked ? { status: 'blocked', note: `${idle} step round(s) in a row finished no step` } : {}), updatedAt: nowIso() }).where(eq(taskPlans.id, plan.id));
    if (finished > 0) await this.markProgress(session);
    const report = results.map((r) => `- ${r.stepId}: ${r.status.toUpperCase()}${r.gaps.length ? ` (not met: ${r.gaps.join(', ')})` : ''}${r.error ? ` — ${r.error}` : ''} · ${r.sessions.length} session(s) · ${r.tokens} tok · $${r.usd.toFixed(4)}\n  ${r.output.replace(/\s+/g, ' ').slice(0, 1_200) || '(no output)'}`);
    return [
      `Ran ${results.length} step(s)${par.length > 1 ? ` (${Math.min(parallelCap, par.length)} in parallel)` : ''}:`,
      ...report,
      notes.length ? `Not run: ${notes.join('; ')}.` : '',
      'Verify each output against its exit criteria before you build on it: accept, or task_plan review redo with a note.',
      blocked ? `The plan is BLOCKED: ${idle} round(s) finished no step (exec.idleRounds). Revise the plan, do the work yourself, or block the task with what it needs.` : '',
      await this.text(plan.id),
    ].filter(Boolean).join('\n');
  }

  /** One step in a worker session (and its continuations after a handoff). */
  private async runWorker(planId: string, step: PlanStep, parent: ChatSession, depth: number, t: ExecTunables, stops: Set<string>, exec?: ToolExecCtx): Promise<WorkerOutcome> {
    const outcome: WorkerOutcome = { stepId: step.id, status: 'failed', output: '', gaps: [], sessions: [], usd: 0, tokens: 0, error: '' };
    const agent = await this.agents.get(parent.agentId!);
    const setStep = (patch: Partial<TaskPlanStepRow>) => this.db.update(taskPlanSteps).set({ ...patch, updatedAt: nowIso() }).where(and(eq(taskPlanSteps.planId, planId), eq(taskPlanSteps.stepId, step.id)));
    for (let hop = 0; hop < t['exec.maxSessions']; hop++) {
      const plan = (await this.get(planId))!;
      const row = (await this.steps(planId)).find((r) => r.stepId === step.id)!;
      // Caps before every session.
      const capHit = plan.sessions + 1 > t['exec.maxSessions'] ? `the plan has used its ${t['exec.maxSessions']} sessions (exec.maxSessions)`
        : t['exec.planUsdCap'] > 0 && plan.usd >= t['exec.planUsdCap'] ? `the plan's workers have spent $${plan.usd.toFixed(2)} of $${t['exec.planUsdCap']} (exec.planUsdCap)`
          : plan.tokensIn + plan.tokensOut >= t['exec.planTokenCap'] ? `the plan has used ${plan.tokensIn + plan.tokensOut} of ${t['exec.planTokenCap']} tokens (exec.planTokenCap)` : '';
      if (capHit) { outcome.error = `stopped: ${capHit}`; await setStep({ status: 'failed', endedAt: nowIso() }); break; }
      // Resume an interrupted worker in its own session; otherwise a fresh one.
      const prevRow = row.sessionId ? await this.sessionRow(row.sessionId) : null;
      const resume = hop === 0 && prevRow?.role === 'worker' && prevRow.status === 'interrupted' ? prevRow : null;
      const handoff = (await this.entries(planId, 'handoff')).filter((e) => e.stepId === step.id && !json<{ to?: string | null }>(e.body, {}).to && e.sessionId === row.sessionId).at(-1) ?? null;
      const model = resolveStepModel(step.tier, { provider: agent.provider, baseModel: agent.model || parent.model, pinned: agent.model || undefined, routing: plan.orgId ? (await this.org.get(plan.orgId).catch(() => null))?.routing : null, type: step.tier ? await this.agents.typeOf(agent).catch(() => null) : null });
      const now = nowIso();
      let sessionId: string;
      if (resume) {
        sessionId = resume.sessionId;
        await this.db.update(taskPlanSessions).set({ status: 'running', endedAt: null }).where(eq(taskPlanSessions.id, resume.id));
      } else {
        const ws = await this.repo.createSession({ workspaceId: parent.workspaceId, agentId: parent.agentId, name: `Worker · ${plan.title.slice(0, 40)} · ${step.id}`, kind: 'work', permissionMode: 'auto', model: model || parent.model, tags: '["worker"]', autoArchiveDays: 1 });
        sessionId = ws.id;
        await this.db.insert(taskPlanSessions).values({ id: newId(), orgId: plan.orgId, planId, sessionId, role: 'worker', stepId: step.id, parentSessionId: parent.id, depth, status: 'running', model: model || parent.model, startedAt: now });
        await this.db.update(taskPlans).set({ sessions: sql`${taskPlans.sessions} + 1`, updatedAt: now }).where(eq(taskPlans.id, planId));
        if (handoff) await this.db.update(taskPlanEntries).set({ body: JSON.stringify({ ...json<Record<string, unknown>>(handoff.body, {}), to: sessionId }) }).where(eq(taskPlanEntries.id, handoff.id));
      }
      await setStep({ sessionId, model: model || parent.model });
      outcome.sessions.push(sessionId);
      exec?.progress?.(`${step.id}: ${resume ? 'resuming' : handoff ? 'continuing after a handoff' : 'running'} in a worker session`);
      // A company task: budget before the call, the task's run context during it.
      const task = plan.orgId && plan.taskId ? await this.tasks.get(plan.orgId, plan.taskId).catch(() => null) : null;
      const estimate = task && this.runtime ? await this.runtime.estimateUsd(model || parent.model) : 0;
      if (task && this.runtime) {
        const r = await this.runtime.reserve(plan.orgId!, { agentId: agent.id, projectId: task.projectId }, estimate);
        if (!r.ok) { outcome.error = `budget stop: the ${r.scope} envelope is exhausted`; await this.closeWorker(planId, sessionId, 'failed', outcome.error); await setStep({ status: 'failed', endedAt: nowIso() }); break; }
      }
      const lead = this.runtime?.runningCtx(parent.id);
      const ctx: RunCtx | null = task && this.runtime ? { orgId: plan.orgId!, taskId: plan.taskId!, agentId: agent.id, runId: lead?.runId ?? '', sessionId, isChief: lead?.isChief ?? false, reviewer: false, progress: false, calls: new Map(), loopDetected: false } : null;
      if (ctx) this.runtime!.beginAuxRun(ctx);
      this.live.set(sessionId, { planId, stepId: step.id });
      stops.add(sessionId);
      const prompt = resume
        ? `The server restarted while you were working step ${step.id} "${step.title}". Your earlier work in this session is above: continue from where you stopped, then call task_step_result.`
        : handoff ? `Continue step ${step.id} "${step.title}" from the handoff packet in your context, then call task_step_result.`
          : `Work step ${step.id} "${step.title}" of the task — your step card is in your context. Do only this step, then call task_step_result.`;
      let tokensIn = 0; let tokensOut = 0; let error = ''; let interrupted = false; let answer = '';
      try {
        for await (const ev of this.turns!.run(sessionId, { text: prompt, origin: 'loop' })) {
          if (ev.type === 'usage') { tokensIn += ev.inputTokens; tokensOut += ev.outputTokens; }
          if (ev.type === 'answer') answer += ev.text;
          if (ev.type === 'interrupted') interrupted = true;
          if (ev.type === 'error') error = ev.message;
        }
      } catch (err) {
        if (isDraining()) interrupted = true;
        else error = err instanceof Error ? err.message : String(err);
      } finally {
        if (ctx) this.runtime!.endAuxRun(sessionId);
        this.live.delete(sessionId);
        stops.delete(sessionId);
      }
      const usd = usdFor(model || parent.model, tokensIn, tokensOut) ?? (tokensIn * FALLBACK_PRICE.input + tokensOut * FALLBACK_PRICE.output) / 1_000_000;
      if (task && this.runtime) await this.runtime.settle(plan.orgId!, { agentId: agent.id, projectId: task.projectId }, estimate, usd, 'task');
      outcome.usd += usd; outcome.tokens += tokensIn + tokensOut;
      await this.db.update(taskPlanSessions).set({ tokensIn: sql`${taskPlanSessions.tokensIn} + ${tokensIn}`, tokensOut: sql`${taskPlanSessions.tokensOut} + ${tokensOut}`, usd: sql`${taskPlanSessions.usd} + ${usd}` }).where(and(eq(taskPlanSessions.planId, planId), eq(taskPlanSessions.sessionId, sessionId)));
      await this.db.update(taskPlanSteps).set({ tokensIn: sql`${taskPlanSteps.tokensIn} + ${tokensIn}`, tokensOut: sql`${taskPlanSteps.tokensOut} + ${tokensOut}`, usd: sql`${taskPlanSteps.usd} + ${usd}` }).where(and(eq(taskPlanSteps.planId, planId), eq(taskPlanSteps.stepId, step.id)));
      await this.db.update(taskPlans).set({ tokensIn: sql`${taskPlans.tokensIn} + ${tokensIn}`, tokensOut: sql`${taskPlans.tokensOut} + ${tokensOut}`, usd: sql`${taskPlans.usd} + ${usd}`, updatedAt: nowIso() }).where(eq(taskPlans.id, planId));
      const after = (await this.steps(planId)).find((r) => r.stepId === step.id)!;
      const sRow = await this.sessionRow(sessionId);
      outcome.output = after.output;
      if (interrupted) {
        outcome.status = 'interrupted';
        await this.closeWorker(planId, sessionId, 'interrupted', 'interrupted by a restart');
        await setStep({ status: 'interrupted' });
        break;
      }
      if (after.status === 'done') { outcome.status = 'done'; await this.closeWorker(planId, sessionId, 'done', ''); break; }
      if (sRow?.status === 'handed_off') continue; // a fresh worker continues from the packet
      if (ctx?.loopDetected) error = error || 'loop detected: the same tool call repeated';
      outcome.status = 'failed';
      outcome.gaps = checkExit(step.exit, json(after.criteria, [])).gaps;
      outcome.error = error || (after.status === 'failed' ? 'the exit criteria are not met' : `the worker ended without task_step_result${answer ? `: "${answer.replace(/\s+/g, ' ').slice(0, 200)}"` : ''}`);
      await this.closeWorker(planId, sessionId, 'failed', outcome.error);
      await setStep({ status: 'failed', endedAt: nowIso() });
      break;
    }
    return outcome;
  }

  private async closeWorker(planId: string, sessionId: string, status: string, error: string): Promise<void> {
    await this.db.update(taskPlanSessions).set({ status, error: error.slice(0, 500), endedAt: nowIso() }).where(and(eq(taskPlanSessions.planId, planId), eq(taskPlanSessions.sessionId, sessionId), inArray(taskPlanSessions.status, ['running', 'done', 'failed'])));
  }

  /** Whether a call is refused in this session (a worker owns only its step). */
  async refusal(session: ChatSession, name: string, input: Record<string, unknown>): Promise<string | null> {
    if (!WORKER_REFUSED.has(name) && !(name === 'org_task_update' && input.status !== undefined)) return null;
    const row = this.live.has(session.id) ? { role: 'worker' } : await this.sessionRow(session.id);
    if (row?.role !== 'worker') return null;
    return `Refused in a worker session: ${name} belongs to the master, which owns the task's status, assignment, review and plan. Report what you found or did with task_step_result; the master integrates it.`;
  }

  /** The worker's whole briefing (its context), or null for another session. */
  async workerCard(session: ChatSession): Promise<string | null> {
    const row = await this.sessionRow(session.id);
    if (!row || row.role !== 'worker' || !row.stepId) return null;
    const plan = await this.get(row.planId);
    if (!plan) return null;
    const def = this.defOf(plan);
    const step = def.steps.find((s) => s.id === row.stepId);
    if (!step) return null;
    const rows = new Map((await this.steps(plan.id)).map((r) => [r.stepId, r]));
    const inputs = step.dependsOn.map((d) => ({ from: d, title: def.steps.find((s) => s.id === d)?.title ?? d, output: rows.get(d)?.output ?? '' })).filter((x) => x.output);
    const handoff = (await this.entries(plan.id, 'handoff')).filter((e) => e.stepId === step.id && json<{ to?: string }>(e.body, {}).to === session.id).at(-1);
    const t = await this.tunablesFor(plan.orgId, plan.agentId);
    const agent = await this.agents.get(plan.agentId).catch(() => null);
    return stepCardText({ taskTitle: plan.title, agentName: agent?.name ?? 'the agent', step, inputs, decisions: await this.decisions(plan.id), note: rows.get(step.id)?.note ?? '', handoff: handoff ? normalizeHandoff(json(handoff.body, {})) : null, depth: row.depth, canSpawn: row.depth < t['exec.maxDepth'] });
  }

  /** The plan section of the master's (or a lead's) context. */
  async masterContext(session: ChatSession): Promise<string | null> {
    const scope = await this.scopeOf(session);
    const t = await this.tunablesFor(scope.orgId, session.agentId!);
    const pressure = session.tokenCeiling > 0 && session.ceilingKind !== 'spend' ? (session.contextTokens ?? 0) / session.tokenCeiling : 0;
    const plan = scope.plan;
    if (!plan || plan.status === 'done' || plan.status === 'abandoned') {
      if (!scope.taskId && pressure < t['exec.handoffAt']) return null;
      const s = suggestMode(await this.signals(session, scope), this.splitT(t));
      if (s.mode === 'single') return null;
      return `Task execution: this ${scope.taskId ? 'task' : 'request'} shows signs of size (${s.reasons.join(', ')}). If one session cannot do it reliably, split it with task_plan (suggested: ${s.mode}); otherwise just do it.`;
    }
    const lines = ['# Task plan', await this.text(plan.id)];
    if (scope.role !== 'worker' && plan.leadSessionId === session.id) {
      const packet = await this.pendingHandoffFor(plan, session.id);
      if (packet) lines.push(`You continue this task in a fresh session. The previous session's handoff packet (trust it over your assumptions; re-check only what it marks open):\n${describeHandoff(packet)}`);
    }
    if (pressure >= t['exec.handoffAt']) {
      lines.push(scope.taskId
        ? `Your context is ${Math.round(pressure * 100)}% full: finish the current step, then task_handoff {state, decisions, artifacts, questions, next} and end the turn — a fresh session continues from it.`
        : `Your context is ${Math.round(pressure * 100)}% full: run the remaining work as steps (task_step_run), each in a fresh session.`);
    }
    return lines.join('\n');
  }

  // ---- restarts ----

  /** Boot: what a dead process left running is interrupted (re-run or resumed by the master). */
  async releaseInterrupted(): Promise<{ sessions: number; steps: number }> {
    // Workers only: the master and lead sessions run again by their own trigger.
    const s = await this.db.update(taskPlanSessions).set({ status: 'interrupted', endedAt: nowIso(), error: 'interrupted by a restart' }).where(and(eq(taskPlanSessions.status, 'running'), eq(taskPlanSessions.role, 'worker'))).returning({ id: taskPlanSessions.id });
    const st = await this.db.update(taskPlanSteps).set({ status: 'interrupted', updatedAt: nowIso() }).where(eq(taskPlanSteps.status, 'running')).returning({ id: taskPlanSteps.id });
    if (s.length || st.length) this.logger.log(`task plans: ${st.length} step(s) and ${s.length} session(s) interrupted by the restart`);
    return { sessions: s.length, steps: st.length };
  }

  // ---- the view (the task drawer, the Work log) ----

  async view(plan: TaskPlanRow): Promise<PlanView> {
    const def = this.defOf(plan);
    const rows = await this.steps(plan.id);
    const byId = new Map(rows.map((r) => [r.stepId, r]));
    const ready = new Set(plan.status === 'active' ? readySteps(def, this.statusMap(rows)) : []);
    const t = await this.tunablesFor(plan.orgId, plan.agentId);
    const entries = await this.entries(plan.id);
    return {
      plan: { id: plan.id, title: plan.title, mode: def.mode, dynamic: def.dynamic, status: plan.status, version: plan.version, sessions: plan.sessions, usd: plan.usd, tokensIn: plan.tokensIn, tokensOut: plan.tokensOut, taskId: plan.taskId, orgId: plan.orgId, rootSessionId: plan.rootSessionId, leadSessionId: plan.leadSessionId, note: plan.note, caps: { maxSessions: t['exec.maxSessions'], maxParallel: t['exec.maxParallel'], maxDepth: t['exec.maxDepth'], planUsdCap: t['exec.planUsdCap'], planTokenCap: t['exec.planTokenCap'] }, createdAt: plan.createdAt, updatedAt: plan.updatedAt },
      steps: def.steps.map((s) => {
        const r = byId.get(s.id);
        return { ...s, status: r?.status ?? 'pending', attempts: r?.attempts ?? 0, sessionId: r?.sessionId ?? null, output: r?.output ?? '', criteria: json(r?.criteria, []), questions: json(r?.questions, []), artifacts: json(r?.artifacts, []), note: r?.note ?? '', model: r?.model ?? '', tokensIn: r?.tokensIn ?? 0, tokensOut: r?.tokensOut ?? 0, usd: r?.usd ?? 0, startedAt: r?.startedAt ?? null, endedAt: r?.endedAt ?? null, ready: ready.has(s.id) };
      }),
      sessions: (await this.sessionRows(plan.id)).map((r) => ({ sessionId: r.sessionId, role: r.role, stepId: r.stepId, parentSessionId: r.parentSessionId, depth: r.depth, status: r.status, model: r.model, tokensIn: r.tokensIn, tokensOut: r.tokensOut, usd: r.usd, error: r.error, startedAt: r.startedAt, endedAt: r.endedAt })),
      decisions: entries.filter((e) => e.kind === 'decision').map((e) => { const b = json<{ text?: string; proposed?: boolean }>(e.body, {}); return { text: b.text ?? '', stepId: e.stepId, sessionId: e.sessionId, proposed: Boolean(b.proposed), createdAt: e.createdAt }; }),
      handoffs: entries.filter((e) => e.kind === 'handoff').map((e) => { const b = json<Record<string, unknown>>(e.body, {}); return { ...normalizeHandoff(b), stepId: e.stepId, fromSessionId: e.sessionId, toSessionId: typeof b.to === 'string' ? b.to : null, createdAt: e.createdAt }; }),
      versions: entries.filter((e) => e.kind === 'version').map((e) => { const b = json<{ version?: number; reason?: string; diff?: string[] }>(e.body, {}); return { version: b.version ?? 0, reason: b.reason ?? '', diff: b.diff ?? [], createdAt: e.createdAt }; }),
    };
  }

  /** The plan a session takes part in (as master, lead or worker), for the UI. */
  async forSession(sessionId: string): Promise<TaskPlanRow | null> {
    const row = await this.sessionRow(sessionId);
    if (row) return this.get(row.planId);
    const own = await this.byScope(`chat:${sessionId}`);
    if (own) return own;
    const s = await this.repo.getSession(sessionId).catch(() => null);
    return s?.taskKind === 'org' && s.taskId ? this.forTask(s.taskId) : null;
  }
}
