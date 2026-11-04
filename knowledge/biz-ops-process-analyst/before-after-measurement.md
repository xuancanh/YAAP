---json
{ "title": "Before-and-after measurement", "summary": "Set a baseline, define success before the change, read a run chart honestly, and report results including the ones that did not work.", "tags": ["improvement", "measurement", "baseline", "run-chart", "experiment"], "updated": "2026-11-04" }
---

# Before-and-after measurement

An improvement case is only as good as the evidence that it worked. Decide how you will judge it before you change anything; deciding afterwards lets any result look like success.

## Write the measurement plan first

Fill this in the improvement case before the change goes live:

```
Metric: <cycle time median | first-pass yield | error count | cost per item>
Definition: <clock start/stop, unit, rework definition — as in the process map>
Baseline period: <dates>, n = <items>
Change date: <date>; rollout: <all items | one team | one item type>
After window: <dates>, expected n = <items>
Success threshold: <e.g. median down by at least X, chosen with the owner>
Guardrail: <metric that must not get worse, e.g. error rate, customer complaints>
Rollback trigger: <what result makes us undo it>
```

Choose the threshold with the process owner. It should be a change big enough to matter to them, not one sized to whatever you expect to see.

## Getting a fair baseline

- **Use the same definition** you will use after. If you fix the definition mid-way, re-measure the baseline.
- **Use enough periods** to see normal variation: several weeks of weekly figures, not one week.
- **Watch for seasonality.** Month-end, holidays and launches change volume. Compare like with like, or note the difference.
- **Avoid a baseline that is already moving.** If the metric was improving before your change, a simple before/after will credit you with that trend.

## Reading the result with a run chart

Plot the metric per week (or per batch) across baseline and after, with the change date marked. Then ask:

1. Did the level shift after the change and stay shifted, or is it one good week?
2. Is the after period inside the range the baseline already showed? If so, you cannot tell the change from normal noise.
3. Did volume or mix change at the same time? (Fewer complex items will lower cycle time on their own.)
4. Did the guardrail hold?

A run of several consecutive points on the better side of the baseline median is more convincing than one big point. Avoid declaring success from one period.

## Ways to make the comparison stronger

- **Staged rollout:** change one team or item type first; compare it with the others over the same weeks.
- **Switch back:** for low-risk changes, revert for a short period and see whether the metric returns.
- **Count, don't guess:** replace estimated touch times with sampled timings for both periods.

Use what fits the risk and the volume. A small-volume process may never give a clean signal; say that rather than over-reading it.

## Reporting

Write the result in /org/operations/improvements.md beside the original case:

> **Approval reminders** — baseline median 2.1 days (6 weeks, n=48), after 0.9 days (6 weeks, n=51). Shift held for all six weeks; volume similar. Guardrail (rejected approvals) unchanged. **Met** the threshold agreed with the owner. Next: make the reminder part of the SOP.

When it did not work:

> **Template for intake form** — first-pass yield unchanged (baseline and after both within normal range). Likely cause: requesters skip the template when sending by email. **Not met.** Rolled back; propose a form-only intake instead.

Negative results get the same space and the same place as positive ones. They stop the company from repeating the change elsewhere.

## Pitfalls

- Moving the success threshold after seeing the data.
- Comparing a quiet month with a busy one.
- Counting the improvement from day one, when people are still learning the new way; allow a settling period and say how long.
- Claiming hours saved without checking that the time was used for something else.
