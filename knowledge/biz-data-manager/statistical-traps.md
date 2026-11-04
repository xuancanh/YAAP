---json
{ "title": "Statistical traps in analysis", "summary": "The statistical and data traps that turn a correct query into a wrong answer, each with how to spot it and what to do, plus a pre-send checklist.", "tags": ["data", "analysis", "statistics", "pitfalls", "review"], "updated": "2026-11-04",
  "sources": [
    { "title": "Simpson's Paradox", "url": "https://plato.stanford.edu/entries/paradox-simpson/", "publisher": "Stanford Encyclopedia of Philosophy", "date": "2021-03-24", "accessed": "2026-11-04", "note": "Discusses the Berkeley admissions example (Bickel et al., 1975)." }
  ] }
---

# Statistical traps in analysis

The audit asks whether an analysis answered the decision and stated its
caveats. These are the traps that most often make a clean, reproducible
query give the wrong answer. Run through them before an answer leaves the
unit.

## Simpson's paradox

A trend in every subgroup can reverse when the groups are combined,
because the groups differ in size or mix. The classic case, discussed by
Bickel and colleagues in 1975, is Berkeley's graduate admissions: overall
figures suggested women were admitted less often, while department by
department the gap largely disappeared or reversed, because women applied
more to departments that admitted fewer applicants overall.

Made-up example: plan A converts better than plan B in both small and large
accounts, yet B looks better overall, because B is sold mostly to small
accounts, which convert better in general.

**Do**: when comparing groups, split by the obvious confounders (segment,
channel, region, cohort) and check the direction holds. Report the
breakdown when it doesn't.

## Survivorship bias

Analysing only what's still there. "Customers who've been with us three
years use feature X a lot, so X drives retention", but the customers who
tried X and left aren't in the data.

**Do**: start from the full cohort at the beginning of the period,
including churned, deleted and failed records, and follow it forward.

## Selection and self-selection

Users who opt into something differ from those who don't. Comparing users
who adopted a feature with those who didn't measures who chooses it, not
what it does. Only a randomised test (see [Experiments](./experiments.md))
separates the two cleanly.

## Correlation and confounding

Two metrics moving together may share a cause: a launch, a season, a price
change. Before saying "X caused Y", name the other things that changed in
the same window and say why they don't explain it.

## Regression to the mean

Pick the worst-performing week, team or region, intervene, and it improves.
It probably would have anyway: extreme values tend to be followed by more
ordinary ones. Compare with a similar group that got no intervention.

## Averages that mislead

- **Skew**: one large customer moves the mean. Show the median, or both.
- **Ratio of averages**: averaging per-segment rates is not the overall
  rate. Compute from totals.
- **Small denominators**: 3 of 4 is 75% and means almost nothing. Show
  the counts next to the percentage.

## Base effects and windows

A 50% rise from 2 to 3 is still 3. A month-over-month change in a month
with fewer working days isn't a trend. State the absolute numbers and pick
windows that are comparable (same length, same weekdays, same season).

## Multiple comparisons

Slice the data enough ways and something will look significant by chance.
If you looked at many segments, say how many, and treat a surprising one
as a hypothesis to test, not a finding.

## Data artefacts

A sudden step change is often a tracking change, a definition change, a
backfill or a bot, not behaviour. Check the change log in
`/org/data/metrics.md` and the quality files before explaining it.

## Pre-send checklist

- [ ] Answers the decision asked, in the first sentence.
- [ ] Uses the catalogued definitions; any deviation is stated.
- [ ] Totals reconcile with the source for the period.
- [ ] Split by the main confounders; direction holds or the breakdown is
      shown.
- [ ] Full population, not just survivors.
- [ ] Counts shown alongside percentages; medians where data is skewed.
- [ ] Causal words ("drives", "because") only when the design supports
      them; otherwise "is associated with".
- [ ] Confidence and caveats in plain words; estimates labelled.
- [ ] Query saved and re-runnable; reviewed by another member.
