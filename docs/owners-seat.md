# The owner's seat: exceptions, not approvals

*Execution-plan item 31; capability C12 in
`docs/autonomous-org-first-principles.md` (with C4's deadlines). Shipped
2 November 2026. It extends `docs/company-vision.md` §8.*

The test from the first principles: does a capability let the owner look
away for longer, and come back to fewer, better decisions? This item makes
four changes so that it does:

- a card says what happens if the owner says nothing;
- routine kinds of cards can be decided by someone else;
- the brief opens with what moved in the world;
- a unit that moves nothing is told to shrink.

None of the four calls a model, except an agent delegate's judgment.

Code:

- `server/src/org/decision-cards.ts` — the decision-card defaults
- `server/src/org/org-seat.service.ts` — `OrgSeatService`
- `server/src/org/governance-tunables.ts` — area `seat`

Tables (migration `0044-org-evals-boundary`):

- new columns on `org_approvals`
- `org_delegations`
- `org_value_events`
- `org_goals.valuePerUnit`, `valueOnAchieve`, `valueNote`

## 1. Decision cards

Every approval carries these fields:

| Field | Source |
|---|---|
| `recommendedAction` (approve, deny or modify) and `recommendation` (one line) | the proposer |
| `alternatives[]` | the proposer, or computed for the kind |
| `reversibility` (reversible, costly or irreversible) | the action class for a held action (`two_key`), else the kind |
| `confidence` (0–1) | the proposer, or `seat.defaultConfidence` |
| `deadline` | `seat.deadlineHours` after creation (default 48; always before the 72 h expiry) |
| `defaultAction` (approve or deny) | computed, see below |

Agent tools that can produce a card take `recommend`, `alternatives` and
`confidence`, and the schemas mark the first two required. These tools are
`org_hire_agent`, `org_set_scope`, `org_terminate_agent`, `org_reorg`,
`org_propose_strategy`, `org_allocate_budget`, `org_set_routing` and
`org_tune`.

Cards written by another path without these fields, such as an escalation
or a human review, get computed fields on the next tick
(`OrgApprovalsService.fillCard`).

**The default action is deny unless all of the following hold:**

- the card is reversible;
- it spends no money;
- the boundary did not route it (`docs/boundary.md`);
- its kind's `seat.defaultApprove.<kind>` is 1.

Approve is the default only for `tune`, `cadence` and `routing`. There is
no switch at all for irreversible or money kinds. The tick re-checks this
floor at the deadline, so an irreversible or money card is denied even if
something stored `approve` on it.

At the deadline the minute tick (`OrgSeatService.applyDefaults`) does four
things:

- decides the card through the normal `decide` path, with `decidedVia:
  default`;
- writes an `approval_default` audit row;
- sends the owner an inbox line ("Approved by default at your deadline: …");
- lists the card in the brief's **Decided for you**.

The brief's numbered decisions show each card's recommendation,
reversibility, confidence and "if unanswered by …: <default>".

## 2. Delegated approvals

`org_delegations` rows, written by the CEO only (`POST …/org/delegations`):

```
{ kind, maxUsd?, delegateType: human | role, delegateRef }
```

`kind` is an approval kind, or an action class: `money` covers any card
that spends money, and a class covers `two_key` cards of that class. A card
is covered when:

- its kind or class matches;
- its amount is known and at most `maxUsd`;
- its boundary row is `delegable`.

A **human** delegate is a member with standing (CEO, board or employee). The
decide route (`POST …/approvals/:id/decide`) accepts that person's decision
on a covered card. It is recorded with `decidedVia: delegate:human:<id>` and
a `delegated_decision` audit row.

A **role** delegate (for example `controller`) is the active member whose
title matches. It decides a covered card when the card is created, through
a tool-free judgment on another model family than the proposer's
(`OrgRuntimeService.judge`, like the co-signer). The judgment is framed by
the delegate's charter and the company's rules:

- allow approves;
- deny rejects;
- ask leaves the card to the CEO.

A proposer never decides its own card. Every delegated review and decision
is audited, and listed in the brief's **Decided for you**.

**Never delegable:**

- the constitution;
- caps;
- the kill switch;
- the external floor;
- trust ceilings;
- audit settings;
- delegation itself;
- metric sources (they define truth);
- any card whose boundary row says `delegable: false`, for example a tune
  card on `actions.*`, `trust.*` or `seat.*`.

Creating a delegation is refused for any of these.

## 3. The brief, in order

1. **Outcomes.** For each active objective: the measured movement of its key
   results this week, and the value realised against spend this month (ROI).
2. **Exceptions.** Incidents and degraded systems, key results at risk,
   cost per outcome, plans awaiting veto, anomalies, signals, the audit and
   questions from meetings.
3. **Decisions.** The numbered cards, then *Decided for you*.
4. **Improve.** Item 30's experiments, calibration and reconciliation.
5. **Activity.** Spend, work since the last brief, autonomous actions and
   the pulse.

`BriefSection.position` is `outcomes`, `first`, `decisions`, `improve` or
`end`.

## 4. Value accounting

The CEO says what an outcome is worth, with `PUT
…/org/goals/:goalId/value {valuePerUnit?, valueOnAchieve?, valueNote?}`.
For example, "each new subscriber is worth $0.50". Agents cannot set it.

For a key result bound to a metric source, `syncValue` turns each metric
sample after the start value into an `org_value_events` row. The row holds
the movement toward the target, signed, times `valuePerUnit`. Reaching the
target adds a one-time `achieved` row worth `valueOnAchieve`. The sync is
idempotent per sample.

`GET …/org/outcomes` and the brief's Outcomes section read these rows.
`GET …/org/value-events` lists them.

## 5. Outcome or shrink (principle 6)

Every 5 minutes `sweepNoOutcome` looks for a unit whose active objectives
are older than `seat.noOutcomeWeeks` (default 4) and showed no measured
key-result movement toward target in that window. Such a unit gets a
`no_outcome` signal for the chief. The chief's next planning prompt gets an
"Outcome or shrink" block: shrink the unit's envelope or headcount through
an experiment or a proposal, with the metric the change should move. The
system makes no automatic cut. Movement resolves the signal.

## 6. Departures

- **Agent decisions.** An agent role decides a delegated card once, when the
  card is created. A card that was answered "ask" waits for a human.
- **Brief headings.** The "activity counts" are the existing Spend, Work,
  Autonomous actions and Pulse sections, moved under a `# Activity` heading.
