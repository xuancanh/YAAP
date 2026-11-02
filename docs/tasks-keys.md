# Task keys

Tasks have Jira-style keys: `ENG-12`, `SALES-3`, `EVL-7`. A key is the
board's prefix and the task's number on it. People and agents name tasks by
key everywhere; the 8-character id prefixes (`b4b81f6f`) are gone from
output, though tools still accept them.

Code: `server/src/common/task-keys.ts` (derivation, the resolver, the
counters, the backfill), `src/lib/task-keys.ts` and `src/lib/useTaskRefs.ts`
(the SPA). Migration `0052-task-keys`.

## Prefixes

Every board owns one prefix: 2–6 uppercase letters or digits, starting
with a letter.

| Board | Prefix from | Examples |
|---|---|---|
| The root unit (the company board) | The company name: a word of four letters or fewer whole, else its first three; two words, two letters and one; three or more, the initials. Filler words (Inc, Corp, the, of) drop out. `CO` when nothing is left. | Jong → `JONG`, Acme Corp → `ACME`, Acme Widget Works → `AWW` |
| A function unit | The lead's job function (its catalog role id or a function word in its title) → a fixed code. | `ENG`, `SALES`, `MKT`, `CS`, `PROD`, `DSN`, `DATA`, `FIN`, `PPL`, `LEGAL`, `OPS`, `IT`, `REV` |
| Any other unit | The lead's title without role words (head, lead, manager…), then the lead's name. | Head of Research → `RES`, Ava → `AVA` |
| An agent's own kanban | The agent's handle (`agents/<handle>`), by the same word rule. | evidence-lead → `EVL`, atlas → `ATL` |

Prefixes are unique in the workspace (units of the organization and every
agent's board together), so a key names one task there. A derived prefix
that is taken gets a number: `ENG`, then `ENG2`. A board gets its prefix
when it is created (units) or on its first task (agents).

**Renaming.** The owner changes a unit board's prefix from the board header
(`PATCH /api/workspaces/:id/org/units/:unitId { taskKey }`). New tasks take
the new prefix from 1 (or where it left off if the board held it before);
existing tasks keep their keys. A prefix another board holds or ever held
in the workspace is refused, so old keys stay unique.

## Numbers

One row per prefix and workspace in `task_key_counters` (`scopeId` is the
workspace id, `next` the last number given). A new task takes its number
with one `UPDATE … SET next = next + 1 … RETURNING next`, which Postgres
serializes on the row lock, so concurrent creates never share a number and
leave no gap. Numbers are never reused: a deleted task's number stays spent.
Claiming a prefix is an `INSERT … ON CONFLICT DO NOTHING` on the
`(scopeId, prefix)` primary key, so two boards cannot claim the same one.

**A task moved to another unit keeps its key** (Jira does the same on a
move within a project; we keep it across boards too), so links, comments
and minutes that name it stay right. The prefix says where a task was
created, not where it is now.

Unique indexes on `org_tasks ("orgId", "key")` and
`agent_tasks ("agentId", "key")` back the counters.

## Backfill

The migration adds the columns and the table, then gives every task without
a key one, board by board in creation order (`createdAt`, then `id`): a
task on a unit board takes the unit's prefix, one without a unit the root
unit's (or the organization's own, adopted by the root unit later). It is
idempotent — keyed rows are skipped and counters only grow — and
`backfillTaskKeys()` can be run on its own.

## Naming a task

- **Tools** accept a key in any case (`ENG-12`, `eng-12`, `#ENG-12`,
  `[ENG-12]`), a full id, or an id prefix: `org_task_update`,
  `org_task_comment`, `org_assign`, `org_request_review`, `org_review`,
  `org_escalate`, `org_why`, the checks tools, `update_task`, `follow`,
  dependencies (`dependsOn`), forecasts and eval cases. One resolver
  (`resolveTaskRef`): the key wins, then the exact id, then id prefixes; no
  match or several matches is an error naming the candidates' keys.
- **Output** shows `ENG-12 Title`: board reads, wake prompts, the heartbeat,
  tool results, channel system posts ("Task ENG-12 … → done"), minutes and
  open items, follow labels and digests, escalation tasks and cards, home
  and inbox rows. Tool descriptions and the system prompt tell agents to
  refer to tasks by key.
- **Chips.** `ENG-12` in channel and chat text (bare, or `#task:ENG-12`)
  renders as a chip when its prefix is a board of the workspace: an org
  board opens the task drawer, an agent's board its Tasks tab. Unknown
  prefixes (`GPT-4`, `UTF-8`) stay text; code spans and URLs are left alone.
- **Links.** `#/ws/<id>/org/board?task=ENG-12` opens the task (ids still
  work); the board writes the key into the address while the drawer is open.
- **SPA.** Board cards, the drawer header (with a copy-key button), agent
  work rows, kanban cards, inbox and minutes show the key; the board header
  shows the board's prefix.
