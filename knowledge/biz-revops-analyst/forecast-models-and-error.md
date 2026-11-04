---json
{ "title": "Forecast models and error", "summary": "Three historical forecast methods, how to combine them, and how to measure forecast model error and bias consistently.", "tags": ["forecast", "model", "error", "mape", "bias"], "updated": "2026-11-04" }
---

# Forecast models and error

The system forecast is a model built from history, separate from the reps' judgement call. Its value is that it doesn't get excited. Keep it simple, measure its error every period, and improve it only when the error says so.

## Three methods

**1. Run-rate (booked + expected from open pipeline)**

```
Forecast = closed-won to date + Σ (open opportunity amount × historical win rate for its stage)
```

Use stage win rates from history: of the opportunities that were in stage S at this point in past periods, what share of amount closed by period end? Calculate separately by segment if there's enough data.

**2. Time-in-period (pacing)**

```
Forecast = closed-won to date ÷ historical share of period bookings typically closed by this day
```

If by day 30 of past quarters an average of a certain share of bookings had closed, divide bookings so far by that share. Works when the period's shape is stable; breaks when there's one big deal.

**3. Pipeline-created conversion (for early in the period)**

```
Forecast = closed-won to date
         + open pipeline × stage conversion
         + expected pipeline still to be created and closed in-period × historical in-period conversion
```

Matters for short cycles where deals created this period still close in it.

Show the methods side by side. If they disagree a lot, explain why (a large deal, an unusual stage mix) rather than averaging blindly.

## Forecast model error

Measure at a **fixed snapshot point** (for example, week 3 of the quarter) so you aren't grading a forecast updated the day before close.

```
Error (per period) = (forecast − actual) ÷ actual
Absolute percentage error = |forecast − actual| ÷ actual
MAPE = mean of absolute percentage errors over the last n periods
Bias = mean of (forecast − actual) ÷ actual over the last n periods
```

- **MAPE** tells you how wrong the model usually is.
- **Bias** tells you which way: positive means it usually over-forecasts.
- Report both, by segment, with n.
- If actual is zero or tiny (a small segment), use absolute error in currency instead.

Also compare the model's error with the reps' forecast error at the same snapshot. The useful question is where each one is better.

## Worked example

Week-3 snapshot: closed-won $400k; open pipeline in Proposal $600k with a historical stage win rate of 50%, in Evaluation $1,000k at 20%.

```
Run-rate forecast = 400 + (600 × 0.5) + (1,000 × 0.2) = $900k
```

Actual close: $820k.

```
Error = (900 − 820) ÷ 820 = +9.8% (over-forecast)
```

If the previous three quarters were +6%, +11% and +4%, bias is consistently positive: look at whether late-stage win rates have fallen.

## Uncertainty

Give a range, not just a point. Simple ways:

- Use the spread of past errors: if past absolute errors ranged up to about 12%, show forecast ±12% and say how it was derived.
- Show the largest open deals separately; one deal can swing the range.

## When to change the model

- Bias in the same direction for several periods
- A structural change (new segment, pricing change, new sales stages)
- Error grows after a process change

Change one thing at a time, back-test it on past snapshots and record the change and its effect in the model's change log.

## Pitfalls

- **Grading at period end** instead of at a fixed snapshot.
- **Using current stage win rates** that include deals still open; use closed history only.
- **Overfitting** to a handful of periods.
- **Silent changes** to definitions or stage mapping; they break comparisons.
