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

## 7. Decisions go to the direct manager first

*Added 3 November 2026.* The owner: "by default a decision should go to the
direct manager, not to the CEO. The manager then decides whether it needs to
go further."

Code:

- `server/src/org/decision-routing.ts` — the pure half: `managerOf`,
  `routeDecision`, `reservedOf`, the authority table and `authorityFor`.
- `server/src/org/org-decisions.service.ts` — `OrgDecisionsService`. It
  places new cards, moves them, times hops out and feeds the managers'
  heartbeats. Other modules ask it "who does this wait on" with
  `routeDecision(orgId, fromAgentId, kind)`; the work tracking uses it for
  blocked-on-manager.
- Migration `0070-decision-routing`:
  - `org_approvals`: `holder`, `holderSince`, `hopDeadline`, `chain`,
    `reserved`, `urgency`;
  - `org_members`: `reportsToHumanId`.

### The route

Every card an org member raises goes first to its **direct manager**:

| Raised by | Goes to |
|---|---|
| a specialist | its head (its `reportsTo` member) |
| a head | the chief of staff |
| the chief of staff | the CEO |
| a member with `reportsToHumanId` | that person (an org human with standing), through their Inbox |
| the owner, the system, an experiment | the CEO, as before |

Three kinds of card are routed:

- approval cards (`OrgApprovalsService.create`);
- escalation cards (`OrgTasksService.escalate`). A head's
  `org_escalate to: "ceo"` and a review's round cap both reach this;
- the `two_key` card of a held or staged outward action in an unattended
  run.

A few rules hold on every route:

- A paused manager is skipped.
- A person escalates to the member they report to, else to the CEO.
- A card never goes to the member who raised it.
- A human review card stays with the person it names.

The specialist → head escalation of a *task* has not changed. It is still an
`Escalation:` task on the head's board (decision 4 of
`docs/autonomous-skills-review.md`). This section routes cards only.

The holder can do one of three things:

- **decide** (approve or reject) when the card is within its authority;
- **send back** to the requester with guidance. The card becomes
  `revision_requested`, and the guidance goes to the requester's inbox and
  the task's timeline;
- **escalate** one level with a recommendation (approve, deny or modify)
  and its reasoning. Both travel with the card.

Agents act with two tools:

- `org_decision_queue` lists the cards, with the chain and the holder's
  authority;
- `org_decide { approvalId, action, recommend?, reasoning? }` acts on one.

A manager agent sees its cards in four places:

- its heartbeat, as one reason per card;
- its heartbeat's "Decisions for you" context block, with every
  recommendation so far;
- its inbox;
- its agent page.

A person sees theirs in the Inbox, with Approve, Reject, Send back and
Escalate. `POST …/approvals/:id/decide` takes `decision: send_back |
escalate` and a `recommendation`.

### The authority table

A manager may decide a card on its own only when all of these hold:

- it did not raise the card itself;
- the card is not CEO-reserved (see below);
- its trust on internal writes is 2 or more (agents only);
- every member the card touches is in its reporting line.

The table per kind is also served at `GET …/org/decisions/authority`:

| Kind | A manager may decide | When |
|---|---|---|
| escalation | yes | a task in its reporting line: continue (unblock with guidance) or cancel; any mode |
| member_settings | if | autonomous; the identity, model (after the eval gate) or heartbeat of a member in its line; never a folder |
| hire | if | autonomous; the hire lands in its line; its budget fits the manager's unit headroom |
| scope_widen | if | autonomous; every scope is within the manager's own holdings |
| reorg | if | autonomous; every member it touches is in its line |
| terminate | if | autonomous; the member leads nobody |
| budget_raise | if | autonomous; an agent or project envelope in its line, within its unit headroom |
| cadence | if | autonomous; a ritual of a unit it leads |
| tune, routing, strategy, external, two_key, metric_source, experiment, charter_change, blueprint, human_review | no | recommend and escalate |

*Unit headroom* is the money a manager may still commit:

- for the chief: the company envelope, less the agent and project
  envelopes;
- for a unit lead: the allocations to its unit's objectives, less the agent
  envelopes its line holds;
- for anyone else: none, so money climbs.

Three more rules:

- In a supervised company, structural changes stay with the CEO; a manager
  only recommends.
- A person who manages is not bound by the mode or by trust, but money
  still climbs.
- If the owner delegated a kind to the manager's role (§2), the manager may
  decide a delegable card of that kind.

**Same model.** A manager agent may approve a card raised by an agent on its
own model family (`familyOf`). That hop is flagged `sameModel`. Where the
co-signer rule applies (money), the approval first needs an independent yes
from a reviewer on another family (`OrgRuntimeService.judge`). Without that
yes, the card goes up with the manager's recommendation instead. The review
is audited as `decision_independent_review`.

### CEO-reserved

`reservedOf` names what only the CEO decides. These cards still pass
through every manager first, to collect recommendations, but no manager may
approve or reject them:

- a held outward action (`two_key`): it needs the owner's key, or the
  co-signer rules. A manager cannot send it back either;
- an external commitment;
- strategy and values;
- a blueprint;
- a metric source;
- a policy change: an experiment or a charter change;
- a company-wide setting (`tune`, `routing`);
- money beyond the company envelope (`budget_raise` of the company);
- a change the boundary routed to the owner (`boundary: propose |
  experiment` on the card);
- an escalation raised `to: "ceo"`;
- anything irreversible.

### Nothing stalls

Each hop has a window:

| Tunable | Card | Default | Bound |
|---|---|---|---|
| `seat.hopTimeoutHours` | normal | 12 h | 1–48 |
| `seat.urgentHopTimeoutHours` | urgent | 2 h | 0.25–12 |

Held outward actions are urgent, and `org_escalate` takes `urgency`.
Onboarding derives both windows from the profile:

| Profile | Normal | Urgent |
|---|---|---|
| speed is a value | 4 h | 1 h |
| a control or rigour culture | 24 h | 4 h |
| an early company | 8 h | 2 h |
| otherwise | 12 h | 2 h |

Both keys sit under `seat.*`, so an agent can only propose a change. When a
window ends, the minute tick moves the card one level up with "no
recommendation (timed out)".

While a manager holds a card, the card does not expire and its default
does not apply. When it reaches the CEO:

- its deadline (§1) starts afresh at `seat.deadlineHours`, and its expiry
  moves past it;
- the chief's inbox line and the owner's channels announce it;
- role delegations (§2) review it.

### What the CEO sees

Only what waits on them. Home's Needs you, the brief's decisions, the Inbox
and its badge count only cards held by `ceo`.

- Each card shows the route it climbed, such as "Writer → Head of Content →
  Chief → you". Each manager's recommendation and reasoning are listed, or
  "did not answer in time".
- The Approvals header counts what is still in review by your managers.
- The owner may still decide any card at any level from Approvals.
- A blocked task names the manager it waits on (`escalated to <manager>:
  …`) and updates as the card climbs.

### Audit

Every hop is written twice: on the card (`chain`), and as a `decision_hop`
row in the hash-chained audit with its recommendation and reasoning. The
hops are raised, escalated, timed_out, sent_back and decided.

A manager's decision is recorded as `decidedVia: manager:<agent:id|human:id>`.
It applies as that agent, so the boundary's fence still binds it.

### Budget stops

A member that hits its budget stop still opens an incident for the owner.
Its manager also gets an inbox line asking it to do one of three things:

- raise the member's envelope within the unit;
- pause the member;
- escalate.

## Home

The owner meets these cards first on Home (`docs/home.md`): each decision
card shows its recommendation, reversibility, confidence and what happens
at its deadline if nobody answers, and can be decided there.
