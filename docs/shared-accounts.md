# Shared accounts across the product suite: one domain package, one front door, no new microservice

Status: **phases 0 and 1 shipped** in `knowledge-loom-ee` (commit `81d6723`);
phases 2–5 remain planned. One design claim in §5 was wrong and is corrected
below where it appears. Spans five repos (`smart-knowledge-app`,
`grove-server`, `knowledge-loom-ee`, `knowledge-loom-landing`,
`knowledge-loom-admin`) plus `yaam-chat`. The question asked was whether
account management, payment, and other shared functions should be refactored
into a separate application. The short answer is: **a separate shared
*package* and a separate *front door*, but not a separate auth service** —
and before any of that, there is an identity bug that is quietly selling
people plans they do not receive.

## 1. What is already built, and it is more than it looks

The composition pattern this question is reaching for mostly exists.

**`smart-knowledge-app` → `@knowledge-loom/server`** is the OSS core: NestJS +
Drizzle + Postgres + React. It already has the right seams:

- `AuthModule` selects an `AuthStrategy` behind the `AUTH_STRATEGY` DI token —
  `LocalAuthStrategy` by default, Supabase when configured. Consumers call
  `AuthModule.forRoot(StrategyClass)` to bind their own.
- `ApiAuthGuard` + `@CurrentUser()` + `@CurrentScope()` give every downstream
  module an identity without knowing where it came from.
- `startApp({ extensions, usageService, authStrategy })` is a real composition
  entry point, not a bootstrap copied per app.
- The frontend has the same seam: an extension registry with an
  `ExtAuthAdapter` (`useAuth`, `getAccessToken`), so the OSS build renders no
  login routes and adds no `Authorization` header, and an extended build
  supplies both.

**`grove-server` → `@grove/server`** is the model citizen and the proof the
pattern works. It peer-depends on the core, owns `grove_*` tables, reads its
own env, and gets auth, quotas, and HTTP bootstrap entirely from the host. Its
module header states the rule plainly: "Everything shared comes from the host."
A second product was added without a second auth system.

**`knowledge-loom-ee`** is the deployable composition: core + Grove + private
`extensions/` (auth, admin, usage, billing). `main.ts` is 30 lines of wiring.
Its `EeDb` is dialect-aware and puts `ee_`-prefixed tables in the *same*
Postgres the app uses in cloud deployments, so there is no data split to undo.

So the architecture question is largely answered already. What is missing is
narrower and more specific than "we need an accounts app".

## 2. The bug to fix before restructuring anything

**There are two identity namespaces and nothing reconciles them.**

Authenticated requests carry a Supabase JWT, and `SupabaseAuthStrategy`
returns the `sub` claim — a UUID. That is the user id every product writes
against. But two other code paths mint a *different* kind of id from an email
string:

- `POST /api/billing/signup` is public, unauthenticated, and does
  `upsert({ userId: 'em:' + email, plan: 'thread', … })` after validating
  nothing but the shape of the address.
- `applyCheckoutSession` (the Stripe webhook) resolves the account as
  `meta.accountId || 'em:' + session.customer_details.email`.

Nothing ever links `em:alice@example.com` to the UUID Supabase issues Alice.
The concrete failure: Alice signs up on the landing page, pays through
checkout where the session metadata is missing or stale, then logs into the
app — and `effectivePlan(userId)` reads her UUID row, which says free tier,
while her paid subscription sits on the email row. She paid and did not
receive it, and no error is raised anywhere.

The second problem with `em:` is that it is **unverified**. Anyone can POST any
email to `/api/billing/signup` and create an account record for it. Today that
record is only a free-tier row, so the blast radius is small — but it is a row
in the table that decides entitlements, keyed by a string an attacker chooses.

This is a correctness bug, not an architecture preference, and it should be
fixed first — independently of everything below, because every phase after
this assumes one account has one id.

## 3. The other gaps

**There is no account.** "Account" is currently spread across Supabase
(identity), `ee_subscriptions` (plan, seats, MRR, name, email, org), the audit
log, and usage counters — with no table that simply *is* the account. That is
why the `em:` fallback exists at all: there was nowhere to put a person who
had not logged in yet. It also means identity is structurally welded to
Supabase, and any second IdP (or self-hosted EE without Supabase) has nowhere
to attach.

**Registration lives in the billing controller.** `POST /api/billing/signup`
is a billing route by accident of history. A second product that needs signup
but not Stripe has to import billing to get it.

**The login page is a mockup.** `knowledge-loom-landing/login.html` has
"Continue with Google" and "Continue with GitHub" as `type="button"` with no
handlers, a form with no submit logic, and `href="#"` for password reset. Real
authentication only happens inside the app shell via the private extension. The
product's front door is not connected to its auth system.

**Admin is a shared static token.** The console gates on an `ADMIN_TOKEN`
typed into a browser modal. There is no per-staff identity, so audit entries
attribute to a literal string (`'System'` in the signup path), and revoking one
person's access means rotating everyone's.

**Distribution is tarball vendoring.** `file:vendor/knowledge-loom-server.tgz`
plus `update-core.sh` / `update-grove.sh`. It works, but "which version of the
core is production running" is answered by a file timestamp, and a breaking
change in the core is discovered at build time in EE rather than at version-
bump time.

**`yaam-chat` is not in the family at all.** It has no user model: every table
is workspace-scoped with no `userId` column, and its entire auth is one
optional shared bearer token (`YAAM_API_TOKEN`) whose own header describes it
as "a pragmatic trust boundary for a single-user self-hosted app". Joining the
suite is not a guard swap; it is a data migration touching every table.

## 4. The recommendation, and the case against a separate auth service

**Do not build a standalone auth microservice.** The suite deploys today as
one container behind a Cloudflare Worker. A separate auth service would add a
network hop on the request path, a second deploy target, token-exchange
plumbing, and a distributed failure mode — to solve a problem that is not
actually distribution. Nothing here is straining a shared process.

**Do extract a shared domain package.** What is missing is not a service but
an *owner*: one place that knows what an account is, which identities map to
it, and what it is entitled to. That is a library, and the suite already has a
proven vehicle for libraries — the peer-dependency extension pattern that
`@grove/server` uses.

**Do build one shared front door.** This is the part that genuinely deserves
its own deployable, and it is the UI, not the API. Login, signup, password
reset, OAuth callbacks, checkout, and account/billing settings are today
spread across a mockup landing page, the app shell, and a token-gated admin
console. One `accounts.<domain>` surface that every product redirects to is
cheaper to build than a microservice and fixes the actual user-visible mess.

So: **one package for the domain, one front door for the UX, the IdP stays
Supabase, and no new service on the request path.**

## 5. The plan

### Phase 0 — Reconcile identity *(done)*
Introduce a canonical account id and stop minting `em:` rows as if they were
accounts. Concretely: keep the pre-signup record, but mark it **pending** and
unverified; on first authenticated request, link the verified email from the
JWT to the pending record and migrate its entitlements onto the real account,
once, idempotently. In the Stripe webhook, treat a missing `metadata.accountId`
as an **incident to log and quarantine**, not a cue to invent an identity from
`customer_details.email`. Backfill existing `em:` rows by verified email match.

This is a few days and it stops the silent under-delivery of paid plans.

### Phase 1 — the account domain *(done, in-repo rather than as a package)*

*(shipped as: `server/src/extensions/accounts/` inside `knowledge-loom-ee`,
not a separate `@loom/accounts` package. Every consumer today — billing,
usage, admin — lives in that one repo, so publishing it would have added a
release cycle without a second consumer to justify it. Extraction stays easy:
the service takes only a `ConfigService` and talks to `EeDb`.)*

The account domain, mounted like any other extension:

- `accounts` — id, primary email, name, status, createdAt
- `account_identities` — (provider, subject) → accountId, so Supabase is *an*
  identity provider rather than *the* identity, and local/self-hosted EE or a
  second IdP attach without a schema change
- `entitlements` — plan, seats, status, source, valid-through, per account
- `AccountsService` for other modules to inject; `AccountsModule` to mount

**Correction — the guard must not do this.** The plan said the guard should
resolve subject → accountId and `@CurrentUser()` should start meaning
"account". Reading the core disproved it: `ApiAuthGuard` puts the strategy's
return value on `request.userId`, and that value **is the data-partition key**
for every note, space, and Grove row (`scopeFor(userId, spaceId)`). Remapping
it would orphan all application data behind a migration across every table in
two products.

So the split is: **the subject stays the data-scope key; the account owns only
entitlements and billing.** Different questions, different keys. Callers that
need entitlements resolve `subject → account` at that boundary — one extra
indexed lookup, cached on the quota path. This also means the core needed no
change at all, which is why phase 1 landed without touching
`smart-knowledge-app`.

Two ordering hazards, both found while building and both covered by tests:
a quota check only ever sees the subject, so it can link an identity *before*
the first request carrying a verified email — a later verified email must
still be able to claim the pending account. And signups must stay visible to
staff: the admin customers view became account-centric rather than
subscription-only, since a pending account has no subscription row.

### Phase 2 — Billing onto accounts *(partly done)*

*(done already: the Stripe webhook no longer invents an identity from
`customer_details.email` — it resolves by session metadata, then by linked
Stripe customer, and otherwise logs and quarantines the session. `signup`
moved out of billing into accounts. Still to do: keying Stripe customers on
accounts from the start, and moving `plans.ts` into the shared domain.)*
Stripe customers and subscriptions key on `accountId`, never on an email
string. Webhooks resolve by `stripe_customer_id → account_identities` with
metadata as a cross-check. `signup` moves out of the billing controller into
accounts, where it belongs, so a product can offer registration without
importing Stripe. The plan catalog (`plans.ts`) is the natural shared constant
and moves with it — it is already described as the single source of truth and
is currently duplicated by hand into the pricing page.

### Phase 3 — One front door
An `accounts` SPA owning login, signup, reset, OAuth callback, checkout, and
billing settings. Products redirect to it and receive a session. The landing
site keeps marketing and links out; its mockup auth pages are deleted rather
than left to imply a login that does not work. Admin moves to per-staff
accounts with a role on the account record, so audit attributes to a person
and revocation is per person.

One thing to decide early here: **cross-subdomain sessions**. A Supabase
session in `localStorage` on `app.<domain>` is invisible to `grove.<domain>`.
Either issue a cookie on the parent domain, or have the front door mint
per-app tokens on redirect. Pick before building, because retrofitting session
scope is painful.

### Phase 4 — Products as consumers
The core stays the core; Grove already conforms and needs nothing. Each
product declares the entitlements it requires, and the existing
`USAGE_SERVICE` quota seam reads from `@loom/accounts` instead of
`ee_subscriptions`. This is mostly deletion.

### Phase 5 — `yaam-chat`, deliberately last
Two honest options:

**(a) Leave it out.** It is positioned as single-user, self-hosted, run
locally. Nothing about it currently wants tenancy, and forcing it in buys
nothing today.

**(b) Multi-tenant it:** add `accountId` to every table, adopt `AuthStrategy`,
mount as an extension.

Recommended: **(a) now, with the seam pre-built** — adopt the `AuthStrategy`
interface and the `@CurrentUser()` shape so the boundary exists and the guard
is swappable, but defer the data migration until there is a product reason to
pay for it. Cheap insurance; the expensive part stays optional.

### Alongside — fix distribution
Replace `file:vendor/*.tgz` with a private registry (GitHub Packages) and real
semver for `@knowledge-loom/server`, `@grove/server`, `@loom/accounts`. Keep
the repos separate: the OSS/EE split is a licensing boundary, not just a code
one, and a monorepo would blur it. Versioned packages turn "which core is
production running" from a file timestamp into a lockfile entry, and turn a
breaking core change into a version bump instead of a surprise at EE build
time.

## 6. What we deliberately do not do

A standalone auth microservice on the request path. Replacing Supabase — it is
a fine IdP, and Phase 1 exists precisely so it stops being load-bearing for
*identity modeling*. Merging the OSS and EE repos. SSO/SAML, org hierarchies,
or seat-level RBAC before a customer asks. Migrating `yaam-chat`'s data model
on speculation.

## 7. Sequencing

Phase 0 stands alone and should go first regardless of whether the rest is
approved — it is a live correctness bug. Phase 1 unblocks 2, 3, and 4. Phase 3
can start in parallel with 2 once the account model in 1 is settled. Phase 5 is
independent and optional. The distribution fix can happen at any point and
makes every phase after it easier to land safely.

A reasonable first cut is **Phase 0 + Phase 1**: stop losing paid plans, then
give the suite an account to hang everything else on.

## 8. What shipped, and what it cost

Phases 0 and 1 are one commit in `knowledge-loom-ee`: `ee_accounts` +
`ee_account_identities`, an `AccountsService` that resolves and reconciles,
signup creating a pending account instead of an entitlement row, quotas and
the subscription endpoint reading the account, the Stripe webhook quarantining
what it cannot attribute, and the admin console showing accounts rather than
only subscriptions. 35 tests pass, 8 of them new and all on the reconciliation
paths — including the merge that prefers a paid row over a free one, which is
the exact failure that started this.

No change to `smart-knowledge-app` or `grove-server` was needed, which is the
strongest evidence that the seams they already had were the right ones.

## 9. Where this lives in code

- `smart-knowledge-app/server/src/auth/` — `AuthStrategy`, `ApiAuthGuard`,
  `AuthModule.forRoot`; the seam every product already uses
- `smart-knowledge-app/src/lib/extensions.ts` — the frontend auth adapter seam
- `grove-server/src/grove.module.ts` — the reference consumer
- `knowledge-loom-ee/server/src/main.ts` — the composition root
- `knowledge-loom-ee/server/src/extensions/accounts/accounts.service.ts` —
  the account domain, resolution, and subscription reconciliation
- `knowledge-loom-ee/server/src/extensions/billing/` — `signup` now creates a
  pending account; `plans.ts` moves in Phase 2
- `knowledge-loom-ee/server/src/extensions/auth/supabase-auth.strategy.ts` —
  becomes one identity provider among several
- `knowledge-loom-ee/server/src/extensions/db/ee-db.ts` — where the accounts
  tables land
- `knowledge-loom-landing/{login,signup,checkout}.html` — the mockup front door
- `knowledge-loom-admin/admin.html` — the shared-token staff gate
- `yaam-chat/server/src/common/auth.guard.ts` — the single-token guard that
  would become an `AuthStrategy`
