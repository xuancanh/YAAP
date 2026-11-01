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
import { registerTunables, tunable, type TunableDef } from './org-tunables';

export const MEETING_TUNABLES: Record<string, TunableDef> = {
  'meeting.roundCap': { default: 3, min: 1, max: 3, area: 'rituals', description: 'Rounds per meeting (a standup is always one).' },
  'meeting.usdCap': { default: 1, min: 0.05, max: 10, area: 'rituals', description: 'USD a single meeting may spend.' },
  'meeting.dailyCap': { default: 4, min: 0, max: 12, area: 'rituals', description: 'Meetings a unit may hold per day; a cadence may not fire more often.' },
  'meeting.leadsOnly': { default: 0, min: 0, max: 1, area: 'rituals', description: '1: only reports that lead units attend a ritual; 0: the whole unit.' },
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
