# The self-modification boundary

*Execution-plan item 31; capability C8 in
`docs/autonomous-org-first-principles.md`. Shipped 2 November 2026.*

The organization changes itself: it tunes thresholds, sets cadences, routes
models, activates playbooks, hires, reorganizes and moves money. Principle 2
says the one who does is not the one who changes the rules. Before this item,
what the chief could change on its own was spread across tool code. Now it is
one table, written as data, and every self-change path asks it first.

Code:

- `server/src/org/boundary.ts` — the table, `ruleFor`, and the pure
  `checkBoundary(change, actor)`.
- `server/src/org/org-boundary.service.ts` — `OrgBoundaryService`. It binds
  the decision into `OrgService` (`gate`, `boundaryDecide`) and adds the side
  effects.
- `GET /api/workspaces/:id/org/boundary` — the table, for the owner and the
  SPA.

## 1. The four verdicts

| Verdict | Meaning for an agent (the chief, a lead, a member) |
|---|---|
| `alone` | The change may be made without the CEO. The company's mode still applies: in supervised mode the change is an approval card, as before. In autonomous mode it acts within the caps (depth, fan-out, agent cap, envelope, the chief's own holdings). |
| `experiment` | The change goes through an experiment (item 30, `org_propose_experiment`): a hypothesis, the metric source it should move, a window and a revert rule. The tool refuses the change and names `org_propose_experiment`. On a server without the experiments service, the change becomes an approval card instead (`boundary.experimentFallbackCard`). |
| `propose` | The change is an approval card for the CEO, in every mode, including autonomous. The card defaults to deny at its deadline. |
| `never` | No agent may make the change. The attempt is refused and written to the audit chain. It also opens a critical `audit_finding` signal for the CEO and a minor `boundary_violation` incident: one per agent and rule while the incident is open, and the trust ledger counts it. |

Humans are not bound: the owner, a CEO or board member, an approved card, or
a default the owner set. The exception is the rows marked *everyone*: no one
rewrites the audit chain. An experiment that applies an approved change uses
the actor `experiment`. That actor passes everything except a `never` row.

## 2. The table

| Family | Scope | Verdict | Why |
|---|---|---|---|
| tunable | `audit.*`, `redteam.*`, `boundary.*` | never | the auditor's independence; the test of the org; the boundary's own settings |
| tunable | `actions.*`, `trust.*`, `seat.*`, `chief.proxyLevel` | propose (not delegable) | the external-action floor; what silence from the owner means; how far the chief acts on the CEO's behalf (`docs/chief-of-staff.md`) |
| tunable | `incidents.*`, `acceptance.*`, `signals.*`, `pulse.*`, `slo.*`, `evals.*`, `capital.vetoWindowMinutes` | propose | safety floors, what counts as verified, what the owner sees, the eval gate, the veto window |
| tunable | any other key | alone | the bound is the safety floor and lives in code |
| cadence | meeting cadences | alone | bounded by the ritual tunables |
| routing | model routing by task class | alone | the eval gate replays the golden set first (`docs/evals.md` §3) |
| playbook | activating a reviewed version | alone | peer review, and the eval gate for a new version |
| charter, role | a member's charter or role | experiment | a change to how a member works has to be measured |
| hire | under one manager | alone | internal structure within caps |
| reorg | within one unit (one lead and its direct reports) | alone | as above |
| reorg | across units | experiment | structure beyond one unit |
| terminate | a member who leads nobody | alone | the agent itself survives |
| terminate | a unit lead (its reports move up) | experiment | it reshapes two units |
| scope_widen / scope_narrow | a member's scopes | alone | widening only within the chief's own holdings; the cap refuses anything beyond |
| budget | an agent or project envelope inside the company envelope | alone | allocation inside the envelope the owner set |
| budget | the company envelope, or above it | propose | money beyond the envelope |
| constitution | the CEO's standing rules | propose (not delegable) | the legislature is the owner |
| caps | agent cap, depth, fan-out | propose (not delegable) | the fence the org acts within |
| external_floor | action classes, staging, two-key | propose (not delegable) | what may leave unattended |
| trust_ceiling | trust ceilings per class | propose (not delegable) | how far autonomy may grow |
| audit_settings | auditor seat, cadence, cap, rotation, spot checks | never | the auditor's independence and data access |
| audit_chain | the hash-chained log | never, for everyone | the record everything else is checked against |
| kill_switch | the org's pause | never | the owner's stop button |
| frozen_classes | classes frozen by an incident | never | lifted by the owner resolving the incident |
| delegation | who decides cards for the owner | never | delegating authority is the owner's act |
| eval_cases | golden-set cases by hand | never | the yardstick; harvesting adds cases from verified work |
| self_guidance | a member's own "How I work" notes and its own lessons | alone | working notes within its charter; every change names its lessons, and a person can edit or undo it |
| guidance_proposal | a charter or playbook change raised by a repeated lesson | propose | the CEO decides the charter card; the playbook's owner and reviewer the revision |
| lesson_audience | who reads a member's private lesson | never | widening one person's private lesson to everyone is the owner's call |

`delegable` on each row says whether a card for that change may be decided
by a delegate (`docs/owners-seat.md` §2).

## 3. Where it is enforced

The decision lives in one function, `checkBoundary`. There are two ways to
reach it:

- **The fence.** Every writer of a self-change calls `OrgService.gate(orgId,
  change, actor)`. The gate refuses anything other than `proceed`. The
  writers are `setTunable`, `setRouting`, `setScopes` (widening),
  `setBudget`, `acceptCharter`, `update` (audit settings, the fan-out cap,
  the company envelope), `setStatus` (the kill switch), `updateMember` and
  `terminateMember`, `OrgApprovalsService.applyHire`,
  `OrgMeetingsService.setCadence`, `OrgPlaybooksService.activate`,
  `OrgEvalsService.addCase` and `retireCase`, `OrgSeatService.delegate` and
  `revoke`, and `TrustService.setCeilings` (through the bridge's `boundary`
  hook). Item 30's `checkChange` asks the boundary for tunable experiments:
  a never-key is refused, and a propose-key is sent back to `org_tune`.
- **The route.** The chief's tools ask first, through
  `OrgService.boundaryDecide`, and turn the answer into a path:
  - `card` becomes an approval card whose payload carries `boundary` and
    `boundaryRule`;
  - `experiment` (with the experiments service present) and `refuse` are
    errors, and the error text is the reason;
  - `proceed` continues down the mode's usual path.

  The tools are `org_tune`, `org_hire_agent`, `org_set_scope`,
  `org_terminate_agent`, `org_reorg`, `org_allocate_budget`,
  `org_set_routing` and `org_update_member`. A function head's
  `org_hire_agent` and `org_update_member` take the same route (see
  "Function heads" below). The route runs before a plan captures the action, so a
  previewed plan never holds a change that would be refused when it applies.

Decisions are kept in a short in-memory log, `OrgBoundaryService.recent`,
and passed to listeners (`onCheck`). The tests use these to prove that every
path family consults the boundary. A non-`proceed` decision by an agent is
written to the audit chain as `boundary_route`, and a violation as
`boundary_violation`.

## 4. Departures

- Retitling a member is a reorg within its unit (`alone`), not a role
  change. The `role` row is the family for role definitions; no agent path
  edits one yet.
- "Within one unit" means that every member the change touches (the moved
  member, its old and new managers) is one lead or a direct report of that
  lead, *before* the change.
- An agent-initiated hire is always within one unit, because it lands under
  one manager.
- An over-envelope agent or project allocation is still refused by the cap,
  as before. Only the company envelope itself becomes a card.
- Scope widening within the chief's holdings stays `alone`, as in item 16.
  The holdings are the cap.
- Frozen classes, the kill switch and the constitution have no agent path.
  Their rows exist so that a future path inherits the rule, and so that the
  delegation check can read `delegable`.

## Member settings (added 2 November 2026)

The chief of staff changes a report's own settings with `org_update_member`.
Four rows govern it:

| Row | Verdict | Why |
|---|---|---|
| `member_identity`: name, role, emoji, colours | alone | presentation only: no authority, money or behaviour changes |
| `member_model`: agent type and model | alone, after the eval gate | like routing, it trades cost for quality inside the envelope; the member's golden set replays on the new model first and a regression blocks it. In supervised mode it is a `member_settings` card |
| `member_heartbeat`: on/off and cadence | alone | bounded by the heartbeat fence in code |
| `member_folder`: assigned workspace folder | propose | it widens which shared files the member can read and write |

`unit_name` (added 4 November 2026): a department's name, renamed with
`org_rename_unit` by the chief (any department) or a function head (its
own) — **alone**: presentation only; the unit id, its board, goals and task
key prefix are unchanged and the old channel slug keeps resolving
(docs/group-chat.md §7 "Department names").

The chief cannot change its own settings, and a model change carries over to
the member's existing chats unless `applyToChats` is false. The CEO changes
any of these directly on the agent's Settings tab.

## Function heads (added 2 November 2026)

The CEO decided (docs/autonomous-skills-review.md §4, decision 1) that a
function head staffs its own unit. A head is the lead of a non-root unit, or
a member reporting to the chief whose title is a function head's in the role
catalog (`<fn>-manager`, e.g. "Head of Sales"), so a new head hires its first
specialist. Its tools and their rows:

| Tool | Row | Extra fences (in code, every mode) |
|---|---|---|
| `org_hire_agent` | `hire:unit` (alone), actor `agent:<head>` | reportsTo the head or one of its reports; a role of its own function or a generalist role or template, never another head, the chief or the auditor; the agent cap (counting pending hire cards); the unit's envelope — the allocations to the objectives of its unit and the units below, against the agent envelopes its reporting line holds — and the company envelope; scopes meet the head's own holdings (`grantorAgentId` on the card, re-met at apply) |
| `org_pause_agent` | none (a narrowing) | its own reporting line only |
| `org_update_member` | the `member_*` rows above | its own reporting line only |

Supervised mode makes the hire a card for the CEO (`requestedBy` the head),
as for the chief; autonomous mode applies it within the fences and records
`auto_hire` with the head as actor. The chief keeps the one view of
headcount: every head hire, pause and settings change sends it an inbox
notice (origin `org`, which the heartbeat surfaces) and a line in the group
log. Terminations, scope widening, reorgs and envelopes stay the chief's.

## On-demand audits (added 2 November 2026)

Decision 3: an open task titled `Assurance request: …` brings the next audit
forward. This is a runtime trigger in `OrgAuditorService.tick`, not an agent
power: once the oldest such request filed since the last audit is
`audit.assuranceDebounceHours` old (default 6, bound 1–168, derived from the
profile at onboarding: 2 when speed is a value, 24 for a control or rigour
culture, 4 early, else 6), one audit runs with trigger `assurance` and
answers every request filed in the window. The key sits under `audit.*`, so
it is `never` an agent's to change, like the cadence it shortens.

## Who reviews a card first (added 3 November 2026)

The verdicts above decide **whether** a change needs a card. Who reviews it
first is the direct manager of the member who raised it
(`docs/owners-seat.md` §7).

- A `propose` row's card is CEO-reserved. It passes through the requester's
  managers for their recommendations, but no manager may decide it.
- A card a manager may decide is one within the authority table: in its
  reporting line, within its unit headroom, at its trust. Examples are an
  `alone` row's card in a supervised company, or a card its raiser could not
  act on alone.
- A manager's approval applies as that manager (`agent:<id>`), so this
  table still binds it.
- Only the owner decides a card whose row says `delegable: false`.


## Learning as they work (added 4 November 2026)

`docs/agent-memory.md` §12. A member keeps its own **How I work** section
with `memory_guidance` (`self_guidance`, `alone`): `AgentGuidanceService.writeSelf`
asks `checkBoundary` and refuses a change that names none of the member's
lessons. The charter stays the manager's or the owner's: no agent path
writes it. A lesson learned `memory.guidanceRepeats` times (a tunable
derived from the profile: 4 for rigour or a control culture, 2 for speed or
an adhocracy, else 3) is proposed by `OrgLearningService.proposeGuidance`
through `OrgService.boundaryDecide` (`guidance_proposal`, `propose`): a
`charter_change` card for the CEO with the diff and `lessonIds`, or a revise
task for the playbook the lesson names. The existing `charter` row
(`experiment`) still governs an agent changing a charter directly; a card
is the CEO's change, so it passes. `lesson_audience` is `never`: only the
owner's route widens a private lesson.
