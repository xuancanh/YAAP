# Autonomous skills review (2026-11)

A review of the skills a yaam-chat company of agents needs to run by
itself — the Chief of Staff (`packs/chief-of-staff.md`), 13 function heads
and 39 specialists (`packs/biz-*.md`), the Auditor (`packs/auditor.md`) and
the built-in skills (`server/src/skills/builtin-skills.ts`) — judged as one
system against the org runtime (`server/src/org/`), not pack by pack. The
yardstick is docs/autonomous-org-first-principles.md (C1–C12),
docs/company-vision.md, docs/chief-of-staff.md and the Business catalog in
docs/agent-catalog.md.

**Method.** Each autonomous loop was traced end to end. A step is **OK**
when a skill owns it, something fires it (a pack loop, the heartbeat, a
ritual, a runtime trigger), the tools it names exist **and are offered to
that role in the session it runs in**, and it leaves an artifact the next
step reads. **GAP** = no owner, trigger or artifact. **BROKEN** = the skill
exists but cannot run (a tool not offered in that session, a hand-off
nobody receives).

Tool availability, as the runtime offers it after this change and the
CEO's decisions (§4):

| Role | Loops, heartbeat, chat | Task run | Reviewer run | Meeting |
|---|---|---|---|---|
| Specialist (member) | common board/intent tools, `org_task_update` / `org_task_comment` / `org_request_review`, `org_escalate` (to its manager), `org_costs` / `org_forecast` (read-only), playbooks and decisions, metric reads and task checks, `org_forecast_outcome`, `org_incidents` (own) / `org_report_incident`, `org_capacity`, `org_experiments`, `fs_*` | same | + `org_review` | `meeting_*` |
| Function head (unit lead, or "Head of …" under the chief) | the member set + `org_assign`, `org_set_goal`, `org_set_key_result`, `org_unit_report`, `org_pulse`, `org_escalate` (its unit's tasks; to the chief, or `to: "ceo"`), `org_hire_agent` / `org_pause_agent` / `org_update_member` (its own reporting line), `org_eval_cases`, `org_calibration`, `org_propose_experiment`, `org_propose_metric_source`, `org_set_cadence`, `org_incidents` (own and its reports') | same | + `org_review` | `meeting_*` (facilitator: `meeting_close`) |
| Chief of staff | everything except the auditor's two recording verbs | same | same | same |
| Auditor (audit run) | — | — | — | read-only: board, goals, `org_intent`, `org_audit_query`, `org_signals`, `org_pulse`, `org_decisions`, `org_metric_sources`, `org_metric_read`, `fs_list` / `fs_read` / `fs_search`, its own playbooks, + `org_audit_finding`, `org_audit_close` |

`tests/backend-org-chief.test.ts` ("every tool a business skill names
exists and is offered to the role that runs it") now checks this for every
business pack, every pack loop and the built-in org skills, from the real
providers' `specsFor`.

## 1. Coverage matrix

### (a) Intent → execution → scoring

| Step | Owning skill | Trigger | Tools | Artifact | Status |
|---|---|---|---|---|---|
| CEO intent → vision | CEO (UI); chief `operating-system-setup`, `annual-planning` | onboarding; yearly | `org_intent`, `org_propose_strategy` | vision, `/org/operating-system.md` | OK |
| Vision → company objectives / KRs | chief `annual-planning`, `quarterly-planning` | quarterly loop; planning session (`vision`) | `org_propose_strategy`, `org_set_key_result`, `org_set_goal unit` | `/org/planning/<q>.md`, strategy memo | OK |
| Objective → function KRs | head `<fn>-okr-planning` | planning session `objective_assigned` (prompt now points to the playbook) | `org_set_goal`, `org_set_key_result`, `org_forecast_outcome`, `org_propose_metric_source` | `/org/<fn>/okrs/<cycle>.md` | OK (was GAP: the planning prompt never named the playbook) |
| Cross-function dependencies in the plan | head `<fn>-okr-planning` step "Dependencies"; chief `quarterly-planning` step 3 | as above | `org_create_task`, `/org/handoffs.md` | handoffs registry rows | OK (was GAP) |
| KRs → tasks | head `<fn>-team-management`, process skills (sprint planning, …) | head loops | `org_create_task`, `org_assign`, `org_capacity` | board | OK |
| Execution, status to the head | specialist pack skills + built-in `org-member-workflow` | task wake; heartbeat | `org_task_update`, `org_run_checks`, `org_request_review` | task timeline | OK (was BROKEN outside task runs) |
| Review / accept | head `<fn>-team-management` step 3; any reviewer | `org_request_review` wakes a reviewer run | `org_review`, `org_task_checks` | accepted task, golden case | OK |
| Check-ins | KR owners; head `<fn>-weekly-review` | heartbeat (check-in due); weekly loop | `org_check_in` | KR value + confidence | OK |
| Scoring | chief `quarterly-planning` step 1 | quarterly loop | `org_metric_read`, `org_intent` | grades in planning pack | OK |
| Retro | built-in `org-unit-retro` (all units), `engineering-retro` | runtime retro ritual per unit | `meeting_*`, `meeting_propose_lesson` | `/org/<fn>/retros/<date>.md`, lessons | OK (was GAP for 12 of 13 functions) |

### (b) Sensing → incident → playbook

| Step | Owning skill | Trigger | Tools | Artifact | Status |
|---|---|---|---|---|---|
| Sensing → signal | runtime (metric sources, SLOs, breakers) | model-free | — | signals | OK |
| Signal → incident, containment | runtime (`OrgIncidentsService`); members `org_report_incident` | detection; member judgment | `org_report_incident` | incident, containment steps | OK |
| Triage while open | chief `ceo-daily-brief`, `escalation-and-blocker-sweep` | daily sweep | `org_incidents`, `org_signals` | brief line | OK (was GAP) |
| Postmortem | head `engineering-incident-review`, `it-security-incident-response`, `cs-escalation-management`; built-in `org-unit-retro` (postmortem retro) | runtime schedules a retro for major/critical | `org_incidents` (a head now sees its reports'), `meeting_*` | `/org/<fn>/postmortems/…`, lessons | OK (was BROKEN: a head saw only incidents about itself) |
| Lesson → playbook | `org-unit-retro`, chief `learning-loop-review` | retro; monthly | `meeting_propose_lesson`, `org_write_playbook` | parked playbook → review | OK (was GAP: nobody turned repeated lessons into playbooks) |

### (c) Reporting → decisions

| Step | Owning skill | Trigger | Tools | Artifact | Status |
|---|---|---|---|---|---|
| Head weekly report | head `<fn>-report` | head Friday loop | `fs_write`, `org_message`, `org_create_task`, `org_escalate` | `/org/<fn>/reports/<yyyy>-W<ww>.md` | OK (was BROKEN: `org_escalate` not offered in a head's loop) |
| CoS intake | chief `function-reports-intake` | weekday sweep | `fs_list`, `fs_read`, `org_read_board` | scorecard, risks, issues | OK |
| WBR pack | chief `weekly-business-review` | weekly loop at pre-read deadline | `org_metric_read`, `org_intent`, `org_task_comment` | `/org/reviews/<date>.md` | OK |
| Exec prep | chief `exec-meeting-prep` | weekly loop | `org_report`, `fs_write` | `/org/meetings/<date>-leadership.md` | OK |
| Decisions | the forum's owner (meeting runtime) | ritual | `meeting_propose_decision` | system decision log | OK |
| Decision log | chief `decision-log-hygiene` | monthly loop | `org_decisions`, `org_audit_query` | `/org/decisions.md` | OK |
| Follow-through | chief `decision-log-hygiene` 4–5 | monthly | `org_read_board` | issues | OK |
| Independent check of the ledger | Auditor `audit-ledger-and-metrics` | audit cadence | `fs_read`, `org_decisions`, `org_metric_read` | findings → signals | OK (was GAP: the auditor could not read `/org/`, nor load its playbooks) |

### (d) Staffing

| Step | Owning skill | Trigger | Tools | Artifact | Status |
|---|---|---|---|---|---|
| Capacity gap | head `<fn>-team-management` 5 | head loops | `org_capacity` | — | OK |
| Hire | head `<fn>-team-management` 5 | head loops | `org_hire_agent role:<fn>-<slug>` (own unit, cap, unit envelope) | card (supervised) or member | OK (decision 1: was a backlog case for the chief) |
| CoS review | chief `function-reports-intake` 3–4 | inbox notice + group log on every head hire/pause; sweep | `org_audit_query`, `org_capacity`, `org_costs` | comment, issue, lifecycle case | OK (reviews, no longer executes) |
| CEO decision card | runtime (`org_hire_agent` → approval in supervised, head or chief) | — | — | card with default | OK |
| First staffing of a new workspace | chief `member-lifecycle-review` 2 | onboarding; monthly | `org_review_structure`, `org_hire_agent` | `/org/staffing/<yyyy-mm>.md` | OK (was GAP) |
| Onboarding the hire | chief `member-lifecycle-review` 3 → head `<fn>-team-management` 6 → member built-in `org-member-onboarding` | after each hire | `org_create_task`, `org_assign`, `fs_read` | `~/onboarding.md`, `/org/<fn>/team.md` | OK (was GAP) |
| Probation / eval | chief `member-lifecycle-review` 4–5 | monthly | `org_pulse`, `org_calibration`, `org_eval_role` | staffing file | OK (was GAP) |
| Pause / model change | head `<fn>-team-management` 5 (its reports); chief `member-lifecycle-review` 5–6 | head loops; monthly | `org_pause_agent`, `org_update_member` | card or plan; chief told | OK (decision 1) |
| Terminate | chief `member-lifecycle-review` 5 | monthly | `org_terminate_agent` | card or plan | OK (was GAP) |

### (e) Self-improvement

| Step | Owning skill | Trigger | Tools | Artifact | Status |
|---|---|---|---|---|---|
| Lessons | `org-unit-retro`; `learning-loop-review` 3 | retro; monthly | `meeting_propose_lesson`, `org_recall` | lessons | OK |
| Playbooks written / revised / retired | heads (`org_write_playbook` in retro and audit skills); chief `learning-loop-review` 4 | monthly | `org_playbooks`, `org_write_playbook` | playbook versions | OK (retirement was GAP) |
| Experiments | heads and chief propose; chief `learning-loop-review` 1 reads out | monthly | `org_propose_experiment`, `org_experiments` | decisions log rows | OK (read-out was GAP) |
| Prediction calibration | members record (`org_forecast_outcome`); heads coach; chief `learning-loop-review` 2 | monthly | `org_calibration` | learning file | OK |
| Evals rollout gate | runtime gate; chief `member-lifecycle-review` 5, `learning-loop-review` 5 | before a change | `org_eval_role`, `org_eval_cases` | eval run | OK |
| Ritual retirement | chief `ritual-retirement-review`; `org-unit-retro` 7 for unit rituals | monthly; retro | `org_propose_experiment`, `org_set_cadence` | calendar | OK |

### (f) Self-audit

| Step | Owning skill | Trigger | Tools | Artifact | Status |
|---|---|---|---|---|---|
| Sampling accepted work | Auditor `audit-accepted-work` | `auditCadenceDays` | `org_read_board`, `org_audit_finding` | findings | OK (playbook now loadable in the run) |
| Scope and spend | Auditor `audit-scope-and-spend` | same | `org_audit_query`, `org_pulse` | findings | OK |
| Values → mechanism | chief `values-mechanism-audit` (proposes); Auditor `audit-values-and-culture` (verifies) | monthly; audit | `fs_read /org/values.md`, `org_audit_query` | findings | OK (independent half was GAP) |
| Culture drift | same | same | `org_pulse`, `org_decisions` | findings | OK |
| Head-requested assurance | head `<fn>-kpi-audit` ("Assurance request:" task) → chief intake 6 → Auditor `audit-ledger-and-metrics` 1 | an open request brings the audit forward after `audit.assuranceDebounceHours` (decision 3); else the cadence | `org_read_board` | findings citing the request | OK (was BROKEN: nobody received the request) |

### (g) Cross-functional handoffs

| Handoff | Requester side | Provider side | SLA owner | Status |
|---|---|---|---|---|
| Marketing → sales (leads) | `lead-scoring-review`, campaign skills | SDR `inbound-lead-qualification` (response target, logged outcomes) | the two heads via `/org/handoffs.md` (okr-planning/weekly-review steps); chief `handoff-sla-monitor` | OK |
| SDR → AE | SDR `meeting-handoff` | AE `discovery-call-prep` | Head of Sales | OK |
| Sales → CS (closed-won) | AE `closed-won-handoff` (new) | CS onboarding `kickoff-plan` reads `/org/customer/handoffs/<account>.md` | heads + chief | OK (was BROKEN: the receiver read a handoff no one wrote) |
| Product ↔ design ↔ engineering | `prd-spec`, `design-handoff-spec` | `engineering-sprint-planning` 3, `design-intake-triage` | heads | OK |
| Finance budget cycle | heads' okr-planning (envelope), `finance-budget-vs-actuals` 3 asks owners | FP&A `driver-based-budget`, `monthly-reforecast` (reads `org_costs` / `org_forecast` live) | Head of Finance | OK (was BROKEN: FP&A named capital tools specialists lacked; decision 2 offers them to every member) |
| Legal review | any member's backlog request (`org-member-workflow` 5) | `legal-intake-triage` | Head of Legal + chief | OK |
| Any request between functions | built-in `org-member-workflow` 5 (requester) | `org-member-workflow` 6 + head `<fn>-weekly-review` handoffs step | chief `handoff-sla-monitor` | OK (was GAP: no provider-side skill, no SLA agreement) |

### (h) Onboarding

| Step | Owning skill | Trigger | Status |
|---|---|---|---|
| New workspace: operating system | chief `operating-system-setup` | bootstrap | OK |
| New workspace: first staffing | chief `member-lifecycle-review` 2 | bootstrap/monthly | OK (was GAP) |
| New member | `org-member-onboarding`, head `<fn>-team-management` 6, chief `member-lifecycle-review` 3 | after hire | OK (was GAP) |

### (i) Failure handling

| Failure | Owning skill | Trigger | Status |
|---|---|---|---|
| Blocked task | member `org-member-workflow` 4; chief `escalation-and-blocker-sweep` 2 | heartbeat; sweep | OK (was GAP) |
| Escalation chain | `org-member-workflow` 8: specialist → head (`Escalation:` task), head → chief (default) or toward the CEO (`to: "ceo"`, through the chief), chief → CEO; every card to the direct manager first (owners-seat §7) | `org_escalate`, `org_decisions`, `org_decide` | OK (decision 4) |
| Abandoned task | `org-member-workflow` 7; sweep 3 | sweep | OK (was GAP) |
| Provider / connection failure | runtime opens a minor incident; `org-member-workflow` 4; sweep 5 | sweep | OK (was GAP) |
| No progress / loop breaker | runtime blocks; sweep 4 | sweep | OK (was GAP) |
| Escalation timeout | runtime card deadline and default; sweep 6, `ceo-daily-brief` | sweep | OK (was GAP) |
| CEO unavailable | sweep 6 (plan for the default, never decide) | sweep | OK (was GAP) |

## 2. Findings, by severity

**Critical (BROKEN)**

1. **Members had no task tools outside a task run.** The heartbeat tells a
   member "task … is in progress (org_task_update / org_request_review)",
   but a heartbeat or loop session offered only the common set. The same
   cut heads' loop skills (weekly review, retro, report, intake of other
   heads' requests) off from `org_task_comment` and `org_escalate`. Fixed:
   `specsFor` offers `org_task_update`, `org_task_comment` and
   `org_request_review` to every member outside a run (ownership is still
   checked at execution, `taskId` required), and `org_escalate` to unit
   leads, now guarded: the caller's own task, a task it reviews, or a task on
   its unit's board.
2. **The Auditor could not use its playbooks or read the record.** The audit
   run's restricted set filtered out skill tools and every file read, so the
   pack's skills were dead text and the "assurance over the register belongs
   to the auditor" hand-off from the chief had no receiver. Fixed: the audit
   set adds `fs_list`/`fs_read`/`fs_search`, `org_intent`, `org_decisions`,
   `org_metric_sources`/`org_metric_read` and the auditor's own private
   skills (a `skill_*` sentinel in the restricted set, resolved by the turn
   loop to the agent's own skills only); still no writes.
3. **Assurance requests went nowhere.** All 13 heads' KPI audits "file a
   backlog task for the chief naming the Auditor"; the chief had no step for
   it and the auditor never looked. Fixed with one convention — the title
   `Assurance request: …` — in the heads' skills, the chief's intake (leave it
   open, close after the report) and the auditor's new
   `audit-ledger-and-metrics`.

**High (GAP)**

4. Failure handling had no owner: blocked and abandoned work, breaker stops,
   degraded providers, card deadlines, an absent CEO → chief
   `escalation-and-blocker-sweep` (in the weekday sweep) and the built-in
   `org-member-workflow`.
5. Staffing stopped at the hire: no onboarding, probation, eval-gated change,
   pause or termination playbook, no first staffing for a new workspace →
   chief `member-lifecycle-review`, head team-management step 6, built-in
   `org-member-onboarding`.
6. Cross-functional handoffs had one side: the chief monitors
   `/org/handoffs.md`, but no head agreed an SLA or answered requests, and the
   closed-won handoff had a reader but no writer → heads' okr-planning and
   weekly-review steps, `org-member-workflow` requester/provider protocol, AE
   `closed-won-handoff`.
7. Heads could not read their reports' incidents (`org_incidents` showed a
   lead only its own), so their postmortem skills could not start → leads now
   see their direct reports' incidents.
8. FP&A named `org_costs`/`org_forecast`, which specialists were not
   offered → first worked around with a monthly extract at
   `/org/finance/spend/<yyyy-mm>.md`; since decision 2 every member reads
   the tools directly and the file is an optional monthly record.
9. The improvement loop had producers and no reader: experiment results,
   calibration, repeated lessons, playbook retirement, golden-set coverage →
   chief `learning-loop-review`.
10. The runtime holds a retro ritual for every unit, but only engineering had
    a retro skill → built-in `org-unit-retro` (also for incident postmortems).

**Medium**

11. The lead planning session (trigger `objective_assigned`) never pointed the
    head at its `<fn>-okr-planning` playbook → one line in the prompt.
12. Nobody kept `/org/` clean (missing core files, dangling ids, secrets in
    shared files) → chief `org-files-hygiene`.
13. The data scientist's `experiment-design` named `org_propose_experiment`
    (a lead tool) → rephrased: the head proposes it.

**Low (noted, not changed)**

14. Folder names differ from role ids for two functions: `cs-*` uses
    `/org/customer/`, `ops-*` uses `/org/operations/`. Skills find them with
    `fs_list /org/`; renaming would orphan existing workspaces' files.
15. Heads' loop crons are fixed defaults; the skills defer to
    `/org/<fn>/cadence.md` and `org_set_cadence`, but the loop still fires at
    the pack time. The chief's loops are derived at onboarding
    (`chiefLoops`); deriving heads' loops at hire is the same kind of work and
    is left as a follow-up.
16. The chief's pack now has 18 skills. Each is fired by name from a loop, so
    the size does not reach the model at once; the risk is drift between
    overlapping steps (e.g. `values-mechanism-audit` vs the auditor's
    `audit-values-and-culture`), handled by the split "the chief proposes, the
    auditor verifies".
17. Eight heads carry a `<fn>-operating-cadence` skill whose first step
    duplicates `<fn>-weekly-review` step 1; harmless, left.
18. The built-in org skills are global (every agent sees three more skill
    tools); each says it does not apply outside a company. Kept by decision 5.

## 3. What changed

Skills (`packs/*.md`, regenerated with `node scripts/build-authored-packs.mjs`):

- Chief of staff: new `escalation-and-blocker-sweep`, `member-lifecycle-review`,
  `learning-loop-review`, `org-files-hygiene`; `function-reports-intake`
  routes assurance requests and hands each hire to onboarding; the sweep and
  monthly loops name the new skills (pack frontmatter and `chiefLoops` in
  `server/src/org/chief-os.ts`, kept identical — the test checks it).
- Auditor: new `audit-ledger-and-metrics` and `audit-values-and-culture`.
- All 13 heads: okr-planning "Dependencies" step, weekly-review "Handoffs"
  step, team-management "Onboard every new member" step, kpi-audit files
  `Assurance request: <what>`.
- Specialists: AE `closed-won-handoff` (new); CS onboarding `kickoff-plan`
  reads `/org/customer/handoffs/<account>.md`; FP&A works from
  `/org/finance/spend/`; Head of Finance BvA saves that extract; data
  scientist hands experiments to its head.
- Built-in skills: `org-member-workflow`, `org-member-onboarding`,
  `org-unit-retro`.

Runtime (minimal; boundary unchanged):

- `org-runtime.service.ts`: task tools offered to members outside a task run;
  `org_escalate` to unit leads (loops and their own task runs) with a
  unit-scope guard; the audit run's set adds file, decision, metric and intent
  reads and the auditor's own skills; the lead planning prompt names its
  playbook.
- `turn-loop.service.ts`: `RESTRICT_OWN_SKILLS` — a restricted set may admit
  the agent's own private skills.
- `org-sensing.service.ts`: offers the two metric reads inside an audit run.
- `org-incidents.service.ts`: a unit lead sees its direct reports' incidents.
- `org-auditor.service.ts`: the audit prompt points at the playbooks, the
  files and the assurance requests.

Tests: `tests/backend-org-chief.test.ts` gains the role-aware tool check for
every business pack, loop and built-in org skill, the head escalation guard,
lead incident visibility, and a loop-closure test; existing tests updated
where the offered sets or the built-in count changed
(`backend-org.test.ts`, `backend-org-assurance.test.ts`,
`backend-skills.test.ts`, `helpers.ts` skills stub).

## 4. Decisions for the CEO — resolved

The CEO decided all five; the first four are implemented (runtime in
`server/src/org/`, skills in `packs/*.md` and the built-ins), the fifth keeps
the code as it is.

1. **Function heads hire within their unit — yes.** A head (a unit lead, or a
   member under the chief titled as a catalog `<fn>-manager`, so a new head
   can hire its first specialist; `OrgRuntimeService.headOf`) gets
   `org_hire_agent`, `org_pause_agent` and `org_update_member` for its own
   reporting line. A head hire: reportsTo the head or one of its reports;
   a role of its function (`role:<fn>-<slug>`), a generalist role or a
   template, never another head, the chief or the auditor
   (`headHireRefusal`); the agent cap counting pending hire cards; the
   unit's envelope (the allocations to the objectives of its unit and the
   units below, against the agent envelopes its line holds; the company
   envelope when it has none) and the company envelope; scopes met with the
   head's own holdings (`grantorAgentId`, re-met at apply). It routes through
   `boundary.ts` exactly like the chief's (`hire:unit`, actor `agent:<head>`):
   a card for the CEO in supervised mode, at once within the fences in
   autonomous mode (`auto_hire`, actor the head). The chief keeps its view
   of headcount: every head hire, pause and settings change sends it an
   inbox notice (origin `org`, which its heartbeat surfaces) and a group-log
   line. Skills: the 13 heads' `<fn>-team-management` step 5 hires, pauses
   and re-tools directly (step 6 onboards its own hires); the chief's
   `function-reports-intake` and `member-lifecycle-review` review the heads'
   staffing instead of executing it; the charters (role catalog, chief pack)
   say the same. Termination, scope widening, reorgs and envelopes stay the
   chief's.
2. **Spend reads for every member — yes.** `org_costs` and `org_forecast`
   (read-only) are offered to every member; a member sees the company view
   unless it names a unit. Nothing that commits or moves money is offered
   (`org_allocate_budget`, `org_set_routing`, `org_tune` stay the chief's;
   the tests check none leaks). FP&A reads the tools directly; the Head of
   Finance's `/org/finance/spend/<yyyy-mm>.md` is now an optional record.
3. **On-demand audits — yes, as a runtime trigger.**
   `OrgAuditorService.assuranceDue`: once the oldest open `Assurance
   request:` task filed since the last audit is
   `audit.assuranceDebounceHours` old, the tick runs an audit with trigger
   `assurance` (its prompt says why). The window is the debounce: every
   request filed in it is answered by that one audit, and a later request
   waits its own window. The tunable (default 6 h, bound 1–168) sits under
   `audit.*`, so it is never an agent's to change; onboarding derives it
   from the profile (2 h when speed is a value, 24 h for a control or rigour
   culture, 4 h early, else 6 h). Heads' kpi-audit skills and the chief's
   intake say a request no longer needs chasing.
4. **Escalation chain — specialists to their head, heads to the chief or the
   CEO.** `org_escalate` is offered to every member. A specialist's blocks
   the task and puts one open `Escalation: <title>` task on its manager's
   board (a repeat is a comment that wakes it again) with an inbox event; no
   CEO card. It cannot pass `to: "ceo"`. A head's goes the same way to the
   chief by default, or with `to: "ceo"` to the CEO as a decision card. The
   default is the chief because most of what a head cannot settle (another
   function's priority, a hire across units, more envelope) is the chief's
   to decide or to frame; `to: "ceo"` is for decisions only the CEO can make:
   money beyond the envelope, a policy, strategy or values call, an external
   commitment, a change the boundary reserves for the owner. The chief's
   goes to the CEO. Skills: the built-in `org-member-workflow` step 8, the
   heads' CEO-only escalations now say `to: "ceo"`, the deal desk escalates
   through its manager, and the chief's intake and sweep answer `Escalation:`
   tasks.
   *Note, 3 November 2026:* decisions now go to the direct manager first
   (`docs/owners-seat.md` §7). A head's `to: "ceo"` card reaches the chief
   first, who adds its recommendation and takes it up; only the CEO decides
   it. Every other card a member raises waits on its manager the same way: a
   hire, a settings change, a held outward action. Managers act with
   `org_decisions` and `org_decide`. A card climbs on its own when a manager
   sits on it.
5. **Built-in skills stay global — no change.** The three org built-ins
   remain visible to every agent; each says it does not apply outside a
   company.

Tests: `tests/backend-org-chief.test.ts` (the role-aware tool check with the
new sets; a head's hire within its line, outside it, another function, a
head role, the auditor, the cap and the unit envelope refused; supervised
cards requested by the head with its holdings; pause and settings with the
chief told; the escalation chain), `tests/backend-org-assurance.test.ts`
(the debounce, one audit for many requests, the tunable's boundary and
profile derivation), `tests/backend-org-capital.test.ts` and
`tests/backend-org.test.ts` (every member reads spend, none of the spend
writers leak).

