import { describe, expect, it } from 'vitest';
import { cronMatches, nextFire, untilLabel } from '../src/lib/cron';

// Local-time dates; the matcher uses getMinutes/getHours/etc.
const at = (min: number, hour: number, day = 5, month = 1) =>
  new Date(2026, month - 1, day, hour, min, 0); // 2026-01-05 is a Monday

describe('cronMatches', () => {
  it('matches a wildcard schedule at any time', () => {
    expect(cronMatches('* * * * *', at(7, 3))).toBe(true);
    expect(cronMatches('* * * * *', at(59, 23, 31, 12))).toBe(true);
  });

  it('matches steps within a field', () => {
    expect(cronMatches('*/15 * * * *', at(0, 9))).toBe(true);
    expect(cronMatches('*/15 * * * *', at(30, 9))).toBe(true);
    expect(cronMatches('*/15 * * * *', at(31, 9))).toBe(false);
  });

  it('matches a specific minute and hour', () => {
    expect(cronMatches('30 9 * * *', at(30, 9))).toBe(true);
    expect(cronMatches('30 9 * * *', at(31, 9))).toBe(false);
    expect(cronMatches('30 9 * * *', at(30, 8))).toBe(false);
  });

  it('matches lists and ranges', () => {
    expect(cronMatches('0 9,17 * * *', at(0, 17))).toBe(true);
    expect(cronMatches('0 9,17 * * *', at(0, 12))).toBe(false);
    expect(cronMatches('0 9-17 * * *', at(0, 12))).toBe(true);
    expect(cronMatches('0 9-17 * * *', at(0, 20))).toBe(false);
  });

  it('matches day-of-month and day-of-week fields', () => {
    expect(cronMatches('0 0 1 * *', at(0, 0, 1))).toBe(true);
    expect(cronMatches('0 0 1 * *', at(0, 0, 2))).toBe(false);
    expect(cronMatches('0 9 * * 1', at(0, 9))).toBe(true); // Monday
    expect(cronMatches('0 9 * * 2', at(0, 9))).toBe(false);
  });

  it('never matches junk expressions', () => {
    expect(cronMatches('banana', at(0, 0))).toBe(false);
    expect(cronMatches('* * * *', at(0, 0))).toBe(false); // 4 fields
    expect(cronMatches('* * * * * *', at(0, 0))).toBe(false); // 6 fields
    expect(cronMatches('', at(0, 0))).toBe(false);
    expect(cronMatches('*/0 * * * *', at(0, 0))).toBe(false); // step 0
  });
});

describe('nextFire', () => {
  it('finds the next quarter hour for */15', () => {
    const from = new Date(2026, 0, 5, 10, 7, 33);
    expect(nextFire('*/15 * * * *', from)).toEqual(new Date(2026, 0, 5, 10, 15, 0));
  });

  it('returns null for an impossible date (Feb 30)', () => {
    expect(nextFire('0 0 30 2 *', new Date(2026, 0, 5, 10, 0, 0))).toBeNull();
  });
});

describe('untilLabel', () => {
  const from = new Date(2026, 0, 5, 10, 0, 0);
  const plus = (mins: number) => new Date(from.getTime() + mins * 60_000);

  it('labels minutes, hours, and days', () => {
    expect(untilLabel(plus(45), from)).toBe('in 45m');
    expect(untilLabel(plus(5 * 60 + 5), from)).toBe('in 5h 05m');
    expect(untilLabel(plus(3 * 24 * 60), from)).toBe('in 3d');
  });
});
