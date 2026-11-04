# The workspace filesystem

One tree per workspace, laid out like a Linux box. Agents live in their own
home folders; shared folders ("artifacts") hold the work people and agents
build together. Replaces the old split between `workspaces/<id>/…` (workspace
files) and `agents/<id>/…` (agent file brains) as two unrelated roots.

## Layout

Physical storage: every object of a workspace lives under `workspaces/<wsId>/`
in the bucket (one prefix = one tree, so quota/search/delete stay one prefix
operation). The paths below are relative to that root and are what users and
agents see, written with a leading `/`.

One predictable tree. `server/src/files/layout.ts` is the single place that
knows it: every server writer (the chief's seeded ledger, the record
mirrors, meeting minutes, the generated indexes, function folders) builds
its path there, and a test checks every `/org/…` path a pack playbook or a
built-in skill names against its patterns (`classifyOrgPath`), so code and
skills cannot drift apart.

```
/                              the workspace
├── org/                       the company's shared folder
│   ├── README.md              the index: what lives where, functions, units      (generated)
│   ├── operating-system.md    the chief's operating system: profile, parameters,
│   │                          decision rights, why the root rituals look as they do
│   ├── calendar.md            every ritual: unit, when (in words), purpose, owner,
│   │                          output, last held, empty cycles                    (generated)
│   ├── decisions.md           the decision log (one decider each)
│   ├── scorecard.md, issues.md, risks.md, handoffs.md, values.md     the ledger
│   ├── goals/                 README.md (vision, objectives) and
│   │                          <id8>-<slug>.md per objective: key results, check-ins (generated)
│   ├── rituals/<unit>.md      a unit's rituals, attendees, recent minutes         (generated)
│   ├── meetings/<unit>/<yyyy>/<yyyy-mm-dd>-<kind>.md          minutes (docs/meetings.md)
│   │                     …/<yyyy-mm-dd>-<kind>-agenda.md       the agenda and pre-reads
│   ├── reports/<yyyy>-W<ww>.md            the weekly review pack (ISO week)
│   │          <yyyy-mm>-<topic>.md        monthly reviews (staffing, learning)
│   │          <yyyy-mm-dd>-board-update.md board / investor update drafts
│   ├── briefs/<yyyy-mm-dd>.md the CEO's daily brief
│   ├── planning/<yyyy>-Q<n>.md            the quarter's planning pack
│   ├── proposals/<yyyy-mm-dd>-<slug>.md   proposals for the CEO
│   ├── archive/<yyyy>/…       closed issues, resolved risks, old decisions
│   ├── playbooks/ experiments/ evals/ outcomes.md metrics.md   record mirrors (below)
│   └── <function>/            one per job function (below): README.md, cadence.md,
│                              kpis.md, team.md, okrs/<yyyy>-Q<n>.md,
│                              reports/<yyyy>-W<ww>.md, audits/<yyyy-mm>.md,
│                              processes/, and the function's own subfolders
├── channels/<slug>/           a channel's shared folder
│   ├── meetings/<yyyy-mm-dd>-<title>.md   minutes of `/meeting`s in a non-unit channel
│   └── sub/<sub-slug>/        a discussion or meeting sub-channel's folder (docs/group-chat.md §9)
├── agents/<handle>/           an agent's home — its default working folder
│   ├── LESSONS.md, JOURNAL.md file brain (agent memory)
│   ├── knowledge/             durable reference notes
│   ├── apps/<appId>/          mini-app state and data
│   ├── work/                  drafts not yet ready to share
│   └── .checkpoints/          read-only rollback history
├── uploads/                   files users attach from the composer
├── library/                   the packs' knowledge bases, read-only (docs/knowledge-base.md):
│                              <pack>/…, _shared/<topic>/…, README.md          (generated)
├── archive/org-<slug>-<day>/  a deleted company's /org/, when its delete kept the files (docs/owners-seat.md)
└── <anything else>/           user- or agent-made shared folders
```

**Function folders.** One folder per job function, named by the
function's id — the ids the market groups business packs by and each pack
names in its frontmatter (`server/src/market/segments.ts`): `sales`,
`marketing`, `customer`, `product`, `engineering`, `design`, `data`,
`finance`, `people`, `legal`, `operations`, `it-security`, `revops`
(`leadership` — the chief and the auditor — works in `/org/` itself). A
catalog role's id prefix is its function, with one documented map where
the two differ (`ROLE_PREFIX_FUNCTION`): `cs-*` roles (role:cs-manager,
pack-biz-cs-*) work in `/org/customer/`, `ops-*` roles in
`/org/operations/`. Tests keep the folder list equal to the market's and
each business pack's frontmatter function equal to its role's folder. The
fixed part is `README.md`, `cadence.md`, `kpis.md`, `team.md`,
`okrs/<yyyy>-Q<n>.md`, `reports/<yyyy>-W<ww>.md` (the weekly report to the
chief), `audits/<yyyy-mm>.md` and `processes/`; anything else is the
function's own subfolder.

**Decisions** stay one file, `/org/decisions.md`: the log is a table agents
append to, and the system's own decision rows (approvals, meetings,
tunables, experiments) are `org_decisions`, which the file links by id.

### Generated indexes

`OrgLayoutService` (`server/src/org/org-layout.service.ts`) writes these
through `WorkspaceFs` with the `system` author, only when their text
changed:

| File | From | Refreshed when |
|------|------|----------------|
| `/org/README.md` | the layout, the functions with members (with their heads and units), the units | a member, unit or the organization changes; at boot |
| `/org/calendar.md` | the cadences in words (`server/src/org/cadence-words.ts`, the wording of the SPA's `cadenceText`, in server time), the units' leads, the held meetings (last held; empty cycles = held meetings in a row with no decision and no action) | a cadence changes, a meeting ends or is cancelled, the org chart changes |
| `/org/rituals/<unit>.md` | one unit's cadences, its lead and direct reports, its last five minutes | as the calendar |
| `/org/goals/README.md`, `/org/goals/<id8>-<slug>.md` | the vision, objectives, key results (start, current, target, progress, confidence, at risk, source) and their last check-ins | a goal is created or updated, a check-in, a key result's source is bound |
| `/org/<function>/README.md` | the folder's fixed layout and its head | written once when the function's first member joins (onboarding or a hire), never over a file; the function owns it |

The refresh listens to the org audit log (`OrgAuditService.onAppend`: every
cadence, goal, check-in, unit, member and meeting change writes a row),
debounced per organization; onboarding refreshes right after it seeds the
ledger (the calendar is no longer seeded). `README.md` and `calendar.md` end
with a Notes marker: whatever follows it is kept when the file is
regenerated (the chief's planning timeline, an absence, a retirement
outcome); a calendar from before the layout keeps its old text under the
Notes. The others are fully generated and say so. A renamed objective's old
file is deleted (kept as a revision).

### Moving files into the layout

A boot job (`OrgLayoutService.bootAll`), per organization of every account,
moves files written under earlier conventions (`legacyTarget` in
`layout.ts`, pure):

| Was | Is |
|-----|----|
| `/org/meetings/<yyyy>/<day>-<unit>-<kind>[-sfx].md` | `/org/meetings/<unit>/<yyyy>/<day>-<kind>[-sfx].md` (the unit is the longest known unit slug the name starts with, else the part before a meeting kind, else `unsorted`) |
| `/org/meetings/<day>-leadership.md` (the chief's agenda) | `/org/meetings/<root unit>/<yyyy>/<day>-board-agenda.md` |
| `/org/reviews/<day>.md` | `/org/reports/<yyyy>-W<ww>.md` |
| `/org/board/<day>-<x>.md` | `/org/reports/<day>-board-<x>.md` |
| `/org/staffing/<yyyy-mm>.md`, `/org/learning/<yyyy-mm>.md` | `/org/reports/<yyyy-mm>-staffing.md`, `…-learning.md` |

Each file moves with `WorkspaceFs.move`, so its version, creator and
revisions follow (the move itself is attributed to `system`). Nothing is
left behind and nothing is overwritten: a target that exists gets `-2`,
`-3`… before the extension. The links the server stored are rewritten:
`org_meetings.minutesPath` and the minutes' attachments on channel
messages. Paths written as text in task comments, messages or other files
are not rewritten (the index names where things live now). Files outside
these patterns — a loose note at the top of `/org/` — stay where they are;
the chief's `org-files-hygiene` pass files them. The job is idempotent (a
moved path never maps again), logs its counts, never throws, then
regenerates every index.

### Homes and Artifacts

- **Home.** `agents.homeDir` stores the agent's home as a workspace-relative
  path, `agents/<handle>`. `<handle>` is the agent's name slugified
  (`[a-z0-9-]`, ≤ 40 chars), made unique within the workspace with `-2`, `-3`…
  It is fixed at creation and kept on rename (like `emailSlug`), so paths
  others wrote down stay valid. Moving an agent to another workspace moves
  its home.
- **Artifacts** = every folder outside `agents/`. In the UI, the
  *Artifacts* view shows the whole tree, grouped as **Shared** (the
  top-level shared folders) and **Agents** (each agent's home, with its
  avatar). An agent's own *Artifacts* tab shows its home. *Artifacts* is a
  main menu item (desktop and phone); `/org/` leads the Shared group, with
  `/org/README.md` pinned above it, and `/org/`'s children are listed in the
  layout's order (README, operating-system, calendar, goals, meetings,
  rituals, reports, briefs, planning, the ledger, the function folders, the
  mirrors, the archive; anything else after — `ORG_ORDER` in
  `src/lib/artifacts.ts`, kept equal to the server's by a test).

## Mirrored company records

In organization mode the company's durable records stay in their tables —
the agents keep their tools (`org_write_playbook`, experiments, evals,
sensing, value accounting) — and are mirrored as small, readable markdown
under `/org/`, so people read them in Artifacts instead of in dedicated
panes (the Ask, Playbooks, Metrics, Experiments, Outcomes and Evals panes
were removed from the SPA on 2 November 2026). `OrgMirrorService`
(`server/src/org/org-mirror.service.ts`) writes them with the `system`
author, only when the text changed:

| File | Written when | Holds |
|------|--------------|-------|
| `/org/playbooks/<name>.md` | a playbook is written or revised, its review closes, it is activated or retired, its outcome counters refresh | status, version, roles, the SKILL.md body, why, uses and rating |
| `/org/experiments/<id8>-<slug>.md` | an experiment is proposed, governed, started, extended, decided or abandoned; a forecast on it is recorded or resolved (reconciliation) | status and window, hypothesis, the change, the metric and expected effect, baseline, result, the predictions with their scores |
| `/org/evals/<role>.md` | an eval run starts or ends (including rollout gates) | the role's golden-set size by source, the latest runs: candidate, pass rate vs baseline, verdict, who asked (`rollout gate (…)`) |
| `/org/outcomes.md` | value accounting records new value events, or the CEO prices a key result | per active objective: value realised this month, spend, ROI, each key result's value / target and 7-day movement |
| `/org/metrics.md` | a metric sample lands (poll, webhook, attestation) | every metric source's kind, status, latest value and last fetch, and its last five readings — never config or secrets |

The files say they are mirrors: edits are overwritten by the next change to
the record. A link to a playbook, an experiment or a metric source in the
SPA opens its file. At boot a one-off backfill mirrors existing rows for
every account — idempotent (unchanged files are skipped), logged, never
throws.

## Meeting minutes

Every meeting ends with a minutes document (`docs/meetings.md`), written
through `WorkspaceFs` (the path from `orgPath.minutes` / `channelPath.minutes`
in `layout.ts`) by `OrgMeetingMinutesService`
(`server/src/org/meeting-minutes.service.ts`) with the facilitator agent as
author (`system` when there is none):

| File | Written when | Holds |
|------|--------------|-------|
| `/org/meetings/<unit-slug>/<yyyy>/<yyyy-mm-dd>-<kind>.md` | a unit's meeting (a ritual from its cadence, `/meeting <kind>` in a unit channel, Start meeting) ends | when, the unit, facilitator, attendees, agenda, summary, discussion, decisions (who decided, `#decision:` id), action items (owner, done-when, the board task), open questions and risks, lessons, the next meeting |
| `/<channel folder>/meetings/<yyyy-mm-dd>-<title-slug>.md` | a `/meeting` in a channel that is not a unit channel ends (the folder is `channels/<slug>` unless the channel has another) | the same |

A meeting runs in a sub-channel of the channel it was called in
(docs/group-chat.md §9), but its minutes file stays where it always was:
the unit's `/org/meetings/…` path, or the *parent* channel's
`meetings/` folder — never the sub-channel's `sub/<slug>/` folder, which
holds only what people and agents put there during the meeting. A
sub-channel's folder is `channelPath.sub(<parent folder>, <slug>)` in
`layout.ts`; its agents see it as `shared/` in their channel session.

Dates are server-local, like the cadences. A second meeting at the same path
the same day gets `-HHMM` (then `-<id8>`) appended; the first is never
overwritten. Unlike the mirrors these are ordinary files: people and agents
may annotate them, and revisions keep every version. The meeting row keeps
the path (`org_meetings.minutesPath`), so lists never parse files.

## Paths an agent uses

Agent file tools resolve paths like a shell whose cwd is the agent's home:

| Written as      | Resolves to                                   |
|-----------------|-----------------------------------------------|
| `notes.md`      | `/agents/<handle>/notes.md` (relative = home)  |
| `~/notes.md`    | `/agents/<handle>/notes.md`                    |
| `/org/sales/plan.md` | `/org/sales/plan.md` (absolute = workspace root) |
| `shared/x.md`   | `/<workspaceFolder>/x.md` — kept for back-compat when the agent has an assigned folder |

A chat with no agent works at `/`, as direct chats did before.

`fs_list` without a prefix lists the home; `fs_list` with `/` lists the top
level (folders collapsed to one line each). Results are always printed as
absolute paths so agents can pass them to each other.

## Permissions

Plain and predictable, checked in one place (`WorkspaceFs.assertCanWrite`):

| Path                         | the owning agent | other agents | users |
|------------------------------|------------------|--------------|-------|
| `/agents/<own>/…`            | read/write       | read         | read/write |
| `/agents/<own>/.checkpoints/`| read             | read         | read  |
| `/agents/<other>/…`          | —                | read         | read/write |
| `/library/…` (knowledge base) | read            | read         | read       |
| everything else (artifacts)  | read/write       | read/write   | read/write |

So: an agent's home is its own; collaboration happens in shared folders.

**This table is the gate for file writes.** `fs_write`, `fs_edit`,
`fs_append`, `fs_delete`, `fs_restore` and `slides_create` run freely for
every agent and chat — no approval pause in Ask mode, no hold in a loop,
heartbeat, channel or org run, no trust-ledger ask, no action reviewer
(`docs/permissions.md` §8): what the table allows is reversible (revisions,
below) and attributed (author, the action log). What it refuses — another
agent's home, any `.checkpoints/`, `.revisions/` — comes back to the agent as
a tool error. Two exceptions: a turn driven by a mini app's `agent.ask`
gates them like any mutation, and an incident freeze of `internal_write`
holds them.

## Collaboration

Several agents (and people) editing the same artifact must not silently
clobber each other.

- **File metadata** (table `workspace_files`, migration 0047):
  `workspaceId, path, version (int), size, contentType, updatedByKind
  ('user'|'agent'|'system'), updatedById, updatedByName, updatedAt,
  createdByKind, createdById, createdAt`. Unique on `(workspaceId, path)`.
  Objects written outside `WorkspaceFs` still list (from storage); they just
  have no author yet.
- **Revisions** (table `workspace_file_revisions`): every overwrite through
  `WorkspaceFs` first keeps the previous body at
  `workspaces/<ws>/.revisions/<sha1(path)>/<version>`, with author and time.
  The last 20 revisions per file are kept. Users can view and restore one.
- **Deletes are reversible.** `delete` keeps the deleted body as a revision
  (with the history before it) and removes only the live object and its
  metadata row; it returns the kept version. `restore` brings the file back
  as a new version, and a new write at a deleted path continues the
  numbering after the kept history instead of overwriting it. Agents undo
  with `fs_restore { path, version? }` (default: the newest kept revision);
  `fs_delete` says which revision it kept. (Moving another file onto a
  deleted path drops that deleted file's history.)
- **Optimistic concurrency.** `fs_read` reports the version
  (`[version 4 · last edited by Ada, 2m ago]` header line). `fs_write` and
  `fs_edit` accept `expectedVersion`; on mismatch they fail with the current
  version and author, so the agent re-reads and merges instead of
  overwriting. The SPA editor sends it too and shows a conflict banner.
- **`fs_edit`** — replace an exact `old` string with `new` (must occur once),
  the collaborative way to change part of a shared file.
- **`fs_append`** — append to a file (logs, meeting notes, shared lists)
  without needing a version.
- **Activity.** Each write emits a workspace event `file.changed { path,
  version, by }` on the existing workspace event stream, so open viewers
  refresh live and show "Ada just edited this".

## Migration of agent homes

A boot-time, idempotent data move (not SQL): for each agent with a
workspace, copy `agents/<agentId>/…` to `workspaces/<ws>/agents/<handle>/…`,
set `homeDir`, then delete the old prefix. Marked done per agent by
`homeDir` starting with `agents/` *and* not equal to `agents/<agentId>`
(old default). Existing workspace-root files stay where they are — they are
already shared artifacts.

## API

Workspace routes (paths are workspace-relative, no leading slash needed):

- `GET  /api/workspaces/:id/files` → `FileEntry[]` with
  `{ path, size, lastModified, version?, updatedBy?: { kind, id, name } , owner?: { agentId } }`
- `GET  /api/workspaces/:id/preview?path=` → `FilePreview` plus `version`, `updatedBy`
- `POST /api/workspaces/:id/files` `{ path, contentBase64, contentType?, expectedVersion? }` → 409 on version conflict
- `GET  /api/workspaces/:id/file/revisions?path=` → `{ version, size, updatedBy, updatedAt }[]`
- `GET  /api/workspaces/:id/file/revision?path=&version=` → `FilePreview`
- `POST /api/workspaces/:id/file/restore` `{ path, version }`
- `POST /api/workspaces/:id/file/move` `{ from, to }`
- `DELETE /api/workspaces/:id/file?path=`

The agent routes (`/api/agents/:id/files`, `/preview`, `/file`) stay and map
onto the agent's home in its workspace, so existing clients keep working.

Shipped as (backend): `server/src/files/` — `WorkspaceFs` (resolution,
`assertCanWrite`, versioned writes, edit/append/move/delete/restore, list),
`agent-home.ts` (handles, lazy + boot migration, move/delete of homes),
`fs-http.ts` (error → HTTP). Details the sections above leave open:

- `POST …/files` returns `{ ok, path, version, updatedBy, updatedAt }`
  (the new version). Without `expectedVersion` the write is unconditional;
  `expectedVersion: 0` means "must not exist yet". Empty content is allowed
  (a new folder is `<folder>/.keep`).
- 409 body: `{ statusCode: 409, message, path, expectedVersion,
  currentVersion, updatedBy?, updatedAt? }`. A refused write (another
  agent's home, any `.checkpoints/`) is 403; a bad path 400.
- `POST …/file/move` moves a file or every file under a folder, refuses to
  overwrite, and carries metadata and revisions along; returns `{ ok, from,
  to, moved }`. Restore returns `{ ok, path, version, … }`.
- `GET …/file/revision` returns the `FilePreview` plus `version`,
  `updatedBy`, `updatedAt` of that revision.
- Event: `{ type: 'file.changed', workspaceId, path, version, by: { kind,
  id, name } }`, `path` workspace-relative; deletes carry `deleted: true`
  (version 0) and a move emits the old path with `deleted, movedTo` then the
  new path.
- User writes record `updatedBy { kind: 'user', id: actorId() }` (the
  member's account id in a shared workspace).
- Moving an agent to another workspace allocates a fresh handle there;
  revisions and authorship of its files stay behind (they belong to the
  workspace that saw the edits). Deleting a workspace moves its agents'
  homes to the workspace they are re-homed into.
- Agent tools: `fs_list`, `fs_read` (version header), `fs_write`,
  `fs_edit`, `fs_append`, `fs_delete`, `fs_restore`, `fs_search` (optional `prefix`;
  `/` = the whole workspace), `slides_create` — all through `WorkspaceFs`.

## Rich display

The Artifacts view renders by kind: Markdown through the chat renderer
(`src/lib/md.tsx`, including rich components); CSV/TSV as a sortable table;
JSON as a collapsible tree; code with line numbers; images, PDF, audio with
transcript, HTML in the sealed sandbox; slides decks. Text files are
editable in place (Edit → Save, with the version check). The header shows
the owner (agent avatar or "Shared"), version, last editor and time, and a
History drawer with revisions and Restore.
