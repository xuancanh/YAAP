# Agent data access

The owner's rule: every piece of data the app stores or computes — plugins,
agent roles, the org, the vision and the rest — is reachable by agents
through tools, scoped to what the agent may see. This document is the map:
what exists, what was missing, the tools that filled the gaps, and the scope
rule each one enforces.

Code: `server/src/org/org-data.tools.ts` (company data, OrgModule),
`server/src/data-access/workspace-data.tools.ts` (workspace data, DataAccessModule),
`server/src/common/data-page.ts` (bounded output). Tests:
`tests/backend-agent-data-access.test.ts`.

## 1. Naming convention

| Prefix | Meaning | Offered to |
|---|---|---|
| `org_*` | Data of the company (the organisation running in the workspace): its profile, people, work, money, decisions. | Active members of the company. |
| `ws_*` | Data of the workspace that exists with or without a company: the workspace itself, the agents directory, the market, plugins, and the discovery tool. | Every durable agent of the workspace (`ws_market`: the chief, managers, unit leads, and agents outside a company). |
| `channel_*`, `meeting_*`, `fs_*`, `skill_*`, … | Existing families, unchanged. | As before. |

Every data tool is **one tool per domain** with a `view` (or `status` /
`kind`) parameter, `q` to filter, and `limit` / `offset` to page. Rows are one
compact line each, carry the id or key to drill down with, and a footer says
how to get the next page (`… 1–20 of 54; pass offset: 20 for more.`).
Limits have hard ceilings (`pageOf`), so no call returns an unbounded dump.

All new tools are class `read` (the provider flag for `org_*`; explicit rows
in `action-classes.ts` for `ws_*`): they run freely, are logged, and never
write. No new write path was added.

## 2. Discovery: `ws_catalog`

"What data can I query?" — every data domain, the tools that read it and the
tools that change it, marked by whether this agent actually holds them in this
session. It asks the turn loop for the session's real tool list
(`TurnLoopService.offeredTools`, the same list a turn sends the model, after
any run restriction), so it never advertises a tool the agent lacks; a domain
whose tools belong to other roles says so ("not offered to you —
org_audit_query belong to other roles"). `domain` narrows it. The domain table
(`DATA_DOMAINS`) also lists where each domain is **writable** today, so the
catalog doubles as the index of write tools.

The member context of the org runtime carries one line pointing at it; the
`org-member-workflow` and `org-member-onboarding` skills, the chief's pack
(operating-system-setup) and every function head's team-management skill
name it.

## 3. Coverage matrix

Legend: **new** = added by this change; *gap* = what was missing before.

| Domain | Read tool(s) | Gap before | Scope rule |
|---|---|---|---|
| Workspace (name, mode, quiet hours, budget) | **`ws_workspace` view profile** | no read tool (memory/profile were only in the prompt) | own workspace only |
| Workspace people | **`ws_workspace` view people** | none | names and roles; never email or account id |
| Org profile: mode, mission, rules (constitution), values, culture, memo, caps | **`org_company` view profile** | only fragments in the prompt | every member |
| Operating system (stage, culture type, norms, rituals, routing) | **`org_company` view os** | none (only `/org/operating-system.md`) | every member; rituals of the viewer's units |
| Tunables (value, bound, area) | **`org_company` view tunables**; `org_intent` (intent/planning only, chief) | full list unreadable | every member (public thresholds) |
| Boundary / policies | **`org_company` view boundary** | none | every member |
| Budgets, envelopes, allocations | **`org_company` view budgets** | none (only spend) | chief: all; others: the company envelope, their own and their reports' agent envelopes, their unit's projects and allocations |
| Spend, forecast, pulse | `org_costs`, `org_forecast`, `org_pulse` | — | as before (lead: unit; member: company) |
| Vision → objectives → key results, check-ins | `org_intent`, `org_why`, `org_read_goal` | — | as before |
| Projects, roadmap, milestones, health updates | `org_projects`, `org_project` | — | every member |
| Tasks, board | `org_read_board`, `org_unit_report`, `list_tasks` | no single-task read | company board is public to members |
| One task: brief, blocker, steps, checks, transitions, comments | **`org_task`** | transitions and the comment timeline unreadable | every member (the board is company-wide) |
| Units, org chart, reporting lines | **`org_people` view chart / units** | only `org_review_structure` (chief) | every member |
| Human employees | **`org_people` view humans** | none | titles and roles only |
| One member (reports, open work; scopes, model, budget) | **`org_people` view member** | none | public part to all; scopes/model/budget only to itself, members up its chain, the chief |
| Agents directory and live status | **`ws_agents`** (home/agent-status.ts) | none | own workspace; charter and status, never memory, lessons or private skills; error text redacted |
| Capacity / WIP | `org_capacity` | — | as before |
| Role catalog | `org_roles` | — (added on main) | chief and function heads |
| Market: packs, connectors, registry (agents, skills, apps, company blueprints) | **`ws_market`** | none | chief, managers, leads, agents outside a company |
| Plugins, interfaces, providers, bindings, conformance, catalog | **`ws_plugins`** | none (only change records) | own workspace; a plugin's grants show only the caller's |
| Change records | `change_list`, `change_status` | — | as before |
| Connections and cards | **`ws_workspace` view connections**; cards already in the prompt | none | only the caller's own grants; tokens and account emails never |
| Skills (own + shared) | **`ws_workspace` view skills**; `skill_*` tools | no listing | own private skills and shared ones; never another agent's private skill |
| Playbooks | `org_playbooks` | — | as before |
| Channels, threads | `channel_list`, `channel_read` | — | channels the agent belongs to |
| Meetings, minutes, calendar of cadences | **`org_meetings`** (upcoming / recent / minutes / cadences) | only `org_recall` keyword hits | company-level meetings to all; a unit's to its members, its leads up the tree and the chief — another unit's minutes are refused |
| Decision log | `org_decisions` | — | as before |
| Decision queue | `org_decision_queue` | — | managers |
| Approvals history (decided cards) | **`org_approvals`** | none | chief: all; others: cards they or their reports requested, or that passed through them |
| Incidents | `org_incidents` | — | as before |
| Signals, pulse, metric sources and samples | `org_signals`, `org_pulse`, `org_metric_sources`, `org_metric_read` | — | as before |
| Experiments, predictions, calibration | `org_experiments`, `org_calibration` | — | as before |
| Evals (golden sets) | `org_eval_cases` | — | chief and leads |
| Audit log | `org_audit_query` | — | chief and auditor (unchanged; heads read their unit through the other tools) |
| Company memory (cited) | `org_recall`; own history `search_history` | — | as before |
| Follows | `list_follows` | — | own rows |
| Files, artifacts, mirrored playbooks and minutes | `fs_list`, `fs_read`, `fs_search` | — | WorkspaceFs permission table |
| Usage and cost | **`ws_workspace` view usage**; `org_costs` | none outside a company | totals to all; the per-agent split to the chief and to agents outside a company, others their own row |
| Inbox / owner messages | — (the owner's inbox is the owner's) | by design | agents write with `message_owner`; they do not read the owner's inbox |

Never readable by any agent through these tools: connection tokens and
refresh tokens, people's emails and account ids, other agents' memory and
lessons, other agents' private skills, another member's private sessions.

## 4. Scope rule

`OrgDataTools.viewer` computes, per call:

- **units**: the chief — every unit; anyone else — the root (company-level)
  unit, the unit it belongs to (`unitForAssignee`), and, for a lead, the
  subtree of the unit it leads;
- **line**: itself plus every member whose chain of managers reaches it (the
  chief: everyone).

Company-level facts (profile, OS, tunables, boundary, chart, units, task
board) are every member's. Unit items (meetings and their minutes, project
budgets) follow `units`; private member details (scopes, model, budget) and
approvals follow `line`.

## 5. Prompt size

Pointers replace dumps where that loses nothing essential: the planning
prompt already points at `org_roles` instead of listing the catalog (main);
`org_tune`'s key hint points at `org_company view tunables`; the channel
context outside a channel names at most 8 channels (`CONTEXT_CHANNELS`) and
points at `channel_list` for the rest, topics clipped; members get one line
naming `ws_catalog` instead of more per-tool prose.

## 6. Tool-spec budget

Measured with the org harness (`tests/org-governance-harness.ts` plus the
project tools; providers that need extra wiring — channels, plugins, meetings
runtime — are not in it), total JSON of the tool specs a chief is offered:

| | Tools | Bytes |
|---|---|---|
| Before | 85 | 59,543 |
| After (+10 data tools) | 95 | 63,787 |

The test asserts the chief stays under **66,000 bytes** and that the data
tools cost under 7 KB. Descriptions are terse on purpose: the tool output,
not the spec, carries the explanation.
