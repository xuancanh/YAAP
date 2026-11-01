# Execution plan: closing the competitor gaps, all of them

Status: **items 1–21 and 23 done** — shipped between 31 October and 1 November 2026; see each item's "Shipped as" line.
`docs/competitor-gap-analysis.md` §5. The owner's decision: execute every
item, deprioritise none, and add desktop computer control (previously on the
"do not build" list) as a must. Payments, phone calls and WhatsApp stay out.
A second thread — autonomous companies of agents — has its own research and
design (`docs/autonomous-company.md`, pending) and is item 14 here.

Each item below ships as one or more commits on `main`, with tests in
`tests/` (node:test over PGlite) and, where the UI changes, `web-tests/`.
Items are sequenced so that each one's prerequisites are already on `main`.
Status markers are updated as work lands.

## Conventions every item follows

- Migrations are idempotent `ALTER TABLE … ADD COLUMN IF NOT EXISTS` /
  `CREATE TABLE IF NOT EXISTS` statements in `server/src/database/migrator.ts`,
  mirrored in `schema.ts`.
- Config comes from `server/src/config/configuration.ts` with a zod check in
  `validation.ts` and a commented line in `.env.example`.
- New tools register in `turn-loop.service.ts` (agent tools) or an owning
  service with `owns()/isReadOnly()/execute()` like `ConnectionsService` and
  `RunnerService`; mutating tools are Ask-gated and never auto-run from
  channel-originated turns.
- Everything proactive writes an `agent_events` row. Nothing unattended is
  silent.
- The frontend talks only to `src/lib/api.ts`; new state lives in
  `src/store.tsx`; views live under `src/components/`.
- Docs: each item updates the doc that owns the area and the README
  "Current state" paragraph.

## The items

### 1. Finish Phase 2 — proactivity controls *(done)*
Shipped as: migrations `0016`–`0019` (`workspaces.quietHours`,
`spendBudgetTokens`/`spendMonth`/`spendTokens`; `agent_events.deliverAfter`,
`silent`, `origin`, `channel`, `deliveredAt`), `workspaces/quiet-hours.ts` +
`spend.util.ts`, the `budget` SSE notice and `budget_stop` events in
`turn-loop.service.ts`/`loops.service.ts`, `ai/pricing.ts` + `usage/
usage.module.ts` (`GET /api/agents|workspaces/:id/usage`, `/api/usage/
pricing`, `pricingOverrides` setting), the `TelegramService.deliverSweep`
minute sweep with `PUBLIC_APP_URL` deep links, and Settings → Workspace /
Usage plus the agent-home usage chart. Tests: `backend-quiet-hours`,
`backend-usage`, and the extended `backend-loops` / `backend-telegram`
suites.

Quiet hours and interrupt policy per workspace (`quietHours` JSON: start,
end, timezone, policy `queue|silent|allow-urgent`); loops that fire inside
quiet hours still run but their notifications queue until the window ends.
Workspace-level hard spend stop: `spendBudgetTokens` per month with a running
`spendMonth`/`spendTokens` counter; when exceeded, loop runs are refused with
a `budget_stop` event and the chat header shows the stop. Cost in dollars:
a per-model price table (`server/src/ai/pricing.ts`, overridable via
settings) turns tokensIn/tokensOut into USD on the agent home (per agent, per
loop, per day for 30 days) and in Settings → Usage. Telegram becomes
two-way: unread inbox events for the default agent are delivered to the
paired chat (respecting quiet hours), each with a link back to the session.

### 2. Independent action review *(done)*
`ActionReviewService`: for every mutating tool call in Auto mode, and for
remembered approvals in Ask mode, a second model call (cheap model, no
tools, outside the turn) receives the user's original request, the
conversation summary and the proposed call, and returns
`allow | ask | deny` with a reason, plus a sensitive-information check
(credentials, payment data, third-party personal data) that forces `ask`.
Deterministic gates stay the floor: confirm-always tools still confirm. The
reviewer's verdict and reason are recorded on the tool call and surfaced in
the tool card. Off switch and model override in Settings.
Shipped as: `server/src/review/` (`ActionReviewService`, `review-prompt.ts`),
the hook in `turn-loop.service.ts` after `checkPolicy`, `review` on tool
records and SSE events, the "Reviewed ·" line in `ChatView.tsx`, settings
`actionReview`/`reviewModel` (Settings → Permissions), `docs/permissions.md`
§6, `tests/backend-action-review.test.ts`. Loop and channel turns turn `ask`
into `deny` plus an inbox event.

### 3. Threat model *(done)*
`docs/security.md`: isolation model, trust tiers, approval taxonomy,
injection posture (what channel/app/MCP content can and cannot do), what we
never do, disclosure address, scope. `SECURITY.md` at the repo root points
to it. Settings → Security renders the same content from the API so the
hosted product shows it too.
Shipped as: `docs/security.md` §a–k, `SECURITY.md`, `GET /api/security`
(`server/src/security/`, public like `/api/status`, `SECURITY_CONTACT` env)
and `tests/backend-security.test.ts`; the Settings → Security pane
(`SecurityPane` in `SettingsView.tsx`, registered in `Rails.tsx`) renders
the contact, the summary bullets and the policy link, with a "Report a
vulnerability" mailto when `SECURITY_CONTACT` is set — wired with item 12.

### 4. Browser tool *(done)*
`browser_open`, `browser_act` (click/type/scroll/select by text), `browser_read`
(readable text + links), `browser_screenshot`. Two backends behind one
interface, like the code runner: Cloudflare Browser Rendering (hosted) and
local Playwright (`playwright-core`, optional). Credential-free: no cookie
jar persists across sessions, no password fields are filled, egress through
the SSRF guard. Viewable: every step's screenshot streams to the artifact
panel as a live "Browser" tab, and the session ends with the turn.
Shipped as: `server/src/browser/` (`BrowserService` with `owns()/
isReadOnly()/execute()/endTurn()`, `browser-backend.interface.ts`,
`cloudflare-browser.backend.ts` over the REST Quick Actions `/snapshot` +
`/scrape`, `playwright-browser.backend.ts` with a dynamic `playwright-core`
import and `context.route` egress wall, `page-model.ts`), config
`BROWSER_BACKEND=auto|cloudflare|playwright|off`, `BROWSER_CF_ACCOUNT_ID`,
`BROWSER_CF_TOKEN`, `BROWSER_CHROMIUM_PATH`, `GET /api/browser/status`, the
`browser` TurnEvent + `toolCalls[i].browser` record, the Browser tab in
`ArtifactPanel.tsx` (live screenshot, URL/title, step strip, rebuilt from
the transcript), the Browser section of Settings → Code runner & browser,
`docs/browser-tool.md`, security.md §c–e, and
`tests/backend-browser.test.ts`. Not done: credential-by-reference sign-in
and live DOM actions on the hosted backend (links + GET forms only there).

### 5. Email channel, web push, PWA *(done)*
Shipped as: migrations `0020`–`0021` (`agents.emailSlug` with a unique
partial index, `agent_events.emailDeliveredAt`/`pushDeliveredAt`,
`push_subscriptions`), `channels/email.service.ts` + `email-sender.ts`
(Cloudflare Email Sending and Resend REST senders behind one `EmailSender`,
`POST /api/channels/email/inbound` as a public HMAC-verified route,
`status`/`pair-code`/`unpair`, `deliverSweep` with `emailDigest` =
`immediate|daily|off`), `cloudflare/email-worker/` (Email Routing →
postal-mime → signed JSON), `push/` (`web-push.ts` VAPID ES256 + RFC 8291
aes128gcm on node:crypto — no dependency; `PushService` sweep; `GET
/api/push/vapid-public-key`, `POST|DELETE /api/push/subscribe`), `npm run
push:keys`, `public/sw.js` + `manifest.webmanifest` + icons, `src/lib/
push.ts`, the Email and "Notifications on this device" cards in Settings →
Channels, `AgentsService.undeliveredEvents/markEventsDelivered(…, channel)`,
`docs/channels.md`, and `tests/backend-email` / `backend-push`.

Each agent gets an inbound address (`<slug>@<EMAIL_DOMAIN>`); inbound mail
arrives via a signed webhook (Cloudflare Email Worker in `cloudflare/`, or any
JSON forwarder) and becomes an Ask-mode turn in `Email · <agent>`; replies
go out via a configurable sending API. Unknown senders get a pairing reply.
Web push with VAPID keys, a service worker, and `manifest.webmanifest` so
the UI installs; inbox events push to subscribed devices respecting quiet
hours.

### 6. Event triggers *(done)*
Loops gain `trigger` alongside `cron`: `mail` (new message matching a
query on a granted connection), `calendar` (event created/changed in the next
N hours), `task` (task assigned to this agent), `webhook` (signed URL). A
poller per connection type runs with the loop tick; webhook posts fire
immediately. Trigger payload is injected into the loop prompt as untrusted
content.
Shipped as: `server/src/chats/loop-def.ts` (shared `LoopDef` + validation,
`cron` now optional), `loops.service.ts` `triggerSweep` (≤4 polls per tick,
`pollMinutes` ≥2, baseline-then-fire cursors, one `loop_error` per loop per
hour) and `runLoop(…, fired)` with the `<trigger kind=…>` "data, not
instructions" frame, `trigger-bus.ts` (`AgentsService.addTask` →
`LoopsService.onTaskAdded`, 30 s debounce, self-queued tasks excluded),
`hooks.controller.ts` (`POST /api/hooks/:agentId/:loopName`, public in
`TokenAuthStrategy`, timing-safe SHA-256 secret, 64 KB, 30/min),
`loops.controller.ts` (`GET /api/agents/:id/loops/state`, `POST …/loops/
:name/webhook-secret`), `connections.poll.ts` + `ConnectionsService.fetchMail`
/ `fetchCalendarWindow` with the new Google `mailread` tier
(`gmail.readonly`, trigger polling only), migration `0022-loop-state`, the
"Runs when" chooser in the agent home's Schedule tab with the one-time
webhook secret, `docs/triggers.md`, and `tests/backend-triggers.test.ts` +
`web-tests/triggers.test.ts`.

### 7. Paid cloud with tenancy *(done)*
`accountId` on every table, a `SessionAuthStrategy` (email + magic link, or
the suite's account service when configured), per-account plan
(`free|hosted|byo`), usage in dollars with the Phase-1 price table, BYO
provider keys per account, hard stop on plan ceilings. Single-user mode stays
the default for self-hosting: `AUTH_MODE=single` keeps `SINGLE_USER`.
Shipped as: `server/src/accounts/` — `account-context.ts` (AsyncLocalStorage
current account, `accountScoped()` column spread, `withAccount()`,
`runWithAccount()`, the request middleware), `scoped-db.ts` (the
account-scoped Drizzle handle every repository already injects; `unscoped()`
for the named cross-account lookups), `accounts.service.ts` (accounts,
hashed one-use magic links with per-address/IP rate limits, 30-day cookie
sessions, plan limits, `account_usage` monthly rollup in micro-USD,
`resolveProviderKey` → own key / platform key / 402), `session-auth.strategy`
+ `suite-jwt.strategy` (experimental, HS256) bound by `AUTH_MODE` in
`app.module.ts`, `auth.controller` (`/api/auth/request-link|callback|me|
logout`), `account.controller` (`GET /api/account`, `PUT /api/account/keys`,
`/api/admin/accounts`), `plans.ts`, `billing-provider.ts` (`manual`);
migration `0023-accounts` + `ensureAccountColumns()` boot sweep (also fences
tables other branches add); `accounts/account_sessions/account_login_tokens/
account_usage` tables, `app_settings` keyed `(accountId, key)`, skills unique
per account; plan caps in `AgentsService.create/update`, the pre-lock 402 in
`TurnLoopService.run` via `TurnContextService.resolveKey`, usage headers on
the turn stream; per-account sweeps in `LoopsService`, `TelegramService`,
`EmailService`, `PushService`, account-resolving `HooksController` and inbound
mail; BYO keys on the account's agent types (not a separate table — one
sealing path); `src/auth.tsx` + `SignIn.tsx` + Settings → Account; config
`AUTH_MODE`, `ACCOUNTS_DEFAULT_PLAN`, `ADMIN_EMAILS`, `AUTH_FROM_ADDRESS`,
`HOSTED_PLAN_USD`, `PLATFORM_*_KEY`, `SUITE_ACCOUNTS_URL|SECRET`;
`docs/accounts.md`; `tests/backend-accounts.test.ts` (13) and
`web-tests/account.test.ts`. Not done: OAuth sign-in, per-account storage
prefixes, RLS, mid-turn ceiling checks, cross-instance link rate limits.

### 8. Shared agents *(done)*
Workspace members with roles (`owner|member|viewer`), per-member connection
grants, per-member memory visibility (lessons and profile entries carry an
`audience`), approvals routed to the member whose grant the tool uses, and
information-flow rules on what one member's content may reach another.
Shipped as: `docs/shared-agents.md`; migration `0027-shared-agents`
(`workspace_members`, `workspace_invites`, `workspace_flow_rules`,
`member_channels`, `org_humans`; `connection_grants.memberAccountId`,
`agent_lessons.audience`, `chat_sessions.initiatedBy|shared`,
`chat_messages.authorAccountId`, `agent_events.forMemberAccountId`,
`workspaces.profilePrivate`, `org_approvals.decidedBy`); `server/src/shared/`
— `SharedService` (invites with hashed 7-day tokens bound to the invitee's
address, roles, flow rules, member channel pairings, addressed events),
`WorkspaceAccessGuard` (the `X-Yaam-Workspace` header rebinds a member's
request into the owner's account with a `Viewer`; `checkRole` /
`isOwnerOnlyRoute`), `SharedController`; `Viewer` / `actorId()` in
`account-context.ts`; `ConnectionsService` grants per member with
initiator-based selection (`resolveConnectionOwner`); the turn loop's routed
approvals (`approval_request` events addressed to one member, `routedTo` on
the stream, `resolveApproval(…, by)`, the existing TTL) and
`<connection-content>` wrapping; `audienceForSession` at distillation,
`digest({ actor, allowFrom })`, `profilePrivate`; attribution in
`buildHistory` and the shared-session system prompt; per-member Telegram and
email pairings running turns `runWithViewer`; routed events on the member's
Telegram, email and web push; `org_humans` with `mayDecide`, `decidedBy` and
human audit actors; the Members pane, "Shared with you" picker, author
chips, shared badges, "Waiting for <name>" banners, inbox Allow/Deny,
audience badges, Company humans; `tests/backend-shared.test.ts` (12) and
`web-tests/shared-header.test.ts`. Not done: `files` flow rules are stored
but not enforced (workspace files have no per-member ownership), and
`ORG.json` import.

### 9. Portability *(done)*
AGENT.json gains lessons, skills, profile, tasks; importers for Claude
memory export, Muse data export, Hermes `MEMORY.md`/`USER.md`; agentskills.io
`SKILL.md` import with a scan step (size, URLs, instruction-smell) before
the skill enters `draft`.
Shipped as: `server/src/portability/` (`PortabilityService` — AGENT.json
`formatVersion: 2` with `lessons`, agent-private `skills`, open `tasks`, and
`profile` only behind `?includeProfile=1`; v1 and v2 import with per-section
toggles, lessons quarantined unless "trust imported lessons" is ticked,
skills as drafts; `importMemory` for `claude-memory` / `muse` / `hermes` /
`openclaw` → `{ lessons, profileProposals, charterSuggestion }`), the
`import` lesson source (untrusted like `app`/`channel`, migration `0022`),
`skill-md.ts` (parse / scan / render) with `POST /api/skills/import`,
`GET /api/skills/:id/skill.md` and `skills.scanReport`, the agent-home
Import dialog and v2 review modal (`SkillBits.tsx`, `AgentsView.tsx`), the
Import SKILL.md button and scan flags on both skills surfaces, docs
`agent-memory.md` §8 and `permissions.md` "Skills", and
`tests/backend-portability.test.ts`. Not done: zip / multi-file skill
bundles (single `SKILL.md` only), multipart upload (the UI reads files
client-side and posts JSON), and the Claude export is treated as pasted
text because Claude has no file export (assumption documented in §8).

### 10. Skill outcome tracking *(done)*
Each turn records which skills it used; ratings attach to those skills;
Skills page shows last used, use count, 👍/👎 rate; a 👎 on a skill turn
produces a draft revision with a diff.
Shipped as: `chat_turns.skillsUsed` (set by the turn loop when a `skill_*`
tool loads), `skill_outcomes` (one row per skill × turn, re-rating updates)
and `skills.useCount/upCount/downCount/lastUsedAt` (migration `0022`;
`SkillsService.recordUse/recordOutcome`, called from the turn loop and
`ChatsService.rateTurn`), skill names carried in the agent's pending
feedback and a system-prompt hint naming the skill after a 👎, the
`revise_skill(skillId, instructions, reason)` agent tool →
`skills.pendingRevision` (read-only class: the user's accept is the gate),
`POST /api/skills/:id/revision/accept|reject` with `skills.history` (last
5), `src/lib/diff.ts` (LCS line diff, `web-tests/diff.test.ts`), the
`RevisionCard` / `SkillStats` UI on Settings → Skills and the agent's
Skills & tools tab, and `tests/backend-skill-outcomes.test.ts`. A
pre-existing bug surfaced on the way: the `0002` unique index on skills
ignored `agentId`, so two agents could not own a same-named private skill;
`0022` replaces it.

### 11. Voice notes *(done)*
Shipped as: `server/src/voice/` (`TranscriptionService` + `VoiceModule`:
`GET /api/voice/status`, `POST /api/voice/tts`), config
`TRANSCRIPTION_PROVIDER|BASE_URL|MODEL|API_KEY` + `TTS_MODEL` (key falls back
to the OpenAI agent type's sealed key via
`AgentTypesService.resolveKeyForProvider`), audio detection + 25MB/type
bounds and a synchronous 60s transcription in both file upload endpoints
with a `<file>.transcript.txt` sidecar, `loadAttachments` rendering
`[Voice note transcript]: …` (never raw bytes), the `audio` preview kind,
settings `ttsEnabled`/`ttsVoice`, `src/lib/voice.ts` (`useVoiceRecorder`),
`VoiceChip.tsx`, the composer mic/Stop UI and reply speaker button in
`ChatView.tsx`, audio previews with transcript in `FilesView.tsx`, and
docs/voice.md. Tests: `backend-voice`, `web-tests/voice-chip`.

Audio attachments transcribe on upload through a configurable
OpenAI-compatible transcription endpoint; the transcript becomes the
attachment text; optional TTS on replies behind a setting.

### 12. Market registry *(done)*
A registry: publish an agent (AGENT.json), skill, or mini app with mandatory
capability review on install; install counts; ratings from the feedback we
collect; remote registry URL configurable so self-hosted instances can pull
from the hosted one.
Shipped as: migration `0025-registry` (`registry_items`, `registry_installs`,
`registry_ratings`, each with `accountId` from the start),
`server/src/registry/` (`RegistryService` — `normalizeManifest` per kind,
`publish` with `dryRun` and (kind, slug) version bumps that keep installs,
`pushToRemote` / `acceptRemotePublish` behind `REGISTRY_PUBLISH_TOKEN`, the
two-step `install` that answers `{ requiresConfirm, review }` until
`confirm: true` and then imports inert via `PortabilityService` /
`SkillsService.importSkillMd` / `AgentsService.saveApp`, `recordTurnRating`
hooked from `ChatsService.rateTurn`, `rate`, a 10-minute remote cache over
`fetchPublic`; `app-scan.ts` for mini-app HTML), `GET/POST /api/registry…`
with the public feed `GET /api/registry/public[/:id]` and the counter
endpoints left open in `TokenAuthStrategy`, config `REGISTRY_URL` /
`REGISTRY_PUBLISH_TOKEN`, `capabilities` carried through
`AgentsService.importJson`, the Community department in `MarketView.tsx`,
`RegistryBits.tsx` (Publish form with the scan shown before confirming,
`RegistryReviewModal`), Publish buttons on the agent home, skill rows and
app cards, Settings → Market and Settings → Security, `src/lib/registry.ts`,
`docs/registry.md`, and `tests/backend-registry.test.ts` +
`web-tests/registry.test.ts`. Deliberately not built: payments, unreviewed
installs, trusting a remote scan, ranking by installs.

### 13. Desktop computer control *(done)*
Shipped as: migration `0024` (`computer_runners`, `computer_actions`),
`server/src/computer/` (`ComputerService` — pairing codes, sha256 companion
tokens, narrow-only scopes in `computer-scopes.ts`, the in-process work
queue with deadlines, the audit rows; `CompanionGuard` as the second bearer
kind on exactly `POST /pair`, `GET /work`, `POST /result/:id`, `POST
/heartbeat`, listed public in `TokenAuthStrategy.isCompanionRoute`;
`ComputerController` with `pair-code|status|pause|resume|disconnect|scopes|
actions`), the `computer_*` branch of `turn-loop.service.ts` (`checkPolicy`:
never Auto, acting tools never remembered; loop/channel origin refused with
an `info` inbox event; the `computer` TurnEvent; screenshots as vision parts
on tool results in both adapters), `COMPUTER_CONTROL_ENABLED`, the
`companion/` CLI (`pair|run|status|unpair`, dependency-free; macOS
`screencapture`/`osascript`/`cliclick`, Linux `xdotool`/`grim`/`scrot`,
Windows PowerShell best effort; realpath file jail; 64 KB/300 s shell), the
Settings → Computer pane, the artifact panel's Computer tab, red "This acts
on your computer" approval banner, `docs/computer-control.md`, and
`tests/backend-computer.test.ts` + `companion/test/scopes.test.ts`.

A paired companion runner (`companion/`, Node CLI) on the user's machine that
connects outbound to the API with a pairing code and exposes
`computer_screenshot`, `computer_click`, `computer_type`, `computer_key`,
`computer_move`, `computer_scroll`, `computer_shell`, `computer_read_file`,
`computer_write_file`, `computer_list_dir` behind per-runner scopes (screen,
input, shell, folders). Always Ask-gated, never from loop or channel turns,
with an audit row per action and Pause / Disconnect kill switches in
Settings → Computer plus a server env switch.

### 14. Autonomous company *(done)*
Designed in `docs/autonomous-company.md`: organisations with roles and
reports-to, a chief-of-staff agent with `hire_agent`, `set_scope`, `reorg`,
`audit`, hierarchical budgets, a shared group session, org-level goals and
board, an audit log, and a CEO brief.
Shipped as: migration `0023-organizations` (`organizations`, `org_members`,
`org_goals`, `org_projects`, `org_tasks`, `org_runs`, `org_budgets`,
`org_grants`, `org_approvals`, `org_audit`, `org_messages`, each with
`accountId DEFAULT 'single'` for item 7), `server/src/org/` —
`OrgService` (depth ≤ 3, fan-out ≤ 5, no cycles, meet-rule scopes via
`scopes.ts`, charter hashes and drift), `OrgTasksService` (the atomic
`UPDATE … RETURNING` claim, comments that wake only the owner, review with a
different-model-family reviewer and the 3-round cap → `escalation`
approval), `OrgRuntimeService` (TriggerBus `org.wake` events debounced into
one run per task in an `Org · <org> · <task>` session with `origin 'loop'`,
pre-call USD reservation against agent → project → company envelopes with
`budget_warn` at 80% and `budget_stop` at 100%, no-progress backoff
2→4→8→30 min then `blocked`, same-call ×3 stop, the `org_*` tool matrix
registered through `TurnLoopService.setOrgTools`, the kill switch), 
`OrgApprovalsService` (hire from a catalog pack or template with
`meet(chief, requested)` scopes and no inheritance, `scope_widen`, `reorg`,
`budget_raise`, `strategy`, `terminate`, `external`, 72 h expiry = not
done; `decide()` only from the controller), `OrgAuditService` (SHA-256
chained, `verify()`), `OrgBriefService` (deterministic brief at `briefHour`
in the workspace timezone, numbered decisions, `parseBriefReply` for
"do 1, 3, skip 2"), `OrgController` (`/api/orgs/*`, 404 when
`COMPANIES_ENABLED=false`), the Company section (`CompanyView.tsx`,
`CompanyRail`: org chart, board with task drawer, goals, approvals with the
full artifact, spend tree over `UsageChart`, activity → runs → session,
group log, brief + reply), `docs/security.md` §b rows and §c paragraph, and
`tests/backend-org.test.ts` (18 tests). Phase D shipped with item 8
(`docs/autonomous-company.md` §5 "Shipped as" under phase D): `org_humans`
with ceo | board | observer, role-checked decisions, `decidedBy`, human
actors in the audit chain, board copies of the brief, humans in the org
chart and "who may decide" in the queue; routed approvals are item 8's
mechanism. Not done from the design: `org_wakes` as a DB-backed queue
(the debounce is in-process), `fileScope` enforcement on `fs_write`, the
cheap `coordinationModel` for the chief's routing runs, per-task
`org_member_charters` versioning (the hash is recorded on `org_members`),
and `ORG.json` export.

## Also in scope
- Correct the doc/code mismatches listed in `docs/competitor-gap-analysis.md`
  §6 (roadmap AGENT.json claim, Phase 2 status, Telegram one-way).
- Rewrite `docs/roadmap.md` §2 and §4 against the competitor matrix.

### 15. Group chat: channels, threads, agents that talk *(done)*
`docs/group-chat.md` §1–§4: channels in every workspace (`#general` by
default), threads, @mentions, unprompted replies gated by a cheap relevance
check with rate caps, 3-round agent-to-agent cap per thread, channel folder,
make-task from a message with status lines posting back, DMs in the same
rail, workspace SSE, mention delivery through paired channels.

*Shipped as (1 November 2026):* migration `0029-group-chat` (`channels`,
`channel_members`, `channel_messages` + GIN FTS, `channel_reads`;
`agent_tasks|org_tasks.channelId|messageId`; `#general` backfill);
`server/src/groupchat/` (`GroupChatService`, `ChannelRuntimeService`,
`GroupChatController` at `/api/workspaces/:id/chat/channels…` and
`GET /api/workspaces/:id/events`, `WorkspaceEventBus`, `mentions.ts`);
`TurnLoopService.addToolProvider` (`ToolProviderHook`);
`WorkspacesService.onCreated`; `TriggerBus.emitTaskStatus` from both task
services; `eventLink`/`eventHead` in the Telegram, email and push sweeps;
`#slug text` in `TelegramService`; `SearchService.channelMessages`;
`channelDailyTokenBudget` setting. SPA: `ChannelView.tsx`, the Channels
block in `Rails.tsx`, `store.tsx` (`channels`, `openChannel`,
`onWorkspaceEvent`, deep links `#/ws/<id>/channel/<slug>[/<messageId>]`),
`src/lib/channels.ts`. Tests: `tests/backend-groupchat.test.ts` (13, including `#company` through the `OrgAnnouncer` seam),
`web-tests/channels.test.ts` (6). Not done: `#goal:<id>` references.

### 16. Workspace is the company *(done)*
`docs/group-chat.md` §5: fold the organization object into the workspace
(`orgMode off|supervised|autonomous`), Company panes under the workspace,
`#company` announcements, autonomous chief of staff within caps (hire, reorg,
scopes, budgets execute immediately and are audited and announced),
supervised mode keeps approvals.

*Shipped as (1 November 2026):* migration `0028-org-mode` (`workspaces.orgMode
| chiefOfStaffAgentId | orgMonthlyUsd | orgAgentCap`, one live org per
workspace), `OrgModeService` + `WorkspaceOrgController`
(`PUT /api/workspaces/:id/org`, `/pause`, `/resume`, `/caps`, `/review`, and a
thin alias of every `/api/orgs/:id/...` route), enrolment of every workspace
agent under the chief, the `Announcer` seam for `#company` (one provider to
bind when item 15 lands), autonomous execution of `org_hire_agent` /
`org_reorg` / `org_set_scope` widening / `org_allocate_budget` /
`org_terminate_agent` inside code-enforced caps with reasons on refusal and
`auto_*` audit rows, inbox events, announcements and a brief section on
execution, `org_review_structure` plus board-event (`TriggerBus.emitOrgBoard`)
and daily chief reviews, the Company section replaced by workspace-scoped
panes in the rail, the Settings → Workspace → Organization card, the
"Chief of staff of <workspace>" badge, `#/ws/<id>/org/<pane>` deep links;
`tests/backend-org-mode.test.ts` (10 tests). Old tool names are accepted for
one release.

### 17. Units: board, channel and goal tracker per org level *(done)*
`docs/group-chat.md` §7: a unit per agent with direct reports, created and
archived automatically; unit channel with chart-driven membership; unit board
and goal tracker with roll-up; lead tools.

*Shipped as (1 November 2026):* migration `0030-org-units` (`org_units`,
`org_tasks.unitId|unitExplicit`, `org_goals.unitId|parentGoalId`, the
`backfillOrgUnits` backfill with `#company` created when missing);
`server/src/org/org-units.service.ts` (`ensureUnitFor`, `archiveIfEmpty`,
`syncMembership` through `OrgService.onStructureChange`, `unitForAssignee`,
`defaultUnitId`, `unitTree`, `goalProgress`/`goalTree`, `addGoal`,
`unitReport`, `announceIn`) over the `UnitChannels` seam on `OrgAnnouncer`
that `GroupChatService` binds; unit defaults and roll-up in
`OrgTasksService`, unit-channel status lines through `emitTaskStatus`,
`#goal:<id>` mentions and `GET …/chat/goals/:goalId/messages`; lead tools
`org_set_goal`, `org_assign`, `org_create_task` (scoped), `org_unit_report`
in `OrgRuntimeService`, unit-channel lines on autonomous hire/reorg/
terminate; `GET|PATCH …/org/units…`, `…/goals/tree`, `unitId` filters; SPA:
Company + unit groups in `WorkspaceRail`, `store.orgUnitId`, Board chips and
roll-up, the goal tracker, org-chart unit boundaries, the unit-channel
header and goal chips in `ChannelView`, `goalRefs`/`goalMentions` in
`src/lib/channels.ts`. Tests: `tests/backend-org-units.test.ts` (9),
`web-tests/channels.test.ts` (+2). Departures are noted at the end of §7.

### 18. Intent: vision, key results, check-ins, cascade *(done)*
`docs/company-vision.md` §2 and §11 phase A; the tunables and operating
profile of §1b.

*Shipped as (1 November 2026):* migration `0031-org-intent` (`org_goals.kind |
metric | targetValue | currentValue | startValue | unitLabel | dueAt |
confidence | atRisk | atRiskReason | lastCheckInAt | checkInCadenceDays`,
`org_checkins`, `organizations.rules | strategyMemo | strategyMemoAt | values
| culture | tunables`); `server/src/org/org-tunables.ts` (`TUNABLES` with
defaults and bounds, `registerTunables`, `tunable`, `checkTunable`,
`describeTunables`); `server/src/org/org-intent.service.ts` (`setVision` with
one active vision per org, `setKeyResult`, `checkIn`/`checkIns`, `paceOf`,
`measuredProgress`, `assessRisk`, `sweepRisk`, `whyChain`, `intentTree`,
`summary`, `setStrategyMemo`, `onIntent`); `OrgService.onGoalChange`,
`setProfile`, `setTunable`, goal kinds and the charter's cascade paragraph;
`OrgRuntimeService.runPlanning` / `queuePlanning` / `flushPlanning(s)` on
intent events with per-unit debounce and cooldown from the tunables, the
shared `taskFreeTurn`, the risk sweep on the minute tick, planning context
and the profile line in every org prompt; tools `org_set_key_result`,
`org_check_in`, `org_why`, `org_intent`, `org_strategy_memo`, `org_tune`;
the `tune` approval kind; the brief's "Key results" section; `GET|PUT
…/org/vision`, `GET|PUT …/org/profile`, `GET|PUT …/org/tunables`, `GET
…/org/intent?unitId=`, `POST …/org/goals/:goalId/checkin`, `GET
…/goals/:goalId/checkins`, `GET …/org/why?taskId=|goalId=`, `POST …/org/plan`,
`GET …/org/strategy` on both controllers; `POST/PATCH …/goals` take `kind`
and the key-result fields; item 20's `org-assurance-tunables.ts` is a wrapper
over `org-tunables.ts` (one registry, one store, one set of bounds);
`heartbeatReasons`/`heartbeatContext` registered on item 21's
`HeartbeatService`. No SPA. Tests: `tests/backend-org-intent.test.ts`
(11). Departures are noted in `docs/company-vision.md` §14.

### 19. Rituals: meetings with minutes, standup, review, retro, board *(done)*
`docs/company-vision.md` §3, phase B. Decision log table lands here.

*Shipped as (1 November 2026):* migration `0032-org-meetings`
(`org_meetings`, `org_decisions` — the §6 decision log — and
`org_cadences`); `server/src/org/org-meetings.service.ts` (meetings,
attendees by unit, the model-free standup agenda with the "blocked needs an
owner" rule, `materialise` → tasks / decision-log rows / audited risks /
brief questions, cadence defaults per unit, cron bounds and `setCadence`,
`limitsFor` over the `meeting.*` tunables of `meeting-tunables.ts` with the
fence in code); `server/src/org/org-meeting-runtime.service.ts` (rounds with
one turn per attendee in the `#<slug> · <agent>` session, the tools
`meeting_speak | meeting_propose_action | meeting_propose_decision |
meeting_raise_risk | meeting_ask_ceo | meeting_close`, human injection and
the stop word, per-turn reserve/settle through `OrgRuntimeService`, the USD
and daily caps, quiet-hours postponing, the kill switch, the minute tick
firing cadences by mode, `/meeting`, `org_set_cadence` for the chief and
unit leads — autonomous within bounds, a `cadence` approval card in
supervised mode — and the operating profile in every prompt); the
`MeetingChannels` seam on `OrgAnnouncer` bound by `GroupChatService`
(`wake: false` posts), `#decision:` refs in `mentions.ts`, "Questions from
meetings" in the brief; `GET|POST …/org/meetings`, `GET …/org/meetings/:id`,
`POST …/org/meetings/:id/cancel`, `GET …/org/decisions`, `GET|PATCH
…/org/cadences`, `GET …/chat/decisions/:id`. Tests:
`tests/backend-org-meetings.test.ts` (11). Backend only; the SPA shows the
threads as ordinary channel threads. Departures are listed in
`docs/group-chat.md` §8.

### 20. Assurance: signals, SLOs and pulse, the auditor role *(done)*
`docs/company-vision.md` §5, phase C.

*Shipped as (1 November 2026):* migration `0033-org-assurance`
(`org_signals` + unique (orgId, kind, refId, dayKey), `org_slo_samples`,
`org_audits`, `organizations.auditorAgentId | auditCadenceDays | auditUsdCap
| tunables`); `server/src/org/org-signals.service.ts` (`sweep` on the
runtime tick every 5 min, `compute` for 12 model-free kinds, `open` with
per-day dedup and owner/lead/chief/CEO routing — inbox `org_signal` events,
`TriggerBus.emitOrgBoard({ kind: 'signal' })`, the brief — `ack`, `resolve`,
auto-resolve, `visibleTo`); `org-slo.service.ts` (`compute`, `sample`,
`pulse`, `pulseScore`/`breachesOf`/`classOf` pure, `slo_breach` signals,
targets and weights from tunables); `org-assurance-tunables.ts`
(`ASSURANCE_TUNABLES` defaults + bounds, `assuranceTunable`,
`mergeTunables`; §1b); `org-auditor.service.ts` (`runAudit` with
reserve/settle, `auditUsdCap`, `audit_start|audit_end|audit_refused`
rows, model-free sampling, operating-profile framing, `pickModel`
different-family selection and the single-model flag, findings → signals,
`#company` report, `org_audits`, cadence tick, `due`); the runtime's
`RunCtx.audit`, `beginAuxRun`/`endAuxRun`, `restrictTo` on
`OrgToolsHook` (turn-loop filters offered tools and refuses calls outside
the set), tools `org_signals`, `org_ack_signal`, `org_pulse`,
`org_audit_finding`, `org_audit_close`, `org_audit_query` opened to the
auditor; `packs/auditor.md` ("Auditor" pack, `pack-auditor`; a hire from it
fills an empty `auditorAgentId`); routes `GET …/org/signals?status=
&severity=&unitId=&kind=`, `POST …/org/signals/:id/ack | /resolve`, `GET
…/org/pulse`, `GET|PATCH …/org/slo`, `GET …/org/audits`, `POST
…/org/audit/run`, `PATCH …/org/detail` with `auditorAgentId |
auditCadenceDays | auditUsdCap` (both on `/api/orgs/:id/…` and the
workspace alias); brief sections Signals / Pulse / Audit; `docs/security.md`
§b auditor row and §k line. Tests: `tests/backend-org-assurance.test.ts`
(11). Departures: tools are `org_audit_finding`/`org_audit_close` (the
org tool hook owns the `org_` prefix); the SLO window is a trailing 7 days
so a sample is stable with few tasks a day; task class is derived from the
brief by keyword (`class: <name>` in constraints wins) until item 23 stores
one; the SPA is not touched.

### 21. Connection context cards and suggested loops; gated heartbeat per agent *(done)*
`docs/company-vision.md` §12–§13, with the §1b rule that every tunable is a
default with a bound.
Shipped as: migration `0034-heartbeat-connection-cards` (`heartbeat_state`,
`workspaces.heartbeatDefaults`, `agents.heartbeatEnabled | heartbeatCron |
heartbeatDailyRunCap | heartbeatStaleMinutes` — the heartbeat is agent
columns, not a loops entry, so the loop cap, export/import and pack hires
are untouched and existing agents get one at boot through the defaults),
`server/src/connections/cards/` (eleven cards as TypeScript data —
`google-gmail`, `google-calendar`, `google-drive`, `microsoft-mail`,
`microsoft-calendar`, `microsoft-files`, `telegram`, `email`, `web-push`,
`browser`, `computer` — plus `mcpCardFor` per enabled MCP server;
`validateCards` at import; `rankUses` by the operating profile's text
against each use's `fits` tags; `cardContextBlock` ≈600 tokens),
`ConnectionsService.grantLevels | cards | heldCards | cardContext` and the
`info` suggestion event on `setGrant`, the card block appended to the
system context in `TurnLoopService` for held grants and available
browser/companion/MCP tools, `GET /api/connections/cards[/:idOrService]
?profile=`, `POST /api/agents/:id/loops/install` (grant-level checked,
unique names), `server/src/chats/heartbeat-config.ts` (fence: cadence ≥ 5
min, daily cap ≤ 48, staleness 5 min..7 d; built-in ← workspace ← agent),
`heartbeat.service.ts` (own minute tick; model-free gate: quiet hours defer,
spend stop, org-paused members, stale tasks + addressed inbox rows +
unanswered mentions + `HeartbeatReasonProvider`s; daily cap; one
`runLoop` named `heartbeat` with the reasons, the charter and the
`HeartbeatContextProvider`s' operating profile in the prompt;
`setHeartbeat` for the org module), `heartbeat.controller.ts` (`GET | PATCH
/api/agents/:id/heartbeat`, `POST …/heartbeat/beat`), the Heartbeat card
and the card installs on the agent page, `docs/integrations.md` §5a,
`docs/triggers.md` "Heartbeat", and `tests/backend-heartbeat.test.ts` (10)
+ `tests/backend-connection-cards.test.ts` (5). Not done: a chief-of-staff
install tool (installs for reports go through the agent's loops PATCH),
channel cards are not injected (no per-agent channel availability signal
in the turn loop), and the org module's reasons/context providers are
interfaces only.

### 22. Memory: playbooks, postmortems, ask-the-company *(planned)*
`docs/company-vision.md` §6, phase D.

### 23. Capital and the CEO seat: cost per outcome, forecasts, routing, preview with veto window, replay *(done)*
`docs/company-vision.md` §7–§8, phase E.

*Shipped as (1 November 2026):* migration `0035-org-capital`
(`org_tasks.class TEXT DEFAULT 'general'`, `organizations.routing TEXT
DEFAULT '{}'`, `org_allocations` + unique (orgId, goalId), `org_plans`);
`server/src/org/org-tasks.service.ts` (`TASK_CLASSES`, the one shared
`deriveTaskClass` heuristic — item 20's `classOf` now reads the stored
column — `normalizeTaskClass`, `class` on create/update and in `TaskDto` /
`org_create_task`); `org-routing.ts` (pure: `parseRouting`, `mergeRouting`,
`resolveRoute`, `tierModel` — cheap via `cheapestModelFor`, standard the
session's model, strong a per-provider table, pinned tier models win);
`org.service.ts` (`routing`, `setRouting` with a decision-shaped
`routing_set` row, `allocations`, `setAllocation` upsert per objective with
`allocation_set`); `org-capital.service.ts` (`costByGoal` and
`describeCosts`/`objectiveLine`, `affectedObjectives`, `forecast` and
`describeForecast`, `sweepForecast` → `burn_forecast` signal, plans:
`createPlan` with the window and the CEO's `org_plan` event, `veto`,
`applyNow`, `applyDue`, `apply` through the runtime-bound `applier` with
`plan_created | plan_action_applied | plan_action_refused | plan_applied |
plan_vetoed | plan_expired | plan_dry_run` rows, `replay` with the segment
chain check); `org-runtime.service.ts` (`RunCtx.plan | applying`, capture
of hire / reorg / terminate / scope widen / budget raise / routing / tune in
autonomous planning runs and chief reviews, `dryRunPlanning` and the
hypothetical in `planningPrompt`, the allocations section and the
allocate-per-objective ask, routing in `runTask` (session model, `run_start`
payload `class | model | routed | pinned`), `applyPlanAction`, `sweepForecast`
and `applyDue` on the tick, tools `org_costs`, `org_forecast`,
`org_set_routing`, `org_allocate_budget {objectiveId, buys}`, spend by class
in `spendTree` and `org_pulse`); `org-slo.service.ts` (`spendByClassUsd`);
`org-approvals.service.ts` (kind `routing`; `budget_raise` applies the
allocation and its summary names what it buys and the affected objectives);
`org-signals.service.ts` (kind `burn_forecast`, left to its owner by the
sweep); `org-brief.service.ts` (Spend projection line, "Cost per outcome"
with its decision line, "Plans awaiting your veto"); tunables
`capital.overspendMargin` (0.2, 0–1), `capital.vetoWindowMinutes` (30,
0–1440), `capital.forecastWindowDays` (7, 1–30) in `org-tunables.ts`; routes
`GET …/org/costs?period=month|all&unitId=`, `GET …/org/forecast`, `GET|PUT
…/org/routing`, `GET|PUT …/org/allocations`, `GET …/org/plans?status=`, `GET
…/org/plans/:id`, `POST …/org/plans/:id/veto | /apply-now`, `POST
…/org/plan/dry-run`, `GET …/org/replay?day=` on both controllers;
`docs/company-vision.md` §14 Phase E, `docs/security.md` §b plan row and §k
line. Tests: `tests/backend-org-capital.test.ts` (12). Departures: the class
is stored on the task and derived once at creation (the brief's `class:`
still wins); `strong` is a per-provider table, not a priced lookup; the plan
is a row of actions the SPA will draw as a diff; the CEO pins a model on the
agent (`agents.model`), not in the routing table; item 20's `burn_rate`
signal (month-to-date average) stays alongside the trailing-window
`burn_forecast`; the SPA is not touched.

### 24. Blueprints: company export/import, registry, role catalog, hybrid human roles *(planned)*
`docs/company-vision.md` §9, phase F.
