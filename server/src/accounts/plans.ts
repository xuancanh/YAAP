/**
 * Plans (docs/accounts.md §4). Three, deliberately legible:
 *
 *  free    — bring your own provider keys; up to 3 agents and 3 enabled
 *            loops. The hosted equivalent of the free desktop tier.
 *  hosted  — the platform's provider keys (PLATFORM_*_KEY) with a monthly
 *            USD ceiling (HOSTED_PLAN_USD, default 15) enforced as a hard
 *            stop like the workspace budget; own keys still allowed and not
 *            metered against the ceiling.
 *  byo     — own keys, no ceiling but the workspace budget. The plan every
 *            AUTH_MODE=single install is on, and what an admin hands a
 *            paying customer who wants to bring their own keys.
 *
 * Billing is out of scope here: BillingProvider (billing-provider.ts) is the
 * seam, `manual` the only implementation.
 */

export type Plan = 'free' | 'hosted' | 'byo';

export const PLANS: readonly Plan[] = ['free', 'hosted', 'byo'];

export interface PlanLimits {
  /** 0 = unlimited. */
  maxAgents: number;
  /** Enabled loops across all agents; 0 = unlimited. */
  maxLoops: number;
  /** Platform provider keys may be used. */
  hostedKeys: boolean;
  /** Monthly USD ceiling on platform-key usage; 0 = none. */
  hostedUsd: number;
}

export function isPlan(value: unknown): value is Plan {
  return typeof value === 'string' && (PLANS as readonly string[]).includes(value);
}

export function limitsFor(plan: Plan, hostedUsd: number): PlanLimits {
  switch (plan) {
    case 'free': return { maxAgents: 3, maxLoops: 3, hostedKeys: false, hostedUsd: 0 };
    case 'hosted': return { maxAgents: 0, maxLoops: 0, hostedKeys: true, hostedUsd: Math.max(0, hostedUsd) };
    case 'byo': return { maxAgents: 0, maxLoops: 0, hostedKeys: false, hostedUsd: 0 };
  }
}
