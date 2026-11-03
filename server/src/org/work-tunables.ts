/**
 * Work-tracking tunables (docs/work-tracking.md "Mechanisms"): every
 * cadence, threshold and back-off the project layer runs by is a per-org
 * setting with a default and a bound on the one registry of
 * org-tunables.ts — `org_tune` and `PUT …/org/tunables` reach them, and
 * onboarding derives starting values from the operating profile
 * (`deriveWorkTunables`, called by chief-os.ts `deriveOperatingSystem`).
 * The defaults below are only the fallback when no profile was read.
 */
import { registerTunables, tunable, type TunableDef } from './org-tunables';
import type { ProfileDiagnosis } from './chief-os';

export const WORK_TUNABLES: Record<string, TunableDef> = {
  'work.updateCadenceDays': { default: 7, min: 1, max: 30, area: 'work', description: 'Days between a project lead\'s health updates on an active (Now) project; a project may set its own.' },
  'work.updateMissingGraceDays': { default: 3, min: 0, max: 14, area: 'work', description: 'Days past a missed health update before the project shows "Update missing" to the CEO (the chief chases from the due day).' },
  'work.appetiteWarnShare': { default: 0.8, min: 0.3, max: 1, area: 'work', description: 'Share (0–1) of a project\'s appetite (days or USD) at which its lead must post a health update.' },
  'work.breakerDefaultExtend': { default: 0, min: 0, max: 1, area: 'work', description: 'When a project trips its appetite and nobody decides: 0 cancels by default (Shape Up), 1 extends by default.' },
  'work.extendShare': { default: 0.5, min: 0.1, max: 2, area: 'work', description: 'How much (share of the original appetite) a manager may extend a tripped project by alone; more is the CEO\'s decision.' },
  'work.blockedBackoffMinutes': { default: 60, min: 5, max: 1_440, area: 'work', description: 'First wait before a blocked task whose blocker did not change wakes its owner again; doubles each time.' },
  'work.blockedBackoffMaxHours': { default: 48, min: 1, max: 336, area: 'work', description: 'The longest wait between wakes on an unchanged blocked task.' },
  'work.circularRepeats': { default: 2, min: 2, max: 5, area: 'work', description: 'Runs ending in the same failed approach on one task before its wakes pause and the lead is flagged (circular behaviour).' },
  'work.operatingWipCap': { default: 3, min: 0, max: 20, area: 'work', description: 'Open tasks a unit\'s "Operating improvements" project (retro and postmortem actions) may hold; more stay proposals in its backlog.' },
  'work.orphanGraceHours': { default: 24, min: 1, max: 336, area: 'work', description: 'Hours a task may sit in a unit\'s Unsorted project before the unit head (then the chief) is asked to place it.' },
  'work.forecastMinSamples': { default: 8, min: 3, max: 60, area: 'work', description: 'Done tasks (in the forecast window) needed before a project shows a forecast range instead of "not enough history".' },
};
registerTunables(WORK_TUNABLES);

export function workTunable(org: { tunables?: string | null } | null | undefined, key: string): number {
  return tunable(org, key);
}

/** Starting values from the profile: speed shortens the update cadence and
 *  the back-off; rigour and a control culture lengthen grace, raise the
 *  forecast's bar and give process work more room; an early company keeps
 *  meta-work small. Pure; values stay inside each bound. */
export function deriveWorkTunables(d: Pick<ProfileDiagnosis, 'stage' | 'cultureType' | 'speed' | 'rigor'>): Array<{ key: string; value: number; why: string }> {
  const { stage, cultureType: c, speed, rigor } = d;
  return [
    { key: 'work.updateCadenceDays', value: speed ? 3 : c === 'hierarchy' ? 7 : stage === 'early' ? 5 : 7, why: speed ? 'speed is a value: leads post health twice a week' : c === 'hierarchy' ? 'a weekly written status, as a control culture expects' : stage === 'early' ? 'a small company checks its bets more often than weekly' : 'a weekly health update per Now project' },
    { key: 'work.updateMissingGraceDays', value: speed ? 1 : c === 'hierarchy' ? 2 : 3, why: speed ? 'a missed update is called out the next day' : 'a missed update is called out after a few days' },
    { key: 'work.appetiteWarnShare', value: rigor || c === 'hierarchy' ? 0.7 : 0.8, why: rigor || c === 'hierarchy' ? 'rigour: the lead reports earlier on burn' : 'the lead reports at 80% of the appetite' },
    { key: 'work.breakerDefaultExtend', value: c === 'clan' ? 1 : 0, why: c === 'clan' ? 'a people-first culture extends by default and cuts deliberately' : 'Shape Up\'s circuit breaker: a bet that runs out is cancelled unless someone extends it' },
    { key: 'work.blockedBackoffMinutes', value: speed ? 30 : 60, why: speed ? 'blocked work is re-checked sooner' : 'an unchanged blocker is re-checked after an hour, then less often' },
    { key: 'work.operatingWipCap', value: rigor || c === 'hierarchy' ? 5 : stage === 'early' ? 2 : 3, why: rigor || c === 'hierarchy' ? 'rigour values process improvements: more room for retro actions' : stage === 'early' ? 'an early company spends little on work about work' : 'a few retro actions at a time; the rest wait as proposals' },
    { key: 'work.forecastMinSamples', value: rigor ? 12 : 8, why: rigor ? 'evidence before a forecast: a larger sample' : 'a forecast once eight tasks are done' },
  ].map((t) => { const def = WORK_TUNABLES[t.key]; return { ...t, value: Math.min(def.max, Math.max(def.min, t.value)) }; });
}
