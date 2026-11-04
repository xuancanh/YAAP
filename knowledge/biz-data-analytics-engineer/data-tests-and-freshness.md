---json
{ "title": "Data tests and freshness", "summary": "Which data tests each kind of model needs, how to set warn and error severities, and how to set freshness thresholds.", "tags": ["data tests", "freshness", "data quality", "dbt"], "updated": "2026-11-04",
  "sources": [{ "title": "dbt documentation, Add data tests to your DAG (read 2026-11-04)", "url": "https://docs.getdbt.com/docs/build/data-tests" },
              { "title": "dbt documentation, source freshness", "url": "https://docs.getdbt.com/reference/resource-properties/freshness" }] }
---

# Data tests and freshness

A data test is a query that looks for rows that break an assumption. Zero rows means pass. This is how dbt defines its tests, and the idea works in any tool.

## The baseline set

dbt ships four generic tests that cover most structural problems: `unique`, `not_null`, `accepted_values` and `relationships`. Apply them like this:

| Model type | Minimum tests |
|---|---|
| Staging | Primary key `unique` and `not_null`; `accepted_values` on status-like columns you depend on |
| Fact | Grain key `unique` and `not_null`; each foreign key `relationships` to its dimension; key measures `not_null` |
| Dimension | Primary key `unique` and `not_null`; required attributes `not_null` |
| Snapshot / SCD | No overlapping validity ranges per entity; exactly one current row per entity |

## Business-rule tests

Add these where a wrong value would change a decision:

- **Ranges:** amounts not negative (unless refunds are), percentages between 0 and 1, dates not in the future.
- **Reconciliation:** the mart's total for a period equals the source's total, within a stated tolerance and with the reasons for any difference.
- **Volume:** today's row count is not wildly off recent days. Compare with a rolling baseline rather than a fixed number.
- **Consistency:** an order's line totals sum to the order total; every paid invoice has a payment.
- **Uniqueness of a combination:** one row per customer per day.

Write each custom test so its failing rows explain the problem: return the IDs and values, not just a count.

## Severity

Not every failure should stop the pipeline.

- **Error (block):** the data would mislead. Key duplicates, broken joins, reconciliation off. Stop downstream models from building on it.
- **Warn:** worth a look, not yet harmful. A new enum value, a small volume dip.

Review warnings weekly. A warning that has fired for weeks is either a real problem or a bad test; fix one or the other.

## Freshness

Freshness asks: is the newest data recent enough for the decision it serves?

1. **Start from the use.** A daily revenue dashboard read each morning needs yesterday's data loaded by the morning; a real-time ops view needs minutes.
2. **Measure on a timestamp that reflects arrival**, such as a loaded-at column, or the newest event time if the source is steady.
3. **Set two thresholds:** warn when data is later than usual; error when it is too late for the use.
4. **Account for gaps that are normal:** weekends, overnight batches, source maintenance windows.

Record each critical table's freshness SLA (the promised maximum age) in the catalogue, with the consumer it serves. That SLA is what the KPI measures.

## Where tests run

- On every build of the model, before downstream models read it.
- On a schedule for freshness, independent of builds, so a stopped pipeline is noticed.
- In the change review: a model change should come with its tests.

## When a test fails

1. Read the failing rows. Is the data wrong, or the assumption?
2. If the data is wrong, follow the [pipeline incident playbook](pipeline-incident-playbook.md). Tell consumers if a published table is affected.
3. If the assumption is wrong (a legitimate new status value), update the test and the docs together, and note the change.
4. Never delete or loosen a test just to get green without writing down why.

## Pitfalls

- Tests only on staging. Joins and logic in marts are where most errors are introduced.
- Exact-count volume tests. Real data varies; use ranges based on history.
- Freshness on a column the pipeline sets to "now" on every run. It is always fresh and tells you nothing.
