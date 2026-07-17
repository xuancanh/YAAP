# YAAM Chat

A standalone web application for **durable-agent chat**: provider-neutral LLM
conversations owned by persistent agent identities, extracted from the YAAM
desktop app's chat feature and rebuilt as a client/server web app.

- Requirements: [`docs/chat-requirements.md`](docs/chat-requirements.md)
  (FR-numbered; the source of truth for scope).
- Stack and layout follow `smart-knowledge-app`: **NestJS** backend
  (`server/`), **React 19 + Vite** frontend (`src/`), **Drizzle ORM +
  Postgres**, **S3-compatible object storage** for workspace files (MinIO in
  dev), tests on `node:test` via `tsx` against **PGlite** (in-memory Postgres).

## Quick start

```bash
npm install
docker compose -f docker-compose.dev.yml up -d   # Postgres :5433 + MinIO :9100
npm run dev        # NestJS API on :8790 + Vite frontend on :5175 (proxies /api)
npm test           # backend tests (PGlite in-memory Postgres, no server boot)
npm run build      # server (tsc) + frontend (vite) production build
```

Config defaults match the compose file; override via env (see `.env.example`).
Migrations are idempotent and run on every boot. The S3 bucket is auto-created
on boot when the store allows it (MinIO does; on AWS pre-create it).

## Layout

```
server/src/
  config/        typed env configuration
  database/      Drizzle schema + idempotent boot migrations (Postgres)
  status/        GET /api/status
  workspaces/    scoping partitions, durable memory (§12) + S3-backed files
  storage/       S3-compatible object storage (workspace-scoped keys)
  agent-types/   provider/model/persona presets (§9); API keys never leave the server
  agents/        durable agent identities: charter, feedback, dashboard (§11)
  chats/         sessions, transcript, the SSE tool-using turn loop (§1–§8)
  skills/        instruction-pack skills offered as tools (§10); built-ins seeded
  search/        GET /api/search — sessions, messages, files (FR-8.2)
  ai/            provider-neutral streaming interface (NFR-1) + Echo dev provider
src/             React frontend: full design port (chats, agents, files,
                 market, settings, artifact panel; dark/light, responsive)
tests/           node:test suites run with tsx against PGlite (in-memory Postgres)
scripts/dev.mjs  parallel server + Vite dev runner
```

Layering inside the server is Controllers → Services → Repositories (Drizzle),
one NestJS module per domain, mirroring the reference app.

## Current state

The chat pipeline runs end to end: session lifecycle
(archive/pin/tags/draft), a **tool-using streaming turn loop** (up to 24
rounds) with an **Anthropic adapter** (plus anthropic-compatible endpoints and
an Echo dev provider), workspace-file + raw-HTTP tools with an SSRF guard,
the **Ask/Auto approval flow** (allow once / always / whole tool / deny,
remembered per chat), **compaction** (`/compact` + auto-threshold, shared
busy lock, visible transcript untouched), token-ceiling refusal, stop/abort,
structured turn records, `/clear`, markdown `/export`, ratings, and system
context assembled from persona + agent charter + workspace memory + pending
feedback.

Also shipped: a **skills system** (global + workspace instruction packs
offered to the model as `skill_*` tools; `deep-research`, `write-document`,
and `create-slides` are seeded built-ins), **web_search / web_fetch /
fs_search** research tools, a **slides_create** tool rendering self-contained
HTML decks, workspace-wide **search** (`/api/search`), and **rich file
previews** (`/api/workspaces/:id/preview` classifies markdown/html/image/pdf/
text; HTML previews must render in a sandboxed, network-denied iframe).

The frontend implements the design comp in `design/`: activity-bar shell,
workspace-scoped chat list grouped by agent, streaming chat with thinking
blocks, tool cards + inline Ask/Auto approvals, artifact side panel
(sandboxed, network-denied), slash + @-mention menus with attachments,
message queueing, retry / edit-and-resend / fork / promote / ratings, token
meter, per-agent file brains with rich previews, agent directory + home
(charter, loops, ratings, mini apps, AGENT.json export), the agent market
with capability-review hiring, and six settings panes backed by the API.

Providers: Anthropic (+anthropic-compatible) and the OpenAI-compatible
family — OpenAI, DeepSeek, Kimi, GLM, and custom gateways — all through one
provider-neutral streaming loop. Scheduled agent loops fire on their cron
(FR-11.6) in a dedicated per-loop chat and journal each run; conversations
distill into size-bounded LESSONS/JOURNAL brain appends via /api/chats/:id/
distill or the Distill button (FR-11.4).

Next up: MCP tool discovery (§10.3), Gemini/Bedrock native adapters, and
attachments beyond workspace files (drag-and-drop uploads).
