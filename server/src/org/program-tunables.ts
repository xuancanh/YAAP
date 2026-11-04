/**
 * Program tunables (docs/work-tracking.md "Program management: the
 * matrix"): the bounds a Program Manager chooses each goal's and project's
 * rhythm within, the defaults a newly owned item starts on, how long a head
 * has to answer a resource request before it climbs, when a member's
 * project allocations count as stretched, and when a cadence is stale.
 * Every value is a per-org setting on the one registry of org-tunables.ts
 * (`org_tune`, `PUT …/org/tunables`); onboarding derives starting values
 * from the operating profile (`deriveProgramTunables`, called by
 * chief-os.ts `deriveOperatingSystem`). The defaults below are only the
 * fallback when no profile was read.
 *
 * Also the pure cadence helpers: a cron for "every N days at hour H", and
 * the typical interval of a cron in days (the bound check).
 */
import { registerTunables, tunable, type TunableDef } from './org-tunables';
import type { ProfileDiagnosis } from './chief-os';
import { cronMatches } from '../chats/cron.util';

export const PROGRAM_TUNABLES: Record<string, TunableDef> = {
  'program.syncDays': { default: 7, min: 1, max: 14, area: 'work', description: 'Days between a project\'s sync (its standup with the team) when its Program Manager first takes it; the PM may change it within program.syncMinDays–program.syncMaxDays.' },
  'program.syncMinDays': { default: 1, min: 1, max: 14, area: 'work', description: 'The most often a Program Manager may hold a project sync (days between).' },
  'program.syncMaxDays': { default: 14, min: 1, max: 31, area: 'work', description: 'The least often a Program Manager may hold a project sync (days between).' },
  'program.reviewDays': { default: 14, min: 3, max: 31, area: 'work', description: 'Days between a goal review (an objective\'s key results, its projects and their asks) and a project\'s milestone review when a Program Manager first takes them.' },
  'program.reviewMinDays': { default: 7, min: 1, max: 31, area: 'work', description: 'The most often a Program Manager may hold a goal or milestone review (days between).' },
  'program.reviewMaxDays': { default: 31, min: 7, max: 92, area: 'work', description: 'The least often a Program Manager may hold a goal or milestone review (days between).' },
  'program.cadenceHour': { default: 10, min: 0, max: 23, area: 'work', description: 'Hour (server time) the default goal and project cadences are held at.' },
  'program.requestAnswerHours': { default: 24, min: 1, max: 168, area: 'work', description: 'Hours a head has to approve, adjust or decline a Program Manager\'s resource request before it climbs to the head\'s manager as a resource conflict.' },
  'program.allocationWarnPct': { default: 85, min: 50, max: 100, area: 'work', description: 'Percent of a member\'s time allocated to project teams above which it is stretched: its head and the Program Managers of its projects are told.' },
  'program.staleCadences': { default: 2, min: 1, max: 6, area: 'work', description: 'Missed intervals after which a goal or project cadence counts as stale (the chief and the owner are told).' },
};
registerTunables(PROGRAM_TUNABLES);

export function programTunable(org: { tunables?: string | null } | null | undefined, key: string): number {
  return tunable(org, key);
}

/**
 * Starting values from the profile: speed syncs more often and answers
 * resource requests within hours; a control culture reviews formally and
 * gives a head two days; a clan culture protects people's time with a lower
 * stretch threshold; an early company keeps reviews light. Pure; values stay
 * inside each bound.
 */
export function deriveProgramTunables(d: Pick<ProfileDiagnosis, 'stage' | 'cultureType' | 'speed' | 'rigor'>): Array<{ key: string; value: number; why: string }> {
  const { stage, cultureType: c, speed, rigor } = d;
  const formal = rigor || c === 'hierarchy';
  return [
    { key: 'program.syncDays', value: speed || c === 'adhocracy' ? 2 : formal ? 7 : stage === 'early' ? 3 : 7, why: speed || c === 'adhocracy' ? 'speed is a value: a project team syncs twice a week' : formal ? 'a weekly project sync with a written agenda' : stage === 'early' ? 'a small team syncs every few days' : 'a weekly project sync' },
    { key: 'program.syncMinDays', value: 1, why: 'a Program Manager may hold a daily sync when a project needs it' },
    { key: 'program.syncMaxDays', value: formal ? 14 : 7, why: formal ? 'a project syncs at least every two weeks' : 'a project syncs at least weekly' },
    { key: 'program.reviewDays', value: speed ? 7 : formal ? 14 : stage === 'early' ? 7 : 14, why: speed ? 'goals and milestones reviewed weekly' : formal ? 'a formal review every two weeks' : stage === 'early' ? 'a small company checks its goals weekly' : 'goal and milestone reviews every two weeks' },
    { key: 'program.reviewMinDays', value: speed ? 3 : 7, why: speed ? 'reviews may run twice a week when a goal is at risk' : 'a review at most weekly' },
    { key: 'program.reviewMaxDays', value: formal ? 31 : stage === 'early' ? 14 : 31, why: formal ? 'a goal is reviewed at least monthly' : stage === 'early' ? 'a small company reviews each goal at least every two weeks' : 'a goal is reviewed at least monthly' },
    { key: 'program.requestAnswerHours', value: speed ? 8 : formal ? 48 : stage === 'early' ? 12 : 24, why: speed ? 'a head answers a resource request the same working day' : formal ? 'a head gets two days to weigh a request against its unit\'s plan' : stage === 'early' ? 'a small company answers staffing asks within a morning' : 'a head answers a resource request within a day' },
    { key: 'program.allocationWarnPct', value: c === 'clan' ? 75 : speed || c === 'market' ? 90 : 85, why: c === 'clan' ? 'a people-first culture keeps a quarter of each member\'s time for its home unit' : speed || c === 'market' ? 'members may be lent almost fully before it is flagged' : 'a member lent more than 85% has little left for its unit' },
    { key: 'program.staleCadences', value: formal ? 1 : 2, why: formal ? 'a missed review is flagged at once' : 'two missed intervals and a cadence is stale' },
  ].map((t) => { const def = PROGRAM_TUNABLES[t.key]; return { ...t, value: Math.min(def.max, Math.max(def.min, t.value)) }; });
}

/** "Every N days at hour H" as a five-field cron (server time): daily on
 *  weekdays, twice a week, weekly on `weekday`, twice a month, monthly. Pure. */
export function cronForDays(days: number, hour: number, weekday = 1): string {
  const h = Math.max(0, Math.min(23, Math.round(hour)));
  const d = Math.max(1, Math.round(days));
  if (d <= 1) return `0 ${h} * * 1-5`;
  if (d <= 3) return `0 ${h} * * 1,4`;
  if (d <= 9) return `0 ${h} * * ${weekday}`;
  if (d <= 20) return `0 ${h} 1,15 * *`;
  return `0 ${h} 1 * *`;
}

/** The typical days between fires of a cron: the mean gap over its next
 *  `n` fires from `from` (null when it fires fewer than twice in the scan
 *  window). Pure. */
export function cronIntervalDays(cron: string, from = new Date(), n = 6): number | null {
  const fires: number[] = [];
  let at: Date | null = from;
  for (let i = 0; i < n && at; i++) {
    at = nextFire(cron, at);
    if (at) fires.push(at.getTime());
  }
  if (fires.length < 2) return null;
  return (fires[fires.length - 1] - fires[0]) / (fires.length - 1) / 86_400_000;
}

/** Why a cron is outside [minDays, maxDays] ('' when within). Pure. */
export function cadenceBoundsError(cron: string, minDays: number, maxDays: number, from = new Date()): string {
  const gap = cronIntervalDays(cron, from);
  if (gap === null) {
    // A monthly cron fires once in the scan window: its gap is about a month.
    if (nextFire(cron, from) && maxDays >= 28) return '';
    return 'that cadence fires fewer than twice in the coming weeks';
  }
  if (gap < minDays - 0.01) return `that cadence fires every ${fmtDays(gap)} — more often than the company allows (at most every ${minDays} day(s))`;
  if (gap > maxDays + 0.01) return `that cadence fires every ${fmtDays(gap)} — less often than the company allows (at least every ${maxDays} day(s))`;
  return '';
}

/** The next minute after `from` the cron matches, within `maxDays` (null when none). Pure. */
export function nextFire(cron: string, from: Date, maxDays = 35): Date | null {
  const f = (cron ?? '').trim().split(/\s+/);
  if (f.length !== 5 || !f.every((x) => /^[\d*,/-]+$/.test(x))) return null;
  const d = new Date(from.getTime()); d.setSeconds(0, 0); d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < maxDays * 24 * 60; i++, d.setMinutes(d.getMinutes() + 1)) if (cronMatches(cron, d)) return new Date(d.getTime());
  return null;
}

function fmtDays(d: number): string { return d < 1 ? `${Math.round(d * 24)} hour(s)` : `${Math.round(d * 10) / 10} day(s)`; }
