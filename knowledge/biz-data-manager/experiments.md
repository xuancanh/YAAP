---json
{ "title": "Experiment analysis basics", "summary": "How to plan and read an A/B test: hypothesis and metrics, sample size reasoning, significance, peeking, guardrails and sample ratio mismatch.", "tags": ["data", "experiments", "ab-testing", "statistics"], "updated": "2026-11-04",
  "sources": [
    { "title": "How Not To Run an A/B Test", "url": "https://www.evanmiller.org/how-not-to-run-an-ab-test.html", "author": "Evan Miller", "accessed": "2026-11-04", "note": "Peeking inflates false positives; fix sample size in advance; rule of thumb n = 16σ²/δ²." },
    { "title": "Trustworthy Online Controlled Experiments: A Practical Guide to A/B Testing", "url": "https://experimentguide.com/", "author": "Ron Kohavi, Diane Tang, Ya Xu", "publisher": "Cambridge University Press", "date": "2020", "accessed": "2026-11-04" }
  ] }
---

# Experiment analysis basics

When the Data Scientist designs an experiment, you propose it with
`org_propose_experiment`. This doc is what to check before it starts and
before anyone believes its result. The goal is a decision, not a p-value.

## Before it starts: the plan

Write this down first. A plan written after seeing data isn't a plan.

```markdown
# Experiment: <name>
Decision it informs: <what we'll do if it wins / loses / is flat>
Hypothesis: changing <X> will move <primary metric> because <reason>.
Unit of randomisation: user / account / session (must match the metric's grain)
Primary metric: <one metric from /org/data/metrics.md>
Minimum detectable effect (MDE): <smallest change worth acting on>
Guardrail metrics: <must not get worse: errors, latency, refunds, unsubscribes>
Sample size per arm: <n> → expected duration: <days, whole weeks>
Significance level / power: <e.g. 5% / 80%, company default>
Stopping rule: run to <n> or <date>; no early stop unless a guardrail breaks
Analysis owner and reviewer: <members>
```

## Sample size reasoning

The smaller the effect you want to detect, the more traffic you need, and
it grows with the square: halving the MDE needs about four times the
sample. Evan Miller's rule of thumb for roughly 80% power at 5%
significance:

```text
n per arm ≈ 16 × σ² ÷ δ²
for a conversion rate p:  σ² = p × (1 − p)
δ = the absolute difference you want to detect
```

Example (made-up): baseline conversion 10%, want to detect +1 point
(10% → 11%). σ² = 0.1 × 0.9 = 0.09; n ≈ 16 × 0.09 ÷ 0.0001 = 14,400 per
arm. If the product gets 2,000 eligible users a day, that is about 15 days;
round up to whole weeks so weekday effects even out. If the needed traffic
isn't there, say so: test a bolder change, pick a more sensitive metric, or
don't run it.

Use a proper calculator for the final number; the rule of thumb is for
checking feasibility fast.

## Reading the result

- **Significance** answers "how surprising would this difference be if
  there were no real effect?". A p-value under the chosen level means
  "unlikely to be noise", not "important" and not "the probability the
  variant is better".
- **Report the effect with a confidence interval**: "+0.8 points
  (95% CI −0.1 to +1.7)" says far more than "not significant".
- **Practical significance**: a statistically real effect smaller than the
  MDE may not be worth shipping.
- **Flat is a result.** It tells you the change didn't matter at the size
  you could detect. Record it in `/org/data/answers/`.

## Checks before believing it

- [ ] **Sample ratio mismatch (SRM)**: a planned 50/50 split that came out
      noticeably uneven (test it with a chi-square test) means the
      assignment or logging is broken. Don't analyse further; find the bug.
- [ ] **No peeking**: the stopping rule was followed. Checking daily and
      stopping on the first significant day inflates false positives well
      above the nominal level. If you need to look early, use a sequential
      method designed for it, decided in advance.
- [ ] **Guardrails held**: none moved the wrong way beyond their limit.
- [ ] **Full cycles**: it ran whole weeks, and long enough for the novelty
      effect to fade if users can notice the change.
- [ ] **One primary metric**: if you looked at twenty metrics, one will
      likely look significant by chance. Secondary metrics are for
      explanation, not for declaring a win.
- [ ] **Segments are exploratory**: a winning segment found after the fact
      is a hypothesis for the next test.

## Common pitfalls

- **No decision attached.** If every outcome leads to the same action,
  don't run it.
- **Unit mismatch.** Randomising by session and measuring per user counts
  the same people in both arms.
- **Changing the test mid-flight.** A new variant or traffic split restarts
  the clock.
- **Outward claims.** "Increases conversion by 8%" in marketing copy is a
  claim about the world. It's a draft for a human, with the interval.
