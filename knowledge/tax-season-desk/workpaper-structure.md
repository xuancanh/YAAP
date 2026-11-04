---json
{ "title": "Workpaper structure", "summary": "A consistent folder and index structure for each return, source-to-figure traceability, a review-notes log, and general record-retention reference points.", "tags": ["workpapers", "review", "traceability", "records"], "updated": "2026-11-04",
  "sources": [
    { "title": "IRS: How long should I keep records? (page reviewed 2026-06-30)", "url": "https://www.irs.gov/businesses/small-businesses-self-employed/how-long-should-i-keep-records" }
  ] }
---

# Workpaper structure

A reviewer should be able to open any figure on the return and find its source in under a minute. That only happens if every return's file has the same shape.

## Standard index

Same sections and numbering for every client, so reviewers know where to look:

```
[client code]-[year]/
  00 Admin        engagement letter, checklist status, client questions log
  10 Prior year   last return, carryforwards (as identified by preparer)
  20 Income       employment, self-employment, investments, other
  30 Deductions / reliefs   as identified by preparer
  40 Payments     withholding, estimated / advance payments
  50 Property     rental, sales
  60 Other        notices, correspondence
  90 Review       review notes log, sign-off
```

Name files consistently: `20.01 W-2 employer A.pdf`, `20.02 1099-DIV broker.pdf`.

## Source-to-figure traceability

- Every number on the return links to a workpaper reference ("see 20.02").
- Every workpaper summary links to its source documents.
- Calculations show inputs and the formula, not just the result.
- Use **tick marks** consistently, with a legend on the index: e.g. ✓ agreed to source, Σ footed (added up), → carried to return.
- Anything estimated or assumed is labelled as such, with the preparer's note.

The desk organises and indexes; it doesn't decide where an item goes on the return.

## Review-notes log

| # | Ref | Note (reviewer) | Raised | Response (preparer) | Cleared by | Date |
|---|---|---|---|---|---|---|
| 1 | 20.02 | Dividends don't agree to broker summary | 03-10 | Corrected 1099 received; updated | Reviewer | 03-11 |
| 2 | 50.01 | Need closing statement for sale | 03-10 | Requested from client | | |

Rules: every note gets a response; only the reviewer clears a note; a return isn't filed with open notes unless the reviewer has signed off on why.

The desk can track open notes and chase client-dependent ones through the [chase ladder](missing-docs-chase-ladder.md).

## Before sending to review

- Checklist shows all items received or marked not applicable by the preparer
- Index complete; every file named to the standard
- Each return line referenced
- Client questions log answered or flagged
- Prior-year comparison prepared (the preparer explains big changes)

## Record retention (reference points)

The IRS sets how long taxpayers should keep records, based on the period in which a return can be examined or amended. Its general rule is three years from filing, with longer periods in specific situations (for example six years if income was substantially under-reported, seven for certain losses, and indefinitely if no return was filed or it was fraudulent; employment tax records at least four years). Other countries differ: HMRC sets its own periods for UK records.

Practices also have professional and insurance requirements. The practice owner sets the retention policy; the desk tracks destruction dates and never deletes on its own initiative.

## Worked example

Reviewer opens line "Dividends" on client C-0412's return. Reference: 20.02. Workpaper 20.02 summarises two broker statements, ticked as agreed to source, total footed and carried to the return. A note says a corrected form replaced the original on 11 March. Review time: one minute.

## Common mistakes

- Files named "scan0043.pdf".
- Calculations pasted as values with no inputs.
- Review notes deleted when cleared, losing the trail.
