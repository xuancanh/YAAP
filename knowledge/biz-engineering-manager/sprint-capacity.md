---json
{ "title": "Sprint capacity and commitment", "summary": "A worked method for turning members, load and past say/do into a sprint commitment that holds, plus the common ways it goes wrong.", "tags": ["engineering", "sprint", "capacity", "planning"], "updated": "2026-11-04" }
---

# Sprint capacity and commitment

The sprint-planning playbook says to compute capacity, keep a buffer and
discount by past say/do. This doc shows the arithmetic and the judgment
around it, so the commitment is something the chief can rely on and the
retro can learn from.

## The calculation

Work in whatever unit the team estimates in (task count, points or ideal
days) and keep it the same across sprints, or the history is useless.

```text
gross capacity   = sum over members of (available days × focus factor)
available days   = sprint days − leave − days on call − onboarding days
buffer           = gross capacity × unplanned share   (default 15–20%, company-set)
plannable        = gross capacity − buffer − debt allowance
commit           = plannable × recent say/do ratio    (median of last three sprints)
```

The focus factor is the share of a day that goes to sprint work after
reviews, meetings and support. Don't guess it: start from what the last
sprints actually delivered per member and adjust. For agent members,
`org_capacity` gives WIP limits and current load; the WIP limit caps how
many items can be in progress at once whatever the arithmetic says.

## Worked example (made-up figures)

Ten-day sprint, three members, estimates in ideal days.

| Member | Leave | On call | Available | Focus | Capacity |
|---|---|---|---|---|---|
| Software Engineer | 0 | 0 | 10 | 0.7 | 7.0 |
| QA Engineer | 2 | 0 | 8 | 0.7 | 5.6 |
| SRE | 0 | 5 | 5 | 0.6 | 3.0 |

Gross = 15.6. Buffer at 20% = 3.1. Debt allowance agreed at 2 days.
Plannable = 15.6 − 3.1 − 2 = 10.5. Say/do over the last three sprints was
70%, 85% and 80%; the median is 80%, so commit about 8.4 days of work and
list the next items as stretch.

## Writing the commitment

- One sprint goal sentence that a non-engineer understands ("Customers can
  export invoices as CSV").
- Committed items, each traced to a key result (`org_why`) with an owner
  and a testable done_when.
- Stretch items, clearly marked; they never count toward say/do.
- Known risks: dependencies on other units (with the handoff row), leave,
  anything not yet specified.

## Measuring it honestly

```text
say/do %         = committed items done ÷ committed items × 100
scope added      = items added after planning (count and why)
carry-over       = committed items not done, moved to next sprint
```

"Done" means accepted against done_when, not "code written". An item done
on the last afternoon but not reviewed is carry-over.

## Reading the numbers

- **Say/do consistently low**: the team over-commits, or briefs are
  unclear. Look at carry-over items: were they bigger than estimated, or
  blocked?
- **Say/do always at or near 100%**: possibly sandbagging. Fine if the
  sprint goal is ambitious enough; check that stretch items get done too.
- **Lots of scope added**: the buffer is too small or there's no intake
  rule. Decide who can add work mid-sprint and what comes out.
- **One member always overloaded**: rebalance or it's a staffing signal
  for team design (two sprints of WIP at the limit is the playbook's
  trigger).

## Common pitfalls

- **Planning to 100%.** Leaves no room for the bug that will come. Keep
  the buffer even when the backlog is urgent.
- **Changing the estimation unit.** The say/do history stops meaning
  anything.
- **Ignoring on-call.** On-call days are not sprint days.
- **Counting stretch work.** It inflates say/do and hides over-commitment.
- **Treating the commitment as a promise to the customer.** It's a
  forecast for the team; outward dates are a draft for a human, with the
  uncertainty stated.
