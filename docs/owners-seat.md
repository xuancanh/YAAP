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

## Inbox and notifications

The Inbox and the top bar's bell show one feed. `FeedService`
(`server/src/home/feed.service.ts`) builds it, and both read the same page,
so what they list and what they count cannot disagree.

### What was wrong (the audit, November 2026)

Before this change the Inbox and the bell were two lists. Each was built
from its own sources and counted in its own way.

- **Counts.** The Inbox's nav badge added up six client-side counters:
  pending approvals (`wsOrg.pendingApprovals`, which counted cards a manager
  still held), held keys, pending plans, open incidents, my open tasks,
  follows needing me and unread messages. The bell counted every unread
  inbox event of every agent in the workspace, plus Home's cards. On the
  dev data one company had 87 unread events. 62 of them were routine task
  runs (`org_run`) and agents' working notes (`info`), and 15 repeated a card
  that was already listed. So the badge said 3 and the bell said 99+.
- **In one and not the other.** Task @mentions (`task:<org>` events) and
  meeting reminders sent with no channel (`org:<org>` events) reached
  neither list. Approvals waiting on your connection (`approval_request`,
  which time out after ten minutes) were only in the agent's own inbox. My
  tasks, reviews and pending plans were in the Inbox but not the bell.
  Every agent `info` note was in the bell but not the Inbox.
- **Never shown anywhere.** Meetings started and ended, hires by heads,
  project seats waiting on a head, project breakers, the company archived,
  cards decided by the default or a delegate, cards that expired, failed task
  runs and failed checks, blocked tasks handed to someone to chase, goals at
  risk, plugin recalls and updates, and plugin updates waiting for review.
  All of these are recorded in the org or plugin audit logs, and nothing
  surfaced them.
- **Addressed to the wrong person.** `blocked`, `decision` and `escalation`
  events addressed to an agent's heartbeat (a manager's decision, a task
  waiting on an agent) appeared in the owner's bell.
- **Opening.** The bell opened events by the hash inside an absolute URL.
  The Inbox opened them through store actions. They disagreed for mentions
  and follows.

### The model

Each feed item has these fields:

- `type`, from the table below;
- `section`: `needs`, `mentions` or `updates`;
- `actionable`, which is true for Needs you;
- `read`;
- a one-line `title` and a `body`;
- `actor`: an agent with its avatar, a person, or the system;
- `company`;
- `context`: the task key, the project, the channel or the meeting;
- `at`;
- `severity`;
- `deadline` and `expiresSoon`;
- `actions` that can run in place;
- `target`, the place it opens.

`target` is structured (`task`, `chat`, `channel`, `meeting`, `agent`,
`project`, `pane`, `plugin`, `need`). The SPA opens it through its own
store actions and never builds a URL from it. The `link` kind exists only
for old events that carry nothing but a link.

**Resolution.** An item in Needs you stays until the record that owns it is
resolved: the card is decided, the task is done, the follow is seen, or the
plugin update is applied. Once resolved, it appears under **Done** (the
Inbox's History).

**Grouping.** Updates about the same thing collapse into one row, such as
"3 updates on ENG-12" or "Writer's runs failed 3 times". Marking that row
read marks every item in it read.

**Titles** (`server/src/home/feed-titles.ts`). A title is one short
sentence a person would write; the detail goes in the body. Names, keys and
amounts stay, and free text is clipped at a word boundary, never mid-word.

| Before | After |
|---|---|
| Content Marketer as Content Marketer (Content Marketer pack) | Head of Marketing wants to hire a Content Marketer |
| task "Landing page and qualified waitlist…": REJ-4 is built and unchanged since 17:54; what it waits on has moved from my manager to the own… | REJ-4 is stuck waiting on you (the whole reason is the body) |
| Burn rate projects $282.36 by month-end against a $200.00 envelope (141%) | Spending is on track to reach $282 against a $200 budget |
| 5 updates on Trạng Tí's runs | Trạng Tí's runs failed 5 times |
| 2 updates on REJ-17 (failed runs) | Runs on REJ-17 failed 2 times |
| Acme: company envelope at 85% | The company budget is 85% used |
| Acted (trust level 1, you hear after): http_request | Head of Engineering ran http_request on its own |
| Trust raised for internal write: level 2 → 3 | Trạng Tí's trust for internal write went up to level 3 |
| Daily brief: 3 decision(s) needed | Daily brief: 3 decisions needed |
| WEB used up its appetite — its tasks stopped taking claims | WEB used up its appetite |

A Needs-you card carries its `facts` (its payload's short fields: a hire's
role, name, pack, budget and who it reports to; an escalation's reason), so
the title and the reading pane can say what is asked without reading the
card again. A card kind the titles do not know keeps its own title.

**Counts.**

- The Inbox's nav badge and the Needs you tab count the open items in Needs
  you, whether you have read them or not.
- The bell counts unread rows in all three sections; the Mentions and
  Updates tabs count their own unread rows.

`GET …/status` and the workspace switcher return the same two numbers
(`needsYou`, `unread`).

**Read state.**

- An item backed by an event uses the event's own `agent_events.readAt`.
- Every other item uses a per-person `home.notifications:<ws>:<actor>`
  row, which holds the ids you have read and the time of your last **Mark
  all read**.

**Who gets what.**

- The owner gets the company-wide updates and the account's own events.
- A member of a shared workspace gets only what is addressed to them:
  their mentions, their tasks, and what they follow.
- Following is decided by the follow service's auto-follow
  (`docs/follows.md`).

**Switches.** Each update type can be turned off for the workspace with the
tunable `notify.<type>` (0 = off). The Inbox's **Customize** panel sets these
switches. `notify.groupAfter` (default 2) sets how many updates about one
thing it takes to collapse them into a row. These tunables are in the
owner's area (`seat`), so an agent can only propose changing them. Needs
you and mentions cannot be turned off.

### On screen

The Inbox (`src/components/InboxView.tsx`, `InboxDetail.tsx`, `FeedRow.tsx`)
is two-pane triage on a wide screen:

- **The list.** Each row is two quiet lines: the title, then who it is from,
  its kind and its context (task key, project, channel), with the time. An
  unread row has weight and a small dot; a near deadline is a soft badge
  ("3 h left", "Overdue"). Needs you puts what is urgent first (critical, or
  a default due within 6 hours, soonest first); Mentions and Updates group by
  Today, Yesterday and Earlier. Hovering or focusing a row shows its quick
  actions: mark read and open where it lives. Chips show only the kinds that
  have items; a kind's full queue (Approvals, Pending changes, My tasks) is
  one click from its chip.
- **The reading pane.** The whole item: who asked and when, the title, what
  is being asked in plain words, the deadline and what happens if you do
  nothing, the why, the card's facts, the route it climbed with each
  recommendation, the recommendation, the context (the task opens), then the
  actions. A decision can carry a note. An escalation is a question: an
  answer box sends the answer to the task as your decision and unblocks it
  ("Answer and unblock"); "Cancel the task" asks to confirm. With nothing
  open, the first row is previewed (not marked read).
- **The address.** The open item is in it:
  `/<company>/inbox/<filter>/<item>` (docs/routes.md), so it can be shared.
  Opening an item reads it.
- **The header.** The counts sit on the tabs. The ⋯ menu holds Mark this tab
  read, Mark everything read, Choose which updates arrive (Customize) and the
  keyboard shortcuts.
- **Keyboard.** j/k or ↑/↓ move (on a wide screen the pane follows), Enter
  opens in the pane, o opens where it lives, m marks read, e marks read and
  moves on, Esc closes the pane. a and r approve and reject only while an
  item is open in the pane, never from the list, and never an escalation
  (it is answered in its box).
- **A phone** (or a narrow Inbox) shows the list; an item opens full screen
  with Back.
- **Empty and done.** An empty Needs you says "You're clear" and points to
  what is unread elsewhere. Done lists what used to wait on you as quiet
  rows.

The bell is a compact list of the same rows. Only its top one or two
actionable rows keep their buttons (an escalation never: it is answered in
the Inbox). A row opens the item in the Inbox's reading pane; the footer
opens the Inbox. Without a company there is no Inbox, so a row opens where
it lives.

### The types

| Type | Section | Source | Opens |
|---|---|---|---|
| decision, escalation, key, pending_change, incident, signal, queued_action | Needs you | Home's Needs-you cards (`HomeService.glance`) | the card's queue, the task, the incident, the agent |
| connection_approval **(new)** | Needs you | `approval_request` events addressed to you, within their 10-minute TTL; Allow / Deny in place | the chat |
| task_assigned, task_review | Needs you | org tasks assigned to you or waiting for your review | the task |
| blocked_on_you **(new)** | Needs you | a task blocked on you (`blockedOn` person) | the task |
| follow_attention | Needs you | a follow of yours whose last change needs you | the task or the thread |
| plugin_review **(new)** | Needs you | a plugin update that widens access, waiting (`plugin_installs.pendingVersionId`) | Foundry |
| message | Mentions | `agent_message` (`message_owner`) | the direct chat |
| mention | Mentions | channel and thread @mentions; task @mentions **(new: `task:<org>` events)** | the channel message or the task |
| follow | Updates | the first change since you last looked at what you follow | the task, the thread or the discussion |
| channel_activity **(new)** | Updates | messages in channels you set to notify on everything | the channel |
| run_failed | Updates | `loop_error`, `action_failed`; failed or looping task runs (`run_end`), failed checks **(new)** | the chat or the task |
| budget | Updates | `budget_warn` **(new)**, `budget_stop` | Spend or the task |
| meeting **(new)** | Updates | about to start (also `org:<org>` events), started (`meeting_start`), ended with its minutes | the meeting |
| brief **(new)** | Updates | the chief of staff's daily brief | the Brief |
| audit **(new)** | Updates | assurance audits (`org_audit`, red team), spot checks | Audit |
| experiment **(new)** | Updates | experiments started, extended and decided | the chief |
| trust **(new)** | Updates | trust raised or lowered | the agent |
| decided_without_you **(new)** | Updates | cards decided by the default (`approval_default`) or a delegate (`delegated_decision`), and cards that expired (`approval_expired`) | Done |
| hire **(new)** | Updates | a head or the chief hired an agent (`member_add`, not by you) | the agent |
| project_team **(new)** | Updates | a seat proposed and waiting on a head, or a seat filled | the project |
| project **(new)** | Updates | a project breaker (appetite used up), a project finished | the project |
| blocked **(new)** | Updates | a blocked task handed to a lead to chase (`blocked_owner_assigned`) | the task |
| goal_at_risk **(new)** | Updates | a goal or key result that went at risk | Goals |
| plugin **(new)** | Updates | a version recalled by its publisher, an update applied (Foundry) | Foundry |
| company **(new)** | Updates | the company archived (not by you) | the Inbox |
| agent_note **(new)** | Updates | `info` events that an emitter tags `feed: 'agent_note'`: acted at trust level 1, a lesson to review, a model switched | the chat or the agent |

**Left out on purpose:**

- routine runs (`loop_run`, `org_run`);
- untagged `info` notes, which are the agent's own log and stay on its page;
- events addressed to an agent's heartbeat (`blocked`, `decision`,
  `escalation`, `next_work`);
- events that repeat a card already listed (`decision`, `action_key`,
  `action_pending`, `org_plan`, `org_incident`, `org_signal`, `org_task`,
  `org_review`);
- what you did yourself.

### The requests

| Request | Returns |
|---|---|
| `GET /api/workspaces/:id/feed?limit=` | `FeedPage { items, counts: { needsYou, urgent, unread, sections }, company, unread }`. Needs you comes first, ranked; the rest is newest first. The counts cover everything, whatever the limit |
| `POST /api/workspaces/:id/feed/read` | `{ ids }` (a row's `ids` or a `group:` id), `{ section }` or `{ all: true }` |
| `GET /api/workspaces/:id/feed/types` | the update types with their switch (`notify.<type>`) and whether they are on |
| `GET /api/workspaces/:id/notifications`, `POST …/notifications/read` | the same page and the same marks (older callers) |

**Deferred.**

- A row per rerun from the Work log (`docs/work-log.md`). A rerun that
  fails again already arrives as `run_failed`.
- Per-person switches. The switches are per workspace for now.
- Push channels (Telegram, email, web push) still send the events they
  sent before. The feed's switches do not mute them yet.
- Snooze, mark unread and a reply box for messages in the reading pane
  (a message opens its chat to reply).
- Done's rows keep the history service's own titles.

## Archive or delete the company

A company ends the way it started: by the owner, on purpose, and
reversibly first. Code: `server/src/org/org-lifecycle.service.ts`
(`OrgLifecycleService`), the read-only guard `archived-org.guard.ts`, the
SPA's Danger zone `src/components/OrgDangerZone.tsx` (Settings → Workspace
→ Organization). Migration `0085-org-archive` adds `organizations.archivedAt`,
`archivedBy` and `archiveState`. Owner only: the routes are in the
owner-only table (`workspace-access.guard.ts`) and the service refuses a
member or viewer too.

### Archive (reversible, the default)

`POST /api/workspaces/:id/org/archive`. It does what the kill switch does —
queued wakes, structure reviews, planning passes and re-wakes are dropped,
in-flight runs aborted — and then puts the company away:

- `organizations.status = 'archived'` with when and who. Every tick skips
  an archived org (briefs, approval expiry and decision deadlines, signals,
  rituals and meetings, sensing, experiments, the auditor), and
  `OrgService.byWorkspace` does not return it, so Company, Inbox and Home
  fall back to the non-company views and the workspace's mode is `off`.
- Its members' seats are **suspended, not deleted**: `membershipsOf` leaves
  archived orgs out, so the agents stay in the workspace as plain agents —
  no org tools, no org prompt, no org heartbeat work, and a paused seat no
  longer holds their own heartbeat.
- Its unit channels are archived (read-only); `#company` stays for the
  workspace. The `/org/` indexes and mirrors stop being written.
- Nothing is deleted. `GET …/org/archived` lists archived companies (also
  under `archived` in `GET …/org`), `GET …/org/archived/:orgId` is the
  read-only view (members, goals, projects, units, latest decisions, the
  audit tail, row counts), and `/api/orgs/:id/…` answers reads but refuses
  writes. The archive dialog offers **Export COMPANY.json first**.

`archiveState` remembers what **Restore** (`POST …/org/restore { orgId? }`)
puts back: the org's status (a company paused before the archive comes
back paused), the workspace's mode, chief and envelope, and the channels
the archive closed. Restore is refused while the workspace has another live
company — archive that one first. A new company can be started in the
workspace while one is archived (the onboarding wizard, or turning the mode
on); a workspace holds any number of archived companies and one live one.

### Delete permanently

`DELETE /api/workspaces/:id/org { orgId?, confirmName, agents?, files?,
channels? }` — only from the archived state, and only with the company's
name typed back. The dialog says what is removed and what is kept and offers
**Export COMPANY.json first** (`GET …/org/archived/:orgId/blueprint`). The
choices:

| Choice | Default | Other options |
|---|---|---|
| `agents` — the agents that were members | `keep`: plain agents in the workspace | `delete` (an agent seated in another live company is kept) |
| `files` — everything under `/org/` | `keep`: moved to `/archive/org-<slug>-<archive day>/` (`WorkspaceFs.move`) | `delete`. Neither touches `/org/` when a new company is live: the folder is its now |
| `channels` — the unit channels | `archive` (read-only, messages kept) | `keep` (reopened as ordinary channels), `delete` (with messages, members and read marks). `#general` and `#company` never go |

Then one transaction removes every org-scoped row: each table with an
`orgId` column, in `ORG_TABLE_PLAN` order (children first), and the rows
that hang off the org without one — metric samples (the metric sources
carry the org's only stored secrets), follows of its tasks, its boards'
task key counters, plugin bindings scoped to its units and projects
(`interface_bindings`); chats and channel messages linked to its tasks keep
their content and lose the link; a registry install or an action-log entry
only points at the org, so its `orgId` is cleared. The organization row
goes last. Nothing outside the org is touched: personal chats, other
agents, other workspaces and their companies.

The org's own audit chain goes with it; the final `org_deleted` entry —
the name, the row counts and the choices — lands on the workspace's audit
chain (`plugin_audit`, `GET /api/workspaces/:id/plugins/audit`).

The delete is safe to interrupt: the attempt is recorded in `archiveState`
(restore is refused meanwhile), every side effect is idempotent (channels,
files, agents), the rows go in one transaction, and a retry redoes only
what is left. A retry after success answers `alreadyDeleted: true`. A
table added later with an `orgId` column is still swept by the delete, and
`tests/backend-org-lifecycle.test.ts` fails until it is named in
`ORG_TABLE_PLAN`. `DELETE /api/orgs/:id` no longer deletes: it points here.
