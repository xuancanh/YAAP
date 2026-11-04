# Blueprints: companies as products

Status: **shipped**, 1 November 2026 (execution-plan item 24, phase F of
`docs/company-vision.md` §9 and §11). A company's structure, charters,
playbooks, cadences and budget split export as one document, `COMPANY.json`,
a sibling of `AGENT.json`. Import one into an empty workspace, pick a mode and
a budget, and it staffs itself. Blueprints publish to the market registry as
kind `company`, behind the same review gate as agents and skills, and are
rated by the measured outcomes of the companies that ran them. The same item
ships the **role catalog as data** (§4) and **hybrid human roles** (§4,
"hybrid staff"). The SPA side is the Blueprint card in Settings →
Workspace → Organization ("In the app" below, `src/components/OrgBlueprintBits.tsx`).

Last updated: 2026-11-04

## 1. The format: `COMPANY.json` v1

`format: "yaam-company/1"`. One JSON object, validated strictly by
`server/src/org/blueprints/format.ts` `validateBlueprint` on every door
(file import, registry publish, registry install): unknown fields are
refused, strings are bounded and checked for invisible unicode, and the
company's own structural caps apply to the document — **≤ 256 KB, ≤ 20
roles, depth ≤ 3, fan-out ≤ 5**, exactly one root, no cycles.

| Field | What it is |
|---|---|
| `name`, `description` | The company and its mission (the organization's `name` and `mission`). |
| `profile { values, culture, rules }` | The operating profile (§1b) and the CEO's standing rules. |
| `vision? { title, description, horizonDays }` | The active vision; the horizon is relative, so an import sets a fresh due date. |
| `roles[]` | `{ roleId?, title, charter, reportsTo, scopes[], modelTier, monthlyUsd }`. Titles are the blueprint's identifiers (unique); `reportsTo` names a title, `null` for the chief of staff. `scopes` are meet-rule strings (`tool:…`, `connection:<svc>:<lvl>`, `skill:…`, `folder:…`); `modelTier` is `cheap \| standard \| strong`. `roleId` names the catalog role the charter was drawn from (informative — the inline fields rule). |
| `units?[]` | `{ title, parent, name? }` — derived from `reportsTo` on export (every role with a report leads a unit); informative on import, except `name` (≤ 60 chars): the department's own name (docs/group-chat.md §7 "Department names"), exported for every non-root unit and applied on import to the unit its lead heads once the hires exist (marked custom; a failure is a note). The root never carries one: it is the company. Every first-party starter names its departments (Engineering, Customer Success, Growth, Editorial, Research…). |
| `cadences?[]` | `{ unitTitle \| "root", kind, cron }` — written on export only when the rituals table (`org_cadences`, item 19) exists at runtime; the probe is defensive. An import lists them for the chief; it writes none. |
| `tunables {}` | The stored overrides (`organizations.tunables`), each applied on import within its bound (`org-tunables.ts`): out-of-bound values are clamped and noted, unknown keys skipped and noted. |
| `routing? {}` | Task class → model tier, exported when `organizations.routing` (item 23) exists. |
| `playbooks[]` | `{ name, skillMd }` — the workspace's approved, enabled shared skills rendered as `SKILL.md` (`renderSkillMd`). The only "content" a blueprint carries, and it is instruction text. |
| `budget { monthlyUsd, allocations? }` | The company envelope and the per-title agent envelopes. |
| `projects?[]` | Roadmap items with their cross-functional teams (§1b): `{ title, brief, lead, team: [{ title, role?, allocation }], krs?, cadence?, appetiteDays?, appetiteUsd? }`, every role named by title. |
| `cards?[]` | Connection card ids (`docs/integrations.md` §5a) the company's members held grants on. **Recommended** by an import, never granted. |
| `origin { exportedFrom, at, sourceOrgId }` | Provenance; `sourceOrgId` is a 16-hex SHA-256 prefix of the org id, not the id. |

What is **not** in a blueprint, by construction: messages, tasks, runs,
lessons, memory, files, connections, grants, tokens, agent ids, workspace
ids. `OrgBlueprintsService.export` reads none of those tables, and the test
greps the document for planted history.

### 1b. Projects with teams (v1 extension, 2026-11-04)

`projects?[]` is an optional, **backward-compatible v1 field** (a blueprint
without it is unchanged; a server older than it refuses the unknown field
rather than dropping it silently). At most **10 projects**, **8 team members**
each:

| Field | What it is |
|---|---|
| `title` | The project title. |
| `brief` | `{ problem, hypothesis, done_when, mvp }` or one string (the problem). |
| `lead` | The role title that owns it — a Program Manager (`role:ops-pm`); the chief of staff acts as one where the blueprint has none. |
| `team[]` | `{ title, role?, allocation }`: a role title from `roles`, its role on the project (engineer, designer, analyst), and its allocation in percent. A role's allocations across all projects sum to at most 100%. |
| `krs?[]` | Short key-result titles it should move; the import writes them into the brief for the chief to set as key results (they need an objective and a target the blueprint does not carry). |
| `cadence?` | The project sync's (standup's) five-field cron. |
| `review?` | The project's milestone review, a five-field cron its PM holds (`docs/work-tracking.md` "Program management: the matrix"); export writes it back. |
| `appetiteDays?`, `appetiteUsd?` | Its appetite. |

`validateBlueprint` refuses an unknown role title, a role listed twice on a
team, a role over 100% across projects, a malformed cron and unknown fields.
**Export** writes the open projects whose lead and active members map to
role titles. **Plan** lists them (`ImportPlan.projects`). **Import** creates
them once the hires exist — at once in autonomous mode, on approval of the
`blueprint` card in supervised mode (the projects travel in its payload) —
in **Next** (`shaped` when brief and appetite are filled: moving one to Now
stays the CEO's bet), with the lead, the team at its allocations (the import
is the CEO's act, so no allocation cards), the project channel and the
standup (`docs/work-tracking.md` "Project teams").

## 2. Export, plan, import

- `GET /api/workspaces/:id/org/blueprint` — the company as `COMPANY.json`.
  Roles come from the live members (title → agent charter, reports-to by
  title, scopes, tier from the model id through `tierOfModel`, envelope);
  the catalog `roleId` is recovered when the charter equals a role's
  template or the title names a role. Drafts and disabled skills do not
  travel.
- `POST /api/workspaces/:id/org/blueprint/plan` — the **dry run**. Body: the
  blueprint itself, or `{ blueprint, mode?, monthlyUsd? }`. Answers
  `ImportPlan`: the chief and its scopes, every hire in order (parents first)
  with `requestedScopes`, `scopes` after the meet with the chief, `dropped`,
  tier and model, the budget with allocations cut to fit the envelope, each
  tunable with the value that will apply and why, the profile and vision,
  the playbooks, the cadences note, `recommendedConnections` and
  `recommendedCards`, `approval: blueprint | none`, and `ok: false` with the
  reason when the workspace already has a company.
- `POST /api/workspaces/:id/org/blueprint/import { blueprint, mode,
  monthlyUsd? }` — executes exactly the plan: a fresh chief agent (the root
  role's charter, nothing inherited), the organization through `OrgService`
  + `OrgModeService.setMode` (no enrolment of other agents — the company is
  the blueprint's), the profile and rules, the vision (`OrgIntentService`),
  the tunables (`OrgService.setTunable`, audited as decisions), the
  playbooks as **skill drafts** (`SkillsService.importSkillMd`, re-scanned),
  and the staffing:
  - **supervised**: one `blueprint` approval card for the whole plan
    (`org_approvals.kind = blueprint`, payload = the hire payloads with
    `reportsToTitle`). No agent exists until the CEO approves; approval
    applies each hire through `OrgApprovalsService.applyHire` in order,
    resolving titles to the agents created before, re-meeting scopes at
    apply time. A board member cannot decide it (`mayDecide`).
  - **autonomous**: the same hires at once, through the same `applyHire`.
  The import is remembered in `org_blueprint_imports` and audited
  (`blueprint_import`).

Scope rules on import: `connection:*` scopes are **never** imported (a
connection is a grant the CEO makes; they appear as
`recommendedConnections`); the chief gets the root role's remaining scopes
as the CEO's grant (`chiefScopes`); every report's scopes are the meet of
the chief's and the role's. A workspace whose agent cap is below the role
count has the cap raised to the role count by the import (noted in the
plan).

### Export before you archive or delete

A blueprint is how a company outlives its rows. Archiving a company
(`docs/owners-seat.md` "Archive or delete the company") and deleting it
permanently both offer **Export COMPANY.json first** in their dialogs; an
archived company exports through `GET
/api/workspaces/:id/org/archived/:orgId/blueprint` (same document, same
validator). The export carries the structure, charters, profile, cadences
and budget split — not the tasks, decisions, files or history, which a
permanent delete removes (or moves, for `/org/` files). Import it into any
empty workspace, or into the same one once the old company is archived, to
start again from the same shape.

## 3. Publishing and installing through the registry

A blueprint is a registry item of kind `company` (`docs/registry.md` §8).

- `POST /api/market/companies { workspaceId, name?, description?,
  publisherName?, dryRun? }` exports the workspace's company and publishes
  it through `RegistryService.publish({ kind: 'company', manifest })`.
  `normalizeManifest('company')` runs `validateBlueprint` and then the
  SKILL.md scan over every role charter and every playbook (`role "x":` /
  `playbook "x":` prefixes); a blocking flag refuses the publish. The
  capability summary carries `company { roles, depth, monthlyUsd,
  playbooks, cadences, tunables, cards }`, the tool names from the scopes and
  the texts, and the connections the scopes imply.
- `GET /api/market/companies?q=` lists published blueprints (local and the
  federated remote, like `GET /api/registry?kind=company`) with their
  **outcome counts** (§4).
- `POST /api/market/companies/:id/install { workspaceId, mode, monthlyUsd?,
  confirm? }` is the two-step install: without `confirm: true` it answers
  `{ requiresConfirm, review, plan }` — the registry review (the blueprint
  with every charter, the playbook bodies, the scan report) plus the dry-run
  plan for *this* workspace — and writes nothing. With `confirm: true` the
  manifest is re-validated and re-scanned, the import runs, and the install
  row is written with the created `orgId` (`registry_installs.orgId`). The
  generic `POST /api/registry/:id/install` refuses companies and points
  here. The remote feed re-validates a remote company locally like any other
  kind.

### 3a. Built-in starters (first-party)

Seven first-party blueprints ship with the server, the starter catalog of
`docs/foundry.md` §10.2 as plain v1 documents (kits come later, with
`yaam-company/2`). The sources are `blueprints/first-party/<slug>.company.json`;
`node scripts/build-builtin-companies.mjs` (`npm run blueprints:build`)
embeds them in `server/src/registry/builtin-companies.generated.ts`, and a
test fails when the two drift.

| Starter (`builtin:<slug>`) | Seats | Envelope | Roles (catalog ids; the chief is `chief-of-staff` in each) | Profile reads as |
|---|---|---|---|---|
| SaaS startup (`saas-startup`) | 10 | $600 | `engineering-manager` → `engineering-software-engineer` ×2, `engineering-qa`; `cs-manager` → `cs-support`; `marketing-manager` (Head of Growth) → `marketing-demand-gen`; `ops-pm` (Program Manager, leading the "Self-serve onboarding" project with a cross-functional team) | early; adhocracy; speed |
| Agency (`agency`) | 8 | $500 | `project-lead` (Head of Client Delivery) → `ops-program-coordinator`, `designer`; `marketing-content` (Editor-in-chief) → `writer-editor`, `design-brand`; `finance-billing` | growth; market |
| E-commerce shop (`e-commerce-shop`) | 11 | $550 | `ops-manager` → `ops-procurement`, `ops-pm` (Program Manager, owning "Returns in five days"); `cs-manager` → `cs-support` ×2; `marketing-manager` → `marketing-demand-gen`; `finance-manager` → `finance-accountant` | early; market; speed |
| Open-source project (`open-source-project`) | 6 | $250 | `engineering-manager` (Lead Maintainer) → `engineering-software-engineer` ×2 (triager, core contributor), `writer-editor` (docs and changelog); `project-lead` (Community Lead) | early; clan; writing |
| Research lab (`research-lab`) | 6 | $400 | `researcher` (Principal Investigator, strong) → `analyst`, `data-scientist`, `writer-editor`; `auditor` | early; adhocracy; rigour |
| Solo creator (`solo-creator`) | 5 | $150 | `marketing-content` (Editor-in-chief) → `writer-editor`, `marketer`; `controller` (cash-basis books) | early; clan |
| Professional services firm (`professional-services-firm`) | 11 | $700 | `project-lead` (Head of Delivery) → `ops-program-coordinator`, `analyst`, `researcher`; `finance-manager` → `finance-accountant`, `finance-billing`; `people-manager` → `people-recruiter`; `auditor` | growth; hierarchy; rigour |

Two starters carry a roadmap item with a cross-functional team (§1b):
**SaaS startup**'s Program Manager leads "Self-serve onboarding" with the
product engineer (60%), the QA engineer (30%), the growth marketer (40%) and
the support specialist (20%) on its team, a weekday standup and a weekly
milestone review;
**E-commerce shop**'s Program Manager owns "Returns in five days" with
the returns support specialist, procurement, the staff accountant and the
growth marketer. Both import into Next — the CEO bets Now.

How they are written, and what the test pins
(`tests/backend-builtin-companies.test.ts`):

- **Valid v1**, inside the caps (≤ 20 roles, depth ≤ 3, fan-out ≤ 5, one
  root, the `chief-of-staff` role), already in normal form, origin
  `{ exportedFrom: "yaam first-party", sourceOrgId: "first-party" }`.
- **Roles from the catalog only.** Each role names its `roleId`; its charter
  is the catalog charter with `{company}` written as "the company" (so it
  reads right whatever the CEO names the organization) plus one sentence of
  focus for that company type; its scopes are the role's `toolScopes` (and,
  for support seats, a `connection:gmail:read` that the import turns into a
  recommendation). The chief's scopes cover every report's, so the meet
  drops nothing on import.
- **Within the envelope**: the seats' `monthlyUsd` sum to at most
  `budget.monthlyUsd`, the remainder is the chief's headroom, and
  `allocations` are the per-seat envelopes, so the plan never cuts one. The
  envelope is a starting point; the install asks for the CEO's.
- **Cadences and tunables derived from the profile**, never fixed: the
  root's rituals are exactly what `deriveOperatingSystem` (chief-os.ts)
  derives from the blueprint's own values and culture, and `tunables` are
  that derivation's values that differ from the defaults (what the
  onboarding wizard writes for the same profile). Unit cadences follow the
  kits' rhythms in §10.1 (sprint planning, queue review, close…) on units
  the blueprint has. As for every v1 import they are **listed** for the
  chief — the plan now carries `cadences.list` and the plan screen shows
  each in words with its unit — and not written.
- **No playbooks**: no starter playbook exists as a shared skill yet, so
  none is carried (a role hire brings its pack's playbooks only on the
  `role:` hire path, not through a blueprint). Recommended **cards** are
  calendar, mail, drive and browser as fits.

**How they are served.** Merged into the listing server-side, not seeded:
`RegistryService.list({ kind: 'company' })` prepends `builtinCompanies()` —
each manifest run once per process through the same
`normalizeManifest('company')` as a publish (validation and scan) — with
`source: 'builtin'`, `official: true`, publisher `yaam`, id
`builtin:<slug>`, searchable by name, description, slug and "official".
`get`, `review` and `POST /api/market/companies/:id/install` resolve the
prefix like `remote:`, so install is the ordinary review → plan → confirm.
Install counts are read from `registry_installs` rows for the id (there is
no `registry_items` row to bump) and outcomes attach to it through
`registry_outcomes` as for any item. Seeding rows at boot would have meant
per-account copies to keep in step with the files and a migration on every
change; the built-in catalog changes with a deploy and costs no storage.
The Community tab (no `kind`) does not list them.

**Where to start one.** Market → Companies, *Review & install* into an
empty workspace (a workspace that runs a company is refused at the plan).
The new-workspace wizard (`NewWorkspaceWizard.tsx`) bootstraps a company
from its own steps and has no blueprint import, so it does not list them
yet.

### In the app

Settings › Company has a **Blueprint** row: *Export
blueprint* downloads the COMPANY.json; *Import blueprint* takes a pasted or
picked file, the mode and an optional envelope, shows the dry-run plan (the
chief, hires by role with the scopes they keep and the ones dropped at the
meet, units, budget and allocations, tunables as applied, playbooks as
drafts, cadences listed, recommended connections) and imports on confirm —
in supervised mode it then opens the one `blueprint` approval card; *Publish
to registry* previews the scan first and publishes on a second click. The
Market's **Companies** tab lists the official starters first (badge
*Official*, seats and envelope on the card), then published blueprints, with
their two outcome counts and installs one into a chosen workspace through the same review →
plan → confirm steps, playbook bodies shown before anything is created. The
org chart's **Hire** dialog shows the role catalog (§5) ranked against the
operating profile, and Organization → People seats hybrid employees (§6) who
get a **My tasks** pane.

## 4. Rating by outcomes

A blueprint is rated by what the companies that ran it achieved, not by
stars. Two milestones are measured, model-free, by
`OrgBlueprintsService.sweepOutcomes` (hourly; once per import, each):

- `first_key_result` — the first key result of the imported company reaches
  `achieved`;
- `thirty_days_in_envelope` — thirty days after the import, company spend
  (`org_budgets` scope `company`) is at or under the envelope. Over it, the
  row records `missed:<date>` and the milestone is never earned.

Each milestone is stamped on the `org_blueprint_imports` row and audited
(`blueprint_outcome`) **always**. It reaches the registry item only when the
app setting **`shareBlueprintOutcomes` is `on`** (default off; `PUT
/api/settings`): a `registry_outcomes` row for a local item, or an anonymous
`POST /api/registry/public/:id/outcome { kind }` for a remote one (a public
route like `/installed` and `/rate`). The outcome carries the kind and
nothing else — no org id, workspace, name or number. Turning sharing on later
does not back-report milestones already stamped.

## 5. The role catalog as data

`server/src/org/roles/catalog.ts` — a `Role` is `{ id, title, charter
(template, {company} filled in), competencies[], toolScopes[] (meet-rule
strings), modelTier, estMonthlyUsd, fits[] (profile tags), reportsToHint? }`.
Seed: Chief of staff, Researcher, Writer / Editor, Analyst, Engineer,
Designer, Marketer, Support, Controller, Auditor (read-only scopes — the same
holdings the `Auditor` pack is hired with), Project lead.

- `GET /api/workspaces/:id/org/roles?profile=` — `OrgRolesService.list`
  ranks the catalog against the profile text with a pure string match on
  `fits` (no model); without `profile` it uses the company's own values,
  culture, mission and vision.
- `org_hire_agent` accepts `templateOrPack: "role:<id>"`.
  `OrgApprovalsService.prepareHire` resolves the role into the existing
  template-hire path: the role's charter for this company, the title the
  chief gave (also the agent's name), the role's scopes plus any requested
  ones **met with the chief's holdings**, and the model tier → a model
  (`modelForTier` delegates to item 23's `tierModel` in `org-routing.ts`, one
  tier table: `cheap` is the provider's cheapest sibling, `strong` its strong
  model, `standard` the default; a CEO-pinned tier model wins). The payload carries `roleId` and `modelTier`; a hire from
  `role:auditor` fills an empty `auditorAgentId` like the pack does. An
  unknown role is refused with a pointer to the catalog.

## 6. Hybrid human roles

`org_humans.role` gains `employee` (beside `ceo | board | observer`), with
`reportsToAgentId` (an active member; the chief by default) and `title`.

- **Chart and channels.** Employees appear on the unit tree
  (`UnitNode.memberHumanIds`) under the unit their manager leads (or sits
  in), and `OrgUnitsService.syncMembership` adds them to that unit's channel
  and to `#company` — not to other units'. Changing the manager moves them;
  removing the row re-syncs.
- **Tasks.** `org_tasks.assigneeHumanId` (mutually exclusive with
  `assigneeAgentId`) and `reviewerHumanId`. `POST …/tasks/:taskId/assign {
  humanId }` (or `{ agentId }`) → `OrgTasksService.assignHuman`: the task
  lands on the manager's board, no wake (a person is not woken), and an
  **addressed inbox event** (`org_task`, `forMemberAccountId`) the push and
  channel sweeps deliver to that member alone. `GET …/humans/me/tasks` and
  `GET …/humans/:memberAccountId/tasks` are the member's task cards
  (`assigned`, `reviewing`); they update status and comment through the
  existing task routes.
- **Review.** `POST …/tasks/:taskId/request-review { text?, reviewerHumanId
  }` puts the task in review and raises a `human_review` approval card
  addressed to that employee (and an `org_review` inbox event). Only the
  addressee or the CEO decides it: approve → the task is accepted (the human
  is the floor, no second check); reject → `request_changes` with the note.
- **Tools.** `org_assign` takes `human` (a title or account id) instead of
  `agent`: a unit lead may assign only humans who report to it; the chief
  anywhere. Audited as `task_assign_human`.

## 7. Safety

Blueprint import is **data-only**, the Paperclip import lesson applied:
no code runs, no connection or grant is created (connection scopes are
dropped and recommended), no memory, lesson, token, file or task is copied,
agents start with a charter and the met scopes and nothing else, playbooks
are drafts behind the Skills approval, tunables stay inside the code-level
bounds, the structural caps apply to the document before anything is
created, and the staffing of a supervised company is one approval card the
CEO reads before any agent exists. Publishing runs the same scan as agents
and skills; installing re-validates and re-scans locally and never trusts
the remote's report. Outcome sharing is opt-in and anonymous.

## 8. Files

`server/src/org/roles/catalog.ts`, `org-roles.service.ts`,
`blueprints/format.ts`, `org-blueprints.service.ts`,
`blueprints/blueprints.controller.ts`, `blueprints/companies.controller.ts`;
`registry.service.ts` (kind `company`, `recordExternalInstall`,
`recordOutcome`, `bumpPublicOutcome`, `outcomesOf`); migration
`0036-org-blueprints` (`org_tasks.assigneeHumanId | reviewerHumanId`,
`org_humans.reportsToAgentId | title`, `registry_installs.orgId`,
`org_blueprint_imports`, `registry_outcomes`); the `blueprint` and
`human_review` approval kinds and `registerApplier` in
`org-approvals.service.ts`; `shareBlueprintOutcomes` in
`settings.module.ts`; `/api/registry/public/:id/outcome` in
`auth-strategy.interface.ts`; `tests/backend-org-blueprints.test.ts` (11).
Built-in starters: `blueprints/first-party/*.company.json`,
`scripts/build-builtin-companies.mjs`,
`server/src/registry/builtin-companies.generated.ts`, `builtinCompanies` /
`BUILTIN_PREFIX` in `registry.service.ts`;
`tests/backend-builtin-companies.test.ts`,
`web-tests/market-companies.test.tsx`.
