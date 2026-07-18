# Mini app capabilities: what apps need and how we hand it to them

Status: design. Companion to `docs/permissions.md`, which reserved the move:
"the day an app can call a tool or fetch a URL, it moves to the skill/tool
review class with a per-app capability manifest." This document designs that
manifest and the runtime behind it.

## 1. Where we are, and why it is not enough

A mini app today is inert HTML in an `allow-scripts` iframe with an opaque
origin and no network. That sandbox is airtight — and it makes apps toys:

- **No state.** The opaque origin means even `localStorage` throws. A habit
  tracker forgets your habits when you close it. Every app is a stateless
  calculator.
- **No data.** An agent that maintains `reports/weekly.md` cannot build a
  dashboard app that *shows* it. The app and the agent's working folder are
  two worlds; the agent has to hard-code data into the HTML at save time,
  which is why every generated dashboard is a snapshot that lies within a day.
- **No hand-off.** An app can render a "Summarize this week" button, but the
  button cannot reach the agent. The user reads the app, then re-types what
  they want into chat.

The promise of profession packs makes this acute: Bookkeeper should ship a
cash-flow dashboard fed by real ledger files; Support Desk's triage helper
should file the ticket it just prioritized as a task.

## 2. Threat model before feature list

Mini apps are **untrusted code**. They are written by the model, and the
model writes them under the influence of whatever text it has read — a
poisoned email, a hostile web page, a malicious skill proposal. Assume an
app can be adversarial even when the agent is honest. Four attacks matter:

1. **Exfiltration.** Data the app can read leaves the machine. Only possible
   with a network path — so apps keep **no network, ever**. Every capability
   below is exfiltration-safe only because this stays true (and because
   `agent.ask`, the one indirect path to the outside, is gated like a
   hostile channel — see §4.6).
2. **Brain poisoning.** The agent's working folder holds its brain
   (`AGENT.md`, `LESSONS.md`, memory files). An app that can write there can
   plant instructions its agent will later read and obey — self-injection
   with a UI. File writes are therefore path-scoped away from everything the
   agent treats as instructions.
3. **Consent spoofing.** Anything rendered *inside* the iframe is the app
   talking. An in-app "Allow" button proves nothing. Every approval a
   capability needs is rendered by the host (our chrome), outside the frame,
   naming the app and the exact operation.
4. **Nagging / resource abuse.** Unlimited calls, unbounded storage, turn
   spam. Everything is quota'd and rate-limited per app.

## 3. The capability inventory

What a useful app actually needs, ordered by how often real apps want it:

| Capability | Example | Risk class |
|---|---|---|
| `storage` — app-private KV state | tracker entries, settings, high scores | none beyond quota |
| `files.read` — read the agent's folder (incl. `shared/` mount) | dashboard over `reports/`, CSV visualizer | reads stay on-screen; low |
| `tasks.read` — the agent's kanban | sprint board, "what's my agent doing" widget | low |
| `chat.compose` — prefill the chat composer, user hits send | "Summarize this week" button | none (user sends) |
| `files.write` — write files into a scoped subfolder | intake form saving submissions for the agent to process | brain poisoning if unscoped |
| `tasks.write` — add/update board tasks | triage helper files the ticket it prioritized | medium (feeds agent work queue) |
| `agent.ask` — run a real turn against the agent | app asks the agent to crunch data and returns the answer | high — this is agency |
| `tools.invoke` — call an already-user-approved custom HTTP tool | price checker calling the approved rates API | high — network by proxy |
| UI conveniences: theme tokens, resize, toast, open a file preview | native look, deep links | none |

Deliberately **not** offered, at any tier: raw network (`fetch`), reading
other agents' anything, the user profile, workspace files outside the
agent's assigned `shared/` folder, settings, other apps' storage, and
channel credentials. Apps also never see chat history — if an app needs
something from a conversation, the agent puts it in a file.

## 4. Capability design, one by one

### 4.1 `storage` — free tier, always on
A server-backed KV: `yaam.storage.get()` / `set(object)` persisted at
`agents/<id>/apps/<appId>/state.json` (64 KB cap, last-write-wins). It lives
in the agent's store so export/import carries it, but under `apps/<appId>/`
so it is the app's own. The agent can read it with fs tools — that is a
feature (the tracker's entries are data the agent should see), and it is
safe in that direction: the app writing *state* the agent may *read as data*
is not the same as writing files the agent treats as instructions; the
system prompt already tells agents to treat file contents as data. No review
needed: it adds persistence, not reach.

### 4.2 `files.read` — activation-gated
`yaam.files.list(prefix)`, `yaam.files.read(path)` over the same FileRoot
the agent's chats use (own folder + `shared/` mount), read-only, previews
capped like the Files tab. With no network, a read-only view is just a
different lens on data the user already sees in the Files tab — the gate
exists because "this app can see everything my agent knows" is still worth
one explicit yes.

### 4.3 `tasks.read` / `tasks.write`
Read maps to `list_tasks`. Write allows `add_task` and status moves only —
never delete, never editing another origin's notes; app-created tasks carry
`origin: 'app'` and the appId, so the board shows provenance ("filed by
Ticket helper"). Write is execution-gated: first call per app prompts the
host-rendered confirm with a "remember for this app" option.

### 4.4 `chat.compose` — free tier
`yaam.chat.compose(text)` prefills the composer beside the embedded app and
focuses it. The user reads what they are about to send and presses send
themselves. This is the safe 90% of "app talks to agent" — zero autonomy
added, pure convenience — and it should ship first.

### 4.5 `files.write` — activation- and path-gated
Writes land only under `agents/<id>/apps/<appId>/…` (plus the shared
`.checkpoints/` refusal). The agent is told, in its context, that this
folder holds app-submitted **data**. If an app legitimately needs to write
elsewhere ("save the cleaned CSV next to the original"), it doesn't — it
writes to its own folder and `chat.compose`s the agent to move it, keeping
a human on the promotion path from app-output to agent-workspace.

### 4.6 `agent.ask` — the dangerous one, modeled as a channel
Running a turn from an app is exactly the Telegram problem: input arriving
from a surface that cannot be trusted to approve anything. Same answer:

- app-originated turns run in a dedicated `App · <name>` session, **always
  Ask mode**, approval-required tools auto-denied with the "only run from
  the app" note — so an app can ask the agent to *think and answer*, never
  to *act*;
- requires a user gesture in the frame **and** a host-rendered confirm
  showing the exact prompt (same shape as the tool-approval card), with
  "remember for this app" allowed because the turn itself cannot mutate;
- budgeted: N turns/day per app (default 20), token ceiling per turn,
  responses returned to the app as text.

Even so it stays behind activation review: "this app can consume your
tokens and read what the agent answers" is a real grant.

### 4.7 `tools.invoke` — defer
Calling approved custom HTTP tools from an app is network-by-proxy: an
approved GET with a `{query}` placeholder becomes an exfiltration channel
the moment an app controls the parameters. Defer until tools have the
secrets vault and per-tool egress review; when it comes, it is per-call
execution-gated with the host confirm showing the substituted URL. Not v1.

## 5. The manifest, through the three gates

`save_app` grows one field:

```
save_app(name, description, html, capabilities?: string[])
```

with capabilities from: `storage`, `chat.compose`, `files.read`,
`files.write`, `tasks.read`, `tasks.write`, `agent.ask`. Unknown names are
rejected at save so the vocabulary stays reviewable.

- **Creation** stays free. Any agent may save any app requesting anything.
- **Activation** splits by tier. `storage` + `chat.compose` (and no
  manifest at all) activate silently — the sandbox is still the permission
  model. Anything more parks the app as **"needs review"**: the bridge
  stays dark, the card gets an amber badge, and the review modal (same
  pattern as hire/tool review) lists each requested capability in plain
  words. Approval is per-capability, not all-or-nothing. **Editing an app
  re-parks its elevated grants**, exactly like custom-tool edits — what you
  approved is what runs, and a benign v1 cannot smuggle a hostile v2.
- **Execution**: mutating calls (`tasks.write`, `agent.ask`) confirm on
  first use per app with host-rendered UI; reads and storage flow freely
  once activated. All server-side enforcement — the shim's checks are UX,
  the controller re-derives grants from the stored manifest on every call.

Provenance stays on every surface: "built by <agent> · sandboxed · no
network", plus the granted capability chips on the app card and in the
viewer header.

## 6. How capabilities reach the page: the bridge

No SDK download, no npm — we control `srcDoc`, so the host injects a shim:

```
srcDoc = "<script>/* yaam bridge shim */</script>" + app.html
```

The shim defines `window.yaam`, a thin promise-based RPC over
`postMessage`, and knows nothing about grants. The host side (an `AppHost`
component wrapping every app iframe — viewer, gallery, artifact panel)
holds the appId/agentId, filters calls against the approved manifest,
renders execution confirms, and forwards allowed calls to scoped endpoints:

```
GET/PUT  /api/agents/:id/apps/:appId/storage
GET      /api/agents/:id/apps/:appId/files?path=…      (read/list)
PUT      /api/agents/:id/apps/:appId/files             (own-folder writes)
GET/POST /api/agents/:id/apps/:appId/tasks
POST     /api/agents/:id/apps/:appId/ask
```

The server re-checks the manifest grant on every request (the iframe can
forge postMessages to its parent, but the parent holds no authority the
server doesn't re-verify). Because the iframe origin is opaque, the app
itself can never reach these endpoints directly — everything funnels
through the parent window, which is the choke point for confirms, rate
limits, and provenance logging (bridge calls append to the agent's event
feed: "Ticket helper read reports/ (12 files) · added task 'P1: checkout
down'").

App-facing surface, all promises:

```js
await yaam.storage.get();            await yaam.storage.set(obj);
await yaam.files.list('reports/');   await yaam.files.read('reports/w.md');
await yaam.files.write('notes.md', text);      // lands in apps/<appId>/
await yaam.tasks.list();             await yaam.tasks.add({ title });
yaam.chat.compose('Summarize this week');
const answer = await yaam.agent.ask('Crunch the numbers in my state');
yaam.ui.theme();  yaam.ui.toast(msg);  yaam.ui.openFile('reports/w.md');
```

The system prompt's `save_app` guidance grows a short contract: which
capabilities exist, that elevated ones park for review (so ask for the
minimum), and that `yaam` may be absent (old viewer, capability denied) —
feature-detect and degrade to static rendering.

## 7. Shipping order

1. **v1 — state and sight**: bridge + `storage`, `chat.compose`,
   `files.read`, `tasks.read`; manifest field on save_app; review modal;
   capability chips. This alone turns snapshots into live dashboards and
   dead buttons into drafted messages, at almost no new risk.
2. **v2 — hands, carefully**: `files.write` (own folder), `tasks.write`
   with provenance badges and execution confirms.
3. **v3 — voice**: `agent.ask` as a budgeted Ask-mode channel.
4. **Later, maybe**: `tools.invoke` after the secrets vault; app-to-app
   never.
