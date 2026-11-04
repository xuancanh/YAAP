---json
{ "title": "Pipeline incident playbook", "summary": "How to triage a failed, late or wrong data load, fix it safely, backfill, tell consumers and prevent a repeat.", "tags": ["pipelines", "incidents", "backfill", "data quality"], "updated": "2026-11-04" }
---

# Pipeline incident playbook

When a pipeline breaks, the real risk is not the broken table; it is someone making a decision on it before you notice. Contain first, then fix.

## Classify the failure

| Symptom | Likely causes | First check |
|---|---|---|
| **Failed:** job errored | Source schema change, expired credentials, quota, a code change, resource limits | The error message and the last change to code or config |
| **Late:** job did not run or is still running | Scheduler issue, upstream delay, a slow query, lock contention | Upstream freshness and job run history |
| **Wrong:** job ran, data is incorrect | Logic bug, duplicated input, join fan-out, missing records, time zone, a changed definition upstream | Failing tests' rows; compare with the previous day and with the source |

"Wrong" is the most dangerous because nothing looks broken.

## Step 1: Contain

- Is a published table or dashboard affected? If yes, tell its consumers now: what is affected, since when, and that a fix is in progress. A short note beats silent wrong numbers.
- If bad data is still flowing, stop the downstream builds or mark the table as stale, within your granted permissions.
- Raise an incident with your manager if a decision, report or customer-facing number may already have used the bad data.

## Step 2: Find the cause

Work backwards along the lineage:

1. Find the first model where the data is wrong. Test each upstream step's output (counts, keys, a known total).
2. At that step, compare inputs and outputs for one affected record. Follow a single ID through.
3. Check what changed: code commits, source schema, source volume, configuration, credentials, the date (month end, daylight-saving change).

Common data-specific causes:

- **Join fan-out:** a dimension gained duplicate keys, so facts multiply.
- **Late-arriving data:** incremental load's window missed records updated after it ran.
- **Silent schema change:** a column renamed or retyped; values now null.
- **Time zones:** "yesterday" computed in a different zone than the source.
- **Duplicates on retry:** a non-idempotent insert ran twice.

## Step 3: Fix

- Fix the cause in code, with a test that fails on the bad data and passes after.
- Make the fix in your sandbox; deploying to the production pipeline follows the company's grants and review.
- Prefer a fix that makes the load idempotent, if that was part of the problem.

## Step 4: Backfill

1. Determine the affected period exactly, from the first bad load to now.
2. Re-run the affected models for that period. Because loads are idempotent (they should be), re-running replaces bad rows.
3. Validate: tests pass, totals for the period match the source or the reconciliation, spot-check a few records.
4. Check downstream extracts, exports and snapshots that copied the bad data; they may need a rerun too.

## Step 5: Tell people it's fixed

Tell the same consumers: what was wrong, the period affected, whether any reported number changed (with before and after for the key ones), and that it is fixed.

## Step 6: Write it up

Save a short note per your pipeline-fix skill:

```markdown
## <date> <table/pipeline>: <symptom>
Impact: <tables, dashboards, period, people told>
Cause: <one or two sentences>
Fix: <change, link>
Backfill: <period, validation done>
Prevention: <test added, alert added, process change>
Detection: <how we found out; how long it took>
```

Count it in the pipeline incidents KPI (see [data reliability metrics](data-reliability-metrics.md)).

## Prevention patterns

- A test for the exact failure, at the step where it entered.
- Look-back windows on incremental loads to catch late updates.
- Uniqueness tests on dimension keys to catch fan-out.
- Schema change alerts from the source, or a contract with its owner.
- Freshness checks that run on a schedule, not only after builds.
