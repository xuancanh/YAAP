# Agent types and their models

An **agent type** is a provider preset: provider, base URL, API key (sealed
at rest, never returned), persona, a **default model**, a **model list**,
and optional **per-tier models**. Every agent runs on one type; its `model`
picks the model within it.

Code: `server/src/agent-types/` (`agent-types.service.ts`,
`model-resolution.ts`, `provider-presets.ts`, `model-selection.ts`),
`server/src/chats/model-selection.service.ts`, `server/src/database/model-repair.ts`.

## Default providers

Claude (Anthropic) and OpenAI are supported out of the box
(`provider-presets.ts`; DeepSeek, Gemini, Kimi and GLM have presets too).
Each preset has a default model, a starting model list and a tier map:

| Provider | cheap | standard (default) | strong | also listed |
|---|---|---|---|---|
| Claude | `claude-haiku-5-5` | `claude-sonnet-5-5` | `claude-opus-5-5` | `claude-fable-5-1`, Claude 5 / 4.x ids |
| OpenAI | `gpt-6-luna` | `gpt-6.1-sol` | `gpt-6-astra` | `gpt-6.1-terra`, GPT-5.x ids |
| DeepSeek | `deepseek-flash` | `deepseek-flash` | `deepseek-v4-pro` | |

Ids checked November 2026 against the providers' model and pricing pages;
prices are in `server/src/ai/pricing.ts` and context windows in
`context-windows.ts`. Older ids keep working: they stay priced, and a type
serves what its own list says.

- **Seeded at boot** (`AUTH_MODE=single`): a key in `ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY` or `DEEPSEEK_API_KEY` creates that preset's type (key
  sealed) when the account has no type of that provider yet. Existing types
  are never touched; `SEED_PROVIDER_TYPES=off` turns it off.
- **Quick add**: Settings › Providers & agent types offers *Add Claude* /
  *Add OpenAI* (`POST /api/agent-types/presets/:provider`, list at `GET
  /api/agent-types/presets`); the account key pane (`PUT /api/account/keys`)
  creates the same preset. The manual add form starts on the picked
  provider's default model.
- **Type defaults** are repaired on boot (`repairTypeDefaults`): a type
  whose own default belongs to another vendor's family — a DeepSeek type
  left on `claude-sonnet-4-5` by the old add form — moves to its family's
  preset default (a listed model of that family when the preset's is not
  listed). Custom gateways are left alone.

## Models

`models` holds the models the type serves: configured by the owner, or
replaced by the provider's own list on discovery. The *known* models are that
list plus the default.

| | |
|---|---|
| `GET /api/agent-types/:id/models` | `{ default, models, tierModels, fetchedAt, discoverable }` — cached, no network. |
| `POST /api/agent-types/:id/models/refresh` | Asks the provider, replaces the list on success. |
| `PATCH /api/agent-types/:id` | `model` (default), `models`, `tierModels: { cheap?, standard?, strong? }` (null unpins); tier picks must be on the list. |

### Discovery

- OpenAI-compatible providers (OpenAI, DeepSeek, Kimi, GLM, Gemini's
  OpenAI endpoint, custom): `GET {baseUrl}/models` with `Authorization:
  Bearer <key>`. Gemini's `models/` prefix is stripped.
- Anthropic and Anthropic-compatible: `GET {baseUrl}/v1/models?limit=1000`
  with `x-api-key` and `anthropic-version`.
- Echo has no list.

The type's key goes to that endpoint only (redirects are refused), with an
8-second timeout (`MODEL_DISCOVERY_TIMEOUT_MS`). On success `models` is
replaced and `modelsFetchedAt` set; a default the provider does not list
moves to the family's standard model when listed, else the first, and tier
picks no longer listed are dropped. On any failure nothing changes — the
configured list stays — and the error is returned to the caller.

Settings › Providers & agent types shows each type's models with Refresh,
the default model picker and the three tier pickers.

### When a model is "known"

`isKnownModel(type, model)`: '' (the type default), Echo, and the default
are always known. With a list: membership. Without a list (never configured
or fetched): by vendor family only — a `claude-*` model on a type that is
plainly DeepSeek (by provider name, base URL host, or its default model's
name) is unknown; a model of no recognisable family gets the benefit of the
doubt.

## Which type, which model

Every creation path — New agent, Market hires and pack installs, org hires
(`org_hire_agent`, approval cards, `applyHire`), blueprint import (chief and
roles), onboarding's chief, `org.create`'s chief, portability imports — goes
through `AgentsService.create` → `resolveModelFor`:

1. **Type**: the explicit `agentTypeId` (refused when unknown or disabled),
   else an enabled type of the requested provider (the app default first),
   else the app default (`defaultAgentTypeId`), else the first enabled type.
   With no enabled type the input is kept as given (legacy vendor guess).
2. **Model**: the explicit model if the type knows it (or the owner chose
   *custom model id*); else the role's tier model on that type — the
   owner's designated tier model, else a vendor guess for the tier that is
   on the type's list (any family-matching guess only when the type has no
   list), else the default; else the type's default.

The agent is stored with `agentTypeId` = that type, so a turn resolves it
deterministically. Org routing (`tierModel`) uses the same table at run time:
a CEO-pinned tier model the type serves, else the type's tier model.

Vendor guesses (last resort, the presets' tier maps): Anthropic
`claude-haiku-5-5` / `claude-sonnet-5-5` / `claude-opus-5-5`; OpenAI
`gpt-6-luna` / `gpt-6.1-sol` / `gpt-6-astra`; DeepSeek `deepseek-flash` /
`deepseek-flash` / `deepseek-v4-pro`; Gemini `gemini-2.5-flash` /
`gemini-2.5-pro` / `gemini-2.5-pro`. A `standard` with no designation is
the type's default.

## Validation

Creating or updating an agent with an explicit model its type does not know
is refused with the list (`unknownModelMessage`), unless the owner chose
*custom model id* (`customModel: true`). The chief's `org_update_member` and
`org_hire_agent` with an explicit model are refused the same way. Imports and
hire cards approved after the type changed fall through to the tier/default
instead (`modelFallback`).

## Self-heal

When a provider refuses the model by name before anything streamed
(`isModelRejection`: a 400/404/422 naming the model as invalid/unsupported,
never key, quota or transient errors), the turn retries once on the type's
default — refreshing the list first when the default itself was refused. The
agent and its chats pinned to the failed model move to the default, and the
agent's inbox gets "Model X isn't served by <type>; switched to Y". A second
rejection in the same turn fails the turn as before.

## Backfill

On every boot, after migrations, `repairAgentModels` moves agents — and chat
sessions with a pinned model — whose model their type does not know to the
type's default, resolving the type as a turn does. Echo types and rows with
no type are left alone. It logs the counts and is idempotent.

## Model selection

An agent runs in one of two **model modes**:

- **fixed** — always its `model` on its type (the behaviour above);
- **auto (by task complexity)** — each org task run and each chat, channel,
  loop or heartbeat turn picks a tier, then a model, from the work.

The mode is the agent's own (`agents.modelMode`: `''` inherit | `auto` |
`fixed`), else its type's (`agent_types.modelMode`), else the workspace's
(`workspaces.modelSelection.mode`), else fixed. In auto mode the agent's
`model` is only the fallback (nothing usable to choose from).

### The tier: model-free, from signals

`chooseTier` (`model-selection.ts`) scores the work:

| Signal | Score |
|---|---|
| Task class | triage 0 · ops / general 1 · review / research 2 · synthesis 3 |
| Brief size (outcome + context + constraints + done_when) | ≥ 350 chars +1, ≥ 900 +2, ≥ 2000 +3; < 120 −1 |
| Structure | all four brief fields +1 |
| Acceptance criteria (done_when lines) + model-free checks | ≥ 3 +1, ≥ 6 +2 |
| A strict quality bar (pass score ≥ 4 or evidence level 2) | +1 |
| Dependencies ≥ 2 / a dependency on another unit's board | +1 / +1 |
| Verifying another member's work | +1 |
| Risky work (release, production, deletion, migration, money, legal or pricing, public statements, contacting customers — the external / irreversible action classes and the alignment classes) | +2, and the risk floor |
| Chat turn | 1, message ≥ 160 / 500 / 1500 chars +1 / +2 / +3, < 40 −1, asks for work +1, tools likely +1, code +1 |

Score ≤ `model.cheapMaxScore` → cheap, ≥ `model.strongMinScore` → strong,
else standard. Then, in order:

1. **Declared tier**: a task's `modelTier` (set by its creator —
   `org_create_task`'s `model_tier` — or by a process step's `tier`)
   replaces the score's tier.
2. **Attempts**: no-progress runs, repeated failed approaches and review
   rounds sent back count; every `model.retryEscalateAfter` of them is one
   tier up (at most two).
3. **Record**: the agent's finished runs of the class over 30 days — at
   least `model.historyMinRuns` — succeeding ≥ `model.historyDowngradeRate`
   drop a tier (not on a retry); ≤ `model.historyEscalateRate` raise one.
4. **The agent's request**: `request_model_tier {tier, reason}` (offered
   only in auto mode, every session kind) asks for the *next* turn or run of
   that session; it moves the tier at most `model.requestCap` tiers.
5. **Money**: less than `model.budgetTightPct`% left in the tightest capped
   envelope (agent → project → company) drops a tier.
6. **The CEO's routing** (`organizations.routing.classes`) pins the class's
   tier over all of the above; otherwise the tier is clamped to
   `model.floorTier` … `model.ceilingTier`.
7. **Risk floor**: risky work never runs below `model.riskFloorTier`
   (standard at least) — not on a tight budget, a cheap request, a low
   ceiling or a routing pin.

### The provider within the tier

`chooseProvider` picks the agent type: the agent's own, plus — when the
workspace allows it (`crossProvider`, on by default) — the owner's
preference order (`modelSelection.order`, agent type ids) or, with no
order, every usable Claude / OpenAI type. Degraded providers
(provider-health) drop out; a verifier prefers another model family than
the maker's when `quality.verifierIndependence` ≥ 1 (the maker's family is
what its last run actually ran on); then the owner's order, else the own
type first and the rest by the tier model's price. The model is the type's
tier model (`tierModelForType`), or the CEO's pinned tier model
(`routing.models`) when the type serves it. The persona, charter, memory
and tools stay the agent's — only the provider and model change, as with
degradation.

**Parity**: private chats, channels, loops and heartbeats resolve through
the same `decideForTurn`; org task runs decide in `runTask` and pass the
choice to the turn. A model picked by hand in one chat's header still wins
for that chat. Agents and decisions stay in their own workspace.

### The record and the outcomes

Every decision — `{ tier, score, model, agentTypeId, provider, family,
reasons, requested }` — is stored on the turn (`chat_turns.modelDecision`)
and, for task runs, on the run (`org_runs.tier`, `org_runs.modelDecision`)
and in the `run_start` audit row. The Work log shows *Auto · tier · model*
with the reasons on each run; the task's run list shows the same.
Verifier independence (docs/quality.md) judges an auto agent by the model
its latest run used.

`GET /api/workspaces/:id/model-selection/outcomes?days=30` gives per tier:
runs, success rate (done or progressed), failed, escalated retries, spend
and chat turns — the numbers to tune the thresholds by.

### Settings and tunables

- Settings › Providers & agent types › **Model selection**: the workspace
  default mode, *may run on another provider*, the preference order, each
  type's tier map, the company's thresholds and the outcomes table (`GET|PUT
  /api/workspaces/:id/model-selection`).
- Each type: a model mode and the three tier pickers.
- Each agent (Settings › Model): *Inherit*, *Auto (by task complexity)* or
  *Fixed model*.
- The thresholds are the company's tunables (`model.*`, area capital), set
  for every starter company by `deriveModelTunables` from its values and
  culture — never fixed defaults: rigour or a control culture escalates
  sooner (strong at a lower score, risky work on strong, nothing below
  standard), frugality (a stated value, or an early company) downgrades
  sooner (cheap up to a higher score, a larger tight-budget margin), an
  adhocracy lets agents move their own tier further, a hierarchy records
  requests without applying them. The chief tunes them with `org_tune`, the
  CEO with `PUT …/org/tunables`. A workspace without a company uses the
  registry defaults.
