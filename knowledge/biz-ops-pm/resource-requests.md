---json
{ "title": "Resource requests that get answered", "summary": "Size what a project needs, write a request a head can approve quickly, negotiate an adjusted answer, and escalate a conflict with a case.", "tags": ["resources", "matrix", "staffing", "escalation", "allocation"], "updated": "2026-11-04" }
---

# Resource requests that get answered

On a matrix team you borrow every person you work with. The head who lends them stays accountable for their capacity and their quality. Your request is a proposal to that head, so write it the way you would want to receive it: specific, bounded, and tied to an outcome.

## Size the need before you ask

Work from the milestone plan, not from a guess at headcount.

1. For each milestone, list the competencies it needs (engineer, designer, analyst, writer).
2. For each competency, estimate the share of a person's time and the window: when it starts and when it ends.
3. Add the budget lines that are not people: a tool, an external service, a paid dataset.
4. Look for overlap. Two milestones that each need "some design" often add up to one designer at a real share for a shorter window.

**Prefer a few members at a real allocation over many at a sliver.** Each extra member adds context-switching for them and coordination for you. A member at a small share rarely finishes anything inside a sprint.

## The request, field by field

| Field | Good | Weak |
|---|---|---|
| Role | "Backend engineer, payments experience helpful" | "An engineer" |
| Allocation | "50%" | "As much as possible" |
| Window | "Mon 3 Nov – Fri 28 Nov" | "Soon" |
| Why | "M2: checkout live for internal accounts, serves KR 'trial-to-paid ≥ target'" | "For the checkout project" |
| Member | "Ana, if available — she built the invoice service" | (blank when you do know who fits) |

Name the member when you know who fits; the head still decides. Leave it blank when you do not, and let the head pick.

## Reading the answer

- **Approved** — the member is on the team. Brief their first task the same day so the allocation is used.
- **Adjusted** — you got less share or a later window. Re-plan first: what moves, which milestone shifts. Only argue back if the adjusted plan misses a key result date, and then argue with that date.
- **Declined** — the reason matters. "No capacity" invites asking another head or a later window. "Wrong role" means rethink the need.
- **Hiring** — plan the work that does not need the seat first, and treat the seat's arrival date as a dependency with a risk.

## Escalating a conflict

Escalate when the outcome is at stake and you and the head cannot settle it, not when you merely prefer a different answer. A good escalation case is short:

```
Conflict: Data unit declined analyst 40% for Nov.
At stake: KR "activation measured weekly" — no analyst means no
baseline before the experiment starts on 17 Nov.
Already cut: dropped the second dashboard; asked for 20% instead (declined).
Options: (a) 20% analyst for two weeks; (b) delay the experiment to Dec;
(c) Data lends the analyst after the quarter-end report on 10 Nov.
Recommendation: (c).
```

It goes to the head's manager first. Their answer is final until something changes; do not re-open it without new facts.

## Giving capacity back

Release a member the day their part is done, with a one-line note on what they delivered. Heads lend more readily to Program Managers who return people on time. A member idle on your project for a week is capacity the company is paying for twice.

## Pitfalls

- Asking for a person before the plan exists, then discovering the need was different.
- Treating "pending" as "approved" and assigning work early.
- Pushing a member past full allocation by asking several heads for overlapping time. The tools refuse it, but the planning error remains.
- Escalating every adjusted answer. Save escalation for outcomes, or heads stop engaging.
