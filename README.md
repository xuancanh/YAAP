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
  chats/         sessions, transcript, and the SSE streaming turn loop (§1–§8)
  ai/            provider-neutral streaming interface (NFR-1) + Echo dev provider
src/             React frontend (placeholder shell; real design lands later)
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

Next up (tracked against the requirements doc): more provider adapters
(OpenAI et al.), attachments + @-mentions + slash autocomplete (§2), search
(§8.2), skills/MCP (§10), the durable-agent brain/dashboard/loops (§11), and
the real frontend.
