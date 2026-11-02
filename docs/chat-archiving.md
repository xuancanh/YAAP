# Chat archiving and the rail

Agents accumulate chats: one per org task they run (`Org · <org> · <task>`),
chats a turn was promoted from, loop and heartbeat sessions. Two things keep
the Home rail usable: finished-task chats archive themselves, and the rail
loads and shows chats a page at a time, folded per agent.

Requirements: [chat-requirements.md](chat-requirements.md) FR-1.4, FR-1.7–FR-1.9.

## How a chat links to its task

`chat_sessions` carries `taskKind` and `taskId` (migration 0051):

| Kind    | Task table    | Linked when |
|---------|---------------|-------------|
| `org`   | `org_tasks`   | the org runtime creates the per-task session for a run (`OrgRuntimeService`, the `Org · <org> · <task title>` session); a session made before 0051 is linked by the migration (through the `org_runs` that used it, matching the session name) or on its next run |
| `agent` | `agent_tasks` | a turn of the chat is promoted to the agent's kanban board (the chat had no task yet); or the agent links it with `set_chat_auto_archive { taskId }` |

A chat keeps its first link; it is never re-linked by a later promote. Chats
with no task are never auto-archived.

## The setting

`chat_sessions.autoArchiveDays`: `null` follows the workspace, `0` is off,
`n` is days. It is resolved in this order:

1. **Workspace** — the tunable `chat.autoArchiveDays` (default 7, bounds
   0–365; 0 turns it off for chats that follow the workspace). Like every
   tunable it lives on the organization row and is shaped per workspace by
   `org_tune` / `PUT …/org/tunables` (Settings → Tunables, area *Chats*);
   a workspace without an organization reads the default.
2. **Agent** — `agents.chatAutoArchiveDays` (agent Settings → *Auto-archive
   task chats*): `null` = the workspace default. Copied onto a task chat when
   it is created or linked.
3. **Chat** — the chat header's *Auto-archive* menu (Default / Off / 1 / 3 /
   7 / 14 / 30 days after the task is done; shown for task chats), or the
   agent's tool.

### The tool

`set_chat_auto_archive { chatId?, days, taskId? }` — `chatId` defaults to the
current chat; `days` is 1–365, `null` (or 0) for off, `"default"` to follow
the workspace; `taskId` links the chat to one of the agent's kanban tasks or
an org task assigned to it. It refuses any chat that is not the calling
agent's own (another agent's, an agent-less chat, another workspace's).
Classed `read` and in `FREE_INTERNAL_TOOLS` like the agent's other
self-organisation tools: no Ask pause, no trust gate. Mentioned in the
agent's board context and in the built-in `org-member-workflow` skill.

## The sweep

`ChatArchiveService.sweep`, hourly on the loops minute tick (minute 23, per
account). A linked chat is archived when, with `days` its effective setting:

- its task is finished — org: `done` / `cancelled`; kanban: `done` /
  `abandoned` (a task deleted from the board counts as finished) — and was
  last changed at least `days` ago, **and**
- the chat itself has been quiet (`updatedAt`) at least `days`.

It is never archived while:

- it is **pinned**;
- a **turn is running** in it;
- an **approval is pending** — paused live in the turn loop, an
  `action_pending` / `approval_request` inbox event, or a `held` / `staged`
  action in the action log;
- it has an **unread inbox event** newer than `chat.autoArchiveUnreadHours`
  (default 24, 0–720).

The archive write is guarded on the row not having changed since it was read.
Each sweep leaves one inbox event per agent — *"Archived 3 finished-task
chats"*, naming them — marked read, so it shows in the inbox history without a
badge. Archived chats restore from the Archived group as before; a restore
counts as activity, so the chat stays at least another `days`.

## The rail

The Home rail no longer loads every chat. `GET /api/chats/rail?workspaceId=`
returns per agent (`agentId` null = the workspace's agent-less chats):

- `total` — its chats, not counting loop / heartbeat sessions or channels'
  hidden working sessions (`#slug · Agent`, tagged `channel`, kept out
  server-side);
- `items` — the newest 5 (pinned first), or as many as `limits=<agentId>:<n>,…`
  asks for, and `nextCursor`;
- `loops` — its `Loop · …` sessions (count and the newest 20), shown as one
  **Heartbeat runs** row;
- `approvalIds` — its chats with an approval waiting in the inbox;

plus `archivedTotal`. `GET /api/chats/page?workspaceId=&agentId=(id|none)&loops=only|exclude&archived=true&q=&limit=&cursor=`
returns one page (`{ items, nextCursor }`, cursor opaque). `GET /api/chats`
is unchanged for other callers.

The store keeps `sessions` as what is loaded: every group's pages, their loop
rows, and the open chat even when it is on no page (looked up by id, e.g. from
a link or a search hit). *Show more (N)* fetches the next 20 of a group, and a
refresh keeps the count each group has loaded.

In the rail:

- Agent groups are **collapsed by default**, except the group of the open
  chat and groups with unread activity or a chat waiting on an approval. The
  header shows the unread badge, the approval badge and the chat count.
- Opening or closing a group by hand is kept per viewer (`localStorage`
  `yaam-rail-groups`, best effort) and wins over the default; **Collapse all /
  Expand all** sets every group.
- **Search** asks the server (`/api/chats/rail?q=`, name, auto-title and
  tags), so it finds chats in collapsed groups and beyond the loaded pages;
  groups with a hit open while searching.
- The **Archived** group pages the same way (20 at a time).
