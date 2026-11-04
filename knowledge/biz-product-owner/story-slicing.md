---json
{ "title": "Slicing stories", "summary": "Check stories against INVEST and split large ones into thin end-to-end slices using common splitting patterns, with a worked example.", "tags": ["user-stories", "invest", "slicing", "backlog"], "updated": "2026-11-04",
  "sources": [{ "title": "Bill Wake, INVEST in Good Stories, and SMART Tasks (2003), accessed 2026-11-04", "url": "https://xp123.com/articles/invest-in-good-stories-and-smart-tasks/" }] }
---

# Slicing stories

A good slice delivers something a user can see and use, end to end, small enough to finish inside a sprint. Slicing by technical layer ("build the API", "build the UI") produces stories that deliver nothing until the last one lands.

## The INVEST check

Bill Wake's INVEST mnemonic is a quick test for each story:

- **Independent:** can be built and released without waiting for another story in the same batch.
- **Negotiable:** describes the need, leaving room to agree the details with engineering.
- **Valuable:** a user or the business gets something from it on its own.
- **Estimable:** the team understands it well enough to size it.
- **Small:** fits comfortably in a sprint.
- **Testable:** you can say how you would check it is done.

A story that fails **Estimable** usually needs a spike (a time-boxed investigation) or more refinement. One that fails **Small** needs splitting. One that fails **Valuable** is probably a technical task; fold it into a story that delivers value.

## Splitting patterns

Try these in order; stop when the slices are small enough.

1. **Workflow steps.** Deliver the first step of the flow end to end, then the next. "Invite a teammate by email" before "bulk invite from CSV".
2. **Happy path first.** The main successful path in one story; error handling and rare cases in later stories (but before release).
3. **Business rule variations.** One rule per story. "Discount for annual plans" before "discount for nonprofits".
4. **Data variations.** One data type or source first. "Import from CSV" before "import from spreadsheet tool".
5. **Interface variations.** One platform or entry point first. Web before mobile; one browser-supported flow before the rest.
6. **Operations.** For managing a thing: create and view first, then edit, then delete.
7. **Simple then sophisticated.** A basic version first (sort by date), then the richer one (custom filters).
8. **Defer performance.** Make it work, then make it fast, if acceptable performance can wait for a later slice before release.

**Spike when unsure.** If no split is visible because nobody knows how it will work, write a time-boxed spike with a question to answer, then slice.

## Worked example

Spec: *Finance leads can filter the monthly report by cost centre and export it.*

Too big as one story. Sliced:

1. **As a finance lead, I want to filter the report by one cost centre so that I can see one team's spend.** (Happy path, one filter value.)
2. Filter by several cost centres at once. (Simple → sophisticated.)
3. Export the filtered report as CSV. (New operation on the same view.)
4. Show an empty state when a cost centre has no spend in the month. (Edge case; must ship before release.)
5. Remember the last filter used. (Nice-to-have; ordered last.)
6. Fire the `report_filtered` and `report_exported` events. (Usually part of 1 and 3, not a separate story — put the event in their acceptance criteria.)

Story 1 alone already lets a finance lead stop exporting to a spreadsheet for the simple case, which is the value the spec is after.

## Working with engineering

- Slice together. Engineers spot splits that are cheap for them and splits that only look cheap.
- Estimate together. You provide the what and the why; they provide the size.
- Mark the order and the dependencies. If story 3 needs story 1, say so on the task.
- Keep slices that must ship together for release marked as a release group, so a half-feature does not go out.

## Pitfalls

- "As a system, I want…" stories. Find the human who benefits, or treat it as a technical task inside another story.
- Splitting so finely that each story has no visible result; reviewers then cannot accept anything meaningful.
- Leaving all edge cases to one final "polish" story, which then turns out to be the biggest.
- Writing acceptance criteria only for the happy path; see the [acceptance criteria guide](acceptance-criteria.md).
