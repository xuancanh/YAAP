# External service integrations: which, how, and the agent surface

Research + design note, July 2026. Answers three questions: which services
to integrate (calendar, mail, drive, docs, ...), what the connect experience
should be, and how connected services are exposed to agents under the
three-gate permission model (docs/permissions.md).

## 1. What the catalog actually needs

The demand signal is already in our own packs. Auditing the 71-pack catalog
for the external systems their playbooks assume:

| Need | Packs that assume it (sample) | Today's workaround |
|---|---|---|
| **Calendar** (read + write) | Executive Assistant (morning briefing), every renewals-radar loop (Car Keeper, Insurance Agent, Landlord), Family Organizer, Tutor Studio, Practice Admin, Event/Wedding Planner | agent keeps its own markdown calendar; user re-types their real one |
| **Email** (read, draft, send) | every chase ladder (Freelancer, Landlord, Tax Season, Trades), Executive Assistant triage, Job Hunt Coach, Agency Recruiter outreach | agent drafts text in chat; user copy-pastes into their mail client |
| **Files/Drive** (read, search) | Deck & Doc Studio, Paralegal matter files, Bookkeeper documents, Genealogy sources, every "the client sent it" flow | upload attachments by hand |
| **Docs/Sheets** (create, edit) | all deliverable-producing packs (write-document / make-spreadsheet builtins produce local files today) | export from the agent folder by hand |
| **Contacts** | client-memory patterns everywhere | codes + manual entry (privacy-positive; keep) |
| **Tasks/PM tools** (Notion, Linear, Todoist) | professional packs whose users already live there | our kanban only |
| **Messaging** (Slack, Telegram) | Workplace packs; channels generally | Telegram channel exists |

Calendar and email are the two integrations that convert the catalog from
"organized notebook" to "actually does the thing": the chase ladder that
sends, the radar that reads real renewal dates, the briefing that reads the
real diary.

## 2. Which services, in what order

What the market ships confirms the same shortlist. Claude.ai's connector
directory (200+ entries) leads with Gmail, Calendar, Drive, Slack, Notion,
Asana, Figma; ChatGPT's connectors lead with Gmail, Google
Calendar/Contacts, Drive, Outlook + Microsoft Calendar, Teams, SharePoint,
GitHub, Linear, HubSpot, with write actions added in 2025-26. Both landed on
the same core: **Google Workspace first, Microsoft 365 second, then the
work-tool long tail.**

**Wave 1 (the backbone): Google Calendar, Gmail, Google Drive (+ Docs/Sheets
export).** One OAuth flow covers all three; Google is the consumer default
and the small-business default, which is exactly our catalog's audience.

**Wave 2 (professional parity): Microsoft Outlook Mail + Calendar,
OneDrive.** Microsoft Graph is one API + one OAuth app for all of it.
Professional/vertical packs (Legal & Finance, Workplace) skew Microsoft.

**Wave 3 (work-tool long tail, via MCP, not bespoke code): Notion, GitHub,
Linear, Slack, Todoist/Asana, Stripe, Atlassian.** All of these already run
official first-party remote MCP servers with OAuth; we should ride that
rather than write per-service clients.

**Explicitly later / not now:** CalDAV/iCloud (fragile, small pull),
WhatsApp (no sane official API for this shape; roadmap already rejects
channel sprawl), banking/finance aggregation (Plaid-class compliance burden;
Money Mate stays manual-entry by design).

## 3. How: the integration architecture

Three viable strategies, and we should use two of them:

### 3a. Native first-party for Google + Microsoft (Waves 1-2)

Direct API integration with our own OAuth apps. Chosen because:
- Neither Google nor Microsoft ships a first-party Workspace/365 remote MCP
  server (Google archived its 2025 attempt; community servers exist but put
  a third party's code in the token path).
- These two are the backbone; they deserve first-class tools with curated
  verb sets, provenance tagging, and our own scope discipline instead of
  whatever a generic server exposes.
- Server-side implementation is small: Google's REST APIs and Microsoft
  Graph are stable, well-documented, and we need perhaps eight verbs each.

Mechanics: a new `ConnectionsModule` (server) holding OAuth clients,
token storage (encrypted at rest, refresh handled server-side), and the
per-service tool adapters. Authorization-code + PKCE flow; the web client
opens the consent URL, the server handles the callback.

Practical constraint to plan around: **Gmail scopes are "restricted" in
Google's verification program.** A hosted multi-tenant deployment needs app
verification and (above 100 users on restricted scopes) an annual CASA
security assessment. Two-track answer:
- Self-hosted deployments: bring-your-own OAuth client (paste client
  ID/secret from the user's own Google Cloud project, like OpenClaw-class
  tools do). No verification needed; it is the user's own project.
- Hosted product: start Calendar + Drive (sensitive-but-not-restricted
  scopes, lighter verification), submit Gmail verification early, and keep
  `gmail.send`-only (not full read) as a fallback tier: draft-and-send
  covers the chase-ladder use case without the restricted read scope.

### 3b. Remote MCP + OAuth for the long tail (Wave 3)

We already have `McpModule` (Streamable HTTP, tools/list discovery, tools
offered as `mcp_<server>_<tool>`, gated by Ask/Auto). What it lacks is
auth. The MCP spec (June 2025 revision, current since) standardizes this:
OAuth 2.1 with PKCE, RFC 9728 protected-resource metadata for discovery,
RFC 8414 auth-server metadata, RFC 8707 resource indicators. Implement that
once in `McpHttpClient` and every first-party server (Notion, Linear,
GitHub, Slack, Stripe, Atlassian, Sentry, Asana...) becomes a one-URL
connect with vendor-maintained tools.

Additions to the module: per-server token store, 401 → discovery →
authorization-code flow (browser popup) → token refresh. The front door
for all of this is the MCP marketplace (§4a), not a URL field.

### 3c. Aggregators (Composio, Nango, Arcade, Pipedream): no, for the core

They offer 800-1000+ connectors in a weekend, but: a third party enters the
token/data path of a product whose pitch is user-owned durable agents;
Composio's May 2026 incident forced mass key rotation; Pipedream's direction
is uncertain post-acquisition (Workday, Nov 2025). Acceptable escape hatch
later for a genuine long-tail request (Nango's open-source runtime,
self-hosted, would be the pick); wrong foundation for calendar/mail/drive.

## 4. The user experience

### Connect surface: a "Connections" section in Settings

One row per provider: logo, account email once connected, scope summary in
plain language ("can read your calendar; cannot send email"), token health,
and one-click disconnect (revokes at the provider, deletes tokens). This is
the inventory surface; nothing else in the app stores service credentials.

### 4a. The MCP marketplace

The Market view grows a second department next to agent packs:
**Connectors**, a curated directory of remote MCP servers, the same shape
Claude.ai's connector directory proved out. Each card: logo, vendor, what
it does in one line, the tool list from a pre-cached discovery (so the
review shows real tool names before connecting), auth type, and a
**Connect** button that runs the OAuth flow from §3b. Native integrations
(Google, Microsoft) appear as cards in the same directory: the user
shouldn't need to know which transport a connector uses.

Curation and trust tiers, mirroring the agent market's verified badge:
- **Verified**: first-party servers run by the service vendor (Notion,
  GitHub, Linear, Slack, Stripe, Atlassian, ...). Listed by default.
- **Community**: known-good third-party servers, shown with a plain
  warning ("runs code by <maintainer>, not by <service>") since a
  third-party server sits in the token path.
- **Custom**: the existing paste-a-URL flow stays, moved behind an "Add
  custom server" affordance, for anything not listed. The directory is
  convenience, never gatekeeping.

The catalog itself ships as data (a `connectors/*.md` or JSON list built
like the packs are: id, name, URL, tier, category, cached tool list) so it
can move to the remote registry later alongside the agent market
(roadmap Phase 5.3). Categories reuse the taxonomy where it fits
(Workplace, Product & Engineering, ...) so the rail feels like one market.

Marketplace cards also close the loop with packs: a pack's hire review can
point at directory entries ("works best with: Calendar, Notion") and an
agent's "needs connection" moment (§4, entry point 2) deep-links to the
right card instead of to raw settings.

### Connect at the moment of need, not as onboarding

Three entry points, same flow:
1. **Hire time:** a pack whose skills reference calendar/email shows it on
   the hire review card ("works best with: Calendar, Gmail: not connected,
   connect now or later"). Never blocking; packs all degrade to files.
2. **In-chat:** when an agent reaches for a tool whose connection is
   missing, the tool returns a structured "needs connection" result and the
   client renders a connect button inline. The agent asks once, warmly, and
   falls back to the manual path if declined.
3. **Settings**, for people who set things up first.

### Minimal scopes, requested incrementally

Google supports incremental authorization; use it as the design everywhere:
- Initial connect asks read-only (calendar.readonly, drive.readonly).
- The first time a pack needs a write ("shall I actually send the chase
  email?"), the missing scope triggers a one-time re-consent for exactly
  that scope. Users learn scope = feature, granted at the moment the
  feature is wanted, which is the same moment they trust it most.
- Scope grants display per-connection in Settings, revocable individually
  where the provider allows.
- One read tier exists that no tool uses: **"Gmail reading"**
  (`gmail.readonly`, `tier=mailread`) lets a loop's `mail` trigger poll a
  query for new message ids and headers (`docs/triggers.md`). The mail
  tools stay draft-and-send only; Outlook's `Mail.ReadWrite` already covers
  the poll.

### Connections are user-level; agent access is a grant

A connection belongs to the user. Which *agents* may use it is a separate,
per-agent, per-service grant, off by default, managed on the agent's page
(same surface as Skills & tools). Hiring a pack proposes the grants its
skills want; the hire review approves them explicitly. This keeps the
blast radius decision visible: connecting Gmail does not hand 71 potential
agents your inbox: it hands it to the one agent you granted.

## 5. Exposing services to agents

Follows the existing three-gate model exactly; connections are a fourth
capability class alongside apps, skills, and tools:

**Creation (free):** connecting a service creates capability but grants
nothing to any agent.

**Activation (explicit, reviewable):** the per-agent grant above. Granting
shows the real artifact: the literal tool list the agent gains
(`calendar_search`, `gmail_draft`, ...), read and write listed separately.
Read and write are separate grants. Revocation is one click and immediate.

**Execution (per-call, class-dependent):**
- Read tools (`calendar_search`, `calendar_freebusy`, `gmail_search`,
  `gmail_read`, `drive_search`, `drive_read`): normal tools, allowed in
  Auto mode. Results carry provenance framing (see injection note below).
- Mutating tools (`calendar_create_event`, `calendar_update_event`,
  `gmail_send`, `drive_write`): mutation-class, gated by Ask/Auto like
  every other mutating tool.
- **`gmail_send` is confirm-always**: sending email in the user's name is
  outward-facing and irreversible, so it confirms in host chrome even in
  Auto mode, showing recipient + subject + body. The companion
  `gmail_draft` (writes to the real Drafts folder) is the workhorse: the
  chase-ladder skills should draft by default and send only on standing
  instruction. Same rule for anything else that leaves the account in the
  user's name.
- Channel-originated and app-originated turns keep the existing rule:
  mutating tools auto-denied, so an inbound Telegram message can never
  send mail.

**Curated verb sets, not raw APIs.** Each service exposes 6-10 tools with
tight schemas, not the full API surface. Small verb sets keep the
activation review honest (a user can actually read ten tool names), keep
prompts small, and let us bake safety into the verb (e.g.
`calendar_create_event` stamps a "created by <agent> via yaam" note into
the event body; `gmail_send` refuses BCC-only sends).

**Prompt-injection posture.** Email bodies, calendar descriptions, and doc
contents are untrusted third-party input landing in context. Mitigations,
consistent with the channel-safety roadmap item: tool results are wrapped
in explicit "external content, not instructions" framing; mutating tools
stay gated regardless of what fetched content says; and the
confirm-always rule on `gmail_send` means an injected "forward this
thread" can never execute silently. This is also a reason to prefer our
native adapters over community MCP servers for mail specifically: the
wrapping is ours to enforce.

**Loops.** A radar loop with a calendar-read grant reads real dates
(the renewals radar finally radars something). Loop turns are background
turns: mutating calls queue as pending approvals surfaced in the
notification rail, never silently execute. The Monday briefing that says
"three things need your yes" is the correct shape.

**Skills already know.** The pack library was written services-first in
spirit (chase ladders, radars, briefings, drafts "in the practice's
voice"). When connections exist, the only pack change needed is the
charter tail gaining one line ("prefer the user's connected calendar/mail
over your file copies when granted"), and skills keep their draft-first
discipline, which maps exactly onto `gmail_draft` vs `gmail_send`.

## 6. Sequencing

1. **Connections foundation:** ConnectionsModule, encrypted token store,
   Settings section, per-agent grant surface + activation review. Google
   OAuth (Calendar read first: smallest scope, biggest catalog payoff).
2. **Calendar tools** (search/freebusy/create/update) + EA briefing and
   renewal-radar loops wired to them. This is the demo that sells the
   whole feature.
3. **Gmail draft + send** (confirm-always), then Gmail read/search behind
   verification-tier gating; chase-ladder skills pick up draft-first.
4. **Drive read/search + Docs/Sheets export** of the deliverable builtins.
5. **MCP OAuth 2.1 client** in McpHttpClient + the Connectors department
   in the Market view (curated directory, trust tiers, one-click connect):
   Notion, GitHub, Linear, Slack for free.
6. **Microsoft Graph** (Outlook Mail/Calendar, OneDrive) re-using the
   entire connections + grants + verb-set machinery.

Sources consulted: Claude.ai connector directory and help center;
ChatGPT/OpenAI connector announcements and help docs; MCP authorization
spec (modelcontextprotocol.io, June 2025 revision) and 2026 ecosystem
surveys; Google Workspace OAuth verification and incremental-auth docs;
first-party MCP server announcements (GitHub, Notion, Linear, Stripe,
Atlassian, Cloudflare); aggregator comparisons (Composio, Nango, Arcade,
Pipedream) including the May 2026 Composio incident coverage.
