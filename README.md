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
A **credential-free browser tool** (`browser_open` / `browser_read` /
`browser_act` / `browser_screenshot`, Cloudflare Browser Rendering or local
Playwright, incognito per turn, SSRF-guarded, password fields refused) streams
every page it renders as a screenshot into the chat's Browser panel
(`docs/browser-tool.md`).

**The workspace is the company** (`docs/group-chat.md` §5,
`docs/autonomous-company.md`): switch a workspace into organization mode and
every agent in it joins under a chief of staff — a shared task board with
atomic claiming and four-field briefs, event-driven wakes (assignment,
comment on an owned task, review request, approval decision — never a
mention, no heartbeats), USD envelopes reserved before every run with an 80%
warning and a 100% hard stop, circuit breakers (no-progress backoff,
same-call loop detection, a three-round review cap that escalates to you)
and a hash-chained audit log. In **supervised** mode the chief's
`org_hire_agent` / `org_set_scope` (widening) / `org_reorg` /
`org_allocate_budget` / `org_terminate_agent` calls produce approval cards
you decide in the app or by answering the brief; in **autonomous** mode they
execute at once within hard caps (depth ≤ 3, five direct reports, an agent
cap, agent and project envelopes inside the company envelope, scopes never
beyond the chief's own, nothing inherited) and are refused with the reason
outside them — every action audited with the chief's reason, announced in
`#company` and listed in the daily brief, and the chief reviews the
structure when a task blocks or a goal lands and once a day. Every member
with direct reports leads a **unit** (`docs/group-chat.md` §7): its own
board, a `#<slug>` channel whose membership follows the org chart, and a
goal subtree with computed progress, plus unit-scoped `org_set_goal` /
`org_assign` / `org_unit_report` tools. Intent flows down as a cascade
(`docs/company-vision.md` §2): you write a **vision** with a horizon, a
budget and your rules; the chief's planning session turns it into objectives
with measurable **key results** (metric, target, owner, due date) and hands
each objective to a unit whose lead plans its own; owners **check in** value
and confidence; a model-free sweep flags key results at risk (behind pace,
no active owner, confidence falling, check-in overdue) and wakes the unit
lead, the chief, or your brief; any task can show its **why chain**. Every
threshold is a per-company **tunable** with a bound, and the company's values
and culture (its operating profile, §1b) reach every planning prompt. Money is
the control surface (§7–§8): every task has a class, spend rolls up to key
results and objectives (**cost per outcome**, flagged when it runs ahead of
progress), allocations say what each envelope buys, task classes route to
model tiers, a trailing-burn **forecast** warns before the balance does, the
autonomous chief's structural plans wait a **veto window** before they apply
(or run as a dry run that applies nothing), and any day can be **replayed**
from the audit chain. The Workspace
rail shows the company and each unit (channel, board, goals), then the org
chart, approvals, spend, brief and audit;
Settings → Workspace → Organization holds the mode, chief, envelope, cap and
the pause button. `COMPANIES_ENABLED=false` hides it all.

**Group chat** (`docs/group-chat.md`): every workspace has Slack-style
channels (`#general` by default), where people and agents converse. A
mentioned agent wakes in its own per-channel session and its reply streams
into the channel; agents allowed to speak unprompted pass one cheap relevance
check and hard bounds (one per two minutes, two per message, never while a
mentioned agent is replying, never to another unprompted reply, never over
the channel's daily token budget); agent-to-agent chains stop after three
rounds per thread until a person speaks. Threads, a channel folder mounted as
`shared/`, "make task" from any message (organisation board or the agent's
kanban) with status lines posting back, approvals routed to the person who
asked, mention notifications through paired Telegram/email/push with deep
links, `#slug text` posting from Telegram, workspace SSE, and FTS over
channel messages.

The frontend implements the design comp in `design/`: activity-bar shell,
workspace-scoped chat list grouped by agent, streaming chat with thinking
blocks, tool cards + inline Ask/Auto approvals, artifact side panel
(sandboxed, network-denied), slash + @-mention menus with attachments,
message queueing, retry / edit-and-resend / fork / promote / ratings, token
meter, per-agent file brains with rich previews, agent directory + home
(charter, loops, ratings, mini apps, AGENT.json export), the agent market
with capability-review hiring, and the settings panes (including Market and
Security) backed by the API.

Providers: Anthropic (+anthropic-compatible) and the OpenAI-compatible
family — OpenAI, DeepSeek, Kimi, GLM, and custom gateways — all through one
provider-neutral streaming loop. Scheduled agent loops fire on their cron
(FR-11.6) in a dedicated per-loop chat and journal each run; conversations
distill into size-bounded LESSONS/JOURNAL brain appends via /api/chats/:id/
distill or the Distill button (FR-11.4).

MCP (§10.3): HTTP(S) MCP servers over the Streamable HTTP transport —
configure in Settings, Discover caches the tool list, and enabled servers'
tools are offered to chats as `mcp_<server>_<tool>`, always pausing for
approval in Ask mode (the server behind an MCP call is opaque, so it gates
like a mutation).

Composer attachments accept drag-and-drop and file-picker uploads (stored
under uploads/ in the workspace file store); assistants can offer one-tap
quick replies (FR-5.3, a provider-neutral QUICK_REPLIES protocol line the UI
parses); AGENT.json v2 round-trips — export from the agent home (identity,
loops, apps, lessons, private skills, open tasks), import on the directory
page behind a review modal where lessons arrive quarantined and skills as
drafts (FR-11.7). Agents also import memory from Claude, Meta Muse, Hermes
and OpenClaw exports as proposals, and skills import/export as agentskills.io
`SKILL.md` through a scan step; every skill tracks use and 👍/👎 outcomes,
and a 👎 lets the agent propose a revision you accept as a diff. The Market's
**Community** department is a registry (`docs/registry.md`): publish an
agent, skill or mini app (scanned first), install behind a mandatory
capability review that lands everything inert, ratings rolled up from turn
feedback, and federation with a hosted registry over `REGISTRY_URL`.

Image attachments are real vision inputs: uploaded/mentioned images become
base64 image blocks (Anthropic) or data-URI image_url parts (OpenAI family)
on the user message, bounded to 4 images ≤3MB each. Gemini is supported via
its OpenAI-compatible endpoint. Chats archive from the header and restore
from the sidebar's Archived group (FR-1.4). Voice notes record in the
composer (or drop an audio file) and transcribe on upload through an
OpenAI-compatible `/audio/transcriptions` endpoint — the model reads the
transcript, never the bytes — with optional read-aloud replies behind a
setting (docs/voice.md).

Accounts and tenancy (docs/accounts.md): every table carries `accountId` and
the database handle is account-scoped, so one deployment can serve many
people. `AUTH_MODE=single` (default) keeps today's one-user install exactly as
it was; `AUTH_MODE=accounts` adds email magic-link sign-in, an Account pane,
and plans — `free` (your keys, 3 agents, 3 loops), `hosted` (platform keys
under a monthly dollar ceiling, default $15, enforced as a hard stop) and
`byo` (your keys, no ceiling) — with billing left to a `BillingProvider` seam
an admin drives by hand today.

Shared agents (docs/shared-agents.md): in accounts mode a workspace owner
invites other people by email as `member` or `viewer`; they work inside the
owner's workspace with their own identity. A member's sessions are private
until shared and their messages are attributed to them (never treated as
authority); an agent may use a member's own Google/Microsoft connection only
in turns that member starts, and a call that would use someone else's
connection pauses for *that* person's approval, delivered to their inbox,
phone or mail and invisible to everyone else; lessons and profile entries
carry an audience (shared or private to one member) and cross-member flow is
default-deny until the owner writes a rule. Organisations gain humans too:
board members decide hires, budgets and strategy, observers read, and the
audit chain names who decided.

Proactivity controls (roadmap Phase 2, finished): per-workspace **quiet
hours** with an interrupt policy (`queue` | `silent` | `allow-urgent`) — loops
still run inside the window, their notifications wait or stay inbox-only; a
**monthly spend stop** (`spendBudgetTokens`) that refuses loop runs before the
model is called (one `budget_stop` event per loop per day) while user turns
keep working behind a "Workspace budget reached" badge; **cost in dollars**
from a per-model list-price table (`server/src/ai/pricing.ts`, overridable in
Settings → Usage) with 30-day per-agent/per-loop charts on the agent home and
`GET /api/agents/:id/usage`; and **two-way Telegram** — undelivered inbox
events for the paired default agent (plus every agent's failures and budget
stops) are pushed to the paired chat within a minute, batched, each with a
deep link back to the conversation, never echoing channel-born events back.
Loops also fire on **event triggers** (`docs/triggers.md`): new mail matching
a query, a calendar event created/changed/starting, a task assigned by
someone else, or a secret webhook URL — payloads reach the agent framed as
data, not instructions, under the same budgets and quiet hours.

Presence (roadmap Phase 4, `docs/channels.md`): every agent has an **email
address** (`<slug>@EMAIL_DOMAIN`, inbound through an HMAC-signed webhook fed
by `cloudflare/email-worker`, pairing by code, replies threaded back through
Cloudflare Email Sending or Resend, optional inbox digest), **web push** with
VAPID keys and a service worker, and a **manifest** so the UI installs as a
PWA — inbox events reach the phone's lock screen, honouring quiet hours.

Desktop computer control (`docs/computer-control.md`, `companion/`): a paired,
outbound-only companion on the user's own machine gives agents `computer_*`
tools (screenshot, click/type/key, shell, files in granted folders) behind
user-chosen scopes — every action approved in the app, the acting tools never
auto-approvable, loop and channel turns refused, every action audited in
Settings → Computer with Pause / Disconnect and a server kill switch.

Next up: a native Bedrock (SigV4) adapter is the one remaining FR-9.2
provider.
