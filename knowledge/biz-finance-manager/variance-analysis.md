---json
{ "title": "Variance analysis", "summary": "How to compute, split and explain budget-vs-actual variances (price, volume, mix, timing vs permanent) so the BvA leads to decisions.", "tags": ["finance", "variance", "bva", "budget", "reforecast"], "updated": "2026-11-04" }
---

# Variance analysis

A variance is the gap between what you planned and what happened. The job isn't to list gaps. It's to say, for each material one, **why** it happened, **whether it will reverse**, and **what it changes** in the forecast.

## The basic table

For every cost centre and line:

```
Variance (amount) = Actual − Budget
Variance (%)      = (Actual − Budget) ÷ Budget
```

Mark each variance favourable (F) or unfavourable (U). Revenue above budget is F and cost above budget is U. Write that rule once, at the top of the BvA file, so the signs aren't misread. Show month and year to date side by side: one bad month can sit inside a year that's on plan.

## Splitting a variance: price and volume

When a line is quantity × rate (seats × price, hours × rate, units × cost), split it so the owner knows which lever moved.

```
Volume variance = (Actual quantity − Budget quantity) × Budget price
Price variance  = (Actual price − Budget price) × Actual quantity
Total variance  = Volume variance + Price variance
```

**Worked example (made-up figures).** Budget: 100 seats at 50 = 5,000. Actual: 120 seats at 45 = 5,400.

- Total variance = 5,400 − 5,000 = **+400** (F, for revenue)
- Volume = (120 − 100) × 50 = **+1,000** (F): you sold more seats
- Price = (45 − 50) × 120 = **−600** (U): at a lower price
- Check: 1,000 − 600 = 400 ✓

The line is "on budget-ish", but the story is a discounting question for sales, not a non-event.

**Mix** matters when several products have different prices or margins. If the volume shifts towards cheaper products, total revenue can fall even when units rise. Do the price/volume split per product, then add up. The difference between that and a single blended calculation is the mix effect.

## Classifying the cause

Give every material variance exactly one primary label:

| Label | Meaning | Forecast effect |
|---|---|---|
| Timing | Will reverse in a later period (an invoice arrived early, a hire started a month late) | Move it, don't remove it. Say which month it lands in |
| Permanent | Won't reverse (a price change, a cancelled contract, a vendor dropped) | Change the full-year forecast |
| Volume | More or less activity than planned | Change the driver assumption |
| Price / rate | Same activity, different unit cost or price | Change the rate assumption |
| Error | A coding or cut-off mistake | Fix it in the ledger; it's not a variance |

If you don't know the cause, ask the owning function (org_task_comment or a briefed task). "Under investigation" is honest. A plausible guess isn't.

## From variance to reforecast

1. Start from closed actuals to date.
2. For the remaining months, change only the assumptions that a variance gave you evidence for. A timing variance moves cost between months. A permanent one changes the run rate.
3. Show three columns: original budget, prior forecast, new forecast. Add a one-line reason for every line that moved.
4. Keep the original budget frozen. Performance is still judged against the plan the company approved, while decisions are made on the new forecast.

## BvA summary template

```markdown
# BvA <yyyy-mm>  (closed actuals, close signed <date>)

Sign rule: + = favourable. Threshold: <x% and amount from kpis.md>

| Cost centre | Line | Budget | Actual | Var | Var % | YTD var | Label | Reason (owner) |
|---|---|---|---|---|---|---|---|---|

Agent workforce: spend <x> vs envelope <y> (org_costs, read <date>); projection <z> (org_forecast)

Forecast change: full year <old> → <new>, because <top two reasons>
Asks: <decision needed, owner, by when>
```

## Common pitfalls

- Explaining variances against a budget that was quietly re-baselined. Freeze the original.
- Netting a large favourable and a large unfavourable variance into "on budget". Explain both.
- Calling everything "timing". Check last month's timing items: did they actually reverse?
- Using preliminary numbers without a label. If you have to, write "preliminary, close not signed" at the top.
- Reforecasting every line from a hunch. Change assumptions only where evidence moved.
