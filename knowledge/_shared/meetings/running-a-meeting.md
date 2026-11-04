---json
{ "title": "Running a meeting", "summary": "How to run a meeting that ends in decisions and actions: a stated purpose, an agenda with pre-reads, timeboxes, and cancelling when there's no agenda.", "tags": ["meetings", "facilitation", "agenda", "decisions"], "updated": "2026-11-04" }
---

# Running a meeting

A meeting is worth having when people need to decide, solve or align together, and a written update wouldn't do. If the work could be done by reading a file and leaving a comment, do that instead.

## Before: purpose and agenda

Write the purpose as the result you want when the meeting ends:

- "Decide whether to add a per-seat plan." (a decision)
- "Agree the Q1 OKR draft, or list what blocks it." (alignment)
- "Find the cause of the failed launch email." (problem-solving)

"Discuss pricing" isn't a purpose. If you can't write one, don't hold the meeting.

The agenda lists items, each with an owner, a timebox and the result wanted. Attach pre-reads so the meeting time goes to deciding, not reading. Send it early enough for people to read. Your company's cadence settings may fix how early.

```markdown
# <Meeting name> — <YYYY-MM-DD>

**Purpose.** <The result we leave with.>
**Decider(s).** <Name, for any decision item>

| # | Item | Owner | Time | Result wanted | Pre-read |
|---|---|---|---|---|---|
| 1 | Per-seat plan | Sales lead | 15 min | Decision | /org/research/pricing-scan-2026-11.md |
| 2 | Q1 OKR draft | CoS | 10 min | Comments or approval | /org/okrs/2027-q1-draft.md |
| 3 | Risks review | Ops head | 5 min | Owners confirmed | /org/risks.md |

Read the pre-reads before we start; we won't present them.
```

**Cancel when there's no agenda.** If nothing arrives by the deadline, cancel and say so in one line: "No agenda items, so cancelling; updates go in the channel." A recurring meeting with nothing to decide is a good one to cancel.

## During: keep it moving

- **Open with the purpose** in one sentence, and confirm who decides each decision item.
- **Timebox each item.** When time's up, either decide, give someone a task to bring back an answer, or agree to extend on purpose. Don't drift past it.
- **Assume the pre-read was read.** Ask for questions and objections, not a recap.
- **Separate facts from opinions.** When someone states a number, ask where it's from. If no one knows, note it as an estimate or as an open question.
- **Park side topics.** Write them in a "parked" list and give each one an owner at the end.
- **Close every item out loud** with a decision, an action (owner, done-when, date) or an open question. "We'll think about it" is none of these.
- **In the last few minutes**, read the decisions and actions back. This catches misunderstandings while everyone's still there.

In a meeting room, speak like a teammate: a sentence or two, react to what was said, and use names. Put long material in a file and give a one-line pointer to it.

## After: minutes within the day

Write minutes the same day, save them under `/org/meetings/`, and post the link. Log one-way decisions in `/org/decisions.md` and add actions to the board as tasks with a done_when. See [writing minutes](./writing-minutes.md).

## Worked example

The Thursday leads meeting gets one agenda item by the deadline: "Per-seat plan — decision — Sales lead — pre-read attached." The facilitator shrinks the meeting to that one item. The Sales lead opens with a two-line recommendation, the Finance manager asks where the "2 lost deals" figure comes from (answer: `/org/sales/lost-deals.md`), the CEO decides yes with a revisit date, and the meeting ends with two actions on the board.

## Checklist

- [ ] Purpose written as a result
- [ ] Every item has an owner, a timebox, a result wanted and its pre-read
- [ ] A decider named for each decision item
- [ ] Agenda sent in time, or the meeting cancelled
- [ ] Every item closed with a decision, an action or an open question
- [ ] Minutes, decision log and board updated the same day

## Common pitfalls

- **Status-update meetings.** Reading out updates is better done in writing.
- **Presenting the pre-read.** That punishes the people who read it.
- **No decider in the room.** Then the meeting can only produce a recommendation. Say so in advance.
- **Actions without owners.** "Someone should…" means no one will.
- **Overrunning.** Respect the timebox, or extend it on purpose.
