---json
{ "title": "Process metrics", "summary": "Definitions and formulas for cycle time, touch and wait time, first-pass yield, automation rate and SOP coverage, with counting rules that keep them honest.", "tags": ["kpis", "cycle-time", "first-pass-yield", "automation-rate", "sop-coverage"], "updated": "2026-11-04",
  "sources": [{ "title": "iSixSigma dictionary: First Time Yield (FTY), accessed 2026-11-04", "url": "https://www.isixsigma.com/dictionary/first-time-yield-fty/" }] }
---

# Process metrics

Every process metric needs three things written down before you compute it: where the clock starts, where it stops, and what counts as one unit. Without those, two people measuring the same process get different numbers and both are right.

## Cycle time (end to end)

**What it answers:** how long does one item take from trigger to output?

**Formula:** for each item, output timestamp − trigger timestamp. Report the median and a high percentile (for example the 85th) over the period, not only the mean. One stuck item drags a mean far more than a median.

**Counting rules:**
- Use the trigger and output defined at the top of the process map.
- Count calendar time unless the SLA is in working time; say which.
- Exclude items still open at period end from the distribution, and report their count separately so they are not hidden.

Some teams say "lead time" for the customer's view (request to delivery) and "cycle time" for the work's view (start of work to done). Pick one pair of definitions, write it in the map, and stick to it.

## Touch time, wait time and flow efficiency

**Touch time:** time someone is actively working on the item. **Wait time:** everything else inside the cycle (queues, approvals, hand-offs).

**Flow efficiency:** total touch time ÷ end-to-end cycle time, as a percentage.

Touch time is usually an estimate from interviews or sampling; label it as such. A low flow efficiency points you to queues and hand-offs rather than to working faster.

## First-pass yield

**What it answers:** how often does an item get through without being sent back?

**Formula (one step):** items that pass the step with no rework ÷ items that entered the step.

**Formula (whole process):** items completed with no rework anywhere ÷ items completed. When you only have per-step yields, multiply them to estimate the whole-process figure (this product is often called rolled throughput yield).

**Counting rules:** define rework concretely: the item returned to an earlier step, was reopened, or needed a correction after hand-off. An item corrected silently by the next person is still rework; ask about it during mapping, because the board will not show it.

## Automation rate

**What it answers:** how much of the process's work no longer needs a person?

**Formula:** pick one and state it.
- **By step:** automated steps ÷ total steps in the mapped processes.
- **By volume (preferred):** item-steps executed automatically ÷ total item-steps, over the period.

Volume-weighted is better because automating a step that runs a thousand times matters more than one that runs twice. A step with an automated draft and a human approval counts as assisted, not automated; report assisted separately.

## SOP coverage

**Formula:** recurring processes with a current SOP ÷ recurring processes in /org/operations/processes.md.

**Counting rules:** "current" means the SOP's next review date has not passed and the owner signed off after the last process change. An SOP past its review date counts as uncovered.

## Reporting

| Metric | Value | Period | Source | Notes |
|---|---|---|---|---|
| Cycle time (median / p85) | | | board export | open items: n |
| First-pass yield | | | map + interviews | rework definition used |

- Always pair a number with its period, source and definition.
- Mark estimates as estimates and measured values as measured.
- Show a trend (a run chart of weekly medians) rather than one snapshot; a single week is noise.
- When a definition changes, restate the earlier periods on the new definition or break the trend line and say why.
