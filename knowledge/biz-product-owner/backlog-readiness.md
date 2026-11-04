---json
{ "title": "Backlog readiness", "summary": "A readiness checklist for backlog items, a weekly refinement routine that keeps two sprints ready, and how to answer engineering's questions during the sprint.", "tags": ["backlog-refinement", "ready", "scrum", "sprint"], "updated": "2026-11-04",
  "sources": [{ "title": "The Scrum Guide (2020), Schwaber and Sutherland, accessed 2026-11-04", "url": "https://scrumguides.org/scrum-guide.html" }] }
---

# Backlog readiness

Your KPI is two sprints of refined work at the top of the backlog. Readiness is what lets sprint planning take minutes and lets the team start on day one without waiting for you.

## What the Scrum Guide says, and what it doesn't

The 2020 Scrum Guide describes refinement as breaking down and further defining backlog items, an ongoing activity that adds detail such as description, order and size. Items the team can complete within one sprint are "deemed ready for selection" in sprint planning. The guide makes the Product Owner accountable for creating, ordering and clearly communicating backlog items.

It does **not** define a "Definition of Ready"; that is a practice many teams add. If your team uses one, keep it short and agreed with engineering, and don't let it become a gate that blocks reasonable work.

## Readiness checklist

An item is ready when:

- [ ] **Outcome is clear:** the user story states who, what and why, and links the spec.
- [ ] **Acceptance criteria are written and testable**, including edge cases and analytics events.
- [ ] **Estimated by engineering** and fits in one sprint.
- [ ] **No open blocking question.** Non-blocking questions may remain, with an owner.
- [ ] **Dependencies are known:** on other stories (ordered) and other teams (requested, with a date).
- [ ] **Design is available** where the story needs it.
- [ ] **Ordered** relative to its neighbours.

Mark items that fail any line as "not ready" with the missing piece, so the gap is visible in planning.

## Weekly refinement routine

Do the prep alone, then hold a short session with engineering (and design where relevant).

**Before the session:**
1. Look at the next two sprints' worth of items by the team's recent throughput.
2. Run the checklist on each. List what is missing and who can supply it.
3. Pull in new urgent bugs from support by severity, and place them.
4. Prepare one or two items that need slicing.

**In the session:**
1. Walk the not-ready items: answer questions, agree the split, get estimates.
2. Confirm the order of the top items and the reasons.
3. Capture every new question as a comment on the item with an owner.

**After:**
1. Update the items and statuses the same day.
2. Archive stale items with no champion, with a one-line reason.
3. Write the backlog note: what changed, what is ready, what is still blocked.

## Answering questions during the sprint

Fast answers protect the sprint. A working routine:

- Check comments and mentions on in-sprint stories at the start of each working session, before anything else.
- **Answer on the story,** not in a side channel, so the answer is attached to the work.
- If you need time, reply with when you will answer.
- If the question reveals a gap in the criteria, update the criteria and tell the team in the same comment.
- If the answer changes scope materially, say so: it may become a new story rather than an expansion of this one.

## When the sprint scope is in trouble

You own the backlog's value, not the team's capacity. If the team says a story will not finish:

- Ask what slice of it could finish and still be valuable.
- Move the rest back to the backlog as its own story.
- Never quietly add criteria to compensate.

## Pitfalls

- Refining far beyond two sprints. Detail ages; refine just enough ahead.
- Refining alone. Readiness without engineering's estimate is your opinion, not readiness.
- Treating every open question as blocking. Separate what stops work from what can be decided during it.
- Ordering by who shouted last. Use the agreed method and record the reason.
