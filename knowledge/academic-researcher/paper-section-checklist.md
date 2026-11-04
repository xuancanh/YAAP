---json
{ "title": "Paper section checklist", "summary": "What each section of an IMRaD-style paper owes the reader, rules for figures and captions, and a pre-submission audit.", "tags": ["paper", "imrad", "writing", "figures", "submission"], "updated": "2026-11-04" }
---

# Paper section checklist

Each section has one job. When a draft feels muddy, it's usually because a section is doing another section's job: results that interpret, an introduction that reviews everything, a discussion that repeats results. Fields vary (humanities and some CS venues don't use IMRaD), so map these jobs onto the venue's skeleton.

## Before drafting

- [ ] Contribution sentence: "After reading this, the reader knows ___ that they didn't before."
- [ ] Target venue chosen; three recent papers from it read for framing, length and tone.
- [ ] Figure list drafted: each figure's one-line takeaway.

## Section jobs

**Title.** Says the finding or the question, with the key terms a searcher would use.

**Abstract.** Context (one sentence), gap, what you did, main result with the key number, what it means. No citations, no undefined acronyms.

**Introduction.** A funnel: field, problem, gap, this paper. End with the contribution stated plainly, often as a short list. Reuse the lit review's gap statement; don't write a second literature review.

**Related work** (if separate). Organized by theme, each paragraph ending with how this paper differs.

**Methods.** Enough detail that a competent peer could repeat it: materials, data sources, sample and how it was chosen, procedures, analysis, software and versions. Ethics approval and data availability per the venue's rules.

**Results.** What you found, in the order that builds the argument. Report effect sizes and uncertainty, not only p-values. No interpretation beyond what's needed to read a number.

**Discussion.** Answer "so what": the main finding in a sentence, how it fits or conflicts with prior work, limitations named before reviewers name them, and what should happen next. Don't introduce new results.

**Conclusion.** Two to four sentences. No new claims.

## Figures and tables

- Each figure earns its place by moving the argument. If you can't write its takeaway in one sentence, cut or merge it.
- Captions state the takeaway first ("Error drops sharply after 100 samples"), then what is shown, then any notes on reading it.
- Axes labeled with units. Colors that still read in grayscale and for color-blind readers.
- Tables for exact values; figures for patterns.

## Pre-submission audit

- [ ] Every citation verified (see [verifying sources](verifying-sources.md)).
- [ ] Formatting: page limit, reference style, file types, word count for abstract.
- [ ] Double-blind venues: no names, acknowledgements, funding or self-identifying links; self-citations in third person.
- [ ] Data and code statements written and links working.
- [ ] Every co-author comment resolved or answered in the tracker.
- [ ] Numbers in the abstract match the results tables.
- [ ] Figures readable at printed size.
- [ ] Author contributions, conflicts of interest and funding statements, if required.

## Common mistakes

- Starting the introduction with the history of the field.
- "Results" that are mostly speculation, or a "Discussion" that is mostly recap.
- A limitations paragraph that lists only minor issues and hides the real one.
- Captions that describe ("Plot of X versus Y") instead of telling.
- Changing a number in the results and forgetting the abstract.
