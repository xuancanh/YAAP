# Group chat: channels, threads and agents that talk

Status: **shipped, 1 November 2026** — execution-plan item 15 (§1–§4, §6:
channels, wake rules, threads/files/tasks, delivery), item 16 (§5,
organization mode), item 17 (§7, units) and item 19 (§8, meetings). Each
section ends with a *Shipped as* note naming the code;
`tests/backend-groupchat.test.ts` (13 tests), `tests/backend-org-units.test.ts`
(9), `tests/backend-org-meetings.test.ts` (11) and `web-tests/channels.test.ts`
cover it.
Supersedes the "group session that wakes nobody" in
`docs/autonomous-company.md` §4 (see the revision note there).

The owner's correction after items 1–14 shipped: the company is the
workspace, and the group chat is a Slack channel, not a log. Humans and agents
converse in channels; agents participate. This document is the design for
that, written against what already exists (chat sessions and the turn loop,
shared workspaces with members and routed approvals, the organization layer,
the file store, event delivery).

## 1. Model

A **workspace** is the company. Every workspace, personal or shared, has
channels. A workspace may switch on **organization mode** (§5), which adds the
chief of staff, the reports-to tree, goals, budgets and the board. Nothing in
this document requires organization mode: a personal workspace with one user
and three agents gets `#general` and can add channels. Agents belong to one
workspace (`agents.workspaceId`, docs/shared-agents.md "Workspace
ownership"): a channel's members, "all agents" at creation and the member
picker are the workspace's own agents, and adding one from another workspace
is refused.

Tables (all `accountScoped()`):

- `channels` — id, workspaceId, slug, name, topic, kind `public|private`,
  createdBy (`human:<memberAccountId>` | `agent:<agentId>` | `system`),
  folder (path in the workspace store, default `channels/<slug>/`),
  dailyTokenBudget (0 = workspace default), archivedAt, createdAt.
- `channel_members` — channelId, memberKind `agent|human`, memberId,
  role `owner|member`, notify `all|mentions|none`, unprompted `0|1`
  (whether this agent may reply without being mentioned), joinedAt.
- `channel_messages` — id, channelId, threadRootId (null = top level),
  authorKind `agent|human|system`, authorId, text, attachments JSON,
  mentions JSON (`[{kind, id}]`), taskId (when the message became or
  reports on a task), runId (agent replies carry the org/chat run that
  produced them), editedAt, createdAt.
- `channel_reads` — channelId, memberAccountId, lastReadMessageId.

Default channels: `#general` in every workspace (created on workspace
create and backfilled by migration); `#company` when organization mode is
enabled (system announcements: hires, reorgs, budget events, brief).

Direct messages are the existing agent chat sessions. The rail lists
channels and DMs together; nothing changes in the DM data model.

*Shipped as:* migration `0029-group-chat` (the four tables, a GIN FTS index
on `channel_messages.text`, `channelId`/`messageId` on `agent_tasks` and
`org_tasks`, `#general` backfilled with `INSERT … WHERE NOT EXISTS`);
`server/src/groupchat/groupchat.service.ts` (`ensureChannel`,
`ensureGeneral` through `WorkspacesService.onCreated`, CRUD, members,
`post`, `postSystem`, reads/unread, `files`, `makeTask`, mention
notifications); `server/src/groupchat/mentions.ts` (`parseMentions`,
`slugify`); `groupchat.controller.ts` under
`/api/workspaces/:id/chat/channels…` (the bare `/channels` path is the
member-pairing route of `shared.controller.ts`). Private channels are a 404
to non-members; `#general` cannot be archived and no human can be removed
from it; no agent tool can change membership (§6). In the SPA:
`src/components/ChannelView.tsx`, the Channels block in `Rails.tsx`, the
`channel` home view in `store.tsx`, `src/lib/channels.ts`.

## 2. Who speaks, and when

A message is posted by a human (the UI, a paired Telegram/email member) or by
an agent (its reply, or an `channel_post` tool call). After every post the
runtime computes a **wake set**:

1. **Mentioned agents** that are channel members always wake. A mention is
   `@name` resolved against channel members (humans included; a mentioned
   human only gets a notification).
2. **Unprompted replies.** For each agent member with `unprompted=1` that
   was not mentioned, one cheap relevance call (the review model from
   `docs/permissions.md` §6, no tools, ~200 output tokens) sees the agent's
   charter, the channel topic and the last 12 messages, and answers
   `{ reply: boolean, reason }`. Bounds, all enforced before the model call:
   at most one unprompted reply per agent per channel per 2 minutes, at most
   two unprompted repliers per message, none while a mentioned agent is
   still replying in the same thread, none to a message that is itself an
   unprompted agent reply (prevents agent chatter), and none when the
   channel's daily token budget is spent.
3. **Agent-to-agent chains.** An agent reply that mentions another agent
   wakes it, up to **3 rounds per thread** counted from the last human
   message; after that the runtime posts a system line ("paused: three
   agent rounds — mention a person to continue") and stops waking.

A wake runs the agent through `TurnLoopService.run` in a per-agent,
per-channel session named `#<slug> · <agent>` (hidden from the DM list). The
turn input is the triggering message; the system context carries the channel
topic, the thread or the last 30 messages with attribution (`<channel-history>`
framed as data), the channel folder mounted as `shared/`, and the rule that
mentions carry no approval authority. Origin is `user` with `initiatedBy` = the
human author of the triggering message (or, for an agent-triggered wake, the
last human in the thread), so Ask approvals route exactly as in shared
workspaces (`docs/shared-agents.md` §3) and appear in the channel as an
approval card visible only to the addressee. The reply streams into the
channel as a live message (SSE over the workspace event stream), then
persists as a `channel_messages` row with `runId`.

Channel tools offered to agents in channel sessions (in addition to their
normal set): `channel_post(channel?, text, thread?)` (read-only class: it
only posts where the agent already is), `channel_read(channel, limit)`,
`channel_make_task(messageId, title?, assignee?)` (creates a board task
linked to the message; posts a system line), `channel_list`. Posting to a
channel the agent is not a member of is refused.

*Shipped as:* `server/src/groupchat/channel-runtime.service.ts`. The wake set
is computed in `handlePost` after every non-system post, with every §2 bound
checked before the relevance call (`relevanceFn` is the test seam; the real
call uses `cheapestModelFor` on the agent's provider, no tools, 200 output
tokens, JSON `{reply, reason}`, parse failure = silence). The chain cap counts
agent messages since the last human message in the thread
(`agentRoundsSinceHuman`) and posts `PAUSED_LINE`; a spent budget posts
`BUDGET_LINE` on a mention and silences unprompted replies. The budget is the
channel's `dailyTokenBudget`, else the `channelDailyTokenBudget` setting
(default 200k, `0` = unlimited), measured as today's `chat_turns` tokens of
the channel's sessions. A wake is `TurnLoopService.run` in `#<slug> · <agent>`
(shared, tagged `channel`, Ask mode) under `runWithViewer` as the human
author (`runAs`), so routed approvals behave as in shared workspaces; a plain
Ask approval becomes a `channel_approval` SSE event for that person plus an
addressed `approval_request` inbox event (TTL-denied otherwise). The reply
streams as `channel_stream` and persists with `runId` = the turn id. Channel
tools are registered through `TurnLoopService.addToolProvider`
(`ToolProviderHook`, the generic shape of the org hook), which also mounts
the channel folder as `shared/` via `sharedFolderFor`.

## 3. Threads, files, tasks, goals

- **Threads.** `threadRootId` groups replies; the UI shows a thread panel;
  agent replies to a message in a thread stay in that thread; the 3-round
  chain cap is per thread.
- **Files.** Each channel owns `channels/<slug>/` in the workspace store;
  agents in channel sessions see it as `shared/`; humans get a Files tab
  with the existing preview component and drag-drop upload. Attachments
  on messages are stored there.
- **Tasks.** Any message → "Make task" (human) or `channel_make_task`
  (agent) creates a task on the workspace board (organization-mode board
  when enabled, else the assignee agent's kanban) with `channelId` and
  `messageId` recorded; task status changes post a system line into the
  originating thread; the task drawer links back to the message.
- **Goals.** Organization-mode goals can be referenced with `#goal:<id>`
  in a message; the goal page lists linked messages.

*Shipped as:* threads — `threadRootId`, replies to a reply are re-rooted,
`GroupChatService.messages({ thread })`, the thread panel in `ChannelView`.
Files — `channels/<slug>/` under the workspace store; uploads go through the
existing `POST /api/workspaces/:id/files` with that path; the Files tab lists
`GET …/chat/channels/:slug/files` and opens the existing preview. Tasks —
`GroupChatService.makeTask` chooses the organisation board when the workspace
has an active organisation (`orgFor`), else the assignee agent's kanban
(`AgentsService.addTask` with `channelId`/`messageId`); both task services
emit `TriggerBus.emitTaskStatus` on a status change and the group chat posts
`Task [id] "title" → status` into the originating thread and a `task_update`
SSE event. Goals (item 17): `#goal:<id>` (full id or a prefix of ≥ 4
characters matching one goal) is parsed by `mentions.ts` `parseGoalRefs`,
resolved in `GroupChatService.post` into a `{ kind: 'goal', id }` entry of
the message's `mentions`, rendered as a chip in `ChannelView` that opens the
goal tracker, and listed on the goal through
`GET /api/workspaces/:id/chat/goals/:goalId/messages`
(`GroupChatService.goalMessages`). System lines carry no references.

## 4. Delivery and presence

Workspace-level SSE (`GET /api/workspaces/:id/events`) carries
`channel_message`, `channel_typing` (agent run started), `channel_stream`
(tokens), `task_update`. Unread counts per channel from `channel_reads`.
Mentions of a human notify through their paired channels (Telegram, email,
push) with the deep link `#/ws/<id>/channel/<slug>/<messageId>`, subject to
quiet hours. Paired members can post into a channel from Telegram with
`#slug text`.

*Shipped as:* `server/src/groupchat/workspace-events.ts` (`WorkspaceEventBus`)
and `GET /api/workspaces/:id/events` (same wire format as the turn stream,
15s keepalive; the SPA reads it with `subscribeWorkspaceEvents`, one
connection per workspace with backoff). Events: `channel_message`,
`channel_typing`, `channel_stream`, `task_update`, `channel_update`,
`channel_approval`. Mentions of a human create a `mention` inbox event on
the sentinel agent id `channel:<id>` (so it lands in no agent's inbox) with
`payload.link`, addressed to the member (`forMemberAccountId`) or the owner
(`channel: true`); the Telegram, email and push sweeps render `eventLink` /
`eventHead` (`agents.service.ts`) so the deep link replaces the chat link.
Members with `notify = all` get every message; `none` gets nothing.
`TelegramService.handlePaired` posts `#slug text` as the paired person
(`GroupChatService.postFromPairedChannel`). `SearchService` returns
`channelMessages` from the FTS index (private channels only for members).

## 5. Organization mode

**Status: shipped as (1 November 2026, execution-plan item 16).** Migration
`0028-org-mode` adds `workspaces.orgMode | chiefOfStaffAgentId |
orgMonthlyUsd | orgAgentCap` and makes `organizations.workspaceId` unique
among non-archived rows (duplicates keep the oldest, the rest are
`status = archived`; workspaces that already had an org land in
`supervised`). `OrgModeService` (`server/src/org/org-mode.service.ts`) behind
`PUT /api/workspaces/:id/org { mode, chiefOfStaffAgentId?, monthlyUsd?,
agentCap? }` creates the 1:1 org on first enable (named after the workspace),
seats every agent — chief at the root, the rest under it, overflow one level
down within depth 3 — writes `org_mode` audit and announces through the
`Announcer` seam (`org-announcer.ts`: `announce(workspaceId, text)`;
`GroupChatService` binds itself into the exported `OrgAnnouncer` at boot —
`ensureCompany` creates `#company` with every agent and person on the first
announcement, then `postSystem` — so enabling a mode, every autonomous
structural action and the kill switch land in `#company`; unbound it drops
the line). `off` pauses the runtime and hides the panes,
deleting nothing. `POST /api/workspaces/:id/org/pause | resume` is the kill
switch; every `/api/orgs/:id/...` route has a thin alias under
`/api/workspaces/:id/org/...` (`WorkspaceOrgController`) and the UI uses
those. Autonomous mode is in `OrgRuntimeService.execute`: `org_hire_agent`,
`org_reorg` (was `org_propose_reorg`), `org_set_scope` widening,
`org_allocate_budget` (was `org_budget_request`) and `org_terminate_agent`
execute at once when depth ≤ 3, fan-out ≤ 5, members < `orgAgentCap`, agent +
project envelopes ≤ `orgMonthlyUsd` (an envelope of 0 refuses every
allocation), scopes ⊆ the chief's holdings, and `why` is given; each refusal
carries its reason and queues nothing; each execution writes an `auto_*`
audit row with the reason, an inbox line on the chief, a `#company` line and
a "## Autonomous actions" section in the next brief. The old tool names are
accepted for one release. The chief's routine: `TriggerBus.emitOrgBoard`
(task blocked, escalation, budget warning, new goal) coalesces into one
structure review run per org (10-minute cooldown) in the `Org · <name> ·
Chief review` session, plus one review a day at the brief hour;
`org_review_structure` lists idle and overloaded members, unassigned goals,
unowned and blocked tasks and headroom against every cap. UI: the Company
section is gone; the Workspace rail shows Board, Goals, Org chart, Approvals
(hidden in autonomous mode unless something is pending), Spend, Brief and
Audit under the current workspace, Settings → Workspace has the
"Organization" card (mode, chief, envelope, cap, pause/resume), the chief's
agent home says "Chief of staff of <workspace>", and
`#/ws/<id>/org/<pane>` deep-links a pane. Tests:
`tests/backend-org-mode.test.ts`. Not done: the group log pane (replaced by
`#company`, item 15); `channel_make_task` → board linkage is item 15's.

**Onboarding (execution-plan item 25, 1 November 2026).** "Add workspace"
opens a wizard instead of a name prompt: name and colour, then "run this
workspace as a company?" with three cards — just a workspace, company
supervised, company autonomous (the caps and the veto window shown) — each
with its plain-language consequence; for a company, the chief of staff
(created with the workspace — a new workspace has no agents of its own yet;
an existing one may also pick one of its agents), the mission and vision
(one line, a paragraph, a horizon of 30/90/180/365 days or a date, standing
rules), values and culture (the §1b operating profile, two short paragraphs),
the budget and agent cap with the fence, the rhythm (default / light / none,
one line per ritual), the first hires from item 24's role catalog (`GET
…/org/roles?profile=` ranked against the profile written so far; each
sent as `role:<id>` and hired with the role's charter and its scopes met
with the chief's; hidden when the route is absent), and a review of
everything that will be created. One
`POST /api/workspaces/:id/org/bootstrap` (`OrgBootstrapService`) then does
the setup in order through the existing services — chief, `setMode`,
`setVision`, `setProfile`, each tunable within its bound (checked before
anything exists), cadences, hires through the one hire path (cards in
supervised mode, seated within caps in autonomous mode), the first planning
session fire-and-forget — audited as one `org_bootstrap` row plus each step's
own decision row, and refused with 400 when the workspace already has a
company. Settings → Workspace → Organization has "Enable company…" opening
the same wizard from the mode step for an existing workspace. Nothing the
chief reads is a hidden default: what the wizard leaves blank stays at the
documented tunable defaults the Settings card shows.

`workspaces.orgMode` ∈ `off | supervised | autonomous`, plus
`chiefOfStaffAgentId`, `orgMonthlyUsd`, `orgAgentCap` (default 12). Enabling
it creates the 1:1 organization record (the existing `organizations` row and
tables stay; `organizations.workspaceId` becomes unique), makes every agent in
the workspace an `org_member` (the chief at the root, the rest reporting to
it), and creates `#company`. The Company panes (org chart, board, goals,
approvals, spend, brief, audit) move under the workspace in the rail; there is
no separate Company section.

**Autonomous** (the default when enabling): the chief of staff's
`org_hire_agent`, `org_propose_reorg` (now `org_reorg`), `org_set_scope`
(widening included), `org_budget_request` (now `org_allocate_budget`) and
`org_terminate_agent` execute immediately **within caps**: depth ≤ 3,
fan-out ≤ 5, agents ≤ `orgAgentCap`, allocated budgets ≤ the company monthly
envelope, scopes ⊆ the chief's own scopes (meet), no connection or memory
inheritance. Every action writes audit, posts to `#company`, and appears in
the brief. Actions outside caps are refused with the reason (not queued).
**Supervised**: today's behaviour — those actions create approvals. In both
modes external actions (sending mail, payments-class tools) keep their tool
policy, budgets hard-stop, and `POST /api/workspaces/:id/org/pause` is the
kill switch.

## 6. Non-goals

No voice/huddles; no message search beyond the existing FTS extended to
`channel_messages`; no reactions beyond 👍/👎 (which feed skill outcomes); no
cross-workspace channels; no agent may add itself to a channel.

## 7. Units: a board, a channel and a goal tracker per org level

**Status: shipped as (1 November 2026, execution-plan item 17)** — see the
note at the end of the section. Every agent with at least one
direct report leads a **unit**. The root unit is the company, led by the chief
of staff, and its channel is `#company`. A unit is created automatically when
an agent gains its first report (hire or reorg) and archived, data kept, when
its last report leaves.

- `org_units` — id, orgId, leadAgentId, parentUnitId (null for the root),
  name (default "<lead>'s team"; the root is the workspace name), slug,
  channelId, archivedAt, createdAt.
- **Channel.** `#<slug>` with members = lead + direct reports + the
  workspace's human CEO and board members. Membership follows the org chart:
  hire, reorg and termination add and remove channel members. Task status
  lines for tasks that did not originate in a channel post into the unit
  channel.
- **Board.** `org_tasks.unitId` defaults to the unit led by the assignee's
  manager (a lead's own tasks belong to its parent unit; tasks it creates for
  reports belong to its unit). The unit board shows its tasks; the company
  board offers "this unit only" and "roll up" views.
- **Goal tracker.** `org_goals.unitId` and `parentGoalId`. Progress = done /
  total of linked tasks plus the mean progress of child goals; the tracker
  shows the goal tree with progress bars and linked tasks and messages.
- **Lead tools.** A unit lead gets `org_set_goal` (child of a goal it can
  see), `org_create_task`/`org_assign` within its unit, and
  `org_unit_report` (board and goal progress for its unit). The chief keeps
  the company-wide set.
- **UI.** Under the workspace, the rail shows the company (`#company`, Board,
  Goals) and each unit as a collapsible group (`#channel`, Board, Goals); the
  org chart draws unit boundaries.

*Shipped as:* migration `0030-org-units` (`org_units` with a unique
`(orgId, leadAgentId)`, `org_tasks.unitId | unitExplicit`,
`org_goals.unitId | parentGoalId`) and the exported `backfillOrgUnits`
(pure SQL: a root unit per live org with `#company` created when missing,
a unit per lead with reports, `unitId` on existing tasks and goals by the
default rule — goals without an owner land in the root).
`server/src/org/org-units.service.ts`: units are *derived* from the
reports-to tree — `OrgService.onStructureChange` fires after `addMember`,
`updateMember` (reporting line), `terminateMember` and `replaceChief`, so
enrolment, hires (approved or autonomous), reorgs, terminations and a chief
swap all run `syncMembership`, which creates (`ensureUnitFor`), archives
(`archiveIfEmpty`, data kept, one row per lead ever, un-archived when the
lead gains reports again), re-parents and re-roots (the root follows the
chief's seat; its channel stays `#company`) and keeps every unit channel's
membership equal to the chart (non-root: lead + direct reports, plus the
owner and `org_humans` CEO/board; root: every live member, terminated ones
removed). Channel operations go through the `UnitChannels` seam on
`OrgAnnouncer` (bound by `GroupChatService`, which de-duplicates `#<slug>`
against the workspace's channels — `#editor` taken → `#editor-2`); unbound,
units exist without channels. The unit name defaults to "<lead>'s team" and
the root to the organization's name; `PATCH …/units/:unitId` renames.
Boards: `OrgTasksService.create` sets `unitId` by `defaultUnitId` (the unit
led by the assignee's manager; an unassigned task a lead creates sits on its
own board, one another agent creates on its manager's, anything else on the
company's) unless `unitId` is given (`unitExplicit = 1`); `assign` re-homes
only defaulted tasks; `list({ unitId, rollUp })` is the unit board and the
roll-up. Status lines: `emitTaskStatus` now fires with `channelId: null` and
`unitId` for tasks that did not come from a message and the group chat
posts the one-liner into the unit channel. Goals: `OrgUnitsService.addGoal`
defaults the unit (by owner, else the root) and refuses a `parentGoalId`
outside the unit's ancestry; `goalProgress` / `goalTree` = done ÷ total of
the tasks linked **through the goal's projects** (cancelled ignored),
averaged with the mean of the child goals when both exist, `achieved` pins
100%; `GET …/goals/tree` and `GET …/units/:unitId/goals/tree` (a unit's
tree includes the units below it). Lead tools: a member that leads a
non-root unit gets `org_set_goal` (its unit; parent must be visible),
`org_assign` and `org_create_task`'s `assignee` restricted to itself and its
direct reports (and to tasks on its board or owned inside it),
`org_unit_report`; the chief has the same tools company-wide (`unit`
argument) plus its manager set. Autonomous hires, reorgs and terminations
post one line into the affected unit channels besides `#company`; a unit
that empties closes with a "Unit archived" line before its channel is
archived. API: `GET …/org/units` (tree with members and counts, also in
`GET …/org` as `units`), `PATCH …/org/units/:unitId`,
`GET …/org/units/:unitId/board?rollUp=`, `GET …/org/units/:unitId/goals/tree`,
`?unitId=` on tasks and goals, `unitId`/`parentGoalId` on goal and task
bodies. UI: `WorkspaceRail` shows Company (`#company`, Board, Goals) and a
collapsible group per unit (lead avatar, `#<slug>`, Board, Goals) that open
the panes scoped by `store.orgUnitId`; the Board pane has unit chips and a
"roll up" toggle (on by default for the company, off for a unit); the Goals
pane is the tracker (tree, progress bars, owner, unit, linked tasks and
messages, inline status, "Add goal" with parent/unit/owner, "+ child goal");
the org chart boxes every unit with its name, channel and counts; a unit
channel's header says "Unit channel · <unit>" (`ChannelDetail.unit`).
Departures from the text above: linked tasks are the goal's projects' tasks
(there is no `org_tasks.goalId`); `org_set_goal`'s parent is optional for
leads too; the root unit keeps the organization's name rather than tracking
later workspace renames.

## 8. Meetings: rituals that end in minutes

**Status: shipped (1 November 2026, execution-plan item 19)** — the design
is `docs/company-vision.md` §3 (and §1b for the tunables). A **meeting** is a
thread in a unit channel: the facilitator posts the agenda as the thread
root, then every agent attendee gets exactly one turn per round (at most
three rounds; a standup has one) in its ordinary `#<slug> · <agent>` session
with the meeting tools `meeting_speak`, `meeting_propose_action`,
`meeting_propose_decision`, `meeting_raise_risk`, `meeting_ask_ceo`; the
facilitator closes with `meeting_close`. People reply in the thread between
rounds and are heard in the next one; "stop" / "end meeting" ends it. The
**minutes** are a structured system message in the thread (attachment kind
`minutes`), one line in the channel, and are executed without a model:
actions → briefed tasks on the unit board (assigned when the facilitator may
assign the owner under §7's rules, else the backlog), decisions → the
decision log (`#decision:<id>` chips resolve like `#goal:`), risks → audit,
questions → the brief's "Questions from meetings". Meeting posts never
compute a wake set; `/meeting <kind> [#unit] [agenda…]` by a person starts
one in that channel (or the named unit's) and wakes nobody else. Standup
agendas are composed from the board (done / in progress / blocked per member;
blocked without an owner → the lead) with no model call. Cadences per unit
(standup weekdays 09:30, weekly review Fridays 16:00, retro every second
Friday 16:30, the board meeting Mondays 09:00 for the root) fire from the
minute tick by cron; the chief (any unit) and a lead (its own) reshape them
with `org_set_cadence` within the bounds (never more fires a day than the
daily cap, never inside quiet hours) — applied in autonomous mode, an
approval card in supervised mode, a decision-log entry either way.

*Shipped as:* migration `0032-org-meetings` (`org_meetings`, `org_decisions`,
`org_cadences`); `server/src/org/org-meetings.service.ts` (rows, attendees,
`standupAgenda`, `materialise`, `renderMinutes`, the decision log, cadence
defaults / bounds / `setCadence`, `limitsFor` over the `meeting.*` tunables in
`meeting-tunables.ts`); `server/src/org/org-meeting-runtime.service.ts` (the
rounds, the tools, the tick, `/meeting`, `org_set_cadence`, the operating
profile in every prompt) over the `MeetingChannels` half of the Announcer
seam that `GroupChatService` binds (`postAs` with `wake: false`, `thread`,
`channelInfo`); `channelSessionName` in `mentions.ts` shared with the channel
runtime; the `cadence` approval kind with `OrgApprovalsService.onApply`;
`GET|POST …/org/meetings`, `GET …/org/meetings/:id`, `POST …/cancel`,
`GET …/org/decisions`, `GET|PATCH …/org/cadences`, `GET …/chat/decisions/:id`.
The round cap, USD cap, daily cap and the leads-only attendee rule are
`meeting.*` tunables on the shared `org-tunables.ts` registry (so `org_tune`
and `PUT …/org/tunables` reach them; `meeting.kinds` is a list in the same
JSON); prompts carry the operating profile (vision from item 18, values,
culture); a facilitator's heartbeat (item 21) opens for "a ritual you
facilitate fires today". Departures: crons are server-local like loops;
"every 2nd Friday" is the Friday cron plus a 13-day minimum gap; the kill
switch and the API cancel take effect at the next turn boundary (a turn is
bounded anyway); a standup has no closing turn (its summary is composed); in
supervised mode a board meeting fires only when an `org_humans` CEO or board
row exists.

Lessons in retros (item 22, `docs/company-vision.md` §6): a retro — scheduled
by its cadence, by `/meeting retro`, or as a postmortem the memory module
opens from the record — offers one more tool, `meeting_propose_lesson {text,
audience: member | unit | company, proposedCharterChange?: {agent, text,
mode?}, proposedPlaybookChange?: {playbookId, note}}`. Lessons sit in the
minutes under "Lessons" and are executed with the rest of the minutes: each
is recorded in the lessons store of the agents its audience names (the
proposer; the unit's lead and reports; every active member) as a trusted
`loop`-surface lesson, a charter change becomes a `charter_change` approval
card showing the before/after diff that only the CEO approves (the charter
then changes and its hash is re-accepted), a playbook change becomes a
revise task for the playbook's owner. A postmortem's agenda is composed
without a model — timeline, cost, signals, decisions, playbook outcomes —
and every retro's agenda ends with the playbooks and how they fared.
