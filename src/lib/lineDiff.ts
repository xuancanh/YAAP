/** A line diff for the conflict view (docs/filesystem.md "Editing"): common
 *  prefix and suffix trimmed, LCS on what is left (capped; past the cap the
 *  middle shows as removed + added). */
export interface DiffLine { kind: 'same' | 'add' | 'del'; text: string }

const CAP = 1500;

export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.replace(/\r\n/g, '\n').split('\n');
  const b = after.replace(/\r\n/g, '\n').split('\n');
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let e = 0;
  while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
  const head = a.slice(0, s).map((text): DiffLine => ({ kind: 'same', text }));
  const tail = a.slice(a.length - e).map((text): DiffLine => ({ kind: 'same', text }));
  const am = a.slice(s, a.length - e);
  const bm = b.slice(s, b.length - e);
  let mid: DiffLine[];
  if (am.length > CAP || bm.length > CAP) {
    mid = [...am.map((text): DiffLine => ({ kind: 'del', text })), ...bm.map((text): DiffLine => ({ kind: 'add', text }))];
  } else {
    const n = am.length; const m = bm.length;
    const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = am[i] === bm[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    mid = [];
    let i = 0; let j = 0;
    while (i < n && j < m) {
      if (am[i] === bm[j]) { mid.push({ kind: 'same', text: am[i] }); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) mid.push({ kind: 'del', text: am[i++] });
      else mid.push({ kind: 'add', text: bm[j++] });
    }
    while (i < n) mid.push({ kind: 'del', text: am[i++] });
    while (j < m) mid.push({ kind: 'add', text: bm[j++] });
  }
  return [...head, ...mid, ...tail];
}

/** Collapse long unchanged runs to `context` lines around each change. */
export function withContext(lines: DiffLine[], context = 3): Array<DiffLine | { kind: 'skip'; count: number }> {
  const keep = lines.map(() => false);
  lines.forEach((l, i) => { if (l.kind !== 'same') for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true; });
  const out: Array<DiffLine | { kind: 'skip'; count: number }> = [];
  let skipped = 0;
  lines.forEach((l, i) => {
    if (keep[i]) { if (skipped) { out.push({ kind: 'skip', count: skipped }); skipped = 0; } out.push(l); } else skipped++;
  });
  if (skipped) out.push({ kind: 'skip', count: skipped });
  return out;
}
