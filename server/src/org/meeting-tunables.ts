/**
 * Meeting tunables (docs/company-vision.md §1b, §3): every ritual number is
 * a per-org setting with a default and a bound. The defaults below are the
 * starting points; the chief adjusts them (within the bounds, which stay in
 * code) to the company's culture. Read from `organizations.tunables` (a JSON
 * column item 18 adds) defensively: a missing column or key is the default.
 *
 * TODO(item 18 rebase): replace `meetingTunable` with the shared
 * `tunable(org, key)` helper from `server/src/org/org-tunables.ts` once the
 * intent branch lands; the keys below are namespaced `meeting.*` to coexist.
 */
import type { MeetingKind } from './org-meetings.service';

export interface MeetingTunables {
  /** Ritual kinds a cadence may fire for (a two-agent shop may hold no standup). */
  'meeting.kinds': MeetingKind[];
  /** Rounds per meeting (a standup is always one). */
  'meeting.roundCap': number;
  /** USD per meeting. */
  'meeting.usdCap': number;
  /** Meetings per unit per day. */
  'meeting.dailyCap': number;
  /** Who attends a ritual: the unit (lead + reports) or the leads only (lead + reports that lead units). */
  'meeting.attendees': 'unit' | 'leads';
}

export const MEETING_TUNABLE_DEFAULTS: MeetingTunables = {
  'meeting.kinds': ['planning', 'standup', 'weekly_review', 'retro', 'board', 'adhoc'],
  'meeting.roundCap': 3,
  'meeting.usdCap': 1.0,
  'meeting.dailyCap': 4,
  'meeting.attendees': 'unit',
};

/** The safety fence (never moved by culture): rounds 1–3, $0.05–$10 a
 *  meeting, 0–12 meetings per unit per day. */
export const MEETING_TUNABLE_BOUNDS = {
  'meeting.roundCap': { min: 1, max: 3 },
  'meeting.usdCap': { min: 0.05, max: 10 },
  'meeting.dailyCap': { min: 0, max: 12 },
} as const;

const KINDS = new Set(MEETING_TUNABLE_DEFAULTS['meeting.kinds']);

function parseTunables(org: unknown): Record<string, unknown> {
  const raw = (org as { tunables?: unknown } | null | undefined)?.tunables;
  if (!raw) return {};
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  try { const v = JSON.parse(String(raw)) as unknown; return v && typeof v === 'object' ? v as Record<string, unknown> : {}; } catch { return {}; }
}

/** One tunable, defaulted and clamped into its bound. */
export function meetingTunable<K extends keyof MeetingTunables>(org: unknown, key: K): MeetingTunables[K] {
  const v = parseTunables(org)[key];
  const d = MEETING_TUNABLE_DEFAULTS[key];
  if (v === undefined || v === null) return d;
  switch (key) {
    case 'meeting.kinds': return (Array.isArray(v) ? v.map(String).filter((k) => KINDS.has(k as MeetingKind)) : d) as MeetingTunables[K];
    case 'meeting.attendees': return (v === 'leads' || v === 'unit' ? v : d) as MeetingTunables[K];
    default: {
      const b = MEETING_TUNABLE_BOUNDS[key as keyof typeof MEETING_TUNABLE_BOUNDS];
      const n = Number(v);
      return (Number.isFinite(n) ? Math.min(b.max, Math.max(b.min, n)) : d) as MeetingTunables[K];
    }
  }
}

/** The operating profile (§1b) as a meeting prompt reads it: values,
 *  culture, vision/mission — columns item 18 adds, read defensively. */
export function operatingProfile(org: unknown): string {
  const o = (org ?? {}) as { values?: unknown; culture?: unknown; vision?: unknown; mission?: unknown };
  const s = (v: unknown) => (typeof v === 'string' ? v.trim().slice(0, 1_500) : '');
  const lines = [
    s(o.vision) ? `Vision: ${s(o.vision)}` : s(o.mission) ? `Mission: ${s(o.mission)}` : '',
    s(o.values) ? `Values: ${s(o.values)}` : '',
    s(o.culture) ? `Culture: ${s(o.culture)}` : '',
  ].filter(Boolean);
  return lines.length ? `Operating profile (run this meeting in the company's style):\n${lines.join('\n')}` : '';
}
