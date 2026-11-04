---json
{ "title": "Charter template", "summary": "A one-page program charter template with guidance on writing the goal, scope, roles and success measures so the sponsor can confirm it quickly.", "tags": ["charter", "template", "scope", "raci"], "updated": "2026-11-04" }
---

# Charter template

A charter is the agreement everyone points to when a trade-off comes up. It should fit on one page and be confirmed by the sponsor before anyone plans work. If it runs longer, the extra detail belongs in the plan.

## Template

```markdown
# <Program name> — charter
Sponsor: <role>   Coordinator: <you>   Confirmed: <date or "pending">

## Goal
<Outcome> by <date>, measured by <measure>. Serves <key result>.

## Why now
<One or two sentences: what happens if we don't do this, or don't do it now.>

## Scope
In: <list>
Out: <list — the things people will assume are in>

## Workstreams and owners
| Workstream | Unit | Accountable owner | Main deliverable |
|---|---|---|---|

## Decision-maker
<Who decides trade-offs between scope, date and cost; how to reach them.>

## Milestones
| # | Milestone (observable state) | Target date | Done when |
|---|---|---|---|

## Success measures
- Outcome: <the key result and its target>
- Delivery: milestones on time; <other>

## Budget
<Amount and owner, or "none">

## Known risks and assumptions
<Top three; the full list lives in raid.md>
```

## Writing each part

**Goal.** Write it as a state of the world, not an activity. "Run the migration" is an activity; "all customer data served from the new region by 30 Jan, with no open sev-1 incidents" is a goal. Include the date.

**Scope out.** This is the most useful section and the one most often skipped. List what reasonable people will assume is included: "Mobile app changes are out", "Historical archive data moves in a later program". Each line saves an argument later.

**Workstreams and owners.** One accountable owner per workstream, named by role and unit. If two people are accountable, nobody is. The owner is whoever the unit lead names; you propose, they confirm.

**Decision-maker.** Name the single person who decides when scope, date and cost conflict. Usually the sponsor. Say how fast they can be reached; a decision-maker who replies weekly will slow the program to weekly.

**Milestones.** Three to six milestones, each an observable state with a "done when" anyone can check. See [Milestones and the critical path](milestones-and-critical-path.md).

**Success measures.** Separate the outcome (did the key result move?) from delivery (did we ship on time?). A program can deliver perfectly and miss the outcome; the charter should make that visible at the retro.

## Roles: a light RACI

When several units touch one deliverable, a small RACI table prevents dropped handoffs:

- **R**esponsible: does the work.
- **A**ccountable: answers for it; exactly one per row.
- **C**onsulted: asked before it is final.
- **I**nformed: told after.

Use it only for deliverables where confusion is likely. A RACI for every task becomes noise.

## Getting it confirmed

1. Share the draft with workstream owners first; ask each to confirm their row and their milestone dates.
2. Send it to the sponsor with the open questions listed at the top.
3. Record the confirmation date in the header. Until it is confirmed, the program is in setup, and your status should say so.

## Pitfalls

- A goal with no date or no measure.
- "Scope: TBD". Write what you know is in and out, and list the open items as decisions with owners.
- Milestones set by the coordinator without the owners' agreement. They will not feel bound by them.
- Updating the charter silently. Any change to goal, scope or milestone dates is a decision: record who approved it and when, and note it in the next status.
