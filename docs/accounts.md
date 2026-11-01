# Accounts: tenancy, sign-in, plans

Status: **shipped** (execution-plan item 7; `docs/shared-accounts.md` phase 5
option (b)). Single-user mode stays the default for self-hosting; the hosted
product turns on `AUTH_MODE=accounts`.

## 1. The two modes

| | `AUTH_MODE=single` (default) | `AUTH_MODE=accounts` |
|---|---|---|
| Who | one person, one install | many accounts, one deployment |
| Credential | optional `YAAM_API_TOKEN` bearer | HttpOnly session cookie from an email magic link (or, experimentally, the suite's JWT) |
| Identity | `SINGLE_USER`, account `single` | the account id |
| Plan | `byo`: own keys, no ceiling but the workspace budget | `free` / `hosted` / `byo` per account, default `ACCOUNTS_DEFAULT_PLAN=free` |
| What changes on screen | nothing; Settings → Account says "Single-user mode" | a sign-in screen, sign-out and an Account pane |

Both modes run the same code and the same schema: every row belongs to an
account, and in single mode that account is `single`. There is no untenanted
code path left to drift.

## 2. Sign-in (accounts mode)

Passwordless, so there is no password database to breach.

1. `POST /api/auth/request-link { email }` — creates a **pending** account for
   a new address, mints a random 32-byte token, stores its SHA-256 in
   `account_login_tokens` (15-minute expiry, one use) and mails
   `<PUBLIC_BASE_URL>/api/auth/callback?token=…` through the `EMAIL_SEND_*`
   provider (`channels/email-sender.ts`, same as the email channel). With the
   sender `off` the link is logged instead — fine for dev, and the response's
   `sent: false` lets the UI say so. Rate-limited: 3 per address and 20 per
   caller IP per 15 minutes (429). The answer is the same for known and unknown
   addresses.
2. `GET /api/auth/callback?token=…` — redeems the token, activates the account
   on first use (and runs the per-account seeding hooks: built-in skills; the
   default workspace is created lazily), mints a session (random token, hash in
   `account_sessions`, 30 days), sets `yaam_session` (HttpOnly, SameSite=Lax,
   Secure when `PUBLIC_APP_URL` is https) and redirects to the app.
3. `GET /api/auth/me` — `{ mode, authenticated, account? }`; public, so the SPA
   renders the right thing without a 401 round trip.
4. `POST /api/auth/logout` — deletes the session row and clears the cookie.

`SessionAuthStrategy` (`server/src/accounts/session-auth.strategy.ts`) is the
`AuthStrategy` bound in accounts mode. It still honours `YAAM_API_TOKEN` as a
bearer for scripts — resolving to the single account's data, an operator
escape hatch rather than a user credential.

**Suite front door (experimental).** With `SUITE_ACCOUNTS_URL` +
`SUITE_ACCOUNTS_SECRET` set, `SuiteJwtStrategy` is bound instead: an HS256 JWT
in `Authorization: Bearer`, `sub` = account id, `email`, `exp` required; the
account row is created on first sight. This is the shape phase 3 of
`shared-accounts.md` will plug into. It is deliberately minimal (no JWKS, no
rotation) and exists so the seam and the token check are real and tested
before the front door is built.

## 3. Data model and the account boundary

**`accountId TEXT NOT NULL DEFAULT 'single'` on every table.** Migration
`0023-accounts` creates the account tables, inserts the `single` account
(status `active`, plan `byo`) and then `ensureAccountColumns()` walks
`information_schema` and adds the column plus an `idx_<table>_account` index
to every table that lacks them — existing rows backfill to `single` through
the default. That sweep also runs on **every boot after the tracked
migrations**, so a table created by a later migration (another branch's
`computer_runners`, `registry_*`, `org_*`) is fenced without anyone writing an
ALTER. The schema side is one line per table:

```ts
export const widgets = pgTable('widgets', { ...accountScoped(), id: text('id').primaryKey(), … });
```

`tests/backend-accounts.test.ts` reflects over every exported `pgTable` and
over the live database and fails with exactly that instruction when a table
is missing the column.

**Scoping is a property of the database handle, not of each query.**
`DRIZZLE_DB` is `scopeDb(drizzle(...))` (`server/src/accounts/scoped-db.ts`):
`select … from(t)`, `update(t).set()` and `delete(t)` get
`WHERE t."accountId" = currentAccountId()` AND-ed onto whatever `where` the
caller adds; `insert(t).values()` stamps the account on rows that do not set
it; `transaction()` hands out a scoped handle. A table takes part the moment
it has an `accountId` column. Raw `db.execute(sql…)` is untouched by design
(the few sites key on ids that are already unique), and `unscoped(db)` returns
the bare handle for the handful of deliberate cross-account lookups —
resolving which account owns an agent slug, a paired Telegram chat id or a
webhook target — each marked with a comment saying why.

**The current account is an `AsyncLocalStorage` context**
(`server/src/accounts/account-context.ts`), not a request-scoped Nest
provider, so no service changed scope. `accountContextMiddleware` opens an
empty store per request; `AuthGuard` fills it with the resolved id (the
single identity maps to `single`). Background work opens its own:
`LoopsService.tick`, the Telegram, email and web-push sweeps run once per
active account via `AccountsService.forEachAccount`, debounced task triggers
remember the account that queued them, webhook fires and inbound mail run
under the account that owns the agent, and a Telegram message runs under the
account whose settings hold that chat id. A pairing code remembers which
account minted it, so a code from one account cannot pair a chat or address
into another.

Account infrastructure tables (`accounts`, `account_sessions`,
`account_login_tokens`, `account_usage`) are read before any account is bound
and are the only ones the scoped handle leaves alone. Unique indexes that
were global became per-account where the thing is per-account (skill names)
and stayed global where it is global (agent email slugs, push endpoints,
account emails). `app_settings` is now keyed `(accountId, key)`.

## 4. Plans and ceilings

`server/src/accounts/plans.ts`:

| plan | keys | agents | enabled loops | monthly ceiling |
|---|---|---|---|---|
| `free` | your own | 3 | 3 (across all agents) | — |
| `hosted` | platform keys (`PLATFORM_ANTHROPIC_KEY`, `PLATFORM_OPENAI_KEY`, `PLATFORM_GEMINI_KEY`, `PLATFORM_DEEPSEEK_KEY`); own keys still allowed | unlimited | unlimited | `HOSTED_PLAN_USD` (default 15) on platform-key dollars |
| `byo` | your own | unlimited | unlimited | — (workspace budget only) |

Enforced server-side, with the reason in the message:

- **402** `PlanLimitException` — a 4th agent or a 4th enabled loop on `free`
  (`AgentsService.create/update`); a turn whose agent type has no key on a
  plan without platform keys; a turn on a platform key once the month's
  hosted dollars reach the ceiling. The turn check runs in
  `TurnLoopService.run` **before the busy lock and before any row is
  written** (`TurnContextService.resolveKey`), for every origin — a hard stop
  like the workspace budget, not a warning. In the SSE stream it arrives as
  the `error` event's message.
- **403** — `/api/admin/*` for anyone not in `ADMIN_EMAILS`.

Usage is rolled up per `(accountId, month)` in `account_usage` as each turn
settles (`AccountsService.recordUsage`): tokens, dollars, and separately the
dollars spent on platform keys, which is what the ceiling compares against.
Platform-key dollars are priced from the **list** table only — a user's
`pricingOverrides` setting cannot lower what the ceiling sees. Own-key turns
are never metered against the ceiling. `GET /api/account` returns the plan,
limits, this month's usage and the providers the deployment has platform keys
for; the turn route sets `X-Yaam-Plan`, `X-Yaam-Usage-Usd`,
`X-Yaam-Hosted-Usd` and `X-Yaam-Ceiling-Usd` on the stream response.

**BYO keys live on the account's agent types.** The brief offered an
`account_keys` table or reusing `agent_types` now that it carries
`accountId`; we chose the latter: one key store, one sealing path
(`secretbox`), and `TurnContextService` resolves keys exactly as before.
`PUT /api/account/keys { provider, apiKey }` sets the key on every type of
that provider the account has (creating a default type when it has none), and
a new preset without a key inherits the account's existing key for its
provider. Hosted accounts that add their own key stop being metered for it.

## 5. Billing is out of scope — the seam is in

`BillingProvider` (`server/src/accounts/billing-provider.ts`) is bound as
`BILLING_PROVIDER`; the only implementation is `manual`: an admin changes a
plan with `PATCH /api/admin/accounts/:id { plan, status }` (Settings → Account
shows the switcher to admins). A Stripe or Paddle provider implements the same
interface — its webhook calls `AccountsService.setPlan`, `manageUrl` points at
the portal — and nothing else in the app needs to know which one is bound.
`docs/shared-accounts.md` §2–3 describes the identity-reconciliation lessons
the suite learned the hard way; the account here is keyed by its own id from
the first request, so there is no second namespace to reconcile.

## 6. Frontend

`src/auth.tsx` loads `/api/auth/me` once before the app store mounts
(`AuthGate` in `App.tsx`): accounts mode and not signed in → `SignIn.tsx`
(email → "check your inbox"); otherwise the app exactly as before. Settings →
Account (`AccountPane` in `SettingsView.tsx`): email, plan, this month against
the ceiling, the BYO keys form, sign-out, and the admin plan switcher. In
accounts mode non-admins no longer see the API-key field on agent-type
presets; the Account pane is the one place keys are entered. In single mode
the pane reads "Single-user mode" and nothing else changes.

## 7. Configuration

```
AUTH_MODE=single|accounts          ACCOUNTS_DEFAULT_PLAN=free|hosted|byo
ADMIN_EMAILS=a@x,b@y               AUTH_FROM_ADDRESS=login@<EMAIL_DOMAIN>
HOSTED_PLAN_USD=15                 PLATFORM_ANTHROPIC_KEY= PLATFORM_OPENAI_KEY= PLATFORM_GEMINI_KEY= PLATFORM_DEEPSEEK_KEY=
SUITE_ACCOUNTS_URL= SUITE_ACCOUNTS_SECRET=   (experimental; both or neither)
```

Validation (`config/validation.ts`): `AUTH_MODE=accounts` in production
requires `TOKEN_ENCRYPTION_KEY` (per-account keys are sealed with it);
`SUITE_ACCOUNTS_*` must be set together and imply accounts mode. Mail for the
links needs the email channel's `EMAIL_SEND_PROVIDER` / `EMAIL_SEND_TOKEN`.

## 8. What the suite front door will replace

When `shared-accounts.md` phase 3 ships, the accounts SPA owns sign-in, and
this app's part shrinks to `SuiteJwtStrategy` (with a real verifier) plus the
account row it creates on first sight. The magic-link routes, the session
table and the sign-in screen become the self-hosted fallback. Plans and
ceilings stay here: they are about this product's agents and this product's
model spend, which the suite has no view of.

## 9. Not done

- No OAuth (Google/GitHub) sign-in; the magic link is the only first-party
  method.
- The hosted ceiling is checked at turn start, not mid-turn: a single long
  turn can overshoot by its own cost.
- Object-storage keys are not yet prefixed per account (`deployment.md`
  layer 3); ids are random and every path goes through `cleanSegments`, so
  cross-account reads need a leaked id, but the prefix is still the right
  defence and is next.
- No Postgres row-level security (layer 2): the scoped handle is the fence.
- Rate limits for sign-in links are per process, not shared across
  instances.
