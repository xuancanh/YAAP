# Follows: threads and tasks that reach you when they change

Agents and people **follow** what they take part in, so a change reaches
them without polling: a channel thread, an org task, an agent kanban task.
An agent learns of it in its heartbeat; a person in their inbox. Following
is automatic for whoever started, commented on, owns, is assigned, reviews
or was mentioned in the target, and manual for anything else.

An agent follows exactly as it does everywhere else: its follows are its
own, whichever surface (private chat, channel wake, org run, heartbeat) it
acted from, and they live in its one workspace.

## 1. Data

`follows` (migration 0048): `workspaceId`, `followerKind` (`agent` |
`user`), `followerId`, `targetKind` (`thread` | `org_task` | `agent_task`),
`targetId` (a thread is its root message id), `reason` (`started` |
`commented` | `owner` | `assignee` | `reviewer` | `mentioned` | `manual`),
`createdAt`, `mutedAt`, `lastSeenAt`. Unique on (`followerKind`,
`followerId`, `targetKind`, `targetId`).

Each row also carries the follower's compact "new since you last looked":
`unseenCount`, `lastActivity` (one line), `lastActorName`,
`lastActivityAt`, `attentionAt` / `attention` (the change needs this
follower), `wokeAt` (the last follow wake it caused) and `closedAt` (the
target is done, cancelled or abandoned). `title` and `link` name the target
in prompts and notifications.

**Unfollow is a mute.** `mutedAt` is set and the row stays, so auto-follow
never resubscribes someone who left; a later manual follow lifts it. A muted
row counts nothing, notifies nobody and wakes nobody.

## 2. Auto-follow

Idempotent (an existing row, muted or not, is left as it is):

| Target | Who follows | Where |
|---|---|---|
| Channel thread | the root's author (`started`) once the thread has a reply or a mention; every replier (`commented`); agents mentioned in it (`mentioned`) | `GroupChatService.post` |
| Org task | the creator (`started`: `agent:<id>`, or the user for `user`); the assignee at create, assign, re-assign and owner change (`assignee`, people too); the reviewer at create and on `request_review` (`reviewer`, people too); every commenter (`commented`) | `OrgTasksService` |
| Kanban task | the owning agent (`owner`); its creator (`started`: the person who added it, or the delegating agent) | `AgentsService.addTask` |

System actors (checks, cadences, the runtime) follow nothing.

## 3. Activity and who hears it

`FollowsService.recordActivity` runs on: a thread reply; a task comment; a
status change (any, including done, cancelled, abandoned, reopened);
assignment; a review request; a review verdict; an escalation. For each
live follower **other than the actor**, it bumps `unseenCount` and records
the line and who made it. The actor's own activity marks the target seen
for the actor instead — an agent never notifies itself.

**Attention** (`attentionAt`) is set when the change needs the follower:
blocked, review requested, reopened (for every follower), or a comment
naming the follower with `@Name` (for that follower). It is *not* set for an
agent an existing mechanism already wakes for the same change: an agent
mentioned in a thread (the channel runtime wakes it now), the owner of a
task that gets a comment, the new assignee, the reviewer asked (the org
runtime wakes them). Nobody is woken twice.

**People** get one addressed inbox event (`kind: 'follow'`, agent id
`follow:<workspaceId>`, payload `{ link, targetKind, targetId }`) per
target: the first update after they last looked. Later updates only count
until they open the thread or the task (the SPA marks it seen) or act on it
themselves. Quiet hours apply as for every event; a person already notified
by a mention gets no follow event for the same message.

## 4. The heartbeat

Two additions to the gated heartbeat (docs/triggers.md "Heartbeat",
docs/company-vision.md §13), both model-free:

- **A reason.** `FollowsService.wakeReasons`: followed targets with an
  attention the agent has not been woken for yet, as
  `Following task [abcd1234] "Title": blocked: waits on legal (Writer)`.
  Debounced per agent: no second follow wake within
  `follow.wakeDebounceMinutes` of the last; the rows named are stamped
  `wokeAt` so one change wakes once. Ordinary replies and comments never
  open the gate. A follow-triggered beat is an ordinary heartbeat run, so
  the daily run cap, loop budgets, quiet hours, the spend stop and paused
  members all apply; it never wakes anyone in a channel.
- **A section.** When a beat runs for any reason, its prompt carries
  "Following — new since your last beat": one line per followed target
  with unseen activity (`thread "#general: …": 3 new replies, last from
  Ada — replied: …`), most recent first, at most `follow.contextItems`.
  Once the run went through, those rows are marked seen.

**Closed targets fade.** A follow on a task done, cancelled or abandoned
longer than `follow.closedWindowHours` stops appearing in the reason and
the section; the row is kept (and reopening the task brings it back).

## 5. Tunables

Registered on the org tunables registry (`follow-tunables.ts`, area
`heartbeat`), so `org_tune` and `PUT …/org/tunables` reach them and the
chief shapes them to the operating profile — a fast, chatty culture wakes
sooner, a deep-work one batches. Workspaces without an organization use the
defaults.

| Key | Default | Bound | What |
|---|---|---|---|
| `follow.wakeDebounceMinutes` | 30 | 0–1440 | minutes between two follow wakes of one agent (0: every beat that finds one) |
| `follow.closedWindowHours` | 24 | 0–720 | hours a closed task keeps reporting |
| `follow.contextItems` | 8 | 1–20 | lines in the heartbeat's "Following" section |

## 6. Tools

Offered to every durable agent (`follows.tools.ts`, a `ToolProviderHook`):

- `follow { kind: 'thread' | 'task', id }` — a thread by any of its message
  ids (full, or a unique prefix of ≥ 4 characters as `channel_read` shows
  it); a task by an org task or kanban task id or prefix (the board's short
  id). A private channel's thread resolves only for its members.
- `unfollow { kind, id }` — mute; it sticks.
- `list_follows` — what it follows, why, and what is new on each.

They change only the agent's own follow rows: classed `read` in
`actions/action-classes.ts` and read-only for the turn loop, so they run
without approval in every mode. Ids resolve inside the session's workspace
only. The org-member workflow skill, the agent's system prompt and the
heartbeat's "Following" header mention them.

## 7. HTTP and the SPA

`/api/workspaces/:id/follows` — `GET ?targetKind=&targetId=` (followers and
whether I follow), `GET mine`, `POST` (follow), `POST unfollow`,
`POST seen`. The follower is always the caller; viewers read only.

The channel thread panel and the org task drawer show a **Follow /
Following** toggle with the followers' avatars (`FollowToggle.tsx`);
opening one marks it seen. The agent kanban card has no detail view and
shows none.
