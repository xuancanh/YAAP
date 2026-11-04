---json
{ "title": "Evidence standards", "summary": "What counts as sufficient and appropriate evidence for an audit conclusion, which sources in the company's record to trust more, and when to re-perform rather than inspect.", "tags": ["evidence", "method", "audit", "reliability"], "updated": "2026-11-04",
  "sources": [
    { "title": "Audit evidence — when is enough enough?", "url": "https://www.accaglobal.com/vn/en/technical-activities/uk-tech/in-practice-ezine-archive/in-practice-archive-2024/April/Audit-evidence-when-is-enough-enough.html", "publisher": "ACCA", "date": "2024-04", "note": "Sufficiency is quantity; appropriateness is relevance and reliability; more reliable evidence needs less of it; unreliable evidence never becomes appropriate by volume." },
    { "title": "ISA (UK) 500 Audit Evidence (updated May 2022)", "url": "https://www.frc.org.uk/docs/5518/html", "publisher": "Financial Reporting Council", "note": "Procedures: inspection, observation, external confirmation, recalculation, reperformance, analytical procedures, inquiry; inquiry alone ordinarily insufficient." }
  ] }
---

# Evidence standards

A finding, or a "this holds", is only as good as the evidence under it. Auditing standards (ISA 500) ask for evidence that is **sufficient** (enough of it) and **appropriate** (relevant and reliable). The two trade off: the more reliable the evidence, the less of it you need. But unreliable evidence never becomes appropriate however much of it you pile up.

## Relevant: does it answer the question you're asking?

Each test has a question. Evidence is relevant only to the question it answers.

- "Was done_when met?" needs the artifact the rubric names (the file, the check result, the merged change), not the final comment saying it was done.
- "Was review independent?" needs the reviewer's id and model family, not the fact a review happened.
- "Is the reported number right?" needs the metric source for the same period, not last week's report repeating it.

Direction matters too. Tracing from the report to the source tests that reported numbers are real; tracing from the source to the report tests that nothing material was left out.

## Reliable: which sources to trust more

General rules from audit practice, mapped onto this company's record:

| More reliable | Less reliable |
|---|---|
| System records the member can't edit: the audit log (org_audit_query), board state, org_metric_read, org_costs, org_pulse | A member's own account of its work (final comment, self check-in) |
| Evidence you obtained directly (you read the file, ran the query) | Evidence handed to you or quoted by someone else |
| A source independent of the work's owner | A source the owner controls |
| Written and dated | A remark in a meeting or chat |
| The original artifact | A summary, a pasted excerpt or a screenshot of it |
| A check that ran and recorded its result (org_task_checks) | A claim a check passed |

A member's comment isn't worthless; it tells you what to look for. It just can't, alone, be the evidence for its own claim.

## Procedures, from weakest to strongest for most questions

- **Inquiry** — ask (read the owner's comment or ask on the task). Useful for leads and explanations; alone it's ordinarily not enough to conclude.
- **Inspection** — read the artifact itself: the file, the diff, the decision row.
- **Analytical review** — compare against expectations: spend per accepted task against the role's median, a metric's trend against the claim.
- **Recalculation** — recompute a number from its inputs: the scorecard total, a cycle time, a key result's score.
- **Re-performance** — redo the check the owner or reviewer was meant to do: walk the done_when rubric item by item against the result; re-run the metric query for the same period; re-trace a decision-log follow-up to the board.

Re-perform when the claim matters (a red/amber/green status, a key result score, a constraint) or when inspection leaves doubt. Inspect when the artifact is self-evidently there or not.

## Sufficient: when to stop

There's no fixed rule; it's judgement. Stop when:

- you'd reach the same conclusion if the next item went either way;
- the evidence comes from a reliable source and directly answers the question;
- conflicting evidence has been resolved or is itself reported.

If you can't get there (the source is missing, the period's data was never recorded, the budget ran out), say "insufficient evidence" and what would settle it. That's a valid outcome, and it's often a finding of its own (no metric source; no record of review).

## Worked example (made up)

Task [task:example-1] says done_when: "the pricing page shows the new tiers and the checkout test passes". Final comment: "Done, tests green." Inquiry only. You inspect the task's checks (org_task_checks): the checkout test isn't among them. You inspect the page file: the new tiers are there. Conclusion: half the rubric is evidenced; the other half is claimed. Severity warn ("evidence does not show done_when was met"), quoting the final comment and the checks list.

## Checklist per item

- [ ] I know the question this test answers.
- [ ] I read the artifact, not only the claim.
- [ ] The source is one the owner couldn't edit, or I said it wasn't.
- [ ] I re-performed where the claim affects a status, a score or a constraint.
- [ ] I quoted the line of evidence and its id.
- [ ] Where evidence was missing, I said "insufficient", not "fine".
