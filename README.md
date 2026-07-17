# YAAM Chat

A standalone web application for **durable-agent chat**: provider-neutral LLM
conversations owned by persistent agent identities, extracted from the YAAM
desktop app's chat feature and rebuilt as a client/server web app.

- Requirements: [`docs/chat-requirements.md`](docs/chat-requirements.md)
  (FR-numbered; the source of truth for scope).
- Stack and layout follow `smart-knowledge-app`: **NestJS** backend
  (`server/`), **React 19 + Vite** frontend (`src/`), **Drizzle ORM + SQLite**
  (`better-sqlite3`), tests on `node:test` via `tsx`.

## Quick start

```bash
npm install
npm run dev        # NestJS API on :8790 + Vite frontend on :5175 (proxies /api)
npm test           # backend tests (in-memory SQLite, no server boot)
npm run build      # server (tsc) + frontend (vite) production build
```

The SQLite database is created at `./data/app.sqlite` on first boot
(`DATA_DIR` overrides; see `.env.example`).

## Layout

```
server/src/
  config/        typed env configuration
  database/      Drizzle schema + idempotent boot migrations (SQLite)
  status/        GET /api/status
  workspaces/    scoping partitions + durable workspace memory (§12)
  agent-types/   provider/model/persona presets (§9); API keys never leave the server
  agents/        durable agent identities: charter, feedback, dashboard (§11)
  chats/         sessions, transcript, and the SSE streaming turn loop (§1–§8)
  ai/            provider-neutral streaming interface (NFR-1) + Echo dev provider
src/             React frontend (placeholder shell; real design lands later)
tests/           node:test suites run with tsx against in-memory SQLite
scripts/dev.mjs  parallel server + Vite dev runner
```

Layering inside the server is Controllers → Services → Repositories (Drizzle),
one NestJS module per domain, mirroring the reference app.

## Current state

The scaffold runs end to end: create a chat, send a message, and an SSE stream
renders the reply token by token (an **Echo** development provider stands in
for real LLMs). Implemented so far: session lifecycle (archive/pin/tags/draft),
turn records with usage accounting, token-ceiling refusal, stop/abort,
provider-history rules (tool/thinking excluded, compaction cutoff honored),
`/clear`, markdown `/export`, turn ratings, and agent pending-feedback
plumbing.

Next up (tracked against the requirements doc): real provider adapters
(Anthropic first), the tool families + Ask/Auto approval flow (§3–§4),
compaction (§7), search (§8.2), skills/MCP (§10), and the durable-agent brain,
dashboard, and loops (§11).
