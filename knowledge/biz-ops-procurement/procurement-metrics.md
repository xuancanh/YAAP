---json
{ "title": "Procurement metrics", "summary": "Definitions and formulas for vendor spend versus budget, renewals decided before notice and seat utilisation, plus the monthly register reconciliation.", "tags": ["kpis", "spend", "renewals", "seat-utilisation", "reconciliation"], "updated": "2026-11-04" }
---

# Procurement metrics

Your three KPIs answer three questions: are we spending what we planned, are renewals being decided on purpose, and are we using what we pay for. Define each period and source when you report, and label any figure that comes from an estimate rather than Finance's records.

## Vendor spend versus budget

**Formula:**
- **Variance** = actual vendor spend − budgeted vendor spend, for the period.
- **Variance %** = variance ÷ budgeted spend × 100.

Report it in total and by category or owner, so one large overrun is not hidden by underspend elsewhere.

**Counting rules:**
- Use Finance's spend records as the source of actuals. Say whether they are on a cash basis (when paid) or an accrual basis (when the service is used); an annual prepayment looks very different in each. Ask Finance which basis the budget uses and match it.
- Annual contracts: compare against the budget phased the same way.
- Include spend on cards and expenses, not only invoiced vendors. Card spend is where untracked tools appear.

**What to do with a variance:** explain it by vendor (new purchase, price rise, overage, usage growth, timing) and say whether it will recur.

## Renewals decided before notice

**What it answers:** did every renewal get a deliberate decision in time to act on it?

**Formula:** renewals in the period with a recorded decision (renew, renegotiate, right-size, exit) dated before the notice deadline ÷ renewals whose notice deadline fell in the period.

**Counting rules:**
- The period is defined by the notice deadline, not the renewal date.
- "Decided" means a human decision is recorded on the renewal task. Your recommendation alone does not count.
- A contract with no notice period (month-to-month) counts when its decision is recorded before the next billing date.
- A renewal discovered only after it renewed counts as a miss and is listed by name, with how it was missed (not in register, wrong date, task not acted on).

**Lever:** the 90-day look-ahead in the monthly scan. Misses usually come from register gaps, so the reconciliation below protects this metric.

## Seat utilisation

**Formula (per tool):** active users in the period ÷ paid seats × 100.

**Counting rules:**
- Define "active" per tool and write it in the register: for example, logged in or performed a core action in the last 30 days. A login-only definition can overstate use.
- Use the tool's admin report where available; label manual counts.
- Report a company-wide figure weighted by cost: Σ (utilisation × annual cost) ÷ Σ annual cost. A small tool at low use matters less than an expensive one.
- Flag tools below the threshold in the register (your playbook uses 70%) and list the reclaim action: remove inactive users, true-down at renewal, move to a lower tier.

## Monthly register reconciliation

Run it before computing the metrics.

1. Pull the period's payees from Finance's records.
2. Match each payee to a register row. **Unmatched payee** → a vendor not in the register: add it with an owner, or flag it as untracked spend.
3. Match each register row to spend. **Row with no spend** → the contract may have ended, billing may have moved, or the record is wrong: confirm with the owner.
4. Compare amounts. **Amount differs** from the register's cost → price change, overage or a different billing cycle; update the row and note why in the change log.
5. Check that every row with a renewal in the next 90 days has a notice date and method.

## Reporting

```
| KPI | This month | Last month | Notes |
|---|---|---|---|
| Spend vs budget | +x% | | overage on <tool>; new <tool> approved |
| Renewals decided before notice | 4/4 | 3/4 | |
| Seat utilisation (cost-weighted) | | | 2 tools below threshold |
| Reconciliation | 2 unmatched payees | | added to register |
```
