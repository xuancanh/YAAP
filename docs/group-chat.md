# Group chat: channels, threads and agents that talk

Status: **design, 1 November 2026** — execution-plan items 15 and 16.
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

## 4. Delivery and presence

Workspace-level SSE (`GET /api/workspaces/:id/events`) carries
`channel_message`, `channel_typing` (agent run started), `channel_stream`
(tokens), `task_update`. Unread counts per channel from `channel_reads`.
Mentions of a human notify through their paired channels (Telegram, email,
push) with the deep link `#/ws/<id>/channel/<slug>/<messageId>`, subject to
quiet hours. Paired members can post into a channel from Telegram with
`#slug text`.

## 5. Organization mode

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
