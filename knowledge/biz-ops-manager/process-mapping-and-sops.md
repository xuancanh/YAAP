---json
{ "title": "Process mapping and SOPs", "summary": "How to map a recurring process (SIPOC, step table, swimlanes) and write an SOP people actually follow, with a copyable template and a check that the SOP matches the work.", "tags": ["process", "sop", "mapping", "template"], "updated": "2026-11-04",
  "sources": [
    { "title": "SIPOC (Supplier, Inputs, Process, Outputs, Customer)", "url": "https://digital.ahrq.gov/health-it-tools-and-resources/evaluation-resources/workflow-assessment-health-it-toolkit/all-workflow-tools/sipoc", "publisher": "Agency for Healthcare Research and Quality" }
  ] }
---

# Process mapping and SOPs

You can't improve or measure a process nobody has written down. Map it at three levels of detail, only as far as the question needs: a SIPOC for scope, a step table for measurement, and a swimlane when hand-offs are the problem. Then write the SOP from the map, not from memory.

## Level 1: SIPOC (scope)

One row per column, a handful of items each. It fixes where the process starts and ends before anyone argues about steps.

```markdown
| Suppliers | Inputs | Process (5–7 high-level steps) | Outputs | Customers |
|---|---|---|---|---|
| Sales | signed order | 1. receive order → 2. check stock → 3. pick → 4. ship → 5. confirm | shipped order, tracking | customer, finance |
```

A useful order for filling it in: the process steps first, then outputs and customers, then inputs and suppliers. Write down the **trigger** (the event that starts it) and the **end state** (the event that ends it); these become the start and stop events for cycle time.

## Level 2: step table (measurement)

```markdown
| # | Step | Owner (role) | Input | Output | Work time | Wait before | Rework? | Manual / automated | System |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Check stock | ops-specialist | order | stock confirmed | <measured> | <measured> | no | manual | inventory sheet |
```

Fill times from the record (task timestamps on the board, org_metric_read) or observe a handful of real runs. Where you only have someone's recollection, label the cell "estimate (owner)". The gap between work time and elapsed time is usually where the improvement is.

## Level 3: swimlanes (hand-offs)

One lane per role or unit, steps placed in the lane that does them, arrows across lanes for hand-offs. Draw it when the problem is between people: every arrow crossing a lane is a queue, a possible SLA, and a row in /org/handoffs.md if it crosses functions. In Markdown, a step table with an "owner" column and a "hand-off to" column is usually enough.

## SOP template

Save under /org/operations/sops/<process-slug>.md and link it from /org/operations/processes.md.

```markdown
# SOP: <process name>

Owner: <function / member> · Version: <n> · Last reviewed: <yyyy-mm-dd> · Next review: <date per cadence.md>
Trigger: <event that starts it> · End state: <event that ends it>
Cycle-time target: <from kpis.md> · SLA: <if any, and calendar vs business hours>

## Purpose
<One sentence: why this exists and for whom.>

## Inputs and prerequisites
- <what must be true or available before step 1>

## Steps
1. <Verb-first instruction.> — owner: <role> — done when: <checkable result>
2. …

## Decision points
- If <condition>, then <path>; otherwise <path>.

## Exceptions and escalation
- <what goes wrong, what to do, who to tell, within what time>

## Controls
- <the check that catches errors, and who performs it>

## Records
- <what gets written where: file, task, metric>

## Change log
| Version | Date | Change | Agreed by (process owner) | Before/after measure |
|---|---|---|---|---|
```

## Checklist: does the SOP match the work?

- [ ] Pick a few recent runs of the process on the board (org_read_board). Did each follow the SOP's steps in order?
- [ ] Are there steps people do that the SOP doesn't mention, or SOP steps nobody does?
- [ ] Are the owners named in the SOP the ones doing the work?
- [ ] Does the trigger and end state match how cycle time is computed in kpis.md?
- [ ] Is the last-reviewed date inside the review interval in cadence.md?
- [ ] Did the process owner agree to the current version (change log)?

If two or more answers are no, the SOP is out of date: a finding in your monthly audit and a task for the owner, not a quiet rewrite.

## Common pitfalls

- **Mapping the ideal, not the actual.** Map what happens today, including workarounds. The ideal comes after.
- **Too much detail too soon.** A 40-step map nobody reads helps no one. Go as deep as the question needs.
- **SOPs written by the wrong person.** The person who does the work drafts or confirms it; you review.
- **No trigger or end state.** Without them, cycle time can't be measured consistently.
- **Changing the process while mapping it.** Agree the current map with the owner first; propose changes separately, with a before and after.
