---json
{ "title": "Dependencies as commitments", "summary": "Find every cross-team dependency, turn each into an accepted commitment with an owner and a date, and handle the ones that slip.", "tags": ["dependencies", "cross-functional", "handoffs", "sla"], "updated": "2026-11-04" }
---

# Dependencies as commitments

A dependency is work your project needs from someone outside your team. It is only safe when someone in the providing unit has accepted it with a date. Until then it is a risk, and your health update should say so.

## Finding them

Most dependencies hide in three places. Check all three every Wednesday.

1. **The plan.** Each milestone: what must exist before it can be true that your team does not build? (An API key, a legal review, a design system component, a data export.)
2. **Blocked tasks.** Any task whose waitsOn points to an agent, a manager or a task outside the team.
3. **The sync.** Phrases like "once they…", "we're waiting on…", "assuming X is ready". Each is a dependency nobody has written down.

## The four states

| State | Meaning | What you do |
|---|---|---|
| Unasked | You know you need it; nobody in the providing unit knows | Send the request today |
| Requested | A task is on their board; no owner has accepted it | Chase once at the SLA |
| Accepted | An owner and a due date exist | Track it like your own milestone |
| At risk | Unaccepted past the SLA, or accepted but slipping | Put it in the health update with the ask |

Write the state in your dependency table in plan.md, one row per dependency: what, from which unit, needed by, owner, due, state, last checked.

## Writing a request the other unit can accept

The providing head reads dozens of requests. Make yours easy to say yes to.

- **Title:** "Request for Legal: DPA review for payments vendor."
- **Outcome:** what done looks like for them, in their terms.
- **Needed by:** the date your milestone needs it, with the milestone named. Give the real date, not a padded one; padding gets discovered and erodes trust.
- **Context:** the project, the key result it serves, and what happens if it is late.
- **Inputs:** everything they need to start, attached. A request that triggers a question back loses a day.

Record the row in /org/handoffs.md with the SLA you and that head agree.

## When the work is better done inside your team

Sometimes the cleanest fix is a member from that unit joining your project for the part that needs them. Propose the member to their head instead of filing a request. You can then assign the work directly, because the allocation is the permission. You may never assign work to someone who is not on your team.

## Handling a slip

1. **At the SLA, unaccepted:** one comment on the task, restating the need-by date and the impact. Do not chase repeatedly in channels.
2. **Still unaccepted:** it becomes at risk in your health update, with the ask addressed to the head. The chief's handoff monitor routes it from there.
3. **Accepted but late:** ask the owner for a new date and its reason, then re-forecast your milestone. If the new date breaks your milestone, the slip goes in the update; if it breaks the appetite, it goes to the appetite decision.

## Reducing dependencies at the source

The best dependency is one you removed. At kickoff and at every re-plan, ask:

- Can we sequence our work so the dependency is needed later, after it is likely ready?
- Can we build a stub or use a manual workaround for the first slice?
- Is the dependency truly required for the key result, or only for a nice-to-have?

## Weekly check

- [ ] Every row has a state, and every accepted row has an owner and date.
- [ ] Every unasked row was asked this week.
- [ ] Every at-risk row appears in the health update with an ask.
- [ ] Closed rows are marked done with the date they arrived.
