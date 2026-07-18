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
