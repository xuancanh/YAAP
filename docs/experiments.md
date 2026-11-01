# Experiments, the prediction ledger and reconciliation

*Execution-plan item 30; capabilities C5, C7 and the rest of C9 in
`docs/autonomous-org-first-principles.md`. Shipped 2 November 2026.*

Principle 5 says every change is a hypothesis with a predicted effect.
Principle 1 says a claim is a hypothesis until a sensor confirms it. Before
this item, the company could change its tunables, cadences, routing,
playbooks, charters and structure, but nothing measured whether a change
helped. Members' estimates were never checked against what happened, and
the auditor read only the record the doers wrote. This item adds three
loops, and none of them calls a model:

- **Experiments** (C5): a change is declared with a metric, a direction, an
  expected effect, a window and a revert rule. The system applies it,
  measures it against a baseline taken from metric samples, and then keeps
  it, reverts it or extends it.
- **The prediction ledger** (C7): forecasts are recorded, resolved from the
  record and scored. Each member gets a calibration score. The trust ledger
  (item 28) uses that score when it decides on a promotion.
- **Reconciliation** (C9): every day, what members claim is compared with
  ground truth. Each gap becomes a signal, a minor incident, or both. The
  auditor's sample includes the gaps.

Code:

- `server/src/org/org-experiments.service.ts`
- `server/src/org/org-predictions.service.ts`
- `server/src/org/org-reconciliation.service.ts`
- `server/src/org/calibration-registry.ts`
- `server/src/org/experiment-tunables.ts`
- `server/src/org/experiments.controller.ts`

Migration `0043-org-experiments` adds two tables, `org_experiments` and
`org_predictions`.

## 1. Experiments

### 1.1 The record

`org_experiments` has these columns:

- `title`, `hypothesis`, `unitId`
- `changeKind`: `tunable`, `cadence`, `routing`, `playbook`, `charter`,
  `structure` or `other`
- `change` (JSON `{ apply, revert }`)
- `metricSourceId`, `direction` (`up` or `down`), `expectedEffect`,
  `effectKind` (`relative`, where 0.2 means +20 %, or `absolute`)
- `windowDays`, `design` (`before_after` or `slice`) and `slice`
- `baseline` (`{ mean, n, sd, from, to }`)
- `result` (`{ mean, n, sd, delta, relative, threshold, verdict, expected,
  met, note?, revertApprovalId? }`)
- `status`: `proposed`, `running`, `extended`, `kept`, `reverted` or
  `abandoned`
- `revertRule` (`{ worseBy, relative }`; the default is 10 % worse than the
  baseline), `extensions`
- `proposedBy`, `approvalId`, `changeApprovalId`
- `startedAt`, `endsAt`, `lastCheckAt`, `decidedAt`, `decisionId`

### 1.2 Proposing

The chief and unit leads propose with `org_propose_experiment`. A lead
proposes only for its own unit. The CEO proposes with `POST …/org/experiments`.

A proposal is validated before it is stored:

- **A measured metric.** This is a live metric source, or a key result
  bound to one. A self-reported key result is refused. Only `other` may go
  unmeasured.
- **The window** lies inside the bound of `experiments.windowDays`
  (3–90 days). The tunable's value is the default.
- **The change** is checked against its own bound:
  - `tunable {key, value}`: checked by `checkTunable`. It must differ from
    the current value and may not be an `experiments.*` key.
  - `cadence {unit, kind, cron | off}`: checked by `cadenceBoundsError`.
  - `routing {class, tier}`
  - `playbook {playbook, action}`: an experiment may only re-activate a
    *retired* playbook (one that was already reviewed) or retire an active
    one. It cannot skip review.
  - `charter {agent, text, mode}`
  - `structure {changes}`: steps are `move`, `retitle`, `pause` and
    `resume`. `terminate` is refused because it cannot be reverted.
  - `other {description}`

The proposer's expected effect is recorded as a forecast in the ledger
(§2).

### 1.3 Governance

| Mode | Tunable, cadence, routing, playbook, other | Charter, structure |
|---|---|---|
| Supervised | An `experiment` approval card; approving it starts the experiment | An `experiment` card; approving it sends the change card (below) |
| Autonomous | Starts at once, within bounds | Held in an `org_plans` row (`org_start_experiment`) for the `capital.vetoWindowMinutes` veto window, or joins the plan of the planning run it was proposed in; when the plan applies, the change goes to the CEO as a `charter_change` / `reorg` card |

A charter or structure experiment starts measuring only when the CEO
approves its change card. If the CEO rejects the card, the experiment is
abandoned. If the CEO rejects the `experiment` card, it is abandoned too.

No more than `experiments.concurrentPerUnit` experiments (default 1, bound
1–5) may run at once in one unit. Running experiments in the same unit
would mix their effects.

### 1.4 Start, measurement, verdict

**Start.** The baseline is the source's samples over the previous window.
It needs at least `experiments.minSamples` samples (default 5); with fewer,
the start is refused. Next, the change's bounds are checked again. Then the
change is applied through the same code path its tool uses, with the actor
`experiment`:

- `OrgService.setTunable`
- `OrgMeetingsService.setCadence`
- `OrgService.setRouting`
- `OrgPlaybooksService.activate` or `retire`

Before the change is applied, the revert recipe is taken from the current
state:

- for a tunable, the previous value;
- for a cadence, the previous cron, or `off`;
- for routing, the previous tier, or none;
- for a playbook, the opposite action;
- for a charter, the old charter;
- for structure, the inverse reorg steps in reverse order.

The experiment ends at `startedAt + windowDays`.

**The daily check.** Once a day, the tick compares the samples since the
start with the revert rule. The rule needs at least two samples. If the
metric is worse than the baseline by more than the rule allows, the change
is reverted at once. The verdict is `harm`, and a minor `experiment_harm`
incident about the proposer is opened through
`OrgIncidentsService.reportIncident`.

**The verdict at `endsAt`.** The window is every sample from `startedAt` to
`endsAt`, and `delta` is the difference of the means. The noise guard makes
the result `inconclusive` in either of these cases:

- either side has fewer than `experiments.minSamples` samples;
- |delta| is at most `experiments.noiseFloor` (default 1) × the baseline's
  standard deviation.

Otherwise the verdict is `improved` or `worse`, depending on the direction:

- **improved:** the experiment is kept (status `kept`).
- **worse:** the experiment is reverted automatically.
- **inconclusive:** the experiment is extended by its window, up to
  `experiments.maxExtensions` times (default 1, bound 0–3). After that it
  is reverted.

`met` records whether the measured effect reached `expectedEffect`. The
forecast's score measures how close the estimate was; keeping the change
needs only a real improvement.

A charter or structure revert creates the inverse approval card. The CEO
decides it like any other card, and its id is stored in
`result.revertApprovalId`. An `other` experiment applies nothing, so it
reverts nothing.

Every verdict does four things:

- writes an `org_decisions` row with the hypothesis and the numbers
  (baseline, window, delta, noise threshold, expected effect, met or not);
- writes an `experiment_keep`, `experiment_revert` or `experiment_abandon`
  audit row;
- sends an `org_experiment` inbox event to the chief;
- resolves the forecasts about the experiment.

The CEO can also stop an experiment (`…/stop`), or keep or revert it at
once (`…/keep`, `…/revert`). Each of these uses the same path.

### 1.5 Improvement as experiments is the default

The planning prompt (`OrgRuntimeService.planningPrompt`) and the retro
agenda (an `OrgMeetingRuntime.addAgendaProvider`) both tell the chief and
the leads to propose an experiment for any change meant to move a metric.
The retro agenda also lists running experiments and recent verdicts.

Direct changes are still allowed. The brief lists every tunable, routing or
cadence change an agent (`chief` or `agent:*`) made outside an experiment
as an **unmeasured change**.

### 1.6 The slice design

`design: 'slice'` records which units, or what share of tasks, the change
is meant for. Units are validated, and a share must be between 0 and 1.
Evaluation is still before/after on the metric, because metric sources are
company-wide. See §8.

## 2. The prediction ledger

### 2.1 Forecasts

Each `org_predictions` row has these fields:

- `agentId`
- `subjectKind`: `task`, `key_result`, `experiment`, `hire` or `other`
- `subjectId`, `question`
- `forecast`: JSON `{ kind: number | probability | duration_runs | date,
  value, low?, high?, unit? }`
- `origin`: `tool`, `checkin` or `experiment`
- `resolvesAt`, `outcome`, `resolvedAt`, `score`
- `status`: `open`, `resolved` or `void`

Forecasts enter the ledger in four ways:

- **`org_forecast_outcome`**, the tool any member can call. A newer open
  forecast with the same subject and kind supersedes the older one, which
  becomes `void`.
- **A task's first run.** The assignee's context asks once for a
  `duration_runs` forecast (`OrgPredictionsService.contextFor`). It is
  recorded only if the agent calls the tool.
- **A key-result check-in** with a confidence, made by the agent that owns
  the key result. This becomes a probability forecast: "reaches its target
  by the due date". It is recorded only for key results bound to a source,
  because a self-reported value could never be scored.
- **An experiment's proposer.** The expected effect becomes a `number`
  forecast in the experiment's `effectKind`.

### 2.2 Resolution and scoring (model-free)

| Subject | Resolved by | Score |
|---|---|---|
| task, `duration_runs` | the assignee's runs on the task when it is done | normalized absolute error |
| task, `date` | the time it was done | normalized absolute error, in days from the forecast |
| task, `probability` | done by `resolvesAt` (1) or not (0) | Brier |
| key result, `probability` | the source's latest sample at or before `resolvesAt` (default: the due date) against the target | Brier |
| key result, `number` | that sample's value | normalized absolute error |
| experiment, `number` | the measured effect (`relative` or `delta`) | normalized absolute error |
| experiment, `probability` | kept (1) or reverted (0) | Brier |
| hire, other | none; voided at `resolvesAt` | — |

- The Brier score is (p − outcome)².
- The normalized absolute error is |f − a| / max(|f|, |a|), clamped to 0–1.

Both are losses in 0–1. A cancelled task, a self-reported key result, a key
result with no sample, or an abandoned experiment voids the forecast.

### 2.3 Calibration

A member's calibration is 1 − the mean loss of its last
`predictions.calibrationWindow` resolved forecasts (default 20). It is
`null` when the member has fewer than `predictions.calibrationMinCount`
resolved forecasts (default 5). Two figures go with it:

- **Brier:** the mean Brier score over the member's probability forecasts.
- **Bias:** the mean signed error. `over` means forecasts land above what
  happens, such as overconfident probabilities or too many runs. `under`
  means they land below.

`calibration-registry.ts` holds the seam. `registerCalibrationProvider(fn)`
registers the provider, and `calibrationOf(workspaceId, agentId)` reads it.
The ledger registers itself when it is constructed. The trust ledger's
`TrustService.calibrationOf` reads the registry, and promotion
(`trust-policy.ts applyOutcome`) needs calibration ≥ `trust.calibrationBar`
(0.7) when a score exists. A `null` score never blocks a promotion.

The brief's **Calibration** line lists each scored member and names whose
estimates to discount: those below the bar.

## 3. Reconciliation

Once a day, `OrgReconciliationService.sweep` compares claims with ground
truth:

- **Key results bound to a source.** If the owner's confidence was at least
  `reconciliation.overclaimConfidence` (default 0.7) on the last two
  check-ins, and the source's value at each check-in put the key result
  behind its linear pace by more than `intent.paceTolerance`, that is an
  **overclaim**: a warn signal to the chief. The latest check-in note is
  also read, but only for a number written right after the key result's
  title or metric, such as "Subscribers at 450" or "subscribers: 80%". If
  that number differs from the measured value (or progress) by more than
  the tolerance, it is a `claimed_number` gap. A claim above the measured
  value also raises the overclaim signal. No other free text is parsed.
- **Tasks accepted by review, not by check,** in the last 14 days. If the
  task's `done_when` names a live metric source with a number, the derived
  check is `metric_at_least`. Otherwise, if it names a file path, the
  derived check is `file_exists`. The check runs once per task through
  `OrgSensingService.runAdHocCheck`, which time-boxes and audits it. A
  failure is a `claim_mismatch` signal to the chief and a minor
  `claim_mismatch` incident about the assignee.
- **The brief's report numbers.** The brief is composed without delivery.
  Its company spend this month and its count of tasks accepted since the
  last brief are compared with SQL aggregates over `org_runs` and
  `org_tasks`. A difference is a `report_drift` signal.

Each sweep is stored as a `reconciliation_sweep` audit row holding the gaps,
which `GET …/org/reconciliation` serves. When the latest sweep found gaps,
the brief shows a **Reconciliation** section. The auditor's sampled
material (`OrgAuditorService.addMaterial`) includes those gaps, plus every
measured key result's value from its source next to the owner's
confidence. This is ground truth the doers did not write.

## 4. Tools

| Tool | Who | What |
|---|---|---|
| `org_propose_experiment` | chief, unit leads | propose, and govern by mode (§1.3) |
| `org_experiments` | members | list experiments with baseline, verdict and delta |
| `org_forecast_outcome` | members | record a forecast |
| `org_calibration` | chief, unit leads | each member's resolved and open forecasts, Brier score, calibration and bias |

All four tools are internal. A proposal is either a card, a plan, or a
bounded change that reverts itself, so like the other org proposals they
run as reads in the turn loop's policy. The auditor's run, and other runs
restricted to a fixed tool list, do not see these tools.

## 5. Brief sections

The brief's `improve` position comes after cost per outcome and before
anomalies (`BriefSection.position`). It holds three sections:

- **Experiments:** running experiments with their reading so far, verdicts
  since the last brief, and unmeasured changes.
- **Calibration**
- **Reconciliation**

## 6. Routes

These are workspace routes, all under `/api/workspaces/:id/org/`. None is
public.

| Route | Who | What |
|---|---|---|
| `GET experiments?status=` | standing | list |
| `POST experiments` | CEO | propose (status `proposed`) |
| `GET experiments/:expId` | standing | one experiment, with its forecasts |
| `POST experiments/:expId/start` | CEO | start |
| `POST experiments/:expId/stop` | CEO | stop |
| `POST experiments/:expId/keep` | CEO | keep now |
| `POST experiments/:expId/revert` | CEO | revert now |
| `GET predictions?agentId=&status=` | standing | the ledger |
| `GET calibration` | standing | per member |
| `GET reconciliation` | standing | the latest gaps |
| `POST reconciliation/run` | CEO | sweep now |

## 7. Tunables (areas `experiments`, `predictions`)

| Key | Default | Bound |
|---|---|---|
| `experiments.windowDays` | 14 | 3–90 |
| `experiments.minSamples` | 5 | 2–100 |
| `experiments.noiseFloor` (baseline SDs) | 1 | 0.25–3 |
| `experiments.maxExtensions` | 1 | 0–3 |
| `experiments.concurrentPerUnit` | 1 | 1–5 |
| `predictions.calibrationWindow` | 20 | 5–200 |
| `predictions.calibrationMinCount` | 5 | 3–50 |
| `reconciliation.overclaimConfidence` | 0.7 | 0.5–0.95 |

## 8. Departures

- **The slice design is recorded, not enforced.** Metric sources are
  company-wide, so a slice experiment is still evaluated before/after. The
  slice says where the change is meant to apply (§1.6).
- **Charter and structure experiments start measuring when the CEO approves
  their change card,** not when the experiment starts. Their revert is also
  a card. In autonomous mode they wait for the veto window *and* the card.
- **Playbook experiments only switch reviewed versions.** They re-activate a
  retired playbook or retire an active one; new playbooks still go through
  review.
- **Early stop needs at least two samples since the start.** The daily check
  is driven by `lastCheckAt` on the 15-minute experiments tick.
- **Check-in forecasts are recorded only for sourced key results,** and only
  when an agent checks in. A human's confidence is not an agent's forecast.
- **The latest reconciliation lives on the audit chain** (a
  `reconciliation_sweep` row, capped at the audit payload size), not in a
  table of its own.
- **Report drift is checked against a fresh composition of the brief,** not
  against the stored text of the last brief, so both sides use the same
  `since`.
