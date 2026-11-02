/**
 * Meeting tunables (docs/company-vision.md §1b, §3): every ritual number is
 * a per-org setting with a default and a bound. The defaults below are the
 * starting points; the chief adjusts them (`org_tune`, within the bounds,
 * which stay in code) to the company's culture. The numeric keys register on
 * the shared registry of `org-tunables.ts` at import, so `org_tune`,
 * `PUT …/org/tunables` and this module read one `organizations.tunables`
 * column with one set of bounds. `meeting.kinds` (a list, not a number) is
 * read from the same JSON column here; the registry ignores non-numbers.
 */
import type { MeetingKind } from './org-meetings.service';
import type { ProfileDiagnosis } from './chief-os';
import { registerTunables, tunable, type TunableDef } from './org-tunables';

export const MEETING_TUNABLES: Record<string, TunableDef> = {
  'meeting.roundCap': { default: 3, min: 1, max: 3, area: 'rituals', description: 'Rounds per meeting (a standup is always one).' },
  'meeting.usdCap': { default: 1, min: 0.05, max: 10, area: 'rituals', description: 'USD a single meeting may spend.' },
  'meeting.dailyCap': { default: 4, min: 0, max: 12, area: 'rituals', description: 'Meetings a unit may hold per day; a cadence may not fire more often.' },
  'meeting.leadsOnly': { default: 0, min: 0, max: 1, area: 'rituals', description: '1: only reports that lead units attend a ritual; 0: the whole unit.' },
  // The meeting room (docs/meetings.md "During", "Before"):
  'meeting.selectiveRounds': { default: 1, min: 0, max: 1, area: 'rituals', description: '1: rounds after the first hear only the attendees with an open thread (named since their turn, given an action, their question answered) and the facilitator; 0: everyone every round.' },
  'meeting.itemMinutes': { default: 10, min: 1, max: 60, area: 'rituals', description: 'Minutes each agenda item may take before the meeting moves to the next one.' },
  'meeting.extendRounds': { default: 1, min: 0, max: 2, area: 'rituals', description: 'Rounds a person may add to a running meeting with Extend (still under the USD cap).' },
  'meeting.prepMinutes': { default: 120, min: 0, max: 1440, area: 'rituals', description: 'Minutes before a scheduled ritual that it is prepared: the pre-read compiled and agenda proposals open (0: prepared at the start).' },
  'meeting.reminderMinutes': { default: 10, min: 0, max: 120, area: 'rituals', description: 'Minutes before a scheduled ritual that the people attending get a "starts in N min · Join" reminder (0: none).' },
  'meeting.autoSkip': { default: 1, min: 0, max: 1, area: 'rituals', description: '1: a scheduled ritual with nothing on its agenda (no deltas, open items, blocked tasks or proposals) skips itself without a model call; 0: it always runs.' },
};
registerTunables(MEETING_TUNABLES);

export const ALL_MEETING_KINDS: MeetingKind[] = ['planning', 'standup', 'weekly_review', 'retro', 'board', 'adhoc'];
const KINDS = new Set<string>(ALL_MEETING_KINDS);

type OrgLike = { tunables?: string | null } | null | undefined;

/** One numeric tunable through the shared registry (defaulted and clamped). */
export function meetingTunable(org: unknown, key: keyof typeof MEETING_TUNABLES): number {
  return tunable(asOrg(org), key);
}

/** The ritual kinds this company holds (`meeting.kinds` in the same JSON;
 *  unknown kinds dropped; missing → all). */
export function meetingKinds(org: unknown): MeetingKind[] {
  try {
    const v = (JSON.parse(asOrg(org)?.tunables || '{}') as Record<string, unknown>)['meeting.kinds'];
    return Array.isArray(v) ? (v.map(String).filter((k) => KINDS.has(k)) as MeetingKind[]) : ALL_MEETING_KINDS;
  } catch { return ALL_MEETING_KINDS; }
}

function asOrg(org: unknown): OrgLike {
  if (!org || typeof org !== 'object') return null;
  const t = (org as { tunables?: unknown }).tunables;
  return { tunables: typeof t === 'string' ? t : t && typeof t === 'object' ? JSON.stringify(t) : null };
}

/** The operating profile (§1b) as a meeting prompt reads it: the vision (the
 *  active vision goal's title, when item 18 has one), else the mission;
 *  values; culture — read defensively from the organization row. */
export function operatingProfile(org: unknown, vision?: { title: string; dueAt?: string | null } | null): string {
  const o = (org ?? {}) as { values?: unknown; culture?: unknown; mission?: unknown };
  const s = (v: unknown) => (typeof v === 'string' ? v.trim().slice(0, 1_500) : '');
  const lines = [
    vision?.title ? `Vision: ${vision.title.slice(0, 500)}${vision.dueAt ? ` (by ${vision.dueAt.slice(0, 10)})` : ''}` : s(o.mission) ? `Mission: ${s(o.mission)}` : '',
    s(o.values) ? `Values: ${s(o.values)}` : '',
    s(o.culture) ? `Culture: ${s(o.culture)}` : '',
  ].filter(Boolean);
  return lines.length ? `Operating profile (run this meeting in the company's style):\n${lines.join('\n')}` : '';
}

/**
 * The meeting room's tunables derived from the operating profile (the
 * report's culture → mechanism map; a heuristic, stated as one): a company
 * that values speed gets short agenda items, no extra rounds and empty
 * rituals skipped; a rigour- or control-minded one long preparation and
 * longer items; a clan culture hears everyone every round. Pure; the
 * operating-system derivation (`chief-os.ts`) appends these to its plan.
 */
export function deriveMeetingTunables(d: Pick<ProfileDiagnosis, 'stage' | 'cultureType' | 'speed' | 'rigor' | 'writing'>): Array<{ key: string; value: number; why: string }> {
  const c = d.cultureType;
  const formal = d.rigor || c === 'hierarchy';
  return [
    { key: 'meeting.itemMinutes', value: d.speed ? 5 : formal ? 15 : 10, why: d.speed ? 'speed is a value: each agenda item gets five minutes' : formal ? 'items are worked through with care: fifteen minutes each' : 'ten minutes per agenda item' },
    { key: 'meeting.selectiveRounds', value: c === 'clan' ? 0 : 1, why: c === 'clan' ? 'a consensus culture hears everyone every round' : 'after the first round only those with an open thread speak' },
    { key: 'meeting.extendRounds', value: d.speed ? 0 : c === 'clan' ? 2 : 1, why: d.speed ? 'a meeting ends on time; there is no extra round' : c === 'clan' ? 'room for one more pass at consensus' : 'one extra round when the room asks for it' },
    { key: 'meeting.prepMinutes', value: formal ? 1440 : d.speed || d.stage === 'early' ? 60 : 240, why: formal ? 'pre-reads and agenda proposals open a day ahead' : d.speed || d.stage === 'early' ? 'an hour of preparation is enough for a small, fast team' : 'the pre-read and agenda open a few hours ahead' },
    { key: 'meeting.autoSkip', value: c === 'hierarchy' && !d.speed ? 0 : 1, why: c === 'hierarchy' && !d.speed ? 'rituals are held as scheduled, even when quiet' : 'a ritual with nothing on its agenda skips itself (written context carries the update)' },
  ];
}
