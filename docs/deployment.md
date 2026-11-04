# Deployment model: free desktop app, paid multi-tenant cloud

> **Operational runbook:** this document is the long-term strategy. For the
> dev/staging/prod environments running today (Workers SPA, VPS API + tunnel,
> R2 buckets, secrets checklist), see **docs/environments.md**.

Two distributions of the same codebase, both proprietary (no source
release). The research behind docs/roadmap.md showed that self-hosting is
the #1 pain point of OpenClaw/Hermes users and exposed instances are the #1
disaster, so we do not ship a self-hosted server at all. The split is about
who manages the machine:

- **Desktop (free)**: your device, your data, everything inside one app
  process. The agent works while the app runs.
- **Cloud (paid)**: no device to manage at all. Agents live in our
  infrastructure and are simply *always there* — loops fire at 3am with the
  laptop closed, channels answer from anywhere, nothing to install, update,
  back up, or keep awake. The cloud is not remote access to a machine; it is
  the machine-less experience.

**Where the code is (1 Nov 2026).** The tenancy the cloud needs shipped as
`docs/accounts.md`: one codebase, `AUTH_MODE=single` for the desktop/self-run
case (the one `single` account owns every row, nothing visible changes) and
`AUTH_MODE=accounts` for the hosted deployment (email magic-link sessions,
one tenant per account, every query account-scoped). The hosted tier is
legible and sits under the competition's $20: `free` (your own keys, 3 agents,
3 loops), `hosted` (our keys, `HOSTED_PLAN_USD` a month — default $15 — as a
hard stop), `byo` (your keys, no ceiling). Of the three isolation layers in
§2, layer 1 is live (the scoped database handle plus the per-request account
context); layers 2 (RLS) and 3 (per-account storage prefixes) are still to
do. Payments plug into the `BillingProvider` seam; today plans are set by an
admin.

## 1. Free desktop app, single user

Target: download, open, chat. No Docker, no daemons, no accounts; the only
credential is a model provider key (or platform-metered access later).

- **Packaging.** Tauri shell (same stack as YAAM) wrapping the built
  frontend, with the Nest API embedded as a local process bound to
  127.0.0.1 on a random port with a per-launch auth token. Nothing listens
  for the outside world, ever: remote access is what the cloud is for.
  macOS / Windows / Linux builds, auto-update.
- **Zero-dependency storage.** The two infrastructure services swap for
  embedded drivers behind the existing interfaces:
  - Postgres → PGlite (embedded Postgres, WASM) through the same Drizzle
    dialect and the same boot migrations — this is already the tested path
    (the whole suite runs on PGlite today);
  - S3 → a local-filesystem StorageService driver under the app data dir,
    same key/prefix validation as the isolation boundary.
  Data lives in the OS app-data folder; backup = copy the folder.
- **Free, not open.** The desktop app is the free tier and the funnel: full
  durable-agent feature set, but bounded by the device — loops run while
  the app (or its tray process) runs, and the agent sleeps when the laptop
  does. That physical limit *is* the upgrade story: the cloud sells the
  removal of the device, not the return of removed features.
- **Escape hatch.** AGENT.json export/import works in both directions
  between desktop and cloud. Portability is the trust story: your agents
  are yours even though the code is not open.

## 2. Cloud: the full machine-less experience, multi-tenant

Target: the same binaries, `MODE=cloud`, behind our infrastructure. The
product promise is "agents with no device to manage": always-on loops and
heartbeats, channels that answer around the clock, zero setup or upgrades,
and durable state that outlives any laptop.

### Identity

- Email magic-link + OAuth (Google/GitHub) via a stateless JWT session.
  Passwordless first: general users, no password database to breach.
- A `users` table and a `tenantId` (= user id, later org id) stamped on the
  root aggregates: workspaces, agents, agent_types, skills, mcp_servers,
  app_settings become tenant-scoped rows.

### Tenancy isolation (defense in depth, three layers)

1. **Application scoping.** Every service call passes through a request
   context carrying `tenantId`; repositories filter on it. The existing
   pattern (everything already hangs off workspaceId/agentId) makes this a
   mechanical change: ownership check at the controller boundary, tenant
   column in the WHERE clause.
2. **Postgres row-level security.** RLS policies on every tenant table with
   `SET app.tenant_id` per request/connection. The app cannot forget a WHERE
   clause and silently leak: the database enforces the fence.
3. **Object storage prefixing + STS.** Keys become
   `tenants/<tenantId>/workspaces/...`; the existing cleanSegments validation
   already blocks traversal. For larger deployments, per-tenant scoped
   credentials (S3 STS session policies) so even an application bug cannot
   read across prefixes.

Secrets: provider API keys (agent_types.apiKey) move to envelope encryption
(KMS data keys) at rest, stay redacted in every API response as today, and
are never written to transcripts (already enforced by FR-13.3).

### Sandbox for the cloud version

Today's tool surface is deliberately brokered: fs_* against S3, HTTP through
an SSRF guard, MCP over HTTPS, previews/mini apps in network-blocked
sandboxed iframes. There is no shell and no host, so the OpenClaw class of
"agent reads your SSH keys" does not exist here. Keep that invariant, and
add capability tiers as we grow:

- **Tier 0 (now): brokered tools only.** No code execution anywhere.
  Per-tenant rate limits and token budgets are the main control.
- **Tier 1: sandboxed compute (browser tool, code runner).** Runs in
  disposable microVM/gVisor workers, one job per sandbox, no reuse across
  tenants. Sandboxes get: no credentials, a read-only job spec, workspace
  files mounted via pre-signed URLs scoped to the job, and egress through a
  filtering proxy (public internet only, same rules as assertPublicUrl,
  request/response size caps). Results come back as artifacts, never as
  direct storage writes.
- **Tier 2: user-owned runners — shipped as desktop computer control**
  (`docs/computer-control.md`, `companion/`). An explicitly paired local
  companion speaking outbound long-poll to the API (never an inbound port),
  scoped by the user at pairing (`screen`, `input`, `shell`, `files:<dir>`),
  with a stricter approval model than MCP tools: every call pauses in every
  mode, the acting tools can never be remembered, loop and channel turns are
  refused. This is the only path that touches user hardware, and it touches
  only the user's own.

Prompt-injection posture (applies to both distributions): tool results and
channel content are data, not instructions; mutating tools stay behind the
Ask policy; SELF_MOD tools can never get blanket grants; exfil-shaped
actions (http_request to unknown hosts with workspace content) remain
approval-gated even in Auto mode for channel-originated turns (roadmap
phase 4).

### Cost governance (multi-tenant survival)

- Per-tenant monthly token budget with hard stop + notification; per-loop
  budgets and model overrides (roadmap phase 2) keep unattended work cheap.
- Usage metering already exists per turn/session; roll it up per tenant for
  the cost dashboard and billing.
- Platform-provided model access (our keys, metered) alongside BYO keys, so
  general users never touch an API console.

### Operational shape

- Stateless API pods (the per-chat busy lock moves from in-process to a
  Postgres advisory lock keyed by session id; SSE streams pin to the pod
  that owns the turn).
- The loops ticker becomes a single leader-elected scheduler (advisory lock)
  so loops fire exactly once across replicas.
- Managed Postgres + object storage; migrations stay the idempotent boot
  migrations that both distributions already share.

## 3. Sequencing

1. Ship the desktop build: Tauri shell, PGlite + filesystem storage drivers,
   loopback-only embedded API (the free tier and the dogfooding platform).
2. Introduce request-context tenancy + users table behind `MODE=cloud`,
   single-tenant-per-deploy first (a hosted instance per user is a valid
   v0 cloud with zero cross-tenant risk).
3. RLS + shared multi-tenant deploy + budgets/metering.
4. Tier-1 sandboxes (browser tool) once phases 1-2 of the product roadmap
   ship.

## 4. Container build (Dockerfile)

The repo-root `Dockerfile` packages the cloud deployable: a multi-stage
build (node:22-alpine) that compiles server (tsc) + frontend (vite) in one
stage, then copies production `node_modules`, `server/dist`, and `dist/`
into a clean runtime stage running as the `node` user on port 8790.

```sh
docker build -t yaam-chat .
docker run -p 8790:8790 --env-file .env yaam-chat
```

With `NODE_ENV=production` (set in the image) the boot-time env validation
(server/src/config/validation.ts) requires `DATABASE_URL` and the `S3_*`
vars — see the Dockerfile header and `.env.example`. The API does not serve
static files; publish `dist/` (also in the image at `/app/dist`) via a
static host or reverse proxy that forwards `/api` to the container and
serves `index.html` for every other path that is not a file (the SPA's
routes are paths, `/<company>/channels/<slug>`; docs/routes.md).
`packs/` is compiled into `server/src/market/*.generated.ts`, so it is
excluded from the build context (`.dockerignore`).
