/** The meetings list and calendar (docs/meetings.md): pure helpers for the
 *  month grid, the week agenda and the list's upcoming / past split. Dates
 *  are the viewer's local time; weeks start on Monday. */
import type { CalendarMeeting, MeetingRoomState, Minutes } from './api';

/** `yyyy-mm-dd` in local time. */
export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function startOfDay(d: Date): Date { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
export function addDays(d: Date, n: number): Date { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
/** Monday of the week `d` is in. */
export function startOfWeek(d: Date): Date { return addDays(startOfDay(d), -((d.getDay() + 6) % 7)); }

/** The month grid around `anchor`: whole Monday-first weeks covering the month (4–6 rows of 7). */
export function monthGrid(anchor: Date): Date[][] {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
  const weeks: Date[][] = [];
  for (let start = startOfWeek(first); start <= last; start = addDays(start, 7)) {
    weeks.push(Array.from({ length: 7 }, (_, i) => addDays(start, i)));
  }
  return weeks;
}

/** The seven days of the week `anchor` is in. */
export function weekDays(anchor: Date): Date[] {
  const start = startOfWeek(anchor);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

/** The API range a view needs: the whole grid for a month, the week for the agenda. */
export function rangeFor(view: 'month' | 'week', anchor: Date): { from: Date; to: Date } {
  if (view === 'week') { const from = startOfWeek(anchor); return { from, to: addDays(from, 7) }; }
  const grid = monthGrid(anchor);
  return { from: grid[0][0], to: addDays(grid[grid.length - 1][6], 1) };
}

/** Meetings by local day, each day in time order. */
export function byDay(items: CalendarMeeting[]): Map<string, CalendarMeeting[]> {
  const out = new Map<string, CalendarMeeting[]>();
  for (const m of [...items].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))) {
    const k = dayKey(new Date(m.at));
    out.set(k, [...(out.get(k) ?? []), m]);
  }
  return out;
}

/** Whether a row is still ahead: an upcoming occurrence, or a meeting not yet held. */
export function isAhead(m: CalendarMeeting): boolean {
  return m.status === 'upcoming' || m.status === 'scheduled' || m.status === 'postponed' || m.status === 'running';
}

/** The list view: upcoming (soonest first, running on top), then past (latest first). */
export function splitList(items: CalendarMeeting[]): { upcoming: CalendarMeeting[]; past: CalendarMeeting[] } {
  const upcoming = items.filter(isAhead).sort((a, b) => (a.status === 'running' ? -1 : 0) - (b.status === 'running' ? -1 : 0) || (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const past = items.filter((m) => !isAhead(m)).sort((a, b) => (a.at > b.at ? -1 : a.at < b.at ? 1 : 0));
  return { upcoming, past };
}

/** "Mon 2 Nov, 09:30" in the viewer's locale. */
export function whenText(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}, ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
}

/** "09:30" in the viewer's locale. */
export function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** A title short enough for a calendar cell: the kind and the unit, without the "Meeting: " prefix. */
export function shortTitle(m: CalendarMeeting): string {
  return m.title.replace(/^Meeting: /, '');
}

// ---- the meeting room (docs/meetings.md "During") ----

export function emptyRoom(): MeetingRoomState {
  return {
    items: [], current: 0, itemStartedAt: null, itemMinutes: 10, round: 0, roundCap: 0, extended: 0, speaking: null, attendance: {}, passes: [], present: [],
    proposals: [], preRead: '', openItems: [], verdicts: {}, answers: {}, controls: { extend: 0, skip: 0, skipped: 0, end: null }, remindedAt: null, preparedAt: null, speakers: [], skipped: null,
  };
}

/** The room JSON of a meeting row, defensively (missing → empty). */
export function parseRoom(raw: string | null | undefined): MeetingRoomState {
  const base = emptyRoom();
  if (!raw) return base;
  try {
    const v = JSON.parse(raw) as Partial<MeetingRoomState>;
    return v && typeof v === 'object' ? { ...base, ...v, controls: { ...base.controls, ...(v.controls ?? {}) } } : base;
  } catch { return base; }
}

export type SeatState = 'speaking' | 'spoke' | 'passed' | 'waiting' | 'idle' | 'present' | 'away';
export interface Seat { kind: 'agent' | 'human'; id: string; name: string; state: SeatState; facilitator: boolean }

/** The attendee strip: agents in speaking order with this round's state,
 *  then the people (present when they joined). */
export function seats(room: MeetingRoomState, attendees: Array<{ kind: 'agent' | 'human'; id: string }>, facilitatorId: string | null, name: (kind: 'agent' | 'human', id: string) => string): Seat[] {
  const agentIds = room.speakers.length ? room.speakers : attendees.filter((a) => a.kind === 'agent').map((a) => a.id);
  const people = [...new Set([...attendees.filter((a) => a.kind === 'human').map((a) => a.id), ...room.present])];
  return [
    ...agentIds.map((id) => ({ kind: 'agent' as const, id, name: name('agent', id), facilitator: id === facilitatorId, state: (room.speaking === id ? 'speaking' : room.attendance[id] ?? 'waiting') as SeatState })),
    ...people.map((id) => ({ kind: 'human' as const, id, name: name('human', id), facilitator: false, state: (room.present.includes(id) ? 'present' : 'away') as SeatState })),
  ];
}

/** Whole minutes since `iso` (0 when unknown). */
export function minutesSince(iso: string | null | undefined, now = Date.now()): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / 60_000)) : 0;
}

/** "12.3k" */
export function tokensText(n: number | null | undefined): string {
  const v = n ?? 0;
  return v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M` : v >= 1_000 ? `${(v / 1_000).toFixed(1)}k` : String(v);
}

/** The proposal a thread message announced (its inline Approve / Reject / Answer). */
export type ProposalRef = { kind: 'decision' | 'action' | 'question'; index: number; title: string };
export function proposalFor(messageId: string, minutes: Minutes): ProposalRef | null {
  const d = minutes.decisions.findIndex((x) => x.messageId === messageId);
  if (d >= 0) return { kind: 'decision', index: d, title: minutes.decisions[d].title };
  const a = minutes.actions.findIndex((x) => x.messageId === messageId);
  if (a >= 0) return { kind: 'action', index: a, title: minutes.actions[a].title };
  const q = minutes.questions.findIndex((x) => x.messageId === messageId);
  if (q >= 0) return { kind: 'question', index: q, title: minutes.questions[q].question };
  return null;
}
