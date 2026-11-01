# Roadmap: a durable personal agent for general users

*Research date: July 2026. Sources listed at the bottom.*

This document distills what made OpenClaw and Hermes Agent the two breakout
open-source personal agents of 2026, extracts the reasons behind their
features (not the features themselves), and lays out a phased roadmap for
bringing that experience to general users through our product. We are not
cloning either project; both are power-user tools whose biggest weaknesses
(setup, security, cost) are exactly the things a hosted, safe-by-default
product can solve.

---

## 1. What we studied

### OpenClaw (ex Clawdbot / Moltbot, ~347k GitHub stars)

A local-first personal assistant daemon. One gateway process connects ~29
messaging channels (WhatsApp, Telegram, Discord, Signal, iMessage, ...) to a
persistent agent with:

- **Memory files** injected into every prompt: SOUL.md (personality),
  MEMORY.md (facts), AGENTS.md / TOOLS.md (behavior and capabilities).
- **Heartbeat**: the agent wakes on an interval with no user message, checks
  what changed, and proactively messages the user. This single feature drove
  the virality ("my agent called me at 7am about my flight").
- **Cron** for deterministic schedules, distinct from the fuzzy heartbeat.
- **Skills**: folders with SKILL.md, discoverable in a registry (ClawHub,
  13,000+ skills), loaded on demand.
- **Multi-agent routing**: channels/accounts route to isolated agents.
- Browser tool, voice wake, live canvas, companion mobile/desktop apps.

### Hermes Agent (Nous Research, Feb 2026, ~180k stars)

"The agent that grows with you." One agent that improves over time:

- **Learning loop**: after a complex task succeeds, the agent extracts a
  reusable skill; skills refine with repeated use; periodic "nudges" prompt
  the agent to persist what it learned.
- **Layered memory**: MEMORY.md + USER.md, full-text search (FTS5) over all
  past conversations with LLM summarization, and Honcho "dialectic" user
  modeling that builds a progressively better model of the person.
- **Checkpoint / rollback** for agent state; command approval; DM pairing.
- Natural-language cron, subagent delegation, provider-agnostic models,
  serverless deployment that hibernates when idle ($5/mo hosting).
- Skill portability via the agentskills.io open standard.

### Why people love them (the gain points that matter)

1. **Proactivity.** The agent reaches out to *you*. An assistant that only
   answers when spoken to feels like a tool; one that says "your build broke
   overnight, I already filed the fix" feels like staff. (OpenClaw heartbeat,
   Hermes cron + nudges.)
2. **Continuity.** It remembers you across sessions: preferences, projects,
   people. Users describe the moment it recalls something from weeks ago as
   the moment it stops being a chatbot. (Memory files, session search, user
   modeling.)
3. **Growth.** It gets *better* at your tasks. Hermes' single biggest
   differentiator: skills born from experience. Users keep an agent they have
   invested in; abandonment is the norm for agents that never improve.
4. **Presence.** It lives where the user already is (messengers, email), not
   in yet another tab. OpenClaw's 29 channels exist because meeting users in
   WhatsApp beat every dedicated UI.
5. **Ownership.** Your data, your model choice, exportable identity. The
   agent feels like *yours*, not a rented feature.

### Where they hurt (the pain points we must not inherit)

1. **Security.** OpenClaw's year: exposed gateways found by the thousands,
   a crafted email or webpage exfiltrating SSH keys via indirect prompt
   injection, CVEs for command injection, SSRF, and path traversal. Root
   causes: tools run with **full host access by default**, secrets live in
   the same filesystem the agent reads, and injected instructions are
   indistinguishable from user intent.
2. **Cost.** Horror stories of $200/day; $50-150/month is typical for a
   modest setup. Root causes: heartbeats re-sending giant contexts, unbounded
   session accumulation, tool outputs resent every turn, wrong model for
   trivial ticks. Cost is invisible until the bill arrives.
3. **Setup and operations.** The community's #1 pain point across both
   projects "isn't the agent, it's the infrastructure": Node daemons, channel
   credentials, VPS hardening, update instability. 30 minutes to 4 hours for
   engineers; a hard wall for everyone else.
4. **Unreliable self-assessment.** Hermes evaluates its own work and almost
   always concludes it did well. Skills extracted from a "successful" task
   can encode a wrong procedure; the loop then reinforces it.
5. **Memory trust.** Hermes overwrites manual edits to its memory files;
   OpenClaw research demonstrated stealthy memory-injection attacks. Users
   need to see, edit, and veto what the agent believes.

---

## 2. Our position

We already have the durable-agent core these projects converge on, running as
a hosted web app with Postgres + S3 rather than a daemon on the user's laptop:

| Their concept | Ours today |
|---|---|
| MEMORY.md / SOUL.md | Agent charter + file brain (LESSONS.md, JOURNAL.md, knowledge/) |
| Heartbeat / cron | Scheduled loops (cron, pause/resume, per-loop prompt) |
| Skills + registry | Skills (global/workspace, slash commands) + Market |
| Self-maintenance | update_dashboard, save_app, kanban tools (list/add/update_task) |
| Approval / pairing | Ask/Auto modes, per-tool and exact-input approvals |
| Compaction | Summary + cutoff compaction, token ceilings |
| Portability | AGENT.json export/import with capability review |
| Sandboxing | Artifacts and previews in network-blocked iframes; S3 key isolation |

The strategic bet: **general users want the OpenClaw/Hermes experience
without the OpenClaw/Hermes operations.** Zero setup, safe by default,
predictable cost, and the same feeling of a persistent teammate that grows.

Design principles derived from the research:

- **Proactive, never spooky.** The agent may prepare work at any time, but
  it interrupts only through channels and quiet hours the user configured.
  Every proactive message links to the loop/run that produced it.
- **Learning with a human gate.** The agent proposes memories, lessons, and
  skills; durable state changes are reviewable diffs, not silent writes. We
  explicitly reject autonomy driven by self-evaluation (Hermes' trap).
- **Budgeted autonomy.** Nothing unattended runs without a token/cost budget
  attached, and spend is always visible before the bill.
- **Isolation as the security model.** The agent has no host: it has an S3
  workspace, a per-agent prefix, and brokered tools. Injection can waste a
  turn; it cannot reach SSH keys, because there are none to reach.
- **The agent is portable property.** AGENT.json v2 (identity, charter,
  loops, dashboard, apps, lessons, private skills, open tasks; the workspace
  profile only on request) is a first-class export, and memory from Claude,
  Muse, Hermes and OpenClaw imports as proposals.

---

## 3. Roadmap

### Phase 1 — Believable continuity (the "it remembers me" moment)

Goal: close the memory gap with Hermes. Everything else builds on this.

1. **Conversation recall.** Postgres full-text index over all of an agent's
   transcripts + a read-only `search_history` tool. The agent can answer
   "what did we decide about X in March" by actually looking. (Hermes FTS5;
   gain point 2.)
2. **Auto-distillation.** Distill (JOURNAL/LESSON extraction) runs
   automatically when a conversation goes idle or is archived, not only on
   button press. Nudge semantics from Hermes, but writes are size-bounded
   appends we already have.
3. **User profile with consent.** A per-workspace USER.md the agent may
   propose edits to; the UI shows proposed changes as diffs the user
   accepts/rejects (fixes Hermes' overwrite pain and OpenClaw's
   memory-injection risk). Injected into context like workspace memory.
4. **Memory transparency.** "What do you know about me?" page per agent:
   brain files, profile, and the provenance of each entry (which chat/loop
   wrote it), with edit and delete.

### Phase 2 — Safe proactivity (the OpenClaw magic, minus the 7am scare)

Goal: the agent initiates. This is the viral feature; ours must be trustworthy.

1. **Agent inbox / notifications.** *(shipped)* Loop runs and agent-initiated
   findings land in a notification feed (badge on the agent in the rail,
   browser push later). Each item links to the "Loop · name" conversation.
   No silent work. Events now also reach the paired Telegram chat (Phase 4.2).
2. **Heartbeat loops.** *(shipped)* A loop flavor with a cheap default prompt
   ("check your board, your watches, and your inbox; message the user only if
   something needs them") plus per-loop **token budget and model override**,
   so a 15-minute heartbeat can run on a small model for pennies while
   deep work uses the big one. (Directly answers pain point 2.)
3. **Quiet hours and interrupt policy.** *(shipped)* Per-workspace: when the
   agent may notify, when it must queue. Proactive ≠ noisy. Shipped as
   `workspaces.quietHours` (start/end/timezone/policy `queue | silent |
   allow-urgent`): loops still run in the window; their events carry
   `deliverAfter` or stay inbox-only.
4. **Watches.** *(reframed)* Lightweight triggers the agent can register with
   a tool (`watch_url`, `watch_keyword` over web search) that feed heartbeat
   runs, giving loops something real to check. Superseded by event triggers
   from connections (execution plan item 6).
5. **Cost dashboard.** *(shipped)* Per-agent and per-loop token spend over
   time in the agent's home page; workspace budget with hard stop +
   notification. Make the invisible bill visible before it happens. Shipped
   as `ai/pricing.ts` + `GET /api/agents/:id/usage` (per day, per loop, USD),
   Settings → Usage, and the monthly `spendBudgetTokens` stop with
   `budget_stop` events.

### Phase 3 — An agent that grows (the Hermes loop, human-gated)

Goal: perceived improvement over time, without self-evaluation autonomy.

1. **Skill drafts from experience.** After a multi-tool conversation ends
   well (user 👍 or explicit "save this as a skill"), the agent drafts a
   skill (name, description, instructions) into a **pending** state; the
   user reviews and enables it in the agent's home page. Rejected drafts
   feed LESSONS.md.
2. **Skill refinement with signal.** 👎 on a turn that used a skill attaches
   the feedback to that skill; the next draft revision shows a diff. The
   learning signal is the human rating we already collect, not the model
   grading itself.
3. **Brain checkpoints.** Versioned snapshots of brain files (S3 object
   versioning or dated copies) with one-click rollback, per Hermes'
   checkpoint/rollback. Protects the growth investment.
4. **Per-agent skill scope.** Skills owned by an agent (in addition to
   global/workspace), included in AGENT.json, aligned with the
   agentskills.io format so skills can be imported from the open ecosystem.

### Phase 4 — Presence (meet users where they are)

Goal: the agent stops living in a tab. Channels made OpenClaw; we need two
or three good ones, not 29.

1. **Email channel.** *(shipped)* Each agent gets an address; inbound mail
   becomes a turn in a dedicated conversation, replies go back out. Email is
   the universal channel for general users and the easiest to host
   centrally. Shipped as `<slug>@EMAIL_DOMAIN`, a signed webhook fed by
   `cloudflare/email-worker`, pairing by code, threaded replies via
   Cloudflare Email Sending or Resend, and an optional inbox digest
   (`docs/channels.md`).
2. **Telegram bridge.** *(shipped, two-way)* The best effort-to-reach ratio
   of the messenger channels (official bot API, no fragile reverse
   engineering, works on every platform). One bot, DM pairing with a code
   like OpenClaw/Hermes; inbox events are pushed back to the paired chat
   with deep links, honouring quiet hours.
3. **Web push + PWA.** *(shipped)* Notifications from Phase 2 reach the
   phone; the existing responsive UI becomes installable. VAPID + aes128gcm
   on node:crypto, `public/sw.js`, `manifest.webmanifest`, a per-device
   toggle in Settings → Channels.
4. **Channel-aware identity and safety.** *(shipped)* Unknown senders get a
   pairing code; channel messages are marked as untrusted content in context
   (prompt-injection surface), and mutating tools stay in Ask mode for
   channel-originated turns by default. See `docs/security.md` §b/§e.

### Phase 5 — Depth and ecosystem

1. **Browser tool.** Headless browsing in an isolated, network-egress-
   controlled worker (fetch/render/extract, no credentials), because "look
   at this page and fill the form" is a top OpenClaw use case. SSRF guard
   already exists for raw HTTP; the browser inherits it.
2. **Agent-to-agent delegation.** An agent can hand a task card to another
   agent (our kanban is the natural handoff surface); the receiving agent's
   loop picks it up. This is OpenClaw's multi-agent story expressed through
   a primitive we already have, with the user able to watch the board.
3. **Real market.** The curated market becomes a registry: publish an
   AGENT.json (capability review stays mandatory), install counts, ratings
   from the feedback we already collect. Skills and mini apps shareable the
   same way.
4. **Voice notes.** Transcription on upload (attachment type we already
   support), TTS on replies later. Wearables and wake words are explicitly
   out of scope.

---

## 4. What we deliberately do not copy

- **Full host access.** OpenClaw's power and its CVE list come from the same
  place. Our agents keep brokered tools over isolated storage. If we ever
  offer "connect to my machine," it is a separate, paired, sandboxed runner.
- **Self-hosted-only distribution.** Running the infrastructure is the
  community's top pain point; hosting it *is* our product. (AGENT.json
  export keeps the ownership story honest.)
- **Self-evaluation autonomy.** Hermes' agent grading its own work is the
  documented failure mode. Human signal gates all durable learning.
- **Channel sprawl.** 29 channels is a maintenance treadmill. Email +
  Telegram + push covers general users; more only with evidence.
- **Always-on heartbeats by default.** Proactivity is opt-in per agent, with
  a budget, a model override, and quiet hours from day one.

## 5. Success measures

- Retention proxy: % of agents older than 30 days with a loop enabled and a
  non-empty brain (continuity + proactivity in actual use).
- "Growth" proxy: median approved skill drafts per active agent per month;
  👍 rate trend on turns that used an approved skill.
- Trust proxy: % of proactive notifications acted on (opened/replied) vs
  muted; approval-denial rate on agent self-maintenance tools.
- Cost health: p95 monthly token spend per active agent, and zero surprise
  overruns past a workspace budget.

## Sources

- OpenClaw: [site](https://openclaw.ai/), [repo](https://github.com/openclaw/openclaw), [DigitalOcean overview](https://www.digitalocean.com/resources/articles/what-is-openclaw), [architecture walkthrough](https://bibek-poudel.medium.com/how-openclaw-works-understanding-ai-agents-through-a-real-architecture-5d59cc7a4764), [heartbeat guide](https://skywork.ai/skypage/en/openclaw-heartbeat-ai-agents/2051941515905306624), [proactive agents coverage](https://hyperight.com/openclaws-proactive-ai-agents-are-messaging-humans-and-organizing-themselves/)
- OpenClaw security: [IBM X-Force](https://www.ibm.com/think/x-force/what-openclaw-reveals-about-agentic-ai-security-risks), [Bitsight exposed instances](https://www.bitsight.com/blog/openclaw-ai-security-risks-exposed-instances), [Giskard vulnerabilities](https://www.giskard.ai/knowledge/openclaw-security-vulnerabilities-include-data-leakage-and-prompt-injection-risks), [prompt-injection attack notes](https://github.com/centminmod/explain-openclaw/blob/master/05-worst-case-security/prompt-injection-attacks.md), [memory-injection research](https://arxiv.org/pdf/2607.05189)
- OpenClaw cost: [official token docs](https://docs.openclaw.ai/reference/token-use), [cost analysis](https://help.apiyi.com/en/openclaw-token-cost-optimization-guide-en.html), [Milvus token analysis](https://milvus.io/blog/why-ai-agents-like-openclaw-burn-through-tokens-and-how-to-cut-costs.md)
- Hermes Agent: [repo](https://github.com/nousresearch/hermes-agent), [site](https://hermes-agent.nousresearch.com/), [desktop app coverage](https://medium.com/@tentenco/hermes-agent-desktop-app-everything-you-need-to-know-about-nous-researchs-self-improving-ai-agent-3cb59bd31e5f)
- Comparisons: [Composio](https://composio.dev/content/openclaw-vs-hermes-agent), [Kilo Reddit analysis](https://kilo.ai/openclaw/vs-hermes), [innFactory](https://innfactory.ai/en/blog/openclaw-vs-hermes-agent-comparison/), [hostadvice hands-on](https://hostadvice.com/blog/ai/hermes-agent-vs-openclaw/)
