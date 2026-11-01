# Sensing and executable acceptance

*Execution-plan item 27; capabilities C1 and C3 of
`docs/autonomous-org-first-principles.md`. Shipped 2 November 2026.*

The first principle of the autonomous organization is that it cannot run,
improve or audit on information it generated about itself. Before this item
every key result was a number its owner typed into a check-in, and every task
was done when a reviewer model said so. This item adds the two missing
senses:

- **Metric sources** (C1): numbers read from where they happen, stored as a
  time series with provenance, and the only thing a bound key result's value
  can come from.
- **Checks** (C3): `done_when` made testable. A task's checks run without a
  model before review; when they all pass the task is accepted *by check*.

Everything here is model-free. Code: `server/src/org/org-sensing.service.ts`
(sources, samples, polling, staleness, the check runner, the tools),
`server/src/org/org-checks.ts` (check shapes, validation, the JSON selector,
the connection-query menu), `server/src/org/org-sensing.controller.ts`
(routes), `server/src/org/sensing-tunables.ts`. Migration `0039-org-sensing`.

## 1. Metric sources

A source belongs to one organization: `org_metric_sources` (`name`, `kind`,
`config`, sealed `secrets`, `tokenHash`, `unit`, `pollMinutes`, `status`,
`lastValue`, `lastFetchedAt`, `lastError`, `failures`, `nextPollAt`,
`approvalId`, `activatedAt`, `createdBy`). Each reading is an
`org_metric_samples` row: `value`, `observedAt`, `fetchedAt` and
`provenance`.

| Kind | How a value arrives | Provenance |
|---|---|---|
| `http_json` | The tick GETs `config.url` and extracts a number with `config.selector` | `{ kind, url, status, responseHash }` |
| `webhook` | A third-party system posts `POST /api/metrics/:sourceId/ingest` | `{ kind: 'webhook', responseHash }` (hash of the body) |
| `connection` | The tick runs one query of a fixed menu over an existing grant | `{ kind, connection, service, query, responseHash }` |
| `manual_attested` | A human posts a value with a note | `{ kind, by, note }` |

Status is `pending_approval`, `ok`, `error`, `stale` or `rejected`. Only
`ok`, `error` and `stale` sources are *live*: polled, sampled, bound, checked.

### 1.1 `http_json`

- The URL must be `https`. Plain `http` (and private hosts) only with the
  existing development flag `YAAM_ALLOW_PRIVATE_URLS=true`.
- The fetch goes through `fetchPublic` (`server/src/common/url-guard.ts`):
  literal private IPs, hostnames resolving to private addresses and
  redirects to either are refused on every hop. Bodies over 1 MB are
  refused; the timeout is `acceptance.checkTimeoutSeconds`.
- **Headers** may carry credentials only by reference. A header whose name
  looks like a credential (`authorization`, `cookie`, `*token*`, `*key*`,
  `*secret*`, `*auth*`, `password`) must be `{{secret:NAME}}`, optionally
  after a scheme word (`Bearer {{secret:API}}`). The value goes in
  `secrets: { API: "…" }`, is sealed with `secretbox` and is never returned
  by the API, written to the audit log or shown to an agent. `GET …/sources`
  shows `secretNames` only. `null` removes a secret.
- **The selector** is a small JSONPath-like parser, not an evaluator:
  `stats.subscribers`, `$.data.items[0].count`, `["odd.key"].x`,
  `items.length` (or `items.count`) for an array's length,
  `items.sum(amount)` / `items.sum(meta.amount)` to sum a field,
  `items.count(field)` to count truthy fields. A numeric string reads as a
  number and a boolean as 0/1. Anything else is refused at write time.

### 1.2 `webhook`

`POST /api/metrics/:sourceId/ingest` with `{ "value": 123, "observedAt"?:
"<ISO>" }`. The token travels as `?token=` or `Authorization: Bearer`. It is
generated when the CEO creates the source and returned once in that
response; `POST …/metrics/sources/:id/token` rotates it (the old one stops
working). At rest only its SHA-256 is kept and the compare is timing-safe. The
route is public (listed in `isPublicRoute` next to the loop webhooks), runs
under the account that owns the source, accepts 30 posts per minute per
source and 64 KB, and refuses an `observedAt` more than five minutes ahead
or more than a year old. An unknown source, a bad token and a non-live
source all answer 401.

A webhook source created from an agent's proposal has no token until the
CEO rotates one after approval. A token handed back by the approval would
land in the audit log.

### 1.3 `connection`

A fixed menu, read-only, Google connections only for now:

| Query | Counts |
|---|---|
| `gmail_unread` | unread messages matching `q` (needs the "Gmail reading" consent) |
| `gmail_matching` | messages matching `q` newer than `days` |
| `calendar_events_week` | primary-calendar events this week (Monday 00:00 UTC + 7 days) matching `q` |
| `drive_changed` | Drive files modified in the last `days`, name containing `q` |

A source (or a check) is refused unless an agent **of the organization's
workspace** holds a default grant on that service (any level). The read runs
through `ConnectionsService.connectionFor` on that agent's behalf, the same
activation gate the mail and calendar triggers use. Each page is capped at
the provider's maximum (500 messages, 250 events, 1,000 files). Microsoft
connections are not wired yet.

### 1.4 `manual_attested`

`POST …/metrics/sources/:id/attest { value, note, observedAt? }`. The CEO, a
board member or an employee may attest. Observers and people without
standing may not. The note is required, and the provenance records who
attested (`user` or `human:<accountId>`).

### 1.5 Polling, errors, staleness

`OrgSensingService` runs its own minute tick, per account, like the other org
ticks. It polls up to ten due `http_json` / `connection` sources per org and
then checks every live source for staleness.

- `pollMinutes` defaults to 60 for polled kinds, 1,440 for webhooks and
  10,080 for attestations (the expected cadence, for staleness). It is
  clamped to at least `sensing.minPollMinutes` and at most 30 days.
- **Error backoff.** A failed poll sets `status = error`, records
  `lastError` and retries after `pollMinutes × 2^(failures−1)`, capped at a
  day. The first failure in a row puts an inbox event on the chief. Key
  results keep their last measured value.
- **Stale.** A live source with no sample for `sensing.staleMultiplier ×
  pollMinutes` (since activation when it never had one) becomes `stale` and
  opens a `metric_stale` signal addressed to the chief. The signal is
  deduplicated per day and names the key results reading the source. The
  next sample resolves it and sets the source back to `ok`.

### 1.6 Who may do what

| Action | Who |
|---|---|
| Create, edit, delete, poll now, rotate the token, bind a key result | the CEO (API) |
| Attest a value | CEO, board, employee |
| Propose a source | the chief and unit leads (`org_propose_metric_source`); always a `metric_source` approval card, in supervised **and** autonomous mode |
| Approve the card | the CEO only (board members decide hire, budget and strategy) |
| Write a sample | nobody but a poll, the webhook or a human attestation; **never an agent** |

An agent never handles a secret. A proposal may reference `{{secret:NAME}}`,
and approval is refused until the CEO has set it (`PATCH …/sources/:id {
secrets }`). Rejecting the card marks the source `rejected`. Every source
change (`metric_source_create | _propose | _activate | _update | _delete |
_token | _rejected`, `metric_error`, `metric_stale`) and every sample
(`metric_sample`, with its provenance) is a row in the hash-chained audit
log.

## 2. Key results measured by a source

`org_goals.metricSourceId` binds a key result to a live source. From then on:

- its `currentValue` is the **latest sample by `observedAt`**, written on each
  ingest, poll or attestation, with `lastMeasuredAt`. A late sample with an
  older timestamp never overwrites a newer one;
- `org_check_in` / `POST …/goals/:id/checkin` with a value is refused
  ("measured by "<source>" (<kind>) …"). Confidence and a note are still
  recorded, so the owner's **judged forecast** sits next to the measured
  value, and the check-in row records the measured value it was made
  against;
- `PATCH …/goals/:id` with a different `currentValue` is refused;
- pace, at-risk and the brief read the measured value, through the same
  rules (`paceOf`, `assessRisk`) as before. The check-in cadence still
  applies to confidence;
- `intentTree` nodes carry `measuredBy { sourceId, name, kind,
  lastFetchedAt, status }` and `selfReported`. The model's tree text says
  `measured by "<name>" (<status>)` or `self-reported`.

A key result without a source behaves as before, flagged `selfReported:
true`. The brief's Key results section counts them in a standing note:
"N of M key result(s) are self-reported (no metric source)".

Binding is `POST …/goals/:goalId/source { sourceId | null }` (the CEO) or
the `source` argument of `org_set_key_result` (the chief or the unit lead
setting it). Binding copies the source's latest value at once. Unbinding
leaves the last measured value and makes the key result self-reported again.
Deleting a source unbinds every key result it measured.

## 3. Executable acceptance: checks

A task may carry `checks` next to its four-field brief
(`org_tasks.checks`, at most 10). They are validated at write time, on
`org_create_task`, `POST|PATCH …/tasks` and a brief's `checks` key, and a
bad one is refused with its index.

| Kind | Passes when | Errors when |
|---|---|---|
| `metric_at_least {sourceId, value}` | the source's latest sample ≥ value (no sample yet = fail) | the source is unknown or not live |
| `metric_increased {sourceId, by, sinceTaskStart = true}` | latest − baseline ≥ by; the baseline is the last sample at or before the task's creation (or the first sample) | no baseline sample |
| `http_status {url, status = 200}` | the GET answers that status | network error, SSRF refusal, timeout |
| `http_json_match {url, selector, equals \| contains \| atLeast}` | the selected value equals (string-compared), contains (substring or array member), or is ≥ | not JSON, network error |
| `file_exists {path}` | the file exists in the organization's workspace files | — |
| `file_matches {path, contains \| regex \| jsonSchemaKeys}` | it contains the text, matches the regex (≤ 200 chars, compiled at write time), has every key path | — |
| `connection_query {service, query, days, atLeast}` | the menu query of §1.3 counts ≥ atLeast | no grant in the workspace, provider error |

`sourceId` accepts an id, an 8-character prefix or the source's name. Paths
are workspace-relative and checked like storage keys: letters, digits,
`. _ -` segments, no `..`.

**`github_check` is not offered.** yaam-chat has no GitHub connection to read
CI from (the GitHub entry in the connector catalog is an MCP server, which
the server cannot call unattended). A check of that kind is refused with
that reason. It can return when a GitHub connection lands in
`server/src/connections`.

### 3.1 Review with checks

`OrgSensingService` binds itself as `OrgTasksService`'s acceptance gate.
`requestReview`, which is the path `org_request_review` and `POST
…/tasks/:id/request-review` both take, runs the task's checks first:

- **All pass** → the task is `done` with `acceptedBy = 'check'`, a
  `review_accept` audit row by `check`, and a timeline comment listing what
  passed. No reviewer, model or human, is asked. The exception: when
  `done_when` also has text and the tunable
  `acceptance.alsoReviewWhenChecksPass` is 1, review proceeds as usual with
  a note that the checks passed.
- **Any fail** → back to the owner. This is a `request_changes` with the
  failing checks' details as the comment ("Changes requested (round n/3):
  checks failed — …"). It counts as a review round, wakes the owner and
  escalates at the round cap, exactly like a reviewer's verdict.
- **Any error (and no fail)** → the normal review runs, with a comment that
  the checks could not run and why. An error never accepts work.

`org_run_checks` (the owner, its reviewer, the chief) and `POST
…/tasks/:id/checks/run` (a person with standing) run them without changing
the task. `org_task_checks` and `GET …/tasks/:id/checks` show the latest
result of each check (`org_task_checks` table: `status pass | fail | error |
pending`, `detail`, `evidence`, `ranAt`). Every run is a `checks_run` audit
row.

### 3.2 Verified by check or by opinion

`org_tasks.acceptedBy` is `check`, `review`, or `''`. The board routes
(`GET …/tasks`, `GET …/units/:unitId/board`) add `verification: 'check' |
'review' | 'none'` to each done task (null otherwise). `none` means it was
set done by hand. Setting a status by hand clears `acceptedBy`. The brief's
Work section adds "N% of tasks accepted by check this week".

## 4. Tools

| Tool | Who | Effect |
|---|---|---|
| `org_metric_sources` | every member | the sources, status, last value, what they measure |
| `org_metric_read {source, since?}` | every member | up to 50 samples with provenance |
| `org_propose_metric_source {name, kind, url?, selector?, headers?, query?, q?, days?, unit?, pollMinutes?, why}` | chief, unit leads | a `pending_approval` source and a `metric_source` card (a dry run records it only) |
| `org_task_checks {taskId}` | every member | the latest results |
| `org_run_checks {taskId}` | owner, reviewer, chief | runs the checks; nothing else changes |

`org_create_task` takes `checks`. `org_set_key_result` takes `source`. The
planning prompts ask for both where they apply. `org_check_in` refuses a
value on a measured key result.

## 5. Routes

On `/api/orgs/:id/…` and the workspace alias `/api/workspaces/:id/org/…`:

```
GET    metrics/sources
POST   metrics/sources                          (CEO) { name, kind, unit?, pollMinutes?, config?, secrets? } → { source, token? }
PATCH  metrics/sources/:sourceId                (CEO) { name?, unit?, pollMinutes?, config?, secrets? }
DELETE metrics/sources/:sourceId                (CEO)
POST   metrics/sources/:sourceId/poll           (CEO)
POST   metrics/sources/:sourceId/token          (CEO) → { token, url }
GET    metrics/sources/:sourceId/samples?since=
POST   metrics/sources/:sourceId/attest         (CEO, board, employee) { value, note, observedAt? }
POST   goals/:goalId/source                     (CEO) { sourceId | null }
GET    tasks/:taskId/checks
POST   tasks/:taskId/checks/run
```

Public: `POST /api/metrics/:sourceId/ingest`.

## 6. Tunables (area `sensing`)

| Key | Default | Bound | Meaning |
|---|---|---|---|
| `sensing.staleMultiplier` | 3 | 1–20 | poll intervals without a sample before a source is stale |
| `sensing.minPollMinutes` | 5 | 1–1,440 | shortest poll interval |
| `acceptance.alsoReviewWhenChecksPass` | 0 | 0–1 | still review when checks pass and `done_when` has text |
| `acceptance.checkTimeoutSeconds` | 10 | 2–60 | time box of one check or one poll |

## 7. Trust model in one paragraph

A doer cannot mark its own homework. Agents read sources and samples. They
can propose a source, but only the CEO makes one live. They never write a
sample, and the one write path refuses an agent actor even if a future
route reaches it. A key result's value comes from its source, so the
at-risk rules, the brief and (from item 30) the auditor's reconciliation
reason over measured numbers, not reported ones. Checks are evaluated by
the server from data it fetches itself. A pass can save a model review, a
failure costs the doer a round, and an error only falls back to a review.
What a source or a check fetches is data: it is hashed into the provenance
and never put in front of a model as an instruction.
