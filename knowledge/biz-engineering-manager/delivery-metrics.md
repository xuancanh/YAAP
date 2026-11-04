---json
{ "title": "Delivery metrics: DORA, cycle time and quality", "summary": "Definitions, formulas and definition traps for the engineering KPIs: the DORA delivery metrics, cycle time, say/do, review turnaround and escaped defects.", "tags": ["engineering", "metrics", "dora", "kpis"], "updated": "2026-11-04",
  "sources": [
    { "title": "DORA's software delivery performance metrics", "url": "https://dora.dev/guides/dora-metrics/", "publisher": "DORA (Google Cloud)", "accessed": "2026-11-04", "note": "Page last updated 2026-01-05; lists five metrics and says failed deployment recovery time replaced MTTR." },
    { "title": "DORA research programme and State of DevOps reports", "url": "https://dora.dev/research/", "publisher": "DORA", "accessed": "2026-11-04" }
  ] }
---

# Delivery metrics: DORA, cycle time and quality

Use this when you write `/org/engineering/kpis.md`, pick key results, audit
how a number was computed, or fill the metrics table in the Friday report.
Write the exact definition you chose into kpis.md. Most "the metric moved"
debates turn out to be "the definition moved".

## The DORA metrics

DORA (DevOps Research and Assessment) groups its software delivery metrics
into **throughput** and **instability**. Its current guide (dora.dev, last
updated January 2026) lists five. The original four from the earlier reports
are the first four below, except that "time to restore service" (often
called MTTR) has been replaced by **failed deployment recovery time**, and
**deployment rework rate** was added. Your pack's KPI list still says MTTR:
treat it as the same idea and write down which version you measure.

| Metric | Formula (per period) | Source |
|---|---|---|
| Deployment frequency | production deployments ÷ days (or weeks) in the period | deploy log |
| Change lead time | median of (deployed_at − committed_at) over changes deployed in the period | VCS + deploy log |
| Change fail rate | deployments needing immediate intervention (rollback, hotfix) ÷ all deployments × 100 | deploy log + incident log |
| Failed deployment recovery time | median of (recovered_at − failed_deploy_at) over failed deployments | incident log |
| Deployment rework rate | unplanned deployments caused by a production incident ÷ all deployments × 100 | deploy log tagged by reason |

**Use medians, not means**, for times: one stuck change makes a mean
meaningless. Report the p90 alongside when the tail matters.

**Performance tiers** (elite, high, medium, low) are published per report,
and the cut-offs change between years. Don't quote a tier without the
report year and a link. Better: compare the unit with its own trend.

## Other engineering KPIs

- **Cycle time** = median of (done_at − started_at) per task. Unlike lead
  time it starts when work starts, so it shows how long work sits in
  progress. Pair it with WIP: by Little's law, average cycle time ≈ average
  WIP ÷ throughput, so lowering WIP is usually the fastest lever.
- **Sprint say/do** = committed items done by sprint end ÷ committed items
  × 100. Items added mid-sprint are counted separately; they were never
  "said".
- **Review turnaround** = median of (first_review_at − review_requested_at),
  in working hours if the team doesn't work nights.
- **Escaped defects per release** = defects found in production that trace
  to a change in the release ÷ releases. Decide whether a defect found by a
  customer and one found by monitoring both count.
- **On-call load** = pages (or out-of-hours interventions) per on-call
  person per week. Track it per person; an average hides the one who
  carries it.

## Definition choices to write down

These are the drift points the monthly audit checks. Record each choice and
the date in kpis.md.

```markdown
## Definitions (decided <yyyy-mm-dd>)
- Deployment: any production release, hotfixes included: yes / no
- Lead time starts at: first commit / PR opened / merge
- Failure means: rollback / hotfix / fix-forward / incident opened within N hours
- Recovery ends at: service restored (not root cause fixed)
- Time unit: calendar hours / working hours
- Excluded: config-only changes, docs-only changes, …
- Source of truth: <metric source id or file>; owner: <member>
```

## Worked example (made-up figures)

Over two weeks the deploy log shows 18 production deployments; 2 were rolled
back and 1 needed a hotfix. Change fail rate = 3 ÷ 18 × 100 = 16.7%.
Recovery times for the three were 40 min, 2 h and 5 h, so failed deployment
recovery time (median) = 2 h. Sorting the 18 lead times, the 9th and 10th
values are 20 h and 26 h, so median lead time = 23 h. Deployment frequency =
18 ÷ 10 working days = 1.8 per day.

## Common pitfalls

- **Gaming by slicing.** Deploy frequency rises if one change ships as five
  trivial deploys. Read frequency next to lead time and fail rate.
- **Counting hotfixes as successes.** A hotfix is usually evidence that an
  earlier deploy failed. If it counts as a deploy, the original counts as a
  failure.
- **One metric as the key result.** Push frequency alone and fail rate
  climbs. Pair one throughput metric with one instability metric.
- **Self-reported numbers.** Without a metric source the result is
  self-reported until one is approved (`org_propose_metric_source`); say so
  in the report.
- **Ranking people.** The metrics describe how a system delivers, not how
  hard anyone works. Use them to find bottlenecks, not to compare engineers.
