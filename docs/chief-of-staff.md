# The chief of staff: run the operating system, not the company

*Shipped 2 November 2026. The design follows
`reports/Chief of staff operating model.md` (research notes in
`research_notes/Chief of staff operating model/`); its "design for the AI
agent" sections are the spec. It extends `docs/company-vision.md` §1b
(everything adapts), §3 (rituals) and §13 (the heartbeat), and stays inside
`docs/boundary.md`.*

The chief of staff (CoS) is the most important agent in an organization. The
research gives it one job: leverage on the CEO's **time, information and
decisions**, obtained by designing and running the company's operating
system — the planning, reporting, decision and communication loops that turn
function leaders' work into CEO decisions and those decisions into
follow-through. The agent's advantage over a human CoS is the upstream
pipeline (data deadlines, pre-reads, timers, logs, hygiene checks), which it
can run completely. Its documented failure modes (the second CEO, the
"Berlin Wall") sit at the proxy end of the role, so it starts as a thorough
conductor and earns proxy scope from the CEO.

Code:

- `server/src/org/roles/catalog.ts` — the `chief-of-staff` role's charter;
  `defaultChiefCharter` (`org.service.ts`) builds the onboarding charter on it.
- `server/src/org/chief-tunables.ts` — the `chief.*` tunables (area `chief`).
- `server/src/org/chief-os.ts` — `diagnoseProfile`, `deriveOperatingSystem`,
  `chiefLoops`, `seedArtifacts` (pure, no model).
- `server/src/org/org-chief.service.ts` — `OrgChiefService`: the operating
  system's state for the chief's heartbeat.
- `server/src/org/org-bootstrap.service.ts` — onboarding installs and seeds it.
- `packs/chief-of-staff.md` — the Chief of Staff pack (skills and loops,
  with the business charter tail),
  built into `server/src/market/authored-packs.generated.ts` by
  `node scripts/build-authored-packs.mjs`.

## 1. The charter

The charter has five parts (report: "Four taxonomies…", "Four limits…",
"An AI chief of staff is a profile, a ledger and a bounded mandate").

1. **Mandate.** Time, information, decisions; own the source of truth, never
   the rituals ("treat the company like a product", HashiCorp).
2. **Archetype.** The four published taxonomies collapse onto one axis,
   which becomes a setting, `chief.proxyLevel`: 0 early-team generalist,
   1 conductor, 2 functional stand-in, 3 CEO brain extension (Bain Capital
   Ventures). Onboarding picks 0–2 from the stage; 3 is never set at
   onboarding. A scheduled re-check of every live initiative against the
   current goals counters the conductor's drift failure.
3. **Function managers.** The CoS works at the handoffs and on work that
   belongs to no function. Function-level work goes to the function's
   head (the business catalog's `role:<fn>-manager`, titled "Head of …", or
   a unit lead): the objective through `org_set_goal unit=…`, or a briefed
   task. It does the work itself only when nobody owns the function ("if 80%
   of a job is one function, it is that function's"). The heads report to
   the chief weekly under `/org/<function>/reports/` and staff their own
   units: a head hires, pauses and re-tools its own reports within the agent
   cap and its unit's envelope, through the boundary, and the chief is told
   of each (`docs/agent-catalog.md` "Business catalog";
   `docs/autonomous-skills-review.md` §4, decision 1). The chief reads the
   reports into the weekly review, reviews the heads' staffing, answers what
   they escalate to it (`org_escalate` defaults to the chief for a head), and
   decides the cases that remain its own — a function's first head, hires
   across units, terminations, more envelope — within the boundary or puts
   them to the CEO.
4. **Three tiers** (below).
5. **Five failures** with their countermeasures (§6).

## 2. The three tiers and the boundary

The boundary table (`docs/boundary.md`) is the ceiling of what any agent may
change. The charter is narrower where the research says a human must
approve, so the two never conflict: the boundary refuses, the charter
declines.

| Tier | What | How it is held |
|---|---|---|
| Alone | schedule and prepare forums; compile pre-reads, the scorecard and the issues list; chase owners; log decisions and to-dos; run handoff timers and goal hygiene; keep the `/org/` ledger; draft memos, board and investor updates, all-hands material; write the CEO brief; tune timers and thresholds within bounds | boundary rows `tunable:*` (alone), `cadence` (alone, timing) |
| Proposes | new or retired rituals and what a ritual is for; the quarterly goal set; reallocations; reorganisations; the values → mechanism map; its own proxy level | charter; `org_propose_strategy`, `org_propose_experiment` (cadence, structure), decision cards; **`chief.proxyLevel` is a `propose`, non-delegable boundary row** |
| Never | decide a one-way door; hire, fire or coach the leadership; commit money beyond an envelope; own the board or investor relationship; set culture-defining rules; send outward in the CEO's name; touch the auditor's settings or assure its own system | charter; boundary rows `never` and `propose (not delegable)`; the external floor |

Alignment (`docs/alignment.md`) is the first stage of the chief's planning:
the direction, the strategy and the OKRs are classified, briefed and aligned
with the CEO (`ceo-alignment` playbook, `org_request_alignment`) before they
are decomposed, and in an autonomous company the chief aligns the classes
delegated to it (`org_align`) and spot-checks under- and over-escalation
(`org_alignment_audit`).

The proxy dial is the one new boundary row. Raising it widens what the chief
does on the CEO's behalf, so it is earned one class at a time through the
approvals record (report, "Conclusion"), never self-granted; a delegate
cannot approve it either.

## 3. The profile is the input

`deriveOperatingSystem(profile)` reads the CEO's words and derives the
parameters (report: "The profile is the input, and every parameter derives
from it"). It is a string match like the role catalog's `fits`; explicit
answers (`profile.stage`, `profile.cultureType` on the bootstrap body) win.

- **Stage.** Words such as "pre-seed", "Series B", "enterprise"; otherwise
  the starting headcount (below 10 early, 10–50 growth, 50+ scale).
- **Culture type.** The Competing Values Framework's clan, adhocracy,
  market or hierarchy by keyword; *balanced* when none dominates.
- **Norms.** Speed-valuing, rigour-valuing, writing culture.

| Parameter | Early | Growth | Scale | Culture and norms |
|---|---|---|---|---|
| `chief.proxyLevel` | 0 generalist | 1 conductor | 2 stand-in | — |
| `planning.objectivesPerVision` / `chief.maxObjectives` | 2 / 3 | 3 / 4 | 4 / 5 | — |
| `planning.keyResultsPerObjective` | 2 | 3 | 3 | — |
| `intent.checkInCadenceDays` | 7 | 7 | 7 | hierarchy without speed: 14 |
| `chief.preReadHours` | 24 | 48 | 48 | rigour or hierarchy 48, both 72; speed 24 |
| `chief.handoffSlaHours` | 24 | 24 | 24 | speed 8, hierarchy 48 |
| `chief.decisionOverdueHours` | 24 | 24 | 24 | speed 12, hierarchy 48 |
| `chief.riskReviewDays` | 30 | 14 | 14 | hierarchy 7 |
| `chief.offTrackWeeks` | 2 | 2 | 2 | speed or market 1 |
| `chief.sunsetEmptyCycles` | 3 | 3 | 3 | speed or adhocracy 2, hierarchy 4 |
| `chief.memoFirst` | 0 | 0 | 0 | rigour, writing or hierarchy 1 |

The root unit's rituals (cadence mode `profile`, now the default):

| Ritual | Derived |
|---|---|
| Standup | held only when the company values speed or is an adhocracy |
| Weekly review | always; a market culture holds it mid-week (Amazon WBR) |
| Retro | off for an early company that is not an adhocracy (postmortems still run) |
| Leadership ("board") meeting | weekly; monthly (first Monday) while early |

The decision protocol (consensus with a named decider, informed captain,
single decider, RAPID, or DACI for a balanced profile) and the communication
default (memo-first, async or written weekly updates) are written into
`/org/operating-system.md`, not stored as numbers.

The report is explicit that the culture → mechanism mapping is a design
heuristic, not a finding. Every value is therefore a per-workspace tunable
the CEO edits in Settings and the chief proposes to change; none is a fixed
default, and nothing carries to another workspace.

## 4. The ledger under `/org/`

A small, fixed core of artifacts whose fields the sources specify. They live
in the shared `/org/` folder at the workspace root, in the one layout
`server/src/files/layout.ts` defines (`docs/filesystem.md` "Layout");
onboarding writes them once, never over a file that exists, and the chief
keeps them. `/org/README.md` indexes the folder.

| File | Holds |
|---|---|
| `/org/operating-system.md` | the diagnosis with its evidence, the archetype, every derived parameter with its reason, the decision protocol, the communication default |
| `/org/scorecard.md` | 5–15 numbers: owner, target, this week, six-week trend, on/off track |
| `/org/issues.md` | the weekly meeting's issues list |
| `/org/decisions.md` | question, one decider, recommender, inputs/veto, door, decision, rationale, dissent, follow-ups, revisit condition |
| `/org/calendar.md` | every forum: unit, when (in words), purpose, owner (never the chief), output, last held, empty cycles — generated from the cadences and the minutes, not seeded; the chief's notes go below its Notes marker and are kept |
| `/org/risks.md` | owner, likelihood, impact, mitigation, status, review dates |
| `/org/handoffs.md` | the handoff SLA registry for handoffs no service covers yet, seeded with the function owners (services: docs/services.md) |
| `/org/values.md` | values → mechanism map; a value with none is a drift candidate |

The goal registry is the intent tree (`org_intent`), mirrored to
`/org/goals/` (one file per objective with its key results and check-ins);
the system's own decision rows stay in `org_decisions`; the files link to
them by id. `/org/rituals/<unit>.md` lists each unit's rituals and attendees.
Both are generated (`OrgLayoutService`), like the calendar.

The chief's own outputs have fixed places too: the weekly review pack at
`/org/reports/<yyyy>-W<ww>.md`, monthly reviews at
`/org/reports/<yyyy-mm>-staffing.md` and `…-learning.md`, board update
drafts at `/org/reports/<yyyy-mm-dd>-board-update.md`, the daily brief at
`/org/briefs/<yyyy-mm-dd>.md`, the quarter's planning pack at
`/org/planning/<yyyy>-Q<n>.md`, proposals at
`/org/proposals/<yyyy-mm-dd>-<slug>.md`, the leadership meeting's agenda
beside its minutes at `/org/meetings/company/<yyyy>/<yyyy-mm-dd>-board-agenda.md`,
and archived ledger rows under `/org/archive/<yyyy>/`. The chief changes a
ritual through its cadence (`org_set_cadence`); the calendar follows.

## 5. The heartbeat reads the operating system

**Staffing gaps (2026-11-04).** The state also lists every head whose unit
has a staffing gap — no specialists yet (and how much work it carries
itself), or every report at its WIP limit — under "Heads with a staffing gap
— delegate the team design to them": the chief's cue for
`delegate-org-design`, not for hiring the specialists itself. The same gap
reaches the head itself as a staffing line in its own context and, once a
day, as a heartbeat reason (docs/autonomous-skills-review.md §5).

`OrgChiefService` registers a reason and a context provider named `chief`
on the gated heartbeat, next to the runtime's `org` providers. Both are for
the chief only and model-free.

- **Rituals coming up** within `chief.ritualLookaheadHours`, with the
  pre-read deadline `chief.preReadHours` before each.
- **Decisions waiting on the CEO** longer than `chief.decisionOverdueHours`:
  to lead the brief, never to decide.
- **Stale risks**: at-risk key results and objectives with no check-in, and
  open warn or critical signals, for `chief.riskReviewDays`.
- **Breached handoffs**: a task a member of one unit asked for that sits on
  another unit's board (backlog, todo, blocked, waiting, in review) and has
  not moved for `chief.handoffSlaHours`. Tasks the chief created are routing,
  not handoffs. Requests for a department's **service** (docs/services.md)
  carry their own accept and resolve SLAs and climb the provider's line as
  `service_breach` cards; the chief routes only the asks that name no
  service and decides the breach cards that reach it.
- **Function owners** to route to (unit leads, "Head of …" and "… manager"
  titles), with a pointer to their reports under `/org/<function>/reports/`.
- **Requests from function heads**: backlog tasks a head filed for the
  chief (cases that stay the chief's, asks) and the `Escalation:` tasks a
  head raised to it, oldest first. The heads' own hires, pauses and settings
  changes arrive as inbox notices (origin `org`) and lines in the group log.
- **Decisions for you** (`OrgDecisionsService`, provider `decisions`;
  `docs/owners-seat.md` §7): the cards the heads raised, and those their
  heads escalated, wait on the chief before the CEO sees them. Each card
  shows its chain so far, every recommendation, and whether the chief may
  decide it. The chief acts with `org_decide`. A card it leaves climbs to
  the CEO with "no recommendation" when `seat.hopTimeoutHours` ends.

A handoff that breached since the chief's last beat is a reason to wake;
breaches already seen stay in the context only, so a stuck handoff does not
wake the chief every beat.

## 6. Five failures and their countermeasures

| Failure | Countermeasure |
|---|---|
| Gatekeeping (the "Berlin Wall") | widen access, never narrow it: no filtering or rewording of messages to the CEO; every brief line names its source (`ceo-daily-brief`) |
| Second CEO | decide only inside an explicit delegated scope; the proxy dial is the CEO's (boundary row) |
| Owner of every ritual | every forum has an owner other than the chief (`/org/calendar.md`); the chief keeps the record and the pre-reads |
| Invented explanations | the WBR rule: unexplained variance is "unknown — investigating", owned and tracked (`weekly-business-review`, `/org/scorecard.md`) |
| Status theatre | a forum empty for `chief.sunsetEmptyCycles` cycles is proposed for retirement (`ritual-retirement-review`); every added ritual must remove a handoff cost |

## 7. The pack

`packs/chief-of-staff.md` (`pack-chief-of-staff`, category Business). Its
skills use only tools the server offers (`org_*`, plus `fs_read`/`fs_write`
for the ledger):

`operating-system-setup`, `delegate-org-design` (2026-11-04: the chief
delegates staffing and team design to the heads — it sets each head's
mandate, the objectives its unit carries, and an envelope, an allocation per
objective; briefs the head a task for its unit's team design (seats with role
ids, cost, the key result each serves, the rituals) per the head's
`<fn>-team-design` playbook; reviews the design against the key results, the
envelope, the cap and the profile; decides the heads' hire cards against the
accepted design; and proposes a Program Manager to own each roadmap item —
it never staffs a head's unit for it. Since the matrix (2026-11-04,
`docs/work-tracking.md` "Program management: the matrix") goals and projects
are assigned to Program Managers: the chief assigns them
(`org_program_assign`; a company goal it sets goes to the least-loaded PM on
its own, and a PM who joins takes over what the chief was acting on), is
the **acting PM** — said so in every view — while the company has none,
proposes the first PM hire once outcomes compete for its attention, decides
the `resource_conflict` cards a PM and a head escalate (they are placed with
the head's manager first), and watches the matrix's health in
`project-portfolio`: items with no PM owner, members stretched past
`program.allocationWarnPct`, stale goal and project rhythms, requests waiting), `function-reports-intake` (the heads' weekly
reports, escalations and cases: scorecard and risks from the reports with the
report cited, the heads' own hires and pauses reviewed rather than redone,
incomplete cases sent back, `Escalation:` tasks answered or taken to the CEO,
the rest to the CEO), `annual-planning`, `quarterly-planning` (grading,
the OKR cascade through function managers, a dependency map with
acceptance), `weekly-business-review` (open items first, exceptions only,
controllable inputs, "unknown" over invented causes), `exec-meeting-prep`
(decision-shaped pre-reads, agenda as decisions and questions),
`decision-log-hygiene` (one decider, door type, revisit conditions),
`ceo-daily-brief`, `handoff-sla-monitor`, `risk-register` (with pre-mortems
before one-way doors), `values-mechanism-audit` (the five mechanism families,
drift with numbers, gaps as questions), `ritual-retirement-review`,
`investor-update` (draft only), `reorg-proposal`, and the four that close
the remaining loops (docs/autonomous-skills-review.md):
`escalation-and-blocker-sweep` (blocked, abandoned and breaker-stopped work,
degraded providers, cards nearing their deadline and default while the CEO
is away), `member-lifecycle-review` (first staffing — the heads, whose
specialists are then their own hires — the heads' staffing changes reviewed,
onboarding owner after each hire, probation, eval-gated model changes, pause
and termination),
`learning-loop-review` (experiments, calibration, lessons into playbooks,
golden sets) and `org-files-hygiene` (the ledger and the function folders
complete, linked, archived, free of secrets). `project-portfolio`
(docs/work-tracking.md) keeps the project layer true: orphans placed out of
Unsorted, retro actions held to the Operating improvements cap, health
updates chased with a drafted diff (the lead owns the call), appetite
breakers watched, and the betting table of shaped projects prepared for the
CEO — it never moves a project to Now, extends an appetite or kills a bet.

Its loops: the weekday **operating-system sweep** (intake, projects, blocks, brief, handoffs)
an hour before the brief — it starts a run of the `chief-daily-ops` process, whose
steps are the sweep's playbooks as tasks with step cards (docs/processes.md) —
the **weekly business review pack** (a run of the `weekly-review-pack` process) at the pre-read deadline before the root
unit's weekly review (moved off the weekend), the **monthly operating
review** and the **quarterly planning kickoff** three weeks before the
quarter. Onboarding computes their times from the workspace (`chiefLoops`);
the pack's frontmatter carries the same loops at the default times for a
market hire.

## 8. Onboarding

`POST …/org/bootstrap` now, after the profile and the chosen tunables:

1. derives the operating system and writes each derived value the body did
   not set as a tunable (an audited `tunable_set` row whose rationale names
   the profile evidence);
2. fits the root unit's rituals to it (cadence mode `profile`, the default;
   `default`, `light` and `none` behave as before);
3. installs the pack's skills on the chief (private to it; an existing
   agent keeps its own charter and gains the skills) and its loops (a loop the
   plan's cap refuses is installed switched off, with a note);
4. seeds the ledger through the workspace filesystem (`WorkspaceFs`, so
   the files carry a version and an author; `StorageService` when the
   filesystem is absent).

The summary and the `org_bootstrap` audit row carry `operatingSystem`
(stage, culture type, archetype, tunables, skills, loops, artifacts). The
New workspace wizard offers "Fit to my profile" as its default rhythm.

## 9. Departures and open edges

- Risks have no table: the register is a file; the heartbeat's "stale
  risks" are at-risk goals and unacknowledged warnings, which the record
  holds.
- A handoff is inferred from units (requester's unit ≠ the task's board);
  the per-handoff SLAs in `/org/handoffs.md` are the chief's record, while
  the timer uses `chief.handoffSlaHours`.
- The report offers no quantitative success measure for a CoS. The
  candidates it lists (decision latency, share of decisions with an owner and
  follow-through, initiatives on time) are read from the pulse and the log,
  not scored.
