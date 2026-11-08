# Quality control: results and policies

*Status: shipped, 8 November 2026. Implements "Evidence-gated claims",
"Verifier diversity as a property" and the "Policy, invariant and control"
primitive of `reports/Process abstractions for agent companies.md`.*

Two questions a CEO who looks away needs answered without reading every
deliverable: **did this work actually meet the bar** (results), and **did
anyone break a rule on the way** (policies). Both are answered by data the
company keeps and the platform enforces, not by prose in a prompt.

Code: `server/src/org/quality-model.ts` (pure: shapes, validators, the
evidence grammar, the grader, the predicate evaluator, templates, metrics),
`server/src/org/org-quality.service.ts` (the gate, the guard, spot checks,
authoring), `server/src/org/org-quality.tools.ts` (agent tools),
`server/src/org/quality.controller.ts` (HTTP), `server/src/org/quality-tunables.ts`.
Migration `0095-quality`.

## 1. Quality standards

A standard (`org_quality_standards`) says what a deliverable must meet to
count as done:

| Field | Meaning |
|---|---|
| `criteria` | `[{ id, text, weight, min?, evidence? }]` — each is both an **acceptance criterion** (the maker cites evidence for it) and a **rubric line** (the verifier scores it 1–5). `min` is a floor: below it the work fails whatever the mean. `evidence` lists the reference kinds that count (`file`, `url`, `tool`, `action`, `check`, `task`) or `["none"]` for a judged-only criterion. |
| `passScore` | The weighted mean (1–5) the work must reach. Defaults to `quality.defaultPassScore`. |
| `requireEvidence` | Whether the submission must cite evidence per criterion. |
| `verifier` | `default`, `agent` (any member but the maker) or `family` (only a verifier on another model family may accept). |
| `scopeKind` / `scopeRef` / `unitId` | `company`, `unit`, `role` (a title), `deliverable` (a task class or a `deliverable: <kind>` line in the brief's constraints), `project`, `task`, `process_step`. `unitId` narrows a deliverable or role standard to one unit. |
| `version`, `status` | Revised in place; every QC result snapshots the criteria and version it was graded against. `proposed → active → retired`, or `rejected`. |

**Which standard applies** (most specific first): an explicit link
(`org_quality_links`, `OrgQualityService.attach` — this is how a process
step's standard reaches the tasks it materialises), another module's
resolver (`addStandardResolver`), a `standard: <slug>` line in the brief,
a project link, then the best active scope: task › project › deliverable
(unit-narrowed first) › role › unit (nearest first) › company.

**Templates** (`QUALITY_TEMPLATES`): `general`, `research`, `report`,
`ops-change`, `outreach`. Nothing is seeded silently — the chief adopts them
(`org_quality_standard action create template …`, its
`quality-and-policy-control` playbook) or the CEO does from the Quality page.

## 2. Evidence-gated submission

`org_request_review` takes `evidence: [{ criterion, refs }]` (or a map, or a
flat list). Every reference is verified **without a model**:

| Ref | Verified against |
|---|---|
| `action:<id>` (≥ 8 chars) | an `action_log` row of the maker, succeeded / staged / held |
| `tool:<name>` or `tool:<message id>` | a tool result of the maker since the task was created (the transcript, or the in-process ledger of this turn) |
| `file:/path[#sha256=<hex>]` | the workspace file exists (and its hash matches); `~/` is the maker's home |
| `url:https://…` | a fetch tool of the maker requested it during the task (this turn's ledger, past turns' tool calls, the action log) |
| `check:<n>` | the task's n-th executable check last passed |
| `task:<key>` | the task exists and is done |

A submission is **refused** — nothing moves — when a reference is unreadable
or does not check out, when a criterion that needs evidence has none (at
`quality.evidenceRequired` ≥ 1 with a standard), or when no real reference is
cited at all (`quality.evidenceRequired` = 2). The refusal names each gap and
the kinds that would close it, and shows the call to make again; a bare "no"
would make agents retry blindly. Deterministic **result policies** (§5) run
here too, over the note and the text of the cited files.

A passing submission opens the round's **QC result** (`org_qc_results`,
outcome `pending`) with the evidence and the model-free checks, and posts one
line on the timeline.

## 3. Independent verification

The verifier is never the maker (as before). `quality.verifierIndependence`:
0 any other member, 1 prefer another model family (the board's existing
pick), 2 — or a standard with `verifier: family` — require one whenever the
roster has one: the reviewer is re-picked, and a same-family accept is
refused naming who may accept.

**Deterministic first**: evidence, task checks (`docs/sensing.md` §3) and
result predicates run before any reviewer is woken. **Then the rubric**: an
`org_review` accept needs `scores: [{ criterion, score 1–5, note, evidence }]`
for every criterion (judged result policies appear as `policy-<key>`
criteria); references the verifier cites are verified too. A weighted score
under `passScore`, or a criterion under its `min`, turns the accept into
`request_changes` with the failing criteria and the verifier's notes. The QC
result records the verifier, the independence (`different_family`,
`same_family`, `human`, `check`), per-criterion scores, the score and
`pass | rework | fail`. A person's review or an accept by checks is recorded
the same way.

The maker's and the verifier's run context carry the standard (criteria,
bar, result policies) and what to call.

## 4. Metrics and spot checks

`GET …/org/quality` and `org_quality` report, per maker, unit and standard:

- **first-pass yield** — tasks whose first decided QC result passed;
- **rework rate** — tasks that needed at least one rework;
- **defect escapes** — accepted work later reopened (a `task_transitions`
  row out of done), tied to an incident on the task, or failing a spot check.
  An escape is a `rejected` outcome on the maker's trust ledger (its
  reputation), a `quality_escape` signal for the chief, and at
  `quality.escapeIncident` escapes in a week a minor incident.
- policy conformance (violations per policy; the share of result-policy checks met).

**Spot checks** (daily, `POST …/quality/spot-check` on demand): accepted
work of the last week is sampled deterministically — `quality.spotCheckPct`
for work that skipped graded review (accepted by checks, or with no
standard), `quality.spotCheckReviewedPct` for graded work. Each sampled task
is re-verified model-free (its cited files still exist, unchanged) and,
within `quality.spotChecksPerDay`, handed to an independent member (not the
maker, not its reviewer; the auditor, else another model family) as a
`QA spot check:` task graded with `org_qc_grade`. A failure is an escape.

## 5. Policies

A policy (`org_policies`) is a rule as data:

| Field | Meaning |
|---|---|
| `statement`, `rationale`, `remediation` | The rule, why, and what to do instead (told with every refusal). |
| `kind` | `predicate` — checked model-free; `judged` — read by an independent checker. |
| `rule` | `{ tools?, classes?, when?, require?, forbid? }`; a condition is `{ field, op, value }` over a dot path of the call's input (`*` = the whole input, `items.*` = every element), or `text` / `note` of a result. Ops: `exists absent eq neq gt gte lt lte contains not_contains matches not_matches in not_in max_len`. No code is evaluated. |
| `appliesAt` | `action`, `result` or `both`. |
| `scopeKind` | `company`, `unit` (and below), `role`, `action_class`, `deliverable`. |
| `severity` / `enforcement` | `low…critical` / `block`, `warn`, `log`. |
| `version`, `status`, `owner` | As standards. |

Examples: a price floor (`tools: ["shop_set_*"], require: [{ field: "price",
op: "gte", value: 10 }]`), a discount cap (`when: discount exists, require:
discount lte 20`), a required disclaimer (`tools: ["gmail_*"], require:
[{ field: "*", op: "contains", value: "Not financial advice" }]`, or
`appliesAt: result` on `text`).

**At actions** — `ActionsService.hooks.guard`, called by the turn loop for
every non-read call in every session kind, after the dedupe check and before
the trust decision: a violated blocking predicate refuses the call (action
log `refused`, decision `policy`) with the remediation and the violation id;
a warning lets it run and is appended to its result; a judged policy that
covers the call makes it a `cosign` (a second agent key on another family,
`docs/actions-and-trust.md` §5) with the policy text in the co-signer's
rules. The quality tools themselves (`org_policy*`, `org_quality*`,
`org_qc_*`) are never covered, so a member can always see and appeal.

**At review** — §2 (predicates) and §3 (judged ones as criteria).

**Violations** (`org_policy_violations`) record the policy version, member,
tool or task, what failed and the outcome. A violation at or above
`policy.signalSeverity` opens a `policy_violation` signal (critical → the
CEO); `policy.repeatForIncident` violations of one policy by one member
within `policy.repeatWindowHours` open an incident (major for a critical
policy). **Exceptions**: `org_policy_exception` (the violation id and why) is
a `policy_exception` card; approved, the identical call (same input hash)
runs once; rejected, the violation is upheld.

## 6. Authoring and approval

The chief authors company standards and policies; a head its own unit's
(`scopeKind: unit` with its unit, or a deliverable/role scope with `unitId`).
People (CEO, board) author from the Quality page and are not bound. For an
agent, three things decide whether a change applies or becomes a
`quality_change` card:

1. the boundary (`boundary.ts`): `policy` / `quality_standard` — a new or
   stricter one is `alone`; retiring one, weakening its enforcement or
   severity, or lowering a standard's bar is `propose` (a card in every mode);
2. `policy.authoringApproval`: 0 the mode decides, 1 a blocking policy is
   always a card, 2 every change is a card;
3. the mode: autonomous applies, supervised is a card.

A revision waits on its card in `pending`; the current version stays in force
until it is approved.

## 7. Tunables

All per company (`org_tune` proposes, `PUT …/org/tunables`), all `propose`
for agents (they decide what counts as verified work), all derived for every
starter from its values and culture (`deriveQualityTunables`; `npm run
blueprints:build`): a rigour or control culture asks for evidence on every
submission, another model family, a 4/5 bar, more spot checks and every
policy change on a card; speed and experimentation keep them lighter.

| Key | Meaning |
|---|---|
| `quality.evidenceRequired` | 0 none, 1 per criterion of a standard, 2 also one real ref without a standard |
| `quality.verifierIndependence` | 0 any other member, 1 prefer another family, 2 require it |
| `quality.defaultPassScore` | the bar of a standard that names none (1–5) |
| `quality.spotCheckPct` / `quality.spotCheckReviewedPct` | sample of unreviewed / graded accepted work |
| `quality.spotChecksPerDay` | spot-check tasks a day |
| `quality.escapeIncident` | escapes in a week that open an incident |
| `policy.authoringApproval` | see §6 |
| `policy.repeatForIncident` / `policy.repeatWindowHours` | repeated violations that open an incident |
| `policy.signalSeverity` | the severity a single violation needs to reach the chief at once |

## 8. Surfaces

- **Oversight › Quality** (`src/components/OrgQualityView.tsx`): the figures,
  standards (adopt a template), policies with their violations, recent QC
  results.
- **Task detail**: the QC result of each round — criteria, scores, notes and
  evidence links (workspace files open in the side panel).
- **Inbox**: `quality_change` and `policy_exception` cards
  (`server/src/home/feed-titles.ts`).
- **Agents**: `org_quality`, `org_quality_standard`, `org_policy`,
  `org_policy_exception`, `org_qc_grade`; `org_request_review evidence`,
  `org_review scores`; the built-in `verify-and-cite` skill (every member),
  the heads' `unit-quality-standards` playbook, the chief's
  `quality-and-policy-control` skill.

## 9. HTTP

```
GET  /api/workspaces/:id/org/quality?days=30         standards, policies, metrics, templates
GET  /api/workspaces/:id/org/quality/results?taskId=
GET  /api/workspaces/:id/org/quality/tasks/:taskRef  the standard a task is held to and its QC results
GET  /api/workspaces/:id/org/quality/violations?policyId=&status=
POST /api/workspaces/:id/org/quality/standards       create ({ template } or fields)
POST /api/workspaces/:id/org/quality/standards/:ref  revise, or { action: "retire" }
POST /api/workspaces/:id/org/quality/policies        create
POST /api/workspaces/:id/org/quality/policies/:ref   revise, or { action: "retire" }
POST /api/workspaces/:id/org/quality/spot-check      run today's sample now
```

Reads need standing in the organisation; writes are the CEO's or a board
member's.

## 10. Not yet

- Kits do not ship standards or policies yet (kit `policies` remain the
  interface-operation requirements of `docs/plugins.md`); a kit manifest
  `quality` section is the natural next step.
- Continuous invariants over org state (a policy evaluated on a schedule
  rather than at a call or a review) are not built.
