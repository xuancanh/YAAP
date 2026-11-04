---json
{ "title": "Reliability metrics and formulas", "summary": "Exact definitions and formulas for SLO attainment, error budget burn, MTTR, actionable-page ratio and out-of-hours pages, with measurement pitfalls.", "tags": ["metrics", "kpi", "mttr", "slo", "on-call"], "updated": "2026-11-04" }
---

# Reliability metrics and formulas

Write the definition you used next to every number you report. "MTTR" means different things to different people, and the difference can be large.

## SLO attainment

Per SLO, over its window (usually 30 days, rolling or calendar; say which):

```
SLI value      = good events / valid events
SLO met        = SLI value ≥ SLO target
SLO attainment = SLOs met / SLOs tracked     (across journeys, for the period)
```

Report the SLI value itself next to the yes/no. "Met at 99.51% against 99.5%" tells a different story from "met at 99.98%".

## Error budget burn

```
error budget        = 1 − SLO target
budget consumed (%) = (1 − SLI value so far) / (1 − SLO target) × 100
burn rate           = error rate over a window / (1 − SLO target)
```

Example: SLO 99.5%, SLI so far 99.7% → budget consumed = 0.003 / 0.005 = 60%.

Compare budget consumed with the share of the window elapsed. 60% consumed at day 15 of 30 means burning faster than sustainable. Burn-rate alerting is in [SLOs and burn-rate alerts](slo-and-burn-rate.md).

## MTTR

Define which "R" you mean. The most useful for this role is **mean time to restore**: from when user impact started (or was detected) to when it ended.

```
time to restore (per incident) = impact end − impact start
MTTR = sum of time to restore / number of incidents
```

Also compute **time to detect** (`detected − impact start`) and **time to mitigate** (`mitigation applied − detected`), because they point to different fixes: alerting versus runbooks and rollbacks.

Pitfalls:

- A mean is dragged by one long incident. Report the median too, and list outliers.
- Few incidents make the number jumpy. Show the count beside it.
- Use the timeline's timestamps, not memory.
- DORA's related metric is *failed deployment recovery time*, which only counts deployment-caused failures; do not mix the two.

## Actionable-page ratio

From the alert review:

```
actionable-page ratio = pages where the on-call had to take an action
                        / total pages
```

"Action" means a human did something that changed the outcome: a mitigation, an escalation, a fix. Acknowledging and watching it clear on its own is not action. Count each page once, even if it re-fired.

A low ratio means noise; fix with the [alert design checklist](alert-design.md).

## Out-of-hours pages

```
out-of-hours pages = pages delivered outside the on-call person's
                     agreed working hours, per shift or per week
```

Define working hours in the on-call policy, in the on-call person's time zone. Report alongside total pages per shift. Out-of-hours pages are the most costly for people and should be the first target of alert tuning and automation.

## Reporting format

```markdown
| Metric | This period | Last period | Target | Note |
| SLO attainment | 4/5 | 5/5 | 5/5 | Search latency missed (99.2% vs 99.5%) |
| Budget consumed — checkout | 40% | 15% | <100% | Release on 12th |
| MTTR (median / mean) | 22 / 41 min | 30 / 30 min | — | 3 incidents; one 95 min |
| Actionable-page ratio | 0.6 | 0.4 | — | Two noisy alerts removed |
| Out-of-hours pages / week | 2 | 5 | — | |
```

Keep the target column honest: leave it blank where no target was agreed rather than inventing one.
