/**
 * Process tunables (docs/processes.md "Tunables"): how hard MUST items
 * bind, whether an edit to a process applies at once or waits for an
 * approval, when a step's deviation rate says the standard needs revising,
 * how many runs of one process may be open, what a missed step SLA does,
 * the ceiling on loops, ad-hoc steps in dynamic stages, how often an
 * owner reviews its processes, how a new version ramps (its share of runs,
 * the sample and tolerance of the comparison, whether the verdict applies
 * itself), when repeated work is proposed as a process, and when drift from
 * the definition is flagged. Registered on the one registry of
 * org-tunables.ts (`org_tune`, `PUT …/org/tunables`); onboarding derives
 * starting values from the operating profile (`deriveProcessTunables`,
 * called by chief-os.ts `deriveOperatingSystem`) — a hierarchy gets block
 * enforcement, approved edits and formal monthly reviews, an adhocracy
 * lighter edits, ad-hoc steps and a higher bar before a step is "wrong".
 * The defaults below are only the fallback when no profile was read.
 */
import { registerTunables, tunable, type TunableDef } from './org-tunables';
import type { ProfileDiagnosis } from './chief-os';

export const PROCESS_TUNABLES: Record<string, TunableDef> = {
  'process.mustEnforcement': { default: 1, min: 0, max: 1, area: 'process', description: 'What an open MUST item does when a process step is handed to review: 1 the review is refused with what is missing; 0 it goes through and is logged as a MUST deviation for the owner.' },
  'process.editApproval': { default: 1, min: 0, max: 2, area: 'process', description: 'Whether an agent\'s edit to a process it may change applies at once: 0 every edit applies (a new version, rollback stays possible); 1 an edit that changes MUST items, checkpoints, approval steps, strict edges or denied tools waits for an approval card routed to the editor\'s manager; 2 every edit does.' },
  'process.reviseDeviationRate': { default: 0.3, min: 0.05, max: 1, area: 'process', description: 'Share (0–1) of a step\'s runs that deviate from it before the process is flagged for revision (a standard nobody follows is the standard\'s problem).' },
  'process.metricsWindowRuns': { default: 20, min: 5, max: 200, area: 'process', description: 'The most recent runs per process that the metrics (completion, cycle time, deviation, rework) are computed over.' },
  'process.maxActiveRuns': { default: 5, min: 1, max: 50, area: 'process', description: 'Open runs one process may have at a time; a trigger beyond it is skipped and logged.' },
  'process.slaAction': { default: 1, min: 0, max: 1, area: 'process', description: 'What a step past its SLA does: 0 a nudge on the task and a note to the owning head; 1 an escalation card up the performer\'s line (decision routing).' },
  'process.defaultSlaHours': { default: 0, min: 0, max: 720, area: 'process', description: 'SLA hours for a process step that sets none; 0 = none.' },
  'process.loopMaxCeiling': { default: 5, min: 1, max: 10, area: 'process', description: 'The highest loopMax a process edge may carry (how often a review loop may go round before it escalates).' },
  'process.adHocSteps': { default: 1, min: 0, max: 1, area: 'process', description: 'Whether the performer of a dynamic stage may add an ad-hoc step (logged as a deviation); 0 = only the defined steps.' },
  'process.reviewCadenceDays': { default: 14, min: 1, max: 90, area: 'process', description: 'Days between an owner\'s reviews of each process it owns (its metrics, deviations and failures); past it the owner is reminded.' },
  'process.rampPercent': { default: 25, min: 0, max: 90, area: 'process', description: 'Share (%) of new runs a new version of a process with a track record starts on while its runs are compared with the stable version\'s; 0 = a new version takes every new run at once.' },
  'process.rampMinRuns': { default: 5, min: 2, max: 50, area: 'process', description: 'Finished runs a ramped version needs before its comparison with the stable version gives a verdict (promote or roll back).' },
  'process.rampTolerance': { default: 0.1, min: 0, max: 0.5, area: 'process', description: 'How much worse (a share for completion, deviation and rework; a fraction of the cycle time) a ramped version may be than the stable one before the verdict is roll back.' },
  'process.rampAuto': { default: 0, min: 0, max: 1, area: 'process', description: 'What a ramp verdict does: 0 the owner is told and promotes or rolls back; 1 the engine promotes or rolls back on its own.' },
  'process.discoveryRepeats': { default: 4, min: 0, max: 30, area: 'process', description: 'How often work must repeat without a process (the same kind of task, the same sequence, the same cross-department request, the same ad-hoc step) before its owner gets a drafted process to consider; 0 = no discovery.' },
  'process.discoveryWindowDays': { default: 30, min: 7, max: 180, area: 'process', description: 'The days of task history discovery looks at.' },
  'process.conformanceAlert': { default: 0.7, min: 0.3, max: 1, area: 'process', description: 'Share (0–1) of a process\'s executed steps that must follow its definition (no open MUST, SHOULD skip, ad-hoc or out-of-order step); below it the owner\'s context flags the process.' },
};
registerTunables(PROCESS_TUNABLES);

export function processTunable(org: { tunables?: string | null } | null | undefined, key: keyof typeof PROCESS_TUNABLES): number {
  return tunable(org, key);
}

/** Starting values from the profile. Pure; values stay inside each bound. */
export function deriveProcessTunables(d: Pick<ProfileDiagnosis, 'stage' | 'cultureType' | 'speed' | 'rigor'>): Array<{ key: string; value: number; why: string }> {
  const { stage, cultureType: c, speed, rigor } = d;
  const control = c === 'hierarchy' || rigor;
  return [
    { key: 'process.mustEnforcement', value: c === 'adhocracy' && speed && !rigor ? 0 : 1, why: c === 'adhocracy' && speed && !rigor ? 'an adhocracy that values speed: an open MUST is logged for the owner rather than blocking' : 'a MUST is a gate: the review says what is missing and how to satisfy it' },
    { key: 'process.editApproval', value: c === 'hierarchy' ? 2 : control ? 1 : speed || c === 'adhocracy' ? 0 : 1, why: c === 'hierarchy' ? 'a control culture approves every change to a standard' : control ? 'rigour: a change to what a run must do is approved; wording edits apply at once' : speed || c === 'adhocracy' ? 'speed and experiment: edits apply at once, versioned and reversible' : 'a change to what a run must do is approved by the editor\'s manager' },
    { key: 'process.reviseDeviationRate', value: c === 'hierarchy' ? 0.2 : c === 'adhocracy' ? 0.5 : 0.3, why: c === 'hierarchy' ? 'deviations are rare in a control culture: a few are a signal' : c === 'adhocracy' ? 'improvisation is expected: only a step most runs skip needs revising' : 'a step skipped in about a third of runs is the standard\'s problem' },
    { key: 'process.metricsWindowRuns', value: rigor ? 40 : stage === 'early' ? 10 : 20, why: rigor ? 'evidence before a revision: a larger sample' : stage === 'early' ? 'a small company has few runs: judge on the recent ones' : 'the last twenty runs' },
    { key: 'process.maxActiveRuns', value: stage === 'early' ? 3 : stage === 'scale' ? 10 : 5, why: stage === 'early' ? 'a small company runs few procedures at once' : stage === 'scale' ? 'a larger company runs many in parallel' : 'a handful of open runs per process' },
    { key: 'process.slaAction', value: c === 'clan' && !rigor ? 0 : 1, why: c === 'clan' && !rigor ? 'a people-first culture nudges before it escalates' : 'a missed step SLA goes up the line as a decision' },
    { key: 'process.defaultSlaHours', value: speed ? 8 : c === 'hierarchy' ? 48 : 24, why: speed ? 'speed is a value: a step waits hours, not days' : c === 'hierarchy' ? 'formal steps get two working days' : 'a step moves within a day' },
    { key: 'process.loopMaxCeiling', value: control ? 3 : c === 'adhocracy' ? 6 : 5, why: control ? 'a loop that goes round three times needs a decision' : c === 'adhocracy' ? 'iteration is the work: loops may go round more' : 'a few rounds, then a decision' },
    { key: 'process.adHocSteps', value: c === 'hierarchy' ? 0 : 1, why: c === 'hierarchy' ? 'a control culture runs the defined steps; a missing step is a process change' : 'a dynamic stage may add a logged ad-hoc step' },
    { key: 'process.rampPercent', value: stage === 'early' ? 0 : c === 'hierarchy' || rigor ? 20 : c === 'adhocracy' || speed ? 50 : 25, why: stage === 'early' ? 'a small company has too few runs to compare: a new version takes every run' : c === 'hierarchy' || rigor ? 'a change to a standard proves itself on a fifth of runs first' : c === 'adhocracy' || speed ? 'fast ramps: half the runs try the new version' : 'a quarter of new runs try a new version first' },
    { key: 'process.rampMinRuns', value: rigor ? 8 : stage === 'early' ? 3 : 5, why: rigor ? 'evidence before a verdict: eight finished runs' : stage === 'early' ? 'few runs: judge on three' : 'five finished runs before a verdict' },
    { key: 'process.rampTolerance', value: c === 'hierarchy' || rigor ? 0.05 : c === 'adhocracy' ? 0.15 : 0.1, why: c === 'hierarchy' || rigor ? 'a new version may not be measurably worse' : c === 'adhocracy' ? 'some noise is accepted for the sake of trying' : 'within ten points of the stable version' },
    { key: 'process.rampAuto', value: c === 'adhocracy' || (speed && c !== 'hierarchy') ? 1 : 0, why: c === 'adhocracy' || (speed && c !== 'hierarchy') ? 'speed: the engine promotes or rolls back on the evidence' : 'the owner promotes or rolls back on the evidence' },
    { key: 'process.discoveryRepeats', value: c === 'hierarchy' ? 3 : c === 'adhocracy' ? 6 : 4, why: c === 'hierarchy' ? 'repeated work is standardised early' : c === 'adhocracy' ? 'routine is proposed only once it clearly recurs' : 'work done four times by hand is a process candidate' },
    { key: 'process.discoveryWindowDays', value: stage === 'early' ? 21 : 30, why: stage === 'early' ? 'a young company: the last three weeks' : 'the last month of tasks' },
    { key: 'process.conformanceAlert', value: c === 'hierarchy' || rigor ? 0.85 : c === 'adhocracy' ? 0.5 : 0.7, why: c === 'hierarchy' || rigor ? 'a standard is followed: drift is flagged early' : c === 'adhocracy' ? 'improvisation is expected: only heavy drift is flagged' : 'most steps follow the definition' },
    { key: 'process.reviewCadenceDays', value: c === 'hierarchy' ? 30 : speed ? 7 : stage === 'early' ? 14 : 14, why: c === 'hierarchy' ? 'formal monthly process reviews' : speed ? 'speed is a value: processes are tuned weekly' : 'every two weeks the owner looks at its processes\' runs' },
  ].map((t) => { const def = PROCESS_TUNABLES[t.key]; return { ...t, value: Math.min(def.max, Math.max(def.min, t.value)) }; });
}
