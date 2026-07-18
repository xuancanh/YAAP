# Deployment model: free single-user OSS, and a multi-tenant cloud

Two distributions of the same codebase. The research behind docs/roadmap.md
showed that self-hosting is the #1 pain point of OpenClaw/Hermes users, and
security of exposed instances is the #1 disaster. So: the open-source build
stays radically simple and safe for one person on one machine, and the cloud
build adds login, tenancy, and hard isolation without forking the code.

## 1. Free and open source, single user

Target: `docker compose up` and nothing else. No accounts, no keys except the
model provider's.

- **Packaging.** One compose file: app (API + built frontend served by Nest),
  Postgres, MinIO. All state in two named volumes. `latest` and pinned tags.
- **Bind local by default.** The app listens on 127.0.0.1 unless
  `BIND_PUBLIC=true` is set, and when it is set without auth configured the
  server refuses to boot with an explanatory error. This single decision
  avoids the "thousands of exposed gateways" failure OpenClaw had: unsafe
  exposure must be a double opt-in, never a setup wizard default.
- **Optional single-user lock.** `AUTH_PASSWORD=<secret>` enables a login
  page + signed session cookie. That is the entire single-user auth story:
  no user table, no roles. Recommended (and required, see above) when
  binding beyond localhost; reverse-proxy TLS documented but not our job.
- **Licensing.** Core stays permissive (Apache-2.0). Everything in this repo
  runs in single-user mode with zero feature flags removed; the cloud layer
  (billing, org admin) lives outside the OSS tree, not as crippled stubs
  inside it.
- **Escape hatch.** AGENT.json export and the S3/Postgres data layout are
  documented so a cloud user can move to self-hosted and back. Portability
  is the trust story that makes a hosted default acceptable.

## 2. Cloud: remote access with login, multi-tenant

Target: the same binaries, `MODE=cloud`, behind our infrastructure.

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
- **Tier 2 (much later): user-owned runners.** If "act on my machine" is
  ever wanted, it is an explicitly paired local runner speaking outbound
  WebSocket to the cloud (never an inbound port), with the same approval
  model as MCP tools. This is the only path that touches user hardware.

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

1. Ship compose packaging + bind-local default + AUTH_PASSWORD (OSS story
   complete; also the dogfooding platform).
2. Introduce request-context tenancy + users table behind `MODE=cloud`,
   single-tenant-per-deploy first (a hosted instance per user is a valid
   v0 cloud with zero cross-tenant risk).
3. RLS + shared multi-tenant deploy + budgets/metering.
4. Tier-1 sandboxes (browser tool) once phases 1-2 of the product roadmap
   ship.
