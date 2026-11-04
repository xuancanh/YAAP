---json
{ "title": "Month-end close checklist", "summary": "A day-by-day close calendar (WD1 to WD5) with the order of tasks, dependencies and what to do when a step slips.", "tags": ["close", "checklist", "calendar", "month-end"], "updated": "2026-11-04" }
---

# Month-end close checklist

The close is a dependency chain. Revenue can't be final until billing is final; the balance sheet review can't start until the sub-ledgers are closed. Work in this order and you'll rarely redo a step.

Adjust the days to the company's close calendar in `/org/finance/`. The sequence matters more than the exact day.

## Before month end (last 3 working days)

- [ ] Send cut-off reminders: bills and expense claims for the month due by a set date; receipts of goods confirmed.
- [ ] Ask budget owners about anything received but not yet invoiced (feeds accruals).
- [ ] Check last month's open exceptions. Anything still open goes on this month's list with its age.
- [ ] Confirm the billing run date with the Billing Specialist so deferred revenue can be rolled forward.

## WD1: cash and sub-ledgers

- [ ] Download bank and card statements for every account, dated the last calendar day.
- [ ] Bank reconciliations (see [reconciliation method](reconciliation-method.md)).
- [ ] Payables: all bills dated in the month entered; AP ageing run as at month end.
- [ ] Receivables: invoices issued in the month posted; AR ageing run as at month end.
- [ ] Payroll journal posted from the payroll provider's report.

## WD2: accruals and schedules

- [ ] Reverse last month's accruals (or confirm auto-reversal ran).
- [ ] Book new accruals with their basis (see [accruals, prepaids and deferrals](accruals-prepaids-deferrals.md)).
- [ ] Prepaid amortisation from the schedule.
- [ ] Fixed asset additions and depreciation.
- [ ] Deferred revenue roll-forward tied to the billing system.

## WD3: balance sheet

- [ ] Reconcile every account above materiality to its support.
- [ ] Clear suspense and clearing accounts or list what's in them.
- [ ] Intercompany balances agree on both sides (if there is more than one entity).
- [ ] Tax accounts tie to the returns or workings (rules are jurisdiction-specific; confirm treatment with the tax adviser).

## WD4: review and fix

- [ ] Submit reconciliations and journals for review.
- [ ] Clear review comments the same day.
- [ ] Draft a flux review: P&L and balance sheet lines that moved more than the threshold month on month, with a one-line reason. The FP&A Analyst uses these for variance commentary.

## WD5: lock

- [ ] Final trial balance saved to the close folder.
- [ ] Exceptions list with owner, age and plan.
- [ ] Close the period in the ledger only when the Head of Finance says so.
- [ ] Note what slowed this close and one change for next month.

## When a step slips

1. Say so the moment you know, with the cause and a new date, on the close task.
2. Say what's blocked downstream. A late bank rec blocks the cash line in the flux review; a late billing run blocks deferred revenue.
3. Offer a fallback: book an estimate with the basis written down and true it up next month, if the Head of Finance agrees.
4. Never mark a task done to hit the calendar. A tied reconciliation one day late beats a "done" one that doesn't tie.

## Pitfalls

- **Starting the balance sheet review before accruals are in.** You'll reconcile twice.
- **Reconciling to the ledger instead of an outside record.** The ledger can't prove itself.
- **Leaving the flux review to the end.** It finds errors; you want them found on WD4, not after lock.
- **Doing everything yourself.** Ask owners for facts early; waiting for an answer is the main cause of slips.

## Close file layout

Keep one folder per month: `/org/finance/close/<yyyy-mm>/` with `checklist.md` (task, owner, due day, status, link), `recs/`, `journals/`, `flux.md` and `exceptions.md`. A reviewer should be able to check any number from this folder alone.
