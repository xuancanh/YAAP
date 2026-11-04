---json
{ "title": "Forecasting and calibration", "summary": "How to build a forecast with an honest range, choose a baseline, score point and interval accuracy, and measure calibration.", "tags": ["forecasting", "calibration", "prediction intervals", "accuracy", "kpi"], "updated": "2026-11-04",
  "sources": [{ "title": "Hyndman and Athanasopoulos, Forecasting: Principles and Practice (3rd ed., OTexts)", "url": "https://otexts.com/fpp3/" }] }
---

# Forecasting and calibration

A forecast is useful when people can plan with it: a central estimate, a range they can trust, and assumptions they can check. Hyndman and Athanasopoulos's free textbook *Forecasting: Principles and Practice* covers the methods below in depth.

## Build order

1. **Write the question.** What quantity, at what level (company, plan, region), for which periods, and what decision uses it?
2. **Plot the history.** Look for trend, seasonality (weekly, monthly, yearly), level shifts, outliers and definition changes. Fix or mark data issues before modelling.
3. **Start with baselines:**
   - *naive:* next value = last value;
   - *seasonal naive:* next value = value one season ago;
   - *drift:* last value plus the average historical change.
   Any model you build must beat these on held-out data, or use the baseline.
4. **Try a simple model** that matches the patterns: exponential smoothing for trend and seasonality, a regression with known drivers (pipeline, price changes, marketing spend), or a cohort model for subscriptions (retention × new customers).
5. **Backtest.** Re-fit on data up to several past cut-off dates and forecast forward, comparing with what happened. This tells you real accuracy at each horizon.
6. **Produce intervals** from the model or from backtest errors at each horizon. State the level (for example, 80%).
7. **Write the assumptions** that would break the forecast: "assumes no price change", "assumes the October campaign repeats".

## Ranges people can use

- Give a central estimate and an interval: "Q1 new customers: 420 (80% range 360–490)."
- Intervals widen with horizon. If yours do not, they are probably too narrow.
- Model-based intervals usually ignore uncertainty about the model itself and about the drivers. Widen them using backtest errors, or show scenarios for key assumptions.

## Scoring point accuracy

With actual `y`, forecast `ŷ`, error `e = y − ŷ` over `n` periods:

```
MAE  = mean(|e|)
RMSE = √mean(e²)
MAPE = mean(|e / y|) × 100
bias = mean(e)            (positive = forecasts too low)
```

- MAPE is easy to explain but breaks when actuals are zero or near zero, and it penalises over- and under-forecasts unequally. Avoid it for small counts.
- To compare across series of different scales, use a scaled error such as MASE: MAE divided by the in-sample MAE of a naive (or seasonal naive) forecast. Below 1 means better than the naive method.
- Report bias separately. A consistently low or high forecast is fixable.

## Scoring intervals and calibration

Calibration asks: do X% intervals contain the actual X% of the time?

```
coverage = forecasts where actual fell inside the stated interval
           / forecasts scored
```

For 80% intervals, coverage well below 80% over many forecasts means intervals are too narrow (overconfident); well above means too wide. With few forecasts, coverage is noisy: show the count.

To score sharpness and coverage together, use the **quantile (pinball) score**. For quantile level `q` and forecast quantile `f`:

```
pinball = q × (y − f)        if y ≥ f
        = (1 − q) × (f − y)  if y < f
```

Lower is better. Averaging over the quantiles you publish (for example, 10th, 50th, 90th) gives one number for the whole forecast distribution.

## KPI: forecast calibration

Record every forecast at the time it is made: date, quantity, horizon, central value, interval and level. When actuals arrive:

```
forecast calibration = coverage of stated intervals over forecasts
                       resolved in the period, at their stated level
```

Report it with the count, the target level, the bias and a point-accuracy measure. Example: "80% intervals: 9 of 12 covered (75%); bias slightly low; MASE 0.8."

## Pitfalls

- Forecasting a target. A forecast says what is likely; a target is what we want. Keep them separate and say which is which.
- Silent revisions. If you update a forecast, keep the original for scoring.
- Too many drivers. Each driver needs its own forecast; uncertainty compounds.
