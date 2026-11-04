---json
{ "title": "Variance analysis", "summary": "How to split budget-vs-actual variances into price, volume and mix, classify them, and write commentary that non-finance readers act on, with good and poor examples.", "tags": ["variance", "budget-vs-actuals", "commentary", "analysis"], "updated": "2026-11-04" }
---

# Variance analysis

A variance comment answers three questions: what moved, why, and does it reverse? If a budget owner reads it and knows whether to do anything, it worked.

## Sign convention

Pick one and state it at the top of the report. A common one: **favourable** when actual revenue is above budget or actual cost is below budget; **adverse** the other way. Show the amount and say "favourable" or "adverse" rather than relying on a minus sign.

## Price and volume

For any line driven by quantity × price, split the variance:

> **Volume variance** = (actual quantity − budget quantity) × budget price
> **Price variance** = (actual price − budget price) × actual quantity
> Volume + price = total variance

**Example: software seats.** Budget: 50 seats at 20 = 1,000. Actual: 58 seats at 22 = 1,276. Total variance: 276 adverse.
- Volume: (58 − 50) × 20 = 160 adverse (more seats).
- Price: (22 − 20) × 58 = 116 adverse (vendor uplift).
- Check: 160 + 116 = 276.

Now the comment can say two different things to two different owners: the team added seats, and the vendor raised prices.

## Mix

When a line has several products or customer types at different prices, a shift in proportion changes revenue even if total volume and each price are on plan. Mix variance = actual total quantity × (actual-mix average budget price − budget average price). Use it when the business sells clearly different tiers; otherwise price and volume are enough.

## Classify every variance

| Type | Meaning | Full-year effect |
|---|---|---|
| **Timing** | Happened in a different month than planned | Reverses; none for the year |
| **Volume** | More or fewer units than planned | Usually continues; reforecast |
| **Price / rate** | Different unit price or rate | Usually continues |
| **One-off** | Won't recur (a settlement, a one-time fee) | This month only |
| **Error** | Booked wrong | Fix in the ledger, not in commentary |

Always say the expected full-year effect. That's what the reforecast and the leadership team need.

## Finding the cause

1. Look at the transactions behind the line: which vendors, which invoices, which journal.
2. Compare with the driver: is the quantity or the rate different?
3. If the cause isn't in the record, ask the budget owner a specific question ("Software is 276 over; I see 8 more seats on the design tool and a price change from March. Is the seat increase expected to stay?").
4. If you don't get an answer by the deadline, write "cause not yet confirmed; asked {owner} on {date}". Never guess.

## Writing the comment

One or two sentences, plain words, lead with the cause.

**Poor:** "Software expenses were 276 above budget due to higher than anticipated costs."
(Restates the number; no cause; no action.)

**Good:** "Software 276 over: 8 extra design seats for the new hires (160, continues) and the vendor's price rise from March (116, continues). Full-year effect about 2,800 adverse; included in the reforecast."

**Poor:** "Marketing under budget, favourable."
**Good:** "Marketing 4,000 under: the conference sponsorship moved from October to January (timing, reverses). No full-year effect."

## Thresholds

Comment on lines above the threshold in `/org/finance/kpis.md` (often a combination of an absolute amount and a percentage, so tiny lines with big percentages and big lines with small percentages are both caught). Below threshold, group as "other".

## Pitfalls

- Netting a favourable and an adverse item inside one line so neither is visible.
- Calling every variance "timing". If it hasn't reversed in two months, reclassify.
- Explaining a variance against a stale budget without also showing it against the latest forecast.
- Comments full of finance words. The reader is a budget owner, not an accountant.
