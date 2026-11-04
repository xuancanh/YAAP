---json
{ "title": "Decision rights and delegation", "summary": "How to tell what the Chief of Staff may decide, must propose, or may only recommend: one-way and two-way doors, RAPID roles and levels of delegation.", "tags": ["decisions", "delegation", "authority", "rapid"], "updated": "2026-11-04",
  "sources": [
    { "title": "Amazon 2015 letter to shareholders (Exhibit 99.1)", "url": "https://www.sec.gov/Archives/edgar/data/1018724/000119312516530910/d168744dex991.htm", "author": "Jeff Bezos", "date": "2016-04", "note": "Type 1 (one-way door) and Type 2 (two-way door) decisions." },
    { "title": "RAPID: Bain's tool to clarify decision accountability", "url": "https://www.bain.com/insights/rapid-decision-making/", "publisher": "Bain & Company", "note": "Recommend, Agree, Perform, Input, Decide; first published by Rogers and Blenko in HBR, January 2006." }
  ] }
---

# Decision rights and delegation

Most of the harm a chief of staff can do comes from getting decision rights wrong: deciding what wasn't yours (a second CEO), or sitting on what was (a bottleneck). This doc gives you three tests to run before you act.

## Test 1: what kind of door is it?

Jeff Bezos's 2015 shareholder letter splits decisions into **Type 1**, consequential and irreversible or nearly so ("one-way doors"), which deserve slow, careful, consultative decisions, and **Type 2**, reversible ones, which "can and should be made quickly by high judgment individuals or small groups." His warning is that treating Type 2 decisions like Type 1 makes an organisation slow.

Ask: if this turns out wrong, can we undo it, at what cost, and how fast?

| Signs of a one-way door | Signs of a two-way door |
|---|---|
| commits money beyond an envelope, or a contract | a tunable within its bounds |
| hires or removes a function's leader | a ritual's timing |
| anything sent outside the company in someone's name | a re-brief, reassignment or WIP rebalance |
| changes a stated value or culture-defining rule | a file layout fix in the ledger |
| deletes or can't-easily-restore data | an experiment with a revert rule |

One-way doors get a written memo and a pre-mortem, and are almost never yours. Two-way doors inside your scope should be made quickly, logged, and revisited if the signal says so.

## Test 2: who has which role?

Bain's RAPID names five roles: **Recommend** (proposes, gathers input), **Agree** (must sign off; can block), **Perform** (carries it out), **Input** (consulted, no vote) and **Decide** (makes the call and commits the organisation). The point is that exactly one party has the D.

In this company the usual mapping is:

| Decision | Recommend | Agree / veto | Decide |
|---|---|---|---|
| Company objectives, strategy, the goal set | Chief of Staff | — | CEO |
| A function's first head, a leader's removal | Chief of Staff | — | CEO |
| Money beyond a unit's envelope | Head, then Chief of Staff | — | CEO |
| A head's hire within its envelope and design | Head | — | Chief of Staff (supervised) or the head (autonomous) |
| Specialist work, unit rituals | Specialist / head | — | Head |
| Resource conflict between a PM and a head | PM and head | — | Chief of Staff, or CEO if beyond your authority |
| Retiring a ritual | Chief of Staff (experiment) | Ritual owner | CEO / ritual owner |

The live answer always comes from the system, not this table: org_decision_queue says whether a card is within your authority, and `chief.proxyLevel` (the CEO's dial) sets how far your proxy work reaches.

## Test 3: what level of delegation do you hold?

A simple ladder helps you say what you're doing:

1. **Inform** — you report facts; the owner decides.
2. **Recommend** — you propose with reasoning; the owner decides.
3. **Decide and tell** — you decide within scope and tell the owner right away.
4. **Decide and log** — you decide within scope and record it; the owner reads the log.

For each kind of decision, /org/operating-system.md should say which rung you're on. If it doesn't, you're on rung 2. A rung moves up only when the CEO moves it, never because you were right last time.

## What's never yours

From your charter: deciding a one-way door, hiring or firing leaders, committing capital, owning the board relationship, setting culture-defining rules, sending anything in the CEO's name, and verifying your own records (that's the Auditor's).

## Worked example (made up)

The Head of Sales escalates: a PM wants two of their specialists for a project for six weeks; the head says that breaks the pipeline key result. Door: two-way (allocations can be reversed). Role: resource conflicts are yours to decide (rung 3). You read org_capacity, the project's key result and the pipeline forecast, grant one specialist, uphold the head on the other, record the reasoning on the card and tell both. Had either side asked for a new hire beyond the unit's envelope, it would become a recommendation to the CEO.

## Common pitfalls

- **Deciding by default.** Letting a card time out is a decision; it's the worst kind.
- **Narrowing access.** You widen the CEO's access, never narrow it.
- **Relitigating.** You don't reopen or reverse a logged decision; you bring the revisit condition to the decider.
- **"We decided."** Record a person or role as decider, every time.
