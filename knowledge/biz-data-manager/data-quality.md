---json
{ "title": "Data quality dimensions and checks", "summary": "The six common data quality dimensions, a concrete check for each, how to compute the unit's quality KPIs, and when a failure becomes an incident.", "tags": ["data", "data-quality", "testing", "freshness"], "updated": "2026-11-04",
  "sources": [
    { "title": "Meet the data quality dimensions", "url": "https://www.gov.uk/government/news/meet-the-data-quality-dimensions", "publisher": "UK Government Data Quality Hub", "accessed": "2026-11-04", "note": "Uses the six dimensions from the DAMA UK working group paper (October 2013)." }
  ] }
---

# Data quality dimensions and checks

Your data-quality-review playbook runs the checks. This doc says which
checks to have, what each catches, and how to turn results into the
unit's KPIs. The six dimensions below come from a 2013 DAMA UK working
group paper and are widely used, including by the UK government's Data
Quality Hub. They are a vocabulary, not a scorecard: pick the ones each
critical table needs and set thresholds by what the data is used for.

## Dimensions and checks

| Dimension | Question | Typical check |
|---|---|---|
| Completeness | Is everything there that should be? | null rate per required column; row count vs expected (yesterday, same weekday last week) |
| Uniqueness | Is anything there twice? | primary key unique; no duplicate events by (id, timestamp) |
| Timeliness | Is it fresh enough for its use? | max(loaded_at) within the table's freshness SLA |
| Validity | Does it fit the rules? | allowed values (status in a list), formats (email, currency code), ranges (amount ≥ 0) |
| Accuracy | Does it match reality? | reconcile totals with the system of record (billing, CRM) on a sample |
| Consistency | Does it agree with itself and other sources? | foreign keys resolve; the same metric matches across two tables |

Accuracy is the hardest to automate, and the one that matters most for
finance numbers. A monthly reconciliation against the source system
catches what row-level tests can't.

## Critical tables

`/org/data/quality/critical.md` lists what the checks cover. For each:

```markdown
| Table / source | Feeds | Owner | Freshness SLA | Tests | Reconciled against |
|---|---|---|---|---|---|
| orders | revenue KR, finance dashboard | Analytics Engineer | 06:00 UTC daily | pk unique, amount ≥ 0, status valid | billing export (monthly) |
```

A table is critical when a key result, a recurring report, or an outward
number depends on it. Keep the list short enough to check every day.

## Anomaly checks

Volume and null-rate anomalies catch failures nobody wrote a test for. The
playbook's default flags a value more than 3 standard deviations from its
trailing 14-day mean; the company tunes both numbers (tighter for finance).
Compare like with like: weekday traffic against weekdays, or the
check fires every Monday. A flagged anomaly is a question, not a verdict:
a marketing launch is a real spike.

## The unit's quality KPIs

```text
freshness SLA met % = critical tables updated within SLA ÷ critical tables × 100   (per check, averaged over the week)
test pass rate %    = data tests passing ÷ data tests run × 100
```

Write down whether freshness is measured per table or per metric source,
and whether a test that was skipped counts as run. Those two choices are
what the audit re-checks.

## When it's an incident

A failed check is a fix task for the owner. It becomes an incident
(`org_report_incident`) when bad data has already reached a decision, a
report, a key result check-in, or anything outward. Then:

- [ ] tell the owners of everything downstream (the "Feeds" column);
- [ ] mark affected numbers in reports as unreliable until fixed;
- [ ] fix the data, then backfill, then re-run the affected reports;
- [ ] note the cause and the new check that would have caught it in
      `/org/data/quality/<week>.md`.

## Worked example (made-up figures)

This week 12 critical tables were checked daily (84 checks); 79 were within
SLA, so freshness SLA met = 79 ÷ 84 × 100 = 94%. Of 310 data tests run, 301
passed: test pass rate = 97.1%. Four of the five freshness misses were the
same upstream export, so the weekly file records one root cause, not five.

## Common pitfalls

- **Tests that never fail.** A test written against today's data that has
  never fired may be checking nothing. Review tests when they stay green
  for months on volatile data.
- **Alert fatigue.** Too many low-value checks and people stop reading
  them. Each check should have an owner and an action.
- **Fresh but wrong.** A pipeline can load on time and load garbage.
  Freshness without validity checks is false comfort.
- **Fixing data in the dashboard.** Patch at the source or the model, not
  in a chart filter, or the next consumer gets the bad data.
