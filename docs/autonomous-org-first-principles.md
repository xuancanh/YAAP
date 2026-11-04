# The autonomous organization, from first principles

*Status: analysis and proposal, 1 November 2026. It re-derives what an
organization that runs, improves and audits itself needs, starting from
the user rather than from the features YAAP already has. It then
grades items 1–26 against that list. `docs/company-vision.md` is the
earlier, feature-first vision. Where the two disagree, this document is
the newer argument. The build order in §8 has since shipped as
execution-plan items 27–32 (2 November 2026); §7 marks each capability
Have.*

Last updated: 2026-11-02

## 1. What an organization is

Strip away the metaphor and an organization is a system that:

1. holds a **purpose** someone else gave it,
2. turns **resources** (money, attention, tools, access) into **outcomes**
   in the world,
3. under **constraints** (law, budget, reputation, the owner's rules),
4. **over time**, through repeated cycles,
5. and **corrects itself** using feedback about what actually happened.

An *autonomous* organization closes those feedback loops without a human
in each one, while staying inside the authority it was delegated. Three
loops matter, plus the one that binds them to the owner:

| Loop | Question it answers | Fails when |
|---|---|---|
| **Run** | What should we do next, and is it done? | work is busy but outcomes do not move |
| **Improve** | Is the way we work getting better? | changes are made but nobody measures their effect |
| **Audit** | Is what we report true, and are we within our rules? | the auditor shares the doer's blind spots or data |
| **Govern** | How much should the owner trust us with next? | autonomy is a switch, not something earned and revocable |

Each loop is only as good as its **feedback signal**. That is the first
principle everything below follows from: *an organization cannot run,
improve or audit on information it generated about itself.* It needs
ground truth from outside its own reports.

## 2. The user, and what they are really buying

**Who.** A solo founder, an operator running a side business, a team
lead with too much routine work, or a person running their own life admin.
They have more intent than attention.

**What they want.** Outcomes with less attention, and the confidence to
look away. They are not buying agents. They are buying delegation.

**What they fear,** in the order the evidence shows it happens (the
Paperclip study in `reports/Paperclip deep dive.md`, Anthropic's Project
Vend, the operator reports):

1. **Busywork.** Agents produce tasks, comments and documents while the
   metric that matters does not move. The best-documented Paperclip company
   built a site with fourteen agents and reported zero revenue.
2. **Runaway cost.** Spend discovered after the fact.
3. **An embarrassing or irreversible external action.** A wrong email to
   a customer, a published error, a password reset nobody asked for.
4. **Silent drift.** The organization slowly does something other than
   what it was asked, and the reports still look fine.
5. **Approval fatigue.** So many cards that the human approves blindly,
   which Paperclip's founder called approval theater.
6. **Opacity.** The owner cannot tell why something happened.

**The test for every capability:** does it let the owner look away for
longer, and come back to fewer, better decisions?

### Use cases that set the bar

| Use case | Outcome metric (ground truth) | External actions | Irreversible risk |
|---|---|---|---|
| Weekly newsletter | subscribers, open rate, issues shipped on time | publish, email list | a wrong issue to every subscriber |
| Support desk | first-response time, resolution rate, CSAT | reply to customers | a wrong promise, a leaked detail |
| Small dev shop | merged PRs that pass CI, escaped bugs | push, merge, deploy | a broken production deploy |
| Personal chief of staff | inbox zero days, missed meetings, errands done | send email, accept invites, book | a commitment made in the owner's name |
| Market research desk | briefs delivered, decisions they informed | none or few | a wrong fact that informs a decision |

Every one of them has an outcome that lives **outside** the organization
(a mailing list, a helpdesk, CI, a calendar). That is where the
organization's feedback must come from.

## 3. Six principles

1. **Ground truth beats self-report.** Progress, quality and spend are
   read from the systems where they happen, with provenance. An agent's
   claim is a hypothesis until a sensor confirms it.
2. **Separation of powers.** The one who does is not the one who checks,
   and neither is the one who changes the rules. Executive: the chief and
   units. Judiciary: reviewers and the auditor, on a different model
   family and with independent data access. Legislature: the owner's
   constitution, which the chief may only propose amendments to.
3. **Every action is classed by reversibility and blast radius.**
   Autonomy is granted per class, not per organization.
4. **Autonomy is earned and revocable.** It grows with a measured track
   record and shrinks on incidents, automatically. A "supervised or
   autonomous" switch is the wrong shape.
5. **Every change is a hypothesis with a predicted effect.** If a plan,
   a reorg or a charter edit does not say what metric it should move and
   by how much, it can be neither evaluated nor audited.
6. **Outcome or shrink.** Resources follow measured outcomes. A unit that
   moves nothing for N cycles loses budget and headcount by default,
   which is the structural cure for busywork.

## 4. The capabilities

Twelve capabilities, grouped by loop. Each says what it is, why it is
needed, how much of it YAAP has today, and what is missing.
*Have* means shipped and tested. *Partial* means the shape exists but the
principle is not met. *Missing* means not built.

### Run

**C1. Sensing: ground-truth metrics with provenance.** *Missing.*
Key results today are updated by their owner's check-in, which is
self-report. Needed: a **metric source** primitive bound to a connection
or a webhook (Stripe revenue, a mailing-list API, GitHub CI status, a
helpdesk's response times, Google Analytics, a spreadsheet cell), polled
on a schedule, stored as a time series with the source and the fetch
recorded. A key result names its source; its current value comes only
from there. Owner confidence stays, as a judged forecast next to the
measured value. Without this, the at-risk rules, the cost-per-outcome
report and the auditor all reason over numbers the agents typed in.

**C2. Effectors with an external-action contract.** *Have (item 28, `docs/actions-and-trust.md`); was Partial.*
Connections, the browser, the computer companion and the code runner
exist, and the Ask/Auto policy plus the action reviewer gate them.
Missing for unattended operation: every outward action carries an
**idempotency key** (so a retry never sends twice), an **action class**
(read, internal write, external reversible, external irreversible,
money), a **staging step** where the medium allows it (a draft email, a
scheduled post, a PR before merge), **outbound rate limits** per
channel, and **two-key** execution for the irreversible class (a second,
independent agent or the owner must co-sign).

**C3. Executable acceptance.** *Partial.*
Tasks carry a four-field brief and a reviewer on another model family
grades them against `done_when`. That is judgment, not verification.
Needed: `done_when` can hold **checks** the system runs without a model,
such as "CI on PR #n is green", "the issue is scheduled in the mailing
tool", "the file exists and matches a schema", "the ticket is closed with
a reply". Model review stays for what cannot be checked, and the board
shows which tasks were verified by check and which by opinion.

**C4. Coordination with capacity.** *Have* (item 31: WIP limits, expected duration, dependencies, deadlines — `docs/owners-seat.md`, `org-capacity.service.ts`); was Have, mostly.
Units, boards, claims, handoffs, channels, meetings with minutes and the
gated heartbeat cover it. Missing: a **capacity model** (WIP limits per
member, expected task duration from history), **dependencies as a
graph** the planner respects, and **deadline-driven scheduling** so the
heartbeat knows what is urgent rather than only what is stale.

### Improve

**C5. Experiments, not edits.** *Have* (item 30, `docs/experiments.md`).
Retros produce lessons, playbooks and charter-change cards, but nothing
measures whether a change helped. Needed: an **experiment** primitive.
A change (charter, playbook, routing tier, cadence, tunable, structure)
is declared with a hypothesis ("first-response time drops 20% within two
weeks"), a metric from C1, a window and a revert rule. It applies to a
slice (one unit, a share of tasks, one cadence) or before/after with the
window recorded. At the end the system keeps it, reverts it or extends it,
and writes the result to the decision log. This is the improve loop. Without
it, "self-improving" means "self-changing".

**C6. Evals per role, and gated rollout.** *Have* (item 31, `docs/evals.md`); was Missing.
Needed: each role or charter keeps a small **golden set** of past tasks
with known-good outcomes, harvested automatically from accepted work.
A charter, playbook or model change is replayed against the set before
it rolls out, and a regression blocks it. Dry-run planning exists for
plans. This extends the same idea to how members do their work.

**C7. Prediction ledger and calibration.** *Have* (item 30, `docs/experiments.md`).
Agents forecast: "this task takes 2 runs", "this key result reaches 60%
by Friday", "this hire pays for itself in 30 days". Forecasts are stored
and scored against outcomes. Calibration is the cheapest honest signal
of judgment quality. It feeds trust (C10) and tells the chief whose
estimates to discount.

**C8. Structural self-modification with a boundary.** *Have* (item 31, `docs/boundary.md`); was Partial.
The chief hires, reorganizes, tunes cadences and thresholds, and routes
models, all within caps, and plans now pass a veto window. Missing is
an explicit **self-modification boundary**, written as data:
- **May change alone:** tunables within bounds, cadences, playbooks,
  routing, task assignment, internal structure within caps.
- **May change only through an experiment (C5):** charters, roles,
  structure beyond one unit.
- **May only propose:** the constitution, caps, the external-action
  floor, budgets above envelope.
- **May never touch:** the audit chain, the auditor's independence and
  data access, the kill switch.

The boundary should be checkable in code, and a violation should be an
audit finding.

### Audit

**C9. Independent verification.** *Have* (items 29 and 30).
Model-free signals, SLOs, the hash-chained audit log, and an auditor on
a different model family exist; since item 29 also the audit of the
auditor (spot checks with precision and recall), rotation and red-team runs
(`docs/incidents.md` §5). Missing (item 30):
- the auditor reads **ground truth** (C1, C3 checks), not only the record
  the doers wrote;
- **reconciliation**: claimed versus measured, per key result and per
  task, and the gap is a signal;
- **audit of the auditor**: the owner is asked to spot-check a small
  random sample of audited items each week (two minutes), which measures
  the auditor's precision and recall;
- **rotation**, so the same auditor does not audit the same unit
  indefinitely;
- **red-team runs**: a scheduled adversarial pass that tries prompt
  injection through connected inboxes and documents and reports what got
  through.

**C10. Trust ledger: earned autonomy.** *Have (item 28, `docs/actions-and-trust.md`); was Missing.*
This replaces the supervised/autonomous switch. For each member and each
action class (C2), the ledger records successes, reverts, review
rejections, incidents and calibration (C7). Autonomy levels follow from
it:

| Level | Meaning for that member and action class |
|---|---|
| 0 | proposes only, the owner decides |
| 1 | acts, the owner is notified after |
| 2 | acts, a peer reviewer checks a sample |
| 3 | acts, only the auditor samples |

Promotion needs N clean actions and calibration above a bar. One
incident drops a level at once. The owner sets the ceilings per class,
and money and irreversible actions start capped at level 0 or 1. The
owner's approval load then falls over time for the work that has proven
safe, and only for that work.

**C11. Incidents as a first-class object.** *Have* (item 29,
`docs/incidents.md`): detection, containment by severity with undo, one
owner line, postmortems, `emitOrgIncident` for the ledger, provider and
connection degradation; the frozen class is enforced once item 28's action
contract reads it.
Signals and breakers exist, but there is no incident. Needed: detection
(a breaker trip, a failed check, a revert, an owner complaint, an
external bounce), **containment** (pause the member or the action class,
or roll back if reversible), an owner notification with what was
contained, a **postmortem** (the retro machinery exists) and the
resulting trust-ledger change. Also **degradation modes**: a provider
outage fails over to another model family, a revoked connection pauses
only the actions that need it, and the brief says what is degraded.

### Govern

**C12. The owner's seat: exceptions, not approvals.** *Have* (item 31, `docs/owners-seat.md`); was Partial.
The brief, decision cards, vision page, pulse, ask-the-company, plan
preview and replay exist or are landing. What the first principles add:
- each decision card carries a **recommendation, the alternatives,
  reversibility, confidence, a deadline and a default action** if the
  owner does not answer, so silence is a decision rather than a stall;
- approvals can be **delegated by class** ("money under $20: the
  controller role decides") with an audit trail;
- the brief opens with **outcomes against ground truth**, then exceptions,
  then decisions, and stops. Activity counts never lead;
- **value accounting**: alongside cost per outcome, what each outcome is
  worth (revenue, hours saved at the owner's rate, a stated value per key
  result), so "outcome or shrink" (principle 6) has a number to act on.

## 5. The minimum viable autonomous organization

Not all twelve are needed to cross the line from "agents with a manager"
to "an organization the owner can look away from". Five are:

1. **C1 Sensing.** Without ground truth, every other loop is
   self-referential.
2. **C3 Executable acceptance.** Without it, done means an agent said so.
3. **C10 Trust ledger** with **C2's action classes.** Without them,
   autonomy is all-or-nothing and the owner either rubber-stamps or
   micromanages.
4. **C5 Experiments.** Without them, improvement cannot be told apart from
   churn.
5. **C11 Incidents.** Without them, the first bad action ends the owner's
   trust for good.

C6, C7, C8, C9's additions and C12's additions make it good. These five
make it real.

## 6. One use case, end to end

*A newsletter company, after the five are built.*

- **Owner, day 0.** Writes the purpose ("a weekly brief on agent
  tooling, growing to 2,000 subscribers by March"), the constitution
  ("never publish without a source per claim; never email the list
  twice in a week"), the budget, and connects the mailing tool and
  analytics.
- **Sensing.** The key result "subscribers" binds to the mailing tool's
  API. "Issue on time" binds to the scheduled-send timestamp. Owner
  confidence sits next to both.
- **Run.** Every Monday the editor unit plans the issue. The researcher's
  tasks finish only when sources are attached (a check). The writer's
  draft goes to the mailing tool as a scheduled send (staging). The send
  is irreversible and broadcast, so it needs two keys: the editor and the
  auditor's fact-check pass. The editor sits at trust level 2 for drafts
  and level 0 for sends in month one.
- **Audit.** The auditor samples three claims per issue against their
  sources and reconciles the subscriber count it reads with the one in
  the brief. The owner spot-checks one of those claims a week in two
  minutes.
- **Improve.** Open rate is flat. The chief proposes an experiment:
  "subject lines in question form, four issues, predicted +3 points".
  It runs, the metric comes from the tool, the result is +1.1 within
  noise, and it is reverted and logged.
- **Govern.** By month three the editor has twelve clean sends and is
  calibrated, so the ledger promotes sends to level 1. The owner now only
  hears about an issue after it goes out. One week a broken link goes
  out. That is an incident: sends drop back to level 0, a retro adds a
  link-check to `done_when`, and the owner reads one paragraph about it
  in the brief.

The owner's weekly attention falls from reviewing every issue to reading
one page and one spot-check. It rises again only after an incident.

## 7. Where YAAP stands

| Capability | Status | Built on |
|---|---|---|
| C1 Sensing | Have — shipped (item 27, `docs/sensing.md`) | connections, loops, triggers (item 6), key results (item 18) |
| C2 Effectors with action contract | Have (item 28) | action classes, idempotency keys, staging (mail drafts), outbound rate limits, two-key execution with a different-family co-signer — `docs/actions-and-trust.md`; calendar staging declared, not built |
| C3 Executable acceptance | Have — shipped (item 27, `docs/sensing.md`) | four-field brief, cross-family review (item 15) |
| C4 Coordination with capacity | Have (item 31) | units, boards, meetings, heartbeat (items 15–21); WIP limits with the chief's audited override, expected duration per class from history, dependencies as a graph (`waiting`, cycles refused, wake on completion), deadlines ranking the heartbeat and overdue signals |
| C5 Experiments | Have (item 30, `docs/experiments.md`) | decision log, retros (items 19, 22), sensing (item 27), plans (item 23) |
| C6 Evals and gated rollout | Have (item 31, `docs/evals.md`) | golden sets harvested from work accepted by check or first-round review; sandboxed (record-only) replays against a cached baseline; charter changes, new playbook versions and routing changes blocked on regression |
| C7 Prediction ledger | Have (item 30, `docs/experiments.md`) | check-ins (item 18), sensing (item 27), trust ledger (item 28) |
| C8 Self-modification boundary | Have (item 31, `docs/boundary.md`) | one table (alone · experiment · propose · never) consulted by every self-change path; a never-attempt is a critical finding and a minor incident; experiment-only changes route to item 30's `org_propose_experiment` |
| C9 Independent verification | Have — spot checks, rotation, red team (item 29); reconciliation of claimed versus measured and ground truth in the auditor's sample (item 30) | signals, SLOs, auditor, audit chain (item 20), sensing (item 27) |
| C10 Trust ledger | Have (item 28) | levels 0–3 per agent × class under owner ceilings, promotion on clean streaks, demotion on incidents (item 29's bus), reverts and rejection streaks; supervised/autonomous is now a ceiling preset; promotion also needs calibration ≥ `trust.calibrationBar` once C7 has scored the member (item 30) |
| C11 Incidents | Have (item 29) | breakers, signals, retros (items 15, 20, 22) |
| C12 Owner's seat | Have (item 31, `docs/owners-seat.md`) | decision cards with recommendation, alternatives, reversibility, confidence, deadline and a default action (never approve-by-default for irreversible or money); delegated approvals to a person or an agent role; value events from measured key results; the brief opens with Outcomes; outcome-or-shrink signals |

The honest reading: YAAP has built the **body** of an organization
(structure, work, conversation, memory, money, rituals) and the first
layer of its **conscience** (signals, auditor, audit chain). It has not
yet built its **senses** (C1), its **hands' safety catches** (C2, C3), or
the mechanism by which **trust is earned** (C10). Those decide whether an
owner can actually look away.

*Shipped (2 November 2026, item 27):* **C1** — metric sources of four
kinds (HTTP JSON through the SSRF guard with sealed secret headers, a
token-authenticated webhook, a fixed menu of connection queries, a human
attestation), samples with provenance, polling with error backoff, stale
sources signalled to the chief; agents only propose a source and the CEO
approves it in both modes; a key result bound to a source takes its value
only from samples, with the owner's confidence kept beside it, and
self-reported key results are counted in the brief. **C3** — model-free
checks on a task (metric thresholds and increases, HTTP status and JSON
match, workspace files, connection counts; no `github_check`, there is no
GitHub connection) run before review: all pass accepts the task by check,
a failure returns it to the owner as a review round, an error falls back
to model review; the board shows `verification: check | review | none` and
the brief the share accepted by check. See `docs/sensing.md`.

*Shipped (2 November 2026, item 30):* **C5**: a change (tunable, cadence,
routing, playbook, charter, structure) is an experiment with a hypothesis,
a metric source, a direction, an expected effect, a window and a revert
rule. The baseline comes from samples. The system applies the change and
reverts it through the tools' own code paths; charters and structure go
through cards. The model-free verdict uses the mean difference with a
noise guard: improved is kept, worse is reverted, and inconclusive is
extended once and then reverted. A daily revert-rule check reverts at once
and opens a minor incident. Every verdict lands in the decision log.
Supervised experiments need a card; autonomous ones start within bounds,
or after the veto window when structural. Direct changes show in the brief
as "unmeasured". **C7**: forecasts come from the tool, a task's first run,
key-result check-ins and experiment proposals. They are scored without a
model against runs, samples and measured effects (Brier, normalized
error). Calibration feeds the trust ledger's promotion bar and the brief.
**C9**: a daily reconciliation catches confidence that outruns the measured
pace, accepted work whose derived check fails, and brief numbers that
disagree with the ledger. The gaps go into the auditor's sample. See
`docs/experiments.md`.

*On screen (2 November 2026, item 32 part one):* C1, C3, C2, C10, C11, C9,
C5 and C7 are in the SPA — the Metrics, Incidents and Experiments panes
(with calibration and reconciliation), Settings → Workspace → Trust and the
agent's Trust tab, the owner's key on held and staged actions in Approvals
and in chat, the health strip and the auditor's spot checks on Pulse (see
`docs/execution-plan.md` items 27–30, "Shipped as, SPA"); C4, C6, C8 and C12
followed in item 32's part two — decision cards with deadlines and
defaults, delegations, the boundary table, the Evals and Outcomes panes,
WIP and deadlines on the board. (Now, since execution-plan item 33: the
Metrics, Experiments, Evals and Outcomes panes are gone and their records
are markdown files under `/org/` in Artifacts; approvals, held actions and
open incidents wait in the Inbox; Incidents sits under Company →
Operations.)

## 8. Build order

| Step | Capabilities | Why this order |
|---|---|---|
| 1 | C1 Sensing; C3 checks | everything downstream reads from them |
| 2 | C2 action classes, idempotency, staging, two-key; C10 trust ledger | turns the mode switch into earned autonomy, and makes unattended external action safe |
| 3 | C11 incidents and degradation; C9 reconciliation and audit-of-auditor | the safety net that lets level 2–3 autonomy stay on |
| 4 | C5 experiments; C7 prediction ledger | the improve loop, measured |
| 5 | C6 evals and gated rollout; C8 boundary as data; C12 decision defaults, delegation and value accounting | refinement once the loops exist |

Each step should ship with the use case in §6 as its acceptance test.
