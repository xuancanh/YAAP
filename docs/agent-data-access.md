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

The company briefing (§7) ends with a line pointing at it; the
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

## 7. What every agent knows without asking

The tools above answer what an agent asks for; this section is what it is
told on every turn so it does not have to ask. Code:
`server/src/org/org-briefing.service.ts` (company members) and
`WorkspaceDataTools.contextFor` (agents outside a company). Tests:
`tests/backend-company-briefing.test.ts` over the fixture in
`tests/company-briefing-fixture.ts`.

### 7.1 The audit (before)

Built with the fixture (a chief; Writer heading a unit with one report;
Junior, a specialist in it; a mission, five values, a vision, three key
results, two projects, six tasks, three decisions) and a real
`TurnContextService`, measuring the system prompt a turn sends:

| Session kind | Chief | Head | Specialist | What the org part said |
|---|---|---|---|---|
| Chat with the owner | 7,472 | 7,920 | 7,021 | `# Organisations`: name, title, mission (≤ 300), role guidance, one `ws_catalog` line |
| Task run | 7,709 | 7,654 | 7,693 | `# Organisation run`: title, the **whole** mission, the **whole** values and culture (≤ 3,000), the brief |
| Heartbeat (org context in the beat's prompt) | +1,623 | +1,216 | +905 | mission (≤ 300), vision, the whole values and culture — on top of the chat system prompt, which already had the mission |
| Meeting round, channel wake | chat + the meeting / channel block | | | the meeting block repeats vision or mission, values and culture for the room |

Gaps: no values in a chat; no unit, manager or reports (only a title); no
projects, health or milestones; no key-result progress; no count of the
agent's own work; no recent decisions; nothing on what waits on it.
Redundancies: the mission appeared in two or three blocks of the same beat;
the values and culture (up to 3 KB) were repeated in full in every task run
and every heartbeat.

### 7.2 The company briefing

A block of at most **2,500 characters** (`BRIEFING_BUDGET`) in every
member's system prompt, every session kind except the auditor's run and
the aux runs other modules frame themselves (ask-the-company). Format, in
priority order (the measured fixture, the specialist):

```
# Company briefing: "Default"
Mission: <first sentence, ≤ 160> Vision: <title> (by <date>).
Values: Readers first · Candour · Ship weekly.
You: Junior writer, in Writer's team; reports to Writer; on P-1 (contributor, 4/5 open tasks yours).
Key results (3; red 0, amber 0):
- [green] Paid subscribers: 120/1000 (12%), due 2026-12-31
Your projects:
- P-1 "Weekly issue pipeline" — at risk; lead Writer; next milestone "Template v2" 2026-11-20; target 2026-12-15; 5 open task(s)
Your open tasks: 4 (1 blocked) — WRI-3 blocked, WRI-1 doing, WRI-4 in review, ….
Recent decisions: "Lead stories stay under 900 words" (2026-11-03); "Publish every Friday at 8:00" (2026-11-03).
Waiting on you: nothing.
More: org_company (mission, values, culture), org_people (chart), org_project <key>, org_intent (goals), org_task <key>, ws_catalog (every domain); your standing context is in ~/knowledge/company.md.
```

Per role:

| | Chief | Head | Specialist |
|---|---|---|---|
| Key results | top 5 by RAG (red, amber, grey, green), then due date | 4: its own, its reports', its unit's, those its projects move — then the rest | 3: its own and those its projects move first |
| Projects | **Portfolio**: Now projects by health, then up to 4 exceptions (breaker, off track, at risk, no update) | **Your unit's projects**: led by it or in its unit subtree, worst first, up to 4 | **Your projects**: led by it or holding one of its tasks, up to 3 |
| Extra line | **Exceptions**: blocked, unassigned, backlog to triage, cards waiting on the CEO, key results never checked in | **Staffing**: reports, idle reports, unassigned and blocked tasks in its unit | — |

RAG is Home's rule (`ragOf`: at risk red, behind pace amber, on pace green,
no measure grey). "Waiting on you" counts the decision cards it holds
(`holder = agent:<id>`), the reviews assigned to it (`in_review`), and its
unread mentions.

**Budget.** Lines carry a priority (0 = always: the header, mission, "You",
open tasks, waiting, the pointer; 1 = key results and projects heads; 2 =
values, decisions; 3 = the third and later list rows). Over the budget the
lowest priority goes first, latest line first; a hard clip is the last
resort. The test builds a company with 20 more key results, projects,
tasks and decisions with long titles and asserts every role stays within
the budget with the priority-0 lines intact.

**Scope.** As `OrgDataTools.viewer`: company-level facts (profile, key
results, the chart) are every member's; decisions follow the viewer's units
(the root, its home unit, the subtree it leads; the chief all); the project
lists follow the role (a head's unit subtree, a specialist's own). No money
— no envelopes, appetites or spend — no scopes, models or budgets of other
members, and nothing from any agent's memory or lessons ever enters the
block. The test checks that a specialist and its head do not see the other
unit's decision or its project budget, and that the other head and the
chief do.

**Cache.** One snapshot per org (org, vision, members, units, live projects,
key results with pace, open tasks, the latest 40 decisions, pending cards),
invalidated by every `org_audit` append of that org — members, goals,
check-ins, projects, tasks, decisions and cards are all audited — and by a
5-minute TTL (`SNAPSHOT_TTL_MS`; pace drifts with time). Each member's
render is cached on the snapshot's generation for a minute
(`RENDER_TTL_MS`; mentions are not audited). Two members briefed back to
back cost one snapshot; the test asserts a project-health and a goal change
rebuild it.

**What it replaced.** The mission and the full values and culture left the
task-run block; the mission and the `ws_catalog` line left the
`# Organisations` block (its role guidance stays); the heartbeat's `org`
context provider (mission, vision, values, culture) is gone — the beat's
system prompt carries the briefing. Left as they are: the planning and
structure-review prompts (chief-only, they plan *from* the full profile),
the meeting room's operating profile (it runs the room in the company's
style), the project-health duty and the decision queue in the heartbeat
(they ask for an act, not a fact).

### 7.3 Sizes after

| Session kind | Chief | Head | Specialist |
|---|---|---|---|
| Chat (whole system prompt) | 8,656 (+1,184) | 8,823 (+903) | 7,884 (+863) |
| Task run | 8,377 (+668) | 8,041 (+387) | 8,040 (+347) |
| Heartbeat org context (beat prompt) | 716 (−907) | 309 (−907) | 0 (−905) |
| Heartbeat total (system + org context) | 9,372 (+277) | 9,132 (−4) | 7,884 (−42) |
| The briefing itself | 1,494 | 1,213 | 1,173 |

The test fails when a chat or a task run grows by more than 1,400
characters over these "before" numbers, or a heartbeat beat by more than
700, and when the mission appears more than once in a prompt.

### 7.4 Outside a company

An agent that is not a member gets a workspace briefing of at most 600
characters (`WORKSPACE_BRIEFING_BUDGET`) from `WorkspaceDataTools`: the
workspace's name, its open board tasks (count and the top three keys) and
its enabled loops, with a pointer to `ws_workspace`, `list_tasks` and
`ws_catalog`. Two indexed reads; the workspace memory and the consented
profile were already in the prompt (`TurnContextService`). A member gets
no workspace block — the company briefing covers it.
