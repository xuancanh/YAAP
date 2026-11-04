---json
{ "title": "Coordinator metrics", "summary": "Definitions and formulas for milestones on time and RAID items owned, with counting rules, a reporting table and how each gets gamed.", "tags": ["kpis", "milestones", "raid", "metrics"], "updated": "2026-11-04" }
---

# Coordinator metrics

Your two KPIs measure whether programs are planned honestly and whether problems have someone working on them. Both are easy to make look good and hard to make mean something; the counting rules below keep them meaningful.

## Milestones on time

**What it answers:** do programs deliver what they said, when they said?

**Formula:** milestones completed on or before their baseline date ÷ milestones whose baseline date fell in the period, as a percentage.

**Counting rules:**
- **Baseline date** is the date in the confirmed charter or the last sponsor-approved re-plan. A forecast change is not a re-plan.
- A milestone completed late counts as late, even if it was re-forecast weeks ahead.
- Completion needs the "done when" test met, with evidence (a check, a reconciliation, a sign-off), not an owner saying it is nearly there.
- Report alongside it:
  - **Average slip** of late milestones, in days: Σ (actual − baseline) ÷ number of late milestones.
  - **Re-baselines** in the period: count of milestone dates changed by approved re-plan.

A high on-time rate with many re-baselines means the plan keeps moving to meet the work. Show both so the reader can see it.

**Gamed by:** soft milestones ("work started"), padded dates, or frequent re-baselining. Guard: milestones as checkable states, dates agreed with owners, and re-baselines reported.

## RAID items owned

**What it answers:** does every known problem have someone acting on it?

**Formula:** open RAID rows with a named, confirmed owner and a dated next action ÷ all open RAID rows, as a percentage. Compute it at the weekly review.

**Counting rules:**
- **Confirmed owner** means the person agreed, on the task or in writing. A name you filled in without asking does not count.
- **Dated next action** means a mitigation, validation or fix step with a date that has not passed. A row whose action date passed without update counts as unowned until refreshed.
- Count each open row once: risks, assumptions, issues and dependencies alike.
- Report separately:
  - **Unowned high items:** high-impact risks and issues without an owner. Target zero; list them by ID.
  - **Overdue actions:** rows whose next-action date passed.

**Gamed by:** closing rows that are not resolved, or not logging uncomfortable ones. Guard: every close has a one-line resolution; issues raised in syncs or status that are missing from the log are added at the review.

## Supporting signals (not KPIs, but worth watching)

- **Issue age:** days since each open issue was raised. Old issues signal a fix nobody owns in practice.
- **Decision lead time:** days from "decision needed" in the status to the decision being recorded.
- **Dependency acceptance time:** days from a cross-unit request to its acceptance.

## Reporting

```
| Program | Milestones on time (period) | Avg slip | Re-baselines | RAID owned | Unowned high | Overdue actions |
|---|---|---|---|---|---|---|
| Support tool rollout | 3/4 | 1 day | 0 | 11/12 | 0 | 1 |
```

Add one line per miss explaining the cause and what changes next time. At the program retro, compare these numbers with the charter's delivery measures and keep them for comparison across programs.
