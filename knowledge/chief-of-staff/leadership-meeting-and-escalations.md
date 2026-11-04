---json
{ "title": "Leadership meeting and escalation triage", "summary": "Templates for a decision-shaped leadership agenda and decision item, plus a triage table for escalations, blockers and decision cards that land on the Chief of Staff.", "tags": ["meetings", "escalation", "decisions", "triage", "template"], "updated": "2026-11-04" }
---

# Leadership meeting and escalation triage

The leadership meeting exists to make decisions the written record can't. Everything else (status, FYIs, celebrations) goes in writing. Escalation triage is the daily version of the same job: put each stuck thing in front of the one person who can unstick it, with what they need to decide.

## Agenda template

Publish at /org/meetings/company/<yyyy>/<yyyy-mm-dd>-board-agenda.md before the pre-read deadline.

```markdown
# Leadership meeting — <yyyy-mm-dd>

Owner: <CEO> · notes and decision log: Chief of Staff · pre-reads due: <date time>

## 1. Scorecard (5 min)
On/off track only. Pack: /org/reports/<yyyy>-W<ww>.md

## 2. Decisions (ordered by cost of delay)
| # | Question | Decider | Recommender | Door | Pre-read | Time box |
|---|---|---|---|---|---|---|
| 1 | <question> | <one name or role> | <name> | one-way / two-way | <link> | 15 min |

## 3. Questions and discussion
| # | Question | Owner | Time box |
|---|---|---|---|

## 4. Carried over
- <unresolved disagreement or deferred item from last meeting>

Invited: only the people the decisions above need.
```

## Decision item template

The owner writes this pre-read; you chase it. With `chief.memoFirst` on, every decision item needs one; one-way doors always do.

```markdown
## Decision: <question, phrased so yes/no or a choice answers it>

Decider: <one person or role> · Recommender: <name> · Input from: <names> · Veto holders: <if any>
Door: one-way / two-way · Deadline: <date> · Default if no decision: <what happens>

### Options
| Option | Cost | Reversible? | Effect on <key result> | Risks |
|---|---|---|---|---|
| A — <…> | | | | |
| B — <…> | | | | |
| Do nothing | | | | |

### Recommendation
<option, why, confidence>

### Pre-mortem (one-way doors)
"It's a year later and this failed. Why?" — <failure modes>
```

## Building the agenda

1. Collect candidates: off-track numbers, top issues in /org/issues.md, pending CEO decision cards (org_report), unaccepted dependencies, heads' escalations, and what the CEO asked to discuss.
2. Drop pure status.
3. Shape each survivor as a decision or a question, with one decider.
4. No pre-read by the deadline? The item moves to the next meeting. Don't let it be improvised in the room.
5. Order decisions by cost of delay: what gets worse, or more expensive, each day this waits.

During the meeting, log each decision to /org/decisions.md: question, decider, rationale, dissent, follow-ups with owners, revisit condition. Afterwards route every follow-up as a task, and put unresolved disagreement on the next agenda.

## Escalation triage

Run this on everything your daily sweep turns up. Oldest and most urgent first; a head's request older than `chief.handoffSlaHours` goes to the top, because you're a handoff too.

| What landed | First question | Where it goes |
|---|---|---|
| Decision card from a head, within your authority (org_decision_queue says so) | Does it hold up against the design, envelope and key result? | Decide with org_decide, reasoning in the note |
| Card missing facts | Which fields are missing? | Send back naming them; don't fill them from guesses |
| CEO-reserved card | What do you recommend, and why? | Recommend; never sit on it (a card left alone climbs with "no recommendation") |
| `Escalation:` task from a head | Is it inside your delegated scope? | Answer on the task, or org_escalate to the CEO with your recommendation |
| Blocked task with no named blocker | What does it wait on? | Ask the owner once to set waitsOn |
| Blocked on another function | Who are the two owners and what's the SLA? | Handoff monitor, not you |
| Blocked on information someone holds | Who holds it? | Comment to them with the question and a date |
| Blocked on a CEO-only decision with no card | Can you frame it? | Question, options, recommendation, default; org_escalate |
| Stopped by the loop breaker or no-progress block | Why did it stop? | Re-brief smaller with a sharper done_when, or reassign; never rerun the same brief |
| Degraded provider or connection | Which tasks and members wait on it? | Say so in the brief; only the CEO resolves incidents |
| "Assurance request: …" | Does it name evidence and ids? | Leave it open for the Auditor; never audit it yourself |

## When the CEO is away

Every card carries a deadline and a default (deny, unless the CEO made that kind default to approve). List cards past `chief.decisionOverdueHours` at the top of the brief once a day. Plan dependent work as if the default happens: replan, descope or park, and tell the owners. Silence isn't consent beyond the card's own default.

## Common pitfalls

- **The committee decider.** "Leadership team" isn't a decider. Name one person or role.
- **Status theatre.** If the agenda is mostly updates, the meeting should be shorter or a document.
- **No follow-up.** A decision without owned follow-ups wasn't really made.
- **Gatekeeping.** Never filter, reword or drop something addressed to the CEO; link it.
