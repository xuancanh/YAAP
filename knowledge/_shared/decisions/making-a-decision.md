---json
{ "title": "Making a decision", "summary": "How to frame a decision: real options, explicit criteria, whether it's a one-way or two-way door, and a clear recommendation, with a decision record template.", "tags": ["decisions", "judgment", "templates", "reversibility"], "updated": "2026-11-04",
  "sources": [
    { "title": "Amazon.com 2015 Letter to Shareholders (Jeff Bezos)", "url": "https://www.sec.gov/Archives/edgar/data/1018724/000119312516530910/d168744dex991.htm", "publisher": "Amazon.com, Inc. via SEC EDGAR", "date": "2016-04", "accessed": "2026-11-04", "note": "Type 1 / Type 2 decisions, one-way and two-way doors" }
  ] }
---

# Making a decision

Most decisions go wrong in the framing: too few options, criteria nobody said out loud, or a big process spent on a small, reversible call. Frame first and the choice usually gets easier.

## Step 1: Is it a one-way or a two-way door?

Jeff Bezos's 2015 letter to Amazon shareholders splits decisions into two types:

- **Type 1, one-way doors**: consequential and irreversible or nearly so. In Bezos's words, these "must be made methodically, carefully, slowly, with great deliberation and consultation."
- **Type 2, two-way doors**: changeable and reversible. These "can and should be made quickly by high judgment individuals or small groups." He notes most decisions are this kind.

His warning is about using the heavy process on light decisions, which slows everything down. So ask: *if this turns out wrong, how hard and how costly is it to undo?*

| | Two-way door | One-way door |
|---|---|---|
| Examples | Wording on a page, a trial tool, the order of next week's tasks | Signing a contract, deleting data, a public price, hiring, spending most of a budget |
| Who | You, within your remit | The owner named for it, after consultation |
| Write-up | A line in the task or handoff | A full decision record (below) |
| Speed | Today | As long as it needs, but set a date |

When unsure, treat it as a one-way door and ask whether it can be made two-way: a pilot, a time limit, or a smaller first step.

## Step 2: Real options

Write at least two or three options that someone could actually choose. Always include "do nothing / wait" as a baseline, so the cost of acting is weighed against something.

Watch for a fake choice, where one option is the plan and the others are straw men. If you can't argue for an option, drop it or find a better one.

## Step 3: Criteria before scoring

List what matters *before* you compare options: cost, time, risk, fit with the goal, effort to reverse. Weight them if they aren't equal. Agreeing on criteria first stops people from picking a favourite and then building the case for it.

Every number you use (cost, time, expected effect) needs a source, or a label saying it's an estimate, with the range. See [working with sources](../sources-and-citation/working-with-sources.md).

## Step 4: Recommend

End with a recommendation, not a menu. Say what you'd do, why, what would change your mind, and what you'll watch to know whether it worked. If the decision isn't yours, say who decides and by when. See [decision log entries](./decision-log-entries.md) for roles.

## Decision record template

Use this for one-way doors, and for any decision someone might later ask "why did we do that?" about. Save it as a file and log a short entry in `/org/decisions.md`.

```markdown
# Decision: <question, phrased as a choice>

**Status.** Proposed / Decided / Superseded by <link>
**Decider.** <one named person/agent>   **Date needed by.** <YYYY-MM-DD>
**Door.** One-way / two-way (why: <how hard to undo>)

## Context
<2–4 sentences: what's forcing the decision now. Link sources.>

## Options
1. **<Option A>**: <what it means>. Pros: … Cons: …
2. **<Option B>**: …
3. **Do nothing / wait**: …

## Criteria
| Criterion | Weight | A | B | Do nothing |
|---|---|---|---|---|
| <cost> | high | … | … | … |

## Recommendation
<Option> because <reason>. We'd change our mind if <signal>.
We'll know it worked when <measurable sign, with source> by <date>.

## Decision
<Filled in by the decider: choice, date, any conditions.>
```

## Worked example (short)

*Should we move the weekly newsletter from Tuesday to Thursday?* That's a two-way door: you can switch back next week. The decision is one line in the task: "Moving to Thursday for 4 sends; compare open rate (source: email platform report) against the last 4 Tuesdays; revert if lower." No meeting needed.

*Should we sign a 2-year contract with a new email platform?* That's a one-way door, because of the contract term and the migration cost. Write the full record, name the decider, and ask whether a 3-month or monthly plan turns it into a two-way door first.

## Common pitfalls

- **Heavy process on light calls.** Don't schedule a meeting to pick a colour.
- **No decider.** "We'll align on it" means nobody decides. Name one person.
- **Hidden criteria.** If cost is the real constraint, say so first.
- **Invented numbers.** Unsourced figures in an options table get treated as facts. Source them or label them as estimates.
- **Not recording the why.** Six weeks later the decision gets reopened because nobody remembers the reason.
