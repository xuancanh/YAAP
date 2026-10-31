/** Small shared helpers. */

/** Parse a JSON column from the server defensively — one malformed field
 *  must not blank the whole view (pattern from store's grad()/parseApps). */
export function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** This month's workspace spend against its budget, from the raw row — the
 *  counter only counts when it belongs to the current (UTC) month, mirroring
 *  server/src/workspaces/spend.util.ts. */
export function workspaceSpend(
  ws: { spendBudgetTokens: number; spendMonth: string; spendTokens: number } | null | undefined,
  now: Date = new Date(),
): { month: string; spentTokens: number; budgetTokens: number; over: boolean } {
  const month = now.toISOString().slice(0, 7);
  if (!ws) return { month, spentTokens: 0, budgetTokens: 0, over: false };
  const spentTokens = ws.spendMonth === month ? ws.spendTokens : 0;
  const budgetTokens = ws.spendBudgetTokens ?? 0;
  return { month, spentTokens, budgetTokens, over: budgetTokens > 0 && spentTokens >= budgetTokens };
}

/** 1234 → "1.2k", 1234567 → "1.2M". */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
