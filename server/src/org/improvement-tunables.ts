/**
 * Improvement and admission tunables (docs/improvements.md): how many
 * improvement proposals may be open per target and per unit, how many one
 * retro, postmortem or process review may raise, which changes are
 * pre-authorised (standard), whether emergency changes apply during an
 * incident, how long a change is watched before it is verified, and — for
 * admission control — how much self-started work (agent initiative, retro
 * and meeting actions) a unit may hold open, how much one member may start
 * in a day, what happens over the cap, and the attention budget on wakes
 * from other agents. Registered on the one registry of org-tunables.ts
 * (`org_tune`, `PUT …/org/tunables`); onboarding derives starting values
 * from the operating profile (`deriveImprovementTunables`, called by
 * chief-os.ts `deriveOperatingSystem`). The defaults below are only the
 * fallback when no profile was read.
 */
import { registerTunables, tunable, type TunableDef } from './org-tunables';
import type { ProfileDiagnosis } from './chief-os';

export const IMPROVEMENT_TUNABLES: Record<string, TunableDef> = {
  'improve.maxOpenPerTarget': { default: 1, min: 1, max: 5, area: 'process', description: 'Improvement proposals one target (a process, policy, standard, playbook, charter, cadence or tunable) may have open — proposed, accepted or applied and still being verified; another waits until that one settles (one change at a time, so its effect can be measured).' },
  'improve.maxOpenPerUnit': { default: 4, min: 1, max: 30, area: 'process', description: 'Improvement proposals a unit may have open (proposed or accepted) at once; more are refused with what to do instead.' },
  'improve.perMeeting': { default: 2, min: 1, max: 6, area: 'process', description: 'Proposals one retro, postmortem or process review may raise: its actions are ranked (prevent, repair, detect, mitigate, investigate; a named target and evidence first) and the rest stay in the minutes as not raised.' },
  'improve.standardScope': { default: 1, min: 0, max: 2, area: 'process', description: 'Which changes are pre-authorised standard changes that apply at once: 0 none (every change is approved); 1 a process edit that leaves its controls alone and a playbook revision; 2 also cadences and a tightening of a policy or quality standard. Charters and tunables are never standard.' },
  'improve.emergency': { default: 1, min: 0, max: 1, area: 'process', description: 'Whether a mitigation or repair proposed while its incident is open applies at once as an emergency change, reviewed by the owner afterwards (rejected in review → reverted); 0 = emergency changes wait like normal ones.' },
  'improve.verifyDays': { default: 14, min: 1, max: 90, area: 'process', description: 'Days an applied change is watched before its expected metric is checked against the baseline; failing opens a revert proposal.' },
  'improve.expireDays': { default: 14, min: 1, max: 90, area: 'process', description: 'Days a proposal may wait for a decision before it expires (no answer is not a yes).' },
  'improve.autoRevert': { default: 0, min: 0, max: 1, area: 'process', description: 'When a change fails its verification: 0 a revert proposal goes to the owner; 1 the revert applies at once (a standard change) and the owner is told.' },
  'improve.repairTasks': { default: 1, min: 0, max: 1, area: 'process', description: 'Whether a retro\'s concrete Repair of a specific defect (an owner and done-when, no standing target) may become a task — counted against the admission caps; 0 = every retro action is a proposal.' },
  'admission.selfWip': { default: 6, min: 0, max: 50, area: 'work', description: 'Open self-started tasks (agent initiative, retro and meeting actions outside any project bet) a unit may hold; beyond it new ones are refused with remediation, or parked (admission.overCap). Process steps, service requests, incidents, accepted proposals, subtasks and the CEO\'s and chief\'s work are not counted.' },
  'admission.selfPerDay': { default: 4, min: 0, max: 50, area: 'work', description: 'Self-started tasks one member may create in 24 hours (the rate cap beside the WIP cap).' },
  'admission.overCap': { default: 0, min: 0, max: 1, area: 'work', description: 'What a self-started task over the caps does: 0 it is refused with what to do instead (finish one, attach it to the project it serves, ask through a service request, or raise an improvement proposal); 1 it is parked as an unassigned backlog proposal nobody is woken for.' },
  'attention.agentWakesPerHour': { default: 12, min: 1, max: 120, area: 'work', description: 'Wakes one member may get from other agents in an hour (their comments, tags and assignments); beyond it a wake is deferred until the hour frees up — never dropped. People\'s wakes, reviews and approvals are not counted.' },
};
registerTunables(IMPROVEMENT_TUNABLES);

export function improvementTunable(org: { tunables?: string | null } | null | undefined, key: keyof typeof IMPROVEMENT_TUNABLES): number {
  return tunable(org, key);
}

/** Starting values from the profile: a control or rigour culture approves
 *  every change, watches longer and keeps self-started work small; speed
 *  and an adhocracy widen the standard-change scope, verify faster and park
 *  rather than refuse; an early company keeps meta-work small. Pure; values
 *  stay inside each bound. */
export function deriveImprovementTunables(d: Pick<ProfileDiagnosis, 'stage' | 'cultureType' | 'speed' | 'rigor'>): Array<{ key: string; value: number; why: string }> {
  const { stage, cultureType: c, speed, rigor } = d;
  const control = c === 'hierarchy' || rigor;
  const loose = speed || c === 'adhocracy';
  return [
    { key: 'improve.maxOpenPerTarget', value: c === 'adhocracy' ? 2 : 1, why: c === 'adhocracy' ? 'experiments overlap: two open changes per target' : 'one change per target at a time, so its effect can be measured' },
    { key: 'improve.maxOpenPerUnit', value: stage === 'early' ? 3 : c === 'hierarchy' ? 3 : loose ? 6 : 4, why: stage === 'early' ? 'an early company spends little on work about work' : c === 'hierarchy' ? 'a few deliberate changes at a time' : loose ? 'room for several changes in flight' : 'a handful of changes per unit at a time' },
    { key: 'improve.perMeeting', value: c === 'clan' || c === 'adhocracy' ? 3 : 2, why: c === 'clan' || c === 'adhocracy' ? 'the team picks its top three changes' : 'a retro keeps at most two changes' },
    { key: 'improve.standardScope', value: control ? 0 : loose ? 2 : 1, why: control ? 'rigour: every change has a written diff and a named approver' : loose ? 'speed and experiment: reversible edits and tightenings apply at once' : 'reversible process wording and playbook revisions apply at once; the rest is approved' },
    { key: 'improve.emergency', value: c === 'hierarchy' && !speed ? 0 : 1, why: c === 'hierarchy' && !speed ? 'a control culture approves even an incident fix first' : 'an incident fix applies at once and is reviewed afterwards' },
    { key: 'improve.verifyDays', value: speed ? 7 : rigor ? 21 : c === 'hierarchy' ? 30 : 14, why: speed ? 'a change is judged within a week' : rigor ? 'three weeks of evidence before a change counts as verified' : c === 'hierarchy' ? 'a month before a change is judged' : 'two weeks before a change is judged' },
    { key: 'improve.expireDays', value: speed ? 7 : c === 'hierarchy' ? 21 : 14, why: speed ? 'an unanswered proposal lapses within a week' : 'an unanswered proposal lapses; it can be raised again with fresh evidence' },
    { key: 'improve.autoRevert', value: speed && !rigor ? 1 : 0, why: speed && !rigor ? 'a change that misses its metric is reverted at once' : 'a change that misses its metric goes back to its owner as a revert proposal' },
    { key: 'improve.repairTasks', value: c === 'hierarchy' ? 0 : 1, why: c === 'hierarchy' ? 'every retro action is a proposal the owner decides' : 'a concrete repair of a specific defect may be a task, inside the admission caps' },
    { key: 'admission.selfWip', value: c === 'hierarchy' ? 3 : stage === 'early' ? 4 : loose ? 10 : 6, why: c === 'hierarchy' ? 'managers assign the work; little starts on its own' : stage === 'early' ? 'a small company keeps self-started work small' : loose ? 'initiative is valued: more room for self-started work' : 'a few self-started tasks per unit at a time' },
    { key: 'admission.selfPerDay', value: c === 'hierarchy' ? 2 : loose ? 6 : 4, why: c === 'hierarchy' ? 'two self-started tasks a day per member' : loose ? 'members start more of their own work' : 'a few self-started tasks a day per member' },
    { key: 'admission.overCap', value: loose || c === 'clan' ? 1 : 0, why: loose || c === 'clan' ? 'over the cap a task is parked as a proposal, not refused' : 'over the cap a task is refused with what to do instead' },
    { key: 'attention.agentWakesPerHour', value: c === 'hierarchy' ? 6 : speed ? 20 : 12, why: c === 'hierarchy' ? 'agents interrupt each other rarely; the rest waits' : speed ? 'fast back-and-forth between agents' : 'a dozen interruptions from other agents an hour, then they wait' },
  ].map((t) => { const def = IMPROVEMENT_TUNABLES[t.key]; return { ...t, value: Math.min(def.max, Math.max(def.min, t.value)) }; });
}
