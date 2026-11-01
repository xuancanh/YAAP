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
| tunable | `actions.*`, `trust.*`, `seat.*` | propose (not delegable) | the external-action floor; what silence from the owner means |
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
  `org_terminate_agent`, `org_reorg`, `org_allocate_budget` and
  `org_set_routing`. The route runs before a plan captures the action, so a
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

The chief cannot change its own settings, and a model change carries over to
the member's existing chats unless `applyToChats` is false. The CEO changes
any of these directly on the agent's Settings tab.
