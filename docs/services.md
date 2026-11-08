# Services: each department's catalog, with SLAs

*Status: built (migration `0098-services`). Design source:
`reports/Process abstractions for agent companies.md` ("Service with SLA",
Phase 2 of the plan). It builds on the process engine (docs/processes.md),
whose `service_request` trigger and `startServiceRequest` hook it calls.*

Asking another function for work used to be prose: a requester created a
"Request for <function>: …" task, the chief routed it by hand, the provider
was told to "accept with a date, decline … or negotiate — silence is a
breach", the SLA lived in `/org/handoffs.md` or `chief.handoffSlaHours`, and
the chief's `handoff-sla-monitor` policed it. Nobody could see what a
function offered or what to expect, and a breach was a sentence in a file.

A **service** is that promise as data: what a department offers the rest of
the company, the fields a requester must give, who answers, the process a
request runs and two clocks — the **accept SLA** (an answer: accepted with a
date, declined with a reason, or a counter-proposal) and the **resolve SLA**
(delivery). A request naming a service is routed with no model; the chief
only routes asks that name nothing.

Code: `server/src/org/service-model.ts` (pure: schema and request checks,
repeat words, diffs, the SLA clock, metrics), `service-templates.ts` (the
starter library), `service-tunables.ts`, `org-services.service.ts` (the
catalog, requests, the tick), `org-services.tools.ts` (agent tools and
context lines), `services.controller.ts` (routes); the page is
`src/components/OrgServicesView.tsx` with `src/lib/services.ts`.

## 1. The model

```
org_services           per department: name (slug), title, description, fields (the request schema), ownerRole,
                       processId (null = the default intake), acceptSlaHours, resolveSlaHours,
                       status draft|active|retired, version + history (author, reason, diff), pending (an edit awaiting its card)
org_service_requests   SR-n: the service (and its version) or none, title, fields, why, neededBy, serves (goal | project),
                       requester, provider unit, status, the run it started and its accept task, both clocks,
                       committed date, counter-proposal, decline reason, thread (every exchange), breaches, the breach card
```

A **field** is `{ name, label, type: text | number | date | url | choice |
boolean, required, options (choice), description }`, at most twelve. A
service's **owner role** is `head` (the department's head answers) or a
title matched inside the department (`engineer`), resolved when the request
arrives — never an agent id, so a service survives hires and reorgs.

Request statuses: `triage` (named nothing; the chief routes it) → `open`
(awaiting the provider's answer; the accept clock runs) ↔ `negotiating` (a
counter-proposal waits on the requester) → `accepted` (the delivery clock
runs to the committed date) → `delivered`; or `declined`, `cancelled`
(withdrawn), `failed` (its run failed).

## 2. Requests (model-free routing)

`org_request_service {service, fields, why, neededBy, serves}`:

1. The fields are checked against the service's schema (`checkRequest`):
   each missing required field, malformed number, date, link or unknown
   choice is a line of the refusal with what to give. Nothing is created.
   Extra fields are kept for the provider.
2. The request goes to the service's department and starts its process
   through `OrgProcessesService.startServiceRequest(…, { process })`: the
   linked process, or the default intake **`service-request`** (accept →
   do → deliver, below). Service requests are admitted by their service, so
   the process's `process.maxActiveRuns` does not cap them. The run's
   variables carry the request (`request`, `request_key`, `request_fields`,
   `why`, `needed_by`, `accept_sla_hours`, the fields by name) and the
   provider (`provider_unit`, `provider_role`); a step on the **`provider`
   lane** is performed by the member of that department in that role (else
   its head).
3. The run's `accept` step is the provider's task (its brief names the SR
   key, the fields, the why and the hours left). The request's accept clock
   starts: `acceptDueAt = now + acceptSlaHours`; the resolve clock runs to
   `now + resolveSlaHours` until the provider commits a date.

A linked process must take service requests (a `service_request` trigger)
and start with a task step `accept` in its first stage; the author is
refused otherwise, with that fix.

**The default intake** (`service-request`, an operating process owned by the
chief; its steps go to the providing department):

| step | lane | what |
|---|---|---|
| `accept` | provider | answer within the accept SLA (MUST: accept with a date, decline with the reason, or negotiate) |
| `do` | provider | deliver by the committed date — only when the answer was `accepted` |
| `deliver` | initiator | the requester confirms the delivery — only when an agent asked (`requester_agent`) |

**Answers** (`org_service_respond`), every one kept on the request's thread:

| who | answer | effect |
|---|---|---|
| provider (the accept task's performer, the department's head or one above it, the chief, a person) | `accept` + `due` | `accepted`; the date becomes the delivery clock; the accept step is settled (outputs `answer`, `due`), the `do` step materialises |
| provider | `decline` + `reason` (+ `alternative`) | `declined`; the run ends without delivery; the requester is told |
| provider | `negotiate` + `due` and/or `scope` | `negotiating`; the requester is told and its context names the counter |
| requester (on a counter) | `agree` | accepted on the counter's date and scope |
| requester (on a counter) | `negotiate` | back to the provider, with a fresh accept window |
| requester (any time before delivery) | `withdraw` | `cancelled`; the run and its open steps are cancelled |
| the chief (on `triage`) | `route` + `unit` or `service` | to a department (the triage step's output `provider`; the accept step goes to its head) or to a service (its schema checked, its process started) |

The tick (every minute) also settles a request whose run finished another
way (a step reviewed instead of answered with the tool, a cancelled run).

## 3. SLAs and breaches

- **Accept SLA.** An `open` request past `acceptDueAt` is breached once. With
  `service.breachAction` 1 a **`service_breach` card** is raised from the
  accept task's performer, so decision routing puts it with the performer's
  manager — the provider department's head (or, when the head is the
  performer, the chief). The manager decides on the record: **approve** holds
  the provider to an answer within a fresh accept window (the performer is
  woken with the note); **reject** declines the request on the provider's
  behalf (the requester is told). Each later breach of the same request is
  raised one level higher — the chief, then the CEO — and a card that is not
  decided climbs on its own (`seat.hopTimeoutHours`). A breach that reaches
  the CEO is a decision card in the **Inbox**. With `service.breachAction` 0
  the performer is nudged on the task and the head told instead.
- An answer (accept, decline, negotiate), a withdrawal or the run ending
  closes the pending breach card.
- **Resolve SLA.** An `accepted` request past its committed date (or
  `resolveDueAt`) is breached once: the delivery task's performer is woken
  and the requester told.

## 4. Unlisted asks and repeats

A need no service covers is still a request: `org_request_service` with
`unit` (the department) and no service runs the default intake on the old
handoff SLA (`chief.handoffSlaHours`). When the department offers a service
that looks like the ask, the result says so. With neither service nor unit
the request is `triage`: the `cross-function-request` process gives the
chief a triage step, and `org_service_respond answer=route` sends it on.

Every unlisted ask stores its significant words (`needWords`). When the same
kind of ask (word overlap ≥ ½) reaches one department
`service.suggestAfterRepeats` times within `service.repeatWindowDays`, its
head is told — "define one (org_service_author)" — and the head's (and the
chief's) context keeps the line until the department adds a service.

## 5. The catalog: templates, authoring, who may change what

The **starter library** (`service-templates.ts`): bug fix and feature
estimate (engineering), mockup (design), launch copy (marketing), budget
check (finance), contract review (legal), customer quote (sales), customer
escalation (support), data pull (data), hiring request (people),
prioritization review (product). Each names the words that match its
department (`unitHint`, against the head's title and the unit's name, as
process templates do) and an `effort` that scales the company's resolve SLA;
templates carry no hours of their own.

- A **new company** gets, at bootstrap, each template whose department it
  has, active (`source: bootstrap`).
- A **company from before services** sees the library (`org_services
  library=true`, the page's "Add from library"); nothing is activated for it.

After adoption a service is the department's. Every change bumps the version
with its author, reason and diff (`history`). Who may change what:

| actor | own department's service | another's / the company's |
|---|---|---|
| the chief | any (boundary `service:own`) | — |
| a head | its unit's subtree | a proposal: a CEO-reserved `service_change` card (`service:beyond`) |
| any other member | — | a proposal |
| the CEO or a board member (the page, the routes) | applies at once | applies at once |

Within its own catalog an agent's change applies at once or waits for a
`service_change` card to its manager by **`service.editApproval`**: 0 every
change applies; 1 a change that loosens the promise (a longer SLA, another
answering role, process or department, a required field dropped —
`loosens`) waits; 2 every change waits. A new service applies at level 0
and 1. Retiring stops new requests; open ones finish.

## 6. Metrics

Per service over `service.metricsWindowDays`: requests (open, delivered,
declined, withdrawn), median hours to the answer and to delivery, the SLA
breach rate (requests that missed either clock), the accept-breach rate and
the decline rate (of answers). They are on the page, in `org_services`, and
in the head's and the chief's context when a service with three or more
requests breaches in 30% or more of them.

## 7. Tunables (per company, derived from its profile)

| key | default | what |
|---|---|---|
| `service.acceptSlaHours` | 8 | a new service's accept SLA |
| `service.resolveSlaHours` | 72 | a new service's resolve SLA (× the template's effort) |
| `service.breachAction` | 1 | 1 a breach card up the line; 0 a nudge |
| `service.suggestAfterRepeats` | 3 | unlisted asks of one kind before the head is asked to define a service |
| `service.repeatWindowDays` | 30 | how far back repeats count |
| `service.editApproval` | 1 | 0 changes apply; 1 looser promises wait; 2 every change waits |
| `service.metricsWindowDays` | 30 | the metrics window |

None is a fixed rule: onboarding derives them from the company's values and
culture (`deriveServiceTunables`, through `deriveOperatingSystem`; the
starter blueprints carry the derived values). Speed answers within hours; a
hierarchy formalises an ask the second time it comes and approves every
change to its catalog; a people-first culture nudges before it escalates;
rigour widens the metrics window. Changing a `service.*` tunable is itself a
proposal (boundary row `tunable:service.`). A service's own hours start from
the tunables and are its department's to change after that.

## 8. Tools (agents) and context

| tool | who |
|---|---|
| `org_services` (unit, library=true, request=SR-n, mine=true) | every member (read) |
| `org_request_service` | every member |
| `org_service_respond` | the provider, the requester, the chief (route) — as in §2 |
| `org_service_author` (template, fields, SLAs, process, retire / restore) | the chief (any), a head (its unit's); others propose |

A member's context gets a line only when something waits on it: a request
its department must answer (with the hours left or how far past), a
counter-proposal to answer, an ask to route (the chief), a delivery past its
date, a breach, an ask that keeps coming without a service, a service whose
breach rate is high. An idle catalog adds nothing to the prompt.

`org-member-workflow` (steps 5 and 6) now says: find the service and request
it; answer within the SLA with `org_service_respond`; a head owns its
catalog. The chief's `function-reports-intake` sends cross-function asks as
service requests, and `handoff-sla-monitor` decides breach cards, routes the
asks that name nothing, keeps `/org/handoffs.md` for the handoffs no service
covers yet and turns repetition into services.

## 9. Routes and the page

```
GET    /api/workspaces/:id/org/services                          the catalog with metrics, the recent requests (with their clock)
GET    /api/workspaces/:id/org/services/templates                the library, with the department each fits
GET    /api/workspaces/:id/org/services/:sid                     one service: history, pending change, requests
POST   /api/workspaces/:id/org/services                          { template? | title, fields, …, unitId?, reason }
PUT    /api/workspaces/:id/org/services/:sid                     { title?, fields?, acceptSlaHours?, …, reason } — a new version
POST   /api/workspaces/:id/org/services/:sid/retire              { reason, restore? }
POST   /api/workspaces/:id/org/services/requests                 { service? | unitId?, title, fields?, why, neededBy?, serves? }
POST   /api/workspaces/:id/org/services/requests/:rid/respond    { answer, due?, reason?, alternative?, scope?, note?, unitId?, service? }
```

Writes are the CEO's or a board member's. On screen: **People › Services**
(`/<company>/people/services`, shortcut `/<company>/services`) shows the
catalog by department — who answers, both SLAs, the fields a request needs,
the metrics — with a department filter; each department's card on People ›
Teams links to its catalog. The open requests carry their live SLA clock
("answer due in 3h", "2h past the accept SLA") and thread; the CEO requests
a service with a form built from its schema (refused, with what is missing,
before anything is sent), asks a department for something unlisted, agrees
to or withdraws from a counter-proposal on its own request, routes an ask
that names no department, and adopts starters from the library. Breaches
that reach the CEO are decision cards in the Inbox.

## 10. Not built yet

Kit manifests declaring services of their own (the library is code, matched
to departments by words); a service-level "capacity" (concurrent requests a
department accepts); an operational-level agreement between two departments
beyond the provider's own SLA; recurring service reviews on a cadence (the
metrics feed the head's context instead); counting coverage — the share of
cross-function work that runs through a service — for the Process Analyst's
"SOP coverage" KPI.
