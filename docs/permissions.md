# Permission model for agent-built things: mini apps, skills, tools

Agents in this product build their own capabilities: mini apps (save_app),
skills (draft_skill), and HTTP tools (save_tool). This document is the
permission model behind that — what may be created freely, what needs the
user, when, and why. It encodes the two failure modes from the OpenClaw /
Hermes research: capability sprawl with full-trust execution (OpenClaw's CVE
year), and self-approved learning loops (Hermes grading its own work).

## 1. The core idea: three gates, not one

Every capability passes up to three distinct gates, and the gates answer
different questions:

| Gate | Question | Who decides | When |
|---|---|---|---|
| **Creation** | May the agent author this artifact? | Nobody — creation is free | During any turn |
| **Activation** | May this artifact enter the agent's toolbox? | The user, explicitly, per artifact | Review UI (agent home, Settings) |
| **Execution** | May this specific call run right now? | The Ask/Auto policy + remembered grants | Every call |

Collapsing these into one gate is what goes wrong elsewhere. If creation is
gated, the agent nags for permission to *think* (and users learn to click
yes). If activation is implicit, the toolbox silently grows (Hermes' skills
appearing from self-evaluated success). If execution trust is granted at
activation ("I approved the tool, so every call is fine"), a compromised
input can drive an approved tool anywhere. Three gates keep each decision
small enough for a general user to actually make.

## 2. Capability classes and where their risk lives

The gates apply differently per class because the risk lives in different
places:

### Mini apps (save_app) — risk at *render* time, plus the bridge
A mini app is HTML in a sandbox (`allow-scripts` iframe, opaque origin, no
network). It may additionally request **bridge capabilities** through a
per-app manifest — the full design lives in `docs/miniapp-capabilities.md`;
the shape mirrors the three gates:
- Creation: free, any manifest. Free-tier caps (`storage`, `chat.compose`)
  activate at save — they add persistence/convenience, not reach.
- Activation: elevated caps (`files.read`, `files.write`, `tasks.read`,
  `tasks.write`, `agent.ask`) park until the user reviews them,
  per-capability, on the app card. **Editing an app re-parks its elevated
  grants** (same rule as custom tools).
- Execution: mutating caps confirm on first use in host chrome (never
  inside the iframe); the server re-verifies every grant per call. Writes
  are jailed to the app's own folder (no brain poisoning); app-originated
  turns are Ask-mode channel turns with gated tools auto-denied.
- The invariant: **no ambient capabilities, and no raw network, ever** —
  everything reaches the world through the reviewed, scoped bridge.
- Residual risk: social engineering inside the rendered page. Mitigation is
  provenance labeling ("built by <agent>, sandboxed, no network") on every
  surface.

### Skills (draft_skill) — risk at *instruction* time
A skill is text the model will later follow, so it is a persistent prompt:
an unreviewed skill is a self-injection channel (write instructions today,
obey them next week, forever). Therefore:
- Creation: free, but lands as a **draft** that is invisible to the model —
  never offered, never resolvable.
- Activation: the user reads the actual instructions and approves. The
  review shows the full body, the proposing agent, and the trigger.
- Execution: invoking a skill only loads text, so it is read-only and
  auto-runs. The *actions the skill leads to* are still gated
  individually by the tools they use. A malicious skill cannot smuggle a
  mutation past the execution gate; the worst it can do is waste a turn.
- Scope: self-built skills are **private to their agent**. Sharing a skill
  to the workspace (or the market) is a separate, explicit promotion, which
  is a second activation gate at a wider blast radius.
- Import: an agentskills.io `SKILL.md` (`POST /api/skills/import`) goes
  through a **scan step** before it is even a draft (`server/src/portability/
  skill-md.ts`): size cap 64 KB; URLs counted and listed; instruction smells
  ("ignore previous instructions", "do not tell the user", persona
  overrides, sending credentials elsewhere); mentions of `.env`, keys,
  passwords, `~/.ssh`; base64 blobs; `allowed-tools` naming tools we do not
  have. Invisible/bidi unicode, an empty body, or oversize **block** the
  import; everything else is a flag stored on the row (`skills.scanReport`)
  and rendered verbatim on the draft card above the full body. The scan
  flags, it does not decide — approval is still the user reading the text.
  Skills arriving inside an AGENT.json land as drafts the same way. Export
  is the mirror: `GET /api/skills/:id/skill.md`.
- Revision: a skill records which turns loaded it (`chat_turns.skillsUsed`)
  and how those turns were rated (`skill_outcomes`, aggregates on the
  skill). After a 👎 the agent is told which skill was involved and may call
  `revise_skill(skillId, instructions, reason)`. That is read-only class —
  it only parks `skills.pendingRevision` — because the *activation* is the
  user accepting the diff on the Skills page, which replaces the text and
  keeps the previous version in `skills.history` (last 5). The live
  instructions never change on the agent's say-so.

### HTTP tools (save_tool) — risk at *call* time, forever
A custom tool reaches the outside world, so it is the most dangerous class
and gets the full treatment:
- Creation: free, lands **disabled**. The proposal fixes the method, the URL
  template, and the parameter shape.
- Activation: the user reviews the literal destination. Two structural
  rules make that review meaningful:
  - **the host must be literal** — `{param}` placeholders are allowed only
    in path and query, so the approved destination cannot be swapped at
    call time;
  - **editing = re-approval** — replacing a tool disables it again. What
    the user approved is exactly what runs.
- Execution: every call re-validates through the SSRF guard (private hosts
  refused even if DNS changed) and, in Ask mode, pauses for per-call
  approval like http_request. Params are length-capped and URL-encoded.
- No secrets, deliberately: v1 tools carry no headers/API keys, because a
  stored key inside an agent-authored artifact is exfiltratable by
  construction. Authenticated tools wait for a **secrets vault**: the user
  binds a named credential to a tool at activation, values are injected
  server-side at call time, never visible to the model, never exportable.

### For contrast: the pre-existing classes
- Core tools (fs_*, web_*, …): shipped by us, activation implicit, execution
  by readOnly policy. fs tools are scoped to the chat's file root (the
  agent's own working folder), and `.checkpoints/` is write-protected even
  from the agent itself.
- MCP tools: third-party servers; the user activates per server, execution
  always gates in Ask mode (opaque side effects).
- Self-maintenance tools (update_dashboard, save_app, …): mutations of the
  agent itself; excluded from blanket "always allow" grants (SELF_MOD).
- Proposal-only tools (update_user_profile, draft_skill, save_tool):
  auto-run even in Ask mode *because their entire effect is to queue
  something for user review*. The gate is the review, not the call.

## 3. Grant semantics (execution gate details)

- Grants are **per chat**, remembered as either exact-input
  (sha256-of-arguments) or per-tool, exactly as today. No cross-chat or
  cross-agent inheritance: an approval is a statement about a context.
- **Never blanket-grantable**: SELF_MOD tools, and (future) any tool bound
  to a secret. "Always allow" on a credentialed call is how OpenClaw
  instances leaked keys.
- Auto mode is a per-chat opt-in and does not bypass activation gates:
  a disabled tool does not exist, whatever the mode.
- Channel-originated turns (Telegram) are hard-floored at Ask + deny:
  approvals can only be given in the app, so a hijacked channel cannot
  approve anything.

## 4. Review UX principles

1. **Review where the thing lives.** Skill drafts and tool proposals appear
   on the agent's own home page (Skills & tools tab) with badges; nothing
   is buried in global settings the user never visits.
2. **Show the real artifact**, not a summary: full skill instructions, the
   literal URL template. Approving a paraphrase is not approving.
3. **Provenance everywhere**: who built it, when, from which conversation.
4. **Every grant is revocable in one click**, and revocation is immediate
   (the next turn simply does not see the capability).
5. **Bounded queues** (10 drafts, 12 tools, 12 apps): a proposal flood is a
   nag attack; caps turn it into a natural rate limit.

## 5. Later: sharing and the market

Promotion widens blast radius, so each step re-reviews:
agent-private → workspace-shared → market-published. Market artifacts get
the existing capability review on install (as AGENT.json does today), plus
static checks (no secrets, literal hosts, size caps). Skill/tool provenance
travels with the artifact. Installing an agent whose profile ships tools
imports them **disabled**, always — the importing user activates each one.

Shipped as the Community registry (`docs/registry.md`, execution-plan item
12). The rules above are now code in `server/src/registry/`:

- **Publish re-reviews.** Every publish runs the item-9 scan over the
  charter, loop prompts and skill bodies (`scanSkillMd`) and over each mini
  app's HTML (`scanAppHtml`: external URLs, `fetch`/`XMLHttpRequest`/
  `WebSocket` use, embeds, capability tiers). Blocking flags refuse the
  publish; warnings travel with the item and are shown verbatim to every
  installer. The form shows the scan before the user confirms.
- **Install is a two-step gate the server enforces.** `POST
  /api/registry/:id/install` without `confirm: true` returns the review —
  capabilities, loops, scan, the real charter and skill bodies, the app
  source — and writes nothing. With confirmation it re-scans and imports
  inert: loops `enabled: false`, skills as drafts, elevated app
  capabilities parked. There is no one-click install and no "trust this
  publisher".
- **Remote items get the local review.** A manifest pulled from
  `REGISTRY_URL` is normalized and scanned here; the remote's report is
  displayed for comparison, never trusted.
- **What never publishes:** lessons, tasks, the user profile, webhook
  secrets. A registry item is the agent's design, not one user's history.
- **Ratings are the feedback already collected** (§Skills, item 10): a 👍/👎
  on a turn that ran on an installed agent or loaded an installed skill
  rolls up to the item. No star widget.

## 6. The independent reviewer

The three gates are deterministic, and that is their strength and their
limit: a remembered "always allow fs_write" or an Auto-mode chat lets a
compromised input drive an approved tool anywhere within its class. Since
October 2026 every hosted competitor ships a second reader for exactly this
case (Grok Bot's Auto Review, Dots' out-of-band review, Duet's intent
classifier that "runs outside the model so hidden page instructions cannot
affect it"). Ours is `ActionReviewService` (`server/src/review/`).

**When it runs.** Only for calls that would otherwise execute *without a
fresh human decision*: verdict `auto` (Auto mode) or `remembered` (a per-tool
or exact-input grant) on a tool that is not read-only. Read-only tools and
skill loads are never reviewed; confirm-always tools already pause and are not
reviewed twice; an Ask-mode pause is a human decision and needs no second
reader. The deterministic gates stay the floor — the reviewer can only make
things stricter.

**What it does.** Two steps, in order:
1. A deterministic sensitive-information pre-check over the serialized tool
   input: API keys and tokens (vendor prefixes, `api_key=`), bearer tokens,
   JWTs, private keys, card numbers (Luhn-checked), IBANs (mod-97), SSN-like
   numbers, `password=` patterns. Any hit forces at least `ask` and is listed
   on the verdict; no model can override it.
2. One bounded (≤300 output tokens), tool-free call to a cheap reviewer model
   — setting `reviewModel`, default the cheapest sibling of the chat's
   provider (Anthropic → `claude-haiku-5-5`, OpenAI → `gpt-5-mini`,
   DeepSeek → `deepseek-chat`, Gemini → `gemini-2.5-flash`, otherwise the
   session model). It receives the user's request for this turn, the
   compaction summary and recent user messages, the agent's charter, the most
   recent tool results (as labelled untrusted content), and the proposed call
   — never the agent's system prompt or tools, so content the agent read
   cannot address it. It answers four questions: scope (within what the user
   asked?), proportion (no broader or more destructive than needed?), leakage
   (secrets or third-party personal data leaving to an external party?),
   inducement (does it look instructed by content rather than the user?) and
   returns strict JSON `{verdict: allow|ask|deny, reason}`. Unparseable
   output or a provider error → `ask`. The reviewer's tokens count into the
   turn's usage.

**What the verdict does.**
- `allow` → the call runs as before.
- `ask` → the call is downgraded to an ordinary approval pause, even in Auto
  mode, with the reviewer's reason on the card. The human decides.
- `deny` → the call does not run; the model receives
  `Denied by the action reviewer: <reason>` as an error result so it can
  explain and adapt instead of retrying.
- Loop-origin and channel-origin turns have nobody to answer a pause, so
  `ask` becomes `deny` there, and the held action is recorded as an
  `agent_events` row (`info`, "Action held by reviewer: <tool>") in the
  agent inbox.

**Where you see it.** The verdict (`review: {verdict, reason, sensitive,
model}`) is stored on the tool call record of the turn, emitted on the
`approval_required` / `tool_result` SSE events, and rendered as a one-line
"Reviewed · allowed / held for you / denied" on the tool card. Settings →
Permissions has the on/off switch (`actionReview`, default on) and the model
override (`reviewModel`).

## 7. The trust ledger, and how Ask and Auto meet it

Since execution-plan item 28 (`docs/actions-and-trust.md`) the unit of
autonomy is not the chat's Ask/Auto switch nor the organization's
supervised/autonomous mode but a **trust level 0–3 per agent and per action
class** (`read`, `internal_write`, `external_reversible`,
`external_irreversible`, `money`), earned from the agent's record and capped
by ceilings the owner sets.

| Where the turn runs | Who decides a mutating call |
|---|---|
| Ask mode, a person typing in the app | The person, as in §1–§6: every mutating call pauses (remembered grants still apply, except that an irreversible or money call is never answered from one) |
| A channel turn (Telegram, email, an app's `agent.ask`) | The legacy gates: Ask mode, and the host denies every pause |
| Auto mode, a person typing | The ledger: level 0 asks the person, level 1–3 act (an irreversible or money call at level 0–1 asks; at 2 a co-signer agent on another model family decides) |
| A loop, a heartbeat, an org run (nobody at the keyboard) | The ledger: 0 holds the call for the owner's key (a send is staged as a draft), 1 acts and tells the owner after, 2 acts (irreversible and money with a co-signer), 3 acts |

The deterministic gates of §1 stay the floor beneath all of it: activation
precedes execution (a tool that is not granted does not exist), computer
tools keep their own rules (user turns only, every acting call asks), and
the independent reviewer of §6 still reads every call that would run without
a fresh human decision, at every level. The ledger can make an agent more
autonomous only within the ceiling the owner chose (defaults: money 0,
irreversible 1, reversible 2), only after `trust.promoteAfterClean` clean
outcomes, and it takes autonomy back at once on an incident, a reported
revert or a rejection streak. Organization mode is a preset over the
ceilings: `supervised` caps every outward class at 1.

Every non-read call — in any of the rows above — is also written to the
action log with an idempotency key (a retry never sends twice) and counted
against the workspace's outbound rate limits.
