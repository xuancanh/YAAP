---json
{ "title": "Planning a quarter", "summary": "How to turn objectives into a quarter plan: capacity first, milestones with done-when, dependencies, buffer, and a written list of what won't happen.", "tags": ["planning", "milestones", "quarterly", "capacity"], "updated": "2026-11-04" }
---

# Planning a quarter

A quarter plan connects the objectives to the board. It says what will be delivered by when, by whom, and what's deliberately left out. It should fit on a page or two. If it doesn't, it's a backlog, not a plan.

The steps below fit any planning period. A quarter is just the common one, and your company may plan on a different cadence.

## 1. Start from the goals

List the objectives and key results for the period (see [writing key results](../okrs/writing-key-results.md)). Every milestone in the plan should trace back to one of them, or to work that keeps the lights on. If something traces to neither, question it.

## 2. Measure capacity before filling it

Work out what you actually have before choosing what to do:

- Who is available, and for how much of the period.
- What's already committed: ongoing operations, recurring reports, support, carry-over work.
- What's left is your **plannable capacity**.

Don't plan to 100% of it. Leave room for the unplanned. How much depends on your history. Look at how much unplanned work landed last period (the board shows it) rather than picking a number from the air.

## 3. Break goals into milestones

A milestone is a checkable result on a date, not an activity. Give each one:

- **A name and a done-when**, the same as a task.
- **An owner**: one person or agent.
- **A date**, from a range estimate (see [estimating work](./estimating-work.md)).
- **Dependencies**: what must happen first, and who owns it.

Aim for a milestone every few weeks per objective. A single milestone at the end of the quarter hides trouble until it's too late to fix.

## 4. Map dependencies and the critical path

List which milestones depend on others, and especially on other teams or outside people. The longest chain of dependent work is the critical path, and any slip on it moves the end date. Start the critical-path work early, confirm each cross-team dependency with its owner in writing, and add a risk for each one you don't control (see [risk registers](../risk/risk-registers.md)).

## 5. Fit to capacity and cut

Add up the estimates and compare them with plannable capacity. If they don't fit, and at first they usually don't, cut scope rather than squeezing estimates. Use a ranking method from [impact, effort and RICE](../prioritisation/impact-effort-and-rice.md). Record what you cut under "Not this quarter". That list is as important as the plan.

## 6. Write it down and review it

```markdown
# Plan: <team> — <period, e.g. 2027 Q1>

**Objectives.** <links to the OKRs>
**Capacity.** <people/agents × availability>; committed run work: <list>;
unplanned reserve based on last period: <amount, source: board history>

## Milestones
| # | Milestone | Done when | Owner | Date (range) | Depends on | KR |
|---|---|---|---|---|---|---|
| M1 | | | | | | |

**Critical path.** M1 → M3 → M5
**Buffer.** <amount>, held before <final milestone>

## Not this quarter
- <Item> — because <reason>

## Risks
- See /org/risks.md: <risk ids>

## Review
Check progress at each OKR check-in; replan if a critical-path milestone slips.
```

Save it under `/org/`, put each milestone's first tasks on the board, and request a review from the person who owns the objectives.

## Worked example (sketch)

Objective: *New customers get value in their first week.* The capacity check shows one growth agent full-time and a designer half-time. Reporting and support take about a quarter of the growth agent's time, based on last quarter's board. Milestones: M1, baseline activation measured (week 2); M2, onboarding checklist live (week 6, depends on design); M3, empty-state prompts tested (week 9); M4, results write-up (week 12). A referral programme was also proposed. It doesn't fit, so it goes under "Not this quarter" with the reason "lower RICE score, no design capacity".

## Checklist

- [ ] Every milestone traces to a KR or to run work
- [ ] Capacity measured, with committed work and an unplanned reserve taken out first
- [ ] Milestones are results with a done-when, an owner and a date range
- [ ] Cross-team dependencies confirmed in writing, and logged as risks
- [ ] Plan fits capacity, and cuts are listed under "Not this quarter"
- [ ] Review points are set

## Common pitfalls

- **Planning to 100%.** The first surprise breaks the whole plan.
- **Activity milestones.** "Work on onboarding" can't be checked.
- **Unconfirmed dependencies.** A dependency that's assumed and never agreed is the most common reason a plan slips.
- **No "not doing" list.** Cut items creep back in.
- **Never replanning.** A plan that ignores what you've learned gets ignored itself. Update it openly when the facts change.
