/**
 * Workspace-level monthly spend stop (roadmap phase 2.5). The counter on the
 * workspace row is `spendTokens` for `spendMonth`; reading it through
 * `spendStatus` applies the month boundary, so a stale row from last month
 * reads as zero without anyone having to run a reset job.
 */

export interface SpendStatus {
  /** 'YYYY-MM' in UTC — the month the counter is for. */
  month: string;
  spentTokens: number;
  /** 0 = unlimited. */
  budgetTokens: number;
  /** Budget set and reached: loops are refused, user turns are warned. */
  over: boolean;
}

export const monthKey = (now: Date = new Date()): string => now.toISOString().slice(0, 7);

export function spendStatus(
  ws: { spendBudgetTokens: number; spendMonth: string; spendTokens: number } | null | undefined,
  now: Date = new Date(),
): SpendStatus {
  const month = monthKey(now);
  if (!ws) return { month, spentTokens: 0, budgetTokens: 0, over: false };
  const spentTokens = ws.spendMonth === month ? ws.spendTokens : 0;
  const budgetTokens = ws.spendBudgetTokens ?? 0;
  return { month, spentTokens, budgetTokens, over: budgetTokens > 0 && spentTokens >= budgetTokens };
}
