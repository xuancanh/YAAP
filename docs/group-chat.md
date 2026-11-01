# Group chat: channels, threads and agents that talk

Status: **shipped, 1 November 2026** — execution-plan item 15 (§1–§4, §6:
channels, wake rules, threads/files/tasks, delivery) and item 16 (§5,
organization mode). Each section ends with a *Shipped as* note naming the
code; `tests/backend-groupchat.test.ts` (13 tests) and
`web-tests/channels.test.ts` cover it.
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
and three agents gets `#general` and can add channels.

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
SSE event. Not done: `#goal:<id>` references and the goal page's linked
messages.

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
