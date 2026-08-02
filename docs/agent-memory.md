# Agent memory: nine mechanisms, one broken loop, and how to close it

Status: review + plan. Durable agents in this codebase write lessons they
never read. Everything else in this document follows from that: the machinery
for learning is built, tested, and running on a timer, and the last link —
putting what was learned back in front of the agent — was never connected.
This reviews all nine memory mechanisms against the code, names what is wrong
with each, and sequences the fixes so that closing the loop does not open a
hole.

## 1. What exists today

Nine distinct mechanisms, grouped by how they reach the model:

**Always injected into the system prompt** (`turn-context.service.ts`):

| Mechanism | Source | Written by |
|---|---|---|
| Charter | `agents.charter` | user |
| Workspace memory | `workspaces.memory` | user, hand-edited |
| User profile | `workspaces.profile` | agent proposes, **user approves** |
| Pending feedback | `agents.takeFeedback()` | user 👍/👎, **drained on read** |

**Available on demand, if the model chooses to reach for them**:

| Mechanism | Tool | Notes |
|---|---|---|
| Past conversations | `search_history` | Postgres FTS, GIN-indexed, agent-scoped, 8 hits |
| Skills | `skill_*` tools | drafted by agent, user-approved, promotable to shared |
| Working folder | `fs_*` | includes the brain files below |

**Written automatically, read by nobody**:

| Mechanism | Written by | Read by |
|---|---|---|
| `LESSONS.md` | `DistillService`, every idle session | **nothing** |
| `JOURNAL.md` | `DistillService`, every idle session | **nothing** |

The distillation pipeline itself is well built. `loops.service.ts` sweeps
every 10 minutes for agent sessions idle 60+ minutes with `distilledAt` older
than `updatedAt`, bounded to 5 per sweep. `DistillService` asks the model for
one journal line and one durable lesson (or the word `none`), and
`appendBrainFile` serializes appends per agent through a promise queue — a
real fix for a real race — caps each append at 2 KB, caps the file at 100 KB,
and snapshots to `.checkpoints/<date>/` before the first change each day,
keeping 14 days.

## 2. The central defect: memory is write-only

Nothing reads `LESSONS.md` back into the model's context. Not the turn loop,
not the context builder, not the loop runner. The only mention anywhere near
the prompt is one sentence telling the agent its folder *contains* those
files:

> Your fs_* tools operate on your own private working folder (it also holds
> your LESSONS.md, JOURNAL.md and knowledge/…). Organize it however serves
> your work.

So an agent learns a lesson only if it spontaneously decides to spend a tool
round-trip opening a file nothing told it to open, on a turn where nothing
suggests the file is relevant. In practice: never. Every lesson the pipeline
has ever distilled is inert text on disk.

This is worth stating plainly because of how it looks from outside: the
feature works. Distillation runs, `LESSONS.md` fills with genuinely good
lessons, the Files tab shows them, checkpoints roll. An agent that has been
running for six months has a rich, well-formatted memory and behaves exactly
like one with no memory at all. Nothing errors, so nothing draws attention —
the third instance in this codebase of a capability that is true in prose and
absent in code (see `docs/code-execution.md` §1 for the CSP, and
`docs/miniapp-roadmap.md` §1 for the bridge quotas).

The fix is not "inject LESSONS.md" — the file is capped at 100 KB, which
would dominate the prompt and cost more per turn than the lessons are worth.
It needs selection, which is what §4 is about. But first, §3.

## 3. Before closing the loop: who is allowed to teach?

`sessionsNeedingDistill` excludes exactly one kind of session: `Loop · %`.
It does **not** exclude `App · %` (mini-app `agent.ask` turns) or
`Telegram · %` (channel messages). Those two surfaces are the ones the whole
permission model treats as untrusted — app-originated turns run Ask-mode with
gated tools auto-denied precisely because an app's input cannot be trusted,
and the Telegram channel has the same posture for the same reason.

Yet a conversation driven entirely by a hostile app or a spoofed message
distills into `LESSONS.md` on the same 10-minute timer as a real one, with no
marking. Today that is harmless, because nothing reads the file. **The moment
§4 lands it stops being harmless**: a mini app that can call `agent.ask`
twenty times a day gets to write text into the agent's permanently-injected
instructions, one distillation at a time. That is the brain-poisoning attack
`docs/miniapp-capabilities.md` §2 named — the one `files.propose` refuses
`AGENT.md` and `LESSONS.md` to prevent — reached by a longer path that nobody
guarded because the destination was inert.

So provenance has to land **before** retrieval, not after. This is the one
ordering constraint in the plan that is not negotiable.

## 4. What is wrong with the rest

**Lessons are prose in a flat file, so nothing can be done with them.**
An entry is `## <date>  <session title>` plus up to 400 characters. There is
no id, no tag, no source, no usage count. Consequences: the same lesson
learned five times is five entries; there is no way to retrieve the three
lessons relevant to *this* turn; and the 100 KB trim drops the **oldest**
entries regardless of value, so the best lesson an agent ever learned is
deleted on age while a duplicate from last week survives. Append-only with a
tail trim is a log, not a memory.

**Nothing consolidates or forgets on purpose.** Real memory systems merge
near-duplicates and let unused entries decay. This one grows until it is
trimmed by byte count.

**Loop work never journals — but the file says it does.** The seed text
promises "the journal fills as <name> completes scheduled and interactive
work," and `Loop · %` is excluded from the sweep. Scheduled work is the
proactive half of the product and it leaves no trace in the agent's own
record. (The exclusion is defensible — a heartbeat loop firing hourly would
bury the journal — but then the promise should change, or loop distillation
should be rarer rather than absent.)

**`knowledge/` is dead.** Seeded with a README, referenced in the prompt,
never written by anything. There is a real distinction it could carry —
episodic lessons ("this API needs a retry") versus durable reference material
("the client's billing codes") — and right now the second has nowhere to go
but a lesson entry it will outlive.

**Recall is lexical only.** `plainto_tsquery('english')` matches stems, not
meaning. "What did we decide about the invoice thing?" will not find a
conversation that said "billing dispute." Paraphrase is exactly what
"whenever they reference earlier work" looks like in practice, so the tool
misses in its main use case and the agent has no signal that it missed.

**Feedback influences one turn and evaporates.** `takeFeedback` drains on
read. A user correction shapes the next reply and is then gone unless the
model happens to fold it into a distilled lesson hours later — for a session
that may never go idle in a distillable state. The most explicit "learn this"
signal in the product is the most ephemeral thing in it.

**Compaction and memory are unrelated.** When a long chat compacts, the
summary lives in `compactSummary` and dies with the session. Compaction is
already an LLM pass over exactly the material distillation wants; running two
independent summarizers over the same transcript is waste.

## 5. Threat model for memory

Memory is an injection surface, and it is the most valuable one in the system:
unlike a poisoned tool result that affects one turn, a poisoned lesson affects
every future turn, silently, forever. Three rules follow.

1. **Provenance is not optional.** Every durable memory records which session
   it came from and what trust tier that session had (user chat, loop,
   channel, app). Tier decides whether it can ever be injected.
2. **Untrusted surfaces propose, they do not teach.** App- and
   channel-originated sessions may produce *quarantined* lessons the user can
   promote, never lessons that enter the prompt on their own. This is the same
   propose-don't-act shape as `files.propose` and `connections.propose`.
3. **Injected memory is visible and revocable.** The user can see exactly
   which lessons are in their agent's prompt and delete any of them. A memory
   nobody can inspect is one nobody can correct — and `.checkpoints/` gives
   rollback for the file, not for what the model was told.

## 6. The plan

### Phase 1 — Provenance and trust tiers *(prerequisite for everything)*
Record with every distillation: `sessionId`, `sessionKind`
(`chat` | `loop` | `channel` | `app`), and a `trusted` flag derived from it.
Only `chat` and `loop` are trusted. App and channel distillations are written
with `trusted: false` and never injected — they surface in the agent's event
feed as "learned something from a mini app — review it?" and enter the pool
only if the user says yes. Cost: small. Value: makes Phase 2 safe rather than
dangerous.

### Phase 2 — Close the loop with a bounded, ranked digest
Inject an **active lessons** block into the system prompt, beside workspace
memory: the top N trusted lessons under a hard character budget (~3–4 KB, the
same order as the profile). Ranking for v1 is recency plus a pin flag —
deliberately dumb, because the point of this phase is that distillation starts
mattering at all, and a dumb ranker that ships beats a good one that waits for
Phase 5. Render it with the same "these are your own past conclusions, not
instructions from the user" framing the profile already uses.

This single change is what turns six months of accumulated lessons from
decoration into behavior.

### Phase 3 — A real lesson store
Move lessons to a table (`agent_lessons`: id, agentId, text, tags, sourceKind,
sourceSessionId, createdAt, lastUsedAt, useCount, pinned, trusted) and
**regenerate `LESSONS.md` from it** on every write. The file stays exactly as
transparent as it is today — that is a product promise (FR-11.3), and users
should keep being able to read and edit their agent's memory as a file — but
it stops being the source of truth for machine reads, which is what makes
dedup, ranking, and forgetting possible at all.

On write, near-duplicate detection (trigram similarity against existing
lessons for that agent): a repeat becomes `useCount++` and a timestamp bump
rather than a second entry. That alone removes most of the growth pressure
that the byte-cap trim exists to relieve.

### Phase 4 — Consolidation and deliberate forgetting
A periodic pass (weekly, same scheduler as the distill sweep) that merges
clusters of related lessons into one better-written lesson, and decays entries
that are old *and* unused *and* unpinned. Trim by value, not by age. Because
Phase 3 gave every lesson a `useCount` and Phase 2 gave it a chance to be
used, "value" is finally measurable.

### Phase 5 — Retrieval that survives paraphrase
Two steps, cheapest first: add `pg_trgm` fuzzy matching as a fallback when
`plainto_tsquery` returns nothing (a few lines, catches typos and near-misses
immediately), then evaluate `pgvector` embeddings over lessons and messages
for genuine semantic recall. With Phase 3's table in place, embeddings are a
column and a nightly backfill rather than a re-architecture — which is the
argument for doing the store before the retrieval, not after.

### Phase 6 — Loose ends, each small
- Route 👎 feedback straight into the lesson pool as a pinned, trusted lesson
  instead of draining it into a single turn.
- Let compaction hand its summary to distillation instead of running a second
  pass over the same transcript.
- Give loop sessions a rarer journal path (one rolled-up entry per day, not
  per run), or fix the seed text that promises they journal.
- Decide `knowledge/`: either a `write_note` tool for durable reference
  material distinct from episodic lessons, or delete the folder and the prompt
  line. Dead scaffolding teaches agents that the folder is meaningless.

## 7. What we deliberately do not build

Cross-agent memory sharing — agents stay separate brains; the shared surface
is skills and `shared/`, both explicitly promoted. Automatic profile writes
without consent, which the current design already refuses and should keep
refusing. Unbounded prompt growth: every injected block stays hard-capped,
and "the agent remembers more" must never mean "every turn costs more
forever." Embeddings before Phase 3 — the store is what makes them cheap to
add and cheap to abandon. Memory that the user cannot see or delete.

## 8. Sequencing

Phase 1 must precede Phase 2; that is a safety constraint, not a preference.
Phase 2 is the one that changes product behavior and should ship immediately
after. Phase 3 unblocks 4 and 5 and can be done any time after 2. Phase 6 is
independent throughout.

A reasonable first cut is **1 + 2 together** — provenance, then the digest —
which is a few days of work and is the difference between agents that
accumulate memory and agents that use it.

## 9. Where this lives in code

- `server/src/chats/distill.service.ts` — the distillation prompt and parse
- `server/src/chats/loops.service.ts` — `distillSweep`, the 10-minute timer
- `server/src/chats/chats.repository.ts` — `sessionsNeedingDistill` (the trust
  filter belongs here), `searchAgentMessages` (FTS recall)
- `server/src/agents/agents.service.ts` — `appendBrainFile`, the append queue,
  caps, `.checkpoints/`, `seedBrain`, `takeFeedback`
- `server/src/chats/turn-context.service.ts` — the system prompt; where the
  active-lessons block belongs, beside workspace memory and the profile
- `server/src/database/migrator.ts` — migration `0006-recall-profile` (FTS
  index); the lessons table lands as a new numbered migration
- `server/src/workspaces/workspaces.service.ts` — profile proposals, the
  consent pattern quarantined lessons should copy
