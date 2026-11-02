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
- Core tools (fs_*, web_*, …): shipped by us, activation implicit. File
  tools resolve against the agent's home in the workspace tree; their
  execution gate is the filesystem's own permission table, not an approval
  (§8): another agent's home and `.checkpoints/` are write-protected, and
  every overwrite and delete is restorable.
- MCP tools: third-party servers; the user activates per server, execution
  always gates in Ask mode (opaque side effects).
- Self-maintenance tools (update_dashboard, save_app, …): mutations of the
  agent itself; they run freely (§8) — creation is free, and what save_app
  can reach is still the capability review (activation).
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
  approve anything. Free internal work (§8) needs no approval and runs
  there too (the channel is the owner's own, paired).

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
or exact-input grant) on a tool that is not read-only. Read-only tools,
skill loads and free internal work (§8: workspace files, the agent's own
records, the org's work record) are never reviewed; confirm-always tools already pause and are not
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
a fresh human decision, at every level — except free internal work (§8),
which runs in every row of the table above without a pause, a hold or a
review. The ledger can make an agent more
autonomous only within the ceiling the owner chose (defaults: money 0,
irreversible 1, reversible 2), only after `trust.promoteAfterClean` clean
outcomes, and it takes autonomy back at once on an incident, a reported
revert or a rejection streak. Organization mode is a preset over the
ceilings: `supervised` caps every outward class at 1.

Every non-read call — in any of the rows above — is also written to the
action log with an idempotency key (a retry never sends twice) and counted
against the workspace's outbound rate limits.

## 8. Agent file and workspace operations

Agents work in files and on boards all day. Pausing, holding or reviewing
each of those writes cost a model call and a person's attention per write,
and protected nothing the workspace does not already protect: the
filesystem refuses what an agent may not touch, keeps a revision of every
overwrite *and delete*, and attributes every change. So **internal,
reversible work runs freely** — in Ask chats, Auto chats, loops, heartbeats,
org runs, channel turns and chats with no agent alike:

- no Ask-mode approval pause, no remembered grant needed;
- no trust-ledger ask, hold or stage, whatever the agent's `internal_write`
  level;
- no action reviewer (§6) — the cost and the latency are per write, and the
  thing an injected instruction is after (leaving the workspace) is
  reviewed at the outward call that would do it.

What stays: the filesystem's permission table (`WorkspaceFs.assertCanWrite`:
another agent's home, `.checkpoints/`, `.revisions/` are refused and the
agent gets the refusal as a tool error); the action log (every call is a row
with `decision: 'free'`, and the ledger counts it); an incident freeze of
`internal_write` (still held for the owner's key); and the red-team canary
(the record-only sandbox takes every call before any policy, so an injected
file write carrying the nonce is still a breach). A turn a **mini app**
drives through `agent.ask` is `confined`: there the free work gates like any
mutation (and the host denies it), so an app cannot write its agent's
LESSONS.md or a shared file through the agent — its own writes stay jailed
to its folder by the bridge.

The registry is `FREE_INTERNAL_TOOLS` in `server/src/actions/action-classes.ts`
(`runsFreely`), applied in `TurnLoopService` (the call loop). Every name in
it classes as `internal_write`; a test keeps outward, money, computer, code,
MCP and governance tools out of it.

| Tool(s) | Decision | How / why |
|---|---|---|
| `fs_list`, `fs_read`, `fs_search` | already free | reads |
| `fs_write`, `fs_edit`, `fs_append`, `slides_create` | **relaxed** | WorkspaceFs decides the path (own home and shared folders such as `/org/`, `/channels/<slug>/` rw; other homes refused); every overwrite keeps a revision |
| `fs_delete` | **relaxed** | now reversible: the deleted body is kept as a revision and `fs_restore` (new, also free) brings it back |
| LESSONS.md, JOURNAL.md, `knowledge/` (agent memory) | **relaxed** | plain files in the agent's home, same rule |
| `update_dashboard` | **relaxed** | the agent's own status page, rewritten every run (not versioned; nothing else depends on it) |
| `save_app` | **relaxed** | creation is free (§1); elevated capabilities still park for the user, and an edit re-parks them |
| `add_task`, `update_task`, `list_tasks` | already free | the agent's own board |
| `delegate_task` | **relaxed** | a task on a colleague's board in the same workspace; the colleague's outward calls are gated as their own |
| `draft_skill`, `revise_skill`, `save_tool`, `update_user_profile` | **relaxed** (were already free in Ask mode; now also unattended) | proposals only: activation is the user's review |
| `org_task_update`, `org_task_comment`, `org_create_task`, `org_assign`, `org_request_review`, `org_review`, `org_escalate`, `org_check_in`, `org_set_goal`, `org_set_key_result`, `org_message`, `org_report`, `org_strategy_memo`, `org_ack_signal`, `org_report_incident`, `org_forecast_outcome`, `channel_make_task` | **relaxed** | the organization's own work record — attributed, on the hash-chained audit, undone by the next update; the org's own rules (who may assign, review rounds, the independent done-when check at acceptance) still apply inside the tools |
| `channel_post`, `channel_read`, `channel_list`, `meeting_*` | already free | the providers mark them read-only: posts stay inside the workspace |
| `org_read_*`, `org_intent`, `org_why`, `org_signals`, `org_pulse`, `org_costs`, `org_forecast`, `org_unit_report`, `org_review_structure` | already free | reads |
| `org_hire_agent`, `org_terminate_agent`, `org_reorg`, `org_propose_strategy` | kept as they are | the turn loop treats them as read-only because `boundary.ts` gates them inside the tool: approval cards in supervised mode, experiments beyond one unit, the agent cap and envelope — unchanged |
| `org_set_scope`, `org_pause_agent`, `org_update_member`, `org_allocate_budget`, `org_set_routing`, `org_tune`, `org_set_cadence`, `org_write_playbook`, `org_propose_*`, `org_eval_*`, `org_audit_*` | **kept gated** | governance: authority, money, models, the rules the org runs by (`boundary.ts` rows) — trust ledger + reviewer as before |
| `run_js`, `run_python` | **kept gated** | the local sandbox has no network but reads the host's whole disk (Seatbelt default-allow reads), and the code may come from injected content |
| `http_request`, agent HTTP tools (`tool_*`), `browser_act`, every `mcp_*` | **kept gated** | outward and opaque (`external_reversible` by default) |
| `gmail_*` / `msmail_*` sends, calendar writes, Drive exports | **kept gated** | outward; sends stay confirm-always and two-key (staged at low trust) |
| `computer_*` | **kept gated** | the user's own machine: user turns only, every acting call asks |
| money-named tools | **kept gated** | `money`, two keys below level 3 |

Not done here: an agent cannot list its deleted files (it names the path to
`fs_restore`), and the Artifacts view has no "recently deleted" list yet —
the restore route (`POST …/file/restore`) works for a deleted path.
