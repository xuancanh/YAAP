---json
{ "title": "Weekly revenue report", "summary": "A copyable template and RAG rules for the Friday RevOps report, so the chief sees funnel, forecast and data health in the same shape every week.", "tags": ["revops", "report", "template", "weekly"], "updated": "2026-11-04" }
---

# Weekly revenue report

The report exists so the chief can see trends and act on asks. It works only if it has the same shape every week. The same metrics in the same order make a change visible at a glance. Save it as /org/revops/reports/<yyyy>-W<ww>.md. Adapt the length to the profile (one screen by default).

## Rules for the numbers

- Every metric shows **target, actual, last week and trend**, and its source: org_metric_read, the CRM snapshot time, or the file it came from.
- Use the definitions in funnel.md and forecast-method.md. If a definition changed this week, say so in a line under the table.
- A number you couldn't get is "n/a (why)", never last week's value carried forward silently.
- Numbers that another unit also reports (bookings with sales and finance, pipeline with marketing) should match theirs. If they don't, show both and say which one is being reconciled.

## RAG rule (write it at the top, tune the defaults in cadence.md)

- **Green**: forecast accuracy and CRM completeness at or above target, no unexplained gap between the system forecast and the sales call, no change released without a release note.
- **Amber**: one key result behind pace, a gap between the system forecast and the sales call that you can't yet explain, or a hygiene check failing on a material share of pipeline.
- **Red**: a key result at risk for two weeks running, a reported number that turned out to be wrong, or a forecast gap that threatens the objective.

## Template

```markdown
# RevOps weekly report <yyyy>-W<ww>

**Status: <Green|Amber|Red>**: <one sentence why>
RAG rule: <the rule, or a link to cadence.md>

## Key results
| Key result | Target | Actual | Last wk | Trend | Confidence | Source |
|---|---|---|---|---|---|---|
| Forecast accuracy (wk-<n> snapshot) | | | | | | |
| CRM completeness (opps) | | | | | | |
| Funnel conversion <stage→stage> (cohort) | | | | | | |
| Lead routing time (median / % within SLA) | | | | | | |

## Funnel (from /org/revops/funnel/<date>.md)
| Stage | Volume | Conv. to next | Median days | vs 90-day norm |
|---|---|---|---|---|

Biggest leak: <stage>, <likely cause, evidence>, fix owned by <unit/task>

## Forecast (from /org/revops/forecast/<date>.md)
| Sales call | Weighted | Run-rate | Target | Gap |
|---|---|---|---|---|
Gap explained: <one or two sentences>

## Data and systems
- Hygiene: <n> deals failing checks (<top failure>), down/up from <n>
- Changes released: <change, release note link> / none
- Audit findings open: <n> (<most severe>)

## Highlights
- 

## Risks
| Risk | Owner | Mitigation | In /org/risks.md? |
|---|---|---|---|

## Asks
| Ask | Decision or resource | Who | By when |
|---|---|---|---|
```

## Delivering it

- Post the status line and three bullets with org_message. The file holds the detail.
- Asks for the chief become backlog tasks, with the decision as the outcome. Quota, compensation and pricing-policy changes go to the person who owns them, never into the report as a done deal.
- Carry the open risks into /org/risks.md if they aren't there already.

## Common pitfalls

- Changing the table layout from week to week.
- Twelve metrics with no trend, where four with a trend and an owner would tell the story.
- "Green" with a number that doesn't match finance's.
- Risks with no owner or mitigation.
- Asks with no decision named ("visibility on pipeline" is a worry, not an ask).
