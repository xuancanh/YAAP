---json
{ "title": "Sample size and power", "summary": "Formulas and a worked example for sample size per group, minimum detectable effect and duration, plus ways to shorten an experiment honestly.", "tags": ["power analysis", "sample size", "mde", "statistics"], "updated": "2026-11-04" }
---

# Sample size and power

Power analysis answers: how many units do we need to have a good chance of detecting an effect of the size we care about? Run it before launch, every time.

## Terms

- **α (significance level):** the false-positive rate you accept when there is no effect. Commonly 0.05, two-sided.
- **Power (1 − β):** the chance of detecting the effect if it is really the size of the MDE. Commonly 0.8.
- **MDE (minimum detectable effect):** the smallest true effect worth detecting. Set it from the decision: below what size would you not bother shipping?
- **Baseline:** the control group's expected value (a rate `p`, or a mean with standard deviation `σ`), from recent data.

The common choices of α and power are conventions; pick yours with your manager and write them down.

## Formulas (two groups, equal split)

For a **mean** metric with standard deviation `σ` and absolute MDE `δ`:

```
n per group ≈ 2 × (z₁₋α/₂ + z₁₋β)² × σ² / δ²
```

For a **rate** (conversion) with baseline `p` and absolute MDE `δ`:

```
n per group ≈ 2 × (z₁₋α/₂ + z₁₋β)² × p(1 − p) / δ²
```

Standard normal values: for α = 0.05 two-sided, `z = 1.96`; for power 0.8, `z = 0.84`; for power 0.9, `z = 1.28`. So with α = 0.05 and power 0.8, `(1.96 + 0.84)² ≈ 7.84`.

These are approximations that work well for large samples. Use a proper calculator or a library function for the final number, and for small samples or very low rates.

## Worked example

Baseline checkout completion `p = 0.20`. We care about an absolute lift of 2 points (`δ = 0.02`, a 10% relative lift).

```
n per group ≈ 2 × 7.84 × 0.20 × 0.80 / 0.02²
            = 2 × 7.84 × 0.16 / 0.0004
            ≈ 6,272
```

About 6,300 users per group, 12,600 total. If 900 eligible users reach checkout per day, that is 14 days. Round up to whole weeks: two full weeks.

Note how the MDE dominates: halving `δ` to 0.01 quadruples the sample to about 25,000 per group.

## Duration

```
duration (days) = total sample needed / eligible units per day
```

Then round up to whole weeks. Also check the metric window: if conversion is measured within 14 days of exposure, the last users enrolled need 14 more days before the readout.

## Ratio metrics

For metrics like revenue per order or clicks per session, where the unit of analysis (order, session) differs from the unit of randomisation (user), the simple variance underestimates the true variance. Use the delta method or a bootstrap at the randomisation unit to estimate `σ`.

## Shortening an experiment honestly

- **Increase the MDE** if a smaller effect would not change the decision.
- **Use a more sensitive primary metric** that is closer to the change (checkout completion rather than monthly revenue), keeping the business metric as a guardrail.
- **Reduce variance:** adjust for a pre-experiment covariate (the same metric measured on each unit before the experiment; the CUPED method). Cap extreme values (winsorise) in revenue-like metrics, deciding the cap in advance.
- **Trigger analysis:** include only units actually exposed to the change.
- **Widen the population** if the change applies to more users.

Do not shorten by peeking and stopping early; that inflates false positives (see [experiment readout](experiment-readout.md)).

## When the numbers do not work

If the required duration is far longer than the company can wait, say so in the design: "At current traffic, detecting a 5% lift needs about 10 weeks. Options: test a bolder change, accept a 10% MDE (3 weeks), or decide without an experiment." This is a useful finding, not a failure.

## Pitfalls

- Using relative and absolute MDE interchangeably. State which.
- Taking the baseline from a period that is not comparable (a holiday month).
- Forgetting that several variants against one control each need the per-group sample, and multiple comparisons need correction.
