/**
 * BillingProvider — the seam where payments plug in later (docs/accounts.md
 * §5). Today's only implementation is `manual`: an admin (ADMIN_EMAILS) sets
 * the plan with PATCH /api/admin/accounts/:id. A Stripe or Paddle provider
 * implements the same interface — webhook → setPlan — and is bound in
 * AccountsModule by BILLING_PROVIDER; nothing else in the app knows which.
 */
import type { Plan } from './plans';

export const BILLING_PROVIDER = 'BILLING_PROVIDER';

export interface BillingProvider {
  readonly name: string;
  /** Where the UI sends someone who wants to change plan; null = nowhere
   *  (manual: ask the operator). */
  manageUrl(accountId: string): Promise<string | null>;
  /** Hook for providers that must mirror a plan change upstream. The manual
   *  provider accepts everything. */
  onPlanChanged(accountId: string, plan: Plan, by: string): Promise<void>;
}

export class ManualBillingProvider implements BillingProvider {
  readonly name = 'manual';
  async manageUrl(): Promise<string | null> { return null; }
  async onPlanChanged(): Promise<void> { /* nothing upstream to tell */ }
}
