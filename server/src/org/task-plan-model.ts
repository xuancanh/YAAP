/**
 * Task plans, the pure half (docs/task-execution.md): a task's own mini
 * workflow — the steps the performing agent splits one task into, with
 * dependencies, and how they run.
 *
 * A plan is a process definition with one stage (process-model.ts): its
 * steps are nodes, `dependsOn` are edges (a strict plan) or `availableWhen.after`
 * (a dynamic plan, where the master chooses among available steps and may add
 * steps as it goes). Validation, the readiness walk and dynamic availability
 * are the process engine's own (`validateProcess`, `strictWalk`,
 * `dynamicAvailable`); a cycle is the engine's "closes a loop without
 * loopMax", reworded — a plan never loops, a step is redone by the master.
 * What a plan adds per step: the inputs it needs, its exit criteria (what
 * the master verifies), whether it is parallel-safe (reads and research) or
 * must run alone (writes and decisions), an effort size and a model tier.
 *
 * Also here, model-free: the signals that say a task is big enough to split
 * and the mode they suggest (effort scaling: a simple task does not fan
 * out), the check of a step's result against its exit criteria, the
 * handoff packet's signature (a second identical handoff is no progress),
 * and the text of the master's plan view and the worker's step card.
 */
import { createHash } from 'node:crypto';
import { dynamicAvailable, strictWalk, validateProcess, type ProcessDef, type ProcessProblem, type StepState } from './process-model';
import { MODEL_TIERS, type ModelTier } from './org-routing';

export const EXEC_MODES = ['single', 'sequential', 'orchestrated'] as const;
export type ExecMode = typeof EXEC_MODES[number];
export const STEP_STATUSES = ['pending', 'running', 'done', 'failed', 'skipped', 'interrupted'] as const;
export type PlanStepStatus = typeof STEP_STATUSES[number];
export const EFFORTS = ['small', 'medium', 'large'] as const;
export type Effort = typeof EFFORTS[number];

/** A plan for a small task is held to this many steps (effort scaling). */
export const SMALL_TASK_STEPS = 3;
const STEP_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;

export interface PlanStep {
  id: string;
  title: string;
  /** What the step must achieve, in a sentence or two. */
  goal: string;
  /** What it needs: earlier steps' outputs come automatically; name files, facts, decisions. */
  inputs: string[];
  /** Exit criteria: each is checked off with evidence in task_step_result. */
  exit: string[];
  dependsOn: string[];
  /** Read/research work that may run beside other parallel steps; false = writes or decisions, run alone. */
  parallel: boolean;
  tier?: ModelTier;
  effort?: Effort;
  /** A step the task can finish without. */
  optional?: boolean;
}

export interface TaskPlanDef { mode: ExecMode; dynamic: boolean; steps: PlanStep[] }

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const list = (v: unknown, max: number, each = 400): string[] => (Array.isArray(v) ? v.map((x) => str(x, each)).filter(Boolean).slice(0, max) : typeof v === 'string' && v.trim() ? [str(v, each)] : []);

/** Coerce an agent's plan JSON into shape; `validatePlan` says what is wrong. */
export function normalizePlan(raw: unknown, prev?: TaskPlanDef | null): TaskPlanDef {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const mode = (EXEC_MODES as readonly string[]).includes(String(o.mode)) ? o.mode as ExecMode : prev?.mode ?? 'single';
  const dynamic = o.dynamic === undefined ? prev?.dynamic ?? false : o.dynamic === true;
  const rawSteps = Array.isArray(o.steps) ? o.steps : null;
  const steps: PlanStep[] = rawSteps ? rawSteps.slice(0, 40).map((x, i) => {
    const r = (x ?? {}) as Record<string, unknown>;
    const id = str(r.id, 32).toLowerCase() || `s${i + 1}`;
    const step: PlanStep = {
      id, title: str(r.title, 120), goal: str(r.goal, 1_500) || str(r.title, 120),
      inputs: list(r.inputs, 10), exit: list(r.exit ?? r.exitCriteria ?? r.doneWhen, 8), dependsOn: list(r.dependsOn ?? r.after, 12, 32).map((d) => d.toLowerCase()),
      parallel: r.parallel === true || r.parallelSafe === true,
    };
    if ((MODEL_TIERS as readonly string[]).includes(String(r.tier))) step.tier = r.tier as ModelTier;
    if ((EFFORTS as readonly string[]).includes(String(r.effort))) step.effort = r.effort as Effort;
    if (r.optional === true) step.optional = true;
    return step;
  }) : prev?.steps ?? [];
  return { mode, dynamic, steps };
}

/** The plan as a one-stage process definition (the engine's model). */
export function toProcessDef(def: TaskPlanDef): ProcessDef {
  const dyn = def.dynamic;
  return {
    title: 'Task plan', category: 'delivery', triggers: [{ kind: 'manual' }],
    stages: [{ id: 'main', title: 'Main', mode: dyn ? 'dynamic' : 'strict' }],
    nodes: def.steps.map((s) => ({ id: s.id, title: s.title, kind: 'task' as const, stage: 'main', outcome: s.goal, doneWhen: s.exit.join('; '), ...(s.optional ? {} : { required: true }), ...(dyn && s.dependsOn.length ? { availableWhen: { after: s.dependsOn } } : {}) })),
    edges: dyn ? [] : def.steps.flatMap((s) => s.dependsOn.map((d) => ({ from: d, to: s.id }))),
  };
}

/** Every problem with a plan, with what to do about it; empty = valid. Pure. */
export function validatePlan(def: TaskPlanDef, caps: { maxSteps: number }): ProcessProblem[] {
  const out: ProcessProblem[] = [];
  const add = (where: string, problem: string, fix: string) => out.push({ where, problem, fix });
  if (def.steps.length === 0) { add('steps', 'the plan has no steps', 'list the steps: id, title, goal, exit criteria, dependsOn, parallel'); return out; }
  if (def.steps.length > caps.maxSteps) add('steps', `${def.steps.length} steps (at most ${caps.maxSteps} here)`, 'merge steps: each step is work one session does reliably, not a single action');
  const ids = new Set(def.steps.map((s) => s.id));
  for (const s of def.steps) {
    const w = `step ${s.id}`;
    if (!STEP_ID_RE.test(s.id)) add(w, 'the step id is not a short lowercase id', 'use ids like "research" or "s2"');
    if (!s.title) add(w, 'the step has no title', 'name what the step does in a few words');
    if (s.exit.length === 0) add(w, 'the step has no exit criteria', 'say how the master will know the step is done (exit: ["…"])');
    for (const d of s.dependsOn) if (!ids.has(d)) add(w, `dependsOn names "${d}", which is not a step`, `use step ids: ${[...ids].slice(0, 12).join(', ')}`);
    if (s.dependsOn.includes(s.id)) add(w, 'a step cannot depend on itself', 'remove it from dependsOn');
  }
  if (def.mode === 'orchestrated' && def.steps.length < 2) add('mode', 'orchestrated with one step', 'one step is a single session: use mode single');
  // The engine's own checks (ids, stages, availability); a loop is a dependency cycle here.
  for (const p of validateProcess(toProcessDef(def), { loopMaxCeiling: 1 })) {
    if (/closes a loop without loopMax/.test(p.problem)) add(p.where.replace(/^edge /, 'dependsOn '), 'the dependencies form a cycle', 'a plan never loops: drop one dependency (the master redoes a step with task_plan review redo)');
    else if (/no step starts the stage/.test(p.problem)) add('steps', 'every step depends on another (a cycle)', 'leave at least one step without dependsOn');
    else if (/does not exist|wait on itself|share an id|not a short lowercase id/.test(p.problem) && !out.some((x) => x.where === p.where)) add(p.where, p.problem, p.fix);
  }
  if (cycleOf(def)) add('dependsOn', `the dependencies form a cycle (${cycleOf(def)!.join(' → ')})`, 'drop one dependency so every chain has a first step');
  return out.filter((p, i, a) => a.findIndex((x) => x.where === p.where && x.problem === p.problem) === i);
}

/** A dependency cycle as step ids, or null. Pure. */
export function cycleOf(def: TaskPlanDef): string[] | null {
  const deps = new Map(def.steps.map((s) => [s.id, s.dependsOn]));
  const state = new Map<string, 1 | 2>();
  const path: string[] = [];
  const visit = (id: string): string[] | null => {
    if (state.get(id) === 2) return null;
    if (state.get(id) === 1) return [...path.slice(path.indexOf(id)), id];
    state.set(id, 1); path.push(id);
    for (const d of deps.get(id) ?? []) { if (!deps.has(d)) continue; const c = visit(d); if (c) return c; }
    path.pop(); state.set(id, 2);
    return null;
  };
  for (const s of def.steps) { const c = visit(s.id); if (c) return c; }
  return null;
}

/** Steps that may start now (dependencies done or skipped; not running or
 *  done), in plan order — the engine's walk for a strict plan, its dynamic
 *  availability for a dynamic one. Pure. */
export function readySteps(def: TaskPlanDef, status: Map<string, PlanStepStatus>): string[] {
  const proc = toProcessDef(def);
  const current = new Map<string, StepState>();
  for (const [id, st] of status) {
    if (st === 'done' || st === 'skipped') current.set(id, 'done');
    else if (st === 'running') current.set(id, 'active');
  }
  const open = (id: string) => !['done', 'skipped', 'running'].includes(status.get(id) ?? 'pending');
  if (def.dynamic) return dynamicAvailable(proc, 'main', current, {}).map((n) => n.id).filter(open);
  const strictCurrent = new Map([...current].filter(([, v]) => v === 'done' || v === 'active'));
  // A failed or interrupted step has no "current" row for the walk: it is ready again when its inputs are.
  return strictWalk(proc, 'main', strictCurrent, {}).ready.filter(open);
}

/** Whether every required step is done (optional ones may be skipped or left). */
export function planComplete(def: TaskPlanDef, status: Map<string, PlanStepStatus>): boolean {
  return def.steps.every((s) => s.optional || status.get(s.id) === 'done' || status.get(s.id) === 'skipped');
}

/** What changed between two versions, one line per change. Pure. */
export function diffPlan(prev: TaskPlanDef | null, next: TaskPlanDef): string[] {
  if (!prev) return [`created: ${next.mode}${next.dynamic ? ' (dynamic)' : ''}, ${next.steps.length} step(s)`];
  const out: string[] = [];
  if (prev.mode !== next.mode) out.push(`mode ${prev.mode} → ${next.mode}`);
  if (prev.dynamic !== next.dynamic) out.push(next.dynamic ? 'now dynamic' : 'now strict');
  const before = new Map(prev.steps.map((s) => [s.id, s]));
  const after = new Map(next.steps.map((s) => [s.id, s]));
  for (const s of next.steps) {
    const b = before.get(s.id);
    if (!b) { out.push(`+ step ${s.id} "${s.title}"`); continue; }
    const changed = (['title', 'goal', 'inputs', 'exit', 'dependsOn', 'parallel', 'tier', 'effort', 'optional'] as const).filter((k) => JSON.stringify(b[k] ?? null) !== JSON.stringify(s[k] ?? null));
    if (changed.length) out.push(`~ step ${s.id}: ${changed.join(', ')}`);
  }
  for (const s of prev.steps) if (!after.has(s.id)) out.push(`- step ${s.id} "${s.title}"`);
  return out.length ? out : ['no change to the steps'];
}

// ---- effort scaling ----

/** What the runtime knows about a task before anything is split. */
export interface SplitSignals {
  /** Length of the brief (a company task) or of the request (a chat). */
  briefChars: number;
  /** Done-when criteria in the brief. */
  criteria: number;
  /** Earlier runs of the task that changed nothing. */
  noProgress: number;
  /** contextTokens / ceiling of the session working it (0–1). */
  contextPressure: number;
  /** Steps of the proposed plan (0 when none yet). */
  steps: number;
}

export interface SplitTunables { splitBriefChars: number; splitCriteria: number; splitSteps: number; handoffAt: number; orchestrateMinSignals: number }

/** The signals a task shows, in words, and the mode they suggest. Pure.
 *  Orchestration (parallel workers, ~15x the tokens of one chat) needs
 *  `orchestrateMinSignals` of them; a context near its ceiling or earlier
 *  runs without progress suggest a fresh session (sequential); otherwise
 *  one session. */
export function suggestMode(sig: SplitSignals, t: SplitTunables): { mode: ExecMode; score: number; reasons: string[] } {
  const reasons: string[] = [];
  if (sig.briefChars >= t.splitBriefChars) reasons.push(`a long brief (${sig.briefChars} chars)`);
  if (sig.criteria >= t.splitCriteria) reasons.push(`${sig.criteria} done-when criteria`);
  if (sig.noProgress >= 1) reasons.push(`${sig.noProgress} earlier run(s) without progress`);
  if (sig.contextPressure >= t.handoffAt) reasons.push(`the context is ${Math.round(sig.contextPressure * 100)}% full`);
  if (sig.steps >= t.splitSteps) reasons.push(`${sig.steps} steps`);
  const score = reasons.length;
  const mode: ExecMode = score >= t.orchestrateMinSignals && sig.steps !== 1 ? 'orchestrated' : sig.contextPressure >= t.handoffAt || sig.noProgress >= 1 || score >= 1 ? 'sequential' : 'single';
  return { mode, score, reasons };
}

/** Refuse a plan the task's size does not justify (null = fine). Pure. */
export function effortRefusal(def: TaskPlanDef, sig: SplitSignals, t: SplitTunables): string | null {
  const s = suggestMode({ ...sig, steps: def.steps.length }, t);
  const inherent = suggestMode({ ...sig, steps: 0 }, t).score;
  if (def.mode === 'orchestrated' && s.score < t.orchestrateMinSignals) {
    return `refused: this task is too small to fan out to parallel workers (${s.reasons.length ? s.reasons.join(', ') : 'no sign of size'}; orchestration needs ${t.orchestrateMinSignals} of: a brief of ${t.splitBriefChars}+ chars, ${t.splitCriteria}+ done-when criteria, an earlier run without progress, a context ${Math.round(t.handoffAt * 100)}%+ full, ${t.splitSteps}+ steps). Do it in this session (mode single) or step by step (mode sequential).`;
  }
  if (inherent === 0 && def.steps.length > SMALL_TASK_STEPS) {
    return `refused: ${def.steps.length} steps for a small task (no sign of size). Keep it to ${SMALL_TASK_STEPS} steps or fewer, or do it without a plan.`;
  }
  return null;
}

// ---- results ----

export interface CriterionResult { criterion: string; met: boolean; evidence: string }

/** Match a result's criteria to the step's exit list (by position, else by
 *  text) and say which are not met with evidence. Model-free: the master
 *  still judges the evidence; this only refuses "done" without it. Pure. */
export function checkExit(exit: string[], raw: unknown): { criteria: CriterionResult[]; gaps: string[] } {
  const given = Array.isArray(raw) ? raw.map((x) => (x ?? {}) as Record<string, unknown>) : [];
  const criteria = exit.map((c, i) => {
    const byText = given.find((g) => typeof g.criterion === 'string' && g.criterion.trim().toLowerCase() === c.toLowerCase());
    const g = byText ?? given[i] ?? {};
    return { criterion: c, met: g.met === true, evidence: str(g.evidence, 600) };
  });
  const gaps = criteria.filter((c) => !c.met || !c.evidence).map((c) => `"${c.criterion}"${c.met ? ' (no evidence)' : ''}`);
  return { criteria, gaps };
}

export interface HandoffPacket { state: string; decisions: string[]; artifacts: string[]; questions: string[]; next: string }

export function normalizeHandoff(raw: Record<string, unknown>): HandoffPacket {
  return { state: str(raw.state, 3_000), decisions: list(raw.decisions, 12), artifacts: list(raw.artifacts, 12, 300), questions: list(raw.questions ?? raw.openQuestions, 8), next: str(raw.next, 1_000) };
}

/** Two handoffs with the same state and next step are no progress. */
export function handoffSignature(p: HandoffPacket): string {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').replace(/\d+/g, '#').trim();
  return createHash('sha256').update(`${norm(p.state)}|${norm(p.next)}`).digest('hex').slice(0, 16);
}

export function describeHandoff(p: HandoffPacket): string {
  return [
    `- State: ${p.state || '(not stated)'}`,
    p.decisions.length ? `- Decisions made: ${p.decisions.join('; ')}` : '',
    p.artifacts.length ? `- Artifacts: ${p.artifacts.join(', ')}` : '',
    p.questions.length ? `- Open questions: ${p.questions.join('; ')}` : '',
    `- Next: ${p.next || '(not stated)'}`,
  ].filter(Boolean).join('\n');
}

// ---- texts ----

export interface StepView { step: PlanStep; status: PlanStepStatus; attempts: number; output: string; usd: number; note: string; questions: string[] }

const STATUS_MARK: Record<PlanStepStatus, string> = { pending: '[ ]', running: '[~]', done: '[x]', failed: '[!]', skipped: '[-]', interrupted: '[?]' };

/** The master's view of its plan (in its context and the tool's answer). */
export function planText(i: { title: string; version: number; mode: ExecMode; dynamic: boolean; status: string; steps: StepView[]; ready: string[]; decisions: string[]; caps: { sessions: number; maxSessions: number; usd: number; usdCap: number; parallel: number } }): string {
  const lines = [
    `Plan v${i.version} for "${i.title}": ${i.mode}${i.dynamic ? ', dynamic' : ''}, ${i.status}. Sessions ${i.caps.sessions}/${i.caps.maxSessions}${i.caps.usdCap > 0 ? `, workers $${i.caps.usd.toFixed(2)}/$${i.caps.usdCap.toFixed(2)}` : ''}, up to ${i.caps.parallel} in parallel.`,
    ...i.steps.map((v) => {
      const s = v.step;
      const tail = [s.dependsOn.length ? `after ${s.dependsOn.join(', ')}` : '', s.parallel ? 'parallel-safe' : 'alone', s.tier ? `tier ${s.tier}` : '', v.attempts ? `attempt ${v.attempts}` : '', s.optional ? 'optional' : ''].filter(Boolean).join(', ');
      const out = v.status === 'done' || v.status === 'failed' ? `\n    → ${v.output.replace(/\s+/g, ' ').slice(0, 240) || '(no output)'}` : '';
      return `${STATUS_MARK[v.status]} ${s.id} ${s.title} (${tail})${out}`;
    }),
    i.ready.length ? `Ready now: ${i.ready.join(', ')}.` : '',
    i.decisions.length ? `Decisions (every session honours them):\n${i.decisions.slice(-12).map((d) => `- ${d}`).join('\n')}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

/** A worker's whole briefing: one step, its inputs, the decisions, the exit. */
export function stepCardText(i: { taskTitle: string; agentName: string; step: PlanStep; inputs: Array<{ from: string; title: string; output: string }>; decisions: string[]; note: string; handoff: HandoffPacket | null; depth: number; canSpawn: boolean }): string {
  const s = i.step;
  return [
    `# Worker session: step "${s.title}" (${s.id}) of "${i.taskTitle}"`,
    `You are ${i.agentName}, working ONE step of a larger task in a fresh session; a master session owns the plan and integrates the result. Same identity, permissions and rules as always: outward actions go through the usual approvals.`,
    `Goal: ${s.goal}`,
    s.inputs.length ? `Needs: ${s.inputs.join('; ')}` : '',
    i.inputs.length ? `Inputs from earlier steps:\n${i.inputs.map((x) => `- ${x.from} "${x.title}": ${x.output.slice(0, 1_500)}`).join('\n')}` : '',
    i.decisions.length ? `Decisions already made — honour them; do not reopen one:\n${i.decisions.slice(-15).map((d) => `- ${d}`).join('\n')}` : '',
    i.note ? `The master's note for this attempt: ${i.note}` : '',
    i.handoff ? `You continue this step from a handoff packet written by the previous session:\n${describeHandoff(i.handoff)}` : '',
    `Exit criteria (check each with evidence):\n${s.exit.map((c, n) => `${n + 1}. ${c}`).join('\n')}`,
    s.parallel
      ? 'This step runs beside others: read and research only; do not write shared files or make decisions others depend on — propose them in decisions and the master adopts them.'
      : 'This step runs alone: you may write and decide within its goal; record each decision others must follow in decisions.',
    `Finish with task_step_result {output, criteria: [{met, evidence}] per exit criterion, decisions, questions, artifacts}, then end your turn. Context getting full before you finish? task_handoff {state, decisions, artifacts, questions, next} and stop: a fresh session continues the step.${i.canSpawn ? '' : ' You cannot start further workers.'}`,
  ].filter(Boolean).join('\n');
}
