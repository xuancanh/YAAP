/** Pure helpers for the Account pane (docs/accounts.md §4): how a plan and
 *  its month read on screen. Kept out of the component so they are testable. */
import type { AccountSummary, Plan } from './api';

export const PLAN_LABEL: Record<Plan, string> = {
  free: 'Free — your own keys, up to 3 agents and 3 loops',
  hosted: 'Hosted — platform keys with a monthly ceiling',
  byo: 'Bring your own keys — no ceiling but your workspace budget',
};

/** 0–100 share of the hosted ceiling spent; null when the plan has none. */
export function ceilingPct(a: Pick<AccountSummary, 'limits' | 'usage'>): number | null {
  if (a.limits.hostedUsd <= 0) return null;
  return Math.min(100, Math.round((a.usage.hostedUsd / a.limits.hostedUsd) * 100));
}

/** "$1.23 of $15.00 hosted this month" / "$1.23 this month on your keys". */
export function usageLine(a: Pick<AccountSummary, 'limits' | 'usage' | 'plan'>): string {
  const usd = (n: number) => `$${n.toFixed(2)}`;
  if (a.limits.hostedUsd > 0) return `${usd(a.usage.hostedUsd)} of ${usd(a.limits.hostedUsd)} hosted this month`;
  return `${usd(a.usage.usd)} this month on your keys`;
}

/** "2 of 3 agents" or "2 agents" when unlimited. */
export function capLine(used: number, max: number, noun: string): string {
  return max > 0 ? `${used} of ${max} ${noun}` : `${used} ${noun}`;
}
