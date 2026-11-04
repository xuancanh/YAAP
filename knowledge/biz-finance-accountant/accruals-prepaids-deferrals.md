---json
{ "title": "Accruals, prepaids and deferrals", "summary": "Definitions, journal patterns and worked examples for month-end accruals, prepaid expenses and deferred revenue, plus how to estimate and reverse.", "tags": ["accruals", "prepaids", "deferred-revenue", "journals", "close"], "updated": "2026-11-04",
  "sources": [{ "title": "IFRS 15 Revenue from Contracts with Customers (IFRS Foundation), accessed 2026-11-04", "url": "https://www.ifrs.org/issued-standards/list-of-standards/ifrs-15-revenue-from-contracts-with-customers/" }] }
---

# Accruals, prepaids and deferrals

All three exist for one reason: put income and cost in the month they belong to, not the month cash moved or the invoice arrived.

| | What happened | Balance sheet item | Journal at month end |
|---|---|---|---|
| **Accrual** | We received a service, no invoice yet | Liability (accrued expenses) | Dr expense, Cr accruals |
| **Prepaid** | We paid or were invoiced for a future period | Asset (prepayments) | Dr prepayments, Cr AP/cash; then monthly Dr expense, Cr prepayments |
| **Deferred revenue** | We invoiced a customer for a future period | Liability (deferred revenue) | Dr AR, Cr deferred revenue; then as earned Dr deferred revenue, Cr revenue |

## Accruals

**Find them.** Look for: recurring vendors whose invoice usually arrives after month end; purchase orders marked received but not billed; contractors' hours for the month; utilities; payroll days worked but paid next month; bonuses or commissions earned.

**Estimate them.** Use the best basis you have and write it down:

1. The contract or PO price for what was delivered.
2. A usage report (seats, hours, API calls) times the rate.
3. The last invoice, if usage is stable.
4. The budget owner's estimate, labelled as such.

**Example.** A contractor bills monthly in arrears at a day rate. In October they worked 12 days at 500. The invoice will arrive on 8 November.
- 31 Oct: Dr Contractor costs 6,000 / Cr Accrued expenses 6,000. Basis: timesheet, rate per contract.
- 1 Nov: auto-reverse. Dr Accrued expenses 6,000 / Cr Contractor costs 6,000.
- 8 Nov: invoice posted for 6,000 to Contractor costs. Net November effect: zero.

If the invoice comes in at 6,250, November takes the 250 difference. If differences are often large, improve the basis rather than living with the swing.

**Materiality.** Don't accrue every small bill. Use the threshold in `/org/finance/kpis.md`. Being consistent month to month matters more than catching every item.

## Prepaids

Use a schedule, one row per item: vendor, invoice, total, start date, end date, months, monthly amount, booked to date, remaining balance.

**Example.** Annual software licence of 12,000 invoiced 15 October for 1 November to 31 October next year.
- On posting: Dr Prepayments 12,000 / Cr AP 12,000.
- From November: Dr Software 1,000 / Cr Prepayments 1,000 each month.
- The schedule's remaining balance must equal the prepayments ledger balance every month.

Pitfalls: amortising from the invoice date instead of the service start date; forgetting to split a bill that is partly this month and partly future; leaving a cancelled contract on the schedule.

## Deferred revenue

Deferred revenue is driven by billing and by when the company meets its promises to the customer. Under both IFRS 15 and ASC 606, revenue is recognised when (or as) a performance obligation is satisfied, using a five-step model: identify the contract, identify the performance obligations, determine the price, allocate it, recognise revenue as each obligation is met.

The roll-forward that must tie each month:

> Opening deferred revenue + billings in the month − revenue recognised in the month = closing deferred revenue

Tie the closing balance to the billing system's deferred revenue report. A difference usually means an invoice was posted straight to revenue, or a credit note wasn't reflected.

**Example.** A 12-month subscription of 2,400 invoiced upfront on 1 October. October: Dr AR 2,400 / Cr Deferred revenue 2,400; then Dr Deferred revenue 200 / Cr Revenue 200. Closing deferred revenue for this contract: 2,200.

**Revenue recognition is judgment-heavy and standard-specific.** Bundles, usage pricing, discounts, set-up fees and contract changes can all change the answer. Prepare the roll-forward; route anything unusual to the Head of Finance and the company's accountants rather than deciding the policy yourself.

## Checklist before you submit

- [ ] Each journal links to its support (timesheet, contract, schedule row).
- [ ] Last month's accruals reversed, and the matching invoices booked.
- [ ] Prepaid and deferred revenue schedules tie to the ledger.
- [ ] Basis written next to every estimate.
