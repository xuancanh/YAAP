---json
{ "title": "Spec template and review checklist", "summary": "A product spec template with what good looks like in each section, plus a checklist to run before asking for review so the spec does not come back.", "tags": ["prd", "spec", "template", "checklist"], "updated": "2026-11-04" }
---

# Spec template and review checklist

A spec is ready for review when an engineer and a designer could each start work without asking you what the feature is for. Most spec rework comes from three gaps: a vague problem, missing states and edge cases, and success metrics that cannot be measured.

## Template

```markdown
# <Feature> — spec
Status: draft | in review | approved   Owner: Product Owner   Key result: <link>

## Problem
<Who has the problem, what they are trying to do, what gets in the way — in their words.>
Evidence: <quotes with study link, ticket counts with source and period, data with source>

## Goals and success metric
- Goal: <user outcome>
- Metric: <name, definition, source> — baseline <value, date>, target <value> by <date>
- Guardrail: <metric that must not get worse>

## Non-goals
- <what we are deliberately not doing, and why>

## Users and permissions
<Which roles see and can do what.>

## Flows
1. <Main flow, step by step>
2. <Secondary flows>

## States and edge cases
| Situation | Expected behaviour |
|---|---|
| Empty (no data yet) | |
| Loading / slow | |
| Error (network, validation, server) | |
| Permission denied | |
| Very large input / many items | |
| Concurrent edit | |

## Analytics events
| Event | When it fires | Properties |
|---|---|---|

## Risks, open questions and dependencies
| Item | Owner | Due |
|---|---|---|

## Out of scope for v1, candidates for later
```

## What good looks like

**Problem.** Specific person, specific situation. "Users want better reports" is not a problem; "finance leads export to spreadsheets every month-end because the report can't filter by cost centre" is. Evidence should be traceable: link the study, give the count and its period.

**Metric.** It has a definition someone else could compute, a source, a baseline you have actually read, and a target. If no baseline exists yet, the first story is instrumenting it.

**Non-goals.** List what reviewers might assume is included. Non-goals are the cheapest scope control you have.

**States.** Walk every screen through empty, loading, error, permission and large-data states. Engineers will hit each one; if the spec is silent, they guess, and the guess becomes rework at acceptance.

**Analytics.** Name each event, when it fires and its properties. An event added after launch means the first weeks of data are lost.

**Open questions.** Every question has an owner and a date. A spec can go to review with open questions, but not with unowned ones.

## Review checklist

Run this yourself before requesting review:

- [ ] The problem names a user and a situation, with linked evidence.
- [ ] The key result link is present and the metric has a baseline, target and source.
- [ ] Non-goals list at least the obvious assumptions.
- [ ] Every flow has its empty, error and permission states covered.
- [ ] Analytics events are named with their trigger.
- [ ] Dependencies on other teams are listed with an owner.
- [ ] Nothing in the spec promises a date or scope to a customer.
- [ ] A reader who knows nothing about the feature could explain the problem back in one sentence.

## Handling review comments

- Reply to each comment with the change made, or why not.
- Record decisions in the spec (a short "Decisions" list with date and decider) so the next reader does not reopen them.
- If the review changes the goal or the metric, it is a new version: bump the status back to draft and say why.

## Pitfalls

- Writing the solution in so much UI detail that design has nothing to contribute. Describe behaviour and constraints; leave layout to design.
- Copying a competitor's feature as the spec. The problem should come from our users.
- Specs that grow during the sprint. New scope is a new story, refined and ordered like any other.
