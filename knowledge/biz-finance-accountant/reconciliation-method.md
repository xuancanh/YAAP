---json
{ "title": "Reconciliation method", "summary": "How to reconcile bank and balance sheet accounts so the proof ties, items are classified correctly and nothing ages unseen, with a worked example.", "tags": ["reconciliation", "bank", "balance-sheet", "close"], "updated": "2026-11-04" }
---

# Reconciliation method

A reconciliation proves a ledger balance against something outside the ledger. If it can't show "outside balance ± listed items = ledger balance" to the cent, it isn't done.

## The three questions

1. **What is the independent balance?** Bank statement, card statement, sub-ledger report, loan statement, payroll provider report, vendor statement, a schedule built from contracts. Write its name and date.
2. **What explains the difference?** Every item, listed individually, with date, amount and reference.
3. **Which items are wrong, and which are just timing?** Wrong items get a journal. Timing items stay on the rec with an expected clear date.

## Classifying reconciling items

| Item | Side | Typical treatment |
|---|---|---|
| Bank fee, interest, FX charge not yet booked | In bank, not ledger | Journal now |
| Customer receipt not yet applied | In bank, not ledger | Apply to the invoice; if unknown, post to unapplied cash and investigate |
| Direct debit not yet recorded | In bank, not ledger | Book against the bill; if no bill, find out why |
| Payment sent, not yet cleared | In ledger, not bank | Timing; should clear in days |
| Deposit recorded, not yet credited | In ledger, not bank | Timing; chase if it doesn't clear |
| Duplicate or wrong-amount entry | Either | Correcting journal |

The rule: if the item belongs in the ledger for this period, book it. Don't carry fixable items forward as "reconciling".

## Steps that save time

- **Match exact first.** Same amount, same date, same reference. That clears most lines.
- **Then match groups.** One deposit for several receipts; one batch payment for several bills. Sum the group and match the total.
- **Then near-matches.** Same amount a few days apart; amount off by a fee. Look at these by hand.
- **Last, the leftovers.** These are your reconciling items. If the list is long, check that you used the right statement date and the right account before you investigate lines one by one.

## Worked example

Operating account, 31 October.

| | Amount |
|---|---|
| Bank statement closing balance | 48,200.00 |
| Less: payment to vendor A, sent 30 Oct, not cleared | (3,500.00) |
| Add: customer receipt deposited 31 Oct, credited 1 Nov | 1,250.00 |
| Adjusted bank balance | 45,950.00 |
| Ledger balance before adjustments | 46,010.00 |
| Less: bank fee not booked (journal drafted) | (60.00) |
| Adjusted ledger balance | 45,950.00 |
| **Difference** | **0.00** |

The fee gets a journal. The two timing items stay on the rec with expected clear dates of 2 and 1 November. Next month, check that they cleared. If one hasn't cleared by the ageing threshold, it becomes an exception.

## Balance sheet accounts

Use the same proof with a different "outside" record:

- **Receivables / payables:** ledger control account vs ageing report total. A difference usually means a manual journal hit the control account.
- **Prepaids / accruals / deferred revenue:** ledger vs schedule. If they differ, one of the two is wrong; find out which.
- **Fixed assets:** ledger vs register, cost and accumulated depreciation separately.
- **Payroll liabilities:** ledger vs the provider's report of amounts due to tax authorities and pension or benefit schemes.
- **Suspense and clearing:** these should be zero. Anything in them is unexplained by definition.

## Ageing open items

Age each open item from its original date, not from when you first noticed it. Group as current, past threshold, and well past threshold (use the thresholds in `/org/finance/kpis.md`). For every aged item write: what it is, who owns it, what's needed to clear it, and by when.

## Pitfalls

- A rec that ties because of a "plug" or "unreconciled difference" line. That's not tied.
- Using a ledger report run before late journals posted. Rerun before you submit.
- Netting a payment and a receipt of similar size to make the list shorter.
- Carrying the same timing item for three months. It isn't timing any more.
