---json
{ "title": "One-pager and report templates", "summary": "A one-page template with cutting rules, and a findings-first report spine with navigation and status conventions.", "tags": ["one-pager", "report", "templates", "executive-summary", "structure"], "updated": "2026-11-04" }
---

# One-pager and report templates

## One-pager template

```
[Headline that states the conclusion or the ask]
Status: proposal/update · Owner: ___ · Date: ___

The ask (or the point): one or two sentences.

Why:
- **Point 1.** Evidence in one line.
- **Point 2.** Evidence in one line.
- **Point 3.** Evidence in one line.

[Optional: one small table if numbers carry the argument]

Risk worth knowing: one or two lines, honest.

Next step: [action] — [name], by [date].

More detail: [link to appendix file]
```

**Rules**

- Three supporting points, maximum.
- Bold lead-ins so a scanning reader gets the gist from the bold alone.
- White space is part of the design. A crammed page reads like a long document that failed to fit.
- Tell the user what you cut and where it went, so they can veto.

**If it won't fit honestly:** the ask is too big for one page. Say which piece should be split off into its own page or document.

## Worked example (one-pager)

Source: a five-page project update. Headline draft: "Q3 project update." Rewritten: "Migration is on track for 1 December; one vendor risk needs a decision by Friday." Three points: data moved, testing status, training plan. Risk: vendor contract renewal date. Next step: approve the contract extension (finance lead, Friday). Everything else, including the full test log, goes to the appendix.

## Report spine

For anything longer than about five pages, or mixing prose and numbers:

```
Title
Status: draft/final · Data as of: [date] · Author(s) · Version

1. Executive summary (one page)
   - Key findings, as sentences
   - Recommendations, each with an owner
2. Findings
   2.1 [Finding as a sentence]
       Evidence (chart/table with a "how to read this" line)
       What it means
   2.2 ...
3. Recommendations
   Action · owner · timing · expected effect
4. Appendices
   A. Method
   B. Data tables
   C. Glossary
```

**Rules**

- Headings are findings: "Support tickets doubled after the pricing change", not "Ticket volume".
- Number findings and cross-reference by number ("see 2.3").
- Every table gets a one-line "how to read this".
- Every chart-worthy trend is also stated in words, for readers who skip charts.
- Method goes at the back. Readers who want it will find it.
- The "data as of" date is on the front. Reports outlive their data.

## Executive summary test

Someone who reads only the executive summary should know: what was found, what's recommended, who acts, and by when. If they would need to read further to make the decision, the summary isn't finished.

## Companion summary deck

When a report goes to a meeting, offer a three-slide summary:

1. The main finding and recommendation.
2. The key evidence (one chart).
3. The decision needed and next steps.

## Common mistakes

- Executive summary that describes the report ("This report examines…") instead of stating findings.
- Method first.
- Recommendations without owners.
- Charts without a takeaway sentence.
- No date on the data.
