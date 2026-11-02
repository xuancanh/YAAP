/**
 * Minimal five-field cron matcher for agent loops (FR-11.6):
 * `minute hour day-of-month month day-of-week`, supporting `*`, numbers,
 * comma lists, ranges (a-b), and steps (*\/n). Anything unparsable (e.g. the
 * design's "on merge" event loops) simply never matches — event triggers are
 * a different mechanism.
 *
 * Matching is in SERVER-LOCAL time (Date.getHours() & friends): a loop fires
 * by the host's wall clock, including across DST changes — there is no
 * per-loop timezone. Keep the host in the timezone you want loops to follow
 * (TZ env var).
 */
export function matchField(field: string, value: number): boolean {
  for (const part of field.split(',')) {
    if (part === '*') return true;
    const step = /^\*\/(\d+)$/.exec(part);
    if (step) { if (value % parseInt(step[1], 10) === 0) return true; continue; }
    const range = /^(\d+)-(\d+)$/.exec(part);
    if (range) {
      const lo = parseInt(range[1], 10);
      const hi = parseInt(range[2], 10);
      if (value >= lo && value <= hi) return true;
      continue;
    }
    if (/^\d+$/.test(part) && parseInt(part, 10) === value) return true;
  }
  return false;
}

export function cronMatches(expr: string, date: Date): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const [m, h, dom, mon, dow] = fields;
  if (![m, h, dom, mon, dow].every((f) => /^[\d*,/-]+$/.test(f))) return false;
  return (
    matchField(m, date.getMinutes()) &&
    matchField(h, date.getHours()) &&
    matchField(dom, date.getDate()) &&
    matchField(mon, date.getMonth() + 1) &&
    matchField(dow, date.getDay())
  );
}
