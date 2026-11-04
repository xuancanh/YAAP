---json
{ "title": "Process improvement", "summary": "How to find a process's bottleneck, recognise the common wastes, score the improvement backlog and prove a change with a measured before and after.", "tags": ["process", "improvement", "lean", "experiments"], "updated": "2026-11-04" }
---

# Process improvement

Improving a process has three parts: find where the time or the errors actually come from, pick the change with the best effect for its effort, and prove it worked. Skipping the first produces busy work; skipping the last produces stories.

## Find the constraint

A process moves at the pace of its slowest step. Speeding up any other step just builds a bigger queue in front of the slow one.

From the step table (see [Process mapping and SOPs](./process-mapping-and-sops.md)):

1. Find where items wait longest. The longest queue usually sits in front of the constraint.
2. Compare each step's throughput with the arrivals. A step that completes fewer per week than arrive is the constraint.
3. Look for rework loops: a step sending items back multiplies the load on everything before it.
4. Look at hand-offs between roles or units; each one is a queue.

Then, in this order: make sure the constraint never sits idle (no waiting on inputs, no lower-priority work in front of it); remove work from it that another step could do; only then add capacity.

## The common wastes

A checklist borrowed from Lean, phrased for a company of agents:

| Waste | What it looks like here |
|---|---|
| Waiting | tasks queued for review, approvals waiting on a card, a hand-off past its SLA |
| Rework (defects) | results sent back at review, re-runs after a vague brief |
| Over-processing | three review rounds on a two-way-door task; a report nobody reads |
| Excess WIP | members with many open tasks, none finishing |
| Hand-offs and transport | work passed through roles that add nothing |
| Motion / searching | members re-reading context because files aren't where the layout says |
| Over-production | producing outputs before anyone needs them |
| Unused skill | a specialist doing manual steps a tool or plugin could do |

## Score the backlog

Keep /org/operations/improvements.md as a table. Scores are judgements; say whose.

```markdown
| # | Improvement | Process | Key result it moves | Expected effect (estimate) | Effort | Risk | Testable as experiment? | Status |
|---|---|---|---|---|---|---|---|---|
| 1 | Remove manual stock re-check (step 4) | order-to-ship | median cycle time | −<x> h per order (estimate, Process Analyst) | S | low | yes, 2-week window | proposed |
```

Prefer, in roughly this order: removing a step, removing a hand-off, preventing rework at the source, automating a step, speeding up a step. Removal is cheaper and longer-lasting than acceleration.

## Prove it: before and after

Your charter says you change a process only with its owner's agreement and a measured before and after. Make that concrete:

1. **Baseline.** Measure the metric over a recent window long enough to see normal variation. Record the definition used.
2. **Hypothesis.** "Removing step 4 cuts median cycle time on order-to-ship, without lowering first-pass yield."
3. **Guardrail.** The metric that must not get worse (quality, cost, SLA).
4. **Window and revert rule.** How long you'll run it and what result makes you revert. Propose it with org_propose_experiment.
5. **After.** Measure the same metric, same definition, same kind of window.
6. **Read out.** Did it move beyond normal week-to-week variation? Did the guardrail hold? Record the result either way.
7. **Lock in.** Update the SOP (with the owner), the change log, and write the procedure as a company playbook when proven.

## Worked example (made up)

Monthly audit flags vendor-invoice approval SLA slipping. The step table shows invoices waiting days for a second approver on amounts below the threshold that needs two signatures. The SOP requires two approvers for every invoice; the finance policy only requires it above a threshold. Improvement: apply the policy as written (one approver below threshold). Owner (Head of Finance) agrees. Baseline median cycle time and SLA attainment over four weeks; guardrail: no increase in payment errors. After four weeks, read out and update the SOP.

## Common pitfalls

- **Optimising a non-constraint.** Faster work at a step that isn't the bottleneck changes nothing at the end.
- **No baseline.** "It feels faster" isn't a result.
- **Changing two things at once.** You won't know which one worked.
- **Declaring victory on one good week.** Look at the variation first.
- **Fixing someone else's process unilaterally.** The owner agrees, or it doesn't change.
- **Keeping the improvement only in your head.** If the SOP isn't updated, the old process comes back.
