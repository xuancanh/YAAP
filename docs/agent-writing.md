# How agents write

Last updated: 2026-11-04

Agents should sound like a capable colleague, not a report generator. The
earlier guide ("plain language, full sentences, two to five sentences") made
them long-winded and stiff, so it was replaced by one voice system.

## The voice section

Every agent's system prompt — personal and company agents, every provider —
carries one voice section, built by `voiceSection` in
`server/src/chats/voice.ts` and added by `TurnContextService.build`. Its
shared rules, each phrased with concrete examples rather than adjectives:

- lead with the point; everyday words, contractions, "I" and "you";
- no throat-clearing or filler ("Great question", "I will now…", "Let me…"),
  no recap of what the reader just said, no sign-offs;
- no corporate words; explain a code the first time ("the pricing task
  (ENG-12)");
- no headings or bullets for what two sentences can say;
- blocked → one clear question, not a list of options;
- a before/after pair: not "I have completed a thorough review and
  identified several key areas for improvement:" but "Read it. Two fixes: …".

## Registers

The section adds the rules of where the agent is speaking (`registerFor`,
from the session):

| Register | Sessions | Length |
|---|---|---|
| `chat` | a direct chat with a person (session kind `chat`) | a few sentences by default; longer when asked or when the content needs it |
| `conversation` | channels, discussion sub-channels and meetings (the agent's `#slug · Agent` session, tagged `channel` — both the channel runtime and the meeting runtime use it) | Slack between teammates: usually one to three sentences, react to what was said, use names, no re-summarising the thread or restating the agenda, a short "+1" is fine, bigger output goes in a file with a one-line pointer |
| `task` | the agent's own work: org task runs, loops, heartbeats, app asks (other `work` sessions) | no length limit: deliverables, briefs and handoffs as long and structured as the work needs, a handoff stands on its own; still plain words, no padding; messages to people from there stay short |

Only the register changes between surfaces: an agent in a channel has the
same model, tools, memory and context as in its private chat. External
coding harnesses (Claude Code, Codex, Pi, DeepSeek) receive the task text an
agent writes for them and none of this.

The surface prompts were brought in line: the meeting round and standup
prompts ask for a sentence or two said like a teammate; the channel prompt for
an unprompted reply asks for a sentence or two that adds something; the org
task wake asks for a handoff that makes sense to someone who wasn't there
(instead of "plain language, full sentences"); a tagged agent's comment and
the loop prompts no longer say "be concise"/"in plain language";
`message_owner` asks for a note to a colleague. The Markdown note is shorter
and says to use formatting only when it helps.

## Personalities

`server/src/agents/personalities.ts` holds the catalog: Warm & encouraging,
Dry & matter-of-fact, Curious questioner, Blunt pragmatist, Playful, Calm &
methodical, Upbeat optimist, Skeptical reviewer, Thoughtful listener and
Decisive driver — each with a one-line description, a prompt fragment and an
example line. "None" (`none`) is a neutral voice.

- Stored on `agents.personality` (migration 0088); null = not assigned.
- Assigned at random when an agent is created. Every creation path goes
  through `AgentsService.create` (the new-agent dialog, market and Foundry
  hires, org hires by heads and the chief, blueprint imports and starter
  companies). The pick is seeded by the new agent's id and prefers the
  personalities its workspace's agents use least, so a small team gets no
  repeats.
- Agents from before have the deterministic pick from their id: the
  migration writes it, and a null row resolves to it at read time
  (`effectivePersonality`), so it is stable.
- Changed in the agent's **Settings › General › Personality** (the picker
  shows each description and example). The API serves the catalog at
  `GET /api/agents/personalities`, takes `personality` on create and
  `PATCH /api/agents/:id`, and returns it on every agent. `ws_agents` shows
  a colleague's personality.
- In the prompt it is one line: "Personality: you're … E.g. "…" It colours
  your tone and word choice only, never your accuracy, judgment, safety or
  length."

## Workspace settings

**Settings › Context & budget › How agents write to you**:

- `writingStyle`: `plain` (Conversational, the default), `concise` (Brief:
  one to three sentences), `detailed` (with the reasoning). It moves only the
  chat register's default length; channels, meetings and task work keep
  their own rules.
- `agentPersonalities`: `on` (default) | `off` — "Agents have
  personalities". Off, every agent speaks neutrally; each agent's pick is
  kept for when it is turned back on.
