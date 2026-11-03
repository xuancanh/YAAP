# Agent types and their models

An **agent type** is a provider preset: provider, base URL, API key (sealed
at rest, never returned), persona, a **default model**, a **model list**,
and optional **per-tier models**. Every agent runs on one type; its `model`
picks the model within it.

Code: `server/src/agent-types/` (`agent-types.service.ts`,
`model-resolution.ts`), `server/src/database/model-repair.ts`.

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

Vendor guesses (last resort): Anthropic `claude-haiku-5-5` / `claude-sonnet-5-5`
/ `claude-opus-5-5`; OpenAI `gpt-5-mini` / — / `gpt-5.1`; DeepSeek
`deepseek-flash` / — / `deepseek-v4-pro`; Gemini `gemini-2.5-flash` / — /
`gemini-2.5-pro`.

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
