---json
{ "title": "Design docs and RFCs", "summary": "When a change needs a design doc, a copyable RFC template, and what the reviewer checks before the work is briefed as tasks.", "tags": ["engineering", "design-doc", "rfc", "review"], "updated": "2026-11-04" }
---

# Design docs and RFCs

A design doc (or RFC, "request for comments") is how a significant change
gets reviewed before code is written, when changing course is still cheap.
It is a decision record as much as a plan: six months later it answers "why
is it built this way?".

## When one is needed

Brief a task straight away when the change is small, reversible and inside
one area. Ask for a design doc first when any of these hold (the company
can tune the list in `/org/engineering/kpis.md` or a process file):

- it changes a public API, a data schema, or a contract another unit uses;
- it touches auth, payments, personal or customer data (security review
  joins);
- it's hard to reverse: a migration, a new datastore, a vendor commitment;
- it will take more than one sprint or more than one engineer;
- two people already disagree about how to do it.

## Template

Save under `/org/engineering/design/<yyyy-mm-dd>-<slug>.md`, brief its
review as a task with `org_request_review`, and link it from the tasks it
spawns.

```markdown
# <Short name of the change>
Status: draft | in review | accepted | rejected | superseded by <link>
Author: <member>   Reviewers: <members>   Decision by: <date>
Key result served: <org_why chain or KR id>

## Problem
What is wrong or missing today, for whom, with evidence (metric, incident, request).

## Goals and non-goals
- Goals: what must be true when this is done (testable).
- Non-goals: what this deliberately won't do, so reviewers don't ask.

## Proposal
How it works: components, data flow, interfaces, a diagram if it helps.
Enough detail that someone else could build it.

## Alternatives considered
At least two, including "do nothing", each with why it lost.

## Risks and open questions
What could go wrong, what we don't know yet, and how we'll find out.

## Rollout and rollback
Flags, migration steps, staged rollout, the rollback trigger and who pulls it.

## Security, privacy and cost
Data touched, access needed, new vendors, expected run cost (estimate, labelled).

## Testing and monitoring
What tests prove it works; which metric or alert shows it is healthy.

## Plan
Milestones as tasks with done_when, in order.
```

## What the reviewer checks

- [ ] The problem is real and stated with evidence, not assumed.
- [ ] Goals are testable; non-goals are explicit.
- [ ] Alternatives are genuine, not straw men, and "do nothing" is costed.
- [ ] The riskiest assumption has a plan to test it early (a spike, a
      prototype, a flag).
- [ ] Rollback is possible, or the forward-fix is written down.
- [ ] Anything touching data or access has the security review it needs.
- [ ] The plan fits the appetite; if not, the doc says what is cut.

Review with `org_review`: accept, or request_changes with specific notes.
A reviewer who only says "looks good" has not reviewed it.

## Recording the decision

When accepted, add a line to `/org/decisions.md` (the decision, the date,
who decided, link to the doc) so it is findable later. When a later doc
replaces it, mark the old one "superseded by" rather than deleting it.

## Common pitfalls

- **Writing the doc after the code.** It becomes documentation, and the
  review becomes a rubber stamp.
- **Too long to review.** If the proposal section runs past a few screens,
  split the change or move detail to an appendix.
- **No decision date.** Reviews drift for weeks. Set one, and when it
  passes, the author decides with the comments in hand.
- **Design by committee.** Reviewers advise; one named person decides.
- **Ignoring non-functional needs.** Performance, cost, security and
  operability are where designs usually fail, not the happy path.
