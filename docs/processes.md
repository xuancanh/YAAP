# Processes: standing procedures whose steps are tasks

*Status: built (migrations `0097-processes`, `0098-process-ramps-sagas-discovery`). Design source:
`reports/Process abstractions for agent companies.md` ("Process should be a
pinned graph whose nodes are ordinary tasks", "Inside a turn the agent sees
one step card", "Every threshold is a tunable"); the audit it rests on is
`research_notes/Process abstractions for agent companies/yaap_current_abstractions.md`.*

YAAP governed the edges of a run (which task, whether budget allows, who
reviews) and left its middle to the model. Procedure lived as prose in
playbooks, pack skills and `/org/**` files, and nothing recorded which
procedure was followed. A **process** is that procedure as data: a
versioned graph the engine walks with no model, whose every agent step is
an ordinary org task with a step card. Review, checks, WIP, breakers,
budgets, next work and any task-creation gate apply to process steps
unchanged, because they *are* tasks.

Code: `server/src/org/process-model.ts` (pure: validation, the walk,
availability, the step card, metrics, the saga plan, the cohort comparison,
conformance), `process-discovery.ts` (pure: mining repeated work, drafts),
`process-templates.ts` (the library), `process-tunables.ts`,
`org-processes.service.ts` (the engine),
`org-processes.tools.ts` (agent tools, the step card in context, denied
tools), `processes.controller.ts` (routes); the page is
`src/components/OrgProcessesView.tsx` with `src/lib/processes.ts`.

A process spans tasks across the company. Inside **one** task, the agent
performing it may split its own work into a plan run across several
sessions — the same graph model with one stage, never on the board: see
[task execution](task-execution.md).

## 1. The model

```
org_processes          header: name (slug), title, category, owning unit, status, the active version; a ramp (candidate, %, verdict)
org_process_versions   immutable: the definition JSON, author, reason, diff, status active|superseded|pending|rejected|candidate|rolled_back
org_process_runs       PR-n, pinned versionId, stage, owner, trigger + triggerRef (dedupe), vars, loop counters, compensation
org_process_steps      (run, node, attempt) UNIQUE — task | approval | wait | subprocess | meeting | stage (a dynamic stage's coordinator) | compensation
org_process_events     append-only: started, materialized, step_done, skipped, looped, deviated, version_adopted, compensated, ramp_*, …
org_process_suggestions one per pattern key: discovered processes, missing steps, revisions — evidence, draft, owner, its task
org_tasks              + processRunId, processNodeId; source 'process'
```

A definition is a list of **stages** run in order. Each stage is
**strict** (a DAG; the engine decides the next step) or **dynamic** (a set
of steps, each *available when* its prerequisites are done and its
variables are set; the performer chooses). A process may mix them: incident
response is strict throughout; the weekly review pack collects in a
dynamic stage and compiles in a strict one; customer onboarding kicks off
strictly and adopts dynamically.

Steps (`nodes`):

| kind | what the engine does |
|---|---|
| `task` | creates an org task through `OrgTasksService.create` (lane → assignee, brief from the template with `${vars}`, MUST/SHOULD/MAY items as the checklist, checks, class) |
| `approval` | creates a `process_gate` card routed by decision routing (the run owner's manager; `approver: ceo` is CEO-reserved); the outcome (approved / rejected) becomes a variable |
| `wait` | a timer (`waitHours`) the minute tick resolves |
| `subprocess` | a child run of another process, pinned to its own active version; the child's variables flow back |
| `meeting` | a meeting of `meetingKind` (planning, standup, weekly_review, retro, board, adhoc) through the meeting runtime, in the owning unit's channel, facilitated by its lane, attended by `attendees` (lanes; `unit` = the owning unit), its agenda `agenda` plus the outputs of earlier steps; done when the meeting ends, its minutes' accepted decisions and actions becoming `<step>_decisions`, `<step>_actions`, `<step>_summary`; a cancelled meeting fails the step |

A step's **lane** is a role, never an agent: `owner` (the process owner —
the owning unit's head, or the chief for company processes), `chief`,
`head`, `initiator`, or a title matched against the members (in the owning
unit first), or `provider` — the department and role a service request names
in the run's variables (docs/services.md). Processes survive hires,
terminations and reorgs.

**Categories.** `operating` processes run the company itself (incident
response, the chief's sweep, request intake, the review pack); their tasks
go to the owning unit's Operating project and are not demoted by its
meta-work cap. `delivery` processes serve a goal or a project. The category
travels to `OrgTasksService.create` as `process.category`, so a creation
gate keyed on goal alignment can let operating processes through.

## 2. Execution (model-free)

- **Strict stages** use token semantics with dead-path elimination
  (`strictWalk`): a step is ready when every forward incoming edge is
  resolved and at least one fired (its source done and its `when` holds);
  when none fired it is skipped, so a branch not taken never leaves a join
  waiting. Edge conditions: `var == value`, `var != value`, `var`, `!var`.
- **Loops are bounded.** An edge that closes a loop must carry `loopMax`
  (at most `process.loopMaxCeiling`); firing it resets the loop's steps
  (their attempts stay as history and count as rework) and starts the next
  attempt. Exhausting it blocks the run and raises a `process_gate`
  escalation: approve for one more round, reject to stop the run.
- **Dynamic stages** materialise one coordinator task (`@<stage>`) for the
  run owner. Its step card lists the available steps; `org_step_choose`
  starts one as its own task (a subtask of the coordinator, assignable to
  another lane); an ad-hoc step is allowed when `process.adHocSteps` is 1
  and logged as a deviation. `org_process_next finish=true` closes the
  stage — refused, with what is missing, while a required checkpoint is
  undone or a step is still under way.
- **Versions.** A run is pinned to the version it started on. A run in a
  dynamic stage adopts the newest version at its next choice when the new
  version still has its stage and every step it has done
  (`canAdopt`; otherwise it stays and logs `version_kept`).
- **SLAs.** A task step's SLA (`slaHours`, else `process.defaultSlaHours`)
  is watched by the minute tick; past it, `process.slaAction` 1 escalates the
  task up its performer's line (an escalation card through decision
  routing), 0 nudges the performer and tells the owner.
- **Failure.** A cancelled step task fails the step; `maxAttempts` retries
  it; an optional step of a dynamic stage may fail without failing the run;
  otherwise the run fails and its owner is told.
- **Compensation (a saga).** A step with an outside side effect names a
  `compensate` step — a node marked `compensation: true`, outside every
  stage's walk, never on an edge. When a run fails or is cancelled, the
  compensations of its done steps run one at a time, the latest completion
  first, each an ordinary task (`undo:<step>`, its lane, its MUST items as
  the checklist, the brief saying what to undo). The run keeps its status;
  `compensation` reads running → done, or partial when one could not be done
  (its task cancelled), and the owner is told what to undo by hand.
  Model-free and keyed like every step; the sweep resumes a saga after a
  restart.
- **Idempotency and restarts.** Materialising inserts the step row first
  (`ON CONFLICT DO NOTHING` on run/node/attempt), then creates the task, card,
  timer or child. The sweep (every five minutes, and so on the first ticks
  after boot) reconciles every open run: a row a restart left without its
  task finds the orphan task (`processRunId`/`processNodeId`) or creates it,
  a task that finished while the server was down settles its step, and the
  run advances. A meeting step's meeting is keyed `createdBy process:<step>`,
  so a restart adopts it. Work triggered by a transition or a decision runs
  per run in order, off the caller's path.

## 3. The step card and the gates

When a run works a process task, the tools provider puts the **step card**
in the context (no prompt change in the runtime): the process and version,
the run, stage n of m and step n of m, why the step exists, the inputs
earlier steps produced (outputs by name, with the step they came from), the
MUST / SHOULD / MAY items (at most nine) with their checklist ids, the
outputs to record, the denied tools, the playbook to load for detail, and
the exit. The coordinator's card lists the available steps, those under
way and the checkpoints left.

- **MUST** items are the task's checklist (`from: process:must`). Handing
  the task to review with one open — or *dropped* without a waiver — or with
  a required output unrecorded is refused with remediation: which item,
  `org_task_steps done=<id>`, `org_step_output {name, value}`, or
  `org_process_deviate level=must` (`process.mustEnforcement` 1). At 0 the
  hand-off goes through and is logged as a MUST deviation.
- **SHOULD** items are skipped only with `org_process_deviate level=should`
  (the reason and the alternative): logged on the step, the run goes on.
- **MUST waivers** are `process_deviation` cards to the performer's manager
  (decision routing); approved, the item is waived and the gate passes;
  rejected, the performer is told to meet it.
- **Denied tools** (`deny` on a step) are refused when called during the
  step's run (`ToolProviderHook.refuseCall`), with what to do instead; the
  turn goes on.

## 4. Lifecycle: templates, edits, rollback

Processes start from the **library** (`process-templates.ts`): the chief's
daily sweep (`chief-daily-ops`, started by the chief's weekday sweep loop),
incident response (on a major incident), the cross-function request (the
chief's triage of an ask that names no service), the service-request intake
(accept → do → deliver, the default process of a catalog service;
docs/services.md), the weekly
review pack (`weekly-review-pack`, started by the chief's weekly pack loop),
release checklist, content publishing (with a bounded review loop), hiring
loop and customer onboarding. A company gets them at **onboarding** (the
ones every company runs, plus the function templates whose function it has),
at **kit install** (each kit `rhythm` line maps to a template by words:
"release checklist before each release" → `release-checklist`), on request
(`org_process_author template=…`, the page's "Add from library"), and — a
company from before processes — once on the first tick, with any cadence
triggers off.

After that a process is the company's. Every change is a new immutable
version with its author, reason and a diff against the version it replaced;
old versions stay; a **rollback** writes a new version with an older
definition; **retire** stops new runs while open ones finish. Who may change
what:

| actor | own process | another unit's / the company's |
|---|---|---|
| the chief of staff | any process (boundary `process:own`) | — |
| a head | its unit's subtree | a proposal: a CEO-reserved `process_change` card (`process:beyond`) |
| any other member | — | a proposal |
| the CEO or a board member (the page, the routes) | applies at once | applies at once |

Within its own processes an agent's edit applies at once or waits for a
`process_change` card to its manager by **`process.editApproval`**: 0 every
edit applies; 1 an edit that changes what a run must do (MUST items,
checkpoints, approval steps, strict edges, denied tools —
`touchesControls`) waits; 2 every edit waits. The validator refuses a broken
definition with each problem and its fix (an unbounded loop, more than nine
items, an edge across stages, an unknown subprocess, a bad cron, …).

### Ramped rollout

A new version of a process whose active version has a track record (at
least three finished runs) does not take every run at once: it becomes the
**candidate** and `process.rampPercent`% of new runs start on it (by a
deterministic bucket of the trigger), the rest on the stable version. The
author may choose the share (`ramp`; 0 = at once); a rollback always applies
at once. Every five minutes the two cohorts are compared
(`compareCohorts`): completion rate, median cycle time, deviation rate and
rework. Until the candidate has `process.rampMinRuns` finished runs the
verdict is *collecting*; then *rollback* when any measure is worse than the
stable one by more than `process.rampTolerance`, else *promote*. On a new
verdict the owner is told (`org_process_rollout`, the page's Promote / Roll
back) — or, with `process.rampAuto` 1, the engine applies it. Promoting
makes the candidate the active version; rolling back marks it
`rolled_back`. Runs stay pinned either way; a dynamic run adopts only a
newer active version.

## 5. Triggers

| trigger | fires |
|---|---|
| `manual` | `org_process_start`, `POST …/processes/:id/runs`, a loop prompt |
| `cadence` | the minute tick, once per cron match (catching up six hours after a restart), deduped by `cadence:<minute>` |
| `event: incident_opened` | an incident at or above `severity` (TriggerBus), once per incident |
| `event: project_now` | a project active in Now since the version's activation, once per project (its tasks go under it) |
| `event: task_created` | a task of `class` created since the version's activation (not a process task), once per task |
| `service_request` | `OrgProcessesService.startServiceRequest` — called by the service catalog (docs/services.md) with the service's linked process; uncapped by `process.maxActiveRuns` (the service admits its requests) |

`process.maxActiveRuns` caps open runs per process; a trigger beyond it is
skipped and logged.

## 6. Metrics and review

Per process over its last `process.metricsWindowRuns` runs: runs (open, done,
failed, cancelled), completion rate, median cycle time, deviation rate and
rework per step (an attempt after a loop, or a task that needed review
rounds), SLA breaches, and a health verdict — **revise** when a step with
enough runs deviates at or above `process.reviseDeviationRate` (a standard
nobody follows is the standard's problem) or fewer than half the finished
runs completed; **watch** on failures, SLA breaches or heavy rework. The
owner's `org_process_metrics` records a review; past
`process.reviewCadenceDays` the chief's and the head's context lists the
process as due, and a process to revise or a pending version as attention.

**Conformance** is a separate question from outcomes — did the runs follow
the definition (`computeConformance`)? Of the steps the window's runs
executed, a step conforms unless it was handed to review with a MUST item
open (logged where `process.mustEnforcement` is 0), skipped a SHOULD item,
was an ad-hoc step of a dynamic stage, or started in a strict stage before a
step it waits on had finished. MUST waivers are sanctioned exceptions:
counted, not against it. The verdict is *drifting* below
`process.conformanceAlert`; the owner's context then says so on its own
line, and the page has a Conformance tab beside Outcomes. A step that
deviates in `process.reviseDeviationRate` of at least three runs becomes a
**revision suggestion** for the owner (a "Revise process: …" task with the
deviations as evidence), once per version and step.

## 6b. Discovery from experience

Model-free, every few hours (`discover`; `process-discovery.ts`): the last
`process.discoveryWindowDays` days of tasks (not process tasks) and the
ad-hoc steps of process runs are mined for work that repeats without a
process — the same title stem on at least two days (*recurring*), the same
sequence of tasks by dependency or next sibling across chains
(*sequence*), the same request made of one department by members of
others, not handed down the line (*cross_function*), and the same ad-hoc
step in run after run of one process (*adhoc_step*). A pattern seen
`process.discoveryRepeats` times that no process covers becomes one
suggestion (`org_process_suggestions`, keyed by the pattern; a dismissed one
stays dismissed; at most six open) for its owner — the head of the
department the work lands in, else the chief — with the evidence and a
drafted definition (a strict chain of the steps seen, in the lanes the work
went to; a cross-function pattern drafts an intake with triage, the work and
a hand-back, started by a service request). The owner gets an ordinary
"Draft process: …" task: an agent refines the draft and authors it, or
cancels the task with why — the engine never calls a model.
`submitSuggestion` is the one place a suggestion becomes the owner's work;
when improvement proposals (`createProposal`) exist, it routes there
instead. The CEO may also create the process from the draft, or dismiss it,
on the page.

## 7. Tunables (per company, derived from its profile)

| key | default | what |
|---|---|---|
| `process.mustEnforcement` | 1 | 1 refuse review with an open MUST item; 0 log it |
| `process.editApproval` | 1 | 0 edits apply; 1 control changes wait for the manager; 2 every edit waits |
| `process.reviseDeviationRate` | 0.3 | a step's deviation rate that flags the process for revision |
| `process.metricsWindowRuns` | 20 | recent runs the metrics cover |
| `process.maxActiveRuns` | 5 | open runs per process |
| `process.slaAction` | 1 | 1 escalate a step past its SLA; 0 nudge |
| `process.defaultSlaHours` | 0 | SLA for a step that sets none |
| `process.loopMaxCeiling` | 5 | the highest loopMax |
| `process.adHocSteps` | 1 | whether a dynamic stage may add an ad-hoc step |
| `process.reviewCadenceDays` | 14 | days between an owner's process reviews |
| `process.rampPercent` | 25 | % of new runs a new version starts on while compared; 0 = at once |
| `process.rampMinRuns` | 5 | finished candidate runs before a ramp verdict |
| `process.rampTolerance` | 0.1 | how much worse a candidate may be before the verdict is roll back |
| `process.rampAuto` | 0 | 1 the engine applies a ramp verdict; 0 the owner does |
| `process.discoveryRepeats` | 4 | repeats before repeated work is suggested as a process; 0 = off |
| `process.discoveryWindowDays` | 30 | the task history discovery reads |
| `process.conformanceAlert` | 0.7 | share of steps that must follow the definition before the owner is alerted |

None is a fixed rule: onboarding derives them from the company's values and
culture (`deriveProcessTunables`, through `deriveOperatingSystem`; the
starter blueprints carry the derived values). A hierarchy approves every edit,
blocks on MUST items, runs only defined steps and reviews monthly; an
adhocracy that values speed logs open MUST items, edits freely and allows
more loop rounds and ramps fast (the engine applying the verdict); rigour
widens the metrics window, tightens loops, ramps on a fifth of runs and
alerts on small drift; a young company activates new versions at once (too
few runs to compare).
Changing a `process.*` tunable is itself a proposal (boundary row
`tunable:process.`).

## 8. Tools (agents)

| tool | who |
|---|---|
| `org_processes` (library=true: the templates; suggestions=true: the suggestions with drafts), `org_process`, `org_process_run`, `org_process_metrics` (outcomes, conformance, a ramp's comparison) | every member (read) |
| `org_process_start` | every member |
| `org_process_next` (finish=true), `org_step_choose` | the performer of a dynamic stage, the owner, the chief |
| `org_step_output`, `org_process_deviate` | the step's owner |
| `org_process_author`, `org_process_rollback`, `org_process_retire` (restore) | the chief (any), a head (its unit's); others propose |
| `org_process_cancel` (then the saga) | the process owner, the chief |
| `org_process_rollout` (promote, rollback, percent) | the process owner |

The chief's pack has a `processes` skill (author, run, review, improve);
every member carries the built-in `org-processes` skill (perform a step,
choose in a dynamic stage, and — for heads — own their unit's processes).

## 9. Routes and the page

```
GET    /api/workspaces/:id/org/processes                      list + open runs
GET    /api/workspaces/:id/org/processes/templates            the library (each with its definition, for the preview)
GET    /api/workspaces/:id/org/processes/:pid                 definition, versions (diffs), runs (steps), events
POST   /api/workspaces/:id/org/processes                      { template? | def?, name?, unitId?, reason }
PUT    /api/workspaces/:id/org/processes/:pid                 { def, reason } — a new version
POST   /api/workspaces/:id/org/processes/:pid/rollback        { version, reason }
POST   /api/workspaces/:id/org/processes/:pid/retire          { reason, restore? }
POST   /api/workspaces/:id/org/processes/:pid/runs            { title?, vars? }
POST   /api/workspaces/:id/org/processes/runs/:runId/cancel   { reason }
POST   /api/workspaces/:id/org/processes/:pid/rollout         { action: promote | rollback | percent, percent?, reason? }
POST   /api/workspaces/:id/org/processes/suggestions/:sid     { action: accept | dismiss, reason? }
```

Writes are the CEO's or a board member's. On screen: **Operations ›
Processes** (`/<company>/operations/processes`) lists every process with its
mode, owner, version, triggers, runs and health, the open runs, and the
library; a process's page (`/<company>/processes/<id>`) shows its stages as
a graph (strict: columns in the order the engine walks them, loops as
"back to"; dynamic: each step with when it is available and its
checkpoints), the metrics, the runs with each step's state and task, and
the versions with their diffs and "Roll back"; the CEO edits the
definition (with a ramp share), starts a run and retires it there. Meeting
steps say what they hold and who comes; the compensations are listed as
"If a run fails or is cancelled"; a run being undone says so. Outcomes and
Conformance are two tabs; a ramp shows both cohorts side by side with the
verdict and Promote / Roll back; a revision suggestion shows on its
process. The list carries "Suggested from repeated work" (evidence, the
drafted steps, the owner's task, Create from the draft, Dismiss). The
Operations dashboard has a Processes card.

The graph (`src/components/ProcessGraph.tsx`) stacks the stages in order;
inside each, a row per role (swimlanes — roles, never agents) and the
engine's columns, with arrows: solid for an edge, dashed when it holds only
on a condition (said on the step: "Only if answer is accepted"), dotted for
a dynamic step's "available after", a loop curving back underneath with its
bound. A step card shows its kind, MUST items, checkpoint, timer or SLA,
outputs, whether it can be undone, and its deviation rate; clicking it opens
its detail. The newest open run is laid over the graph (each step's state;
"Show" picks another run or the definition only), and each run reads as a
timeline of its steps, with the deviations in full and the steps not
reached yet. Too narrow for the lanes, the graph becomes a vertical list.
Every decision on the page (dismiss, retire, cancel, promote, roll back)
asks why inline. The library is a dialog whose templates preview their
graph; the editor previews the definition as it is typed; starting a run
asks for each `${input}` the steps use.

## 10. Not built yet

The service catalog is built (docs/services.md). Still open: routing
suggestions through improvement proposals (docs/improvements.md;
`submitSuggestion` is the switch to `createProposal`); an LLM-free merge of
a suggested missing step into the definition (the owner writes it today).
