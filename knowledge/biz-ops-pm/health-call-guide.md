---json
{ "title": "Making the health call", "summary": "Decide on track, at risk or off track from evidence, place the hill honestly, and write an update whose ask gets acted on.", "tags": ["status", "health-update", "hill-chart", "reporting"], "updated": "2026-11-04",
  "sources": [{ "title": "Shape Up, chapter 13: Show Progress (Basecamp), accessed 2026-11-04", "url": "https://basecamp.com/shapeup/3.4-chapter-13" }] }
---

# Making the health call

A health update exists so someone else can act without asking you a question. Make the call first, then give only the evidence and the ask that support it.

## The decision rule

Work through these in order and stop at the first that is true.

1. **Off track** — the forecast puts a milestone or the target date past its date, or past the appetite, and nothing already agreed brings it back.
2. **At risk** — a milestone is in doubt: a blocker with no accepting owner, a pending allocation past the hop window, the forecast within the slack you have left, or a key assumption untested.
3. **On track** — the next milestone holds on the forecast and nothing blocks it.

When two people would argue between two calls, pick the worse one. A downgrade that turns out unnecessary costs a conversation; a late downgrade costs the milestone.

## Evidence to read before you call

- Tasks done since the last update, and tasks aged past the team's normal cycle.
- The next milestone's date versus the forecast.
- Spend and days used against the appetite.
- Open blockers, especially ones that wait on another unit.
- Last update's ask: was it answered?

An unanswered ask from last week is itself a reason to stay at risk.

## The hill

Shape Up's hill chart splits work into two halves: uphill is figuring out the approach, full of unknowns; downhill is execution, when the remaining work is known. Place the project, or each scope inside it, where it really is.

- **Uphill (0–0.5):** the team still has open questions about how. Progress shows as questions closed, not tasks closed.
- **Downhill (0.5–1):** what remains is known and listed.

**The watermelon check:** green on the outside, red inside. If the dot has not moved for two updates and you are calling on track, either the call or the dot is wrong. Say which in the body.

## Writing the update

Keep it to the fields plus a short body. Template:

```
Health: at risk
Reason: payments API sandbox not provisioned; integration tests can't start.
Ask: IT admin access for the sandbox from Head of IT by Thu 12:00.
Hill: 0.4 (approach for refunds still open)
Body: 6 of 11 tasks done; M2 "checkout live for internal accounts" due Fri 14,
forecast Mon 17 if the sandbox lands Thursday. Spend 55% of appetite.
```

Rules for each field:

- **Reason** is a cause, not a symptom. "Behind schedule" is a symptom; "the design review took two rounds instead of one" is a cause.
- **"Unknown, still investigating"** is a valid reason when it comes with an owner and a date for the answer. A plausible story you have not checked is not.
- **Ask** names one thing, one person, one deadline. If you have three asks, the biggest goes in the field and the rest go in the body.
- **No softening.** Do not move a call to protect a team member or a head. Name the gap, not the person's failure.

## Pitfalls

- Calling on track because the tasks are moving, when the key result is not.
- Reporting from the channel's mood instead of the board.
- Forgetting to send the ask: the update is posted, but the addressee never gets a task or comment. Send it the same day.
- Re-dating a milestone silently. Every slip appears in the next update with its reason.
- Over-explaining a green update. On track needs one line of evidence and nothing else.

## Quick self-check before posting

- [ ] Could the reader repeat the call and its reason in one sentence?
- [ ] Does every number in the body come from a tool read today?
- [ ] Is the ask addressed and dated, and sent as a task or comment?
- [ ] Does the hill match the body?
