---json
{ "title": "From question to answer", "summary": "How to turn a vague business question into a precise one, plan the analysis, and write an answer with caveats that a busy reader can act on.", "tags": ["analysis", "framing", "answer template", "stakeholders"], "updated": "2026-11-04" }
---

# From question to answer

Most analysis time is wasted answering a question nobody quite asked. Spend the first minutes pinning it down.

## 1. Find the decision

Ask (or infer from the task): what will you do differently depending on the answer?

- "How many trials converted last month?" → *Decision:* whether to extend the trial length experiment. Now you know they care about conversion **by trial length**, not a single number.
- If no decision depends on it, say so and offer a lighter answer (a link to an existing dashboard).

## 2. Make the question precise

Write it down with every term pinned:

| Part | Vague | Precise |
|---|---|---|
| Metric | "conversion" | Trial-to-paid conversion as defined in `/org/data/metrics.md` |
| Population | "customers" | New self-serve workspaces, excluding internal and test accounts |
| Period | "last month" | Trials started 1–31 October, converted within 30 days of start |
| Comparison | "is it good?" | Versus the same cohort definition for September and August |
| Cut | — | By trial length group (14 vs 30 days) |

If the requester's definition differs from the catalogue, flag it before you start, not after.

## 3. Plan before querying

- Which tables (marts, not staging) hold this?
- What result would surprise you? Write your expectation down; it is your first sanity check.
- What is the simplest analysis that answers the decision? Do that first; add depth only if it changes the answer.

## 4. Query and check

Follow [query hygiene and sanity checks](query-hygiene.md). Save the query where it can be re-run.

## 5. Write the answer

Lead with the answer. A reader who stops after the first two lines should still act correctly.

```markdown
## Answer
<One or two sentences that answer the question, with the number and
 the comparison.>
e.g. 30-day trials converted at 18% vs 14% for 14-day trials (October cohort).

## What this means for the decision
<One sentence. Is it enough to act? What would change the call?>

## How I got it
- Metric: <catalogue name and link>
- Population and period: <exact filters>
- Query: <path to saved query>

## Caveats
- <Sample size, if small: "n = 85 and 92 trials; differences this size
   can be noise at these counts.">
- <Data issues: late data, known gaps, definition changes.>
- <What this does NOT show: correlation not cause, unless it was an experiment.>

## Next steps (optional)
<A follow-up analysis or a dashboard, only if worthwhile.>
```

## Caveats that matter

Include a caveat only if it could change how someone reads the number:

- **Small numbers.** Percentages from a few dozen records move a lot by chance. Show counts next to rates.
- **Correlation.** "Customers who use feature X churn less" does not mean X prevents churn. Say so, and suggest an experiment if the decision is costly.
- **Survivorship.** Analysing only current customers hides those who left.
- **Incomplete periods.** The current week or month is not finished; compare like with like.
- **Definition changes.** If a metric's definition changed during the period, mark the break.

## Pitfalls

- Delivering a table of numbers with no sentence. The reader then does the analysis.
- Hedging every line. Pick the caveats that matter; drop the rest.
- Answering a bigger question than asked because it was interesting. Offer it as a next step instead.
- Rounding inconsistently. Pick precision that fits the decision; don't report 17.4382%.
