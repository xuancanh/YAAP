# Improvements: capped proposals, change enablement and admission control

*Status: built (migration `0098-improvements`). Design source:
`reports/Process abstractions for agent companies.md` ("Improvement
proposal", "Admission control on self-generated work", Phase 2); the audit
it rests on is `research_notes/Process abstractions for agent
companies/yaap_current_abstractions.md`.*

Agents generate work about themselves. In the sample the report was built
on, 58 of 144 tasks came from retros, 118 of 144 from retros or agent
initiative and only 22 from plans, and 108 of 144 sat in the system
"Operating improvements" and "Unsorted" projects: the minutes executor
turned every retro action into a task. Two mechanisms replace that
firehose.

- **Improvement proposals.** A retro, a postmortem, a process review,
  process discovery or any member raises a capped, evidenced proposal on a
  *target* instead of a task. It is applied through the target's own
  versioning and verified against the metric it promised; a miss is
  reverted.
- **Admission control.** Every task's origin is classified. Self-started
  work (agent initiative, retro and meeting actions outside a project bet)
  enters only within small per-unit and per-member caps; everything else
  enters through a trigger, a service request, an accepted proposal or a
  person. Wakes one agent causes another draw on an attention budget.

Code: `server/src/org/improvement-model.ts` (pure: targets, the change
class, retro routing, origins and admission, verdicts, shares),
`improvement-tunables.ts`, `org-improvements.service.ts` (the lifecycle,
appliers, verification, the retro sink, the admission gate, the attention
budget, work sources), `org-improvements.tools.ts`, `improvements.controller.ts`;
the page is `src/components/OrgImprovementsView.tsx` with
`src/lib/improvements.ts`.

## 1. The proposal

```
org_improvements   IM-n, unit, title
                   target: targetKind (process | policy | quality_standard | playbook | charter | cadence | tunable | '') + targetRef + label
                   evidence[] {kind: event_query | metric | postmortem | incident | lessons | deviations | meeting | task, ref, summary}
                   hypothesis, change (the target-specific payload), diff[] (readable), expected {metric, direction, by}
                   category: investigate | mitigate | repair | detect | prevent (Google's postmortem action classes)
                   changeClass: standard | normal | emergency (+ why), owner ('ceo' | 'agent:<id>')
                   origin: retro | postmortem | process_review | discovery | incident | verification | agent | ceo (+ originRef)
                   status, approvalId, reviewPending, appliedRef, revertData, baseline, verifyAt, verification, revertOf, history[]
```

A proposal needs evidence and a hypothesis; a proposal without either is
refused with what to add. The **change** is in the target's own terms:

| Target | `change` | Applied through | Reverted by |
|---|---|---|---|
| process | `{def}` (the full edited definition) or `{rollbackTo}` | `OrgProcessesService.author` — a new immutable version | `rollback` to the version before (a new version) |
| policy | `{fields}` | `OrgQualityService.revisePolicy` — a revision | revising back to the stored fields |
| quality_standard | `{fields}` | `reviseStandard` | revising back |
| playbook | `{body}` | `OrgPlaybooksService.write` — a new version in peer review | writing the old body back |
| charter | `{text, mode}` | the agent's charter, re-accepted | the old charter |
| cadence | `{cron}` / `{enabled}` | `OrgMeetingsService.updateCadence` | the old cron and state |
| tunable | `{value}` | `OrgService.setTunable` (audited) | the old value |

A proposal with no target or no structured change is prose: accepting it
makes **one** task for its owner (source `proposal`, `createdBy
improvement:<id>`), and it counts as applied when that task is done.

**Owner** (model-free): a process, policy, standard or cadence of a unit is
its head's, the company's the chief's; a playbook is its owner's; charters
and tunables are the CEO's.

**Lifecycle** — the change-record pattern (`plugins/changes.service.ts`): a
transition table (`IMPROVEMENT_NEXT`), every move in `history` and the audit
log (`improvement_<status>`), deadlines on the row (`expiresAt`,
`verifyAt`) so the sweep resumes after a restart.

```
proposed → accepted → applied → verified
                            ↘ reverted
         ↘ rejected   ↘ expired
```

## 2. The change class

`classify` (improvement-model.ts), no model, by the company's tunables:

- **Emergency** — a mitigation or repair while the incident it names is
  open (`improve.emergency`). It applies at once; an `improvement` card asks
  the owner to review it afterwards. Rejected in review, it is reverted.
- **Standard** — pre-authorised: the proposer owns the target (or is the
  chief), the change is concrete and reversible and leaves the controls
  alone. `improve.standardScope` 1 covers process edits that touch no MUST
  item, checkpoint, approval, strict edge or denied tool, and playbook
  revisions; 2 adds cadences and tightening a policy or standard; 0 makes
  every change normal. A process company with `process.editApproval` 2
  never treats a process edit as standard. Charters and tunables are never
  standard.
- **Normal** — everything else: an `improvement` decision card routed by
  decision routing from the proposer (its manager decides within
  authority — `AUTHORITY_TABLE` row `improvement` — or escalates). Charters,
  tunables and anything that loosens a control are CEO-reserved
  (`payload.boundary = propose`).

Applying is done as `improvement:<key>`, so every version, revision and
tunable row names the proposal that made it.

## 3. Caps and retros

| Tunable | Default | What |
|---|---|---|
| `improve.maxOpenPerTarget` | 1 | Proposals one target may have unsettled (proposed, accepted or applied and being verified): one change at a time, so its effect can be measured. |
| `improve.maxOpenPerUnit` | 4 | Proposals a unit may have proposed or accepted. |
| `improve.perMeeting` | 2 | Proposals one retro, postmortem or process review raises. |
| `improve.standardScope` | 1 | Which changes are pre-authorised (0–2). |
| `improve.emergency` | 1 | Whether incident fixes apply at once. |
| `improve.verifyDays` | 14 | The verification window. |
| `improve.expireDays` | 14 | An undecided proposal expires: no answer is not a yes. |
| `improve.autoRevert` | 0 | 0 a failed verification opens a revert proposal; 1 it reverts at once. |
| `improve.repairTasks` | 1 | Whether a retro's concrete repair may stay a task. |

Caps bind agents; a person's proposal is applied at once, and a revert
proposal is never capped.

**Retros emit proposals** (`ImprovementSink`, bound into
`OrgMeetingsService.materialise`). A retro's (and a postmortem's — a retro
created by `postmortem`) actions are routed by `routeActions`: a concrete
**repair** of one defect — an owner, a done-when, no standing target — stays
a task (`improve.repairTasks`) and counts against the admission caps; every
other action is a proposal, ranked by category (prevent, repair, detect,
mitigate, investigate), then a named target, evidence and an expected
metric; the top `improve.perMeeting` are raised, the rest stay in the
minutes as *not raised* with the reason. A task the admission gate refuses
is parked as a proposal; a bad target or metric is retried as prose rather
than lost. `meeting_propose_action` takes `category`, `target`,
`hypothesis`, `evidence` and `expected`. A lesson's playbook change becomes
a proposal on the playbook (the revise task is the fallback).

## 4. Verification

At apply, the expected metric is read as the **baseline**; after
`improve.verifyDays` the sweep reads it again (`verdictOf`: moved in the
expected direction by at least `by`; `by` 0 means *not worse*). Metrics:
`process.deviationRate | completionRate | cycleHours | reworkRate |
slaBreaches` (the target process's metrics), `quality.firstPassYield |
reworkRate | escapes` (the unit's, else the company's), `policy.violations`,
`work.selfShare | retroShare | systemShare | blockedHours`, and
`metric:<source id>` (a metric source's latest value).

- **pass** → verified;
- **fail** → a revert proposal (origin `verification`, `revertOf`, the
  target's own undo as its change) — applying it marks the original
  reverted; rejecting it keeps the original (verified, "kept by the
  owner"); with `improve.autoRevert` 1 the revert applies at once;
- **unverifiable** (no metric named, or unreadable) → kept, recorded as
  unverifiable.

The CEO can check an applied change now (`POST …/:ref/verify`).

## 5. Admission control on self-generated work

`originOf` classifies every task: `plan`, `process`, `service`,
`incident`, `escalation`, `human` (the CEO and people), `proposal` (an
accepted proposal carried out), `chief` (the chief's sweep), `retro`,
`meeting`, `agent` (initiative). `isServiceRequest` is the predicate other
code uses: source `service`, a `serviceId` / `serviceRequestId` / `service`
field, or a `service:<name>` tag — it tolerates the service catalog's fields
not existing yet.

`admissionOf` decides what the caps count: an agent-created task of a
self-started origin (`retro`, `meeting`, `agent`) that is not a subtask of
admitted work, not under a project bet (`kind = project`) and not review
work. The gate (`OrgTasksService.setAdmissionGate`, after the alignment
gate) counts the unit's open self-started tasks and what the member started
in 24 hours:

| Tunable | Default | What |
|---|---|---|
| `admission.selfWip` | 6 | Open self-started tasks per unit. |
| `admission.selfPerDay` | 4 | Self-started tasks one member may create in 24 h. |
| `admission.overCap` | 0 | 0 refused with remediation; 1 parked (unassigned backlog, nobody woken). |
| `attention.agentWakesPerHour` | 12 | Wakes a member may get from other agents per hour. |

Over the cap nothing is dropped silently: the refusal says what to do —
finish or cancel one, attach it to the bet it serves or make it a subtask,
ask the owning function through a service request, or raise an improvement
proposal — and an audit row (`admission_refused` / `admission_parked`)
counts it. The chief's own tasks are classified but not capped.

**The attention budget.** A wake carries who caused it (`OrgWakeEvent.by`).
Comments, tags and assignments from another agent beyond
`attention.agentWakesPerHour` are deferred until the hour frees up
(`OrgRuntimeService.setAttentionGate`) — queued again, never dropped, with
one `attention_deferred` audit row per member per hour. People's wakes,
reviews, approvals, dependencies and the chief's are not counted; the
next-work pull keeps `work.nextTaskMaxPerHour`.

Every key is derived from the operating profile
(`deriveImprovementTunables`): a hierarchy or rigour culture approves every
change, watches a month, keeps self-started work small and refuses over
the cap; speed and an adhocracy widen the standard scope, verify in a week
and park; an early company keeps meta-work small. The boundary reserves
`improve.*`, `admission.*` and `attention.*` (`propose`).

## 6. Measure

`workSources(orgId, {days, unitIds})`: new tasks by origin, the
self-started share, the share in Operating/Unsorted projects, the retro
share, each unit's open self-started work against its cap, refusals,
parkings and deferred wakes, and proposals opened, accepted, applied,
verified, reverted, rejected and expired in the window. The chief (company)
and each head (its subtree) get it as one context line with the proposals
that wait on what they own; the UI shows it as the Work sources panel.

## 7. Surfaces

- **Tools** (every member): `org_improvements` (by status, one by key, or
  `sources: true`) and `org_improvement_propose`. Normal changes are
  decided with `org_decide` like any card.
- **API** (`improvements.controller.ts`): `GET …/org/improvements`,
  `GET …/sources?days=`, `GET …/:ref`, `POST …/:ref/accept|reject {note}`
  (the CEO or a board member; a pending card is decided through the
  approvals path) and `POST …/:ref/verify`.
- **Operations › Improvements** (`/:company/operations/improvements`):
  proposals by *Needs a decision / In flight / Verified / Closed* with
  target, evidence, hypothesis, the diff, the class and why, the metric and
  what verification found, the history; Accept / Reject (Keep / Revert for an
  emergency change's review) and *Check the metric now*. Below, the Work
  sources panel.
- **Inbox**: a normal change that reaches the CEO (or is CEO-reserved) is an
  `improvement` card with the diff and the expected metric.

## 8. For other features

- `OrgImprovementsService.createProposal(orgId, input, actor)` is the one
  entry point — process discovery raises its drafts with `target: process`
  (or no target for a first draft), `origin: 'discovery'`.
- `isServiceRequest(task)` (improvement-model.ts) tells a service request
  from initiative; tasks with `source: 'service'` are admitted freely.
