---json
{ "title": "AR metrics", "summary": "Definitions, formulas and worked examples for DSO, AR over 60 days, invoice right-first-time and the collection effectiveness index, with the traps in each.", "tags": ["metrics", "dso", "accounts-receivable", "kpis"], "updated": "2026-11-04" }
---

# AR metrics

These numbers say how quickly the company turns sales into cash and how often billing gets it right. Use the definitions in `/org/finance/kpis.md` if it has them. If it doesn't, propose these and get them confirmed before reporting.

## DSO (days sales outstanding)

**Standard method**

> **DSO** = accounts receivable at period end ÷ credit sales in the period × days in the period

Example: AR at 30 September is 90,000; September credit sales were 60,000; 30 days. DSO = 90,000 ÷ 60,000 × 30 = 45 days.

**Countback method** (better when sales swing month to month): start with closing AR and subtract each month's sales, most recent first, counting the days used up, until AR is used up.

Example: closing AR 90,000; September sales 60,000 (30 days), August sales 50,000 (31 days).
- 90,000 − 60,000 = 30,000 left → 30 days.
- 30,000 ÷ 50,000 × 31 = 18.6 days.
- DSO = 48.6 days.

**Traps**
- A big invoice on the last day of the month raises DSO without anyone paying late. Note it.
- Annual upfront billing makes DSO jump in renewal months. Compare the same month last year, or use countback.
- Unapplied cash still sitting in AR overstates DSO. Apply receipts before you measure.
- Always say which method you used. Switching method changes the number.

## AR over 60 days

> **AR > 60 share** = AR more than 60 days past due ÷ total AR

Note whether your buckets are "past due date" or "past invoice date". The ladder in your playbook uses days overdue; keep the metric consistent with it.

Report value and count, plus the top accounts by value with their status (dispute, promise to pay, no response, payment plan). A single large account can move this metric alone; say so.

## Invoice right-first-time

> **Right-first-time rate** = invoices issued with no later correction (credit, rebill or reissue for an error) ÷ invoices issued

- Count an invoice as wrong if it was corrected for a billing error, whether we or the customer found it. Reissues for a missing PO number count if the PO was available to us.
- Don't count goodwill credits or service credits; those aren't billing errors.
- Corrections can arrive weeks after issue. Report the rate for a month once it has had time to settle (e.g. restate last month alongside this month's early figure).
- Pair it with the error causes from the [invoice accuracy checklist](invoice-accuracy-checklist.md).

## Collection effectiveness index (CEI)

Optional, but useful because it isn't distorted by sales volume.

> **CEI** = (opening AR + credit sales in period − closing AR) ÷ (opening AR + credit sales in period − closing current AR) × 100

The numerator is what you collected. The denominator is what you could have collected (everything except invoices not yet due). Closer to 100 is better.

Example: opening AR 80,000; sales 60,000; closing AR 90,000 of which 55,000 is not yet due. CEI = (80,000 + 60,000 − 90,000) ÷ (80,000 + 60,000 − 55,000) × 100 = 50,000 ÷ 85,000 × 100 ≈ 59.

## Ageing report

Buckets: current, 1–30, 31–60, 61–90, 90+ days past due. For each, value and count. Totals must tie to the AR control account in the ledger; tell the Staff Accountant if they don't.

## Monthly summary format

| Metric | This month | Last month | Note |
|---|---|---|---|
| DSO (method) | | | |
| AR > 60 days (value, share) | | | |
| Right-first-time | | | restated prior month |
| CEI | | | |
| Expected collections next 4 weeks | | | from promises to pay |

The last row is what the cash review needs most. Base it on promises and payment history, not hope, and label which is which.
