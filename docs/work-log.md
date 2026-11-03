# The Work log: chat vs an agent's own work

Every agent session used to be "a chat": the owner's conversations, but also
every heartbeat beat (`Loop · heartbeat`), every org task run (`Org · Acme ·
Close the books`), every meeting round and channel wake (`#general · Jong`).
They all sat in the left rail and the agent's Chats tab, and the agent's
thinking and tool calls sat inline in the conversation with its answer.

Now a session is one of two kinds, and each kind has its own surface:

| Kind | What it is | Where you read it |
|---|---|---|
| `chat` | a conversation with people | the rail, the agent's **Chats** tab, chat search, the chat view |
| `work` | the agent's own run | the agent's **Work log** tab |

Requirements: [chat-requirements.md](chat-requirements.md) FR-1.10, FR-3.2,
FR-5.1, FR-8.2. The rail: [chat-archiving.md](chat-archiving.md). The agent
page: [mission-control.md](mission-control.md).

Code:

- `server/src/chats/session-kind.ts` — the kinds, `classifySession`, the
  owner-DM tag
- `server/src/chats/work-log.service.ts`, `work-log.controller.ts` — the
  Work log endpoints
- `server/src/chats/chats.repository.ts` (`railWhere`, `railCounts`,
  `approvalSessions`), `chats.service.ts` (`rail`, `page`, `ownerChatFor`)
- `src/components/WorkLog.tsx` — the tab; `src/components/ChatView.tsx`
  (`WorkedOn`) — the folded steps in a chat
- tests: `tests/backend-work-log.test.ts`, `web-tests/work-log.test.tsx`,
  `web-tests/chat-rail.test.tsx`, `web-tests/chat-rail-store.test.tsx`

## 1. The kind

`chat_sessions.kind` (migration 0080, `'chat'` by default) is set when a
session is created, by the code path that creates it — every `createSession`
call states it, and a test fails if a new one does not:

| Created by | Kind |
|---|---|
| a person: New chat, `POST /api/chats` | chat |
| a fork of any session | chat |
| the owner DM (`ownerChatFor`, below) | chat |
| a member's Telegram or email thread (`Telegram · …`, `Email · …`) | chat |
| scheduled loops and the heartbeat (`Loop · <name>`) | work |
| org task runs, planning, chief review, plans, ask-the-company, audits (`Org · …`) | work |
| channel wakes and meeting rounds — the hidden `#slug · Agent` session | work |
| red-team and eval runs (`Red team · …`, `Eval · …`) | work |
| mini-app asks (`App · <agent>`) | work |

`classifySession` is the fallback for a caller that does not say, and the
rule existing rows were backfilled with: a work name prefix (`Loop · `,
`Org · `, `Red team · `, `Eval · `, `App · `), a channel working session
(`#… · …` or tagged `channel`), an org task link (`taskKind = 'org'`), or —
in the migration only — a session an `org_runs` row used. Everything else
is a chat, including a chat a turn was promoted to the kanban from. The
migration touches only rows still at the default, so a re-run never undoes
a later decision.

Delegated work (`delegate_task`) and `code_agent` runs are not sessions of
their own: the delegate runs the task from its heartbeat or its org task
run (work); a coding-agent call is a tool call inside whichever session made
it.

**The kind is presentation, not behaviour.** The turn loop, the turn context,
memory, distillation and compaction read the same sessions the same way; no
model input depends on the kind, and the turn context never keys on session
names. A work session's turns still run with the session's own permission
mode, model and token ceiling.

### The owner DM

`ChatsService.ownerChatFor(agentId)` is the conversation an agent's messages
to its owner land in (`message_owner`): the agent's newest live chat tagged
`owner-dm`, the owner's own (`initiatedBy ''`, not shared), created on first
use and replaced if archived. Always `chat`, so what an agent says to its
owner is in the rail, never the Work log.

## 2. Chat surfaces show chats

- **The rail** (`GET /api/chats/rail`, `/api/chats/page`) lists `chat`
  sessions only. The old *Heartbeat runs* row is one **Work log** row per
  agent (opens the agent's Work log). The archive counts chats only.
- **Approvals.** A run waiting on an approval (an `action_pending` /
  `approval_request` inbox event on a work session) is an Inbox item as
  before and a red badge on the agent's rail group (it opens the group), a
  dot on its Work log row, and a count on the Work log tab — never a chat
  row. The rail group carries `work: { total, approvalIds }`.
- **The agent's Chats tab** lists and counts its chats.
- **Chat search** (`/api/search`, the rail search) covers chat sessions; the
  Work log has its own search.
- **Links.** `openSession(id)` routes by kind: a chat opens the chat view, a
  work session opens the agent's Work log on that session with its newest run
  expanded. That covers the Inbox, mission control and the agent dashboard
  (*See the run*, the error's *run*), Settings › Usage, the org run list and
  `#/chat/<id>` deep links from notifications.

### Thinking in a chat

In a conversation each turn's thinking and tool calls fold behind one line,
**worked on it · N steps**, placed where the first of them was; the answer
stays in view. The owner can expand it. While a turn runs the line reads
**working · N steps…**, and a tool call waiting on the owner's approval stays
in view outside the fold. A work session opened in the chat view (it can be,
by id) shows everything unfolded.

Thinking is now kept: each round's thinking is a `thinking` transcript row
(bounded at 50k characters). Provider history never carries it
(`providerHistory` reads user and assistant rows), export skips it, and chat
search ignores it.

## 3. The Work log

The agent page's **Work log** tab (`?tab=Work log`, also *worklog*, *runs*,
*Heartbeat runs*; linked from the Overview's Activity, the mission-control
side panel and the rail). One run is one turn of a work session.

**The timeline.** Runs newest first, by day. A row: the outcome dot, the time,
the trigger label, the answer's first line (or the error), steps, tokens and
cost, the outcome.

**Grouped by trigger.** Chips across the top, one per trigger group with its
count, newest group first — *Heartbeat*, *Loop · digest*, *ENG-12 Close the
books*, *Meeting · #eng*, *#general*, the org sessions (*Acme · Planning ·
Eng*), *Mini app · Jong*. A chip filters to that group; *All* clears it.

| Trigger | Run of | Key |
|---|---|---|
| `heartbeat` | `Loop · heartbeat` | — |
| `loop` | `Loop · <name>` | the loop name |
| `task` | a session linked to a task (org run or kanban) | the task key (else id) |
| `meeting` | the channel session, a turn opened by a meeting round prompt | `#slug` |
| `channel` | the channel session, any other turn (a wake) | `#slug` |
| `org` | other `Org · …`, red-team and eval sessions | the session name |
| `app` | `App · …` | the session name |

**Outcome.** `running`; `error` (the turn errored, or its org run failed,
looped or was killed); `blocked` (its org run ended blocked, a budget stop,
or was refused); `stopped`; else `done`. A task run's outcome and cost come
from the `org_runs` row that ran it (the latest started before the turn).

**Cost.** The org run's settled USD when there is one, else the model's list
price for the turn's tokens (Settings › Usage overrides apply); blank for a
model the table does not know.

**A run, expanded:** the prompt (folded), each thinking block, each tool call
with its input and its output (and *ERROR* / a non-default approval), the
answers, the files it wrote (`fs_write`, `fs_edit`, `fs_append`,
`fs_delete`, `fs_restore` — each opens in Artifacts), tokens in and out, the
model, cost, and a link to its task (an org task's drawer, or the agent's
board).

**Filters:** trigger (and key), outcome, task (key or id, any case), from /
to (whole days), and search — the prompt, the session name, the task key
and title, and every message of the run, thinking included (`LIKE`
wildcards are literal). **Paging:** 30 runs a page, *Load more runs*
(opaque cursor on `createdAt, id`).

**Archived sessions.** Auto-archive sweeps finished task sessions — mostly
work sessions ([chat-archiving.md](chat-archiving.md)). Their runs stay in
the Work log, marked *archived session*: the log is history.

### Endpoints

```
GET /api/agents/:agentId/work-log?trigger=&key=&outcome=&task=&session=&from=&to=&q=&limit=&cursor=
  → { runs: WorkRun[], nextCursor, groups: [{ trigger, key, label, count, lastAt }] }
GET /api/agents/:agentId/work-log/runs/:turnId
  → WorkRun + { messages (in order, thinking included), toolCalls (input, result, approved, isError) }
GET /api/agents/:agentId/work-log/sessions/:sessionId/latest
  → { turnId }
```

The list reads work sessions only; a run by id opens for any session of the
agent, so a link never breaks on the kind. A member of a shared workspace
sees the runs of shared sessions and their own, as with chats. The groups
are counted under every filter but the trigger, so the chips stay put while
filtering.
