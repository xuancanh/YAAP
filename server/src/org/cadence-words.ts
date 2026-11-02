/**
 * A five-field cron in words, server side — the wording the SPA's
 * `cadenceText` (src/lib/home.ts) uses for Coming up, so a ritual reads the
 * same in /org/calendar.md and on Home: "Fridays at 16:00", "every weekday at
 * 09:30", "1st of each month at 08:00", "every 2 hours". Crons are
 * server-local and so is this text (24-hour clock; the files say "server
 * time"). Anything odder stays the raw cron. Pure.
 */
const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function dowSet(field: string): Set<number> | null {
  const days = new Set<number>();
  for (const part of field.split(',')) {
    const range = /^(\d)-(\d)$/.exec(part);
    if (range) { for (let d = Number(range[1]); d <= Number(range[2]); d++) days.add(d % 7); continue; }
    if (/^\d$/.test(part)) { days.add(Number(part) % 7); continue; }
    return null;
  }
  return days.size ? days : null;
}

function daysWords(days: Set<number>): string {
  const list = [...days].sort((a, b) => a - b);
  const key = list.join(',');
  if (key === '0,1,2,3,4,5,6') return 'every day';
  if (key === '1,2,3,4,5') return 'every weekday';
  if (key === '0,6') return 'weekends';
  if (list.length === 1) return `${DOW[list[0]]}s`;
  const names = list.map((d) => `${DOW[d]}s`);
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

const ordinal = (n: number): string => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;
const pad = (n: number): string => String(n).padStart(2, '0');

export function cadenceWords(cron: string): string {
  const f = (cron ?? '').trim().split(/\s+/);
  if (f.length !== 5) return cron;
  const [min, hour, dom, mon, dow] = f;
  if (mon !== '*') return cron;
  const time = /^\d+$/.test(min) && /^\d+$/.test(hour) ? `${pad(Number(hour))}:${pad(Number(min))}` : null;
  if (dom === '*' && time) {
    if (dow === '*') return `every day at ${time}`;
    const days = dowSet(dow);
    return days ? `${daysWords(days)} at ${time}` : cron;
  }
  if (dow === '*' && /^\d+$/.test(dom) && time) return `${ordinal(Number(dom))} of each month at ${time}`;
  // "0 9 1-7 * 1": the first <weekday> of each month.
  const firstWeek = /^1-7$/.test(dom) && /^\d$/.test(dow);
  if (firstWeek && time) return `first ${DOW[Number(dow) % 7]} of each month at ${time}`;
  if (dom === '*' && dow === '*') {
    const everyH = /^\*\/(\d+)$/.exec(hour);
    if (/^\d+$/.test(min) && everyH) return `every ${everyH[1]} hours`;
    if (/^\d+$/.test(min) && hour === '*') return 'every hour';
    const everyM = /^\*\/(\d+)$/.exec(min);
    if (everyM && hour === '*') return `every ${everyM[1]} minutes`;
  }
  return cron;
}
