---json
{ "title": "Operational metrics", "summary": "Formulas and definition choices for the core operations metrics — cycle time, lead time, throughput, WIP and Little's Law, first-pass yield, SLA attainment, backlog age, cost per unit, SOP coverage, automation rate and vendor spend variance.", "tags": ["metrics", "kpis", "formulas", "operations"], "updated": "2026-11-04",
  "sources": [
    { "title": "A Proof for the Queuing Formula: L = λW", "url": "https://doi.org/10.1287/opre.9.3.383", "author": "John D. C. Little", "publisher": "Operations Research 9(3)", "date": "1961", "note": "Little's Law: average items in system = arrival rate × average time in system, for a stable system over the long run." }
  ] }
---

# Operational metrics

A metric is only useful if everyone computes it the same way. For each one, /org/operations/kpis.md should record the formula, the start and stop events, the unit, the source and the choices below. The monthly KPI audit checks the numbers against these definitions; drift is a finding.

## Flow metrics

**Cycle time** = time the item's work ends − time its work starts.
Choose and write down: which events (task claimed → accepted? order received → shipped?), calendar or business hours, and whether paused time counts. Report the **median** and a high percentile (say the 85th) rather than the mean: a few stuck items distort the mean.

**Lead time** = time delivered − time requested. It includes queue time before work starts, which is what the customer feels. Lead time ≥ cycle time.

**Throughput** = items completed ÷ period length (per day or per week).

**Work in progress (WIP)** = items started and not finished, at a point in time.

**Little's Law** (Little, 1961): for a stable system over the long run,

```
average WIP = average throughput × average time in system
so average time in system = average WIP ÷ average throughput
```

Use it to sanity-check numbers and to see that, at the same throughput, more WIP means longer waits. It holds for long-run averages of a stable process; it won't predict a single item.

**Flow (process cycle) efficiency** = value-adding work time ÷ total elapsed time. Low efficiency means items mostly wait; cut waiting before speeding up work.

**Backlog age** = now − request time for each open item; report the oldest and the count past target.

## Quality metrics

**First-pass yield (FPY)** = units that pass the step with no rework ÷ units that entered the step.
For agent work, "accepted at first review ÷ reviewed" is the same idea.

**Rolled throughput yield (RTY)** = FPY of step 1 × FPY of step 2 × … × FPY of step n. It shows the chance an item gets through the whole process untouched, and why a long chain of "pretty good" steps can be poor overall.

**Rework rate** = units reworked ÷ units completed.

## Service metrics

**SLA attainment (adherence)** = items completed within their SLA target ÷ items whose SLA came due in the period.
Choose: count by due date or completion date (be consistent); calendar or business hours; whether items paused awaiting the customer stop the clock; how open items already past target count (include them as misses, or you'll flatter the number).

**SLA breaches** = count of items past target, and **repeat breaches** per process (the trigger for a process review in cadence.md).

## Cost and coverage metrics

**Cost per unit (transaction)** = total cost of the process in the period ÷ units completed.
Choose: include or exclude vendor fees, agent spend (org_costs), and shared overhead. State it in kpis.md; the KPI audit checks it.

**SOP coverage** = recurring processes with a current SOP ÷ recurring processes in the inventory. "Current" means reviewed within the interval in cadence.md.

**Automation rate** = steps (or items) completed without manual touch ÷ total steps (or items). Say which, and what counts as a touch.

**Vendor spend variance** = (actual spend − budgeted spend) ÷ budgeted spend, per vendor and in total. **Seat utilisation** = active seats ÷ paid seats.

## Worked example (made up)

Invoice approval, one week: 40 invoices approved; at any time about 20 were in progress.
Little's Law: 20 ÷ (40 per week) = 0.5 weeks average time in system, about 2.5 business days. If the SOP says the target is 1 day, the process can't hit it without cutting WIP or raising throughput. Of the 40, 30 passed first review: FPY = 30 ÷ 40 = 0.75. The same 40 had SLA due; 34 met it: SLA attainment = 34 ÷ 40 = 85%.

## Pairing leading and lagging

Lagging metrics (cost per unit, SLA attainment) tell you how it went. Leading metrics (SOP coverage, automation rate, FPY, WIP) move first. Each key result set should pair one of each, so you see trouble before the lagging number does.

## Common pitfalls

- **Means for time.** Use medians and percentiles.
- **Changing the definition mid-quarter.** If you must, report both for one period and note the break.
- **Dropping open items.** Excluding items still open past target hides the worst ones.
- **Gaming the clock.** Pausing items to protect SLA. Track pause time.
- **Unlabelled estimates.** A hand-counted number is an estimate until it has a source; say so in the report.
