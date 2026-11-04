---json
{ "title": "Close metrics", "summary": "Definitions and formulas for the Staff Accountant's KPIs (close tasks on time, reconciliations tied, exceptions aged, payables matched, DPO) and how to report them honestly.", "tags": ["metrics", "kpis", "close", "payables"], "updated": "2026-11-04" }
---

# Close metrics

These metrics tell the Head of Finance whether the close is fast, complete and clean. Report them the same way every month so the trend means something.

## Close tasks on time

> **On-time rate** = close tasks completed by their due working day ÷ close tasks due in the period

- A task counts as on time only if it was done (tied, supported, submitted for review) by its due day. Submitted but failed review counts as late until it passes.
- Report the count too: "34 of 36 on time (94%)". A percentage on a small denominator hides a lot.
- List the late tasks with cause: waiting on a person, missing data, error found, capacity.

**Close duration**: working days from period end to the day the period is locked. Useful as a trend alongside the on-time rate.

## Reconciliations tied

> **Tied rate** = accounts reconciled with zero unexplained difference ÷ accounts in scope

- In scope = every bank and card account, plus balance sheet accounts above the materiality threshold.
- "Tied" means outside balance ± listed items = ledger balance exactly. A rec with an "unexplained" line isn't tied, however small.
- Also report how many recs were reviewed and signed off; tied but unreviewed is a weaker state.

## Exceptions aged

An exception is an open item past the ageing threshold in `/org/finance/kpis.md`: a reconciling item that hasn't cleared, an unmatched bill, a suspense balance.

> **Aged exceptions** = count and total value of open items older than the threshold, as at period end

Report:
- count and value by bucket (e.g. past threshold, twice the threshold);
- the oldest item and its age in days;
- movement since last month: new, cleared, still open.

Age from the item's original date. Re-dating an item when it's "re-investigated" hides the problem.

## Payables matched

> **Match rate** = bills in the period that passed the match (three-way or two-way) without exception ÷ bills processed in the period

- Track the exceptions by type: price, quantity, no receipt, no PO, duplicate caught. The mix shows where to fix the process (e.g. many "no PO" exceptions mean a buying policy problem, not a payables problem).
- **Duplicates caught** is worth showing separately; it's a direct saving.

## DPO (days payable outstanding)

The playbook asks you to note DPO for each payment run.

> **DPO** = average accounts payable ÷ cost of purchases on credit in the period × days in the period

- Average AP = (opening AP + closing AP) ÷ 2.
- Use cost of goods sold plus operating purchases on credit if that's what the company has defined; state which denominator you used.
- A rising DPO can mean better cash management or late payments that will hurt vendor relationships. Report it next to the count of bills paid after their due date.

## Reporting format

One table per month in the close folder, with last month and a three-month trend:

| Metric | This month | Last month | 3-month avg | Note |
|---|---|---|---|---|
| Close tasks on time | 34/36 (94%) | | | 2 late: bank feed outage |
| Reconciliations tied | | | | |
| Aged exceptions (count / value) | | | | |
| Payables match rate | | | | |
| DPO | | | | |

## Honest reporting

- Never change a definition mid-year without saying so in the note and restating the prior months.
- Don't improve a metric by narrowing scope (dropping hard accounts from "in scope").
- Each miss gets a cause and one fix. The metric is there to make next month better, not to look good this month.
