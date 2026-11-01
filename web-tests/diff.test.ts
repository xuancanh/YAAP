import { describe, expect, it } from 'vitest';
import { lineDiff, diffStats } from '../src/lib/diff';

describe('lineDiff', () => {
  it('marks unchanged lines as same', () => {
    expect(lineDiff('a\nb', 'a\nb')).toEqual([{ kind: 'same', text: 'a' }, { kind: 'same', text: 'b' }]);
  });

  it('finds an inserted and a removed line around a common core', () => {
    const ops = lineDiff('1. Reconcile.\n2. Report.', '1. Reconcile every account.\n2. Report.\n3. File the summary.');
    expect(ops).toEqual([
      { kind: 'del', text: '1. Reconcile.' },
      { kind: 'add', text: '1. Reconcile every account.' },
      { kind: 'same', text: '2. Report.' },
      { kind: 'add', text: '3. File the summary.' },
    ]);
    expect(diffStats(ops)).toEqual({ added: 2, removed: 1 });
  });

  it('handles empty sides', () => {
    expect(lineDiff('', 'x')).toEqual([{ kind: 'del', text: '' }, { kind: 'add', text: 'x' }]);
    expect(lineDiff('x', '')).toEqual([{ kind: 'del', text: 'x' }, { kind: 'add', text: '' }]);
  });

  it('keeps the longest common subsequence when lines move', () => {
    const ops = lineDiff('a\nb\nc\nd', 'b\nc\nd\na');
    expect(ops.filter((o) => o.kind === 'same').map((o) => o.text)).toEqual(['b', 'c', 'd']);
    expect(diffStats(ops)).toEqual({ added: 1, removed: 1 });
  });
});
