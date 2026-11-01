# Actions and trust: the external-action contract and the trust ledger

*Status: shipped, 2 November 2026 (execution-plan item 28). Capabilities C2
and C10 of `docs/autonomous-org-first-principles.md`. The SPA for it is item
32.*

The Ask/Auto switch answers "may this chat act without asking?". It cannot
answer the question an owner who wants to look away is really asking: *which*
actions may *this* agent take on its own, and how did it earn that? Two
principles from the first-principles document drive this design:

- **Every action is classed by reversibility and blast radius** (principle 3).
  Autonomy is granted per class, never per organization.
- **Autonomy is earned and revocable** (principle 4). It grows with a
  measured record and shrinks on incidents, automatically.

Everything here is model-free except the agent co-signer's one call. It runs
in **every** session: private chats, channels, loops, heartbeats and org
runs. The same agent at the same level gets the same decision wherever it
acts (the parity rule; the parity test in `tests/backend-actions-trust.test.ts`
holds the line).

## 1. Action classes

`server/src/actions/action-classes.ts` is the one registry.

| Class | Meaning | Examples |
|---|---|---|
| `read` | nothing changes anywhere | `fs_read`, `web_fetch`, `gcal_search`, `browser_open`, skills, `org_read_board`, an MCP tool its server marks `readOnlyHint` |
| `internal_write` | changes the workspace only | `fs_write`, `slides_create`, `run_js` / `run_python` (the sandbox), agent self-maintenance, every mutating `org_*` / `channel_*` / `meeting_*` tool |
| `external_reversible` | leaves the workspace but can be undone or reached nobody yet | `gmail_draft`, `msmail_draft`, a calendar event without outside guests, `drive_export_*`, `browser_act`, `http_request`, agent HTTP tools, MCP tools by default |
| `external_irreversible` | reaches another person or system for good | `gmail_send`, `msmail_send`, a calendar event with a guest outside the owner's domains, every `computer_*` tool |
| `money` | moves money | none ship; any tool named like a payment (`pay`, `charge`, `refund`, `transfer`, `checkout`, …) from an MCP server or a custom tool |

Lookup order: exact names, then the money pattern, then families by prefix
(`computer_`, `skill_`, `tool_`, `mcp_`, and `org_` / `channel_` /
`meeting_`, where the owner's read-only flag decides `read` vs
`internal_write`). **Unknown tools fail safe to `external_reversible`**, and
at boot the turn loop logs every tool the registry does not know
(`TurnLoopService.onApplicationBootstrap`).

`classOf(tool, input, hint, ctx)` is input-aware where it matters: a
calendar write with `attendees` (or `guests`, `invitees`) outside
`ctx.ownDomains` is an invitation, so it is irreversible; without guests it
stays on the owner's calendar and is reversible. Today's calendar tools take
no guests, so they class as reversible until one does.

## 2. Idempotency and the action log

Every non-read call gets an **idempotency key**:
`sha256(sessionId, scope, tool, canonical JSON of the input)`, where the
scope is the acting agent and the canonical JSON sorts keys. The key is
unique per account in `action_log` (migration `0040-org-trust`):

`accountId, id, key, workspaceId, agentId, sessionId, orgId, tool, class,
channel, inputHash, input, status, decision, level, keys, stagedRef, result,
resultHash, dedupeCount, revertedAt, note, createdAt, finishedAt`.

Statuses: `started → succeeded | failed`, or `held`, `staged`, `refused`,
`denied`. `decision` is the trust decision (`run`, `run_notify`, `ask`,
`hold`, `stage`, `cosign`, `cosign→stage`, …) or `legacy` when the Ask
gates decided (§7).

A retry of a **succeeded outward call** (any external class or money)
inside `actions.dedupeWindowMinutes` (default 1 440, bound 5–10 080) is not
executed again: the model gets `Deduplicated: … The recorded result
follows` plus the stored result, `dedupeCount` goes up, and the ledger
records a neutral `deduplicated` outcome. A retry of a call still `held` or
`staged` is told it is waiting; nothing is queued twice. Failed, refused,
denied or stale attempts are retried on the same row. Internal writes are
logged but never deduplicated (writing the same file twice is harmless).

The key covers the next round of the same turn, the next run of the same
org task (org runs reuse one session per task) and a re-woken loop.

## 3. Staging

A staging twin prepares an outward action where the medium allows it:

| Tool | Twin | State |
|---|---|---|
| `gmail_send` | `gmail_draft`; promotion sends the draft (`POST …/drafts/send {id}`) | implemented |
| `msmail_send` | `msmail_draft`; promotion sends the message (`POST /me/messages/:id/send`) | implemented |
| `gcal_create_event`, `mscal_create_event` with guests | an event without invitations (`sendUpdates=none`) | declared, not implemented: the calendar tools take no guests yet, so these calls are held for the owner's key instead |

When the decision is `stage` (§5), the turn loop runs the twin with the same
input, records the draft id as `stagedRef`, sets the row `staged` and tells
the model it was staged, not sent. The key that promotes it is the owner's
(§5); the promotion runs under the rate limits.

## 4. Outbound rate limits

Per workspace, checked right before acting (after any key was given), on
promotion and before staging. Org tunables (`server/src/actions/actions-tunables.ts`),
defaults for a workspace without an organization:

| Tunable | Default | Bound | Counts |
|---|---|---|---|
| `actions.externalPerHour` | 30 | 1–500 | outward calls per **channel** (gmail, gcal, drive, msmail, browser, `mcp_<server>`, …) in the last hour, staged drafts included |
| `actions.irreversiblePerDay` | 20 | 0–200 | irreversible calls in the last 24 h |
| `actions.moneyPerDay` | 0 | 0–50 | money calls in the last 24 h; 0 = money is off |

Over a limit the call is `refused` with the reason (the model is told not to
retry), and in an organization an `action_rate_limit` signal opens for the
chief.

## 5. Two keys and the policy matrix

The trust level that governs a call is
`min(earned level, the owner's ceiling, the organization preset)`.
`decide()` in `server/src/actions/trust-policy.ts` turns it into one
decision. "Present" means a person started the turn in the app; loops,
heartbeats and org runs are unattended.

| Class | Level 0 | Level 1 | Level 2 | Level 3 |
|---|---|---|---|---|
| `read` | acts | acts | acts | acts |
| `internal_write` | asks the person present · held for the owner's key unattended | acts | acts | acts |
| `external_reversible` | asks the person present · held for the owner's key unattended | acts · acts and the owner hears after (unattended) | acts | acts |
| `external_irreversible` | asks the person present · staged (draft) or held unattended | same as 0 | a second agent key (co-signer on another model family) | acts |
| `money` | asks the person present · held unattended | same as 0 | a second agent key | acts |

The **action reviewer** (`docs/permissions.md` §6) still reads every call
that acts without a fresh human decision at every level — it is the
per-call floor, not the peer check of the ledger. A co-signed call is not
reviewed twice.

**The owner's key.** With a person present it is the ordinary inline
approval pause, never remembered for the two-key classes (the row records
`keys.owner.inline`). Unattended, the action is `held` (or `staged`), an
`action_key` inbox event lands on the agent, and in an organization a
`two_key` approval card is opened for the CEO. The key is given by
`POST /api/workspaces/:id/actions/:actionId/keys {approve, note}` or by
deciding the card (`approve` runs the held call through the turn loop's own
executor or sends the draft; `reject` drops it). Only the owner or the
organization's CEO holds it.

**The agent co-signer.** At level 2 the second key is an independent agent:
a different member of the workspace whose model family
(`OrgTasksService.familyOf`, the reviewer selection) differs from the
actor's, preferring the org's auditor, then the chief. It runs one bounded,
tool-free verification on its own model (`ActionReviewService.review` with
the model pinned), seeing the exact call, the company's standing rules and
values, and its own charter. `allow` is an approval; anything else is a no.
Every co-signer turn is audited: `keys.agent` on the row, an inbox event on
the co-signer, and `action_cosign` on the org audit chain. A denial refuses
the call and counts as a rejection. **No member on another family** →
`keys.singleFamily = true` and the second key must be the owner's (asked if
present, staged or held otherwise). A co-signer that cannot answer fails
closed.

## 6. The trust ledger

Tables (migration `0040-org-trust`):

- `trust_records` — `accountId, id, workspaceId, agentId, actionClass,
  outcome (success | reverted | rejected | incident | deduplicated), refType,
  refId, at`. Append-only evidence.
- `trust_levels` — `accountId, id, workspaceId, agentId, actionClass, level
  0–3, ceiling 0–3, cleanCount, rejectStreak, lastIncidentAt, lastChangedAt,
  reason`, unique `(workspaceId, agentId, actionClass)`.
- `workspaces.trustCeilings` — the owner's ceilings per class (JSON).

**Start and ceilings.** A row is created on first use at `min(ceiling,
start)`. Default ceilings: read 3, internal write 3, external reversible 2,
external irreversible 1, money 0. Default start: read 3, internal write 2,
external reversible 1, external irreversible 0, money 0. Lowering a ceiling
lowers every level above it at once.

**What feeds it.**

| Source | Outcome |
|---|---|
| a tool call that succeeded | `success` (clean) |
| a retry answered from the record | `deduplicated` (neutral) |
| the co-signer said no; the owner refused a held or staged action | `rejected` |
| an org review sent the task back (`request_changes`) | `rejected` on `internal_write` for the assignee |
| an org review accepted the task | `success` on `internal_write` |
| `POST …/actions/:id/revert-report` | for an org member, a `revert` incident opens (item 29's `reportIncident`, major) and its demotion is the one change; otherwise `reverted` — one level down at once. Never both |
| `TriggerBus.onOrgIncident` (item 29 emits) | `incident` — `minor` / `major` one level down, `critical` to 0; a tool name in `actionClass` (connection incidents write `gmail_send`) is mapped to its class (`normalizeActionClass`); `actionClass: null` = every non-read class; `agentId: null` = nobody's ledger |

Tool failures, inline Ask denials and action-reviewer verdicts are not
ledger evidence: a network error is not the agent's judgment, and a person
saying no in their own chat is a conversation, not a review.

**Promotion.** `trust.promoteAfterClean` (default 10, bound 3–100) clean
outcomes since the last change raise the level by one, never above the
ceiling; the member's forecast calibration from the prediction ledger
(item 30, `docs/experiments.md` §2.3, read through
`server/src/org/calibration-registry.ts`) must also clear
`trust.calibrationBar` (0.7, 0–1). A member with too few resolved forecasts
has no score (null) and is not held back by it.

**Demotion.** `trust.demoteAfterRejections` (3, 1–10) rejections in a row
drop one level; an incident or a reported revert drops at once.

**On every change:** the row's `reason` and `lastChangedAt`, an
`agent_events` row `trust_change` on the agent (pushed to the owner's
channels when an outward class is raised), and a `trust_change` row on the
organization's audit chain when the workspace has one. Ceiling changes and
overrides are audited the same way.

**The owner's levers.** `PUT …/trust/ceilings` and the override
`POST …/trust/:agentId/:class {level, reason}` (a reason is required; the
level may not exceed the ceiling). Both are the owner's or the CEO's.

## 7. How it meets Ask/Auto and organization mode

- **Ask mode with a person present** (and every channel turn): the legacy
  gates decide exactly as before — the person answers every mutating call —
  except that irreversible and money calls are never answered from a
  remembered grant. The action log, idempotency and rate limits still apply.
- **Auto mode, loops, heartbeats, org runs:** the matrix decides. The old
  rule "loop turns queue every connection mutation, runner and `browser_act`
  call" is replaced by it when the contract is wired (it still applies to a
  turn loop built without `ActionsService`).
- **A frozen class** (item 29: a critical incident's containment, or the
  CEO's `freeze_class`) is held for the owner's key for every member of the
  organization, whatever their level and in every kind of session — Ask,
  Auto, channel, loop, heartbeat, org run (`decision: 'frozen'` on the row).
  `OrgTrustBridge` asks `OrgIncidentsService.isFrozen`.
- **Computer tools** keep their own floor: refused from loop and channel
  turns, asked on every acting call; the contract does not loosen them and
  they are not logged in `action_log`.
- **Organization mode is now a ceiling preset**, not the unit of autonomy:
  `supervised` caps every outward class at 1 (act and notify at most;
  irreversible and money never without the owner) and keeps its structural
  approval cards; `autonomous` uses the ledger's ceilings; `off` uses them
  too. `orgMode` is kept. **The unit of autonomy is now (agent, action
  class) in the ledger.**

## 8. API and tools

| Route | Who | What |
|---|---|---|
| `GET /api/workspaces/:id/trust` | any member | every agent × class: level, ceiling, effective, counts by outcome, reason; the ceilings; the matrix in words |
| `PUT /api/workspaces/:id/trust/ceilings` | owner / CEO | `{ceilings: {class: 0–3}}` (or the map itself) |
| `POST /api/workspaces/:id/trust/:agentId/:class` | owner / CEO | `{level, reason}` — ≤ ceiling, audited |
| `GET /api/workspaces/:id/actions?agentId=&class=&status=&limit=` | any member | the action log, newest first |
| `GET /api/workspaces/:id/actions/:actionId` | any member | one row (the owner's key shows its exact call) |
| `POST /api/workspaces/:id/actions/:actionId/revert-report` | owner / CEO | `{note}` — marks it reverted, demotes |
| `POST /api/workspaces/:id/actions/:actionId/keys` | owner / CEO | `{approve, note?}` — the owner's key on a held or staged action |

The turn stream's `tool_result` event, and the turn's stored tool records,
carry `actionClass`, `actionId` and `held` (`held` | `staged`) for every
call the contract logged, so a client shows the class and offers the key
without parsing the result text.

Tool: **`trust_status`** (read) for agents in a workspace with organization
mode on — the caller's own levels; the chief of staff sees every member's.

Seams: `TriggerBus.emitOrgIncident / onOrgIncident` (`OrgIncidentEvent {
orgId, incidentId, agentId | null, actionClass | null, severity: minor |
major | critical, kind }`), `TrustService.calibrationOf`, and
`OrgTrustBridge` (`server/src/org/org-trust-bridge.ts`), which binds the
audit chain, signals, `two_key` approvals and review verdicts without the
actions module importing the org domain.

## 9. Not done here

- The SPA (item 32): the ledger table, the action log, the `two_key` card.
- Calendar staging (`sendUpdates=none`) waits for calendar tools that take
  guests; `ownDomains` is not yet filled from the owner's connections, so
  every guest counts as outside.
- A `two_key` org card that expires leaves its action `held`; the key can
  still be given on the route.
- An org tool held at `internal_write` level 0 runs on the owner's key
  outside the run that called it, where some org tools have no run context.
- Level 3 does not switch off the per-call action reviewer; the auditor's
  sampling of level-3 work is item 29's.
