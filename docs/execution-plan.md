# Execution plan: closing the competitor gaps, all of them

Status: **in progress**. Started 31 October 2026 from the roadmap delta in
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
and `tests/backend-security.test.ts`; the Settings → Security pane that
renders it is still to be wired in `SettingsView.tsx`.

### 4. Browser tool *(todo)*
`browser_open`, `browser_act` (click/type/scroll/select by text), `browser_read`
(readable text + links), `browser_screenshot`. Two backends behind one
interface, like the code runner: Cloudflare Browser Rendering (hosted) and
local Playwright (`playwright-core`, optional). Credential-free: no cookie
jar persists across sessions, no password fields are filled, egress through
the SSRF guard. Viewable: every step's screenshot streams to the artifact
panel as a live "Browser" tab, and the session ends with the turn.

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

### 7. Paid cloud with tenancy *(todo)*
`accountId` on every table, a `SessionAuthStrategy` (email + magic link, or
the suite's account service when configured), per-account plan
(`free|hosted|byo`), usage in dollars with the Phase-1 price table, BYO
provider keys per account, hard stop on plan ceilings. Single-user mode stays
the default for self-hosting: `AUTH_MODE=single` keeps `SINGLE_USER`.

### 8. Shared agents *(todo)*
Workspace members with roles (`owner|member|viewer`), per-member connection
grants, per-member memory visibility (lessons and profile entries carry an
`audience`), approvals routed to the member whose grant the tool uses, and
information-flow rules on what one member's content may reach another.

### 9. Portability *(todo)*
AGENT.json gains lessons, skills, profile, tasks; importers for Claude
memory export, Muse data export, Hermes `MEMORY.md`/`USER.md`; agentskills.io
`SKILL.md` import with a scan step (size, URLs, instruction-smell) before
the skill enters `draft`.

### 10. Skill outcome tracking *(todo)*
Each turn records which skills it used; ratings attach to those skills;
Skills page shows last used, use count, 👍/👎 rate; a 👎 on a skill turn
produces a draft revision with a diff.

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

### 12. Market registry *(todo)*
A registry: publish an agent (AGENT.json), skill, or mini app with mandatory
capability review on install; install counts; ratings from the feedback we
collect; remote registry URL configurable so self-hosted instances can pull
from the hosted one.

### 13. Desktop computer control *(todo)*
A paired companion runner (`companion/`, Node CLI) on the user's machine that
connects outbound to the API with a pairing code and exposes
`computer_screenshot`, `computer_click`, `computer_type`, `computer_key`,
`computer_shell`, `computer_read_file`, `computer_write_file` behind
per-runner scopes (screen, input, shell, folders). Always Ask-gated, never
from channel turns, with an audit row per action and a kill switch in
Settings → Computer.

### 14. Autonomous company *(research running)*
Designed after the second research thread lands. Expected shape:
organisations with roles and reports-to, a chief-of-staff agent with
`hire_agent`, `set_scope`, `reorg`, `audit`, hierarchical budgets, a shared
group session, org-level goals and board, an audit log, and a CEO brief.

## Also in scope
- Correct the doc/code mismatches listed in `docs/competitor-gap-analysis.md`
  §6 (roadmap AGENT.json claim, Phase 2 status, Telegram one-way).
- Rewrite `docs/roadmap.md` §2 and §4 against the competitor matrix.
