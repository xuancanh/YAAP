---json
{ "title": "Reproducible analysis standard", "summary": "A header template, folder layout and review checklist so every revenue analysis can be rerun, checked and trusted.", "tags": ["reproducibility", "analysis", "standards", "checklist", "data-quality"], "updated": "2026-11-04" }
---

# Reproducible analysis standard

An analysis is finished when someone else can rerun it next month and get the same answer from the same data. Reproducibility is what turns a one-off number into something the company can manage by.

## The header (top of every analysis file)

```
Question: the decision this informs, in one sentence
Answer: the short answer, with confidence (high / medium / low) and why
Definitions: each metric with its formula (link to the standard definition)
Population: which records — segment, stage boundary, filters, exclusions
Date range: period analysed; snapshot date for any point-in-time data
Sources: system, report or table names; pull date and time
Method: steps in plain words
Caveats: known data gaps, small samples, assumptions
Rerun: how — the query file and the order to run things
Owner / reviewer / date
```

Lead with the answer. Put the method after it.

## Folder layout

Keep each analysis in its own folder:

```
<analysis-slug>/
  README.md        # the header above and the findings
  queries/         # saved queries or report definitions, numbered in run order
  data/            # raw extracts as pulled (read-only) and cleaned versions
  outputs/         # tables and charts used in the findings
  changelog.md     # what changed between runs
```

Never edit raw extracts by hand. Make cleaning steps a script or a documented, repeatable sequence.

## Definitions discipline

- Use the company's standard metric definitions. If you need a variant, give it a different name ("NRR excluding price uplift").
- Keep one definitions file for RevOps and link to it rather than restating.
- When a definition changes, rerun the history with the new definition or mark the break clearly in charts.

## Showing uncertainty

- Show counts beside percentages.
- Mark incomplete periods and cohorts.
- For comparisons, say whether a difference is larger than normal period-to-period variation; if you can't tell, say that.
- Use words that match the evidence: "suggests", "consistent with", "shows". Don't say "proves" for an observational analysis.

## Sanity checks before publishing

- [ ] Totals reconcile to a known figure (bookings to finance's number, pipeline to the CRM dashboard), or the difference is explained
- [ ] Row counts make sense; no duplicate opportunities or accounts
- [ ] Filters applied as stated (spot-check a few records)
- [ ] Time zones and period boundaries consistent
- [ ] Currency handled consistently
- [ ] Extreme values checked: one record driving the result?
- [ ] A second person (or a fresh rerun) gets the same headline number

## Writing the findings

- Three to five findings, each: what the data shows, the evidence, the confidence, and what it means for the decision.
- If a finding contradicts a plan or a belief, say it plainly and show the evidence. Offer what would change your view.
- Separate facts from interpretation from recommendation.

## Pitfalls

- **Dashboard screenshots as evidence.** They can't be rerun; save the query.
- **Silent filters.** "Excluding test accounts" belongs in the header.
- **Moving baselines.** Comparing this month's definition with last year's different one.
- **Precision theatre.** Three decimals on a noisy number suggests confidence you don't have.
