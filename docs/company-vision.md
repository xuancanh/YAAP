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
  into tasks, decisions and messages.
- **Preview.** In autonomous mode the chief shows its plan as a diff
  (hires, moves, budgets, first tasks) and a cost estimate before the veto
  window closes. The CEO can also ask "what would you do with twice the
  budget" and get a plan that is not executed.
- **Replay.** Any day can be replayed from the audit chain: what woke,
  what was decided, what it cost.

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
