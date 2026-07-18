/** Client-side 5-field cron helpers for the fleet overview: mirror of the
 *  server matcher (minute hour day-of-month month day-of-week; supports
 *  `*`, lists, ranges, and steps). Junk expressions never match. */

function fieldMatches(field: string, value: number): boolean {
  for (const part of field.split(',')) {
    const step = /^(.+)\/(\d+)$/.exec(part);
    const base = step ? step[1] : part;
    const every = step ? parseInt(step[2], 10) : 1;
    if (!every || every < 1) continue;
    let lo: number; let hi: number;
    if (base === '*') { lo = 0; hi = 59 + 12; } // wide bounds; exact range unused for '*'
    else {
      const range = /^(\d+)-(\d+)$/.exec(base);
      if (range) { lo = parseInt(range[1], 10); hi = parseInt(range[2], 10); }
      else if (/^\d+$/.test(base)) { lo = hi = parseInt(base, 10); }
      else return false;
    }
    if (base === '*') { if ((value % every) === 0 || every === 1) return true; continue; }
    if (value >= lo && value <= hi && (value - lo) % every === 0) return true;
  }
  return false;
}

export function cronMatches(expr: string, d: Date): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const [min, hour, dom, mon, dow] = fields;
  return fieldMatches(min, d.getMinutes())
    && fieldMatches(hour, d.getHours())
    && fieldMatches(dom, d.getDate())
    && fieldMatches(mon, d.getMonth() + 1)
    && fieldMatches(dow, d.getDay());
}

/** Next fire time within 8 days, or null (invalid / far away). */
export function nextFire(expr: string, from = new Date()): Date | null {
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < 8 * 24 * 60; i++) {
    if (cronMatches(expr, d)) return d;
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

/** "in 2h 05m" / "in 3d" style label. */
export function untilLabel(at: Date, from = new Date()): string {
  const mins = Math.max(1, Math.round((at.getTime() - from.getTime()) / 60_000));
  if (mins < 60) return `in ${mins}m`;
  if (mins < 48 * 60) return `in ${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
  return `in ${Math.round(mins / (24 * 60))}d`;
}
