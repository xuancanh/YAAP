---json
{ "title": "Receiving review", "summary": "How to request a review that gets a useful answer, respond to every comment, push back with reasons, and close the loop.", "tags": ["review", "feedback", "quality", "collaboration"], "updated": "2026-11-04" }
---

# Receiving review

Review is how work gets better before it matters, and how you catch mistakes while they're still cheap. Make it easy to review, respond to everything, and treat the comments as being about the work, not about you.

## Asking for review

Make the reviewer's job quick. A review request says:

- **What it is and where it lives**: the exact file path or link.
- **The done-when** it should be checked against. Usually you can copy it from the task.
- **What kind of review you want**: a full review, a quick check, or just one part ("is the pricing logic in section 3 right?").
- **What you're unsure about**, so they look there first.
- **When you need it by**, and whether that's hard or soft.

```text
Review please: /org/research/pricing-scan-2026-11.md, against the task's
done-when (table of 3 competitors, every price linked and dated, short
"what this means" section). I'm least sure about competitor C's seat price;
their page is ambiguous. Needed by tomorrow 10:00 for the leads meeting.
```

Before you send it, check the done-when yourself. Don't use the reviewer as your first reader for problems you could have found.

## Reading the review

- **Read it all before you reply.** Later comments often explain earlier ones.
- **Sort by severity.** Blockers first, then shoulds, then nits. If the reviewer didn't label them, ask which ones block. See [giving review](./giving-review.md) for the labels.
- **Assume good intent.** A blunt comment is usually a busy reviewer, not a hostile one.

## Responding to each comment

Every comment gets a reply, even if it's one word. The reviewer shouldn't have to re-check to see what you did.

| Comment | Your reply |
|---|---|
| Blocker, agreed | Fix it, then say "Fixed: <what changed>" |
| Should, agreed | Fix it, or say why not: "Leaving as is because <reason>" |
| Nit | "Done", or "Leaving it" (no reason needed) |
| Question | Answer it. If the answer should be in the work itself, add it there too |
| You disagree | Push back once, with your reason (below) |

## Disagreeing well

You can disagree. The reviewer can be wrong, or missing context. Do it once, with substance:

- Quote the done-when or the brief, if it supports you.
- Give the evidence: a source, a constraint, or a decision already logged.
- Offer a middle ground if there is one.

```text
On blocker 2 (add monthly prices): two of the three competitors don't publish
monthly team pricing (links in the table). I've added a note saying so rather
than estimating. OK to approve with that?
```

If you still disagree after one exchange, don't keep arguing in comments. Ask whoever owns the task or the decision to settle it, and go with their call.

## Closing the loop

- When the fixes are in, reply with a short summary: "Fixed 1 and 2, left 4 (nit). Ready for another look." Ask for a re-review only if there were blockers.
- If the review raised something bigger than this task (a risk, a decision, a follow-up), log it: `/org/risks.md`, `/org/decisions.md`, or a new task on the board.
- Note what you'd do differently next time. Repeated comments across reviews show you a habit worth fixing.

## Checklist

- [ ] Request names the file, the done-when, the review type, your doubts and a deadline
- [ ] Self-checked against the done-when first
- [ ] Every comment answered
- [ ] Every blocker fixed, or disagreed with once, with a reason
- [ ] Follow-ups logged as risks, decisions or tasks
- [ ] Closing message sent

## Common pitfalls

- **Silent fixes.** Changing things without replying makes the reviewer hunt for what changed.
- **Defending everything.** If most of your replies are pushback, re-read the brief.
- **Accepting everything.** Taking a wrong suggestion just to avoid friction makes the work worse. Push back when you have a reason.
- **Endless rounds.** Agree what "approved" needs after round one, and hold both sides to it.
- **Asking for review too late** to act on it. Ask early, while changes are still cheap.
