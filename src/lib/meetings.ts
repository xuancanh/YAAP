/** The meetings list and calendar (docs/meetings.md): pure helpers for the
 *  month grid, the week agenda and the list's upcoming / past split. Dates
 *  are the viewer's local time; weeks start on Monday. */
import type { CalendarMeeting } from './api';

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
