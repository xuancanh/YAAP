# Environments runbook: dev, staging, prod

Three environments, one codebase. Dev runs entirely on your laptop; staging
and prod share the same hosted shape — SPA on Cloudflare Workers, API +
Postgres on a VPS behind a cloudflared tunnel, files in R2.

For the long-term product/deployment strategy see docs/deployment.md; this
page is the operational runbook for what exists today.

## Topology

```
                 ┌─────────────────────────── Cloudflare ───────────────────────────┐
 browser ──────▶ │ Worker (yaam-chat / yaam-chat-staging)                           │
                 │   ├── /api/*  ──worker.js proxy──▶ API_ORIGIN ─┐                 │
                 │   └── *       ──static assets──▶ dist/ (SPA)   │                 │
                 │                                                │ named tunnel   │
                 └────────────────────────────────────────────────┼────────────────┘
                                                                  │
        ┌──────────────────── VPS (docker compose) ───────────────▼───────────────┐
        │  cloudflared (host-level) ──▶ api container :8790 (127.0.0.1 only)      │
        │                                 │                                       │
        │                                 ├──▶ postgres container (volume pgdata) │
        │                                 └──▶ Cloudflare R2 (S3 API, per-env)    │
        └─────────────────────────────────────────────────────────────────────────┘
```

- **SPA**: `infra/cloudflare/` — Workers Static Assets serving `dist/` with
  SPA fallback; `worker.js` proxies `/api/*` (SSE streams included) to
  `API_ORIGIN` and marks API responses uncacheable.
- **API origin**: the container behind a *named* cloudflared tunnel, bound to
  `127.0.0.1` — nothing else reaches it. SSE is hardened end-to-end
  (`no-transform`, `X-Accel-Buffering: no` in the API; pass-through streaming
  in the worker; cloudflared streams SSE natively).
- **Data**: Postgres in compose (per-env volume), workspace files in R2 with
  one bucket per environment.
- **Images**: CI builds the root `Dockerfile` and pushes
  `ghcr.io/xuancanh/yaam-chat`; the VPS pulls by tag.

## What's deployed where

| Piece            | dev                        | staging                          | prod                            |
| ---------------- | -------------------------- | -------------------------------- | ------------------------------- |
| SPA              | Vite dev server (:5175)    | Worker `yaam-chat-staging`       | Worker `yaam-chat`              |
| API              | `npm run server:dev`       | VPS compose, tunnel `api-staging.<zone>` | VPS compose, tunnel `api.<zone>` |
| Postgres         | docker-compose.dev.yml     | VPS compose service              | VPS compose service (separate volume) |
| Object storage   | MinIO (:9100)              | R2 `yaam-chat-staging`           | R2 `yaam-chat-prod`             |
| DATABASE_URL     | localhost:5433             | VPS compose network, per-env password | VPS compose network, per-env password |

Secrets are never shared between environments: separate DATABASE_URL,
S3 bucket + R2 API token, TOKEN_ENCRYPTION_KEY, and YAAM_API_TOKEN each.

## GitHub environment variables / secrets (staging, prod)

Set these on the `staging` and `prod` GitHub environments (values differ):

| Name                    | Kind   | Purpose |
| ----------------------- | ------ | ------- |
| `CLOUDFLARE_API_TOKEN`  | secret | Scoped token: **Workers Scripts:Edit** + **Workers R2 Storage:Edit** (bucket bootstrap) on the account. |
| `CLOUDFLARE_ACCOUNT_ID` | secret | Account id for wrangler (`CLOUDFLARE_ACCOUNT_ID` env var). |
| `STAGING_HOST` / `PROD_HOST` | var | VPS SSH target for the API deploy (`user@host`). |
| `STAGING_SSH_KEY` / `PROD_SSH_KEY` | secret | Private key with pull/`docker compose` rights on the VPS. |
| `GHCR_PAT` (or `GITHUB_TOKEN`) | secret | Lets the VPS `docker login ghcr.io` and pull the image. |

`API_ORIGIN` is not a secret — it lives in `infra/cloudflare/wrangler.toml`
under `[env.*.vars]`. Fill in the real tunnel hostnames there.

## VPS compose secrets (per environment, `/opt/yaam-chat-<env>/.env`)

Consumed by `deploy/docker-compose.prod.yml` (copy it to the VPS as
`docker-compose.yml`):

- `POSTGRES_PASSWORD` — compose-network DB password (DATABASE_URL is
  assembled from it).
- `S3_ENDPOINT` / `S3_REGION=auto` / `S3_BUCKET` / `S3_ACCESS_KEY_ID` /
  `S3_SECRET_ACCESS_KEY` / `S3_FORCE_PATH_STYLE=false` — the per-env R2
  bucket and its scoped R2 API token (see `.env.example` for exact values).
- `TOKEN_ENCRYPTION_KEY` — seals connection tokens at rest (required).
- `YAAM_API_TOKEN` — bearer token required on every `/api` route; the SPA
  sends it too (required — the API is reachable from the internet via the
  tunnel).
- `PUBLIC_BASE_URL` — `https://api(-staging).<zone>` (OAuth redirect base).
- Optional: `GOOGLE_CLIENT_ID/SECRET`, `MS_CLIENT_ID/SECRET`,
  `TELEGRAM_BOT_TOKEN`, `RUNNER_CF_URL/TOKEN`, per env.

## Deploy commands

```sh
# SPA (from repo root, after `npm run build`)
npx wrangler deploy --config infra/cloudflare/wrangler.toml --env staging
npx wrangler deploy --config infra/cloudflare/wrangler.toml --env prod

# API (on the VPS, per environment)
cd /opt/yaam-chat-<env>
docker compose pull && docker compose up -d
```

## First-time setup checklist

1. **R2**: in the Cloudflare dashboard create buckets `yaam-chat-staging` and
   `yaam-chat-prod`; create one R2 API token per bucket (Object Read & Write,
   scoped to that bucket) and record the access key id / secret.
2. **Tunnel**: create one named tunnel (`cloudflared tunnel create yaam-chat`),
   and route two public hostnames on your zone: `api-staging.<zone>` and
   `api.<zone>`, both to service `http://localhost:8790`. Install the tunnel
   on the VPS at host level (`cloudflared service install` with the tunnel
   token) so it survives compose restarts. DNS records are created
   automatically by the hostname routes.
3. **wrangler**: update `API_ORIGIN` in `infra/cloudflare/wrangler.toml` for
   both envs, then `npx wrangler login` (locally) or set
   `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` (CI) and run the first
   `wrangler deploy --env staging` / `--env prod`.
4. **VPS**: install Docker + cloudflared; `docker login ghcr.io`; create
   `/opt/yaam-chat-staging` and `/opt/yaam-chat-prod`, drop
   `deploy/docker-compose.prod.yml` in as `docker-compose.yml` plus a filled
   `.env` (list above); `docker compose up -d`.
5. **Smoke test**: `curl https://api-staging.<zone>/api/status` (200 without
   auth), then open the staging Worker URL, run a chat turn, and confirm SSE
   streams live (no buffering delays).

`deploy/docker-compose.prod.yml` is the canonical per-env compose file —
API from GHCR (bound to localhost), Postgres 17 with a healthcheck and
named volume, tunnel handled at host level.
