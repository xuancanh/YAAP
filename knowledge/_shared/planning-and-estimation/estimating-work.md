---json
{ "title": "Estimating work", "summary": "How to estimate time, cost or effort as a range: three-point (PERT) estimates, reference-class checks against past work, the planning fallacy and buffers.", "tags": ["estimation", "planning", "pert", "forecasting"], "updated": "2026-11-04",
  "sources": [
    { "title": "Three-point estimation", "url": "https://en.wikipedia.org/wiki/Three-point_estimation", "publisher": "Wikipedia", "accessed": "2026-11-04" },
    { "title": "Reference class forecasting", "url": "https://en.wikipedia.org/wiki/Reference_class_forecasting", "publisher": "Wikipedia", "accessed": "2026-11-04", "note": "Kahneman & Tversky's theory; Flyvbjerg's practical method" },
    { "title": "Planning fallacy", "url": "https://en.wikipedia.org/wiki/Planning_fallacy", "publisher": "Wikipedia", "accessed": "2026-11-04" }
  ] }
---

# Estimating work

An estimate is a forecast with uncertainty, not a promise. Give a range and say what it rests on. A single number sounds precise, and that's exactly why it misleads.

## Ranges, not points

Say "3–6 days, most likely 4", not "4 days". The width of the range is information in its own right: a wide range tells the planner to build in slack, or to spend a little time cutting uncertainty first.

Always label it: "**Estimate:** 3–6 days (three-point, based on the last two similar tasks)." Never let an estimate get passed on as a fact.

## Three-point (PERT) estimate

For each piece of work, give three numbers:

- **O**: optimistic, if everything goes right.
- **M**: most likely.
- **P**: pessimistic, if the realistic bad things happen (not the end of the world).

**Expected = (O + 4M + P) ÷ 6**
**Spread (rough standard deviation) = (P − O) ÷ 6**

### Worked example

Writing a market sizing memo:

| Part | O | M | P | Expected |
|---|---|---|---|---|
| Gather sources | 0.5 d | 1 d | 3 d | (0.5 + 4 + 3) ÷ 6 = 1.25 d |
| Build the model | 1 d | 2 d | 4 d | (1 + 8 + 4) ÷ 6 ≈ 2.2 d |
| Write and review | 0.5 d | 1 d | 2 d | (0.5 + 4 + 2) ÷ 6 ≈ 1.1 d |
| **Total** | | | | **≈ 4.5 d** |

Report it as "about 4–5 days expected, could run to 9 if sources are hard to find." The pessimistic numbers tell you the main risk is gathering sources, so put that first, or ask someone where the data lives.

Note that the expected value sits above M. Pessimistic tails are longer than optimistic ones, and the formula accounts for that.

## Check against reality: the reference class

People estimating their own plans tend to be optimistic. Kahneman and Tversky called this the **planning fallacy**. The fix, which Bent Flyvbjerg turned into a practical method, is **reference-class forecasting**:

1. Find past work that resembles this task: the same kind, size and team.
2. Look at how long or how much those actually took. Use the board history, past handoffs and `/org/` files.
3. Start from that real distribution, then adjust for what's really different this time.

If your bottom-up estimate says 2 days and the last five similar tasks took 4–7, trust the history unless you can name the specific reason this one is different.

No history? Say so ("no comparable past work found") and widen the range.

## Buffers

Add the buffer in the open, as its own line, not hidden inside each task. Hidden padding gets spent. A visible buffer can be watched and protected.

- Base the buffer on the uncertainty: a wider O–P spread or lower confidence means a bigger buffer.
- Hold one buffer at the milestone level, not one per task.
- Track it: if half the buffer is used up before half the work is done, raise it early.

## Re-estimate as you learn

An estimate made before the work starts is the least informed it will ever be. Re-estimate at natural checkpoints, and tell the owner as soon as the range moves past a deadline. Don't wait for the deadline itself. Update the risk register if it matters (see [risk registers](../risk/risk-registers.md)).

## Template

```markdown
**Estimate: <work item>** — <YYYY-MM-DD>
- Range: <O>–<P> <units>, most likely <M>; PERT expected <E>
- Basis: <three-point / reference class: N similar tasks took X–Y (source)>
- Biggest unknown: <what drives the pessimistic case>
- Buffer: <amount>, held at <milestone>
- Re-estimate at: <checkpoint>
```

## Common pitfalls

- **Anchoring.** Hearing "can you do it by Friday?" before estimating bends the estimate toward Friday. Estimate first, then compare.
- **Estimating only the fun part.** Include review, rework, waiting on others and handoff.
- **Treating the estimate as a commitment.** Commit to a date with buffer, not to the most likely number.
- **False precision.** "4.37 days" implies knowledge you don't have.
- **Unlabelled estimates.** Write "estimate" every time, so nobody downstream mistakes it for a measured figure.

For turning estimates into a plan, see [planning a quarter](./planning-a-quarter.md).
