# The company that runs itself: a vision for yaam-chat

*Status: proposal, 1 November 2026. Builds on `docs/autonomous-company.md`
(the research and the shipped foundation), `docs/group-chat.md` §5–§7
(organization mode, channels, units) and `docs/execution-plan.md` items
1–17. Nothing here is built yet; §9 turns it into an execution plan.*

## 0. The one-sentence version

Today yaam-chat is a chat app whose agents can be arranged into a company.
The next version inverts that: **the company is the product, and chat is
one of the ways you talk to it.** A person writes a paragraph of intent and
a budget, and a durable organisation of agents turns that into a strategy,
a structure, a cadence of work, a stream of verified results, and a daily
conversation with its CEO. It keeps running when the tab is closed, learns
from its own record, and can be exported, cloned and shared like a product.

The guiding analogy is not "a chatbot with tools" but a **well-run small
company**: clear intent flowing down, honest status flowing up, meetings
that end in decisions, a controller who counts the money, an auditor who
checks the books, and a boss who reads one page a day.

## 1. Eight primitives

Everything the company does is expressible with eight nouns. Items 1–17
built most of the storage for them; the vision is the behaviour that links
them.

| Primitive | What it is | Today | Where it goes |
|---|---|---|---|
| **Intent** | Vision → objectives → key results → tasks; every task answers "why" by walking up the tree. | Goals with progress from linked tasks. | Measurable key results, owners, due dates, confidence check-ins, at-risk detection, cascade into units. |
| **Structure** | Units, roles, charters, reporting lines. | Chart with depth/fan-out caps; units per lead. | Role catalog with competency profiles; charters versioned and diffed; succession; "org debt" detection. |
| **Work** | Tasks with four-field briefs, review, acceptance. | Board per unit, claims, review rounds, breakers. | Projects with milestones; task classes routed to models by class; cycle time and acceptance rate as company SLOs. |
| **Conversation** | Channels, threads, DMs, meetings. | Channels per unit, mentions, relevance wake. | Meetings as bounded rituals that end in minutes, decisions and actions. |
| **Memory** | Files, lessons, decisions, playbooks. | Shared files per channel, lessons with audiences, skills. | A decision log with rationale; playbooks agents write and follow; postmortems that revise charters and skills. |
| **Capital** | Envelopes, reservations, spend. | Nested USD envelopes, reserve-before-call, breakers. | Allocation by expected value; cost per accepted outcome; forecasts; model routing as a cost lever. |
| **Trust** | Scopes, approvals, audit, disclosure. | Meet rule, Ask/Auto, hash-chained audit, external floor. | A per-company constitution; an independent auditor role; plan preview before autonomous execution. |
| **Time** | Cadences, triggers, quiet hours. | Minute tick, daily brief, board-event chief review. | Rituals per unit (standup, weekly review, retro, board meeting); time-boxed sprints; deadlines that escalate. |

## 1b. Everything adapts: the operating profile

No mechanism in this document is a fixed rule. Each is a **tunable with a
default and a bound**, and the company adjusts it to its own values,
culture, vision and goals. The workspace carries an **operating profile**:
its values (what it optimises for and what it refuses), its culture (how
it communicates: terse or discursive, how often it meets, how much it
reviews, how much autonomy a member gets), its vision and current goals.
The profile is written by the CEO in plain language, revised by the chief
through proposals, and read by every prompt that plans, meets, monitors or
wakes.

Concretely:

- **Rituals** take their cadence, length, attendees and format from the
  profile. A two-agent newsletter company may hold no standup and one weekly
  review; a research lab may hold a daily seminar. The chief proposes
  cadence changes with a reason; they apply within bounds (never more than
  N meetings a day, never outside quiet hours).
- **Thresholds** (stale, at-risk pace, confidence drops, burn warnings,
  SLO targets) are per-org settings the chief tunes to the work: a slow
  research objective and a daily publishing objective should not share a
  48-hour cycle-time target.
- **Heartbeat** cadence and gate rules follow the culture: a reactive
  support agent beats often; an archivist beats daily.
- **Roles and charters** are drawn from the catalog and reshaped to the
  vision; the catalog is a starting point, not a taxonomy.
- **The brief** says what this CEO cares about, in the order they care, in
  the tone of the culture.
- **Planning depth, review strictness and autonomy** flex with the goals:
  a launch week can ask for daily replans and two reviewers; a quiet month
  can run on weekly check-ins.

What does **not** adapt is the safety floor: depth and fan-out caps, the
meet rule, the kill switch, the external floor, the audit chain, and the
bounds on every tunable. Culture chooses within the fence; it never moves
it. Every change to the profile or a tunable is a decision-log entry, so
the company can see how it changed itself and why.

The chief of staff turns the profile into the company's operating system
— cadence, goal count, decision protocol, timers, the archetype it plays —
and keeps the ledger under `/org/`: `docs/chief-of-staff.md`.

## 2. The intent cascade (the example, generalised)

The CEO writes a **vision**: one paragraph, a horizon, a budget, and the
rules that must never be broken. Everything below is derived from it and
stays linked to it.

1. **Strategy.** The chief of staff runs a *planning session*: it reads the
   vision, the current chart, the catalog of hireable roles and the
   envelope, and produces a strategy proposal: company objectives, each
   with two or three **key results** (a metric, a target, a due date, an
   owner), the structural changes needed (hire, reorg, retire), the budget
   split per unit, the first tasks, the risks, and the questions only the
   CEO can answer. Supervised mode: one approval card with the whole plan
   as a diff. Autonomous mode: executed within caps, with a memo to the CEO
   and a veto window before anything outward happens.
2. **Cascade.** Each objective is handed to a unit. The unit lead runs its
   own planning session, scoped to its reports and its envelope, and
   returns unit key results and tasks. Depth is bounded by the chart (≤ 3),
   so the cascade is at most three sessions deep and finishes in minutes.
3. **Check-ins.** Every key result has an owner who updates *current value*
   and *confidence* on a cadence (weekly by default) with one tool call.
   Progress is therefore partly measured (linked tasks) and partly judged
   (owner confidence), and the two are shown side by side so the CEO can
   see when they disagree.
4. **Re-planning.** A key result that falls behind its linear pace, loses
   its owner, or has its confidence drop twice in a row becomes *at risk*.
   At-risk key results wake the unit lead for a replan; two at-risk key
   results under one objective wake the chief; an objective at risk lands
   on the CEO's brief as a decision ("cut scope, add budget, or accept").
5. **Why chain.** Any task, message or file can show its chain:
   task → key result → objective → vision. A task whose chain is broken
   (its goal was abandoned) is flagged, not silently worked.

The same machinery serves a one-line request. "Ship a newsletter by
Friday" is a vision with a short horizon; the cascade is one session deep.

## 3. Rituals: meetings that end in decisions

Agents already talk in channels. A **meeting** is a channel thread with a
facilitator, an agenda, a round cap, a budget and a required output: the
*minutes*. Minutes are structured (decisions, actions, risks, questions for
the CEO), posted and pinned in the channel, hash-chained into the audit log,
and executed: each action becomes a task, each decision a decision-log
entry, each question a brief item.

| Ritual | Default cadence | Facilitator | Attendees | Output |
|---|---|---|---|---|
| Planning | on new vision or objective; start of a sprint | chief or unit lead | the unit | key results, tasks, hires |
| Standup | daily, in the unit channel | unit lead | the unit | one line per member: done / next / blocked; blocked items get owners |
| Weekly review | weekly | unit lead | the unit | key result check-ins, at-risk calls, replans |
| Retro | end of sprint | unit lead | the unit | lessons, charter and skill revisions, playbook updates |
| Board meeting | weekly | chief | CEO, board humans, unit leads | the strategy memo, spend vs plan, decisions |
| Ad hoc | on demand (`/meeting`) | whoever calls it | named | minutes |

Rules that keep this cheap and safe: at most three rounds; one turn per
attendee per round; a per-meeting USD cap and a per-unit daily meeting cap;
standups are composed from the board without a model and members only add
what the board cannot know; a human message in the thread is injected into
the next round; the CEO can end any meeting with one word; quiet hours
postpone rituals.

## 4. Self-organising structure

The chief already hires, reorganises and retires within caps. The vision
adds *judgement about structure*:

- **A role catalog** with competency profiles (what a Researcher, an
  Editor, a Controller, an Auditor is good at, which tools and model class
  each needs, what it costs per month). Hiring is choosing a role for an
  objective, not inventing a charter from scratch.
- **Org debt detection**, model-free: idle members, overloaded members,
  duplicate roles, a lead with one report, an objective with no owning
  unit, a unit with no key result. Each is a signal that wakes the chief
  with the structure review it already runs.
- **Charters as versioned documents** with diffs, approval on change, and
  drift detection (shipped) extended to "the member's recent work does not
  match its charter" as a flag for the auditor.
- **Succession.** When a lead is paused or terminated, its unit gets an
  acting lead chosen by the chief within the same session, so no unit is
  headless for longer than a wake.
- **Hybrid staff.** Humans can hold roles too: a board member who approves,
  a human employee who is assigned tasks and posts status like any member.
  The chart and the channels do not care which kind of member a node is.

## 5. Monitoring and assurance

Autonomy is only acceptable with independent observation. Three layers,
two of them with no model in the loop:

1. **Signals** (no model). Every minute tick computes: stale tasks, blocked
   tasks without an owner, review queue age, key results off pace, burn
   rate versus envelope, breaker trips, charter drift, org debt. Signals
   are deduplicated per day, stored, and wake the right person: the task
   owner, the unit lead, the chief, or the CEO.
2. **Company SLOs** (no model). Cycle time per task class, acceptance rate
   at first review, cost per accepted task, percentage of key results on
   pace, decision latency (how long CEO cards wait). Shown as a **pulse**
   with a 30-day trend. An SLO breach is a signal.
3. **The auditor** (a model, but a different family from the workers). A
   standing role with read-only tools that samples accepted tasks and
   checks them against their done-when rubric, re-reads scope-widening and
   spend audit rows, and looks for work that drifted from its charter. Its
   report goes to `#company` and to the brief; its findings are signals.
   The reviewer layer (item 2) checks individual actions; the auditor
   checks the pattern.

## 6. Memory and learning

A company that cannot remember why it did things repeats its mistakes.

- **Decision log.** Every decision (from minutes, approvals, or the chief's
  autonomous actions) is a record with the decision, the alternatives
  considered, the rationale, who decided, and a link to what it changed.
  Searchable; linkable from any message as `#decision:<id>`.
- **Playbooks.** Repeatable procedures the company discovers ("how we
  publish an issue") are written as skills by the agents that do them,
  reviewed like any task, versioned, and offered to the right roles. Skill
  outcome tracking (item 11) tells the retro which playbooks work.
- **Postmortems.** A failed or escalated objective triggers a retro whose
  output is a lesson with an audience, a proposed charter diff, a proposed
  playbook change. The CEO approves charter changes; the rest is the
  company improving itself.
- **Company knowledge.** Files, decisions, goals, tasks and messages form
  one graph. "What did we decide about pricing and what happened after"
  is a question the chief can answer by walking it, not by guessing.

## 7. Capital

Money is the control surface the CEO understands best.

- **Allocation by expected value.** The strategy proposal states, per
  unit, what the envelope buys (which key results) so a budget cut is a
  scope decision, not a number.
- **Cost per outcome.** Spend is attributed to tasks, key results and
  objectives, so the brief can say "objective A has consumed 40% of its
  envelope for 20% of its key results".
- **Model routing as a lever.** Task classes (triage, research, synthesis,
  review) map to model tiers; the chief can trade quality for cost per
  class inside its caps, and the pulse shows the effect.
- **Forecasts.** Burn rate projects the month-end against the envelope;
  the projection, not the balance, is what warns.

## 8. The CEO's seat

The CEO should spend ten minutes a day and feel in control.

- **The vision page.** Write it, revise it, see the strategy derived from
  it as a tree, see what changed since last week.
- **The pulse.** Signals, SLOs, key results on pace, spend versus plan, the
  meeting calendar, the decision queue, all on one screen and in one push
  notification a day.
- **Decision cards** stay the only place authority widens or money moves.
  The daily brief numbers them; the CEO answers in one reply, by voice if
  they like.
- **Ask the company.** A chat with the chief that answers from the record
  ("who is working on X, why is Y late, what did Z cost") with citations
  into tasks, decisions and messages. (Since 2 November 2026 this is an
  ordinary chat with the chief; the separate Ask pane is gone.)
- **Preview.** In autonomous mode the chief shows its plan as a diff
  (hires, moves, budgets, first tasks) and a cost estimate before the veto
  window closes. The CEO can also ask "what would you do with twice the
  budget" and get a plan that is not executed.
- **Replay.** Any day can be replayed from the audit chain: what woke,
  what was decided, what it cost.
- **Exceptions, not approvals** (item 31, `docs/owners-seat.md`). Every
  card says what the proposer recommends, the alternatives, how reversible
  it is, how confident they are, and what happens at its deadline if the
  CEO says nothing. Silence approves only reversible internal changes, and
  only where the CEO allowed it. Kinds of cards can be delegated to a
  person or an agent role (for example "money under $20: the controller").
  The brief opens with outcomes measured in the world and the value they
  realised against spend. A unit that moves nothing for weeks is told to
  shrink, through an experiment or a proposal. What the company may change
  about itself is one table (`docs/boundary.md`), and every change that
  rolls out to how a member works is first replayed against that role's
  golden set (`docs/evals.md`).

**On screen (simplified 2 November 2026).** The main menu is Home · Chat ·
**Inbox** · **Company** · **Artifacts** · Apps · Market (+ Settings); Inbox
and Company show only in organization mode.

- **Inbox** — everything waiting on the CEO in one list with filters:
  decision cards, actions waiting for the owner's key, escalations, plans
  awaiting a veto, my tasks and reviews, incidents nobody has contained. A
  filter opens the full pane; the nav icon carries the combined count.
- **Company** (the Workspace section) — the rail groups the panes, each
  group collapsible per viewer: *Teams* (each unit's #channel, Board,
  Goals), *Direction* (Vision, Goals, Plans, Decisions), *Operations*
  (Pulse with Brief as a tab, Meetings, Incidents), *People & money* (Org
  chart, Spend with Capital as a tab), *Oversight* (Audit with Replay as a
  tab).
- **Artifacts** — the workspace tree. Playbooks, experiments, evals,
  outcomes and metrics are files under `/org/` there
  (`docs/filesystem.md` "Mirrored company records"); their panes were
  removed. Old links (`#/ws/<id>/org/approvals`, `…/experiments`, …) land
  on the new home.

## 9. Companies as products

- **Blueprints.** A company's structure, charters, playbooks, cadences and
  budget split export as one package, a sibling of AGENT.json: "a
  newsletter company", "a research lab", "a two-person dev shop". Import
  one, write a vision, and it staffs itself.
- **The registry** already distributes agents and skills with review
  gating; blueprints join it. A blueprint can be reviewed and rated by the
  outcomes of the companies that ran it.
- **Companies working together.** Later: a unit in one workspace can be a
  customer of a unit in another, with the external floor between them
  (disclosure, approvals, budgets). This is the only place the vision
  leaves the single workspace, and it stays last.

## 10. Safety as structure, restated

Nothing in this vision loosens item 1–17 guarantees. Caps, the meet rule,
the kill switch, the external floor and the audit chain stay in code. Three
things are added: a **constitution** per company (the CEO's standing rules,
enforced in code where they can be and used as the reviewer's rubric where
they cannot), **plan preview with a veto window** before autonomous
structural change, and the **auditor** as an independent model family
reading the record. Every ritual is bounded by rounds, budget and quiet
hours. Every minute and every decision is hash-chained.

## 11. From vision to execution plan

Six phases, each shippable on its own and each extending items 1–17 rather
than replacing them.

| Phase | Delivers | Depends on |
|---|---|---|
| **A. Intent** | Vision; key results with metric/target/owner/due; check-ins; at-risk detection; the cascade (planning sessions per unit); the why chain; vision page | goals, units, chief review (shipped) |
| **B. Rituals** | Meetings as channel threads with minutes; standup, weekly review, retro, board meeting; `/meeting`; minutes → tasks, decisions, brief items | channels, units, A |
| **C. Assurance** | Signals store; company SLOs and the pulse; the auditor role; signal routing to owner / lead / chief / CEO | runs, audit (shipped) |
| **D. Memory** | Decision log; playbooks as agent-authored skills; postmortem retro; `#decision:` refs; ask-the-company over the record | B, skills outcomes (shipped) |
| **E. Capital and the seat** | Allocation by objective; cost per outcome; forecasts; model routing by task class; plan preview with veto window; replay | A, C |
| **F. Blueprints** | Company export/import; registry distribution; role catalog as data; hybrid human roles | portability, registry (shipped) |

Recommended order: A → B → C in one wave (they are the loop: plan, meet,
watch), then D and E in parallel, then F. A and B are where the example in
this request lives; C is what makes autonomous mode trustworthy enough to
leave on.

## 12. Connections that come with context

A connection today is a credential plus per-service grants. In the company
it is a **capability with a manual**. Every connection (Google, Microsoft,
Telegram, email, MCP servers, the browser, the desktop companion) ships a
*context card*: what the service is, what the agent can and cannot do with
it at each grant level, the data it exposes, the risks (external floor,
PII), and a set of **suggested use cases** each paired with a ready-made
loop: a cron ("every weekday 07:30, summarise unread mail into the brief"),
a trigger ("on new calendar event with external guests, prepare a one-page
briefing"), or a ritual hook ("post the day's inbox count in standup").

- The card is injected into the agent's system context whenever the agent
  holds a grant on that connection, so the agent knows how to use what it
  has without being told in every prompt.
- Granting a connection offers its suggested loops as one-click installs
  (and the chief may install them for a report inside its caps); they are
  ordinary loops afterwards and can be edited.
- Cards are data (`server/src/connections/cards/*.json`-style), so a new
  connector or MCP server adds a card, not code, and a blueprint can ship
  its own cards.

## 13. Every agent has a heartbeat

`docs/autonomous-company.md` said "no idle heartbeats" to keep cost at
zero when nothing happens. The company keeps that promise differently:
every agent has a **heartbeat loop by default**, but the heartbeat is
*gated*. On each beat the server computes, without a model, whether there
is anything for the agent to act on: an assigned or blocked task, an inbox
event not yet handled, a channel mention unanswered, a key result check-in
due, a signal addressed to it, a stale task it owns, a ritual it
facilitates. Only when the gate opens does a real turn run, framed with
that list ("you were woken because…"). An empty gate costs nothing and
writes one `heartbeat` state row (last beat, last reason, next due).

- Default cadence every 30 minutes inside the workspace's waking hours;
  per-agent override; the chief's heartbeat is where its structure review
  and the cascade's replans run.
- The heartbeat auto-starts when an agent is created or imported and when
  the server boots; pausing an agent pauses it; quiet hours and the spend
  stop apply as for any loop.
- A member's heartbeat is the single place "check your status, your
  tasks, your channels" happens, so tools like `org_task_update` and
  check-ins are reached from one well-known prompt rather than from many
  ad hoc triggers.
- Members **follow** the threads and tasks they start, own, are assigned,
  review, comment on or are mentioned in (and anything else with
  `follow`): the beat lists what changed on them under "Following", and a
  followed task that becomes blocked, asks for review or reopens opens the
  gate — debounced by a tunable the operating profile shapes, never on top
  of a mention ([follows.md](follows.md)).

## 14. Status

*Phase A, Intent (item 18) — shipped 1 November 2026.* §2 and the §1b
tunables/profile are built, backend only (the vision page is SPA work for a
later item). Goals carry a
`kind` (one active *vision* per organization, revised in place; *objectives*;
*key results* with metric, start/target value, unit label, due date, owner
and check-in cadence) and the model-free risk state (`atRisk`,
`atRiskReason`); check-ins are rows of `org_checkins` with the latest
mirrored on the goal; the CEO's rules, the chief's latest strategy memo and
the operating profile (§1b: `values`, `culture`) sit on the organization row
with the `tunables` JSON. `OrgIntentService` owns `setVision`,
`setKeyResult`, `checkIn`, the pure `paceOf` (linear expectation between
createdAt/startValue and dueAt/targetValue against the measured value;
`onPace | behind | unknown`), `assessRisk` (behind pace by more than the
tolerance, owner missing / paused / terminated, confidence falling N check-ins
in a row, check-in overdue by M cadences; an objective with K at-risk key
results; audited transitions), `sweepRisk` (the minute tick: one wake per
goal per day through the audit log, a board event for an objective at risk),
`whyChain` (task → key result → objective → vision with a `broken` flag),
`intentTree` and the brief's "Key results" section with the vision-level
decision line. The cascade runs in `OrgRuntimeService.runPlanning`: a
per-unit planning session of the unit's lead (`Org · <org> · Planning ·
<unit>`), queued by a new or revised vision (root), an objective handed to a
non-root unit (`org_set_goal unit=…` or `PATCH unitId`), or a risk, debounced
and cooled per unit by the `planning.*` tunables, bounded by the chart's
depth, reserving budget like any run, auditing `planning_start | planning_end
| planning_skipped | planning_refused`, and prompting with the vision, the
rules, the operating profile, the unit's objectives, chart and envelope, the
role catalog (chief) and the current tree. Tools: `org_set_key_result`,
`org_check_in`, `org_why`, `org_intent` (lead/member set), `org_strategy_memo`
and `org_tune` (chief). Thresholds are tunables with bounds
(`server/src/org/org-tunables.ts`, `tunable(org, key)`); the chief tunes
within the fence in autonomous mode or through a `tune` approval card in
supervised mode, and every change is a decision-shaped audit row.
Departures from §2: supervised-mode planning creates key results and tasks
directly rather than as one plan-as-diff approval card (structural parts keep
their cards; the preview/veto window is phase E); objective progress blends
measured key results with linked tasks through the §7 formula rather than
showing measured and judged side by side (the tree carries both `measured`
and `confidence`, so the SPA can).
On the rebase over item 20, `org-assurance-tunables.ts` became a wrapper over
`org-tunables.ts` (its keys register at import; `assuranceTunable` delegates to
`tunable`, `mergeTunables` validates against the one registry, so `org_tune`,
`PUT …/org/tunables` and `PATCH …/org/slo` share one store and one set of
bounds), and `goalsAtRiskPct` reads `org_goals.atRisk` directly. The runtime also
registers the org's heartbeat providers (§13, item 21): open tasks and due
check-ins as reasons, the operating profile and the vision as context.

*Phase C, Assurance (item 20) — shipped 1 November 2026.* §5 is built,
backend only: migration `0033-org-assurance` (`org_signals` with a unique
index per (org, kind, refId, day), `org_slo_samples` one row per org per
day, `org_audits`; `organizations.auditorAgentId | auditCadenceDays |
auditUsdCap | tunables`). `OrgSignalsService` runs on the runtime's tick
every five minutes with no model: stale tasks, blocked tasks without an
owner, review-queue age, burn rate projected to month-end against the
envelope (warn at 100 %, critical at 120 %), breaker trips from `run_end`
rows, charter drift, and the §4 org debt (idle and overloaded members, a
lead with one report, a unit with no goal, a goal with no owner or unit,
duplicate titles). Each signal is addressed — owner and lead get an
`org_signal` inbox event, the chief an OrgBoard event (`kind: signal`) that
runs its structure review with the signal as reason, the CEO a pushed
event and a brief line — fires once a day, stays open while the condition
holds, is acked by its addressee (`org_ack_signal`, `POST …/signals/:id/ack`)
and resolves itself when the sweep no longer sees it. `OrgSloService`
computes cycle time (overall and per task class derived from the brief),
first-review acceptance, cost per accepted task, decision latency, goals
with owner and unit (and at-risk when item 18's column is present),
spend vs envelope over a trailing 7-day window, stores the day's sample,
opens an `slo_breach` signal per missed target and serves `pulse()`: the
score formula (four weighted quarters, minus a penalty per open critical
signal) is in `org-slo.service.ts`. `OrgAuditorService` is the §5.3 role:
`auditorAgentId` names a member — the "Auditor" catalog pack (read-only
scopes) fills the seat when hired — and every `auditCadenceDays` (or
`POST …/org/audit/run`) one run in `Org · <org> · Audit` samples accepted
tasks with their done_when and final comment, the scope/spend/autonomous
audit rows and charter-drift candidates, frames them with the operating
profile (§1b: mission, values, culture, vision, read defensively) and
runs with a tool set restricted to reads plus `org_audit_finding` /
`org_audit_close` (`OrgToolsHook.restrictTo`: any other tool is refused,
not executed). Budget is reserved before the call and clamped to
`auditUsdCap`; the auditor runs on a model family other than the workers'
majority when one is available (pinning the session to an enabled agent
type on another provider) and the report is flagged *single-model audit*
otherwise. Findings become signals (critical → CEO), the report goes to
`#company` and `org_audits`, the brief gains Signals, Pulse and Audit
sections. Every threshold, SLO target, pulse weight and the sample size is
a per-org tunable with a default and a bound (`org-assurance-tunables.ts`,
`GET|PATCH …/org/slo`); bounds stay in code. Not done: the SPA (signals,
pulse and audits are API-only), `org_tune` (item 18 owns it; the reads
here already go through the tunables column so tuning works once merged),
and the generic `org-tunables.ts` helper this module will switch to on
rebase.

**§12–§13 (item 21, 1 November 2026).** Context cards are data in
`server/src/connections/cards/` (eleven cards plus one built per MCP
server), injected into the system context for held grants only and ranked
by the operating profile's text (`fits` tags, no model); suggested uses
install as ordinary loops through `POST /api/agents/:id/loops/install`
with the grant level checked. The heartbeat is on for every agent from
birth as agent columns (not a loops entry), gated by a model-free check —
stale tasks, addressed inbox rows, unanswered mentions, plus whatever the
org module registers through `HeartbeatReasonProvider` — that runs one
"Loop · heartbeat" turn only with reasons, framed with the charter and the
operating profile from `HeartbeatContextProvider`s. Per §1b every number is
a default with a bound: workspace `heartbeatDefaults`, agent overrides,
and a fence in code (cadence ≥ 5 min, ≤ 48 runs a day, staleness 5 min..7
days). Quiet hours defer the beat; the spend stop closes it. Details:
`docs/triggers.md` "Heartbeat", `docs/integrations.md` §5a.

**Phase B, rituals (item 19) — shipped 1 November 2026.** §3 is built as
`docs/group-chat.md` §8 describes: meetings are unit-channel threads with a
facilitator, an agenda, one turn per attendee per round (≤ 3), a per-meeting
USD cap, a per-unit daily cap, quiet-hours postponing and the kill switch;
minutes are posted, hash-chained into the audit log and executed into tasks,
decision-log rows (§6's `org_decisions` lands here, with `#decision:` refs),
audited risks and brief questions. Standups are composed from the board with
no model. Cadences per unit are the §3 defaults, fired by the minute tick;
`/meeting` starts one by hand. Per §1b, the round cap, USD cap, daily cap,
attendee rule and kind set are `meeting.*` tunables with the fence in code
(`server/src/org/meeting-tunables.ts`, registered on the shared
`org-tunables.ts` registry, so `org_tune` and `PUT …/org/tunables` reach them), the chief and unit
leads reshape cadences with `org_set_cadence` (bounded, audited, logged as
decisions, approval cards in supervised mode), and every meeting prompt
carries the operating profile (values, culture, the item-18 vision) when the
organization has one; a facilitator's gated heartbeat (item 21) lists the
rituals it runs today as a reason. Not built: pinned minutes (a `minutes` attachment
marks them), planning sessions as the §2 cascade (item 18), postmortem
retros (item 22).

*The CEO's seat, SPA (1 November 2026, branch `feat/spa`).* §8 is on screen
for what the backend has: the Company section gains **Vision** (§2: the
vision, profile, strategy memo, Plan now, the intent tree with measured
progress and owner confidence side by side, pace, risk, check-ins, the Why
drawer), **Pulse** (§5: score and sparkline, SLO tiles, signals with ack /
resolve and deep links, audits, spend vs envelope, today's rituals),
**Meetings** (§3: cadences in words and editable, meetings held, Start
meeting; meeting threads and minutes cards in the channel) and
**Decisions** (§6: the log with rationale, alternatives, decider and source);
the tunables (§1b) edit from Settings → Workspace → Organization and the
heartbeat defaults (§13) from Settings → Workspace. *(1 November 2026,
branch `feat/spa2`)* The rest of the seat followed: **Ask** (§6, citations as
chips, sources), **Plans** (§8, every planned change as a diff with the veto
countdown, Veto / Apply now, the dry run), **Replay** (§8, a day as a
timeline with the chain check), **Capital** (§7, cost per outcome, forecast,
allocations, routing), **Playbooks** and the Related drawer (§6), the
Blueprint row in Settings and the Companies tab in the Market (§9), the Hire
dialog with the role catalog and hybrid employees with a **My tasks** pane
(§4) — see each item's "Shipped as, SPA" in `docs/execution-plan.md`.

*Phase E, Capital and the CEO's seat (item 23) — shipped 1 November 2026.*
§7 and the §8 preview/replay are built, backend only (the vision page, the
pulse screen and the plan diff are SPA work): migration `0035-org-capital`
(`org_tasks.class`, `organizations.routing`, `org_allocations`, `org_plans`).
**Cost per outcome:** every task carries a `class` (`triage | research |
synthesis | review | ops | general`, set by its creator or derived by the one
shared heuristic `deriveTaskClass`, which item 20's `classOf` now reads);
`OrgCapitalService.costByGoal` rolls run spend up task → key result →
objective → vision for a period, model-free, sets each objective's share of
its envelope (its allocation, else the company envelope) against its measured
progress (the mean of its key results, else the tree's blended progress) and
flags it when the spend share exceeds the progress share by more than
`capital.overspendMargin` (default 0.2, bound 0–1); the brief's "Cost per
outcome" section is one line per objective, `org_costs` and `GET …/org/costs`
read the same report, and the pulse, the spend tree and `org_pulse` show USD
by class. **Allocation by expected value:** `org_allocations` says what an
envelope buys — `org_allocate_budget` takes `objectiveId` and `buys`, writes
the row with the agent/project envelope it rides on (on approval, in
supervised mode), the planning prompt lists allocations per objective with
their cost so far and asks the chief to allocate per objective and say what
each buys in the memo, and a budget card's summary names the objectives the
envelope affects. **Model routing:** `organizations.routing` maps classes to
tiers (`cheap | standard | strong`, `org-routing.ts`: cheap through
`cheapestModelFor`, standard the session's own model, strong a per-provider
table, each overridable by a pinned tier model); `runTask` sets the per-task
session's model from the task's class unless the CEO pinned a model on the
agent, and the `run_start` row records class, model, tier and pin.
`org_set_routing {class, tier, why}` applies at once in autonomous mode
(decision-shaped `routing_set` + `auto_routing`, inbox, `#company`) and is a
`routing` approval card in supervised mode; `GET|PUT …/org/routing` is the
CEO's. **Forecasts:** `forecast` projects month-end spend per envelope —
company, each agent, each project, each objective's allocation — from the
burn over the trailing `capital.forecastWindowDays` (default 7, 1–30) with
`onTrack | warn | stop` against the assurance burn thresholds; the tick's
`sweepForecast` opens a `burn_forecast` signal from the projection (warn →
chief, critical → CEO) and resolves it when the projection falls back; the
brief's Spend section carries the projection line; `org_forecast` and
`GET …/org/forecast` read it. **Preview with a veto window:** in autonomous
mode the structural actions of a planning run or a chief review (hire, reorg,
terminate, scope widening, budget raise, routing, tuning) are not executed:
`RunCtx.plan` collects them, validated and cap-checked as if they ran, into an
`org_plans` row with `applyAt = now + capital.vetoWindowMinutes` (default 30,
bound 0–1440; 0 applies at once), one inbox event pushed to the CEO ("Plan
ready: N actions, est. $X, applies at HH:MM unless you veto"), and the tick
applies the actions in order through the very `execute` path the tools use
(`applyPlanAction`, caps re-checked, stop at the first refusal, every step
audited); `POST …/org/plans/:id/veto | /apply-now` are the CEO's; key
results, tasks, check-ins, assignments and the memo still apply immediately;
supervised mode is unchanged. `POST …/org/plan/dry-run {prompt?, assume:
{monthlyUsd?}}` runs a chief planning turn in which every mutating call is
recorded and nothing is applied, with the hypothetical envelope injected as
such, and returns a `dry_run` plan — "what would you do with twice the
budget". **Replay:** `GET …/org/replay?day=` composes, from the audit chain,
runs, signals, approvals and plans, an ordered timeline of what woke, what was
decided and what it cost, with the chain verification of that day's segment
against the row before it. Departures from §7–§8: a run's class is the
task's, not re-judged per call; `strong` resolves through a small per-provider
table rather than a priced lookup; the preview is one row per run, not a diff
view (the SPA will draw it); the CEO pins models through the agent's
`model`, not through the routing table.

*Phase D, Memory (item 22) — shipped 1 November 2026.* §6 is built, backend
only: migration `0037-org-memory` (`org_playbooks`). **Playbooks** are skills
agents write for the company (`OrgPlaybooksService`): `org_write_playbook
{title, body, roles?, why}` creates the skill `org-<slug>` in the org's
workspace as a parked draft and a review task owned by the author that goes
straight to a reviewer other than the author (the `org_request_review` path);
the reviewer's accept activates the version — the body becomes the skill's
instructions, the skill is enabled and `#company` hears of it — and writing
the same title again proposes a new version while the live one keeps
serving. Active playbooks whose `roles` name a member's title (or nobody in
particular) are listed with one-line summaries in that member's org context;
the agent loads one through the ordinary `skill_org_<slug>` tool.
`org_playbooks {role?}` lists them; skill outcome tracking (item 10) is
copied onto `org_playbooks.outcomes` and the retro's agenda names every
playbook with its uses and rating, the unused and the poorly rated called
out. **Postmortems** (`OrgMemoryService`): an abandoned objective or key
result, a task escalated after the review rounds, a breaker tripped twice on
one task in a day, or a critical audit finding schedules a `retro` for the
owning unit through the item-19 runtime, with an agenda built from the record
and no model — what happened, the timeline (the ref's audit rows as
`[audit:<seq>]`), the cost (its runs), the signals, the decisions touching
it, the playbook outcomes — once per ref per `memory.postmortemCooldownDays`;
`memory.postmortemTriggers` is the bit set of what triggers (§1b). The
retro's minutes gain `lessons[]` through `meeting_propose_lesson {text,
audience: member|unit|company, proposedCharterChange?, proposedPlaybookChange?}`;
when the minutes materialise each lesson is recorded in the lessons store of
the agents its audience names (source `loop`, the trusted surface), a
charter change becomes a `charter_change` approval card carrying the before,
the after and the line diff — the CEO decides; approving writes the charter
and re-accepts its hash through `acceptCharter`, so it is never drift — and a
playbook change becomes a revise task for the playbook's owner. **The
decision log** now receives a row for every approved or rejected approval
and every executed autonomous action (`auto_*` and an autonomous
`org_tune`), with the alternatives and the rationale from the `why`;
`GET …/org/decisions/search?q=` is ILIKE over title, decision and rationale
and `org_decisions {q?, unit?}` is the same read for any member. **Ask the
company** (`OrgKnowledgeService`): `POST …/org/ask {question}` (anyone with
standing: CEO, board, observer) assembles a citation pack from the record
by keyword — goals and key results, tasks, decisions, minutes, signals,
audit rows, channel messages, `memory.recallCap` per source — and runs one
chief turn over it with read-only tools only (`org_intent`, `org_why`,
`org_decisions`, `org_read_board`, `org_read_goal`, `org_audit_query`,
`org_signals`, `org_playbooks`; anything else is refused by the turn loop,
not executed); every `[task:…]`, `[decision:…]`, `[goal:…]`, `[meeting:…]`,
`[audit:<seq>]` in the answer is verified against the record and unknown
ones are stripped; the turn is reserved and settled like any run under
`memory.askUsdCap` and audited as `ask_company`. `org_recall {question}`
gives the chief the pack alone inside planning and review runs. **The
graph**: `GET …/org/graph?ref=<kind:id>&depth=1|2` walks goal ↔ project ↔
task ↔ comment, decision ↔ meeting ↔ approval, message ↔ task / mention /
file through the existing link columns, model-free. Departures from §6:
skill names are slugs, so the `org/` namespace is spelled `org-`; a skill's
tool is visible workspace-wide once active (the role targeting is the
context list, not the tool list); a charter change is text appended to (or
replacing) the charter rather than a free-form patch, the card shows the
computed line diff; the SPA is not touched.

*Phase F, Blueprints (item 24) — shipped 1 November 2026.* §9 and the two §4
items it depends on are built, backend only (`docs/blueprints.md`). A company
exports as **`COMPANY.json` v1** (`format: yaam-company/1`): roles by title
with charter, reporting line, meet-rule scopes, model tier and envelope; the
operating profile and rules; the vision with a relative horizon; the stored
tunables; the workspace's approved playbooks as `SKILL.md` text; the budget
split; cadences and routing when later items' tables exist (probed
defensively); recommended connection cards; a hashed origin — and none of its
history (no messages, tasks, lessons, files, connections, grants, tokens or
ids). `validateBlueprint` is the strict gate on every door (≤ 256 KB, ≤ 20
roles, depth ≤ 3, fan-out ≤ 5, unknown fields refused). `POST
…/org/blueprint/plan` is the dry run (hires with scopes after the meet,
budget within the envelope, tunables within bounds, playbooks, what is skipped
and why); `POST …/org/blueprint/import { blueprint, mode, monthlyUsd }` creates
the chief, the organization in that mode, the profile, vision, tunables and
skill drafts, and staffs the company — one **`blueprint` approval card** for
the whole plan in supervised mode, direct `applyHire`s in autonomous mode.
Import never runs code, never creates a connection or a grant (connection
scopes are dropped and recommended), never copies memory. Blueprints publish
to the registry as kind **`company`** behind the same scan and review gate
(`POST|GET /api/market/companies`, `POST …/companies/:id/install` = review +
plan, then import on `confirm`), federate like any kind, and are rated by two
measured **outcomes** — the first key result achieved, thirty days under the
envelope — recorded on the item only when `shareBlueprintOutcomes` is on. The
**role catalog is data** (`server/src/org/roles/catalog.ts`: eleven roles with
charter templates, competencies, scopes, tiers, cost estimates and `fits`
tags; `GET …/org/roles?profile=` ranks them against the profile with a string
match; `org_hire_agent` takes `role:<id>` through the existing template-hire
path, scopes met with the chief's, the cheap tier → the provider's cheapest
sibling). **Hybrid staff**: `org_humans.role = employee` with a reporting line
and a title; employees sit on the unit chart and in their unit's channel and
`#company`, can own a task (`assigneeHumanId`, an addressed inbox event, task
cards at `GET …/humans/me/tasks`, status through the usual routes), review one
as a `human_review` approval card only they or the CEO decide, and be assigned
by a lead inside its unit or the chief anywhere (`org_assign human=`).
Departures from §9: playbooks install as skill *drafts* (the registry rule
that nothing installs live); cadences are listed, not written, by an import
until item 19's rituals own them; tiers resolve through item 23's `tierModel` (one tier table); "companies working
together" (§9.3) stays last and is not started; no SPA.

*Onboarding (item 25) — shipped 1 November 2026.* The §1b profile is
collected at birth: the New workspace wizard asks whether the workspace is a
company and, if so, for its chief, vision, horizon, rules, values, culture,
budget, rhythm and first hires, and `POST …/org/bootstrap` writes them in
order through the same services the Settings card and the chief use, so a
company starts from the CEO's words rather than from fixed defaults.

*Workspace-owned agents (item 26) — shipped 1 November 2026.* Each
workspace owns its own agents and its own organization: enrolment, hires,
blueprint imports and the onboarding chief all land in the company's
workspace, an agent of another workspace cannot be seated, and moving an
agent between workspaces is an explicit action (`POST /api/agents/:id/move`),
refused while it sits in an organization (docs/shared-agents.md "Workspace
ownership").

*The chief of staff's operating system — shipped 2 November 2026.* From
`reports/Chief of staff operating model.md`: the chief's charter now states
its mandate (leverage on the CEO's time, information and decisions by
running the planning, reporting, decision and communication loops), its
place on the conductor ↔ CEO-brain-extension axis (`chief.proxyLevel`, a
proposal for the CEO in the boundary), the three authority tiers and the five
failures it guards against. Onboarding derives the operating system from the
profile (stage, culture type, norms) into `chief.*` and existing tunables and
the root unit's rituals, installs the Chief of Staff pack's skills and loops
on the chief and seeds the ledger under `/org/`; the chief's heartbeat reads
the rituals due, overdue decisions, stale risks and breached handoffs. See
`docs/chief-of-staff.md`.

*A simpler app — shipped 2 November 2026.* The Ask, Playbooks, Metrics,
Experiments, Outcomes and Evals panes are gone from the SPA; their records
are mirrored as markdown under `/org/` and read in the new Artifacts main
menu item. Approvals and My tasks moved to the new Inbox; Brief, Capital
and Replay became tabs of Pulse, Spend and Audit; the Workspace section is
now Company, its rail grouped (§8 "On screen"). The backend tools and
routes are unchanged.
