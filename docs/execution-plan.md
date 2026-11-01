# Execution plan: closing the competitor gaps, all of them

Status: **items 1–26 done** — shipped between 31 October and 1 November 2026; items 27–31 shipped 2 November 2026; see each item's "Shipped as" line.
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
*Shipped as, SPA (1 November 2026, branch `feat/spa`):* the **Vision** pane
(`src/components/OrgVisionView.tsx`, Company → Vision, `#/ws/<id>/org/vision`)
— vision card (title, paragraph, horizon, rules; write / revise and re-plan),
operating profile (values, culture), the strategy memo, "Plan now", the intent
tree as objectives → key results with measured progress and owner confidence
side by side, pace badge, at-risk flag with reason, owner, due, last check-in,
inline check-in form and history, unit filter via `orgUnitId` with at-risk
counts, a **Why** drawer (also on the board's task drawer) that walks task →
key result → objective → vision and names the broken link; the **Tunables**
editor in Settings → Workspace → Organization (grouped by area, default /
bound / changed, `PUT …/org/tunables`, `slo.*` through `PATCH …/org/slo`);
helpers in `src/lib/org.ts`, `web-tests/org.test.ts`.

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
*Shipped as, SPA (1 November 2026, branch `feat/spa`):* in `ChannelView` a
meeting thread renders specially — a "Meeting · <kind> · running/done" header
on the agenda root with rounds, cost, Open thread and Cancel, the `minutes`
attachment as a structured card (summary, decisions as `#decision:` chips,
actions linking to their tasks, risks, questions for the CEO), the thread
composer saying replies are read at the next round, `#goal:` / `#decision:` /
`#task:` chips drawn inline by the Markdown `refs` resolver (decision titles
fetched once per id through `GET …/chat/decisions/:id`; `decisionRefs` /
`decisionMentions` beside `goalRefs` in `src/lib/channels.ts`) and a `/meeting`
hint in the composer; the **Meetings** pane (`src/components/OrgMeetingsView.tsx`,
`#/ws/<id>/org/meetings`) — cadences per unit with the cron in words
(`humanCron`) and editable, running meetings, meetings held opening their
thread, "Start meeting" with kind / unit / agenda; the **Decisions** pane
(`#/ws/<id>/org/decisions`) — the log with title, decision, rationale,
alternatives, decided by, source (meeting / approval / cadence / autonomous)
and a link to the meeting; rail unit groups show today's ritual.

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
*Shipped as, SPA (1 November 2026, branch `feat/spa`):* the **Pulse** pane
(`src/components/OrgPulseView.tsx`, Company → Pulse, `#/ws/<id>/org/pulse`) —
the score with its 30-day inline-SVG sparkline (`sparkPath`, no chart
library, the UsageChart approach), SLO tiles against targets and the health
line, open signals grouped by severity with ack (note) / resolve and deep
links to the task (board drawer), goal (vision page), member or unit they
name (`orgFocus` in the store), the latest audits with findings and "Run
audit now", spend against the envelope with a month-end projection, today's
rituals; SLO targets and every assurance tunable edit from the Tunables
editor in Settings → Workspace → Organization.

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
*Shipped as, SPA (1 November 2026, branch `feat/spa`):* the Heartbeat card
and the card installs on the agent page were verified against the live
`HeartbeatView` / `BeatResult` shapes (no change); Settings → Workspace gains
a **Heartbeat defaults** row (cadence, daily run cap, stale minutes; `PATCH
/api/workspaces/:id { heartbeatDefaults }`, the fence stated in the copy);
`Workspace.heartbeatDefaults` on the client type.

### 22. Memory: playbooks, postmortems, ask-the-company *(done)*
`docs/company-vision.md` §6, phase D.

*Shipped as (1 November 2026):* migration `0037-org-memory` (`org_playbooks`
— skillId, name `org-<slug>`, title, body, owner, roles, status draft |
in_review | active | retired, version, sourceTaskId, reviewTaskId,
outcomes JSON); `server/src/org/memory-tunables.ts` (`memory.postmortemTriggers`
bit set, `memory.postmortemCooldownDays`, `memory.breakerTrips`,
`memory.recallCap`, `memory.askUsdCap` on the shared registry, area
`memory`); `org-playbooks.service.ts` (`write` → parked draft skill + review
task straight to a reviewer ≠ author, `syncReviews` → `activate` on the
accepted task (skill enabled, `#company` line, owner inbox) or back to draft
on cancel, `offeredTo` / `contextBlock` by title, `refreshOutcomes` from the
item-10 counters, `outcomesSummary` for the retro agenda, `reviseTask`,
`retire`); `org-knowledge.service.ts` (`recall` + `renderPack` model-free,
`answer` as one chief turn with `RunCtx.aux { context, restrict: ASK_TOOLS }`,
`verifyCitations`, reserve/settle, `ask_company_start | ask_company |
ask_company_refused` audit rows, `searchDecisions` ILIKE, `graph` BFS over
the link columns with a 200-node cap); `org-memory.service.ts` (a
`ToolProviderHook` with `org_write_playbook`, `org_playbooks`,
`org_decisions`, `org_recall` (chief), the playbooks block in `contextFor`,
the postmortem triggers — `org.onGoalChange` for abandons, `onOrgBoard`
escalations with `reviewRounds ≥ 3`, a minute tick `sweep` for breakers and
critical `audit_finding` signals — `considerPostmortem` with the cooldown
read from `postmortem_scheduled` audit rows and `postmortemAgenda`,
`meeting_propose_lesson` registered on the meeting runtime for retros,
`materialiseLessons` → `AgentMemoryService.record` per audience /
`charter_change` card with `lineDiff` / `reviseTask`, the `charter_change`
applier (`agents.update` + `acceptCharter`), `onDecided` → decision rows for
approvals, `onAutoAction` → decision rows for `auto_*` and autonomous tune);
seams added for it: `OrgApprovalsService.onDecided` and the `charter_change`
kind, `OrgRuntimeService.onAutoAction` and `RunCtx.aux` (context + tool
restriction for a task-free run), `OrgMeetingsService.onMaterialise` and
`Minutes.lessons`, `OrgMeetingRuntime.addMeetingTool` / `addAgendaProvider`;
routes `GET …/org/decisions/search?q=&unitId=`, `POST …/org/ask {question}`,
`GET …/org/recall?q=`, `GET …/org/graph?ref=&depth=`, `GET …/org/playbooks?role=&status=`
on the workspace surface; `docs/security.md` §b row and §f paragraph. Tests:
`tests/backend-org-memory.test.ts` (10). Departures: skill names are slugs
(`org-<slug>`, not `org/<slug>`); the skill tool is workspace-wide once
active and the role targeting lives in the context list; a charter change is
appended/replacing text with a computed line diff on the card rather than an
agent-written patch; `org_decisions.outcomes` of the vision is
`org_playbooks.outcomes`; backend only.
*Shipped as, SPA (1 November 2026, branch `feat/spa2`):* the **Ask** pane
(`src/components/OrgMemoryView.tsx`, Company → Ask, `#/ws/<id>/org/ask`) —
one question to `POST …/org/ask`, the answer through `<Markdown>` with every
`[task:|decision:|goal:|meeting:|audit:…]` citation turned into a chip that
opens what it names (task → board drawer, decision → Decisions, goal →
Vision, meeting → its thread, audit → the Replay of that row's day; `md.tsx`
gains `meeting` and `audit` ref kinds), the verified citations list, the
stripped ones, the cost, the `budget_stop | busy | failed` states, "Show
sources" (the recall pack, or `GET …/org/recall?q=`) and a session history;
the **Playbooks** pane (`#/ws/<id>/org/playbooks`, `GET …/org/playbooks
?role=&status=`: status, owner, roles offered to, version, outcomes, why, the
body through Markdown, links to the review and source tasks — no retire
button, no route exists); the Decisions pane searches server-side through
`GET …/org/decisions/search?q=` (debounced) and every task drawer and
decision row has a **Related** drawer (`GET …/org/graph?ref=&depth=1|2`
rendered as grouped lists with the relation and hop count, `groupGraph`);
retro minutes cards show `lessons[]` with audience badges and the proposed
charter / playbook changes. Helpers in `src/lib/org2.ts`, tests in
`web-tests/org2.test.ts`.

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
*Shipped as, SPA (1 November 2026, branch `feat/spa2`):* the **Plans** pane
(`src/components/OrgCapitalView.tsx`, `#/ws/<id>/org/plans`) — `GET
…/org/plans?status=` with each plan as a **diff**: actions humanised from
tool + input (`humanizePlanAction`) and grouped hire / reorg / terminate /
scope / budget / routing / tune with the estimate per row and group, the
veto countdown (`countdownLabel`, 30-s tick), **Veto** (note) and **Apply
now**, applied / vetoed / expired / dry-run badges and "stopped here" on the
refused action; the **Dry run** form (prompt + assumed monthly USD → `POST
…/org/plan/dry-run`) rendering the same diff under a "hypothetical, nothing
applied" banner; pending plans as a banner on Pulse, a badge on the Plans
row and a count in the rail's Organization header (`orgPendingPlans`,
fetched with `wsOrg`). The **Replay** pane (`#/ws/<id>/org/replay`): day
picker with prev / next / today → `GET …/org/replay?day=`, totals tiles,
the chain verification badge, the timeline grouped by hour
(`groupReplayByHour`) with kind pills, cost and deep links. The **Capital**
pane (`#/ws/<id>/org/capital`): the cost-per-outcome table from `GET
…/org/costs?period=` (spent, share, envelope bar and source, progress,
measured, the overspend flag with its sentence — `costRows`), spend by
class, the forecast per envelope worst-first (`GET …/org/forecast`,
`forecastRows`, on track / will warn / will stop), the allocations editor
(`GET|PUT …/org/allocations`) and the routing table (`GET|PUT
…/org/routing`: class → tier with the resolved model — pinned, the agent's
own, the provider's strong model, "cheapest" — and pinned tier models). The
`routing`, `tune` and `cadence` approval kinds render as cards. The board
shows the task class.

### 24. Blueprints: company export/import, registry, role catalog, hybrid human roles *(planned)*
### 24. Blueprints: company export/import, registry, role catalog, hybrid human roles *(done)*
`docs/company-vision.md` §9, phase F.

*Shipped as (1 November 2026):* migration `0036-org-blueprints`
(`org_tasks.assigneeHumanId | reviewerHumanId`, `org_humans.reportsToAgentId |
title`, `registry_installs.orgId`, `org_blueprint_imports`,
`registry_outcomes`); `server/src/org/roles/catalog.ts` (`ROLES` — eleven
roles as data, `rankRoles`, `roleById`, `roleRef`, `roleCharter`,
`tierOfModel`) and `org-roles.service.ts` (`list`, `get`, `resolveRoleHire`,
`modelForTier` over `org-routing.ts` `tierModel`); `role:<id>` in `OrgApprovalsService.prepareHire` with
`roleId`/`modelTier` on the payload and the Auditor role filling the seat;
`server/src/org/blueprints/format.ts` (`COMPANY.json` v1, `validateBlueprint`
with the 256 KB / 20 roles / depth 3 / fan-out 5 caps, `hireOrder`,
`unitsOf`); `org-blueprints.service.ts` (`export` with defensive probes for
`org_cadences`, `organizations.routing` and held cards, `importPlan`,
`import` in supervised or autonomous mode, the `blueprint` approval applier,
`sweepOutcomes`, `imports`); the `blueprint` and `human_review` approval kinds
and `registerApplier`; `RegistryService` kind `company` (`normalizeManifest`
validate + scan, `review` with the blueprint and playbook bodies,
`recordExternalInstall`, `recordOutcome`, `bumpPublicOutcome`, `outcomesOf`;
the generic install refuses companies); `blueprints/blueprints.controller.ts`
(`GET …/org/blueprint`, `POST …/org/blueprint/plan`, `POST
…/org/blueprint/import`, `GET …/org/roles?profile=`) and
`companies.controller.ts` (`GET|POST /api/market/companies`, `POST
/api/market/companies/:id/install`); `POST /api/registry/public/:id/outcome`
left open in `auth-strategy.interface.ts`; the `shareBlueprintOutcomes`
setting; hybrid staff — `HUMAN_ROLES` + `employee`, `OrgService.setHuman`
with a reporting line and `employee()`, `OrgTasksService.assignHuman`,
`tasksOfHuman`, `requestReview` to a human (the `human_review` card and an
addressed `org_review` event), `OrgUnitsService` employees on the tree
(`memberHumanIds`) and in unit channels, `org_assign human=` with lead
scoping, `POST …/tasks/:taskId/assign { agentId | humanId }`, `GET
…/humans/me/tasks`, `GET …/humans/:memberAccountId/tasks`, `HumanDto` with
`reportsToAgentId | title`; `docs/blueprints.md`, `docs/registry.md` §8,
`docs/security.md` rows, `docs/company-vision.md` §14. Tests:
`tests/backend-org-blueprints.test.ts` (11). No SPA. Departures: playbooks
install as drafts; cadences are listed, not written; tiers resolve through
item 23's `tierModel`; a role hire is named after the
title the chief gives.
*Shipped as, SPA (1 November 2026, branch `feat/spa2`):* Settings → Workspace
→ Organization gains a **Blueprint** row (`src/components/OrgBlueprintBits.tsx`,
lazy): **Export blueprint** downloads COMPANY.json from `GET …/org/blueprint`;
**Import blueprint** takes a pasted or picked file, mode and an optional
envelope → `POST …/org/blueprint/plan` renders the dry-run plan (chief, hires
by role with scopes after the meet and the dropped ones, units, budget and
allocations, tunables, playbooks as drafts, cadences listed, recommended
connections and cards, notes; `blueprintPlanSummary`) → confirm → `POST
…/org/blueprint/import {blueprint, mode, monthlyUsd}` (opens Approvals when a
`blueprint` card was created); **Publish to registry** runs `POST
/api/market/companies` with `dryRun` first (scan, slug, counts) and then
publishes. The Market gains a **Companies** tab (`GET /api/market/companies
?q=` cards with both outcome counts, scan state, playbook and scope counts)
whose Install opens the two-step modal (`POST /api/market/companies/:id/
install` → review with the playbook bodies + the plan → `confirm: true`).
The org chart's **Hire** dialog (`src/components/OrgPeopleView.tsx`) shows
the role catalog from `GET …/org/roles?profile=` as ranked chips (charter
preview, competencies, scopes, tier, estimated USD) beside the profession
packs and proposes a `hire` card through `POST …/org/approvals` with
`templateOrPack: role:<id>`. Hybrid staff: Organization → People seats a
workspace member as `employee` with a title and a reporting line (`POST
…/org/humans`), employees hang under their manager on the chart with a
person badge, the board drawer's Assign offers them (`assign {humanId}`) and
"Human review by…" sends the task to one (`request-review {reviewerHumanId}`),
the **My tasks** pane (`#/ws/<id>/org/mytasks`, `GET …/org/humans/me/tasks`)
lists assigned and reviewing cards with status, comments and request review
to a human or the agent reviewer, and the `human_review`, `blueprint` and
`charter_change` (with the line diff) kinds render in the approvals UI.

### 25. Company onboarding: the New workspace wizard and `POST …/org/bootstrap` *(done)*
`docs/group-chat.md` §5 "Onboarding", `docs/company-vision.md` §1b, §14.

The request: starting a workspace should ask whether to run it as a company
with a chief of staff and then collect what the company needs — its values,
culture, vision and goals — so nothing the chief reads is a hidden default.

*Shipped as (1 November 2026):* `server/src/org/org-bootstrap.service.ts`
(`OrgBootstrapService.bootstrap(workspaceId, input, actor)`: validates the
whole body first — mode, chief shape, `monthlyUsd ≥ 0`, `agentCap` 1–50,
cadence mode, vision title, horizon, every tunable against `checkTunable` —
then in order creates the chief when asked (`AgentsService.create` with
`role: 'Chief of staff'`, the `defaultChiefCharter` of the workspace with the
mission and the §1b profile baked in, and the workspace id — honoured since
item 26), `OrgModeService.setMode`,
`OrgIntentService.setVision` (`horizonDays` → `dueAt`, rules), `setProfile`
and the org's `mission`, `setTunable` per key, `ensureCadenceDefaults` then
`updateCadence` for `'light'` (standup and retro off on the root unit) or
`'none'` (all off), the first hires — item 24's role catalog first (`role:<id>`, a bare role
id or a title through `roleRef` / `OrgRolesService.get`, sent as
`templateOrPack: 'role:<id>'` so `prepareHire` applies the role's charter,
title, tier and scopes met with the chief's holdings; market packs by id or
name as the fallback; the chief's own role never a report) through
`proposeHire` (supervised) or `prepareHire` + `applyHire` under the agent
cap (autonomous), the dropped scopes named in the note — an unknown role is
a `skipped` entry with a note, never a failure — and
`runtime.runPlanning` of the root unit fire-and-forget when `planNow` and a
vision exist (`planning: 'queued' | 'not_requested' | 'unavailable'`); one
`org_bootstrap` audit row lists it all; a workspace with an organization or
a live mode is refused with 400 naming Settings); `POST
/api/workspaces/:id/org/bootstrap` (`BootstrapDto` on
`WorkspaceOrgController`, `OrgBootstrapService` provided and exported by
`OrgModule`); `GET …/org/caps` now also carries `vetoWindowMinutes` (the
`capital.vetoWindowMinutes` default) for the wizard's autonomous card.
SPA: `src/components/NewWorkspaceWizard.tsx` (steps name → mode → chief →
vision → profile → budget → rhythm → hires → review; cards are
`role="radio"` buttons, every field labelled, Escape closes, `min(640px,
100%)` wide with no horizontal scroll on a phone; `existing={id, name}`
starts at the mode step and only bootstraps), `src/lib/onboarding.ts`
(`horizonToIso`, `wizardSteps`, `validateStep` / `validateAll`,
`rankRoles` on the catalog's `fits` tags as the server ranks, `roleHireRef`
(`role:<id>`), `roleCostLabel`, `hiresEstimate`, `buildBootstrapBody` from
what is on screen only, `buildSummary`, `successToast`, the mode / cadence /
ritual copy), `src/lib/api.ts` (`bootstrapOrg`, `orgRoles(wsId, profile?)`
over `GET …/org/roles?profile=` tolerant of 404 with `normalizeRoles`,
`BootstrapBody`, `BootstrapSummary`, `OrgRole` in the item 24 shape — id,
title, charter, competencies, toolScopes, modelTier, estMonthlyUsd, fits,
score, matched), `Rails.tsx` ("Add workspace" opens the
wizard; the `window.prompt`-style inline input is gone), `SettingsView.tsx`
(Organization card: "Enable company…" for a workspace in `off` mode). On
success the wizard selects the workspace, opens the Vision pane and toasts
"Company ready — <chief> is planning" when planning was queued. Tests:
`tests/backend-org-bootstrap.test.ts` (7), `web-tests/onboarding.test.ts`
(12). Departures: the chief picker lists existing agents only when the
wizard runs for an existing workspace (a new workspace owns no agents yet,
per the per-workspace agents rule); the hires step re-ranks server-side
against the profile written so far when entered and shows the matched
tags, tier, estimate and competencies per role, with the cost of the picked
seats against the envelope; the hires step is hidden when the roles route
is absent; tunables are accepted by the route but the wizard does not edit
them (the Settings card does, with the fence).

### 26. Workspace-owned agents *(done)*
Each workspace owns its own agents and its own organization; agents are
never shared across workspaces, and moving one is an explicit action. Before
this, `agents` had no `workspaceId`: every agent was account-global, showed
in every workspace, was enrolled by organization mode wholesale, and loops
and heartbeats ran "in the default workspace".

*Shipped as (1 November 2026, branch `feat/ws-agents`):* migration
`0038-agents-workspace` (`agents.workspaceId TEXT NOT NULL DEFAULT ''` +
`idx_agents_workspace`; backfill `backfillAgentWorkspaces`: the workspace of
the one live organization the agent is a member of when it is a member of
exactly one, otherwise the account's default — oldest — workspace; an
account with no workspace keeps `''`); `AgentsService` (`list({ workspaceId? })`,
`create` requires-or-defaults `workspaceId` through `defaultWorkspaceId()`,
`importJson(profile, { workspaceId })`, `move(id, workspaceId)` with its
`moved` audit event, refused while an org member; chats move, old channel
seats drop); `AgentsController` (`GET /api/agents?workspaceId=`, `POST
/api/agents {workspaceId required → 400}`, `POST /api/agents/:id/move
{workspaceId}`); scoping in `OrgModeService.setMode` (workspace agents
only), `OrgService.create|addMember` (foreign agent → 400, chief created in
the org's workspace), `OrgApprovalsService.applyHire` (hires land in the
org's workspace), `GroupChatService.ensureChannel|addMember`,
`ChannelRuntimeService` (a foreign seat never wakes), `ChatsService.create`
(foreign agent → 400), `LoopsService.runLoop` and `HeartbeatService`
(the agent's own workspace, `workspaceOf`), `TurnLoopService` `delegate_task`
(the delegating agent's workspace), `MarketService.hire(id, workspaceId)`
(`POST /api/market/:id/hire {workspaceId}`), `PortabilityService.importAgent`
and the registry install (`options.workspaceId` → the agent's workspace),
`WorkspacesService.remove` (re-homes the agents), `OrgBlueprintsService.import`
(the chief is created in the target workspace; role hires follow through
`applyHire`), `OrgKnowledgeService` recall and graph (the org workspace's
agents), `OrgBootstrapService` (the chief is created in, or must already
belong to, the bootstrapped workspace) and the wizard's existing-chief
picker; SPA `api.agents(workspaceId)`,
`api.moveAgent`, `createAgent {workspaceId}`, `hire(id, workspaceId)`,
the store's `refreshAgents` per selected workspace (reloads on switch; Rails,
the channel member picker and the org chart read the same list), the agent
Settings tab's "Move to workspace…" card; `docs/shared-agents.md` §1
"Workspace ownership", `docs/group-chat.md` §1, `docs/security.md` §b row.
Tests: `tests/backend-agents-workspace.test.ts` (10), one blueprint test
in `tests/backend-org-blueprints.test.ts` and one bootstrap test in
`tests/backend-org-bootstrap.test.ts`. Departures: the column
is `NOT NULL DEFAULT ''` rather than nullable so every reader sees a string;
`move` also carries the agent's chat sessions and drops its old channel
seats (an agent and its history move together; channels stay with their
workspace); `delegate_task` scopes by the delegating agent's workspace, not
the session's; `GET /api/agents` without `?workspaceId=` still returns every
agent of the account for admin and name-map callers.

## Autonomous organization: closing the gaps (`docs/autonomous-org-first-principles.md`)

### 27. Sensing and executable acceptance (C1, C3) *(done)*
Metric sources bound to connections, webhooks or HTTP JSON with provenance;
key results read their value only from their source; `done_when` checks run
without a model.

*Shipped as (2 November 2026, branch `feat/sensing`):* migration
`0039-org-sensing` (`org_metric_sources` with sealed `secrets`, `tokenHash`,
`failures`, `nextPollAt`, `approvalId`, `activatedAt`; `org_metric_samples`
+ `(sourceId, observedAt)` index; `org_goals.metricSourceId |
lastMeasuredAt`; `org_tasks.checks | acceptedBy`; `org_task_checks`);
`server/src/org/org-checks.ts` (check kinds and `normalizeChecks`, the
JSONPath-like `parseSelector` / `selectValue` / `selectNumber` with
`length`, `count`, `sum(field)`, the connection-query menu);
`server/src/org/org-sensing.service.ts` (`OrgSensingService`: CRUD,
`prepare` with https-only + SSRF-guarded fetches and `{{secret:NAME}}`
headers sealed by secretbox, `create` live for the CEO or
`pending_approval` + a `metric_source` card for an agent's proposal in both
modes, `activateFromApproval`, `rotateToken`, `ingest` (timing-safe,
30/min), `attest`, `recordSample` — the one sample write path, refusing
agent actors — `measureKeyResults`, `poll` with exponential error backoff and
a first-failure inbox event, its own minute `tick`/`sweep` per account with
`metric_stale` signals, `runChecks`/`evaluate`/`taskChecks`, the acceptance
`gate`, and the tools `org_metric_sources`, `org_metric_read`,
`org_propose_metric_source`, `org_task_checks`, `org_run_checks` as a
`ToolProviderHook`); `server/src/org/sensing-tunables.ts`
(`sensing.staleMultiplier`, `sensing.minPollMinutes`,
`acceptance.alsoReviewWhenChecksPass`, `acceptance.checkTimeoutSeconds`,
area `sensing`); `OrgTasksService.setAcceptanceGate` and `requestReview`
running checks first (pass → `done`, `acceptedBy: 'check'`; fail →
`request_changes` with details, a counted round; error → review with a
note), `acceptedBy: 'review'` on review acceptance, `verificationOf`;
`OrgIntentService.bindSource`, check-ins refusing a value on a measured key
result, `intentTree` `measuredBy`/`selfReported`, `summary.selfReported`;
`OrgService.updateGoal` refusing a value edit on a measured key result;
`org_create_task` `checks`, `org_set_key_result` `source`, `org_check_in`
refusal and the planning prompts; the brief's self-reported note and "% of
tasks accepted by check this week"; the board's `verification` field;
`metric_source` approval kind and `metric_stale` signal kind;
`server/src/org/org-sensing.controller.ts` (`GET|POST metrics/sources`,
`PATCH|DELETE metrics/sources/:id`, `POST …/:id/poll`, `POST …/:id/token`,
`GET …/:id/samples?since=`, `POST …/:id/attest`, `POST goals/:goalId/source`,
`GET tasks/:taskId/checks`, `POST tasks/:taskId/checks/run` on
`/api/orgs/:id/…` and the workspace alias; public `POST
/api/metrics/:sourceId/ingest` in `isPublicRoute`); `docs/sensing.md`,
`docs/security.md` §b rows and §k line. No SPA (item 32). Tests:
`tests/backend-org-sensing.test.ts` (16).
Departures: `github_check` is not offered, because the codebase has no
GitHub connection (only an MCP catalog entry). The check is refused with
that reason. `org_set_key_result` takes a `source` to bind rather than
`checks`, since checks belong to tasks. Binding a key result through the
API is the CEO's. Agents bind through `org_set_key_result` as the chief or
the unit lead. A webhook source activated by approval gets its token from a
CEO rotation, not from the approval result, which would land in the audit
log. Connection sources and checks read Google connections only.

### 28. Action contract and the trust ledger (C2, C10) *(done)*
Action classes, idempotency keys, staging, outbound rate limits, two-key
execution for irreversible actions; per-member, per-class autonomy levels
earned from the record and dropped on incidents. Replaces the
supervised/autonomous switch as the unit of autonomy.

*Shipped as (2 November 2026, branch `feat/trust`):* `docs/actions-and-trust.md`
(new). Migration `0040-org-trust` (`action_log` with `idx_action_log_key`
unique on (accountId, key), `trust_records`, `trust_levels` unique on
(workspaceId, agentId, actionClass), `workspaces.trustCeilings`), mirrored in
`schema.ts`. `server/src/actions/`: `action-classes.ts` (the one registry —
exact names, the money pattern, families, the owner's read-only flag for
`org_` / `channel_` / `meeting_` and MCP `readOnlyHint`; unknown →
`external_reversible`; input-aware `classOf` for calendar guests;
`channelOf`, `STAGING` / `stagingOf`, `canonicalJson`, `idempotencyKey`,
`unclassified`), `trust-policy.ts` (pure: levels, `DEFAULT_CEILINGS`,
`DEFAULT_START`, the supervised preset, `effectiveLevel`, `decide`,
`describeMatrix`, `applyOutcome`, `applyIncident`, the `calibrationOf` hook
returning null), `actions-tunables.ts` (`actions.externalPerHour` 30 [1–500],
`actions.irreversiblePerDay` 20 [0–200], `actions.moneyPerDay` 0 [0–50],
`actions.dedupeWindowMinutes` 1 440 [5–10 080], `trust.promoteAfterClean` 10
[3–100], `trust.demoteAfterRejections` 3 [1–10], `trust.calibrationBar` 0.7
[0–1]; areas `actions` and `trust` added to `TunableDef`), `TrustService`
(lazy rows at min(ceiling, start), `effective`, `record`, `incident` from
`TriggerBus.onOrgIncident`, `setCeilings`, `override`, `overview`,
`statusText`, `isOwnerOrCeo`; `trust_change` inbox events, pushed for an
outward promotion, and audit through a hook), `ActionsService` (`byKey`,
`priorOutcome` / `replay` / `waitingText`, `start` / `finish` feeding
successes to the ledger, `rateCheck` / `refuseRate`, `hold`, `stage`,
`ownerKey`, `pickCoSigner` with `familyOf`, `coSign` with the `coSignFn` test
seam, `list`, `revertReport`, `notifyAfter`), `ActionsController`,
`ActionsModule` (imported by `ChatsModule` and `OrgModule`).
`chats/trigger-bus.ts`: `OrgIncidentEvent` with `emitOrgIncident` /
`onOrgIncident` (the seam item 29 emits on). `chats/turn-loop.service.ts`:
the contract block before the legacy loop queue (class, key, replay or
waiting, the trust decision for Auto / loop / heartbeat / org-run turns,
co-sign, hold or stage), `contractPolicy` over `checkPolicy`, the rate limit
right before execution, the row settled after it, `holdOrStage`,
`runCoSigner` (the co-signer's own model through `ActionReviewService.review`
with a pinned model), the held-action executor, the `trust_status` provider
and the boot warning for unclassified tools; `ToolRecord.approved` gains
`deduplicated | held | staged`. `connections`: `sendStagedDraft`,
`draftIdFrom`, `ConnectionsService.sendDraft`. `mcp`: `readOnlyHint` kept on
discovery, `McpService.readOnlyTools`. `review`: `review(…, { model })`.
`org`: approval kind `two_key` (applied through `onApply`, rejected through
`onDecided`), `OrgTasksService.onReviewVerdict`, `OrgTrustBridge` (audit
chain, `action_rate_limit` signals for the chief, `two_key` cards, review
verdicts as ledger outcomes). Routes `GET /api/workspaces/:id/trust`, `PUT
…/trust/ceilings`, `POST …/trust/:agentId/:class`, `GET …/actions?agentId=&class=&status=&limit=`,
`POST …/actions/:actionId/revert-report`, `POST …/actions/:actionId/keys`;
tool `trust_status`. Docs: `docs/security.md` §b rows (outward action, trust
level, agent co-signer), §d and §k; `docs/permissions.md` §7;
`docs/autonomous-org-first-principles.md` §4 and §7 (C2, C10 → Have).
Rebased on items 27 and 29: migration order 0039 sensing, 0040 trust, 0041
incidents; one `OrgIncidentEvent` definition; the freeze is enforced (an org
member's call of a frozen class is held for the owner's key at any level, in
every session kind, through `OrgTrustBridge` → `OrgIncidentsService.isFrozen`);
incident and freeze class names go through `normalizeActionClass` (a tool name
maps to its class; `frozenClasses` stores class names); an org member's
revert report opens item 29's `revert` incident instead of a separate ledger
revert. The red-team sandbox stays ahead of the contract block, so a record-only
run never acts.
Tests: `tests/backend-actions-trust.test.ts` (19).
Departures: the policy matrix decides only where nobody is answering every
call anyway — Ask mode with a person present and channel turns keep the
legacy gates (with irreversible and money never remembered); computer tools
keep their own floor and are not logged; an `internal_write` at level 1 acts
without a per-call notification (the action log is its record); level 1
notifies only unattended turns; level 3 does not switch off the per-call
action reviewer (the auditor's sampling is item 29's); tool failures, inline
Ask denials and reviewer verdicts are not ledger evidence; the incident
seam's `agentId: null` changes nobody and `actionClass: null` every non-read
class; one `action_log` row per key (a retry of a failed or stale attempt
reuses it); `keys` and `POST …/actions/:id/keys` are an addition to the
listed routes so a private (non-org) workspace has an owner key; calendar
staging is declared, not built; `ownDomains` is not filled yet.

### 29. Incidents, degradation and independent audit (C11, C9) *(done)*
Incidents with containment and postmortems; provider and connection
degradation modes; audit of the auditor, rotation, red-team runs.

*Shipped as (2 November 2026, branch `feat/incidents`):* migration
`0041-org-incidents` (`org_incidents` with a partial unique index on
(orgId, kind, refId) while not resolved, `organizations.frozenClasses`,
`org_audits.spotChecks | precision | recall | noRotation`,
`chat_turns.degraded`); `server/src/org/org-incidents.service.ts` (`open`
with dedupe, `containBySeverity` over the `incidents.contain*` levels —
note, pause + drop wakes + stop runs, freeze an external class, autonomous →
supervised — recorded steps, `contain`, `resolve` with undo, the one
words-first `org_incident` owner event, the `incident` postmortem trigger
and a ref describer on OrgMemoryService, `TriggerBus.emitOrgIncident`,
detectors for breakers / budget stop (`OrgRuntimeService.onBreaker`),
critical findings (`OrgAuditorService.onFindings`), bounces and degraded
connections (`ConnectionsService.onDeliveryFailure | onHealth`), degraded
providers (`ProviderHealthService.onChange`, tunable thresholds), the
tool-error streak (`ToolProviderHook.onToolResult`), `reportIncident` for
items 27–28, `report`, `answerSpotCheck`, `isFrozen`, the brief's
Incidents and Degraded sections (`OrgBriefService.addSection`),
`healthReport`, tools `org_incidents` / `org_report_incident`);
`server/src/org/incident-tunables.ts`; `server/src/org/org-redteam.service.ts`
(canary in a sandboxed copy of inbound content, throwaway session with
`TurnLoopService.setSandbox` record-only tools, breach → critical finding +
major incident, cadence tick); `server/src/ai/provider-health.ts`
(transient-error classification, degrade / probe / recover per workspace and
provider family) with failover in `TurnContextService.build` (another
family's agent type, same prompt and tools, `degraded {from, to}` on the
turn); degraded connections in `ConnectionsService` (`ConnectionDegradedError`,
refused only for their own tools, skipped silently by the loop poller);
the auditor's spot-check cards, `auditorQuality`, the rotating `seat` and the
`no_rotation` flag; the pulse's `auditor` precision/recall;
`server/src/org/incidents.controller.ts` (`GET|POST …/org/incidents`, `GET
…/org/incidents/:id`, `POST …/:id/contain | /resolve`, `GET …/org/health`,
`POST …/org/audits/:auditId/spotcheck/:itemId`, `POST …/org/redteam/run`);
`docs/incidents.md`, `docs/security.md` §b rows and §k line. Tests:
`tests/backend-org-incidents.test.ts` (17; the last wires item 27: a task accepted by check that fails a re-run of its checks opens `check_failed` through `OrgSensingService.onChecksRun`). Departures (`docs/incidents.md`
§8): connection incidents use the tool name as the action class; health is
in memory; the chief is never paused automatically; the freeze is enforced
by item 28's contract through `isFrozen`; `memory.postmortemTriggers` grows
bit 16 (default 31).

### 30. Experiments and the prediction ledger (C5, C7, C9 reconciliation) *(done)*
Changes as hypotheses with a metric, window and revert rule; forecasts
scored for calibration; claimed versus measured reconciliation.

*Shipped as (2 November 2026, branch `feat/experiments`):*

- **Migration `0043-org-experiments`.** Adds the `org_experiments` and
  `org_predictions` tables (account-scoped, mirrored in `schema.ts`).
- **`server/src/org/org-experiments.service.ts`.**
  - `propose` validates the proposal: a measured metric or a sourced key
    result, the window inside the `experiments.windowDays` bound, the
    change inside its own bound, and a revert recipe. Terminate is refused,
    and a playbook may only be re-activated if it is retired.
  - `govern` creates an `experiment` card in supervised mode, starts the
    experiment at once in autonomous mode, or holds it in a plan with
    `org_start_experiment` through `OrgCapitalService.addToolApplier`.
  - `start` snapshots the baseline and applies the change through
    `setTunable`, `setCadence`, `setRouting` or `activate` / `retire`, as
    the actor `experiment`. A charter or structure change goes through a
    `charter_change` or `reorg` card instead.
  - `begin` starts measuring when that card is approved.
  - `sweep` runs the daily revert-rule check (`experiment_harm`, a minor
    incident) and, at `endsAt`, the noise-guarded verdict: keep, revert, or
    extend and then revert.
  - `decide` executes the revert recipe and writes the decision-log row,
    the audit row and the `org_experiment` inbox event.
  - `stop` / `conclude(force)` are the CEO's controls.
  - Also: the brief's Experiments section with "unmeasured change", and
    the retro agenda provider.
- **`server/src/org/org-predictions.service.ts`.**
  - `record`, with supersede.
  - Check-in forecasts through the new `OrgIntentService.onCheckIn`.
  - The first-run duration prompt (`contextFor`).
  - `sweep` / `resolveSubject` resolve forecasts with Brier and normalized
    absolute error.
  - `calibration`, `report` and the brief's Calibration line.
- **`server/src/org/calibration-registry.ts`.** `registerCalibrationProvider`
  and `calibrationOf`, read by `TrustService.calibrationOf`, which is now
  async with `(workspaceId, agentId)`. Promotion holds below
  `trust.calibrationBar`, and a null score never blocks it.
- **`server/src/org/org-reconciliation.service.ts`.** The daily sweep
  checks overclaims and claimed numbers on sourced key results. It also
  derives a check for tasks accepted by review and runs it through
  `OrgSensingService.runAdHocCheck`, giving a `claim_mismatch` signal and a
  minor incident. Finally it recomputes the brief's spend and accepted-task
  counts from SQL aggregates (`report_drift`). It feeds the brief's
  Reconciliation section and the auditor's material through
  `OrgAuditorService.addMaterial`.
- **Seams.** `BriefSection.position: 'improve'`; `reportIncident` accepts
  `severity`, `refType`, `refId` and `cause`; the signal kinds `overclaim`,
  `claim_mismatch` and `report_drift`; the approval kind `experiment`; the
  "improvement as experiments" line in the planning prompt.
- **`server/src/org/experiment-tunables.ts`.** Eight bounded keys in the
  areas `experiments` and `predictions`.
- **`server/src/org/experiments.controller.ts`.** Workspace routes: `GET|POST
  experiments`, `GET experiments/:id`, `POST experiments/:id/start | stop |
  keep | revert` (the CEO), `GET predictions?agentId=&status=`, `GET
  calibration`, `GET reconciliation`, `POST reconciliation/run` (the CEO).
- **Tools.** `org_propose_experiment`, `org_experiments`,
  `org_forecast_outcome`, `org_calibration`.
- **Docs.** `docs/experiments.md`.
- **Tests.** `tests/backend-org-experiments.test.ts` (17 tests, including
  item 28's promotion held below the calibration bar).

Departures (`docs/experiments.md` §8):

- The slice design is recorded but evaluated before/after.
- Charter and structure experiments measure from the approval of their
  change card, and revert through an inverse card.
- Playbook experiments only switch reviewed versions.
- Check-in forecasts are recorded only for sourced key results and agent
  check-ins.
- The latest reconciliation is kept on the audit chain.

### 31. Evals, the self-modification boundary, capacity and the owner's seat (C6, C8, C4, C12) *(done)*
Golden sets per role and gated rollout; the boundary as data; WIP limits,
dependencies and deadline scheduling; decision defaults, delegated
approvals and value accounting.

*Shipped as (2 November 2026, branch `feat/evals`, rebased on item 30):*

**Migration.** `0044-org-evals-boundary`, after 0042 and 0043. It adds:

- `org_eval_cases` and `org_eval_runs`;
- `org_delegations`;
- `org_value_events`, unique on (goalId, kind, sampleId);
- `org_tasks.dependsOn | dueAt`;
- `org_goals.valuePerUnit | valueOnAchieve | valueNote`;
- `org_approvals.recommendedAction | alternatives | reversibility |
  confidence | deadline | defaultAction | decidedVia`.

All are mirrored in `schema.ts`, and every new table carries `accountId`.

**C8, the boundary** (`docs/boundary.md`).

- `server/src/org/boundary.ts` holds the table, `ruleFor` and the pure
  `checkBoundary`.
- `server/src/org/org-boundary.service.ts` (`OrgBoundaryService`):
  - binds the decision into `OrgService.gate` / `boundaryDecide`;
  - on a never-attempt: a `boundary_violation` audit row, a critical
    `audit_finding` signal and a minor `boundary_violation` incident;
  - `experiment` routes to item 30 when `OrgExperimentsService` is present
    (the refusal names `org_propose_experiment`); without it, an approval
    card;
  - `onCheck` / `recent` record every decision.
- The fence (`OrgService.gate`) is called from:
  - in `OrgService`: `setTunable`, `setRouting`, `setScopes`, `setBudget`,
    `acceptCharter`, `update` (audit settings, the fan-out cap, the company
    envelope), `setStatus`, `updateMember`, `terminateMember`;
  - `applyHire`, `setCadence` and playbook `activate`;
  - eval cases and delegations;
  - `TrustService.setCeilings`, through the bridge's `boundary` hook;
  - item 30's tunable experiments.
- The route: `org_tune`, `org_hire_agent`, `org_set_scope`,
  `org_terminate_agent`, `org_reorg`, `org_allocate_budget` and
  `org_set_routing` ask first. A `card` outcome becomes an approval with
  `boundary` on its payload, in every mode. In autonomous mode, raising the
  company envelope is now such a card where it used to be an error.

**C6, evals** (`docs/evals.md`).

- `server/src/org/org-evals.service.ts`:
  - harvest on `OrgTasksService.onAccepted`;
  - `addCase` / `retireCase`;
  - `run`: record-only replays through `TurnLoopService.setSandbox`, the
    candidate in an aux-run context or on the session model, a baseline
    cached per version hash, `reserve`/`settle` of the run cap;
  - file checks graded against recorded `fs_write` calls, the rest by
    `OrgRuntimeService.judge` (extracted from `independentTaskCheck`);
  - gates: `OrgApprovalsService.onBeforeApply('charter_change' |
    'routing')`, `OrgRuntimeService.setRolloutGate`,
    `OrgPlaybooksService.setActivationGate`.

**C4, capacity.**

- `server/src/org/org-capacity.service.ts`:
  - expected duration (median runs and hours per member × class, else per
    class), shown on the board API as `expected`;
  - the overview, and the planning-prompt block;
  - `sweepDue`: `task_overdue` to the owner, then `task_overdue_lead`.
- `OrgTasksService`:
  - the `waiting` status;
  - `resolveDeps` with cycle detection (`wouldCycle`);
  - `releaseDependants`, which wakes with the new `OrgWakeReason`
    `dependency`;
  - `checkWip` (the chief's override is audited as `wip_override`);
  - `claimBlocker`, so the runtime returns `skipped:waiting` or
    `skipped:wip`;
  - `annotate` (`waitingOn`, `expected`).
- The heartbeat ranks overdue, then due-soon work first (`urgencyOf`).

**C12, the owner's seat** (`docs/owners-seat.md`).

- `server/src/org/decision-cards.ts`.
- `OrgApprovalsService`:
  - `cardFields` on `create`, `fillCard`;
  - `onCreated`, `onBeforeApply`, `attach`;
  - `delegateVia`;
  - `decide(…, {via})` with a `delegated_decision` audit row.
- `server/src/org/org-seat.service.ts`:
  - `applyDefaults` on the minute tick;
  - delegations and their matching (`delegationCovers`, `cardDelegable`);
  - an agent-role decision through `judge`;
  - `setGoalValue`, `syncValue`, `outcomes`;
  - `sweepNoOutcome` and the chief's shrink note.
- `OrgBriefService`. Section positions are `outcomes`, `first`,
  `decisions`, `improve` and `end`. The order is Outcomes, then exceptions,
  then decisions and *Decided for you*, then item 30's improve section, then
  `# Activity` (Spend, Work, Autonomous actions, Pulse).

**Runtime seams.** `OrgRuntimeService.addTicker`, `addPlanningNotes` and
`setRolloutGate`.

**Tunables** (`server/src/org/governance-tunables.ts`; areas `boundary`,
`evals`, `capacity`, `seat`):

- `boundary.experimentFallbackCard`;
- `evals.casesPerRole | casesPerRun | runUsdCap | regressionMargin |
  baselineCacheDays | harvestReviewMaxRounds | gate`;
- `capacity.wipPerMember` 3 [1–20] `| historyDays | dueSoonHours |
  overdueEscalateHours`;
- `seat.deadlineHours | noOutcomeWeeks | defaultConfidence |
  defaultApprove.<kind>` (reversible internal kinds only).

**Routes** (`server/src/org/governance.controller.ts`, on
`/api/workspaces/:id/org/…`):

- `GET boundary`;
- `GET|POST evals/cases`, `DELETE evals/cases/:caseId`, `POST evals/run`,
  `GET evals/runs?roleKey=`;
- `GET capacity`;
- `GET|POST delegations`, `DELETE delegations/:delegationId`;
- `GET outcomes`, `GET value-events?since=`;
- `PUT goals/:goalId/value`.

The decide route accepts a covered delegate, and the board route adds
`waitingOn` and `expected`.

**Tools** (`server/src/org/org-governance.tools.ts`, a `ToolProviderHook`,
so they behave the same in every session kind):

- `org_capacity`;
- `org_eval_cases`;
- `org_eval_role`;
- `org_create_task` gains `dependsOn`, `dueAt` and `override`;
- `org_assign` gains `override`;
- the card tools gain `recommend`, `alternatives` and `confidence`.

**Docs:** `docs/boundary.md`, `docs/evals.md`, `docs/owners-seat.md`,
`docs/company-vision.md` §8, `docs/autonomous-org-first-principles.md` §4
and §7, `docs/security.md` §b and §k.

**Tests:**

- `tests/backend-org-boundary.test.ts` (8);
- `tests/backend-org-evals.test.ts` (8);
- `tests/backend-org-capacity.test.ts` (6);
- `tests/backend-org-seat.test.ts` (8);
- the shared harness `tests/org-governance-harness.ts`.

`tests/backend-org-mode.test.ts` changes one assertion: raising the company
envelope is now a card, not an error.

**Departures.**

- "A copy of the member" is the member's own agent in a throwaway sandboxed
  session, with the candidate charter in the run context. No temporary
  agent is created.
- "A strong reviewer verdict" is acceptance within
  `evals.harvestReviewMaxRounds` rounds (default: the first).
- Metric, HTTP and connection checks of a case are graded by the rubric
  grader.
- Retitling a member is a reorg within its unit. The `role` row has no
  agent path yet.
- An over-envelope agent or project allocation is still refused by the cap.
- An agent role decides a delegated card once, when the card is created.
- Charter acceptance by an agent actor is refused at the fence
  (experiment). Charter changes reach agents only through approved cards.
- WIP binds agent actors only. The CEO may assign past it.
- A dependency counts as met only when it is `done`; a cancelled one keeps
  its dependants waiting until the chief edits them.
- Activity sections are grouped under one `# Activity` heading rather than
  removed.

### 32. SPA for items 27–31 *(planned)*
