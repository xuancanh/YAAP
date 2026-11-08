/**
 * Task execution tunables (docs/task-execution.md "Guardrails"): how far
 * one task may split — sessions, parallel workers, depth, steps, spend and
 * tokens per plan — when a session is told to hand off, how often a step
 * may be retried and how many idle step rounds stop a plan, and the
 * model-free signals that say a task is big enough to split at all.
 * Registered on the one registry of org-tunables.ts (`org_tune`,
 * `PUT …/org/tunables`); onboarding derives starting values from the
 * operating profile (`deriveExecTunables`, called by chief-os.ts) — speed
 * fans out wider, rigour verifies more and retries less, an early company
 * keeps caps small. Outside a company (a personal agent's chat) the
 * defaults apply. The defaults are only the fallback when no profile was read.
 */
import { registerTunables, tunable, type TunableDef } from './org-tunables';
import type { ProfileDiagnosis } from './chief-os';

export const EXEC_TUNABLES: Record<string, TunableDef> = {
  'exec.maxSessions': { default: 12, min: 1, max: 60, area: 'execution', description: 'Sessions one task\'s plan may use in all: the master\'s continuations after a handoff plus every worker session.' },
  'exec.maxParallel': { default: 3, min: 1, max: 8, area: 'execution', description: 'Worker sessions that may run at once for one task (only steps marked parallel-safe run side by side).' },
  'exec.maxDepth': { default: 1, min: 1, max: 2, area: 'execution', description: 'How deep worker sessions nest: 1 = only the master starts workers; 2 = a worker may start workers for other steps of the same plan.' },
  'exec.maxSteps': { default: 12, min: 2, max: 30, area: 'execution', description: 'Steps one plan may have (a plan of a small task is held to 3).' },
  'exec.planUsdCap': { default: 5, min: 0, max: 500, area: 'execution', description: 'USD one plan\'s worker sessions may spend in all; 0 = no plan cap (the budget envelopes still apply).' },
  'exec.planTokenCap': { default: 3_000_000, min: 50_000, max: 50_000_000, area: 'execution', description: 'Tokens (in + out) one plan\'s sessions may use in all.' },
  'exec.handoffAt': { default: 0.7, min: 0.3, max: 0.95, area: 'execution', description: 'Share (0–1) of a session\'s context ceiling at which it is told to write a handoff packet and continue in a fresh session instead of compacting.' },
  'exec.stepAttempts': { default: 2, min: 1, max: 5, area: 'execution', description: 'Attempts at one step (a worker that ended without meeting the exit criteria) before the step fails and the master must revise the plan.' },
  'exec.idleRounds': { default: 2, min: 1, max: 6, area: 'execution', description: 'Consecutive step rounds that finish no step before the plan is blocked (the no-progress breaker across sessions).' },
  'exec.splitBriefChars': { default: 2_500, min: 300, max: 20_000, area: 'execution', description: 'A brief (or request) this long is one signal that the task is big enough to split.' },
  'exec.splitCriteria': { default: 4, min: 2, max: 12, area: 'execution', description: 'This many done-when criteria is one signal that the task is big enough to split.' },
  'exec.splitSteps': { default: 4, min: 2, max: 12, area: 'execution', description: 'A plan of this many steps is one signal that the task is big enough to split.' },
  'exec.orchestrateMinSignals': { default: 2, min: 1, max: 5, area: 'execution', description: 'Signals (long brief, many criteria, earlier runs without progress, a context near its ceiling, many steps) a task needs before it may fan out to parallel workers; below it the plan runs in one session or sequentially.' },
};
registerTunables(EXEC_TUNABLES);

export type ExecTunables = Record<keyof typeof EXEC_TUNABLES, number>;

export function execTunable(org: { tunables?: string | null } | null | undefined, key: keyof typeof EXEC_TUNABLES): number {
  return tunable(org, key);
}

/** Every exec tunable's effective value (the defaults outside a company). */
export function execTunables(org: { tunables?: string | null } | null | undefined): ExecTunables {
  return Object.fromEntries(Object.keys(EXEC_TUNABLES).map((k) => [k, tunable(org, k)])) as ExecTunables;
}

/** Starting values from the profile. Pure; values stay inside each bound. */
export function deriveExecTunables(d: Pick<ProfileDiagnosis, 'stage' | 'cultureType' | 'speed' | 'rigor'>): Array<{ key: string; value: number; why: string }> {
  const { stage, cultureType: c, speed, rigor } = d;
  return [
    { key: 'exec.maxSessions', value: stage === 'early' ? 8 : stage === 'scale' ? 20 : 12, why: stage === 'early' ? 'a small company keeps one task to a few sessions' : stage === 'scale' ? 'a larger company runs bigger tasks' : 'a dozen sessions per task' },
    { key: 'exec.maxParallel', value: speed || c === 'adhocracy' ? 4 : c === 'hierarchy' ? 2 : 3, why: speed || c === 'adhocracy' ? 'speed is a value: independent research fans out wider' : c === 'hierarchy' ? 'a control culture keeps parallel work narrow and reviewable' : 'a few parallel workers on breadth work' },
    { key: 'exec.maxDepth', value: 1, why: 'only the master starts workers: a worker that splits again loses the shared decisions' },
    { key: 'exec.maxSteps', value: rigor ? 16 : 12, why: rigor ? 'rigour: smaller steps, each verified' : 'a dozen steps per plan' },
    { key: 'exec.planUsdCap', value: stage === 'early' ? 2 : stage === 'scale' ? 15 : 5, why: stage === 'early' ? 'a small company caps one task\'s workers at a couple of dollars' : stage === 'scale' ? 'a larger company affords bigger fan-outs' : 'a few dollars per task\'s workers' },
    { key: 'exec.planTokenCap', value: stage === 'early' ? 1_500_000 : stage === 'scale' ? 8_000_000 : 3_000_000, why: 'the token ceiling follows the spend cap' },
    { key: 'exec.handoffAt', value: rigor ? 0.6 : 0.7, why: rigor ? 'rigour: hand off early, before a long context drifts' : 'hand off at seven tenths of the context ceiling' },
    { key: 'exec.stepAttempts', value: rigor || c === 'hierarchy' ? 1 : 2, why: rigor || c === 'hierarchy' ? 'a step that misses its exit criteria goes back to the master at once' : 'one retry, then the master revises the plan' },
    { key: 'exec.idleRounds', value: speed ? 1 : 2, why: speed ? 'speed is a value: one idle round stops a plan' : 'two idle rounds stop a plan' },
    { key: 'exec.splitBriefChars', value: 2_500, why: 'a brief of a page or more' },
    { key: 'exec.splitCriteria', value: rigor ? 3 : 4, why: rigor ? 'three criteria already deserve separate verification' : 'four or more done-when criteria' },
    { key: 'exec.splitSteps', value: 4, why: 'four or more steps' },
    { key: 'exec.orchestrateMinSignals', value: c === 'hierarchy' || stage === 'early' ? 3 : 2, why: c === 'hierarchy' || stage === 'early' ? 'fan out only when the task is clearly big' : 'two signals before a task fans out' },
  ].map((t) => { const def = EXEC_TUNABLES[t.key]; return { ...t, value: Math.min(def.max, Math.max(def.min, t.value)) }; });
}
