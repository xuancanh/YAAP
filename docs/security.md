# Security and threat model

Status: **published**, 31 October 2026 (execution plan item 3). This is the
public statement of what yaam-chat defends against, how, and where it does
not. It is written from the code as it is on `main`, not from the roadmap:
every claim below names the file that enforces it, and the gaps in §i are
things the code does not do yet. `SECURITY.md` at the repository root points
here, and `GET /api/security` serves the headline summary and the disclosure
contact so the hosted product can show the same policy.

When a sentence here and the code disagree, the code is the bug or the doc
is; either way, tell us (§j).

## a. Scope and what the product is

yaam-chat is a chat workspace for **durable agents**: named agents with a
charter, a working folder, scheduled loops, skills, mini apps, and
connections to a user's calendar, mail and files. It is a single
codebase — a React SPA (`src/`) talking only to a NestJS API
(`server/src/`) over `/api`, with Postgres for state and S3-compatible object
storage for files. Agents reason with a model provider the user chooses and
keys the user supplies (`agent_types.apiKey`).

Two distributions are planned (`docs/deployment.md`): a free desktop app and
a paid multi-tenant cloud. **What runs today is the single-user, self-hosted
shape**: one API process, one operator, no user accounts. This document
covers that shape and says explicitly where the cloud shape will need more.

In scope: the API, the SPA, the agent tool surface, the mini-app bridge, the
code runner, the Telegram channel, MCP client behaviour, memory and learning,
and the data at rest the server holds. Out of scope: the security of the
model providers, MCP servers, Google and Microsoft tenants the user connects,
and the user's own machine or browser.

## b. Assets and trust tiers

**What we protect**, in order of blast radius:

1. Credentials the server holds: provider API keys, OAuth refresh tokens for
   Google/Microsoft connections, MCP OAuth tokens, the Telegram bot token,
   S3 and database credentials.
2. The agent's **brain**: `AGENT.md`, `LESSONS.md`, memory files, the
   lessons table, the user profile. A poisoned instruction here outlives
   every turn.
3. Workspace and agent files, chat history, task boards, connection data
   read into context.
4. Money: tokens spent on the user's keys, especially by unattended work.
5. The user's name: anything sent outward on their behalf (mail, calendar
   invites).

**Who and what we trust**, from most to least. Trust follows the surface a
piece of text arrived on, never the text itself.

| Tier | Surface | Trust | Where enforced |
|---|---|---|---|
| User | Typed into the app's chat, approvals clicked in host chrome | Full. The user is the only principal. | `AuthGuard` + `TokenAuthStrategy` |
| Agent (own turn) | The model's reasoning and tool calls in a user-originated turn | Trusted to *propose*; every mutation passes the Ask/Auto policy | `turn-loop.service.ts` `checkPolicy` |
| Loop | A scheduled prompt the user wrote, run unattended | Trusted as a source of lessons; **background** for actions — outward mutations and code execution queue instead of running | `turn-loop.service.ts` (`origin === 'loop'`), `loops.service.ts` |
| Channel | A Telegram message from the one paired chat | Untrusted input. Ask mode; gated tools auto-denied; lessons quarantined | `channels/telegram.service.ts`, `agent-memory.service.ts` |
| Channel (email) | Mail to `<slug>@EMAIL_DOMAIN` from a paired owner address, via the HMAC-signed webhook | Untrusted input. Ask mode; gated tools auto-denied; body wrapped as `<email>` data; lessons quarantined | `channels/email.service.ts` (`verifySignature`, `handleInbound`), `agent-memory.service.ts` |
| Email (unpaired sender) | Mail from any other address | Not input at all. One pairing auto-reply per sender per day, then dropped; bounces and auto-replies never answered | `channels/email.service.ts` (`isAutomatedMail`, `prompted`) |
| Push subscription | A browser that subscribed in Settings → Channels | Output only. Receives inbox events; cannot send anything in | `push/push.service.ts` |
| Companion | The one `yaam-companion` process the user paired on their own machine (`docs/computer-control.md`) | Trusted to **act within the scopes the user typed at pairing**, and only on actions the user approved in the app. Authenticated by a hashed bearer on four routes; cannot reach any user route; scopes only narrow server-side; refused outright from loop/channel turns | `computer/computer.service.ts`, `computer/companion.guard.ts`, `checkPolicy` |
| App | A mini app calling `agent.ask` or any bridge op | Untrusted code. Ask mode; gated tools auto-denied; jailed writes; rate-limited; lessons quarantined | `appbridge/*`, `src/lib/sandbox.ts` |
| MCP server | A third-party tool server the user enabled | Opaque side effects. User activates per server; every call gates in Ask mode | `mcp/mcp.module.ts`, `checkPolicy` |
| Web and connection content | `web_fetch`, `web_search`, `http_request` bodies; mail, calendar, drive content | Data. Can influence what the model proposes, never what runs | `connections.tools.ts` framing, the approval gates |
| Loop output | Journal entries and events a loop wrote | Visible to the user as events; a lesson only through the trusted-source distillation path | `agents.service.ts` `addEvent`, `distill.service.ts` |

The principle that ties the table together: **an untrusted surface may
propose, it may never act or teach**. Channel and app turns can ask for a
mutation and be denied; they can produce a lesson and have it quarantined;
they cannot approve anything, because approvals exist only in the app.

## c. Isolation model

**No host.** Agents do not have a shell, a filesystem, or a process. Every
capability is a verb we implemented: `fs_*` over object storage,
`web_fetch`/`http_request` through the SSRF guard, curated connection verbs,
MCP over HTTPS, and two code-execution tools whose only runtime is a
sandbox. The only `child_process` use in `server/src` is
`runner/runner.service.ts`, and the only thing it spawns is an interpreter
inside `sandbox-exec` or `bubblewrap`. There is no `eval`, `new Function`
or `node:vm` anywhere in the server.

**One paired hole in that wall, shaped by the user.** Desktop computer
control (`docs/computer-control.md`) lets a user run `yaam-companion` on
their own machine and give agents `computer_*` tools. The server still has
no path *into* that machine: the companion connects outbound and long-polls
for work, authenticated by a 256-bit token stored only as a sha256 and valid
on exactly four routes. Scopes (`screen`, `input`, `shell`, `files:<dir>`)
are chosen on the companion at pairing and can only be narrowed afterwards;
every action is scope-checked on the server before queueing and again on the
companion (realpath, no symlink escapes). Every computer tool is
mutation-class and pauses in every mode; the acting ones (click, type, key,
shell, write) can never be remembered; loop and channel turns are refused
with an inbox note. Every action — including refusals — is a
`computer_actions` audit row. Kill switches: `COMPUTER_CONTROL_ENABLED=false`,
Disconnect (token revoked at once), Pause, and stopping the companion.

**Object-storage prefixes are the file boundary.** Workspace files live
under `workspaces/<id>/`, agent files under `agents/<id>/`
(`storage/storage.keys.ts`). Every user- or model-supplied path goes through
`cleanSegments`: no traversal, no absolute paths, printable segments only.
Within an agent's prefix, `.checkpoints/` (daily snapshots of the brain
files) is write-protected even from the agent, and a mini app's writes are
confined to `agents/<id>/apps/<appId>/` — never where the agent keeps its
instructions (`app-bridge.service.ts`). `files.propose` refuses `AGENT.md`,
`LESSONS.md`, `JOURNAL.md`, `AGENT.json` and the `knowledge/`,
`.checkpoints/`, `apps/` and `skills/` prefixes outright.

**Files served inert.** `GET /api/workspaces/:id/file` sets
`X-Content-Type-Options: nosniff` and forces `Content-Disposition:
attachment` for active content types, so an agent-written HTML file can
never execute on the API or SPA origin. In-app previews go through the JSON
`/preview` endpoint into a sandboxed iframe.

**Sandboxed iframes with a real CSP.** Every iframe we render — mini apps,
chat artifacts, HTML and PDF previews — carries `sandbox="allow-scripts"`
*and* a `default-src 'none'` Content-Security-Policy injected by
`src/lib/sandbox.ts`. The attribute makes the frame opaque-origin; the CSP is
what denies network (`connect-src`, remote `script-src`, `img-src` beacons,
`form-action`, `base-uri`). Only inline script/style, `'unsafe-eval'` (for
WebAssembly and chart helpers; it cannot cross the boundary), and
`data:`/`blob:` media are allowed. The `window.yaam` bridge validates
`e.source` on every message, and the server re-derives every capability
grant from the stored manifest per call — the frame is never trusted to
report its own permissions.

**Code runner backends.** `run_js` / `run_python` (and the app bridge's
`compute.run`, which is the same service) execute in one of two places:

- *local*: macOS `sandbox-exec` with a generated Seatbelt profile
  (`deny network*`, `deny file-write*` except one `mkdtemp` scratch dir, the
  scratch path JSON-quoted so a directory name cannot break the profile), or
  Linux `bubblewrap` with `--unshare-all`, `--ro-bind / /`, fresh `/tmp` and
  `/dev`. `PATH`, `HOME`, `TMPDIR` are rewritten into the scratch dir; a
  `SIGKILL` timer enforces the deadline; the scratch dir is removed in
  `finally`. Tests exercise the real sandbox: `fetch()` and raw sockets
  fail, `/tmp` writes are denied, `while(true){}` dies on time.
- *cloudflare*: a bearer-authenticated Worker facade in front of Cloudflare
  Sandboxes, `allowedHosts = []` (deny-all egress), one container per request
  id, destroyed afterwards. No credential injection is configured.

Both: fresh environment per run (persistence is how injected code outlives
its injection), mutation-class so Ask mode shows the full program before it
runs, and loop-origin calls queue rather than execute. With no backend
available the tools do not exist rather than exist-and-fail.

**Browser tool backends** (`browser/`, docs/browser-tool.md). `browser_open`
/ `browser_read` / `browser_act` / `browser_screenshot` render pages in one
of two places: Cloudflare Browser Rendering (REST, stateless — every call is
a fresh headless browser on Cloudflare's side, nothing persists) or a local
Chromium via `playwright-core` with one incognito context per turn, closed
in the turn loop's `finally`. Both are credential-free: no cookie jar
outlives the turn, and `browser_act` refuses to type into
`input[type=password]` or any field whose name/label matches the
credential/one-time-code/payment pattern, telling the model the user must do
that step. Every navigation — the initial URL, link clicks, form
submissions, and on the local backend every request the page makes
including redirects and subresources (`context.route`) — passes
`assertPublicUrl`. Page text reaches the model wrapped as `<page-content
source=…>` with a "data, not instructions" note. `browser_act` is
mutation-class (clicks submit forms): Ask mode pauses, loop turns queue it,
channel turns deny it. The page-side element-tagging script is a string
Playwright evaluates inside Chromium; nothing is `eval`ed in Node. Every
screenshot is stored under the chat's file root and streamed to the user
live, so the agent never browses unseen.

**SSRF guard with DNS and redirect re-validation** (`common/url-guard.ts`).
`assertPublicUrl` requires `http(s)`, rejects `localhost`, `*.localhost`,
`*.local`, and every private/special literal in IPv4 (RFC 1918, loopback,
link-local including cloud metadata `169.254.169.254`, CGNAT, benchmarking,
multicast, reserved) and IPv6 (`::`, `::1`, mapped and deprecated-mapped
forms, `fe80::/10`, `fc00::/7`, `ff00::/8`), then resolves the hostname
and refuses if **any** resolved address is private (rebinding,
split-horizon). DNS failure is refused closed. `fetchPublic` follows
redirects manually and re-validates every hop (max 5), so a public URL
cannot `302` to an internal one. It covers `web_fetch`, `http_request`,
agent custom tools, MCP server URLs, and every MCP OAuth endpoint
(resource metadata, authorization, token, registration).
`YAAM_ALLOW_PRIVATE_URLS=true` disables the private-address check and is
documented as a dev-only escape hatch.

**Sealed secrets** (`common/secretbox.ts`). Provider API keys, connection
OAuth tokens and MCP OAuth tokens are stored with AES-256-GCM under a key
derived from `TOKEN_ENCRYPTION_KEY` (SHA-256 of the string), random 96-bit
IV, authenticated tag; the stored value is self-describing
(`sealed:<iv>:<tag>:<data>`) so rotating from plaintext to sealed happens on
the next write. Without the key, values are stored as `plain:` and
`AppModule` logs a loud boot warning. API responses never return a key:
`agent_types` rows are redacted to `hasApiKey: true|false`. Custom HTTP
tools carry no headers or keys by design — a secret inside an agent-authored
artifact is exfiltratable by construction.

**API boundary.** `TokenAuthStrategy` requires `Authorization: Bearer
<YAAM_API_TOKEN>` on every `/api` route when the token is set; only
`GET /api/status` (readiness) and `GET /api/security` (this policy) are
public. CORS is an explicit allowlist (`YAAM_CORS_ORIGINS`); requests without
an `Origin` header pass, which is correct for same-origin and server-to-server
and is why the token exists. A global `ValidationPipe({ whitelist: true })`
strips unknown body fields; the JSON body limit is 25 MB. Environment is
validated at boot with zod; production refuses to start on dev database or
S3 credentials.

## d. The approval taxonomy as implemented

Every tool call in a turn gets one verdict from `checkPolicy`
(`chats/turn-loop.service.ts`), in this order:

1. **Unknown tool** (no owner recognises the name): `ask`, never remembered.
   Unknown names and malformed arguments are refused, not executed.
2. **Confirm-always**: `gmail_send`, `msmail_send`. Pause in host chrome on
   every call, in every mode — Auto mode and remembered approvals never
   apply. The card shows recipient, subject and body.
3. **Auto mode** (a per-chat opt-in): everything else runs (`auto`), subject
   to the loop and channel rules below.
4. **Read-only** (`read-only`): runs without asking in Ask mode. Read-only
   today means: `fs_list`, `fs_read`, `fs_search`, `web_search`,
   `web_fetch`, `browser_open`, `browser_read`, `browser_screenshot` (public
   web reads through the SSRF guard, no credentials to spend), every skill
   (invoking a skill only loads text), `list_tasks`,
   `search_history`, connection reads (`gcal_search`, `gcal_upcoming`,
   `gcal_freebusy`, `drive_search`, `drive_read`, `drive_export_*` and the
   `mscal_*`/`msdrive_*` equivalents), and the **proposal-only**
   tools `update_user_profile`, `draft_skill`, `save_tool`, whose entire
   effect is to queue something for human review — the gate is the review,
   not the call.
5. **Remembered** (`remembered`): the chat previously answered
   *allow-always* (exact arguments, keyed by `sha256` of the input) or
   *allow-tool* (any arguments) for this tool. Grants are per chat; nothing
   is inherited across chats or agents.
6. **Ask** (`ask`): everything mutating — `fs_write`, `fs_delete`,
   `slides_create`, `http_request`, agent custom tools, `run_js`,
   `run_python`, `browser_act` (a click or keystroke can submit a form),
   connection writes (`gcal_create_event`,
   `gcal_update_event`, `mscal_*_event`, `gmail_draft`, `msmail_draft`), the
   self-modification tools `update_dashboard` and `save_app`, and **every
   MCP tool** — the server behind an MCP tool is opaque, so MCP never
   auto-runs in Ask mode regardless of what it claims to be.

Two refinements on remembering: `SELF_MOD` tools (`update_dashboard`,
`save_app`) can be allowed once or for exact arguments but never blanket
*allow-tool*; and a pending approval auto-denies after 10 minutes or when the
client disconnects (`APPROVAL_TTL_MS`, the abort listener), so an orphaned
question never becomes a yes.

**Origin overrides the mode.**

- **Loop turns** (`origin: 'loop'`): connection mutations, both runner
  tools and `browser_act` are not executed at all, in any mode. They are recorded as an
  `action_pending` event in the agent's inbox with the exact tool and input,
  and the model is told to report what it queued. The user approves, runs
  or dismisses from the inbox (`action_done`, `action_failed`,
  `action_dismissed`).
- **Channel turns** (Telegram, email) and **app turns** (`agent.ask`): the
  session is created in Ask mode (`Telegram · <agent>`, `Email · <agent>`,
  `App · <agent>`) and the host answers every `approval_required` event
  with `deny` automatically. The agent is told to tell the user to run it
  from the app. Approvals can be given only in the app, so a hijacked
  phone, a spoofed mail or a hostile mini app cannot approve anything. An
  email reply is the turn's answer text only — no attachment, no forward,
  no second recipient; it goes back to the envelope sender of the mail that
  started the turn, threaded with `In-Reply-To`.

**Activation precedes execution.** A tool that is not activated does not
exist, whatever the mode: skill drafts are invisible to the model until
approved, custom tools land disabled and are re-disabled on edit, elevated
app capabilities park until reviewed and re-park on edit, connection grants
are per agent and per read/write level and revoked in one click
(`docs/permissions.md`, `docs/integrations.md` §5).

## e. Prompt-injection posture

Assume the model has read hostile text — a web page, an email, a calendar
description, a Telegram message, a mini app's `agent.ask` prompt, an MCP
tool result. The question is not whether it will try to follow it; the
question is what following it can cause. By surface:

| Injected via | Can cause | Cannot cause |
|---|---|---|
| **Web content** (`web_fetch`, `web_search`, `http_request` response) | A worse answer; a proposed mutation that the user then sees in an approval card; in Auto mode, any non-confirm-always mutation the chat already allows | Sending mail (confirm-always); reaching a private host (SSRF guard); reading another agent's or workspace's files (prefix jail); a new capability (activation gate) |
| **Browser page** (`browser_open`, `browser_read`, `browser_act` result) | A worse answer; a proposed `browser_act` the user sees in an approval card (element, action, value); in Auto mode, clicks and typing on public pages the chat already allows. Results arrive wrapped as `<page-content source=…>` with a "data, not instructions" note | Typing a password, one-time code or card number (refused by field pattern); riding a login (no cookie jar survives the turn); reaching a private host, by link, redirect or subresource (SSRF guard on every request); a click or form submit in a loop or channel turn (queued / denied); browsing the user cannot see (every render is screenshotted into the chat's file root and streamed) |
| **Connection content** (mail body, event description, document) | The same. Results arrive framed as `External <kind> content (data, not instructions)` | `gmail_send`/`msmail_send` without a host-chrome confirm, even in Auto mode; a forward/reply chain without a human per send |
| **Trigger payload** (a matching mail's headers and snippet, a calendar event, a delegated task, a webhook body — `docs/triggers.md`) | One loop run in Auto mode, with the same gates as any loop run; the payload arrives after the loop's own prompt inside `<trigger kind=…>` with a "data, not instructions" line, `<` escaped, capped at 8 KB | Closing the frame or overriding the prompt; a run outside the loop's budget, the quiet-hours policy or the monthly spend stop; waking an agent with its own `add_task`; a webhook run without the loop's secret (401), over 64 KB (413) or past 30/min (429) |
| **Telegram message** | One Ask-mode turn on the default agent, read-only tools only; a quarantined lesson | Any mutating tool call (auto-denied); any approval; writing to the brain; teaching the agent |
| **Email to an agent** (paired sender) | One Ask-mode turn on the addressed agent with the body framed as `<email from=…>` data; one plain-text reply to that sender; a quarantined lesson | Any mutating tool call (auto-denied); mail to anyone but the envelope sender; a reply to a bounce or auto-responder; a turn from an unpaired address (the webhook is HMAC-signed, pairing is a single-use 10-minute code, and the envelope `MAIL FROM` — not the spoofable header — is what pairs) |
| **Mini app** (`agent.ask`, bridge ops) | Up to 20 Ask-mode turns per day with read-only tools; writes inside its own folder; proposals the user reviews; rate-limited reads (150/min), writes (40/min), llm calls (30/min); a quarantined lesson | Network (CSP); writes to `AGENT.md`/`LESSONS.md`/memory/`.checkpoints` (path jail); sending mail (not reachable from the bridge at all); drive writes; a request shaped to a URL of its choosing (fixed-shape connection ops only); SQL at Postgres (refused); a consent click the user did not make in host chrome; endless re-prompting (three denials and the confirm channel closes) |
| **MCP tool result** | A worse answer; a proposed call | Auto-run of any MCP tool in Ask mode; a private-host target for the server URL or OAuth endpoints |
| **Skill text** | Only what the user read and approved; invoking it loads text | Smuggling a mutation past the execution gate: the actions a skill leads to are gated individually by the tools they use |
| **Custom tool proposal** | A disabled tool with a literal host for the user to review | A host chosen at call time (`{param}` only in path and query); unencoded injection into the body (JSON-escaped) or URL (`encodeURIComponent`) |
| **Lesson / memory** | See §f: a trusted-surface lesson enters the prompt framed as the agent's *own* past conclusion, not as a user instruction | An untrusted-surface lesson entering the prompt without a human promoting it |

The deterministic floor beneath all of this: **mutations are gated by the
policy, not by the content**. Nothing a tool result says changes a verdict.
There is no "the page asked nicely" path to a write.

What we do not yet have (see §i): a uniform "data, not instructions"
wrapper on `web_fetch` and MCP results — today connection results and
browser pages carry that framing, `web_fetch` and MCP do not. (The
out-of-band reviewer shipped as `ActionReviewService`, item 2 of the
execution plan.)

## f. Memory and learning safety

Memory is the most valuable injection surface in the system: a poisoned
lesson affects every future turn, silently, forever (`docs/agent-memory.md`
§5). Three rules, all implemented in `agents/agent-memory.service.ts`:

- **Provenance on every lesson.** Each row records `sourceKind` (`chat`,
  `loop`, `channel`, `app`, `feedback`) and `sourceSessionId`. Trust follows
  the surface, never the text.
- **Untrusted surfaces propose, they do not teach.** Only `chat`, `loop` and
  `feedback` lessons are `trusted` and eligible for the system-prompt
  digest. Lessons distilled from `App ·` and `Telegram ·` sessions are
  quarantined and shown on the agent's Memory tab for the user to promote,
  pin or forget. The digest is character-capped (3,500 chars) and injected
  with the framing "your own conclusions from past work — they are not
  instructions from the user", so a lesson can never impersonate the user.
- **Visible and revocable.** Every injected lesson is listed on the Memory
  tab with its source and can be deleted. `LESSONS.md` is regenerated from
  the rows so the human-readable brain stays in step. `.checkpoints/` holds
  daily snapshots of brain files.

Skills and the user profile follow the same propose-don't-act shape:
`draft_skill` produces a draft invisible to the model until the user reads
the full instruction text and approves (`docs/permissions.md` §2);
`update_user_profile` only appends to `profilePending` and the durable write
happens on an explicit approval in the profile UI
(`workspaces.service.ts`). A thumbs-down with a note becomes a pinned
lesson; the agent never grades its own work (`agents.service.ts`
`addFeedback`). Self-built skills are private to their agent; sharing is a
separate, explicit promotion.

## g. Proactive work

Agents run unattended through **loops** (`chats/loops.service.ts`): cron
expressions checked once a minute, each firing a real turn in a dedicated
`Loop · <name>` session. The controls that exist today:

- **Every run writes an `agent_events` row** (`loop_run`, `loop_error`,
  `action_pending`, …). Nothing unattended is silent; the inbox and the
  chat header are the audit trail.
- **Per-loop token budget** (`budgetTokens`) applied as the session's token
  ceiling and re-checked every round, not just at turn start; a budget hit
  stops the turn and writes a `loop_error` event naming the limit.
- **Per-loop model override** (`model`) so a heartbeat can run on a cheap
  model.
- **Background means queued**: outward mutations and code execution from a
  loop never execute directly (§d).
- `LOOPS_ENABLED=false` is a master switch.

Delivery of those events beyond the inbox (execution plan items 1 and 5):
the Telegram sweep, the email sweep or daily digest (`emailDigest`, off by
default) and the web-push sweep each own a delivered-at column on
`agent_events`, honour `deliverAfter`/`silent` from quiet hours, and never
echo channel-born events back to a channel (`docs/channels.md`).

## h. What we never do

Grounded in `docs/competitor-gap-analysis.md` §(c), these are refusals, not
backlog items. If a future change needs one of them, this document changes
first and says why.

- **No shared per-user computer, and no ambient host access.** Agents have
  no shell and no filesystem of their own; isolation is the architecture,
  not a setting. The one way to a real machine is the user's own, explicitly
  paired companion (`docs/computer-control.md`): outbound-only, scoped by
  the user at the keyboard, every action approved in the app with the
  acting tools never auto-approvable, audited, revocable in one click. There
  is no server-side computer, no computer shared between agents, no inbound
  port, and no action from a loop or channel turn. If a browser tool lands it
  is per-run and credential-free, never a persistent desktop. A sandbox
  backend never skips the Ask gate.
- **No autonomous memory writes without provenance.** Nothing enters the
  prompt from a surface the permission model distrusts without a human
  promoting it, and nothing enters the profile without a human approving
  it. We do not add an `auto` option for either, because defaults are what
  users run.
- **No memory the user cannot see or delete.** Every lesson and profile
  entry is on a tab with a delete button. No channel, app or routine writes
  memory outside that view.
- **No enumerable share links.** When sharing ships, links are
  capability tokens or authenticated on a single origin, revocable, never a
  subdomain per share, never indexed.
- **No plaintext secrets as the design.** Secrets are sealed at rest when a
  key is configured and redacted in every response; the `plain:` fallback
  exists only so local development works with zero setup and announces
  itself at boot.
- **No self-graded skills.** Skills are approved by a person who read them;
  ratings are the user's, attached to the turn.
- **No silent background spend.** Loops have budgets enforced before the
  call, every run is an event, and the model used is visible on every turn.
- **No training on user data.** With bring-your-own keys we see no model
  traffic at all; this stays true when platform-metered access arrives.
- **No credentials inside agent-authored artifacts.** Custom tools carry no
  keys; a future vault binds a named credential at activation and injects it
  server-side, never visible to the model.

## i. Known gaps and limitations

Honest list, as of this writing. Several map to execution-plan items.

- **Computer control trusts the user's machine and the OS tools on it.**
  `shell` is the user's shell with the user's permissions; `input` types into
  whatever has focus; a screenshot is untrusted content the model reads. The
  gates are the per-call approval, the scopes and the audit — not a sandbox.
  Linux and Windows companion back-ends are implemented from documentation
  and untested; the work queue is in-process and one companion per server
  (`docs/computer-control.md` §7–8).

- **Single-user auth is the default and the only shipped model.** Every
  request resolves to one identity (`SINGLE_USER`); tables are
  workspace-scoped with no user column. Without `YAAM_API_TOKEN` the API is
  unauthenticated, which is only acceptable bound to localhost. The
  `AuthStrategy` seam exists; tenancy does not (plan item 7).
- **No independent action review.** Gates are deterministic; nothing
  compares a proposed `gmail_send` to what the user asked for, and there is
  no sensitive-information check on outbound content (plan item 2).
- **Framing is uneven.** Connection results are wrapped as "data, not
  instructions"; `web_fetch`, `web_search`, `http_request` and MCP results
  are not.
- **Sandbox strength depends on the backend.** The local runner relies on
  the OS (Seatbelt on macOS, bubblewrap on Linux) and on an interpreter it
  does not control; the Cloudflare backend relies on Cloudflare Sandboxes'
  container isolation. Neither has had an external review.
- **No formal audit, pen test or bug bounty yet.** This document and the
  test suite are the current evidence.
- **The `plain:` secret fallback exists.** A hosted deployment that forgets
  `TOKEN_ENCRYPTION_KEY` stores tokens unencrypted; the only guard is a boot
  warning.
- **`YAAM_ALLOW_PRIVATE_URLS` is a full SSRF bypass** when set. It is a
  documented dev switch; nothing stops it being set in production.
- **Rate limits and budgets are in-process memory.** App daily ask
  budgets, bridge rate windows and the approval registry reset on restart,
  and will need shared state for multi-replica cloud.
- **Telegram is one paired chat with no message signing beyond Telegram's
  own transport.** The bot token is the trust root; pairing codes are
  10-minute, single-use.
- **Email pairing trusts the envelope sender.** `MAIL FROM` is far harder
  to spoof than the header `From`, and the forwarder reports it, but a mail
  provider that does not enforce SPF/DMARC on inbound could still be
  tricked. The blast radius is one Ask-mode turn and a reply to the spoofed
  address — never an approval. The HMAC webhook secret is the trust root for
  inbound; the sending API token for outbound.
- **Web push payloads are encrypted end to end (RFC 8291) but the push
  service sees timing and size.** Titles are an agent name and an event
  title; bodies are capped at 240 characters.
- **MCP servers are trusted to be honest about their tool schemas.** We gate
  every call, but a malicious server's results are untrusted text with no
  wrapper (see framing above) and `stdio://` servers are deliberately
  unsupported.
- **`'unsafe-eval'` and `'unsafe-inline'` are in the iframe CSP** by
  necessity (single-file apps, WebAssembly). The wall is the opaque origin
  and the denied network, not the script policy.
- **Loop budgets are tokens, not dollars, and per loop, not per workspace.**
  There is no workspace-level hard stop and no quiet hours yet (plan item 1).
- **No signed audit log.** `agent_events` is the record of unattended work;
  it is a normal table the operator can edit.

## j. Reporting a vulnerability

Email **`security@<your-domain>`** — the operator of a deployment sets the
real address with `SECURITY_CONTACT` in the environment, and it is published
by `GET /api/security` and in Settings. If you are reading this on the
repository and no deployment-specific address is set, open a private
security advisory on the GitHub repository instead of a public issue.

Please include: the affected surface (API route, tool, bridge op, channel),
steps to reproduce, and what an attacker gains. Do not include real user
data or credentials you may have encountered; describe them.

**What to expect:** acknowledgement within **3 business days**, an initial
assessment within **10 business days**, and a fix or mitigation plan for
confirmed issues within **30 days** of acknowledgement, with credit in the
changelog below if you want it. We will tell you when the fix ships.

**Safe harbour.** Good-faith research against your own deployment or a test
instance — including reading this document and probing the behaviours it
describes — will not be met with legal action by the maintainers, provided
you avoid accessing or modifying other people's data, do not degrade a
service others depend on, and give us a reasonable window before public
disclosure. Testing against a hosted instance you do not operate requires the
operator's permission.

## k. Changelog of security-relevant changes

From `git log`, newest first. Dates are commit dates.

| Date | Commit | Change |
|---|---|---|
| 2026-11-01 | this | Desktop computer control: paired outbound companion, hashed companion token on four routes (`CompanionGuard`), user-chosen narrow-only scopes, every `computer_*` tool Ask-gated in every mode with acting tools never remembered, loop/channel refusal, `computer_actions` audit, Pause/Disconnect/`COMPUTER_CONTROL_ENABLED` kill switches (`docs/computer-control.md`) |
| 2026-10-31 | this | Email channel (HMAC-signed inbound webhook, envelope-sender pairing, `<email>` framing, quarantined lessons) and web push (VAPID + aes128gcm on node:crypto); `POST /api/channels/email/inbound` the second non-GET public route |
| 2026-10-31 | browser | Credential-free, viewable browser tool: Cloudflare Browser Rendering / local Playwright, incognito per turn, password-field refusal, SSRF guard on every request, `<page-content>` framing, `browser_act` mutation-class and loop-queued |
| 2026-10-31 | this | `docs/security.md`, `SECURITY.md`, `GET /api/security`, `SECURITY_CONTACT` |
| 2026-08-02 | `8c844c2` | Auth guard behind a swappable `AuthStrategy` seam; `GET /api/status` the only public route |
| 2026-08-02 | `a1456db` | Memory with provenance: lessons table, trusted vs quarantined sources, visible and revocable digest |
| 2026-08-02 | `5e7bc15` | Mini-app connections by fixed shape (no app-shaped requests), compute over the sandboxed runner |
| 2026-08-02 | `57ef204` | Per-app bridge rate limits (sliding window per op class) and read provenance |
| 2026-08-02 | `befe9fc` | Iframe sandbox sealed: `default-src 'none'` CSP on every frame, PDF preview sandboxed, full skill text at hire review, JSON-escaped custom-tool bodies, denial quota on confirms |
| 2026-08-02 | `e152db3` | Tier-1 code execution: Seatbelt/bubblewrap local sandbox and Cloudflare Sandboxes, mutation-class, loop-origin queuing |
| 2026-08-01 | `fd4137f` | Provider API keys sealed at rest with AES-256-GCM (`secretbox`) |
| 2026-08-01 | `021b108` | Real SSRF guard: literal IP forms, DNS resolution checks, redirect re-validation, MCP and OAuth endpoint coverage |
| 2026-08-01 | `713157a` | Optional bearer auth (`YAAM_API_TOKEN`), CORS allowlist, inert file serving (`nosniff`, attachment for active types) |
| 2026-08-01 | `b57d67a` | Fail-fast env validation; boot warning when the encryption key is missing |
| 2026-08-01 | `b51b3db` | Outbound provider and MCP fetches bounded by timeouts |
| 2026-08-01 | `a9634eb` | Approval TTL auto-deny; client disconnect aborts the turn |
| 2026-08-01 | `e61a5d3` | MCP OAuth 2.1 client (PKCE, discovery) |
| 2026-08-01 | `07ddcc7` | Calendar write tier; loop-origin connection mutations queue as `action_pending` |
| 2026-07-18 | `60bcf17` | Permission model for agent-built things: skills as drafts, custom tools disabled until reviewed with literal hosts, SELF_MOD tools excluded from blanket grants |
| 2026-07-17 | `8610f27` | Tool loop with Ask/Auto approvals: read-only auto-runs, mutations pause, remembered grants per chat |
