# Task execution: one task, several sessions

*Status: built (migration `0098-task-plans`). Design source:
`reports/Process abstractions for agent companies.md` and its research notes
(`agent_process_engines.md`, `agent_specific_controls.md`). Related:
[processes](processes.md) (the engine whose model a plan reuses),
[work tracking](work-tracking.md) (the task a plan belongs to),
[actions and trust](actions-and-trust.md) (the gates every worker call passes).*

A run used to be one session doing one task. Some tasks are too big for
that: the brief is long, the done-when list has many independent parts,
earlier runs made no progress, or the context fills up and compaction blurs
what was decided. The agent performing such a task can now split it into a
**plan** — a mini workflow that lives inside the one task and its sessions,
never on the board — and run it across several sessions.

Code: `server/src/org/task-plan-model.ts` (pure: the plan as a process
definition, validation, readiness, effort scaling, exit checks, the texts),
`task-exec-tunables.ts`, `task-plan.service.ts` (storage, the worker
executor, handoffs, restart release), `task-plan.tools.ts` (the four tools,
the plan and step card in context, worker refusals), `task-plan.controller.ts`
(read routes); on screen `src/components/TaskPlanPanel.tsx` with
`src/lib/task-plans.ts`, in the task drawer, the Work log and the chat.

## 1. The plan

```
task_plans          one per task (scopeKey task:<orgTaskId> | chat:<sessionId>): mode, current version (def JSON), totals, idle rounds, the lead session
task_plan_steps     (plan, step) UNIQUE — status, attempts, the session that worked it, output, criteria with evidence, cost
task_plan_sessions  the session tree: master | lead | worker, parent, depth, status, model, tokens, USD
task_plan_entries   append-only: version (def, reason, diff), decision (the shared log), handoff (the packets), event
```

A plan is a [process](processes.md) definition with one stage: each step is
a node, `dependsOn` are its edges. A **strict** plan is walked by the
engine's own `strictWalk` (a step is ready when what it depends on is done
or skipped); a **dynamic** plan uses `dynamicAvailable` — the master picks
among the available steps and may add steps as it goes. Validation is
`validateProcess` plus what a plan needs: exit criteria on every step, known
dependencies, no cycle (a plan never loops: the master redoes a step). Every
revision is a new version with its reason and a diff; a running step cannot
be changed and a done one cannot be removed.

Each step carries: `goal`, `inputs` (what it needs beyond the outputs of the
steps it depends on, which come automatically), `exit` (the criteria the
result is checked against), `dependsOn`, `parallel` (true only for read and
research work that touches nothing shared; writes and decisions run alone),
`tier` (cheap | standard | strong) and `effort`.

## 2. Three modes

| mode | who does the steps | when |
|---|---|---|
| **single** | the session itself; each step recorded with `task_step_result` | the plan is a checklist with evidence |
| **sequential** | the session, then a fresh one per handoff | long work whose steps depend on each other (writes, decisions) |
| **orchestrated** | worker sessions started by the master | breadth: independent research, sizing, gathering |

**Sequential.** At a step boundary, or when the context nears
`exec.handoffAt` of its ceiling (the context says so), the session writes a
**handoff packet** with `task_handoff`: state (what is done and where),
decisions, artifacts, open questions, the next action. On a company task the
run ends, the run-end hook wakes the task, and the next run continues in a
fresh session (`Org · <company> · <task> · part n`, linked to the task)
whose context re-grounds it — identity and authority (the run context),
the brief, the plan and the packet, once. This replaces relying on
compaction for long tasks; compaction stays the safety net. A packet that
says the same as the previous one is refused (no progress). A person's own
chat cannot hand off — the person is in it — so a chat runs long work as
steps instead.

**Orchestrated.** The session that owns the plan is the **master**.
`task_step_run` claims each ready step (one conditional update: no step runs
twice), starts a fresh **worker** session per step and waits:
parallel-safe steps side by side up to `exec.maxParallel`, the others one at
a time. A worker is the same agent with the same permissions; its context is
only its step card — goal, inputs, the outputs of its dependencies, the
decision log, the exit criteria, the master's note on a redo — and one
prompt, never the master's history. It reports with `task_step_result`
(each criterion met with evidence); a worker running out of room hands off
to a fresh worker for the same step. The result comes back to the master
with its exit check: done only when every criterion is met with evidence and
there is an output. The master verifies (accept, `review redo` with a note,
or skip), revises the plan, and integrates the result itself.

**The decision log.** Decisions every session must honour — formats, names,
scope, the approach chosen — are recorded by the master (`task_plan
decide`) and by sequential steps; every worker's card lists them. A parallel
worker's decisions come back as *proposals* the master adopts or not: workers
side by side never set direction for each other (Cognition, "Don't build
multi-agents": parallel workers make conflicting implicit decisions — share
the decisions, keep interdependent writes sequential).

## 3. Guardrails

All of them are company tunables (`exec.*`, area `execution`, derived at
onboarding from the operating profile — speed fans out wider, rigour hands
off earlier and retries less, an early company keeps the caps small); a
personal agent outside a company gets the defaults.

| tunable | default | binds |
|---|---|---|
| `exec.maxSessions` | 12 | sessions per plan (continuations and workers) |
| `exec.maxParallel` | 3 | workers at once (parallel-safe steps only) |
| `exec.maxDepth` | 1 | only the master starts workers (2: a worker may, for other steps of the same plan) |
| `exec.maxSteps` | 12 | steps per plan (a small task: 3) |
| `exec.planUsdCap` / `exec.planTokenCap` | $5 / 3M | what the plan's sessions may spend |
| `exec.handoffAt` | 0.7 | context share at which a session is told to hand off |
| `exec.stepAttempts` | 2 | attempts at a step before the master must revise |
| `exec.idleRounds` | 2 | step rounds that finish nothing before the plan blocks |
| `exec.splitBriefChars`, `exec.splitCriteria`, `exec.splitSteps`, `exec.orchestrateMinSignals` | 2500, 4, 4, 2 | effort scaling |

- **Effort scaling, model-free.** The signals are a long brief (or request),
  many done-when criteria, earlier runs without progress, a context near its
  ceiling and many steps. Orchestration needs `exec.orchestrateMinSignals`
  of them; a task with none is held to three steps. The context shows the
  suggestion only when there is a sign of size. Evidence: Anthropic's
  research system found parallel subagents up to ~90% faster on breadth
  tasks at ~15x the tokens of a chat, and its early versions spawned dozens
  of subagents for simple queries — scale the effort to the task.
- **Budgets.** A company task's workers reserve their estimate against the
  agent → project → company envelopes before each session and settle from
  the usage, like any run; the plan's own USD and token caps bind on top. A
  workspace over its spend stop refuses worker turns like any loop turn.
- **The same gates.** Workers run `loop` turns: outward and mutating calls go
  through the action contract, trust, the policy stage and the reviewer
  exactly as any background run's; held actions land in the inbox. On a
  company task a worker runs under the task's run context (the kill switch,
  the same-call loop breaker, the org tools, the process step card), but the
  master's tools are refused in it — `org_request_review`, `org_review`,
  `org_assign`, `org_create_task`, a status change, `task_plan`.
- **Breakers across sessions.** Attempts per step; idle rounds block the
  plan; a repeated handoff is refused; the task's own no-progress back-off
  and circular-behaviour pause still watch its runs (a handoff or a finished
  step counts as progress).
- **WIP stays per task.** Workers are sessions, not board tasks: nothing is
  created on the board, no claim or WIP slot is taken.
- **Model per step.** A step's tier goes through one function,
  `resolveStepModel` (task-plan.service.ts): the company's routing and the
  agent's type resolve it as a task class does, no tier inherits the
  master's model, the CEO's pin on the agent wins. Automatic model selection
  by task complexity plugs in there.
- **Step size.** Steps are sized to what one session does reliably (METR's
  reliability horizon), and every session is re-grounded rather than
  carrying a drifting long context.

## 4. Restarts

Claiming a step is idempotent. On boot the recovery participant
(`task-plans`) marks the worker sessions and steps a dead process left
running `interrupted`. A company task's interrupted run is resumed by the
existing recovery (docs/architecture.md "Restarts and recovery"); its context
names the interrupted steps, and the master's next `task_step_run` resumes
each in its own worker session (its history is there; a resume is not a new
attempt). Worker sessions (`Worker · …`) are never re-run by the generic
recovery, so a step is never run twice. A person's chat shows Retry as
before.

## 5. On screen

The task drawer, each run in the Work log and a chat with a plan show the
**plan panel** (`TaskPlanPanel.tsx`). Its header is the glance: mode,
status, failed steps, a progress bar, steps done, sessions and cost. Open,
it shows the sessions and cost against the caps, then the steps grouped
into **stages** — a step's stage is one past its latest dependency, so the
steps of a stage can run side by side — each row with its status, id,
title, dependencies, attempt, criteria met, tier and cost, opening to its
goal, exit criteria with evidence, model, notes and output. Tabs hold the
session tree (master → workers, lead → continuations, each worker's
transcript collapsed until opened — like tool calls and thinking), the
decision log, the handoff packets and the versions.

## 6. The tools

| tool | who | does |
|---|---|---|
| `task_plan` | the master (any agent session) | show; create or revise (a version); `decide`; `review` accept / redo / skip; `status` done / abandoned |
| `task_step_run` | the master (a worker only below `exec.maxDepth`) | run ready steps in worker sessions and wait |
| `task_step_result` | a worker (its step) or the master (a step it did) | output, criteria with evidence, decisions, questions, artifacts |
| `task_handoff` | a company task's session, or a worker | the packet a fresh session continues from |

All four are internal work (no approval of their own); the skill
`plan-big-tasks` says when to split and when not to, and the member workflow
points to it.
