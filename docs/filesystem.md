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

```
/                         the global workspace
├── agents/
│   ├── <handle>/         an agent's home — its default working folder
│   │   ├── LESSONS.md    file brain (agent memory), as before
│   │   ├── JOURNAL.md
│   │   ├── knowledge/
│   │   ├── apps/<appId>/ mini-app state and data
│   │   └── .checkpoints/ read-only rollback history
│   └── …
├── org/                  org-wide artifacts: plans, decisions, meeting notes
├── channels/<slug>/      a channel's shared folder (unchanged)
├── uploads/              files users attach from the composer
└── <anything else>/      user- or agent-made shared folders
```

- **Home.** `agents.homeDir` stores the agent's home as a workspace-relative
  path, `agents/<handle>`. `<handle>` is the agent's name slugified
  (`[a-z0-9-]`, ≤ 40 chars), made unique within the workspace with `-2`, `-3`…
  It is fixed at creation and kept on rename (like `emailSlug`), so paths
  others wrote down stay valid. Moving an agent to another workspace moves
  its home.
- **Artifacts** = every folder outside `agents/`. In the UI, the
  *Artifacts* view shows the whole tree, grouped as **Shared** (the
  top-level shared folders) and **Agents** (each agent's home, with its
  avatar). An agent's own *Artifacts* tab shows its home.

## Paths an agent uses

Agent file tools resolve paths like a shell whose cwd is the agent's home:

| Written as      | Resolves to                                   |
|-----------------|-----------------------------------------------|
| `notes.md`      | `/agents/<handle>/notes.md` (relative = home)  |
| `~/notes.md`    | `/agents/<handle>/notes.md`                    |
| `/org/plan.md`  | `/org/plan.md` (absolute = workspace root)     |
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
| everything else (artifacts)  | read/write       | read/write   | read/write |

So: an agent's home is its own; collaboration happens in shared folders.
Writes go through the existing approval policy as before (fs_write is not
read-only).

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

## Migration

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

## Rich display

The Artifacts view renders by kind: Markdown through the chat renderer
(`src/lib/md.tsx`, including rich components); CSV/TSV as a sortable table;
JSON as a collapsible tree; code with line numbers; images, PDF, audio with
transcript, HTML in the sealed sandbox; slides decks. Text files are
editable in place (Edit → Save, with the version check). The header shows
the owner (agent avatar or "Shared"), version, last editor and time, and a
History drawer with revisions and Restore.
