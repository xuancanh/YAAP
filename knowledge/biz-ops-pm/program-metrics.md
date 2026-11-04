---json
{ "title": "Program Manager metrics", "summary": "Definitions and formulas for the Program Manager's KPIs, how to measure each from the record, and how each one gets gamed.", "tags": ["kpis", "metrics", "program-management", "definitions"], "updated": "2026-11-04" }
---

# Program Manager metrics

Your KPIs measure whether the program machinery works: fresh status, check-ins on time, resources answered before work waits, milestones met, breakers decided fast. They are hygiene measures. The outcome measure is always the key result each project serves, and a project with perfect hygiene and an unmoved key result has still failed.

Measure each one over a fixed period (a week for the rhythm measures, a quarter for milestones) and state the period when you report.

## Fresh status coverage

**What it answers:** does every goal and project you own have a current status?

**Formula:** owned items with a status update inside their cadence ÷ owned items, as a percentage.

**Counting rules:** an item is fresh if its last update is no older than its own cadence (a weekly project needs one in the last 7 days). Items paused or closed in the period are excluded.

**Gamed by:** posting empty "no change" updates. Guard: an update with no evidence line counts as stale.

## Key-result check-ins on cadence

**Formula:** key-result check-ins made by their due date ÷ check-ins due, in the period.

**Counting rules:** a check-in counts only with a value (from the source, or your best measure labelled as such) and a confidence with its reason.

**Gamed by:** copying last week's value. Guard: note the source and date of the reading.

## Resource requests answered before work waits

**What it answers:** did you ask early enough that nobody sat idle waiting for a person?

**Formula:** resource requests answered before the window start ÷ resource requests whose window started in the period.

**Counting rules:** "answered" means approved, adjusted, declined or hiring — any answer. A request filed after its own window started counts as a miss.

**Lever:** this is mostly about you asking early. Ask at kickoff and at each re-plan, not when the milestone arrives.

## Milestones on time

**Formula:** milestones ticked done on or before their date ÷ milestones due in the period.

**Counting rules:**
- Use the date as it stood at the start of the period. A milestone re-dated during the period and then met still counts as late.
- Done means done on evidence: a passed check, a reviewed task, a measured number.
- Report the count of re-dated milestones beside the rate, so a high rate with many re-dates is visible.

**Gamed by:** setting milestones as activities ("design review held") instead of observable states, or padding dates. Guard: milestones must be states, and dates sit inside the appetite.

## Breaker decisions within a day

**Formula:** breaker trips where the decision memo reached the decider within one working day ÷ breaker trips in the period.

**Also track:** time from trip to the decider's answer. That is not yours to control, but long waits are worth raising with the chief.

## Reporting your KPIs

Use a small table in the weekly program review:

| KPI | This period | Last period | Misses and why |
|---|---|---|---|
| Fresh status coverage | 5/6 | 6/6 | ONB update skipped while owner was on another bet |
| Milestones on time | 2/3 (1 re-dated) | 3/3 | M2 slipped on vendor sandbox |

Always pair a miss with its cause. A number without a cause does not help anyone improve.

## Outcome check

For each project, keep a single line beside the hygiene table: the key result's baseline, its current value and its source. That line is what the CEO actually reads.
