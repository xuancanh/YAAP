---json
{ "title": "Writing minutes", "summary": "How to write meeting minutes people act on: decisions, action items with owner, done-when and date, and open questions, not a transcript.", "tags": ["meetings", "minutes", "actions", "templates"], "updated": "2026-11-04" }
---

# Writing minutes

Minutes record what changed because the meeting happened: what was decided, who will do what, and what's still open. They aren't a transcript. Someone who missed the meeting should know in a minute what it means for them.

## Structure

Put the most useful parts first.

1. **Decisions**: what was decided, by whom, and the reason in one line.
2. **Action items**: each one has an owner, a done-when and a date.
3. **Open questions**: unresolved items, each with someone to chase it.
4. **Notes**: short context per agenda item, only where it helps a reader understand the decisions. Optional.

Include the meeting name, date, attendees and a link to the agenda at the top.

## Template

```markdown
# <Meeting name> — <YYYY-MM-DD>

**Attendees.** <names/roles>   **Absent.** <names>
**Agenda.** </org/meetings/.../agenda.md>

## Decisions
- **<Decision as an action>.** Decided by <name>. Why: <one line, link to source>.
  Logged in /org/decisions.md: yes / not needed (two-way door)

## Action items
| Action | Owner | Done when | Due |
|---|---|---|---|
| <verb-first action> | <one name> | <checkable result> | <YYYY-MM-DD> |

## Open questions
- <Question>? Chase: <name>, by <date>.

## Notes
- **<Agenda item>.** <1–3 lines of context, only what readers need>
- Parked: <topic> — owner <name>
```

Save the minutes under `/org/meetings/`, following the folder's naming pattern, for example `/org/meetings/leads/2026-11-06.md`.

## Writing each part well

**Decisions.** Write each one as what will happen, not as what was discussed. Not "Discussed per-seat pricing" but "Add a per-seat team plan from 2027-01-01." If nothing was decided, don't invent a decision. Put the item under open questions.

**Action items.** Each one has:

- **One owner.** Not "Sales team". The owner can delegate, but they answer for it.
- **A done-when** that someone else could check, the same as a task's `done_when` on the board.
- **A date.**

Put every action on the board as a task with the same owner, done-when and due date, and link the task in the minutes if you can. Actions that only live in minutes get forgotten.

**Open questions.** Phrase each as a question and name who will chase it. These often become next meeting's agenda.

**Numbers.** If a figure came up, write where it came from ("2 lost deals, per /org/sales/lost-deals.md"). If no one knew, write "estimate, unverified" or turn it into an open question. Minutes are where unsourced numbers start getting quoted as fact.

## Worked example

```markdown
# Leads weekly — 2026-11-06

**Attendees.** CEO, Sales lead, Finance manager, CoS
**Agenda.** /org/meetings/leads/2026-11-06-agenda.md

## Decisions
- **Add a per-seat team plan from 2027-01-01.** Decided by CEO. Why: lost deals cited
  it (/org/sales/lost-deals.md); all 3 close competitors offer it
  (/org/research/pricing-scan-2026-11.md). Logged in /org/decisions.md: yes

## Action items
| Action | Owner | Done when | Due |
|---|---|---|---|
| Draft per-seat price options | Finance manager | 2–3 options with margin per seat in /org/pricing/per-seat-options.md, review requested from CEO | 2026-11-13 |
| Update the pricing page copy | Marketing lead | Draft copy in /org/marketing/pricing-copy.md, approved by Sales lead | 2026-11-20 |

## Open questions
- Do existing customers move to per-seat automatically? Chase: Sales lead, by 2026-11-13.
```

## Checklist

- [ ] Decisions, then actions, then open questions
- [ ] Each decision names a decider, and each one-way decision is logged
- [ ] Each action has one owner, a checkable done-when and a date, and is on the board
- [ ] Every number has a source or an "estimate" label
- [ ] Saved under `/org/meetings/` and linked in the channel the same day

## Common pitfalls

- **Transcripts.** Nobody reads them. Record outcomes.
- **"Agreed to look into it."** That's not a decision or an action. Give it an owner and a done-when, or make it an open question.
- **Shared owners.** "Sales and Marketing" owns nothing. Pick one.
- **Late minutes.** A day late, half the actions have already been forgotten.
- **Minutes that overrule the room.** If you're unsure what was decided, ask the decider before you publish.

For running the meeting itself, see [running a meeting](./running-a-meeting.md).
