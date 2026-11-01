/**
 * Quiet hours and the interrupt policy (roadmap phase 2.3).
 *
 * A workspace may declare a daily window in which the user does not want to
 * be interrupted. Loops keep running inside it — the work is the point, the
 * 7am notification is not — so what changes is only the delivery of the
 * `agent_events` rows they produce:
 *
 *  - queue        → the event carries `deliverAfter` = the end of the window;
 *                   channels push it then. The inbox shows it immediately.
 *  - silent       → the event is inbox-only (`silent` = 1), never pushed.
 *  - allow-urgent → like queue, except loop_error / budget_stop go out now.
 *
 * Wall-clock math goes through Intl so "22:00–07:00 Europe/Berlin" means the
 * user's night, not the server's, and windows that cross midnight work.
 */

export type QuietPolicy = 'queue' | 'silent' | 'allow-urgent';

export interface QuietHours {
  /** "HH:MM", 24h. */
  start: string;
  end: string;
  /** IANA zone, e.g. Europe/Berlin. */
  timezone: string;
  policy: QuietPolicy;
}

export const QUIET_POLICIES: readonly QuietPolicy[] = ['queue', 'silent', 'allow-urgent'];

/** Event kinds that `allow-urgent` lets through a quiet window. */
export const URGENT_EVENT_KINDS = new Set(['loop_error', 'budget_stop', 'org_incident']);

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Parse the stored JSON; null when off, malformed, or self-contradictory
 *  (an invalid saved value must behave like "no quiet hours", never throw
 *  inside a loop tick). Use `validateQuietHours` for user input. */
export function parseQuietHours(raw: string | null | undefined): QuietHours | null {
  if (!raw || !raw.trim()) return null;
  try {
    return validateQuietHours(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

/** Strict check for the PATCH API: throws a message fit for a 400. */
export function validateQuietHours(input: unknown): QuietHours {
  const q = input as Partial<QuietHours> | null;
  if (!q || typeof q !== 'object') throw new Error('quietHours must be an object');
  if (typeof q.start !== 'string' || !HHMM.test(q.start)) throw new Error('quietHours.start must be HH:MM');
  if (typeof q.end !== 'string' || !HHMM.test(q.end)) throw new Error('quietHours.end must be HH:MM');
  if (q.start === q.end) throw new Error('quietHours.start and end must differ (an empty window is "off")');
  if (typeof q.timezone !== 'string' || !isValidTimezone(q.timezone)) throw new Error('quietHours.timezone must be an IANA zone');
  const policy = q.policy ?? 'queue';
  if (!QUIET_POLICIES.includes(policy)) throw new Error(`quietHours.policy must be one of ${QUIET_POLICIES.join(', ')}`);
  return { start: q.start, end: q.end, timezone: q.timezone, policy };
}

const toMinutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/** The wall clock in `tz` at instant `now`, plus the zone's UTC offset at
 *  that instant (so a wall time can be mapped back to an instant). */
function wallClock(now: Date, tz: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const y = get('year'); const mo = get('month'); const d = get('day');
  const h = get('hour'); const mi = get('minute'); const s = get('second');
  // Re-reading the wall clock as if it were UTC and subtracting the real
  // instant gives the zone offset at `now`, DST included. Rounded to the
  // minute because `now` carries milliseconds the parts do not.
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  const offsetMs = Math.round((asUtc - now.getTime()) / 60_000) * 60_000;
  return { y, mo, d, minutes: h * 60 + mi, offsetMs };
}

export interface QuietState {
  quiet: boolean;
  /** Instant the current window ends (only when quiet). */
  until: Date | null;
  policy: QuietPolicy;
}

/** Is `now` inside the workspace's quiet window? Accepts the workspace row,
 *  a parsed config, or nothing (→ never quiet). */
export function isQuiet(
  source: { quietHours: string } | QuietHours | null | undefined,
  now: Date = new Date(),
): QuietState {
  const q = source && 'quietHours' in source ? parseQuietHours(source.quietHours) : source ?? null;
  if (!q) return { quiet: false, until: null, policy: 'queue' };
  const start = toMinutes(q.start);
  const end = toMinutes(q.end);
  const wall = wallClock(now, q.timezone);
  const m = wall.minutes;
  // Same-day window (09:00–17:00) vs one crossing midnight (22:00–07:00).
  const inside = start < end ? m >= start && m < end : m >= start || m < end;
  if (!inside) return { quiet: false, until: null, policy: q.policy };
  // End of the window as an instant: today's `end` on the zone's wall clock,
  // or tomorrow's when we are past midnight's near side of a crossing
  // window. The offset is taken at `now`; a DST switch inside the window
  // shifts `until` by an hour, which is a tolerable error for a notification.
  const endsTomorrow = start > end && m >= start;
  const untilWall = Date.UTC(wall.y, wall.mo - 1, wall.d + (endsTomorrow ? 1 : 0), Math.floor(end / 60), end % 60);
  return { quiet: true, until: new Date(untilWall - wall.offsetMs), policy: q.policy };
}

export interface EventDelivery {
  deliverAfter: string | null;
  silent: boolean;
}

/** How an event of `kind` created at `now` should be delivered under the
 *  workspace's quiet hours. Callers spread this into addEvent(). */
export function deliveryFor(
  source: { quietHours: string } | QuietHours | null | undefined,
  kind: string,
  now: Date = new Date(),
): EventDelivery {
  const state = isQuiet(source, now);
  if (!state.quiet || !state.until) return { deliverAfter: null, silent: false };
  if (state.policy === 'allow-urgent' && URGENT_EVENT_KINDS.has(kind)) return { deliverAfter: null, silent: false };
  if (state.policy === 'silent') return { deliverAfter: null, silent: true };
  return { deliverAfter: state.until.toISOString(), silent: false };
}
