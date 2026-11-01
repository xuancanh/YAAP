# The market registry

Status: **shipped**, 1 November 2026 (execution-plan item 12, roadmap Phase
5.3). The curated agent packs and the Connectors directory stay what they
are; this document covers the third department of the Market — **Community**
— where anyone running yaam-chat can publish an agent, a skill or a mini app,
and anyone can install one behind the same capability review an AGENT.json
import already gets.

The design follows `docs/competitor-gap-analysis.md` §5 row 12: we cannot
out-build 6,000-connector and 1-million-skill ecosystems, so we do not try.
The registry rides the open formats we already speak (AGENT.json v2,
agentskills.io `SKILL.md`, the mini-app capability manifest), stays a thin
table plus one federation URL, and spends its effort on the one thing the
large ecosystems get wrong: **nothing installs unreviewed, and nothing
installs live.**

## 1. The model

Three tables, migration `0025-registry` (`server/src/database/migrator.ts`,
mirrored in `schema.ts`). All three carry `accountId TEXT NOT NULL DEFAULT
'single'` from day one so the tenancy work (item 7) finds nothing to backfill.

| Table | What a row is |
|---|---|
| `registry_items` | One listing: `kind` (`agent` · `skill` · `app` · `company`, §8), `slug`, `name`, `description`, `version`, `publisherName`, `manifest` (the portable artifact, JSON), `capabilities` (the static review summary, JSON), `scanReport` (the item-9 scan that ran at publish, JSON), `installs`, `ratingUp`/`ratingDown`, `published`, `source` (`local` · `remote`), `remoteUrl`, `sourceRef` (the agent/skill/app it was published from). Unique on (`accountId`, `kind`, `slug`). |
| `registry_installs` | One install: `itemId` (a local id, or `remote:<id>` for an item pulled from `REGISTRY_URL`), `version`, and the `agentId` / `skillId` / `appId` it created locally. |
| `registry_ratings` | One rating: `itemId`, `installId`, `turnId` (set when rolled up from a turn rating, `''` when explicit), `rating`, `note`. Unique on (`installId`, `turnId`) so a re-rated turn updates instead of doubling. |

What a manifest is, per kind:

- **agent** — AGENT.json v2 **without** `lessons`, `tasks` or `profile`.
  Those are the user's history, not the agent's design, and
  `normalizeManifest` drops them whatever the input says. What remains:
  identity (`name`, `emoji`, `colors`, `role`), `charter`, `provider`/`model`
  hints, `loops` (every one forced to `enabled: false`), `dashboard`, `apps`
  (with their capability manifests) and agent-private `skills`.
- **skill** — `{ skillMd }`: the skill rendered as a spec-conformant
  `SKILL.md` (`portability/skill-md.ts` `renderSkillMd`). Drafts cannot be
  published; approve first.
- **app** — `{ name, description, html, capabilities }`: the mini app as
  `save_app` produced it.

Remote items are never written to `registry_items`. They live in a 10-minute
in-memory cache (`RegistryService.remote`) and are addressed as
`remote:<id>`; an install of one records the `registry_installs` row with
that id, so ratings on it still have somewhere to attach.

## 2. Publishing

`POST /api/registry/publish` with `{ kind, agentId | skillId | agentId+appId,
name?, description?, publisherName?, dryRun? }` (`RegistryController`).

1. The source object is exported: `PortabilityService.exportAgent` for an
   agent (no profile — it is opt-in there and never requested here),
   `renderSkillMd` for a skill, the stored app for an app.
2. `normalizeManifest(kind, raw)` (`registry.service.ts`) validates and
   bounds every field, strips what must not travel, forces loops off, and
   runs **the scan**:
   - text — the charter, each loop prompt and each skill body go through
     `scanSkillMd` from item 9 (size, URLs, instruction smells, secret
     mentions, base64 blobs, invisible unicode);
   - HTML — each mini app goes through `registry/app-scan.ts`
     `scanAppHtml`: external URLs, `fetch(` / `XMLHttpRequest` / `WebSocket`
     / `EventSource` / `sendBeacon` / dynamic `import()` of a remote module,
     external `<script src>` / `<link href>` / `<iframe>` / cross-origin
     `<form action>` / remote media, `window.top`/`parent` and navigation
     calls, requested capabilities split into free and elevated, unknown
     capability names, base64 blobs, invisible unicode. A mini app runs in
     a CSP-sealed, network-denied iframe (`docs/security.md` §c), so a
     `fetch(` cannot succeed — which is exactly why it belongs on the card:
     code written to call home is code someone meant to call home.
   Flags are merged with a `charter:` / `loop "x":` / `skill "x":` /
   `app "x":` prefix so the reader knows where each one lives.
3. A **blocking** flag (oversize, invisible unicode, empty body, unknown
   capability) refuses the publish with the flags in the error. Warnings
   travel with the item.
4. The capability summary is computed statically: tool names the text
   mentions (`TOOL_RE` over our vocabulary), connections those imply
   (`calendar` · `mail` · `drive`), loops with their cron or trigger kind,
   bundled skills, apps with their capabilities.
5. `dryRun: true` returns `{ slug, name, description, capabilities,
   scanReport }` and writes nothing. The Publish form calls this first and
   shows the result; the user sees what installers will see before anything
   is listed.
6. Otherwise the item is upserted on (`kind`, `slug`): a new slug inserts
   `version 1`; an existing one bumps `version`, replaces manifest, summary
   and scan, and **keeps `installs` and ratings** — a re-publish is the same
   thing, improved.
7. With `REGISTRY_URL` and `REGISTRY_PUBLISH_TOKEN` both set, the item is
   also pushed to `<REGISTRY_URL>/api/registry/public` with the token as
   bearer (`pushToRemote`, through `fetchPublic`). The response reports
   `pushed: { attempted, ok, error? }`; a failed push never fails the local
   publish.

Publish buttons live where the thing lives (`docs/permissions.md` §4.1): on
the agent home header beside Export, on each live skill row (Settings →
Skills and the agent's Skills & tools tab; built-ins excluded), and on each
mini-app card. The form (`src/components/RegistryBits.tsx` `PublishModal`)
asks for name, description and a publisher display name (remembered per
browser under `yaam_publisher_name`), runs the dry run on **Scan**, and only
then offers **Publish**.

## 3. The review gate

`POST /api/registry/:id/install` is a two-step call, and the server enforces
the order:

- **Without `confirm: true`** the response is
  `{ requiresConfirm: true, review }` and nothing is written. `review`
  carries: `kind`, `name`, `version`, `publisherName`, `source`; the
  `capabilities` summary, `loops`, `tools`, `connections`; the
  `scanReport`; and the real artifacts — `charter` (agents), `skillBodies`
  with full instructions (agents and skills), `appHtml` (apps) — plus
  `installs`, plain-language lines saying what will be created. Approving a
  paraphrase is not approving (`docs/permissions.md` §4.2), so the card
  shows the text.
- **With `confirm: true`** (the boolean; `"yes"` is not confirmation) the
  manifest is normalized **and scanned again**. A blocking flag refuses even
  a confirmed install. Then it imports, and what it imports is inert:

| Kind | Lands as | Activation gate |
|---|---|---|
| agent | a new agent via `PortabilityService.importAgent(…, { lessons: false, tasks: false, profile: false })`; every loop `enabled: false`; bundled skills as **drafts**; mini apps with elevated capabilities **parked** (`AgentsService.importJson` now carries `capabilities` through `saveApp`) | enable each loop on the Schedule tab; approve each skill; review each app's capabilities |
| skill | `SkillsService.importSkillMd` → a **draft**, `proposedBy: "registry: <publisher>"`, workspace-shared or private to a chosen agent | Approve on the Skills page |
| app | `AgentsService.saveApp` on the chosen agent: free capabilities (`storage`, `chat.compose`) granted, the rest parked | the app card's capability review |

A name clash on an agent install resolves to `Name (2)`, `Name (3)`…, or the
caller passes `options.name`. The install row is written, the item's
`installs` bumps (locally) or the remote is told (`POST
…/public/:id/installed`, best-effort).

The UI (`RegistryReviewModal`) is the hire modal's review extended: what
installs, the tools and implied connections ("nothing is granted by
installing"), loops with a green "install disabled" line instead of the
hire modal's amber "enable immediately", the charter and every skill body
behind **Read text**, the app source behind **Read source**, the scan
report (labelled "run here, just now" for remote items), and the install
options (target agent for apps, scope for skills, name for agents).

## 4. Browse, ratings, the public feed

- `GET /api/registry?kind=&q=` returns `{ items, remote }`: local published
  items plus the cached remote feed, each with `installed` (this instance
  has an install row), filtered by kind and a substring over name,
  description, publisher and slug. A remote copy of a slug we published
  ourselves is hidden in favour of ours.
- `GET /api/registry/:id` adds the `manifest`. `GET /api/registry/status`
  reports the remote URL, whether a publish token is set, and the cache
  state (Settings → Market).
- **Ratings are the feedback we already collect.** `ChatsService.rateTurn`
  — the same path that records skill outcomes (item 10) — calls
  `RegistryService.recordTurnRating` with the session's agent and the turn's
  `skillsUsed`; every install row for that agent or those skills gets one
  rating per (install, turn), re-rating replaces, and `ratingUp`/`ratingDown`
  on the item follow. Apps have no turns, so `POST /api/registry/:id/rate
  { rating, note? }` records an explicit rating against the latest install
  of that item (one per item from this instance; a second replaces the
  first). There is no star widget.
- **The public feed** — `GET /api/registry/public` and
  `GET /api/registry/public/:id` — is left open by `TokenAuthStrategy`, like
  `/api/status` and `/api/security`. It serves local items with
  `published = 1` as a projection (no manifest in the list; the manifest on
  the item endpoint), and by construction a manifest never carries lessons,
  tasks, a profile, webhook secrets (`exportJson` strips them) or anything
  about the publisher beyond the display name they typed.
  `tests/backend-registry.test.ts` pins the projection's key list and greps
  the item body for the planted lesson and task text.

## 5. Remote federation

One setting: `REGISTRY_URL` (default empty). A self-hosted instance points it
at the hosted registry; the hosted registry is just another yaam-chat
serving the same `/api/registry/public`.

- The listing fetches `<REGISTRY_URL>/api/registry/public` through
  `fetchPublic` (`common/url-guard.ts`), so the SSRF guard applies: a
  private or link-local `REGISTRY_URL` (`127.0.0.1`, `169.254.169.254`,
  `localhost`) never produces a request, and the listing reports
  `remote.error` while local items still show. Results are cached for ten
  minutes; a failed fetch is cached too, so a dead remote costs one attempt
  per ten minutes, not one per page view. Every field of every remote row
  is re-validated (`fromRemote`): unknown kinds and malformed ids are
  dropped, strings are bounded, loops are forced to `enabled: false`.
- Installing `remote:<id>` fetches `…/public/<id>`, takes the manifest and
  runs **the local** `normalizeManifest` — the remote's `scanReport` is
  carried for display but ours is what gates. The test plants a URL the
  remote's report omits and asserts the local review finds it.
- Publishing pushes when `REGISTRY_PUBLISH_TOKEN` is set (§2). On the
  receiving side, `POST /api/registry/public` is public at the auth layer
  but `RegistryService.acceptRemotePublish` requires the bearer to equal
  the instance's own `REGISTRY_PUBLISH_TOKEN` (timing-safe compare; no token
  configured → refused outright). The pushed manifest goes through the same
  normalize + scan as a local publish: the token proves the sender may list
  here, not that the content is clean.
- `POST /api/registry/public/:id/installed` and `…/rate` are anonymous
  counter bumps so a remote install or rating is reflected upstream. They
  count; they read and write nothing else.

## 6. What we deliberately do not build

- **Payments.** Publishing is free, installing is free, there is no price
  field. The gap analysis is explicit that a small product does not win a
  marketplace on volume, and a paid one adds a tax authority, refunds and
  fraud to a table with three columns of trust.
- **Unreviewed installs.** No one-click install, no "trust this publisher",
  no auto-update. A new version is a new review.
- **Trusting a remote scan.** The remote's report is shown for comparison;
  the local one decides.
- **Publisher accounts or identity.** `publisherName` is a display string.
  When tenancy lands (item 7), `accountId` is already on every row.
- **Curation or ranking.** Items list newest first; installs and ratings are
  shown, not used to sort. A registry that ranks by installs rewards
  install farming.
- **Executable bundles.** Skills are single `SKILL.md` texts (item 9's
  limit), apps are single HTML files; no scripts, no archives.

## 8. Companies (item 24)

A **company blueprint** (`docs/blueprints.md`, `COMPANY.json` v1) is the
fourth kind, `company`. It follows every rule above and adds none of its own
exceptions:

- **Manifest**: the validated blueprint (`validateBlueprint` — ≤ 256 KB, ≤
  20 roles, depth ≤ 3, fan-out ≤ 5, unknown fields refused). By construction
  it carries no messages, tasks, lessons, files, connections, grants, tokens
  or ids; the only text content is role charters and playbooks as `SKILL.md`.
- **Publish**: `POST /api/market/companies { workspaceId, name?,
  description?, publisherName?, dryRun? }` exports the workspace's company
  and runs the same `normalizeManifest` → scan path (each role charter and
  each playbook through `scanSkillMd`, flags prefixed `role "x":` /
  `playbook "x":`); a blocking flag refuses. The capability summary gains
  `company { roles, depth, monthlyUsd, playbooks, cadences, tunables, cards
  }`; tools and connections come from the scopes and the texts. Re-publish
  bumps the version like any kind; the push to `REGISTRY_URL` and
  `acceptRemotePublish` accept the kind unchanged.
- **Browse**: `GET /api/market/companies?q=` (or `GET
  /api/registry?kind=company`) — local and remote items, each with
  `outcomes { first_key_result, thirty_days_in_envelope }` counts.
- **Review and install**: `POST /api/market/companies/:id/install {
  workspaceId, mode, monthlyUsd?, confirm? }`. Without `confirm: true`:
  `{ requiresConfirm, review, plan }` — the review (the blueprint with every
  charter, `skillBodies` = the playbooks, the scan report, plain-language
  `installs` lines) plus the dry-run **import plan** for that workspace;
  nothing is written. With `confirm: true`: re-validated, re-scanned locally
  (a remote's report is shown, never trusted), imported through
  `OrgBlueprintsService.import`, and the install row written with the
  created `orgId`. The generic `POST /api/registry/:id/install` refuses a
  company and names this route. What installs is inert in the registry's
  sense: agents with a charter and met scopes, playbooks as drafts, a vision
  and profile, tunables within bounds — and, in supervised mode, no agent at
  all until the CEO approves the one `blueprint` card.
- **Outcomes instead of stars**: `registry_outcomes` rows (`kind`
  `first_key_result` | `thirty_days_in_envelope`) are written by the
  importing instance's `sweepOutcomes` only when its `shareBlueprintOutcomes`
  setting is on — locally for a local item, through the anonymous public
  `POST /api/registry/public/:id/outcome { kind }` for a remote one. Turn
  ratings do not apply to companies (there is no turn to rate).

## 7. Files

`server/src/registry/` (`registry.service.ts`, `registry.controller.ts`,
`registry.module.ts`, `app-scan.ts`), migration `0025-registry` (and
`0036-org-blueprints` for `registry_installs.orgId` and `registry_outcomes`),
`server/src/org/blueprints/companies.controller.ts` for `/api/market/companies`, config
`registryUrl` / `registryPublishToken` (`REGISTRY_URL`,
`REGISTRY_PUBLISH_TOKEN`), the public-route additions in
`common/token-auth.strategy.ts`, the `recordTurnRating` hook in
`chats/chats.service.ts`, `capabilities` carried through
`AgentsService.importJson`; `src/lib/registry.ts` (pure helpers),
`src/components/RegistryBits.tsx` (Publish form, review modal), the
Community department in `MarketView.tsx`, Settings → Market and Settings →
Security in `SettingsView.tsx`; `tests/backend-registry.test.ts`,
`web-tests/registry.test.ts`.
