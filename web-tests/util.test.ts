import { describe, expect, it } from 'vitest';
import { safeJsonParse } from '../src/lib/util';

describe('safeJsonParse', () => {
  it('parses valid JSON', () => {
    expect(safeJsonParse('{"a":1}', {})).toEqual({ a: 1 });
    expect(safeJsonParse<string[]>('["x","y"]', [])).toEqual(['x', 'y']);
  });

  it('returns the fallback for corrupt JSON', () => {
    expect(safeJsonParse('{"a":', { ok: false })).toEqual({ ok: false });
    expect(safeJsonParse('not json at all', 'fb')).toBe('fb');
  });

  it('returns the fallback for null/undefined/empty input', () => {
    expect(safeJsonParse(null, 42)).toBe(42);
    expect(safeJsonParse(undefined, 42)).toBe(42);
    expect(safeJsonParse('', 42)).toBe(42);
  });
});
