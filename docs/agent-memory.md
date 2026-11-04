# Agent memory: nine mechanisms, one broken loop, and how to close it

Status: **shipped**. All six phases landed; the review in §1–§5 is preserved
as written because it is the reasoning behind the design, and §6 now records
what each phase actually became. Departures are marked *(shipped as)*.

Durable agents in this codebase **wrote lessons they never read**. Everything
else here follows from that: the machinery for learning was built, tested, and
running on a timer, and the last link — putting what was learned back in front
of the agent — had never been connected. Sections 1–5 are the review as
written, in the present tense of the code as it then stood; they review all
nine memory mechanisms, name what was wrong with each, and sequence the fixes
so that closing the loop did not open a hole.

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

*(shipped as: phases 1 and 3 landed together. Phase 1 needed somewhere to
put provenance, and writing it into the flat file only to move it in phase 3
would have been work done twice. The safety ordering that mattered —
provenance before injection — held.)*

### Phase 1 — Provenance and trust tiers *(done)*
Record with every distillation: `sessionId`, `sessionKind`
(`chat` | `loop` | `channel` | `app`), and a `trusted` flag derived from it.
Only `chat` and `loop` are trusted. App and channel distillations are written
with `trusted: false` and never injected — they surface in the agent's event
feed as "learned something from a mini app — review it?" and enter the pool
only if the user says yes. Cost: small. Value: makes Phase 2 safe rather than
dangerous.

### Phase 2 — Close the loop with a bounded, ranked digest *(done)*
Inject an **active lessons** block into the system prompt, beside workspace
memory: the top N trusted lessons under a hard character budget (~3–4 KB, the
same order as the profile). Ranking for v1 is recency plus a pin flag —
deliberately dumb, because the point of this phase is that distillation starts
mattering at all, and a dumb ranker that ships beats a good one that waits for
Phase 5. Render it with the same "these are your own past conclusions, not
instructions from the user" framing the profile already uses.

This single change is what turns six months of accumulated lessons from
decoration into behavior.

### Phase 3 — A real lesson store *(done)*
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

### Phase 4 — Consolidation and deliberate forgetting *(done, partly)*
Trimming by value shipped: `consolidate()` runs on every write and keeps the
top 300 by pinned, then recurrence, then recency — so a pinned lesson survives
being old, which the byte-cap tail-trim could never do.

*(shipped as: no LLM merge pass. Dedup-on-write collapses the repeats that
drive most growth, and 300 rows is far from the pressure point, so a weekly
model call to rewrite clusters would spend tokens on a problem nobody has
yet. The hook is `consolidate()` when it does.)*

### Phase 5 — Retrieval that survives paraphrase *(done, step one)*
`search_history` now falls back to substring matching on the query's longest
words when the stem query returns nothing, so a miss degrades to partial
recall instead of the silent zero-result an agent reads as "we never discussed
that". `pg_trgm` is installed where available and powers near-duplicate
detection on lesson writes.

*(shipped as: the recall fallback is ILIKE rather than trigram similarity —
it needs no extension, so it behaves identically on PGlite and Postgres.
pgvector embeddings remain future work; with the phase-3 table in place they
are a column and a backfill, which was the argument for building the store
first.)*

### Phase 6 — Loose ends *(done)*
- 👎 **with a note** now becomes a pinned, trusted lesson as well as
  shaping the next turn. *(shipped as: only when the user wrote a note — a
  bare thumbs-down carries no content worth making permanent.)*
- Loop sessions journal **once a day** instead of never, keeping the promise
  the seeded JOURNAL.md makes without burying it under one entry per run.
- `knowledge/` kept and given a purpose in the system prompt: durable
  reference material (conventions, account names, recurring specs) as against
  lessons, which are conclusions about doing the work. *(shipped as: prompt
  guidance over the existing fs tools, not a new `write_note` tool — agents
  could always write there; nothing told them when to.)*
- **Not done:** handing compaction's summary to distillation. Both passes
  exist and overlap, but compaction runs mid-session on live history while
  distillation runs after idle on the whole transcript; sharing output means
  reconciling two different cutoffs for a saving of one model call. Left
  alone deliberately.

### Audience — who a lesson is for *(execution-plan item 8)*
With more than one human on a workspace (`docs/shared-agents.md`) a lesson
has a second axis beside trust: `agent_lessons.audience`, `shared` or
`private:<memberAccountId>`. Distillation sets it from the session: content
that came through a member's connection makes the lesson that member's; a
member's private session makes it theirs; a shared session with nothing
private in it stays shared; a workspace with no members is all shared.
`digest(agentId, { actor, allowFrom })` injects shared rows plus the acting
member's own plus what a `workspace_flow_rules` allow row opens — never
another member's private rows by default, the owner included. Dedup runs
within an audience so repetition cannot widen one. The Memory tab badges
each row and lets the owner flip a private lesson to shared; no agent tool
can. The same split applies to the consented profile: a `private:<member>`
proposal lands in `workspaces.profilePrivate[member]` and is injected only
for that member. Trust (§3) and audience are independent: a quarantined
private lesson needs both a promotion and the right reader.

## 7. What we deliberately do not build

Cross-agent memory sharing — agents stay separate brains; the shared surface
is skills and `shared/`, both explicitly promoted. Automatic profile writes
without consent, which the current design already refuses and should keep
refusing. Unbounded prompt growth: every injected block stays hard-capped,
and "the agent remembers more" must never mean "every turn costs more
forever." Embeddings before Phase 3 — the store is what makes them cheap to
add and cheap to abandon. Memory that the user cannot see or delete.

## 8. Import

*(execution-plan item 9)* Memory arrives from outside in two shapes: our own
AGENT.json (now `formatVersion: 2`, carrying `lessons`, the agent's private
`skills`, open `tasks`, and — only when exported with `?includeProfile=1` —
the workspace `profile`), and other assistants' exports. The importers live
in `server/src/portability/` (`POST /api/agents/:id/import/memory` with
`{ format, content, workspaceId? }`, where `content` is one file's text or a
`{ filename: text }` map; the UI reads the files client-side):

| format | source files | mapping |
|---|---|---|
| `claude-memory` | the text users copy from Settings → Your Claude → Manage, or Claude's "write out your memories of me verbatim" reply; Claude has no file export, so we accept a JSON array of `{ topic?, text }` (or strings), a markdown bullet list, or the `[date] - text` lines Claude's own import prompt asks for | entries that read as facts about the user → profile proposals; the rest → lessons |
| `muse` | `Soul.md`, `Identity.md`, `Memory.md` | Soul → charter addendum (shown as a diff, applied by the user); Identity → lessons; Memory → lessons / profile proposals |
| `hermes` | `MEMORY.md`, `USER.md` | MEMORY → lessons; USER → profile proposals |
| `openclaw` | `MEMORY.md`, `USER.md`, `SOUL.md` | as Hermes, plus SOUL → charter addendum |

The rule is the one §3 set for apps and channels, applied to a wider mouth:
**nothing imported becomes trusted memory without a human click.** Imported
lessons carry `sourceKind: 'import'` and `trusted = 0` — a seventh source
kind, untrusted like `app` and `channel` — and sit in "Awaiting review" until
promoted; the AGENT.json modal has a "trust imported lessons" tick for the
one case where that is right (an export you made yourself). Profile lines go
through `addProfileProposal`, the consent queue the profile already had. A
persona is never written into the charter by the importer; the user sees the
proposed charter as a line diff and applies it. Imports dedup against every
existing lesson regardless of tier, and against themselves, so importing the
same export twice is a no-op. The summary the UI shows is
`{ lessons, profileProposals, charterSuggestion, files }`.

Skills come in through the same door with their own scan
(`docs/permissions.md`, "Skills"): an agentskills.io `SKILL.md` lands as a
draft with a `scanReport`, and an AGENT.json's skills land as drafts too.

Verified by `tests/backend-portability.test.ts`: the v2 round-trip (lessons
quarantined on import, trusted only when ticked; skills as drafts; tasks as
todo; v1 files still import), each importer's mapping, that `importMemory`
never creates a trusted row or touches the charter, and dedup.

## 9. What this changed

Agents now use what they learn. A lesson distilled from a real conversation
reaches the system prompt on the next turn, ranked and capped, framed as the
agent's own past conclusion rather than as a user instruction. Lessons learned
on untrusted surfaces are quarantined and surfaced for review instead. Every
lesson is visible, pinnable, and deletable on the agent's **Memory** tab,
because a memory nobody can inspect is one nobody can correct.

Verified by `tests/backend-memory.test.ts` (8 cases), including the one that
would have caught the original defect: that the digest reaches `ctx.system` at
all.

## 10. Where this lives in code

- `server/src/portability/` — `importers.ts` (format parsers, pure),
  `portability.service.ts` (AGENT.json v2 export/import, `importMemory`),
  `skill-md.ts` (SKILL.md parse/scan/render); `AgentMemoryService.importLessons`
  is the only write path imports use

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
- `server/src/agents/agent-memory.service.ts` — the store, digest, dedup,
  consolidation, and LESSONS.md regeneration; `audience`, `visibleTo`
- `server/src/chats/distill.service.ts` `audienceForSession`,
  `server/src/shared/shared.service.ts` `allowedSources` — who a new lesson
  is for and who else may read it (`docs/shared-agents.md` §4)
- `src/components/AgentsView.tsx` — the Memory tab (promote, pin, forget)
- `tests/backend-memory.test.ts` — provenance, quarantine, dedup, budget,
  and the prompt-injection check that closes the loop
- `server/src/workspaces/workspaces.service.ts` — profile proposals, the
  consent pattern quarantined lessons copy

## 11. What a company member knows without asking

Memory above is what an agent *learned*; a company member also needs what
is simply *true* about its company and its place in it. Two mechanisms,
both in `server/src/org/org-briefing.service.ts`
(docs/agent-data-access.md §7 has the format, the audit and the sizes):

**The company briefing** — injected into every member's system prompt on
every turn (chat, heartbeat, task run, review, planning, meeting round,
channel wake), at most 2,500 characters: the company's name, one-line
mission, vision and top values; the member's title, unit, manager, direct
reports and the projects it is on with its part; key results with RAG;
its projects' health, next milestone and target; its own open and blocked
tasks with the top keys; recent decisions in its units; what is waiting on
it (cards, reviews, mentions); and the tools that hold the detail. The
emphasis follows the role (the chief: portfolio and exceptions; a head: its
unit and staffing gaps; a specialist: its work and its project). Like the
lessons digest it is hard-capped, so a bigger company never means a bigger
prompt; unlike lessons it is computed from the company's records, never
written by the agent, and never carries another agent's memory.

**`knowledge/company.md`** — the slowly changing part (mission, values, its
role and reporting line, its unit, its reports, its projects and whether it
leads them) written into the member's home, so it survives outside prompts
and `fs_search` / `fs_read` find it. It is regenerated, not appended: after
an audit entry that can change standing (a hire, a member update or reorg,
a unit change, a project created or re-led, a task created) the members'
notes are recomputed after a short debounce, and on every briefing render;
a note is rewritten only when its text changed (it carries no timestamp).
The file says it is generated; an agent's own notes belong in other files
under `knowledge/`. The briefing's last line points at it.

Verified by `tests/backend-company-briefing.test.ts`: the note's content,
no rewrite when nothing changed, a rewrite on a project re-lead (for both
leads and nobody else), on a hire (the new member and its manager), on a
promotion to head, and the debounced refresh after an audit entry.

## 12. Learning as they work *(4 November 2026)*

An audit of a running company ("Real Jong", six members, ~150 runs) found
the loop closed in code but not in behaviour:

- **No tool to remember.** The only write path was distillation of an idle
  session. Members that wanted to keep a lesson appended it to LESSONS.md
  with `fs_append` / `fs_edit` (seven times across four members), and the
  next `regenerate()` overwrote the file from the table, erasing them. One
  wrote to `/home/user/LESSONS.md`, outside its home.
- **No trigger to write.** The prompt said lessons existed and that
  `search_history` existed; nothing said when to record one. The moments
  that teach most produced no lesson: a review that sent work back, a breaker
  stop, a CEO rejection with a note.
- **Dedup was exact-text on PGlite.** With no `pg_trgm`, every paraphrase was
  a new row: 86 lessons, every `useCount` 1, so "ranked by recurrence" was
  ranking by recency.
- **Half the lessons never reached the prompt.** The top 12 by recency
  within 3.5 KB: 11 of 20, 11 of 26 and 11 of 29 for the three busiest
  members, with nothing chosen for the task at hand. Retro lessons spent
  ~130 characters each on the meeting title.
- **Nothing ever changed guidance.** No playbook, no `charter_change` card;
  the only path from a lesson to a charter was a retro participant typing a
  proposal.

What changed:

**Capture.** `memory_note` (chats/memory-tools.service.ts) records a lesson
the moment it is learned (the rule, what happened, the evidence), or
confirms / retires one by the 8-character id the prompt shows; six per
session per hour. Model-free capture at the work's own moments
(`OrgLearningService`): a review sent back teaches the assignee the
reviewer's note, and acceptance afterwards confirms it; a loop or
no-progress stop teaches a rule with the task key; a proposal the CEO
rejected with a note teaches who asked; an accepted task gets a journal
line. A 👎 with a note is a pinned `feedback` lesson with the reply as
evidence; retro lessons are recorded as the rule, with the retro as
context and evidence. `memory.captureTriggers` switches each. Lessons carry
`cause`, `context`, `evidence` (≤ 8 refs), `tags`, `recalls`, `status`
(migration 0092); text is capped at 600 characters, and dedup falls back to
model-free term similarity (Jaccard / overlap ≥ 0.6) when `pg_trgm` is
absent or misses. Distillation asks for the rule and its evidence and pulls
task keys from the transcript.

**Recall.** The digest is a small always-on core (8 lessons, 2.2 KB: pinned,
then learned-again, then recalled, then recent) plus up to 4 lessons
relevant to this turn's text (the person's message, the task wake, the
heartbeat), matched on rare shared words, tags, context and a task key in
the evidence, within the same 3.5 KB. A relevant hit counts as a recall,
which lets a useful lesson climb into the core. `memory_recall` searches the
lessons (retired ones marked) and knowledge/ notes.

**Consolidate.** `consolidateAgent` on the loops tick (once per agent per
six hours): merge paraphrases (counts, recalls and evidence add up), retire
lessons learned once, never recalled, not pinned and not a person's
correction after `memory.lessonStaleDays`, then trim to 300. LESSONS.md
lists the top 60 active by value with their evidence, the retired apart;
JOURNAL.md rotates its older part into `journal/<date>.md` instead of
dropping it.

**Self-guidance.** `agents.selfGuidance` is the agent's own How I work
section (1.5 KB), injected right after the charter; `memory_guidance`
rewrites it naming the lessons, and a person edits it on the Memory tab.
Every change is a row of `agent_guidance_changes` with its lesson ids, and
HOW-I-WORK.md is generated from the section and its log. A lesson learned
`memory.guidanceRepeats` times is proposed (never written): a revise task
for an active playbook it names, otherwise one `charter_change` card at a
time with the diff and the lessons. Boundary rows `self_guidance` (alone),
`guidance_proposal` (propose), `lesson_audience` (never); see
docs/boundary.md. Untrusted surfaces (an app, a channel) may only propose a
lesson: they cannot confirm, retire or touch guidance. Agents' `fs_*`
writes to LESSONS.md and HOW-I-WORK.md are refused with the tool to use.

**Visibility.** The Memory tab (`src/components/AgentMemoryTab.tsx`) shows
How I work and where each change came from, the proposals waiting on a
decision, and lessons with what made them, learned / recalled counts and
evidence, filtered to all, learned this week, or retired; a person pins,
edits, retires, restores or forgets each.

Verified by `tests/backend-agent-learning.test.ts` and
`web-tests/agent-memory-tab.test.tsx`.
