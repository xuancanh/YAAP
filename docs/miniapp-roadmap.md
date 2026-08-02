# Mini apps, act two: model calls, live data, storage that scales, and the connected world

Status: **shipped**. Every step in §8 landed; this document is now the design
of record for what runs, with the review in §1 kept as the reasoning behind
it. Deliberate departures from the original design are marked *(shipped as)*.

`docs/miniapp-capabilities.md` designed act one — the shim, seven
capabilities, the three-gate manifest, host-rendered review. This document
started as a review of what actually landed there, named where the code and
the docs disagreed, and designed what apps needed next: talking to a model
directly, working with files they can hand back, holding more than 64 KB, and
reaching the connections their agent already owns. All of it is now built;
§1 is preserved as written, because the gaps it found are the reason the rest
of the document takes the shape it does.

## 1. What shipped, verified against code

The bridge is real and it is close to the design. `src/components/AppHost.tsx`
injects the shim, filters ops against the manifest, renders confirms outside
the frame, and forwards to `server/src/appbridge/`, which re-derives every
grant from stored state rather than trusting the parent. All seven
capabilities work: `storage`, `chat.compose`, `files.read`, `files.write`,
`tasks.read`, `tasks.write`, `agent.ask`. The scoping rules hold — writes land
only under `apps/<appId>/`, reads see exactly the agent's own FileRoot,
app-originated turns run Ask-mode with approval-gated tools auto-denied.
Covered by `tests/backend-appbridge.test.ts` and `web-tests/sandbox.test.ts`.

So the capabilities doc's §7 shipping order (v1 "state and sight", v2 "hands",
v3 "voice") is complete, and its "Status: design" header is wrong. Fixed
alongside this document.

Three gaps were not cosmetic. All three are now closed (§8 step 1); the
findings stay here because each was a claim believed for months:

- **The quota claim is aspirational.** §2 threat 4 says "everything is
  quota'd and rate-limited per app." Only `agent.ask` is (20 turns/day).
  `storage.set`, `files.read`, and `tasks.add` take unbounded call rates —
  an app in a `while(true)` can hammer S3 and fill the board. This is the
  same failure shape as the CSP hole: an invariant stated in prose, believed
  because it was written down, never enforced in code. Worth naming as a
  pattern, because it has now happened twice. *Now enforced* in
  `bridge-limits.ts`, billed through the one gate every op passes.
- **Reads leave no trace.** §6 promised the event feed would show bridge
  activity ("read reports/ (12 files)"). Only `files.write` and `tasks.add`
  emit events. An app with `files.read` can walk the entire agent folder and
  the user sees nothing, ever. Reads are the capability most likely to be
  granted casually, so they are the ones most worth logging. *Now logged* on
  a curve — the first read, then every 25th — so a walk of the folder is
  visible without one feed line per file.
- **Confirms are `window.confirm`.** Safe — browser chrome is outside the
  frame, so consent cannot be spoofed — but it cannot show a real payload,
  cannot offer per-scope "remember", and blocks the page. The design called
  for the tool-approval card's shape. *Now a card* that shows the payload,
  splitting remember-once ops from the always-ask ones where the payload is
  the decision.

## 2. What the threat model says about act two

Nothing below changes the founding rule: **apps have no network, ever**,
enforced by `default-src 'none'`. Every capability here is exfiltration-safe
only because that holds. Two additional principles fall out of the review and
govern the new work:

**Shape is the allowlist.** The reason `tools.invoke` was deferred is that an
approved GET with a `{query}` placeholder becomes an exfiltration channel once
an app controls the parameter. The fix is not to review harder — it is to
never hand apps a free-form request. A fixed API (`calendar.list(range)`)
cannot express "send this data to evil.com" no matter what the app passes,
because the destination was never a parameter. Where an app needs to express
something open-ended, it does not get to *execute* it — it proposes.

**Propose, don't act.** For every operation whose blast radius reaches outside
the app's own folder — writing a deliverable, creating a calendar event,
drafting mail — the app builds a payload and the host renders it for approval,
then *the server* executes under the agent's existing grant. The app never
holds the authority; it holds a request. This generalizes what §4.5 already
required for file promotion, and it is what makes integrations tractable.

An app's authority is always the intersection: **app grant ∧ agent grant ∧
user confirm**. An app can never exceed the agent that built it.

## 3. Talking to a model: `llm.*` alongside `agent.ask`

`agent.ask` runs a full turn — the agent's brain, its files, its tools, its
memory. That is right for "crunch the numbers in my folder" and wrong for
almost everything else an app wants. A tagger that classifies 40 entries, a
form that extracts fields from pasted text, a summarizer — routing those
through an agent turn costs the whole system prompt per call, returns prose
when the app needed JSON, and may nondeterministically decide to use a tool.

Add a **plain model call**: no agent context, no tools, no memory, no file
access.

```js
const out = await yaam.llm.complete('Classify: ' + text, { schema, maxTokens });
for await (const chunk of yaam.llm.stream(prompt)) render(chunk);
```

- Routed to the cheap model tier from settings; `schema` (JSON Schema)
  constrains output so apps get parsed objects, not prose to regex.
- Budgeted in **tokens per app per day**, not turns — the natural unit for
  something an app calls in a loop — with the remaining budget readable via
  every result's `remainingTokensToday` so apps degrade gracefully instead of
  failing at 3 pm. *(shipped as: the budget rides on each result rather than a
  separate `yaam.llm.budget()` call — one fewer round trip, same information.)*
- Vision: not shipped. `files.read` already returns base64 for images, so this
  is a provider-plumbing change, not a bridge one; deferred until an app wants
  it.

The risk class is **cost, not agency**. Being tool-free and context-free makes
`llm.complete` strictly safer than the `agent.ask` we already ship: the worst
case is a token bill, and a per-day ceiling bounds it. It should therefore
activate at a *lower* tier than `agent.ask` — activation-gated, no per-call
confirm — and it is likely to become the most-used capability in the set.

`agent.ask` keeps its place for anything needing the agent's own knowledge.
*(shipped as: streaming landed on `llm.stream` only. `agent.ask` still returns
one block at the end — it runs the full turn loop with approval waits inside
it, so relaying it is a larger change than wrapping a provider stream, and the
calls it serves are rarer.)*

## 4. Files: give apps a way to hand work back

Writes are trapped under `apps/<appId>/`, which is correct — an app that could
write `AGENT.md` could author instructions its agent will later obey. But the
consequence is that an app can never produce anything the user sees in the
Files tab. Today the workaround is `chat.compose` asking the agent to move the
file, which is a strange dance for "export this cleaned CSV."

**`files.propose(path, content)`** — the promotion path, host-rendered:

- The app submits a target path and content; the host shows the content in a
  card naming the app. *(shipped as: the full proposed content, not a diff
  against the existing file — a diff view is a rendering improvement over the
  same approval, and the decision is the same either way.)*
- On approval the **server** writes it, into the agent's folder proper, with
  an event recording which app proposed it. The app never gains write reach.
- Refused for anything the agent treats as instructions (`AGENT.md`,
  `LESSONS.md`, memory files, `.checkpoints/`) regardless of approval — the
  brain-poisoning boundary is not a thing users should be able to click
  through.

Two smaller additions make dashboards stop lying:

- **`files.watch(prefix)`** — long-poll or ETag-compare so a dashboard over
  `reports/` updates when the agent writes, instead of freezing at open time.
  This is the entire original motivation for `files.read`, and without it
  every dashboard is a snapshot again the moment it is left open.
- **Range reads** past the 200 KB preview cap, so a CSV visualizer can page
  through a real export rather than seeing a truncated head.

## 5. Databases: three shapes, two worth building

`storage` is a 64 KB last-write-wins JSON blob. A habit tracker outgrows it in
a year; an expense log with receipts outgrows it in a month; anything wanting
to *query* never fit in the first place. Three candidate shapes:

**a. SQLite in the frame, over a file in the app's folder.** The engine is
WASM; the database is bytes the app already owns. No new server surface, no
new trust boundary — it is `files.read`/`files.write` plus a query engine
running inside the sandbox. It also composes with the code runner: the agent
can open the same `.db` with Python's `sqlite3` and analyze what the app
collected.

One real constraint, inherited from the CSP: **the engine cannot be fetched
by URL.** `default-src 'none'` blocks loading a `.wasm`, so the bytes must
arrive through the bridge (`yaam.sql.engine()` returning base64) or be inlined
in the shim. Compilation itself is fine — `script-src` carries `'unsafe-eval'`,
which covers WebAssembly. Anyone implementing this will otherwise lose an hour
to a silent CSP violation.

**b. App-scoped structured collections.** `yaam.data` over server-side rows:

```js
const db = yaam.data.collection('entries');
await db.put({ id, date, amount, tag });
await db.query({ where: { tag: 'food' }, order: ['date', 'desc'], limit: 50 });
```

A bounded query surface — filter, order, limit, an index or two — with no SQL
string to parse and therefore no injection surface. Rows live under the app's
namespace, quota'd by count and bytes, exportable with the agent. This is what
apps that outgrow a single blob should use.

**c. Arbitrary SQL against our Postgres.** Rejected — see non-goals. Untrusted
model-written code emitting free-form SQL at the primary database is a blast
radius no review gate justifies, and (b) covers the actual demand.

Recommendation: **(a) first** — it is nearly free, needs no new endpoint, and
handles "hold 50k rows and pivot them" today — then **(b)** when apps need
data the agent and multiple app versions share.

For heavy compute, apps do not need a database at all; they need the runner we
already ship. **`yaam.compute.run(language, code, files)`** hands work to the
same sandboxed backend as `run_js`/`run_python` (`docs/code-execution.md`) —
network-denied, scratch-only, time-capped. That is how an app gets pandas
without us shipping pandas to the browser. It inherits the runner's existing
safety properties rather than inventing new ones.

## 6. Integrations: fixed shapes to read, proposals to write

Connections now exist with per-service, per-level grants (Google and Microsoft;
calendar, mail, drive; read and write) and a confirm-always class for sending.
That machinery is what `tools.invoke` was waiting for, and it changes the
answer: apps still never get generic tool invocation, but they can get
**fixed-shape views** onto grants their agent already holds.

```js
await yaam.connections.list();                       // what's available
await yaam.connections.calendar.list({ from, to });  // read grant required
await yaam.connections.mail.recent({ limit: 20 });   // read grant required
```

No URL, no free-form query, no header control — the app chooses among
parameters we defined, so there is no request it can shape into an exfiltration
channel. Access requires the agent to hold the grant *and* the app to have
been activated for it; the app is strictly weaker than its agent.

Writes follow §2's propose rule:

```js
await yaam.connections.calendar.propose({ title, start, end, attendees });
await yaam.connections.mail.proposeDraft({ to, subject, body });
```

The host renders the real card — the same one the agent's own tool calls use,
showing recipients and body in full — and on approval the server executes under
the agent's grant with the existing provenance stamp. Sending mail stays
confirm-always even in Auto mode, because it already is; nothing about an app
asking for it may relax that.

Mail bodies returned to an app are **untrusted external content**, exactly as
they are for the agent, and carry that framing — an app rendering attacker
text into its own DOM is contained by the CSP, but an app feeding that text
into `llm.complete` or `agent.ask` is a prompt-injection path worth naming.

Custom HTTP tools stay off-limits to apps. Their parameters are attacker-shaped
by construction, which is the original objection and still holds.

## 7. What we deliberately do not build

Raw `fetch` in any form. Arbitrary SQL against the application database.
App-to-app communication or shared storage. Reading another agent's files,
tasks, or connections. Chat history. Channel credentials or OAuth tokens in
any form, including "just the account email." Custom-tool invocation with
app-supplied parameters. Persisted "always allow" for `agent.ask` across
mounts — the per-mount memory is deliberate.

Apps also do not get to *bypass* the agent: every capability here is a
narrower view of something the agent can already do, never a new reach.

## 8. Sequencing — all shipped

1. **Truth pass** *(done)* — a sliding-window rate limit per app per op class
   (reads 150/min, writes 40/min, model calls 30/min), read provenance on a
   curve (the first read, then every 25th, so the feed stays readable), and a
   confirm card that shows the payload instead of `window.confirm`.
2. **`llm.complete` / `llm.stream`** *(done)* — tool-free, context-free, with
   a per-app daily token budget and prompt-level schema output.
3. **`files.propose` + `files.watch`** *(done)* — plus `offset` on reads.
   Promotion refuses the agent's instruction files whatever was approved.
4. **Data** *(done)* — `yaam.data` collections **and** `sql.engine()`
   delivering sql.js as bytes. Shipped in the reverse of the order proposed
   here: collections came first because they need no new dependency, and the
   engine followed once the delivery mechanism the CSP forces was in place.
5. **`connections.*`** *(done)* — read views and propose-to-mutate. *(shipped
   as: no mail sending at all, see §6 — a narrowing, not an expansion.)*
6. **`compute.run`** *(done)* — over the existing RunnerService, adding no new
   sandbox and no new safety claims.

One gate covers all of it: `AppBridgeService.gate()` re-derives the manifest
grant and bills the rate ceiling for every op, including the ones the
collaborator services (`llm`, `data`, `connections`, `compute`) own. Each
surface re-implementing that check is how boundaries rot.

## 9. Where this lives in code

- `src/components/AppHost.tsx` — shim, op routing, confirms, `CAP_INFO`
- `server/src/appbridge/` — controller + service, grant re-derivation, scoping
- `server/src/agents/agents.service.ts` — `save_app`, manifest, `approveAppCaps`
- `src/lib/sandbox.ts` — the CSP everything above depends on
- `server/src/chats/turn-loop.service.ts` — `save_app` spec, tool gating
- `server/src/connections/` — grants the `connections.*` views would read
- `server/src/runner/` — the backend `compute.run` would target
- `server/src/appbridge/app-llm.service.ts` — `yaam.llm`, tool-free calls
- `server/src/appbridge/app-data.service.ts` — collections + the SQLite engine
- `server/src/appbridge/app-connections.service.ts` — the fixed-shape op table
- `server/src/appbridge/app-compute.service.ts` — the runner, gated for apps
- `server/src/appbridge/bridge-limits.ts` — rate classes and read provenance
- `tests/backend-appbridge.test.ts` (20 cases), `web-tests/sandbox.test.ts`
