---json
{ "title": "Estimates and engineering metrics", "summary": "How to give range estimates you can be scored on, and the formulas for first-review acceptance, estimate accuracy, regressions introduced and the DORA delivery metrics.", "tags": ["estimation", "metrics", "kpi", "dora"], "updated": "2026-11-04",
  "sources": [{ "title": "DORA's software delivery performance metrics (dora.dev, read 2026-11-04)", "url": "https://dora.dev/guides/dora-metrics/" }] }
---

# Estimates and engineering metrics

## Giving an estimate

Give a range, not a point, and say what it depends on.

1. **Break the work into pieces** you can each picture finishing: model change, endpoint, UI, tests, review fixes.
2. **Estimate each piece** with a low (things go smoothly) and a high (the plausible bad case, not the disaster).
3. **Add the items people forget:** writing tests, the design note, review rounds, migration and rollback testing, documentation.
4. **Name the biggest unknown** and how you would shrink it: "Range is wide because I have not seen the billing module. A two-hour spike would narrow it."
5. **Record the forecast** (task, low, high, date) so it can be scored later.

Re-estimate as soon as you learn something that moves the range, and tell your manager on the task the same day. A late surprise is worse than a wide range.

## Your KPIs

Define each over a period (for example, a month) and compute from task and review records, not memory.

### First-review acceptance

```
first-review acceptance = changes approved in their first review
                          / changes submitted for review
```

"Approved" includes "approve with nits". A low value usually means missing tests, unclear descriptions or changes too large. Use the [definition of done](pr-description-and-done.md) before each submission.

### Estimate accuracy

Two useful views. Use both.

```
hit rate = tasks where actual effort fell inside the [low, high] range
           / tasks estimated

bias     = median of (actual / midpoint of range)
```

A hit rate that is low means ranges are too narrow. A bias above 1 means you consistently underestimate; below 1, you pad. Count effort in the same unit you estimated in (hours of work or elapsed days), and say which.

### Regressions introduced

```
regressions introduced = defects found after merge whose cause is
                         traced to a change you authored, per period
```

Count a defect once, at the change that caused it. Report alongside the number of changes merged, so the rate is visible:

```
regression rate = regressions introduced / changes merged
```

Every regression should leave behind a regression test and, if the gap was a missing kind of test, a note in the next design note's test plan.

## The DORA delivery metrics

Your manager may report these for the team. DORA (dora.dev) currently describes five software delivery metrics:

| Metric | Definition (DORA) | Typical formula |
|---|---|---|
| Change lead time | Time from commit to deployed in production | median(deploy time − commit time) |
| Deployment frequency | Deployments over a period, or time between them | deployments / period |
| Failed deployment recovery time | Time to recover from a deployment that fails and needs immediate intervention | median(recovered − failure detected) |
| Change fail rate | Share of deployments that need immediate intervention | failed deployments / deployments |
| Deployment rework rate | Share of deployments that are unplanned and happen because of a production incident | unplanned incident-driven deployments / deployments |

Small, well-tested changes improve all five at once: they move faster, fail less and are easier to roll back.

## Pitfalls

- Do not game a metric by splitting work artificially or skipping hard reviews. Report the number and the context.
- Do not compare individual engineers on these numbers; use them to spot where your own process leaks.
