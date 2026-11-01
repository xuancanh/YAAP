# Evals and gated rollout

*Execution-plan item 31; capability C6 in
`docs/autonomous-org-first-principles.md`. Shipped 2 November 2026.*

A charter edit, a new playbook version, a cheaper model or a routing change
alters how a member does its work. Before this item nobody checked such a
change against work the member had already done well. Now each role keeps a
**golden set** of past tasks with known-good outcomes. A candidate change is
replayed against that set, in a sandbox, before it rolls out, and a
regression blocks it.

Code:

- `server/src/org/org-evals.service.ts` — `OrgEvalsService`
- `server/src/org/org-governance.tools.ts` — the tools
- `server/src/org/governance.controller.ts` — the routes

Tables (migration `0044-org-evals-boundary`):

- `org_eval_cases`
- `org_eval_runs`

## 1. Golden sets

A case belongs to a **role**. The role key is the member's title as a slug,
for example `writer`; a member without a title falls back to its agent id.

Cases are **harvested** automatically when a task is accepted
(`OrgTasksService.onAccepted`):

- by its checks (item 27). The case keeps the checks;
- by review within `evals.harvestReviewMaxRounds` request-changes rounds.
  The default is 0: accepted the first time, which is the strong verdict.
  The case keeps `done_when` as its rubric.

The snapshot holds the title, the four-field brief, the checks, the class
and the paths the task named. At most `evals.casesPerRole` live cases are
kept per role (default 20). Harvesting is idempotent per task.

The **CEO** adds a case by hand (`POST …/org/evals/cases`), from a task id or
from a written snapshot, and retires a case (`DELETE …/org/evals/cases/:id`).
Agents cannot do either: the cases are the yardstick (the `eval_cases` row of
`docs/boundary.md`).

## 2. A run

`run(orgId, { roleKey, candidate })` takes a candidate:

```
{ kind: 'charter' | 'playbook' | 'model' | 'routing', ref, before, after }
```

`before` is filled from the live configuration when it is left out. A run:

1. picks the role's newest `evals.casesPerRun` cases (default 5);
2. reserves `evals.runUsdCap` (default $1) against the member's and the
   company's envelopes, through the runtime's `reserve` and `settle`. A
   refused reservation is a `failed` run with verdict `inconclusive` and an
   `eval_refused` audit row;
3. runs the **baseline**: the same cases on the current configuration. The
   baseline is cached per version hash (role, kind, ref, `before`, case ids)
   for `evals.baselineCacheDays` (default 7);
4. runs the **candidate** and compares. The verdict is `regress` when the
   candidate's pass rate is below the baseline's by more than
   `evals.regressionMargin` (default 0.1). Otherwise it is `pass`, or
   `inconclusive` when nothing could be graded.

**One case** is a throwaway session of the member's own agent, so it has the
same tools. The session is **record-only** through
`TurnLoopService.setSandbox`, the path the red-team runs of item 29 use:

- every tool call goes to the recorder before the contract, the reviewer,
  the loop queue and connection routing;
- nothing executes, queues or leaves the company;
- the session is deleted afterwards.

The candidate charter or playbook rides in the run's context (an aux run of
the runtime). The model, or the tier's model for a routing candidate, rides
on the session. Cases past the USD cap are recorded as `skipped`.

**Grading** works as follows:

- File checks (`file_exists`, `file_matches`) are graded without a model,
  against the recorded `fs_write` calls.
- When every check is a file check, the checks settle the case.
- Other checks (metric, HTTP, connection) cannot be run against a sandbox.
  These, and a case with only a rubric, go to the independent reviewer on
  another model family (`OrgRuntimeService.judge`, the same seam as the
  task check). Allow is a pass, deny is a fail, and ask is not graded.

## 3. The gate

Three paths replay first when `evals.gate` is 1 (the default):

- **Charter change.** The `charter_change` card from item 22 (a retro
  proposal) runs through `OrgApprovalsService.onBeforeApply`.
- **Routing change.** This covers the chief's `org_set_routing` in
  autonomous mode (`OrgRuntimeService.setRolloutGate`) and an approved
  `routing` card. The role checked is the one whose golden set covers the
  task class best.
- **New playbook version.** On review acceptance, version 2 and later
  replay against the first role among its roles that has cases
  (`OrgPlaybooksService.setActivationGate`). `before` is the live skill's
  body.

A **regression** blocks the change. A card stays pending with `eval` (the
run id, the verdict and the rates) attached to its payload, and an
`eval_blocked` row is audited. Approving the same candidate again is
refused without a rerun. A blocked playbook version stays a draft and its
owner is told. For routing, the tool is refused.

A **pass**, or a role with no golden set yet, lets the existing path
continue. The result is attached for the owner to read.

## 4. Tools and routes

| Tool | Who | What |
|---|---|---|
| `org_eval_role {roleKey, candidate}` | the chief | runs and returns the verdict with each case's result. It changes nothing. |
| `org_eval_cases {roleKey?}` | the chief, unit leads | reads the golden set |

| Route | Who |
|---|---|
| `GET …/org/evals/cases?roleKey=` | anyone with standing |
| `POST …/org/evals/cases` | the CEO |
| `DELETE …/org/evals/cases/:caseId` | the CEO |
| `POST …/org/evals/run {roleKey, candidate}` | the CEO |
| `GET …/org/evals/runs?roleKey=` | anyone with standing |

## 5. Departures

- **The member's copy.** "A copy of the member" is the member's own agent in
  a throwaway, sandboxed session. The candidate charter is given in the run
  context as the charter that replaces its own. No temporary agent is
  created, so no agent cap or heartbeat is touched.
- **Strong verdict.** "A strong reviewer verdict" is measured without a
  model: accepted within `evals.harvestReviewMaxRounds` rounds. Review notes
  carry no score.
- **Sandbox checks.** Metric, HTTP and connection checks are graded by the
  rubric grader, with the check written into the rubric, because a sandbox
  cannot move the world they read.
- **Model changes.** A model change for a role is evaluated on demand
  (`org_eval_role`, `POST …/evals/run`). The CEO pinning a model on an agent
  is not gated: the CEO is not bound.
