---json
{ "title": "FP&A metrics", "summary": "Definitions and formulas for forecast accuracy (error, absolute percentage error, bias), variance explained and scenario turnaround, and how to report them.", "tags": ["metrics", "forecast-accuracy", "kpis", "bias"], "updated": "2026-11-04" }
---

# FP&A metrics

Your KPIs measure whether the numbers you give the company can be trusted and whether they arrive in time to matter. Report them monthly with a short note on what you'll change.

## Forecast accuracy

Measure each forecast against the actual it predicted, at a fixed horizon (for example, the forecast made one month ahead). Record the forecast at the time you make it (`org_forecast_outcome` when your manager owns the key result) so it can't be revised after the fact.

> **Forecast error** = actual − forecast
> **Absolute percentage error (APE)** = |actual − forecast| ÷ |actual|
> **Forecast accuracy** = 1 − APE (floored at zero)
> **MAPE** (across several lines or months) = average of the APEs

**Example.** Forecast for October revenue made at the end of September: 100,000. Actual: 94,000. Error = −6,000. APE = 6,000 ÷ 94,000 ≈ 6.4%. Accuracy ≈ 93.6%.

**Weighted accuracy across lines.** MAPE treats a small line the same as a big one. For the whole P&L, use weighted APE: sum of absolute errors ÷ sum of absolute actuals.

**Bias.** Accuracy can look fine while you're always wrong in the same direction.

> **Bias** = sum of (forecast − actual) ÷ sum of actuals

Positive bias means you forecast too high on average (optimistic revenue, or pessimistic cost). Track it over several months; persistent bias is a fixable assumption, usually a driver set from hope rather than history.

**Pitfalls**
- Measuring against the latest reforecast made days before the month ended. Fix the horizon.
- Excluding the months you got badly wrong.
- APE explodes when the actual is near zero; use absolute error for those lines.

## Variance explained

> **Variance explained %** = value of above-threshold variances with a confirmed cause ÷ total value of above-threshold variances

- "Confirmed" means the cause comes from the transactions or the budget owner, not a guess. "Cause not yet confirmed" doesn't count.
- Use absolute values so favourable and adverse variances don't cancel out.
- Also report how many lines had a confirmed cause by the commentary deadline. Late explanations help less.

## Scenario turnaround

> **Turnaround** = time from the request being accepted to the first answer reviewed by the Head of Finance

- Measure in working days (or hours for urgent requests).
- Track the first answer and the final answer separately. A fast rough answer with caveats is often what the decision needs.
- Note the cause when a scenario was slow: unclear question, model not current, waiting on a driver owner.

## Supporting measures

- **Reforecast changes with a reason**: share of changed assumptions that have a written reason. Should be all of them.
- **Close-to-forecast time**: working days from close lock to the reforecast being issued.

## Monthly report

| Metric | This month | 3-month trend | Note |
|---|---|---|---|
| Revenue forecast accuracy (1-month horizon) | | | |
| Cost forecast accuracy | | | |
| Bias (revenue, cost) | | | |
| Variance explained | | | |
| Scenario turnaround (first / final) | | | |

End with one change you'll make: a driver to re-base, an owner to involve earlier, a lever to wire into the model.
