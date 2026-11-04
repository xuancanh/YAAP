---json
{ "title": "Design brief", "summary": "A copyable design brief for intake and assignment: problem, user, success measure, constraints, states and done_when, with a triage checklist.", "tags": ["brief", "intake", "templates", "design"], "updated": "2026-11-04" }
---

# Design brief

Most design rework starts with a thin brief: the problem was never stated, the user was assumed, or nobody said what "done" looked like. Intake triage checks requests against this template; anything missing goes back to the requester as one specific question. Save accepted briefs as `/org/design/briefs/<slug>.md` and link them from the task and from `/org/design/requests.md`.

## Template

```markdown
# Design brief: <name>
Requester: <member, function> · Owner: <designer> · Reviewer: <a different member>
Goal served: <KR or objective> · Effort: S | M | L · Due: <date> · Status: <queue status>

## Problem
<What the user is trying to do and what gets in the way.>
Evidence: <research, analytics, support tickets, crit notes — linked>

## User and context
Who: <segment or role; first-time or returning; device and setting>
Accessibility needs to design for: <e.g. keyboard-only, screen reader, low vision>

## Success measure
<How we'll know it worked: e.g. task success on "invite a colleague" from <baseline> to <target> in the next usability round>

## Scope
Flows: <list>
States: default, empty, loading, error, success, permission-denied, long content
Out of scope: <and why>

## Constraints
Design system: <components to use; any new component goes through governance>
Platform: <web, mobile, breakpoints>
Content: <voice guide, UX Writer involved yes/no>
Technical: <engineering constraints known>
Not allowed without approval: publishing externally, changing the live product

## Done when
- [ ] All listed flows and states designed
- [ ] Accessibility checklist passed (contrast, focus, labels, target size)
- [ ] System components used, or a governance proposal filed
- [ ] Copy reviewed by the UX Writer
- [ ] Reviewed in crit with must-fixes resolved
- [ ] Prototype or file linked; handoff notes for engineering written
```

## Intake triage checklist

- [ ] Is the problem stated from the user's side, not as a solution ("add a button")? If it's a solution, ask what problem it solves.
- [ ] Is there a goal it serves? Requests serving no goal are deferred or declined with the reason.
- [ ] Is there a success measure, even a rough one?
- [ ] Is the deadline real (tied to a launch or commitment) or a preference?
- [ ] Does it need research first? If nobody knows how users behave here, brief a small study before the design.
- [ ] Does capacity allow it now (`org_capacity`)? If not, say when.

## Worked example (made-up)

Request from product: "Make the invite screen nicer." Triage asks: what's going wrong? Product links a usability round where 3 of 8 participants couldn't find how to invite more than one person. The brief becomes: problem "admins can't add several colleagues at once"; success measure "task success on bulk invite at least 7 of 8 in the next round"; states include an error for invalid addresses and a long list of 50 names; out of scope: SSO provisioning. Effort M, due before the bulk invite launch readiness review.

## Common pitfalls

- Accepting "make it nicer" or "modernise it" without a problem behind it.
- Briefs listing only the happy path; error and empty states are where most rework comes from.
- A success measure invented after the work ships.
- Deadlines that nobody can trace to a launch, so everything is urgent.
