---json
{ "title": "KPI pack template and analyst metrics", "summary": "A template for the recurring KPI pack with commentary rules, and formulas for request turnaround, dashboard usage and answers reproducible on re-run.", "tags": ["kpi pack", "reporting", "metrics", "kpi"], "updated": "2026-11-04" }
---

# KPI pack template and analyst metrics

## The KPI pack

A KPI pack tells a function head, in a few minutes, where they are against target and what needs attention. Numbers without commentary push the analysis onto the reader.

```markdown
# <Function> KPI pack — <period>
Data as of: <time, zone>   Prepared by: BI Analyst

## Headlines
- <Most important point: a KR at risk, a big move, a target hit.>
- <Second point.>
- <Third point, if any.>

## Scorecard
| Metric | Actual | Target | vs last period | Status | Comment |
| <catalogue name> | 1,240 | 1,500 | +6% | At risk | Pace needs +130/week |

## Notable movements
<For each metric that moved beyond its usual range: driver, in one or two
 sentences, from a metric explainer. Link the analysis.>

## Data notes
<Late data, definition changes, known gaps this period.>
```

### Commentary rules

- **Lead with exceptions.** Metrics on track get a status, not a paragraph.
- **Say "so what".** "Signups +6%, mostly from the webinar; pace still short of target by about 130 a week."
- **Status rules are fixed in advance** (for example, on track, at risk, off track, by the share of target reached against the share of period elapsed). Write the rule in the pack's footer and apply it the same way every time.
- **Same definitions every period.** If a definition changes, mark it and restate the previous period on the new definition if you can.
- **No new metrics without agreement.** Propose additions to the function head and the catalogue.

### Pace calculation

For a cumulative target over a period:

```
expected to date = target × (days elapsed / days in period)
pace gap         = actual to date − expected to date
needed per day   = (target − actual to date) / days remaining
```

Note when the metric is seasonal or back-loaded; a straight line can mislead.

## Your own KPIs

### Request turnaround

```
turnaround (per request) = answer delivered − request received
```

Report the median and the 90th-percentile turnaround over the period, plus the count. Measure in working days or hours, and say which. Split by request size if the mix varies a lot (quick lookups versus deep analyses), otherwise a few big pieces distort the picture.

The clock stops when the requester has an answer they can use. If you are waiting on them for clarification, record the waiting time separately; do not hide it.

### Dashboard usage

```
active dashboards  = dashboards with at least one view by someone other
                     than their builder in the period
usage rate         = active dashboards / published dashboards
viewers per dashboard = distinct viewers in the period
```

Use what the BI tool reports, and label it as tool data. Track the dashboards with zero or falling use as retirement candidates (see [dashboard design checklist](dashboard-design.md)).

### Answers reproducible on re-run

Pick a sample of answers delivered in the period (all of them if few). For each, re-run the saved query with the recorded parameters.

```
reproducible = answers whose re-run gives the same number
               (within rounding, or with an explained data correction)
               / answers sampled
```

An answer fails if the query is missing, the parameters are unrecorded, it uses rolling dates, or the result differs with no explanation. A failure is a process fix: follow [query hygiene](query-hygiene.md) next time.

### Reporting your own metrics

```markdown
| Metric | This period | Last period | Note |
| Turnaround median / p90 | 1.5 / 4 days | 2 / 6 days | 23 requests |
| Active dashboards | 14 of 19 | 13 of 20 | 2 proposed for retirement |
| Reproducible on re-run | 9 of 10 | 8 of 10 | 1 used a rolling date |
```
