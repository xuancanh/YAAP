# Processes: standing procedures whose steps are tasks

*Status: built (migration `0095-processes`). Design source:
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
availability, the step card, metrics), `process-templates.ts` (the
library), `process-tunables.ts`, `org-processes.service.ts` (the engine),
`org-processes.tools.ts` (agent tools, the step card in context, denied
tools), `processes.controller.ts` (routes); the page is
`src/components/OrgProcessesView.tsx` with `src/lib/processes.ts`.

## 1. The model

```
org_processes          header: name (slug), title, category, owning unit, status, the active version
org_process_versions   immutable: the definition JSON, author, reason, diff, status active|superseded|pending|rejected
org_process_runs       PR-n, pinned versionId, stage, owner, trigger + triggerRef (dedupe), vars, loop counters
org_process_steps      (run, node, attempt) UNIQUE — task | approval | wait | subprocess | stage (a dynamic stage's coordinator)
org_process_events     append-only: started, materialized, step_done, skipped, looped, deviated, version_adopted, …
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

A step's **lane** is a role, never an agent: `owner` (the process owner —
the owning unit's head, or the chief for company processes), `chief`,
`head`, `initiator`, or a title matched against the members (in the owning
unit first). Processes survive hires, terminations and reorgs.

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
- **Idempotency and restarts.** Materialising inserts the step row first
  (`ON CONFLICT DO NOTHING` on run/node/attempt), then creates the task, card,
  timer or child. The sweep (every five minutes, and so on the first ticks
  after boot) reconciles every open run: a row a restart left without its
  task finds the orphan task (`processRunId`/`processNodeId`) or creates it,
  a task that finished while the server was down settles its step, and the
  run advances. Work triggered by a transition or a decision runs per run in
  order, off the caller's path.

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
incident response (on a major incident), the cross-function request (with
a `service_request` trigger for the service catalog to come), the weekly
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

## 5. Triggers

| trigger | fires |
|---|---|
| `manual` | `org_process_start`, `POST …/processes/:id/runs`, a loop prompt |
| `cadence` | the minute tick, once per cron match (catching up six hours after a restart), deduped by `cadence:<minute>` |
| `event: incident_opened` | an incident at or above `severity` (TriggerBus), once per incident |
| `event: project_now` | a project active in Now since the version's activation, once per project (its tasks go under it) |
| `event: task_created` | a task of `class` created since the version's activation (not a process task), once per task |
| `service_request` | `OrgProcessesService.startServiceRequest` — the hook a service catalog will call |

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

None is a fixed rule: onboarding derives them from the company's values and
culture (`deriveProcessTunables`, through `deriveOperatingSystem`; the
starter blueprints carry the derived values). A hierarchy approves every edit,
blocks on MUST items, runs only defined steps and reviews monthly; an
adhocracy that values speed logs open MUST items, edits freely and allows
more loop rounds; rigour widens the metrics window and tightens loops.
Changing a `process.*` tunable is itself a proposal (boundary row
`tunable:process.`).

## 8. Tools (agents)

| tool | who |
|---|---|
| `org_processes` (library=true: the templates), `org_process`, `org_process_run`, `org_process_metrics` | every member (read) |
| `org_process_start` | every member |
| `org_process_next` (finish=true), `org_step_choose` | the performer of a dynamic stage, the owner, the chief |
| `org_step_output`, `org_process_deviate` | the step's owner |
| `org_process_author`, `org_process_rollback`, `org_process_retire` (restore) | the chief (any), a head (its unit's); others propose |
| `org_process_cancel` | the process owner, the chief |

The chief's pack has a `processes` skill (author, run, review, improve);
every member carries the built-in `org-processes` skill (perform a step,
choose in a dynamic stage, and — for heads — own their unit's processes).

## 9. Routes and the page

```
GET    /api/workspaces/:id/org/processes                      list + open runs
GET    /api/workspaces/:id/org/processes/templates            the library
GET    /api/workspaces/:id/org/processes/:pid                 definition, versions (diffs), runs (steps), events
POST   /api/workspaces/:id/org/processes                      { template? | def?, name?, unitId?, reason }
PUT    /api/workspaces/:id/org/processes/:pid                 { def, reason } — a new version
POST   /api/workspaces/:id/org/processes/:pid/rollback        { version, reason }
POST   /api/workspaces/:id/org/processes/:pid/retire          { reason, restore? }
POST   /api/workspaces/:id/org/processes/:pid/runs            { title?, vars? }
POST   /api/workspaces/:id/org/processes/runs/:runId/cancel   { reason }
```

Writes are the CEO's or a board member's. On screen: **Operations ›
Processes** (`/<company>/operations/processes`) lists every process with its
mode, owner, version, triggers, runs and health, the open runs, and the
library; a process's page (`/<company>/processes/<id>`) shows its stages as
a graph (strict: columns in the order the engine walks them, loops as
"back to"; dynamic: each step with when it is available and its
checkpoints), the metrics, the runs with each step's state and task, and
the versions with their diffs and "Roll back"; the CEO edits the
definition, starts a run and retires it there. The Operations dashboard has
a Processes card.

## 10. Not built yet

Meeting steps, compensation steps, ramped rollout of a new version, process
discovery from recurring free-form tasks, and the service catalog (the
`service_request` trigger is the hook) — the report's later phases.
