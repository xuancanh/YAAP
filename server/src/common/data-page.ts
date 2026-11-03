/**
 * Bounded output for the agent data tools (docs/agent-data-access.md §3):
 * one compact line per row, a limit with a hard ceiling, an offset to page,
 * and a footer that says how to get the rest. Pure.
 */

export interface PageInput { limit?: unknown; offset?: unknown }

/** The rows of one page, the header line and the "more" footer. */
export function pageOf(rows: string[], input: PageInput, opts: { def?: number; max?: number; header?: string; empty?: string } = {}): string {
  const def = opts.def ?? 20;
  const max = opts.max ?? 60;
  const limit = clampInt(input.limit, def, 1, max);
  const offset = clampInt(input.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  if (rows.length === 0) return opts.empty ?? 'Nothing to show.';
  const slice = rows.slice(offset, offset + limit);
  const out: string[] = [];
  if (opts.header) out.push(opts.header);
  if (slice.length === 0) out.push(`(offset ${offset} is past the end: ${rows.length} row(s))`);
  else out.push(...slice);
  const end = offset + slice.length;
  if (end < rows.length) out.push(`… ${offset + 1}–${end} of ${rows.length}; pass offset: ${end} for more.`);
  return out.join('\n');
}

export function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export const clip = (s: string | null | undefined, n: number): string => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** A case-insensitive match of `q` against any of the fields ('' matches all). */
export function matches(q: unknown, ...fields: Array<string | null | undefined>): boolean {
  const needle = typeof q === 'string' ? q.trim().toLowerCase() : '';
  if (!needle) return true;
  return fields.some((f) => (f ?? '').toLowerCase().includes(needle));
}

/** Shared JSON-schema properties of a paged data tool. */
export const PAGE_PROPS = {
  q: { type: 'string' },
  limit: { type: 'number' },
  offset: { type: 'number' },
} as const;
