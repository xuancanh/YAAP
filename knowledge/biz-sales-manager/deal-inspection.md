---json
{ "title": "Deal inspection checklist", "summary": "A deal-by-deal inspection checklist, a mutual close plan template and the questions that expose a weak deal before the forecast does.", "tags": ["sales", "pipeline", "deal-review", "checklist", "close-plan"], "updated": "2026-11-04" }
---

# Deal inspection checklist

Pipeline review fails when it turns into status updates ("still talking to them"). Inspection is different. You test whether the record is **true**, whether the deal is **moving** and whether there's a **plan**. Do it from the record and the evidence, then ask the owner only about the gaps.

## The checklist (every open deal)

**Truth: does the record match reality?**
- [ ] The stage's exit criteria are met, with evidence (for example, Proposal has the proposal link).
- [ ] The amount is based on something real: a quote, a scoped number, the buyer's stated budget. It isn't a hoped-for upsell.
- [ ] The close date is tied to a buyer event (a budget cycle, a renewal date, a go-live), not to the end of our quarter.
- [ ] The contacts include someone above the day-to-day user.

**Movement: is it alive?**
- [ ] A next step with a date that hasn't passed yet.
- [ ] Activity within the stale-deal limit (cadence.md, flexed with cycle length).
- [ ] The last meaningful step was a **buyer** action (they scheduled, shared, introduced, reviewed), not only a seller action (we sent, we followed up).
- [ ] The close date hasn't been pushed more than the allowed number of times.

**Plan: can it close?**
- [ ] Qualification scored (see [qualification](./qualification.md)), with no "unknown" left on the elements your stage requires.
- [ ] A mutual close plan exists and the buyer has seen it.
- [ ] Paper process mapped: security review, legal, procurement, signature.
- [ ] Commercial terms inside the pricing policy, or an exception already filed with the deal desk or chief.

## Questions that expose a weak deal

Ask these when a box above isn't ticked:

- "What did *they* do since last week?"
- "Who besides your contact has said they want this? How do you know?"
- "If the economic buyer said no tomorrow, what would the reason be?"
- "What has to happen between now and signature, and what's the date of each step?"
- "Why would they buy this quarter instead of next?"
- "What happens to them if they do nothing?"

If the owner can't answer, the deal isn't necessarily bad. The record is just weaker than the stage claims. Record the action, not a judgement.

## Mutual close plan template

Share it with the buyer as a draft for a human to send, and agree it with them. A plan only you have seen is a wish list.

```markdown
# Close plan: <account> / <deal>   (target signature <date>, last updated <date>)

Goal (in their words): <metric / outcome they expect, by when>
Why now: <event driving the date>

| # | Step | Owner (them/us) | Due | Status |
|---|---|---|---|---|
| 1 | Success criteria agreed | them + us | | |
| 2 | Technical validation / demo for wider team | us | | |
| 3 | Business case to economic buyer | champion | | |
| 4 | Security review submitted | us | | |
| 5 | Commercial proposal reviewed | them | | |
| 6 | Legal redlines | them + us | | |
| 7 | Procurement / vendor setup | them | | |
| 8 | Signature | economic buyer | | |
| 9 | Kick-off | us | | |

Risks: <top two, with mitigation>
```

## Inspection output

For each failing deal, write one action with an owner and date (org_task_comment, or a briefed task when it's real work). For the five deals that decide the quarter, add: what must be true to close, the single biggest risk, and the next step.

## Signals worth a deal review

Bring a deal to sales-deal-review when it's above the review threshold, needs a discount outside the band, has stalled for two reviews, has slipped its close date repeatedly, or when its champion or economic buyer has changed.

## Common pitfalls

- Inspecting only the deals the owner wants to talk about. Go through the list, sorted by weighted value.
- Accepting "next step: follow up" as a next step.
- Letting the amount grow as the deal ages without a new scope behind it.
- Treating a close plan nobody on the buyer's side has seen as a plan.
- Fixing the record yourself instead of asking the owner. The owner learns nothing and the problem comes back.
