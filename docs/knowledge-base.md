# The knowledge base

Every agent pack can ship a **knowledge base**: curated, read-only reference
for that role. It holds frameworks, checklists, templates, metric definitions
with formulas, pitfalls and short worked examples. The agent searches it
while it works. It complements the pack's skills: a skill says what to do,
step by step, and the knowledge base holds the reference material behind it.

The knowledge base is shipped and the same for every install. It is not the
agent's memory. What an agent learns on the job stays in its own home:
`LESSONS.md`, `JOURNAL.md` and `knowledge/` notes (docs/agent-memory.md).
The prompt names both and keeps them apart.

## Source format

```
knowledge/
├── _shared/<topic>/<slug>.md       cross-role topics (1–5 docs each)
└── <pack-file-basename>/           one folder per pack, named like packs/<name>.md
    ├── README.md                   the overview: what it covers, when to use which doc
    └── <slug>.md                   the docs (1–8; aim for 3–6)
```

Every file starts with JSON front matter:

```
---json
{ "title": "Budget memo", "summary": "One sentence: what this doc helps with.",
  "tags": ["budget", "finance"], "updated": "2026-11-04",
  "sources": [{ "title": "…", "url": "https://…", "date": "2025-03" }],
  "shared": ["_shared/okrs", "_shared/decisions"] }
---

# Budget memo
…markdown…
```

- `title` takes 3–120 characters and `summary` takes 10–300.
- `tags` holds 1–12 strings. They are stored in lowercase.
- `updated` is a date written `YYYY-MM-DD`.
- `sources` is optional and is only for docs that cite external facts. Each
  entry is `{ title, url }`, plus optional `date`, `accessed`, `publisher`,
  `author` and `note` strings. An installed file lists its sources at the end.
- `shared` is optional and belongs only in a pack's `README.md`. It names
  the shared topics this role also sees.
- No other keys are allowed.

Links between docs are relative, like `./weekly-review-pack.md` or
`../_shared/okrs/writing-key-results.md`. A path relative to `knowledge/`,
like `_shared/okrs/x.md`, is also accepted, and the build rewrites it
relative to the doc. The installed tree has the same shape, so the links
work in Artifacts.

Shared topics today: `okrs`, `briefs-and-handoffs`, `decisions`, `meetings`,
`prioritisation`, `planning-and-estimation`, `risk`, `review` and
`sources-and-citation`.

## Build and validation

`npm run knowledge:build` runs `scripts/build-knowledge.mjs`, which writes
`server/src/knowledge/knowledge.generated.ts`. `npm run knowledge:check`
validates without writing anything. Commit the generated module with the
content, because a test checks that it matches the build. The validation is
strict, and any of these fails the build:

- front matter that is missing, is not JSON, has an unknown key or has a wrong type;
- a folder that names no `packs/<folder>.md`, or a pack folder without `README.md`;
- a sub-folder or a file other than `.md`, or a file name that is not a slug;
- a `shared` ref that is not a topic folder;
- a relative link that resolves to no doc or folder, or an absolute link that is not `http(s)` or `/library/…`;
- a size cap that is exceeded (next section).

A pack with no folder is fine. The build and a test only **warn** about it,
so content can be added pack by pack. Each pack's version is a content hash
of its docs and of the shared topics it names.

## Caps

| What | Cap |
|------|-----|
| A doc's body | 16,000 characters (at least 200) |
| A README's body | 8,000 characters (at least 80) |
| A pack, in all | 90,000 characters |
| Docs per pack | 8, plus the README |
| Docs per shared topic | 5 |
| Tags / sources per doc | 12 / 20 |
| kb_read page | about 6,000 characters |
| kb_search hits | 8 by default (at most 20) |
| The prompt pointer | 700 characters |

Aim for 300–900 words per doc, in plain language (docs/agent-writing.md).
Don't invent statistics: a benchmark or fact goes in `sources`, with its date.

## Which agent sees what

An agent's pack is `agents.packId`, added in migration 0092. Every pack door
sets it: a market hire, a company hire from a role or a pack, and a chief
created from the Chief of Staff pack. Agents from before 0092 have their
pack read from what they carry:

1. the chief of staff's seat, then the auditor's;
2. else the pack whose playbooks the agent holds (at least two of them);
3. else a pack with the same name.

From the pack, the scope (`scopeFor` in `server/src/knowledge/knowledge.ts`) is:

| The agent | Searches and reads |
|-----------|--------------------|
| A pack with a knowledge base | its pack's docs, plus the shared topics its README lists |
| A business pack with no knowledge base yet | every shared topic |
| An agent made outside packs, in a company | every shared topic |
| An agent made outside packs, outside a company, or a personal pack with no knowledge base | nothing (no tools, no pointer) |

An agent never searches another role's knowledge base. That role's folder
is still a readable file under `/library/`, but it is not this agent's reference.

## Install: `/library/`

The docs are installed into each workspace as read-only files:

```
/library/README.md                     the index (generated)
/library/<pack>/README.md, <slug>.md    a role's knowledge base
/library/_shared/<topic>/<slug>.md      the shared topics
```

- **Once per workspace.** Every agent of a role shares one copy.
- **When it is installed:** on a hire through the market or the company, on
  an agent's first turn that needs it, and at boot for every workspace with
  agents. The agent page installs it again on demand.
- **Updates.** An install writes only the files whose text changed. A doc
  the pack no longer ships is deleted, and a revision is kept. So a new
  pack version reaches every workspace at the next boot or turn.
- **Read-only.** `WorkspaceFs.assertCanWrite` refuses every writer under
  `/library/` except the system, agents and people alike. An agent that
  tries to write there is told to use its own `knowledge/` notes or `/org/`.
- **In Artifacts.** `/library/` is a shared folder, and its files open in
  the side panel. A `/library/…` path written in chat is a link.

**Why a shared folder and not the agent's home `knowledge/`.**
`agents/<handle>/knowledge/` is the agent's own notes: the agent writes it,
it travels with the agent and it holds what the agent learned. Copying
curated reference into it would mix shipped text with learned memory. Every
pack update would overwrite the agent's own files. N agents of one role
would mean N copies to refresh, and nothing would stop an agent from editing
the shipped text. A shared, system-owned folder keeps one copy per role, has
one place to update and one permission rule, and keeps reference and memory
apart.

## Tools, skill and prompt

The tools come from `server/src/knowledge/knowledge.tools.ts`, a turn-loop
tool provider. They are offered to every agent whose scope isn't empty, in
a private chat, a channel, a meeting, a task run or a heartbeat alike. They
are classed `read` (no approval), and they are in the auditor's read-only
run set.

- `kb_search { query, limit? }` ranks the scope's docs with BM25F over the
  title (weight 3), tags (2.5), summary (2) and body (1), and shows the best
  matching line. It reads the embedded bundle, not the files.
- `kb_read { path, page? }` reads a doc by any path form (`x/y.md`,
  `/library/x/y.md`, `(KB: x/y.md)`, or a bare slug that is unique in scope),
  in pages. The header gives the citation form, and the last page lists the
  sources.
- `kb_list` lists every doc in scope with its summary.

The **`use-the-knowledge-base`** built-in skill says when to search: before
planning a deliverable in the agent's field, when unsure of a method or a
formula, when a checklist may apply, and when reviewing. It also says how
to apply a doc (fill the template with company facts; the company's
playbooks and tunables win) and how to cite it as `(KB: <path>)`.

The **prompt pointer** is one `# Knowledge base` section of at most 700
characters. It holds the README summary, the doc titles and the shared
topics, says when to search and how to cite, and adds one line separating
the knowledge base from LESSONS.md and knowledge/ notes.

## Market and agent page

- `GET /api/market` items carry `knowledge: { folder, docs, titles, shared, version }`.
  The Foundry card shows "N docs". The hire review shows "Knowledge base · N docs"
  with the titles and the shared topics.
- `GET /api/agents/:id/knowledge` returns the agent's scope with each doc's
  `/library/` file. `POST …/knowledge/install` installs it. The agent's
  Overview tab shows a *Knowledge base* card, and each doc opens in Artifacts.

## Portability

AGENT.json carries `packId` (by reference, never the docs). An import with a
known pack id gets that pack's knowledge base from the importing install.
Blueprints refer to roles, whose packs bring their knowledge base on the hire.

## Adding a doc

1. Read the pack (`packs/<name>.md`) so the doc adds to its skills instead of repeating them.
2. Write `knowledge/<pack>/<slug>.md` with the front matter. Link it from the
   pack's `README.md` under "when to use which doc".
3. Run `npm run knowledge:check`, then `npm run knowledge:build`, and commit
   the doc and `server/src/knowledge/knowledge.generated.ts`.
4. Workspaces pick the change up at the next boot, or on the next turn of an agent of that role.
