---json
{ "title": "Data reliability metrics", "summary": "Definitions and formulas for freshness SLA met, test pass rate and pipeline incidents, with how to read them together.", "tags": ["metrics", "kpi", "freshness", "data quality"], "updated": "2026-11-04" }
---

# Data reliability metrics

Your three KPIs answer three questions: is the data on time, is it correct as far as tests can tell, and how often does it break in a way people notice? Compute them from the scheduler, test results and incident notes, never from memory.

## Freshness SLA met

Each critical table has a freshness SLA: the maximum allowed age of its newest data at the time it is needed (see [data tests and freshness](data-tests-and-freshness.md)).

```
freshness check passed = (check time − newest data time) ≤ SLA
freshness SLA met      = freshness checks passed / freshness checks run
```

Run checks on a fixed schedule, at least at the time consumers rely on the table (for example, before the morning dashboard is read). Report per critical table and overall, for the period.

Variants worth tracking when the overall number dips:

- **Minutes late** per breach: one table five minutes late is different from one a day late.
- **Breaches by cause**: upstream source, scheduler, slow model, failure.

## Test pass rate

```
test pass rate = test executions passed / test executions run
```

Count executions, not distinct tests, so a test that fails every day for a week counts seven times. Report errors and warnings separately:

```
error-test pass rate = error-severity executions passed / error-severity executions run
```

A high pass rate is good only if the tests cover what matters. Pair it with **critical-table coverage**:

```
critical-table coverage = critical tables with key, relationship and
                          freshness tests / critical tables
```

Pitfalls: disabled or deleted tests disappear from the denominator. List tests disabled in the period next to the rate.

## Pipeline incidents

```
pipeline incidents = incidents in the period where a pipeline failed,
                     was late beyond its SLA, or produced wrong data
                     that reached a consumer table
```

Rules:

- Count an incident once, however many tables it touched.
- Include incidents found by consumers as well as by tests; tag which.
- Record time to detect (`detected − first bad load`) and time to resolve (`backfill validated − detected`).

The share of incidents detected by tests rather than by people is a strong signal of test quality:

```
detected by tests = incidents first detected by a test or freshness check
                    / pipeline incidents
```

## Reading them together

| Pattern | Likely meaning | Action |
|---|---|---|
| Pass rate high, incidents found by people | Tests check the wrong things | Add tests for each incident's cause; reconciliation tests |
| Freshness low, pass rate fine | Scheduling or upstream delay | Look at breach causes; talk to source owners |
| Many warnings, few incidents | Noisy tests | Tune or remove; warnings should be rare |
| Incidents clustered on one source | Fragile source | Contract with owner, schema alerts, staging tests |

## Reporting format

```markdown
| Metric | This period | Last period | Target | Note |
| Freshness SLA met | 97% | 99% | <from kpis.md> | Billing source late 3 days |
| Error-test pass rate | 99.2% | 99.5% | | 2 tests disabled (listed) |
| Pipeline incidents | 2 | 1 | | 1 found by a dashboard user |
| Detected by tests | 1 of 2 | 1 of 1 | | Added reconciliation test |
```

Leave a target blank if none is set in `/org/data/kpis.md`, rather than inventing one.
