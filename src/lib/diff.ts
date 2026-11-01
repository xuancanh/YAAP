/** Line diff via LCS — small inputs (skill instructions), no dependency.
 *  Used by the Skills page to show an agent's proposed revision against the
 *  live text before the user accepts it (execution-plan item 10). */

export type DiffOp = { kind: 'same' | 'add' | 'del'; text: string };

export function lineDiff(before: string, after: string): DiffOp[] {
  const a = before.split('\n');
  const b = after.split('\n');
  // Guard: the table is (n+1)(m+1); cap pathological inputs by falling back
  // to a whole-replace, which is still a correct (if blunt) diff.
  if (a.length * b.length > 4_000_000) {
    return [...a.map((text) => ({ kind: 'del' as const, text })), ...b.map((text) => ({ kind: 'add' as const, text }))];
  }
  const n = a.length;
  const m = b.length;
  // lcs[i][j] = LCS length of a[i:] and b[j:]
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ kind: 'same', text: a[i] }); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { out.push({ kind: 'del', text: a[i] }); i++; }
    else { out.push({ kind: 'add', text: b[j] }); j++; }
  }
  while (i < n) out.push({ kind: 'del', text: a[i++] });
  while (j < m) out.push({ kind: 'add', text: b[j++] });
  return out;
}

export function diffStats(ops: DiffOp[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.kind === 'add') added++;
    if (op.kind === 'del') removed++;
  }
  return { added, removed };
}
