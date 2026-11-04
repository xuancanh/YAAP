---json
{ "title": "Dashboard standards", "summary": "What every core dashboard must carry, a review checklist before one is published, and how to measure and prune for adoption.", "tags": ["data", "dashboards", "bi", "adoption"], "updated": "2026-11-04" }
---

# Dashboard standards

A dashboard earns its place by being looked at before a decision. Most
don't: they answer a question someone asked once and then sit there,
slowly going stale and disagreeing with the next one. These standards keep
the set small, trusted and used, which is what the adoption KPI measures.

## What every core dashboard carries

A "core" dashboard is one a key result, a ritual or a recurring report
depends on. Each one shows, on its face:

- **Purpose**: one line on the decision or ritual it serves ("Weekly
  review: is activation on pace?").
- **Owner**: the member who keeps it right, and the function that uses it.
- **Definitions**: every metric links to its spec in `/org/data/metrics.md`;
  no metric defined only inside the chart.
- **Freshness**: "data as of <timestamp, time zone>", and a visible warning
  when a source is stale or failed (from `org_metric_sources` status).
- **Targets**: where a key result applies, the target and the pace line,
  so "good or bad" doesn't need explaining.
- **Caveats**: known gaps (a backfill, a tracking outage) in a note, not in
  someone's head.

## Layout rules

- The question first: headline numbers at the top, detail below.
- One idea per chart; a title that says what it shows ("Signups per week,
  last 12 weeks"), not just the metric name.
- Show trend and context, not a lone number: compared with what, against
  which target, over which period.
- Same metric, same colour, same scale everywhere.
- Axes from zero for bar charts; label units and time zone.
- Fewer filters. Each filter is a way to get a different answer and argue
  about it.

## Review checklist before publishing

- [ ] Purpose and owner stated; it serves a real decision or ritual.
- [ ] Every number reconciles with its source for at least one period
      (spot-check with `org_metric_read` or the saved query).
- [ ] Definitions link to the catalogue; none redefined locally.
- [ ] Freshness timestamp and stale warning work.
- [ ] Filters default to the view the ritual needs.
- [ ] No personal or customer data beyond what the audience is allowed to
      see under the company's privacy rules.
- [ ] Doesn't duplicate an existing dashboard; if it replaces one, the old
      one is retired.
- [ ] Reviewed by someone other than the builder (`org_request_review`).

## Measuring adoption

```text
dashboard adoption = distinct weekly viewers of core dashboards
                     (or: core dashboards viewed at least once in the week ÷ core dashboards × 100)
```

Pick one form, write it in `/org/data/kpis.md`, and say whether agents'
reads count or only people's. A dashboard read only by the agent that
built it is not adopted.

## Pruning

Monthly, list dashboards nobody viewed in the period (the company sets
how long). For each: retire it, merge it into a core one, or name who
needs it and why they aren't using it. Announce retirements with
`org_message` and keep the saved queries, so the answer can be rebuilt if
someone asks.

## Worked example (made-up)

The Sales head asks for a "pipeline dashboard". Intake finds the decision:
whether to hire another seller next quarter. That needs one chart (pipeline
coverage versus target by month) added to the existing sales dashboard,
not a new dashboard with fifteen tiles. Sized S, done in a day, and the
adoption count doesn't get diluted.

## Common pitfalls

- **Dashboards as answers.** A dashboard is for monitoring a recurring
  question. A one-off question gets a written answer in
  `/org/data/answers/`.
- **Numbers that disagree.** Two dashboards showing different "revenue"
  destroy trust in both. One definition, one place.
- **No freshness shown.** People act on yesterday's failure as if it were
  today's number.
- **Vanity layouts.** Gauges and big totals that never change tell no one
  what to do. Show movement against a target.
