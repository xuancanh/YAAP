---json
{ "title": "Query hygiene and sanity checks", "summary": "How to write queries that re-run to the same answer, and the checks that catch the common SQL mistakes before a number leaves your hands.", "tags": ["sql", "reproducibility", "data quality", "checks"], "updated": "2026-11-04" }
---

# Query hygiene and sanity checks

A number you cannot reproduce is a number you cannot defend. A number you did not check is one you will have to retract.

## Make it re-runnable

- **Save every query** that produced a reported number, with a header:

```sql
-- Question: <one line> | Task: <link>
-- Metric: <catalogue name> | Author: BI Analyst | Date: <date>
-- Period: 2026-10-01 to 2026-10-31 (UTC) | Filters: excl. internal/test
```

- **Fix the dates.** Use explicit dates, not `now()` or "last 30 days", for any number you report. Rolling windows give different answers tomorrow.
- **Read from marts**, not staging or raw tables, unless you note why.
- **Name the time zone.** Day boundaries in UTC and in local time give different daily counts.
- **No manual steps.** If you edited a spreadsheet after the query, the answer is no longer reproducible. Move the step into SQL or document it exactly.

The KPI "answers reproducible on re-run" is measured by re-running saved queries; see [KPI pack template and analyst metrics](kpi-pack-and-metrics.md).

## Common mistakes and how to catch them

| Mistake | What it does | Check |
|---|---|---|
| Join fan-out | One-to-many join multiplies sums | Compare row counts and totals before and after the join |
| `COUNT(*)` vs `COUNT(DISTINCT id)` | Counts rows, not entities | Ask "what is one row?" before counting |
| Inner join drops rows | Records with no match vanish silently | Use a left join and count unmatched rows |
| `NULL` in filters | `WHERE status != 'x'` excludes nulls too | Count nulls separately |
| Averages of averages | Weights every group equally | Recompute from totals: `sum(numerator) / sum(denominator)` |
| Integer division | `3/4 = 0` in some databases | Cast to decimal |
| Incomplete period | Current day or month looks like a drop | Exclude it or label it partial |
| Test or internal accounts | Inflate usage | Apply the standard exclusion filter |
| Time-zone boundaries | Events land on the wrong day | Convert explicitly; state the zone |
| Duplicated events | Retries or double tracking | Check uniqueness on event ID |

## Sanity checks before you send

Run at least these:

1. **Expectation check.** Is the result near what you expected before querying? If not, find out why before believing it.
2. **Known total.** Does a total match a trusted figure (finance's monthly revenue, the product's own admin count)? Explain any gap.
3. **Grain check.** `count(*)` equals `count(distinct key)` at the level you claim.
4. **Breakdown sums.** Segments add up to the total. If not, something is missing or double-counted.
5. **Trend check.** Plot the metric over a longer period. Sudden jumps often mean a tracking or definition change, not a business change.
6. **Spot check.** Pick two or three records and follow them through the query by hand.
7. **Second method.** For important numbers, compute it another way (a different table, a simpler query). Agreement is strong evidence.

## When the data looks wrong

- Check whether the Analytics Engineer's tests or freshness checks are failing for those tables.
- If a mart is wrong, report it to the Analytics Engineer with the query and the evidence. Do not patch around it silently in your query; others will hit the same problem.
- Label any answer that depends on suspect data, or hold it until fixed.

## Sharing a query

When someone else will re-run your work, include the path to the saved query, the exact parameters, the expected result for the original period, and any known caveats. That lets them confirm they get the same number before changing anything.
