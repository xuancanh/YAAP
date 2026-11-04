---json
{ "title": "Forecasting methods", "summary": "How the weighted-pipeline, category and run-rate forecasts work, how to combine them into a system forecast, and how to score accuracy and bias.", "tags": ["revops", "forecast", "accuracy", "pipeline", "method"], "updated": "2026-11-04" }
---

# Forecasting methods

The sellers' call is a judgement. Your job is to put an independent number next to it, explain the gap, and measure both so the company learns whose number to trust. Keep the agreed method in /org/revops/forecast-method.md. Changing it is a decision.

## Method 1: Weighted pipeline

```
Forecast = closed-won to date + Σ (open amount × stage probability), for deals closing in the period
```

- Set stage probabilities from **your own history**: the share of deals that reached each stage and went on to win, over a stated window (for example the last four quarters). Don't use vendor defaults or round guesses. With little history, label the probabilities as estimates and review them every quarter.
- It's weak when a few large deals dominate (a 40% probability on a single deal is never the actual outcome) and when stages aren't enforced by exit criteria.

## Method 2: Category roll-up

Each owner puts each deal in a category:

| Category | Meaning | Test (agree the exact tests with the Head of Sales) |
|---|---|---|
| Commit | Will close this period; the owner would bet on it | Economic buyer engaged, mutual close plan with dates, paper process started, close date not slipped repeatedly |
| Best case | Could close if one thing goes right | Qualified, a real path to signature this period, but at least one test above is missing |
| Pipeline | Open, unlikely this period | Everything else in the period |
| Omitted | Not in this period's numbers | Pushed out or disqualified |

```
Commit forecast    = closed-won + Σ commit
Best-case forecast = commit forecast + Σ best case
```

It's strong because sellers know things the CRM doesn't. It's weak because it reflects optimism, sandbagging and pressure.

## Method 3: Run-rate / historical model

Base it on how past periods filled in, for example "by week 4, we had historically closed X% of the final quarter".

```
Forecast = closed-won to date ÷ historical share closed by this point in the period
```

Add pipeline generated and closed within the same period if your cycle is short. This method ignores current deal quality, but it has no opinions, which makes it a useful sanity check. It breaks when the business changes shape (new segment, new pricing).

## The system forecast

Show the methods side by side with the sales call, and explain each gap in a sentence:

```markdown
| Method | Number | Note |
|---|---|---|
| Sales call (most likely) | | from sales-forecast-call, <date> |
| Weighted pipeline | | after hygiene fixes; <n> deals with past close dates excluded |
| Run-rate | | week <n> of <m>; historical share <x%> over <window> |
| Commit / best case | | |
| Gap explained | | e.g. two large deals in commit at stage 2 |
```

Don't average the methods into one number unless you've measured that the average is more accurate. Usually the gap is the useful information.

## Scoring accuracy

Freeze each forecast at fixed snapshot points, for example week 4 and week 8 of a quarter (agree them in forecast-method.md). At period close:

```
Accuracy = 1 − |actual − forecast| ÷ actual
Bias     = (forecast − actual) ÷ actual          (+ = optimistic, − = sandbagging)
Commit conversion = closed-won from deals that were in commit at the snapshot ÷ commit amount at the snapshot
```

Track each one per method and per owner over several periods. One period proves little. Use org_calibration for the agents' own forecasts. **Worked example (made-up):** week-4 call 500,000, actual 440,000. Accuracy = 1 − 60,000/440,000 ≈ 86%. Bias = +13.6% (optimistic).

## Pre-call data checks

- [ ] Close date in the past
- [ ] Missing amount, or amount 0
- [ ] No next step, or next-step date passed
- [ ] Stage without its exit criteria met
- [ ] Close date pushed more than the allowed number of times
- [ ] Commit deals failing the commit tests

## Common pitfalls

- Letting the forecast be edited after the snapshot. A forecast you can rewrite can't be scored.
- Stage probabilities nobody has re-measured since they were set.
- Treating the system forecast as a challenge to the Head of Sales rather than a second opinion. Agree the method together.
- Scoring only the final-week forecast, which is always accurate and tells you nothing.
- Changing category definitions mid-quarter, which breaks the comparison.
