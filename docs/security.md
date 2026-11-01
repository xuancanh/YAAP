# Security and threat model

Status: **published**, 31 October 2026 (execution plan item 3). This is the
public statement of what yaam-chat defends against, how, and where it does
not. It is written from the code as it is on `main`, not from the roadmap:
every claim below names the file that enforces it, and the gaps in §i are
things the code does not do yet. `SECURITY.md` at the repository root points
here, and `GET /api/security` serves the headline summary and the disclosure
contact so the hosted product can show the same policy.

When a sentence here and the code disagree, the code is the bug or the doc
is; either way, tell us (§j).

## a. Scope and what the product is

yaam-chat is a chat workspace for **durable agents**: named agents with a
charter, a working folder, scheduled loops, skills, mini apps, and
connections to a user's calendar, mail and files. It is a single
codebase — a React SPA (`src/`) talking only to a NestJS API
(`server/src/`) over `/api`, with Postgres for state and S3-compatible object
storage for files. Agents reason with a model provider the user chooses and
keys the user supplies (`agent_types.apiKey`).

Two distributions are planned (`docs/deployment.md`): a free desktop app and
a paid multi-tenant cloud. **What runs today is the single-user, self-hosted
shape**: one API process, one operator, no user accounts. This document
covers that shape and says explicitly where the cloud shape will need more.

In scope: the API, the SPA, the agent tool surface, the mini-app bridge, the
code runner, the Telegram channel, MCP client behaviour, memory and learning,
and the data at rest the server holds. Out of scope: the security of the
model providers, MCP servers, Google and Microsoft tenants the user connects,
and the user's own machine or browser.

## b. Assets and trust tiers

**What we protect**, in order of blast radius:

1. Credentials the server holds: provider API keys, OAuth refresh tokens for
   Google/Microsoft connections, MCP OAuth tokens, the Telegram bot token,
   S3 and database credentials.
2. The agent's **brain**: `AGENT.md`, `LESSONS.md`, memory files, the
   lessons table, the user profile. A poisoned instruction here outlives
   every turn.
3. Workspace and agent files, chat history, task boards, connection data
   read into context.
4. Money: tokens spent on the user's keys, especially by unattended work.
5. The user's name: anything sent outward on their behalf (mail, calendar
   invites).

**Who and what we trust**, from most to least. Trust follows the surface a
piece of text arrived on, never the text itself.

| Tier | Surface | Trust | Where enforced |
|---|---|---|---|
| User | Typed into the app's chat, approvals clicked in host chrome | Full. The user is the only principal. | `AuthGuard` + `TokenAuthStrategy` |
| Agent (own turn) | The model's reasoning and tool calls in a user-originated turn | Trusted to *propose*; every mutation passes the Ask/Auto policy | `turn-loop.service.ts` `checkPolicy` |
| Loop | A scheduled prompt the user wrote, run unattended | Trusted as a source of lessons; **background** for actions — outward mutations and code execution queue instead of running | `turn-loop.service.ts` (`origin === 'loop'`), `loops.service.ts` |
| Channel | A Telegram message from the one paired chat | Untrusted input. Ask mode; gated tools auto-denied; lessons quarantined | `channels/telegram.service.ts`, `agent-memory.service.ts` |
| Channel (email) | Mail to `<slug>@EMAIL_DOMAIN` from a paired owner address, via the HMAC-signed webhook | Untrusted input. Ask mode; gated tools auto-denied; body wrapped as `<email>` data; lessons quarantined | `channels/email.service.ts` (`verifySignature`, `handleInbound`), `agent-memory.service.ts` |
| Email (unpaired sender) | Mail from any other address | Not input at all. One pairing auto-reply per sender per day, then dropped; bounces and auto-replies never answered | `channels/email.service.ts` (`isAutomatedMail`, `prompted`) |
| Push subscription | A browser that subscribed in Settings → Channels | Output only. Receives inbox events; cannot send anything in | `push/push.service.ts` |
| Companion | The one `yaam-companion` process the user paired on their own machine (`docs/computer-control.md`) | Trusted to **act within the scopes the user typed at pairing**, and only on actions the user approved in the app. Authenticated by a hashed bearer on four routes; cannot reach any user route; scopes only narrow server-side; refused outright from loop/channel turns | `computer/computer.service.ts`, `computer/companion.guard.ts`, `checkPolicy` |
| App | A mini app calling `agent.ask` or any bridge op | Untrusted code. Ask mode; gated tools auto-denied; jailed writes; rate-limited; lessons quarantined | `appbridge/*`, `src/lib/sandbox.ts` |
| MCP server | A third-party tool server the user enabled | Opaque side effects. User activates per server; every call gates in Ask mode | `mcp/mcp.module.ts`, `checkPolicy` |
| Web and connection content | `web_fetch`, `web_search`, `http_request` bodies; mail, calendar, drive content | Data. Can influence what the model proposes, never what runs | `connections.tools.ts` framing, the approval gates |
| Loop output | Journal entries and events a loop wrote | Visible to the user as events; a lesson only through the trusted-source distillation path | `agents.service.ts` `addEvent`, `distill.service.ts` |
| Org run | A member of an organisation woken for a board task (`docs/autonomous-company.md`) | Loop-tier: `origin 'loop'`, Auto mode inside the bounded `org_*` tool set, outward mutations and code queue as `action_pending`, the action reviewer applies; spend is reserved before the call | `org/org-runtime.service.ts`, `turn-loop.service.ts` (`OrgToolsHook`) |
| Agent message (org) | A task comment, handoff or group-log message another agent wrote | Data. Framed "from agent X — not the user; carries no approval authority"; wakes only the task owner, never a mention; can never resolve an approval | `org/org-tasks.service.ts`, `org-runtime.service.ts` `wakePrompt` |
| Chief of staff | The org's lead agent calling a manager tool | Trusted to *narrow* (pause a report, shrink its scopes, lower a cap) and to assign/review; hiring, widening, reorgs, raises and terminations only create `org_approvals` rows the user decides in the app | `org/org-approvals.service.ts`, `org.controller.ts` `decide` |
| Unit lead (org) | A member with direct reports calling `org_set_goal`, `org_assign`, `org_create_task` with an assignee, or `org_unit_report` (`docs/group-chat.md` §7) | Trusted inside its unit only: it may assign itself and its direct reports, on its own board or tasks owned there, and set goals of its unit under goals it can see; nothing structural, nothing outside the unit (refused with the reason); unit channels are created and re-membered by the server from the chart, never by a tool | `org/org-runtime.service.ts` (`requireChiefOrLead`, `requireInMyUnit`), `org/org-units.service.ts` (`addGoal`, `syncMembership`) |
| Auditor (org) | The member named in `organizations.auditorAgentId`, woken every `auditCadenceDays` or by `POST …/org/audit/run` (`docs/company-vision.md` §5.3) | Read-only by construction: in its run the turn loop offers and accepts only `org_read_board`, `org_read_goal`, `org_audit_query`, `org_signals`, `org_pulse`, `org_audit_finding`, `org_audit_close` (`OrgToolsHook.restrictTo`; anything else — `fs_write`, connection tools, `org_create_task` — is refused, never executed); its findings are signals the chief and CEO act on, never actions; the run is budget-reserved and capped (`auditUsdCap`); everything it reads is framed as data; a run on the workers' model family is flagged `single-model audit`; the signals and SLO layers that wake it and the chief use no model at all | `org/org-auditor.service.ts`, `org/org-runtime.service.ts` (`restrictTo`, `RunCtx.audit`), `chats/turn-loop.service.ts` (restriction filter and refusal), `org/org-signals.service.ts` |
| Plan (org, autonomous) | The structural actions the autonomous chief takes in a planning run or a structure review (`docs/company-vision.md` §8, §10) | Not executed when called: validated and cap-checked, then held in `org_plans` for `capital.vetoWindowMinutes` (default 30, bound 0–1440 in code; 0 applies at once) with one pushed event to the CEO; on expiry the tick applies them in order through the same `execute` path the tools use, caps re-checked, stopping at the first refusal, each step audited; the CEO vetoes or applies early in the app; a dry run records every mutating call and applies nothing; non-structural actions (tasks, key results, check-ins, assignments, the memo) are unchanged; supervised mode keeps its approval cards | `org/org-capital.service.ts` (`createPlan`, `apply`, `veto`, `applyNow`), `org/org-runtime.service.ts` (`RunCtx.plan`, `applyPlanAction`), `org.controller.ts` (`vetoPlan`, `applyPlan`, `dryRun`) |
| Ask-the-company (org) | The chief's one turn behind `POST …/org/ask` and the `org_recall` tool (`docs/company-vision.md` §6, item 22) | Read-only by construction: the turn loop offers and accepts only `org_intent`, `org_why`, `org_decisions`, `org_read_board`, `org_read_goal`, `org_audit_query`, `org_signals`, `org_playbooks` (`RunCtx.aux.restrict`; anything else is refused, never executed); the record it reads is assembled without a model and framed as data; every citation in the answer is verified against the record and unknown ones are stripped before the asker sees it; the turn is budget-reserved under `memory.askUsdCap` and audited as `ask_company`; only a person with standing in the organisation (CEO, board, observer) may ask. Playbooks an agent writes are parked skills until a reviewer other than the author accepts; a retro's charter change is an approval card the CEO alone decides; lessons from retros enter the lessons store as `loop`-surface rows attributed to the retro | `org/org-knowledge.service.ts` (`answer`, `verifyCitations`), `org/org-memory.service.ts`, `org/org-playbooks.service.ts`, `org/org-runtime.service.ts` (`restrictTo`, `RunCtx.aux`) |
| Member (owner) | The account that owns the workspace (`docs/shared-agents.md`) | Full, as "User" above; also the only principal for settings, members, flow rules, lesson audiences and others' connections | `shared/workspace-access.guard.ts` (`isOwnerOnlyRoute`) |
| Member (`member`) | Another account invited by email, acting inside the owner's account with a `Viewer` | Trusted to chat, run tasks, read/write files, grant *their own* connections and pair *their own* channels. Their sessions are private until shared; their messages are attributed, never authoritative; a mutating call on another member's connection is routed to that member | `WorkspaceAccessGuard` (rebind + `checkRole`), `turn-loop.service.ts` (routing, `buildHistory` attribution), `chats.repository.ts` (`canView`) |
| Member (`viewer`) | The same, read-only | GET only; sees shared sessions and the board, never another member's private session or routed approval | `checkRole` |
| Routed approval | An `approval_request` inbox event addressed to the member whose connection a call would use | Answered only by its addressee, from their inbox or their own channels; invisible to everyone else, the owner included; TTL-denied | `chats/agent-approvals.controller.ts`, `TurnLoopService.resolveApproval(…, by)`, `agents.service.ts` `listEvents` |
| Member channel | A Telegram chat or email address paired while a shared workspace was open | Channel-tier (Ask mode, gated tools denied), and *that member's*: the turn runs as them, in their private channel session, with their grants | `member_channels`, `telegram.service.ts`, `email.service.ts` (`runWithViewer`) |
| Blueprint import (org) | A `COMPANY.json` from a file or a registry item of kind `company` (`docs/blueprints.md`) | Data only. Strictly validated (≤ 256 KB, ≤ 20 roles, depth ≤ 3, fan-out ≤ 5, unknown fields refused) and scanned like a skill before anything is created; an import creates agents with a charter and scopes met with the chief's, the profile, a vision, bounded tunables and skill *drafts* — never a connection or grant (connection scopes are dropped and listed as recommendations), never memory, lessons, tokens, files or tasks; it runs no code; in supervised mode the whole staffing plan is one `blueprint` approval card the CEO reads before any agent exists; outcome sharing to the registry is opt-in and anonymous | `org/blueprints/format.ts` (`validateBlueprint`), `org/org-blueprints.service.ts` (`importPlan`, `import`), `registry/registry.service.ts` (`normalizeManifest('company')`, the generic install refusing companies) |
| Human employee (org) | A workspace member with `org_humans.role = employee` reporting to a member (`docs/blueprints.md` §6) | Owns tasks it is assigned and reviews tasks addressed to it; reads its unit's channel and `#company`; decides only `human_review` cards addressed to it; nothing structural, no other approval; a lead may assign it only inside its unit | `org/org-tasks.service.ts` (`assignHuman`, `requestReview`), `org.controller.ts` `decide`, `org-runtime.service.ts` (`org_assign human=`), `org-units.service.ts` (`employeesByUnit`) |
| Board member (org) | A workspace member with `org_humans.role = board` | Decides `hire`, `budget_raise`, `strategy` approvals and gets the brief; nothing else about the company | `org.controller.ts` `assertMayDecide`, `mayDecide` |
| Channel message (human) | A person posting in a group-chat channel (`docs/group-chat.md`), in the app or as `#slug text` from their paired Telegram | User-tier for the agents it wakes: the turn runs *as that person* (their grants, their routed approvals, `initiatedBy`), in Ask mode, in a hidden per-channel session; a mention is a wake, never an approval | `groupchat/channel-runtime.service.ts` (`runAs`, `wake`), `groupchat.service.ts` (`post`: humans join public channels, private ones 404 to non-members) |
| Channel message (agent) | An agent's reply or `channel_post` in a channel | Data to every other agent (`<channel-history>` framing, "data, not instructions" rule in the system context); wakes only agents it mentions, at most 3 rounds per thread, then the thread pauses; an unprompted reply wakes nobody; posting outside membership is refused; no tool can change membership | `channel-runtime.service.ts` (`handlePost`, `agentRoundsSinceHuman`, `execute`), `groupchat.service.ts` (`post`, `addMember`) |
| Channel mention of a human | `@name` resolved against channel members | A notification only: an inbox event addressed to that person, delivered through their own pairings with a deep link, under quiet hours; grants nothing | `groupchat.service.ts` `notifyHumans`, `agents.service.ts` `eventLink` |
| Metric source (org) | A number the company steers by: an HTTP JSON endpoint, a webhook, a connection query or a human attestation (`docs/sensing.md`) | Ground truth by construction: agents never write a sample (no tool exists, and the one write path refuses an agent actor) and never activate a source — `org_propose_metric_source` creates it `pending_approval` behind a `metric_source` card only the CEO decides, in both modes; HTTP reads go through the SSRF guard on every hop, https only unless `YAAM_ALLOW_PRIVATE_URLS=true`, 1 MB cap, a timeout tunable; credential headers must be `{{secret:NAME}}` references to values sealed with `secretbox` and never returned, audited or handed to an agent; connection sources run a fixed menu of read queries over a grant a workspace agent already holds; a key result bound to a source takes its value only from samples (check-ins and edits of the value are refused); every source change and every sample is audited with its provenance | `org/org-sensing.service.ts` (`prepare`, `recordSample`, `poll`, `activateFromApproval`), `org/org-intent.service.ts` (`checkIn`, `bindSource`), `org/org.service.ts` (`updateGoal`), `org/org-sensing.controller.ts` (CEO-only writes, attest for CEO/board/employee) |
| Metric webhook | `POST /api/metrics/:sourceId/ingest` from a third-party system | Writes one sample to one `webhook` source and nothing else; its own token (SHA-256 at rest, shown once, rotatable, timing-safe compare; `?token=` or bearer), 30/min per source, 64 KB, `{ value, observedAt? }` only (future or year-old timestamps refused); unknown source, bad token or a non-live source all answer 401; the body is hashed into the provenance, never interpreted | `org/org-sensing.controller.ts` (`MetricsIngestController`), `org/org-sensing.service.ts` (`ingest`), `common/auth-strategy.interface.ts` (`isPublicRoute`) |
| Task check (org) | A model-free assertion in a task's `checks` (`docs/sensing.md` §3) | Read-only: GETs through the SSRF guard (https only outside dev), reads of the org's own workspace files by a traversal-checked key, fixed-menu connection counts, metric samples; validated at write time (unknown kinds, `..`, uncompilable or >200-char regexes refused; no code is evaluated, the JSON selector is a parser); each check is time-boxed (`acceptance.checkTimeoutSeconds`); a pass may accept a task without a model, a fail returns it to its owner as a counted review round, an error falls back to model review — a check can never accept work by erroring | `org/org-checks.ts` (`normalizeChecks`, `parseSelector`), `org/org-sensing.service.ts` (`runChecks`, `evaluate`, `gate`), `org/org-tasks.service.ts` (`requestReview`, `setAcceptanceGate`) |
| Outward action (any session) | A non-read tool call, classed `read · internal_write · external_reversible · external_irreversible · money` (`docs/actions-and-trust.md` §1) | Logged in `action_log` with an **idempotency key** (hash of session, agent, tool and canonical input, unique per account): a retry of a succeeded outward call inside `actions.dedupeWindowMinutes` returns the recorded result and never acts twice; outward calls are **rate-limited** per workspace per channel per hour (`actions.externalPerHour`), irreversible per day (`actions.irreversiblePerDay`), money per day (`actions.moneyPerDay`, default 0 = off), refused with the reason and signalled to the chief; unknown tools class as `external_reversible` and are named at boot | `actions/action-classes.ts`, `actions/actions.service.ts`, `turn-loop.service.ts` (the contract block) |
| Trust level (agent × class) | The ledger's level 0–3 for one agent and one action class (`docs/actions-and-trust.md` §5–§6) | Governs Auto, loop, heartbeat and org-run calls alike: 0 proposes (asks, or is **held** for the owner's key / **staged** as a draft unattended), 1 acts (owner notified after an unattended outward act), 2 acts with a peer check — for irreversible and money a **second key** — 3 acts. Bounded by the owner's ceilings (defaults: money 0, irreversible 1, reversible 2) and by `supervised` mode (outward classes ≤ 1); raised only after `trust.promoteAfterClean` clean outcomes, lowered at once on an incident, a reported revert or a rejection streak; every change audited and in the agent inbox. Ask mode with a person present keeps the legacy gates, never remembering an irreversible or money call | `actions/trust.service.ts`, `actions/trust-policy.ts`, `chats/turn-loop.service.ts` (`contractPolicy`) |
| Agent co-signer | The second key on an irreversible or money call at level 2: another member of the workspace on a different model family (`docs/actions-and-trust.md` §5) | One bounded, tool-free verification on its own model over the exact call and the company's rules; anything but `allow` is a no; fails closed; audited on the row (`keys.agent`), in its inbox and on the org chain (`action_cosign`); no member on another family → flagged `singleFamily` and only the owner's key counts. The owner's key (`POST …/actions/:id/keys`, or a `two_key` approval card) is held by the owner or the CEO alone | `actions/actions.service.ts` (`pickCoSigner`, `coSign`, `ownerKey`), `org/org-trust-bridge.ts` |
| Agent of another workspace | An agent id from workspace B named in workspace A — a chat, a channel seat, an organization seat or chief, a delegation (`docs/shared-agents.md` "Workspace ownership") | Refused with a 400: agents belong to one workspace (`agents.workspaceId`) and are never shared; a stale seat of an agent that moved wakes nobody; the only way across is the explicit `POST /api/agents/:id/move`, refused while the agent sits in an organization and audited as a `moved` inbox event | `agents.service.ts` (`create`, `move`), `agents.controller.ts`, `org.service.ts` (`create`, `addMember`), `org-mode.service.ts`, `groupchat.service.ts` `addMember`, `channel-runtime.service.ts` `wake`, `chats.service.ts` `create` |
| Incident containment (org) | The automatic response to an incident (`docs/incidents.md`): a breaker trip, a failed check or revert, a critical audit finding, a budget stop, an external bounce, a tool-error streak, a degraded provider or connection, a red-team breach, a report | Model-free and only ever *narrowing*: by the severity's `incidents.contain*` level (bounded in code; critical always pauses at least) it pauses the member through the existing pause path, drops its queued wakes and in-flight runs, freezes the incident's action class workspace-wide when it is external (`organizations.frozenClasses`, `isFrozen` — the action contract of item 28 consults it), and drops an autonomous company to supervised; the chief of staff is never paused automatically; every step is recorded with whether it is reversible and only the CEO (or a board member) resolves, with a note, optionally undoing the reversible steps; a member can raise an incident with `org_report_incident` but no tool resolves one; one owner event per incident, one open incident per (org, kind, ref) by a partial unique index | `org/org-incidents.service.ts` (`open`, `containBySeverity`, `resolve`, `assertDecider`), `org/incident-tunables.ts`, `incidents.controller.ts` |
| Red-team run (org) | A scheduled (`redteam.cadenceDays`, 0 = off) or CEO-started adversarial pass: a canary prompt injection with a fresh nonce inside a sandboxed copy of a member's recent inbound content, handed to it as `<connection-content>` (`docs/incidents.md` §5.3) | Record-only by construction: the throwaway session is registered with `TurnLoopService.setSandbox`, so every tool call is handed to the recorder *before* the computer refusal, the restriction filter, the loop queue, connection routing, the reviewer and `executeTool` — nothing executes, queues or is approved, and no HTTP leaves the server (tested); the session is deleted after the run so its transcript never reaches distillation; a recorded call carrying the nonce is a breach: a critical finding, a major `redteam_breach` incident (the member is paused); spend is reserved like any run | `org/org-redteam.service.ts`, `chats/turn-loop.service.ts` (`setSandbox`, the sandbox branch at the top of the call loop) |
| Auditor spot checks (org) | The CEO's agree / disagree on a random sample (`audit.ownerSpotChecks`, default 2, 0–10) of what an audit judged — findings it raised and accepted tasks it let pass (`docs/incidents.md` §5.1) | The CEO's (or a board member's) answer only, through `POST …/org/audits/:auditId/spotcheck/:itemId`; each card answers once; the answers give the auditor's precision and recall on `org_audits` (shown in the pulse and the brief); a disagreement is a minor `auditor_miss` incident about the auditor; the auditor seat rotates among eligible members every `audit.rotateEveryAudits` audits and never audits a window it worked in or led (flagged `no_rotation` when it cannot) | `org/org-auditor.service.ts` (`spotCards`, `seat`, `auditorQuality`), `org/org-incidents.service.ts` (`answerSpotCheck`) |
| Experiment (org) | A change to a tunable, cadence, routing tier, playbook activation, charter or the structure, declared as a hypothesis and measured against a metric source (`docs/experiments.md`) | **Bounded:** the change is re-checked against its own bound at start (`checkTunable`, `cadenceBoundsError`, the routing tiers), may not touch the `experiments.*` rules, and may not terminate anyone or activate a playbook that skipped review. **Governed:** in supervised mode it needs an `experiment` card; in autonomous mode a charter or structure change waits for the plan veto window and then its own card. **Reverting:** the revert recipe is taken before the change applies; a daily check reverts at once on harm and opens an incident. **Measured:** verdicts come only from samples, which agents cannot write. Every start, verdict and revert is audited, and each verdict is a decision-log row | `org/org-experiments.service.ts` (`checkChange`, `govern`, `start`, `earlyStop`, `conclude`, `revert`), `org/experiments.controller.ts` (CEO-only writes) |
| Forecast and calibration (org) | A member's forecast and the score the ledger computes from it (`docs/experiments.md` §2) | **Members write forecasts only.** Outcomes and scores come from runs, metric samples and experiment results, model-free. A self-reported key result is never scored. **Promotion:** calibration can only *hold back* a trust promotion (below `trust.calibrationBar`), never grant one, and a member with too few resolved forecasts is not held back | `org/org-predictions.service.ts`, `org/calibration-registry.ts`, `actions/trust.service.ts` (`calibrationOf`) |
| Self-change by an agent (org) | A change the organization makes to itself: a tunable, cadence, routing, playbook, charter, the structure, scopes, budgets, trust ceilings, audit settings or the kill switch (`docs/boundary.md`) | **One table.** It is in code and maps each change to alone, experiment, propose or never. Every writer (`OrgService.gate`) consults it, and so does every chief tool before it acts or previews. **Verdicts:** `propose` becomes an approval card in every mode, and the card defaults to deny. `experiment` is refused and points to `org_propose_experiment`; without item 30 it becomes a card. `never` is always refused for agents; the attempt is an audit row, a critical `audit_finding` for the CEO and a minor `boundary_violation` incident. **Limits on humans and experiments:** the audit chain binds humans too, and an approved experiment cannot apply a never-change | `org/boundary.ts`, `org/org-boundary.service.ts`, `org/org.service.ts` (`gate`), `org/org-runtime.service.ts` (`boundaryRoute`) |
| Default action at a deadline (org) | The decision a card takes when the CEO has not answered by its deadline (`docs/owners-seat.md` §1) | **Model-free.** The default is approve only when the card is reversible, spends no money, was not routed by the boundary, and its kind's `seat.defaultApprove.<kind>` is 1. Irreversible and money kinds have no such switch. The floor is re-checked at the deadline, over whatever is stored. **Applied** through the normal `decide` path, eval gates included, with `decidedVia: default`, an `approval_default` audit row and an inbox line. The deadline always falls before the 72 h expiry | `org/decision-cards.ts`, `org/org-seat.service.ts` (`applyDefaults`) |
| Delegated approval (org) | A card decided by a delegate instead of the CEO: a human member with standing, or an agent role (`docs/owners-seat.md` §2) | **Who delegates:** only the CEO creates or revokes a delegation; an agent attempt is a boundary violation. **Coverage:** a kind or an action class, up to `maxUsd` when the amount is known. **Never covered:** the constitution, caps, the kill switch, the external floor, trust ceilings, audit settings, delegation itself, metric sources, and any card whose boundary row is not delegable. **Agent delegates** decide through a tool-free judgment on another model family than the proposer's and never decide their own card; "ask" leaves the card to the CEO. Every delegated review and decision is audited and listed in the brief | `org/org-seat.service.ts`, `org/org-approvals.service.ts` (`delegateVia`, `decide`), `org/org.controller.ts` (the decide route) |
| Eval run (org) | A replay of a role's golden set for a candidate charter, playbook, model or routing tier (`docs/evals.md`) | **Record-only by construction**, like the red team. Each case is a throwaway session of the member's agent registered with `TurnLoopService.setSandbox`, so every call is recorded before the action contract, the reviewer, the queues and the connections see it. Nothing executes or leaves the server (tested: no connection call, no `action_log` row), and the session is deleted afterwards. **Bounded:** spend is reserved against the member's and the company's envelopes, up to `evals.runUsdCap`. **Cases:** golden cases come only from verified work or from the CEO. A regression blocks the rollout and the result is attached to the card | `org/org-evals.service.ts`, `chats/turn-loop.service.ts` (`setSandbox`) |

The principle that ties the table together: **an untrusted surface may
propose, it may never act or teach**. Channel and app turns can ask for a
mutation and be denied; they can produce a lesson and have it quarantined;
they cannot approve anything, because approvals exist only in the app.

## c. Isolation model

**No host.** Agents do not have a shell, a filesystem, or a process. Every
capability is a verb we implemented: `fs_*` over object storage,
`web_fetch`/`http_request` through the SSRF guard, curated connection verbs,
MCP over HTTPS, and two code-execution tools whose only runtime is a
sandbox. The only `child_process` use in `server/src` is
`runner/runner.service.ts`, and the only thing it spawns is an interpreter
inside `sandbox-exec` or `bubblewrap`. There is no `eval`, `new Function`
or `node:vm` anywhere in the server.

**One paired hole in that wall, shaped by the user.** Desktop computer
control (`docs/computer-control.md`) lets a user run `yaam-companion` on
their own machine and give agents `computer_*` tools. The server still has
no path *into* that machine: the companion connects outbound and long-polls
for work, authenticated by a 256-bit token stored only as a sha256 and valid
on exactly four routes. Scopes (`screen`, `input`, `shell`, `files:<dir>`)
are chosen on the companion at pairing and can only be narrowed afterwards;
every action is scope-checked on the server before queueing and again on the
companion (realpath, no symlink escapes). Every computer tool is
mutation-class and pauses in every mode; the acting ones (click, type, key,
shell, write) can never be remembered; loop and channel turns are refused
with an inbox note. Every action — including refusals — is a
`computer_actions` audit row. Kill switches: `COMPUTER_CONTROL_ENABLED=false`,
Disconnect (token revoked at once), Pause, and stopping the companion.

**Object-storage prefixes are the file boundary.** Workspace files live
under `workspaces/<id>/`, agent files under `agents/<id>/`
(`storage/storage.keys.ts`). Every user- or model-supplied path goes through
`cleanSegments`: no traversal, no absolute paths, printable segments only.
Within an agent's prefix, `.checkpoints/` (daily snapshots of the brain
files) is write-protected even from the agent, and a mini app's writes are
confined to `agents/<id>/apps/<appId>/` — never where the agent keeps its
instructions (`app-bridge.service.ts`). `files.propose` refuses `AGENT.md`,
`LESSONS.md`, `JOURNAL.md`, `AGENT.json` and the `knowledge/`,
`.checkpoints/`, `apps/` and `skills/` prefixes outright.

**Files served inert.** `GET /api/workspaces/:id/file` sets
`X-Content-Type-Options: nosniff` and forces `Content-Disposition:
attachment` for active content types, so an agent-written HTML file can
never execute on the API or SPA origin. In-app previews go through the JSON
`/preview` endpoint into a sandboxed iframe.

**The account boundary.** Every table carries `accountId`
(`docs/accounts.md` §3), and the Drizzle handle every repository injects is
account-scoped: selects, updates and deletes are fenced to the account bound
for the current async context, inserts are stamped with it, and a table takes
part the moment it has the column — a boot-time sweep adds it to tables that
lack it, and a reflection test fails when the schema half is forgotten. The
context is set by the auth guard per request and by each background sweep per
account it processes; webhook fires and inbound mail run under the account
that owns the agent, and a pairing code only pairs into the account that
minted it. The deliberate holes are small and named: `db.execute(sql…)` is
unscoped (its call sites key on random ids), and `unscoped(db)` exists for the
cross-account lookups that resolve an agent slug or a paired chat id to its
owner. In `AUTH_MODE=single` the boundary is still there with one account in
it. Sessions are random tokens stored as SHA-256 in an HttpOnly, SameSite=Lax
cookie; magic links are one-use, 15 minutes, rate-limited. Not yet: per-account
object-storage prefixes and Postgres RLS (`deployment.md` §2 layers 2–3).

**Sandboxed iframes with a real CSP.** Every iframe we render — mini apps,
chat artifacts, HTML and PDF previews — carries `sandbox="allow-scripts"`
*and* a `default-src 'none'` Content-Security-Policy injected by
`src/lib/sandbox.ts`. The attribute makes the frame opaque-origin; the CSP is
what denies network (`connect-src`, remote `script-src`, `img-src` beacons,
`form-action`, `base-uri`). Only inline script/style, `'unsafe-eval'` (for
WebAssembly and chart helpers; it cannot cross the boundary), and
`data:`/`blob:` media are allowed. The `window.yaam` bridge validates
`e.source` on every message, and the server re-derives every capability
grant from the stored manifest per call — the frame is never trusted to
report its own permissions.

**Code runner backends.** `run_js` / `run_python` (and the app bridge's
`compute.run`, which is the same service) execute in one of two places:

- *local*: macOS `sandbox-exec` with a generated Seatbelt profile
  (`deny network*`, `deny file-write*` except one `mkdtemp` scratch dir, the
  scratch path JSON-quoted so a directory name cannot break the profile), or
  Linux `bubblewrap` with `--unshare-all`, `--ro-bind / /`, fresh `/tmp` and
  `/dev`. `PATH`, `HOME`, `TMPDIR` are rewritten into the scratch dir; a
  `SIGKILL` timer enforces the deadline; the scratch dir is removed in
  `finally`. Tests exercise the real sandbox: `fetch()` and raw sockets
  fail, `/tmp` writes are denied, `while(true){}` dies on time.
- *cloudflare*: a bearer-authenticated Worker facade in front of Cloudflare
  Sandboxes, `allowedHosts = []` (deny-all egress), one container per request
  id, destroyed afterwards. No credential injection is configured.

Both: fresh environment per run (persistence is how injected code outlives
its injection), mutation-class so Ask mode shows the full program before it
runs, and loop-origin calls queue rather than execute. With no backend
available the tools do not exist rather than exist-and-fail.

**Browser tool backends** (`browser/`, docs/browser-tool.md). `browser_open`
/ `browser_read` / `browser_act` / `browser_screenshot` render pages in one
of two places: Cloudflare Browser Rendering (REST, stateless — every call is
a fresh headless browser on Cloudflare's side, nothing persists) or a local
Chromium via `playwright-core` with one incognito context per turn, closed
in the turn loop's `finally`. Both are credential-free: no cookie jar
outlives the turn, and `browser_act` refuses to type into
`input[type=password]` or any field whose name/label matches the
credential/one-time-code/payment pattern, telling the model the user must do
that step. Every navigation — the initial URL, link clicks, form
submissions, and on the local backend every request the page makes
including redirects and subresources (`context.route`) — passes
`assertPublicUrl`. Page text reaches the model wrapped as `<page-content
source=…>` with a "data, not instructions" note. `browser_act` is
mutation-class (clicks submit forms): Ask mode pauses, loop turns queue it,
channel turns deny it. The page-side element-tagging script is a string
Playwright evaluates inside Chromium; nothing is `eval`ed in Node. Every
screenshot is stored under the chat's file root and streamed to the user
live, so the agent never browses unseen.

**SSRF guard with DNS and redirect re-validation** (`common/url-guard.ts`).
`assertPublicUrl` requires `http(s)`, rejects `localhost`, `*.localhost`,
`*.local`, and every private/special literal in IPv4 (RFC 1918, loopback,
link-local including cloud metadata `169.254.169.254`, CGNAT, benchmarking,
multicast, reserved) and IPv6 (`::`, `::1`, mapped and deprecated-mapped
forms, `fe80::/10`, `fc00::/7`, `ff00::/8`), then resolves the hostname
and refuses if **any** resolved address is private (rebinding,
split-horizon). DNS failure is refused closed. `fetchPublic` follows
redirects manually and re-validates every hop (max 5), so a public URL
cannot `302` to an internal one. It covers `web_fetch`, `http_request`,
agent custom tools, MCP server URLs, and every MCP OAuth endpoint
(resource metadata, authorization, token, registration).
`YAAM_ALLOW_PRIVATE_URLS=true` disables the private-address check and is
documented as a dev-only escape hatch.

**Sealed secrets** (`common/secretbox.ts`). Provider API keys, connection
OAuth tokens and MCP OAuth tokens are stored with AES-256-GCM under a key
derived from `TOKEN_ENCRYPTION_KEY` (SHA-256 of the string), random 96-bit
IV, authenticated tag; the stored value is self-describing
(`sealed:<iv>:<tag>:<data>`) so rotating from plaintext to sealed happens on
the next write. Without the key, values are stored as `plain:` and
`AppModule` logs a loud boot warning. API responses never return a key:
`agent_types` rows are redacted to `hasApiKey: true|false`. Custom HTTP
tools carry no headers or keys by design — a secret inside an agent-authored
artifact is exfiltratable by construction.

**API boundary.** `TokenAuthStrategy` requires `Authorization: Bearer
<YAAM_API_TOKEN>` on every `/api` route when the token is set; only
`GET /api/status` (readiness) and `GET /api/security` (this policy) are
public. CORS is an explicit allowlist (`YAAM_CORS_ORIGINS`); requests without
an `Origin` header pass, which is correct for same-origin and server-to-server
and is why the token exists. A global `ValidationPipe({ whitelist: true })`
strips unknown body fields; the JSON body limit is 25 MB. Environment is
validated at boot with zod; production refuses to start on dev database or
S3 credentials.

**Organisations are policy in code, not in prompts.** An org run
(`server/src/org/`) is an ordinary turn with three extra walls: the task is
claimed by one `UPDATE … WHERE claimedBy IS NULL RETURNING`, so two members
cannot work the same item; the run's estimated cost is reserved against the
agent → project → company envelopes *before* the provider is called and the
run is refused with `budget_stop` when any level lacks headroom; and the
structure of the company — hires, scope widening, reporting lines, caps,
terminations — changes only through `org_approvals` rows that the user
decides via the controller, never through a tool or a message. A hire's
scopes are the meet of the chief's holdings and the request; a member starts
with no connections, no lessons and no loops. Each member's charter hash is
recorded on join and re-checked, so a charter edited outside the org path
shows as drift (the Carbonato lesson). Breakers fire without a model: the
same tool call three times ends the run, no-progress runs back off and then
block, review rounds cap at three and escalate. `POST /api/orgs/:id/pause`
is the kill switch (drops queued wakes, aborts in-flight runs through the
same `AbortController` a client disconnect uses) and `COMPANIES_ENABLED=false`
removes the routes, the tools and the wakes. Every structural change is a row
in the SHA-256 hash-chained `org_audit` table, verifiable with
`GET /api/orgs/:id/audit/verify`.

**Autonomous mode is a cap, not a blank cheque.** Since the company became
the workspace (`docs/group-chat.md` §5, `workspaces.orgMode`), the owner may
set a workspace to *autonomous*, and then the chief of staff's hire, reorg,
scope-widening, budget-allocation and termination tools execute without an
approval card. What bounds them is code in `OrgRuntimeService.execute`, not
the chief's charter: reporting depth ≤ 3, at most 5 direct reports per
member, members ≤ `orgAgentCap`, agent and project envelopes summing to at
most the company envelope `orgMonthlyUsd` (an envelope of 0 refuses every
allocation), a report's scopes never exceeding the chief's own holdings (the
meet rule, unchanged), no connection, memory or lesson inheritance by a hired
agent, and a required one-line `why`. Anything outside a cap is refused in
the tool result with the exact reason and is **not** queued, so a refusal
cannot be ratified later by another agent's message. Every executed action
writes an `auto_*` row in the hash chain with the reason, an inbox event on
the chief, a system line in `#company` and a line in the next brief. The
company envelope itself, the agent cap, the mode and the chief are the
owner's only (`PUT /api/workspaces/:id/org`); strategy, escalations and
outward actions still come to a human; `POST /api/workspaces/:id/org/pause`
and `COMPANIES_ENABLED=false` stop everything in either mode; and the
budget reservation before every run — including the chief's own structure
reviews — still hard-stops at 100%.

## d. The approval taxonomy as implemented

Every tool call in a turn gets one verdict from `checkPolicy`
(`chats/turn-loop.service.ts`), in this order:

1. **Unknown tool** (no owner recognises the name): `ask`, never remembered.
   Unknown names and malformed arguments are refused, not executed.
2. **Confirm-always**: `gmail_send`, `msmail_send`. Pause in host chrome on
   every call, in every mode — Auto mode and remembered approvals never
   apply. The card shows recipient, subject and body.
3. **Auto mode** (a per-chat opt-in): everything else runs (`auto`), subject
   to the loop and channel rules below.
4. **Read-only** (`read-only`): runs without asking in Ask mode. Read-only
   today means: `fs_list`, `fs_read`, `fs_search`, `web_search`,
   `web_fetch`, `browser_open`, `browser_read`, `browser_screenshot` (public
   web reads through the SSRF guard, no credentials to spend), every skill
   (invoking a skill only loads text), `list_tasks`,
   `search_history`, connection reads (`gcal_search`, `gcal_upcoming`,
   `gcal_freebusy`, `drive_search`, `drive_read`, `drive_export_*` and the
   `mscal_*`/`msdrive_*` equivalents), and the **proposal-only**
   tools `update_user_profile`, `draft_skill`, `save_tool`, whose entire
   effect is to queue something for human review — the gate is the review,
   not the call.
5. **Remembered** (`remembered`): the chat previously answered
   *allow-always* (exact arguments, keyed by `sha256` of the input) or
   *allow-tool* (any arguments) for this tool. Grants are per chat; nothing
   is inherited across chats or agents.
6. **Ask** (`ask`): everything mutating — `fs_write`, `fs_delete`,
   `slides_create`, `http_request`, agent custom tools, `run_js`,
   `run_python`, `browser_act` (a click or keystroke can submit a form),
   connection writes (`gcal_create_event`,
   `gcal_update_event`, `mscal_*_event`, `gmail_draft`, `msmail_draft`), the
   self-modification tools `update_dashboard` and `save_app`, and **every
   MCP tool** — the server behind an MCP tool is opaque, so MCP never
   auto-runs in Ask mode regardless of what it claims to be.

Two refinements on remembering: `SELF_MOD` tools (`update_dashboard`,
`save_app`) can be allowed once or for exact arguments but never blanket
*allow-tool*; and a pending approval auto-denies after 10 minutes or when the
client disconnects (`APPROVAL_TTL_MS`, the abort listener), so an orphaned
question never becomes a yes.

**Origin overrides the mode.**

- **The trust matrix** (`docs/actions-and-trust.md` §5, since item 28):
  in Auto mode and in every loop, heartbeat and org-run turn, the agent's
  trust level for the call's action class decides — act, act and notify,
  ask, hold for the owner's key, stage as a draft, or a second agent key
  on another model family — under the owner's ceilings and the
  `supervised` preset. The two paragraphs below describe the gates when
  the turn loop runs without the action contract (and channel turns,
  which always keep them).
- **Loop turns** (`origin: 'loop'`): connection mutations, both runner
  tools and `browser_act` are not executed at all, in any mode. They are recorded as an
  `action_pending` event in the agent's inbox with the exact tool and input,
  and the model is told to report what it queued. The user approves, runs
  or dismisses from the inbox (`action_done`, `action_failed`,
  `action_dismissed`).
- **Channel turns** (Telegram, email) and **app turns** (`agent.ask`): the
  session is created in Ask mode (`Telegram · <agent>`, `Email · <agent>`,
  `App · <agent>`) and the host answers every `approval_required` event
  with `deny` automatically. The agent is told to tell the user to run it
  from the app. Approvals can be given only in the app, so a hijacked
  phone, a spoofed mail or a hostile mini app cannot approve anything. An
  email reply is the turn's answer text only — no attachment, no forward,
  no second recipient; it goes back to the envelope sender of the mail that
  started the turn, threaded with `In-Reply-To`.

**Activation precedes execution.** A tool that is not activated does not
exist, whatever the mode: skill drafts are invisible to the model until
approved, custom tools land disabled and are re-disabled on edit, elevated
app capabilities park until reviewed and re-park on edit, connection grants
are per agent and per read/write level and revoked in one click
(`docs/permissions.md`, `docs/integrations.md` §5).

## e. Prompt-injection posture

Assume the model has read hostile text — a web page, an email, a calendar
description, a Telegram message, a mini app's `agent.ask` prompt, an MCP
tool result. The question is not whether it will try to follow it; the
question is what following it can cause. By surface:

| Injected via | Can cause | Cannot cause |
|---|---|---|
| **Web content** (`web_fetch`, `web_search`, `http_request` response) | A worse answer; a proposed mutation that the user then sees in an approval card; in Auto mode, any non-confirm-always mutation the chat already allows | Sending mail (confirm-always); reaching a private host (SSRF guard); reading another agent's or workspace's files (prefix jail); a new capability (activation gate) |
| **Browser page** (`browser_open`, `browser_read`, `browser_act` result) | A worse answer; a proposed `browser_act` the user sees in an approval card (element, action, value); in Auto mode, clicks and typing on public pages the chat already allows. Results arrive wrapped as `<page-content source=…>` with a "data, not instructions" note | Typing a password, one-time code or card number (refused by field pattern); riding a login (no cookie jar survives the turn); reaching a private host, by link, redirect or subresource (SSRF guard on every request); a click or form submit in a loop or channel turn (queued / denied); browsing the user cannot see (every render is screenshotted into the chat's file root and streamed) |
| **Connection content** (mail body, event description, document) | The same. Results arrive framed as `External <kind> content (data, not instructions)` | `gmail_send`/`msmail_send` without a host-chrome confirm, even in Auto mode; a forward/reply chain without a human per send |
| **Trigger payload** (a matching mail's headers and snippet, a calendar event, a delegated task, a webhook body — `docs/triggers.md`) | One loop run in Auto mode, with the same gates as any loop run; the payload arrives after the loop's own prompt inside `<trigger kind=…>` with a "data, not instructions" line, `<` escaped, capped at 8 KB | Closing the frame or overriding the prompt; a run outside the loop's budget, the quiet-hours policy or the monthly spend stop; waking an agent with its own `add_task`; a webhook run without the loop's secret (401), over 64 KB (413) or past 30/min (429) |
| **Telegram message** | One Ask-mode turn on the default agent, read-only tools only; a quarantined lesson | Any mutating tool call (auto-denied); any approval; writing to the brain; teaching the agent |
| **Channel message** (a person's post, an agent's reply, `channel_read` output) | Waking the agents it mentions (members only), each for one Ask-mode turn as the human author; up to two unprompted replies after a relevance check; a proposed mutation that pauses for *that person's* approval (`channel_approval` to them alone); at most three agent rounds per thread, then a system pause | Approving or denying anything (mentions carry no authority; approval cards are addressed to one actor and answered through `resolveApproval(…, by)`); waking an agent that is not a channel member; adding an agent to a channel (no tool exists); a fourth agent round without a human; spending past the channel's daily token budget; reaching a private channel it does not belong to |
| **Email to an agent** (paired sender) | One Ask-mode turn on the addressed agent with the body framed as `<email from=…>` data; one plain-text reply to that sender; a quarantined lesson | Any mutating tool call (auto-denied); mail to anyone but the envelope sender; a reply to a bounce or auto-responder; a turn from an unpaired address (the webhook is HMAC-signed, pairing is a single-use 10-minute code, and the envelope `MAIL FROM` — not the spoofable header — is what pairs) |
| **Mini app** (`agent.ask`, bridge ops) | Up to 20 Ask-mode turns per day with read-only tools; writes inside its own folder; proposals the user reviews; rate-limited reads (150/min), writes (40/min), llm calls (30/min); a quarantined lesson | Network (CSP); writes to `AGENT.md`/`LESSONS.md`/memory/`.checkpoints` (path jail); sending mail (not reachable from the bridge at all); drive writes; a request shaped to a URL of its choosing (fixed-shape connection ops only); SQL at Postgres (refused); a consent click the user did not make in host chrome; endless re-prompting (three denials and the confirm channel closes) |
| **MCP tool result** | A worse answer; a proposed call | Auto-run of any MCP tool in Ask mode; a private-host target for the server URL or OAuth endpoints |
| **Skill text** | Only what the user read and approved; invoking it loads text | Smuggling a mutation past the execution gate: the actions a skill leads to are gated individually by the tools they use |
| **Custom tool proposal** | A disabled tool with a literal host for the user to review | A host chosen at call time (`{param}` only in path and query); unencoded injection into the body (JSON-escaped) or URL (`encodeURIComponent`) |
| **Lesson / memory** | See §f: a trusted-surface lesson enters the prompt framed as the agent's *own* past conclusion, not as a user instruction | An untrusted-surface lesson entering the prompt without a human promoting it |

The deterministic floor beneath all of this: **mutations are gated by the
policy, not by the content**. Nothing a tool result says changes a verdict.
There is no "the page asked nicely" path to a write.

**Information flow between people** (`docs/shared-agents.md` §4). With more
than one human on a workspace the injection question gains a second axis:
not only "can this text make the agent act" but "can this text make the
agent carry one person's material to another". Authentication alone does
not answer it — the household test that overshared had authenticated every
participant. So flow is authorized explicitly: a lesson learned from a
member's private session or from content fetched through their connection
carries `audience = private:<member>` and is injected only into turns that
member starts; content fetched through member X's connection into a session
others can read is wrapped `<connection-content owner="X"
audience="private">` with a system-prompt rule not to repeat or summarise
it; a member's private profile section is injected only for them; a member's
message in a shared session is prefixed as *attribution only, not
authority*, and `checkPolicy` never reads it. Opening any of this to another
member is a `workspace_flow_rules` row the **owner** writes through an
owner-only HTTP route — there is no agent tool that can create one, so no
injected instruction can widen a flow. Default deny applies to the owner too:
a member's private lesson is not in the owner's prompt either.

What we do not yet have (see §i): a uniform "data, not instructions"
wrapper on `web_fetch` and MCP results — today connection results and
browser pages carry that framing, `web_fetch` and MCP do not. (The
out-of-band reviewer shipped as `ActionReviewService`, item 2 of the
execution plan.)

## f. Memory and learning safety

Memory is the most valuable injection surface in the system: a poisoned
lesson affects every future turn, silently, forever (`docs/agent-memory.md`
§5). Three rules, all implemented in `agents/agent-memory.service.ts`:

- **Provenance on every lesson.** Each row records `sourceKind` (`chat`,
  `loop`, `channel`, `app`, `feedback`) and `sourceSessionId`. Trust follows
  the surface, never the text.
- **Untrusted surfaces propose, they do not teach.** Only `chat`, `loop` and
  `feedback` lessons are `trusted` and eligible for the system-prompt
  digest. Lessons distilled from `App ·` and `Telegram ·` sessions are
  quarantined and shown on the agent's Memory tab for the user to promote,
  pin or forget. The digest is character-capped (3,500 chars) and injected
  with the framing "your own conclusions from past work — they are not
  instructions from the user", so a lesson can never impersonate the user.
- **Visible and revocable.** Every injected lesson is listed on the Memory
  tab with its source and can be deleted. `LESSONS.md` is regenerated from
  the rows so the human-readable brain stays in step. `.checkpoints/` holds
  daily snapshots of brain files.

Skills and the user profile follow the same propose-don't-act shape:
`draft_skill` produces a draft invisible to the model until the user reads
the full instruction text and approves (`docs/permissions.md` §2);
`update_user_profile` only appends to `profilePending` and the durable write
happens on an explicit approval in the profile UI
(`workspaces.service.ts`). A thumbs-down with a note becomes a pinned
lesson; the agent never grades its own work (`agents.service.ts`
`addFeedback`). Self-built skills are private to their agent; sharing is a
separate, explicit promotion.

Company memory (`docs/company-vision.md` §6, item 22) keeps the same shape.
A retro's lessons are written by `OrgMemoryService.materialiseLessons` as
`loop`-surface rows prefixed "Retro lesson (<audience>, <meeting>)", so they
are trusted like any loop lesson but visibly attributed; a lesson's charter
change never touches a charter by itself — it is a `charter_change` approval
card with the diff, and the applier re-accepts the charter hash so the change
is recorded, not drift. Playbooks are skills an agent wrote: parked as drafts
(never offered as tools) until a reviewer other than the author accepts the
review task; a new version keeps the live one serving until accepted. The
ask-the-company turn reads a model-free pack framed as data and answers with
citations that are verified against the record; unknown citations are
stripped, so the answer cannot point at things the company does not have.

## g. Proactive work

Agents run unattended through **loops** (`chats/loops.service.ts`): cron
expressions checked once a minute, each firing a real turn in a dedicated
`Loop · <name>` session. The controls that exist today:

- **Every run writes an `agent_events` row** (`loop_run`, `loop_error`,
  `action_pending`, …). Nothing unattended is silent; the inbox and the
  chat header are the audit trail.
- **Per-loop token budget** (`budgetTokens`) applied as the session's token
  ceiling and re-checked every round, not just at turn start; a budget hit
  stops the turn and writes a `loop_error` event naming the limit.
- **Per-loop model override** (`model`) so a heartbeat can run on a cheap
  model.
- **Background means queued**: outward mutations and code execution from a
  loop never execute directly (§d).
- `LOOPS_ENABLED=false` is a master switch.

Delivery of those events beyond the inbox (execution plan items 1 and 5):
the Telegram sweep, the email sweep or daily digest (`emailDigest`, off by
default) and the web-push sweep each own a delivered-at column on
`agent_events`, honour `deliverAfter`/`silent` from quiet hours, and never
echo channel-born events back to a channel (`docs/channels.md`).

## h. What we never do

Grounded in `docs/competitor-gap-analysis.md` §(c), these are refusals, not
backlog items. If a future change needs one of them, this document changes
first and says why.

- **No shared per-user computer, and no ambient host access.** Agents have
  no shell and no filesystem of their own; isolation is the architecture,
  not a setting. The one way to a real machine is the user's own, explicitly
  paired companion (`docs/computer-control.md`): outbound-only, scoped by
  the user at the keyboard, every action approved in the app with the
  acting tools never auto-approvable, audited, revocable in one click. There
  is no server-side computer, no computer shared between agents, no inbound
  port, and no action from a loop or channel turn. If a browser tool lands it
  is per-run and credential-free, never a persistent desktop. A sandbox
  backend never skips the Ask gate.
- **No autonomous memory writes without provenance.** Nothing enters the
  prompt from a surface the permission model distrusts without a human
  promoting it, and nothing enters the profile without a human approving
  it. We do not add an `auto` option for either, because defaults are what
  users run.
- **No memory the user cannot see or delete.** Every lesson and profile
  entry is on a tab with a delete button. No channel, app or routine writes
  memory outside that view.
- **No enumerable share links.** When sharing ships, links are
  capability tokens or authenticated on a single origin, revocable, never a
  subdomain per share, never indexed.
- **No plaintext secrets as the design.** Secrets are sealed at rest when a
  key is configured and redacted in every response; the `plain:` fallback
  exists only so local development works with zero setup and announces
  itself at boot.
- **No self-graded skills.** Skills are approved by a person who read them;
  ratings are the user's, attached to the turn.
- **No silent background spend.** Loops have budgets enforced before the
  call, every run is an event, and the model used is visible on every turn.
- **No agent-set caps on agents.** In autonomous organization mode the chief
  of staff acts within depth, fan-out, member and envelope caps the owner
  set; no tool can raise a cap, change the mode, pick the chief or widen
  beyond the chief's own holdings, and a refused action is never queued for
  later approval.
- **No training on user data.** With bring-your-own keys we see no model
  traffic at all; this stays true when platform-metered access arrives.
- **No credentials inside agent-authored artifacts.** Custom tools carry no
  keys; a future vault binds a named credential at activation and injects it
  server-side, never visible to the model.

## i. Known gaps and limitations

Honest list, as of this writing. Several map to execution-plan items.

- **Computer control trusts the user's machine and the OS tools on it.**
  `shell` is the user's shell with the user's permissions; `input` types into
  whatever has focus; a screenshot is untrusted content the model reads. The
  gates are the per-call approval, the scopes and the audit — not a sandbox.
  Linux and Windows companion back-ends are implemented from documentation
  and untested; the work queue is in-process and one companion per server
  (`docs/computer-control.md` §7–8).
- **Single-user mode is unauthenticated by default.** With
  `AUTH_MODE=single` (the self-hosting default) and no `YAAM_API_TOKEN`, the
  API accepts every caller as the one local account — acceptable only bound
  to localhost. Tenancy itself shipped (`docs/accounts.md`, section c above);
  the hosted deployment runs `AUTH_MODE=accounts`. Still open there: no
  per-account object-storage prefixes, no Postgres RLS, and the hosted
  ceiling is checked at turn start rather than mid-turn.
- **No independent action review.** Gates are deterministic; nothing
  compares a proposed `gmail_send` to what the user asked for, and there is
  no sensitive-information check on outbound content (plan item 2).
- **Framing is uneven.** Connection results are wrapped as "data, not
  instructions"; `web_fetch`, `web_search`, `http_request` and MCP results
  are not.
- **Sandbox strength depends on the backend.** The local runner relies on
  the OS (Seatbelt on macOS, bubblewrap on Linux) and on an interpreter it
  does not control; the Cloudflare backend relies on Cloudflare Sandboxes'
  container isolation. Neither has had an external review.
- **No formal audit, pen test or bug bounty yet.** This document and the
  test suite are the current evidence.
- **The `plain:` secret fallback exists.** A hosted deployment that forgets
  `TOKEN_ENCRYPTION_KEY` stores tokens unencrypted; the only guard is a boot
  warning.
- **`YAAM_ALLOW_PRIVATE_URLS` is a full SSRF bypass** when set. It is a
  documented dev switch; nothing stops it being set in production.
- **Rate limits and budgets are in-process memory.** App daily ask
  budgets, bridge rate windows and the approval registry reset on restart,
  and will need shared state for multi-replica cloud.
- **Telegram is one paired chat with no message signing beyond Telegram's
  own transport.** The bot token is the trust root; pairing codes are
  10-minute, single-use.
- **Email pairing trusts the envelope sender.** `MAIL FROM` is far harder
  to spoof than the header `From`, and the forwarder reports it, but a mail
  provider that does not enforce SPF/DMARC on inbound could still be
  tricked. The blast radius is one Ask-mode turn and a reply to the spoofed
  address — never an approval. The HMAC webhook secret is the trust root for
  inbound; the sending API token for outbound.
- **Web push payloads are encrypted end to end (RFC 8291) but the push
  service sees timing and size.** Titles are an agent name and an event
  title; bodies are capped at 240 characters.
- **MCP servers are trusted to be honest about their tool schemas.** We gate
  every call, but a malicious server's results are untrusted text with no
  wrapper (see framing above) and `stdio://` servers are deliberately
  unsupported.
- **`'unsafe-eval'` and `'unsafe-inline'` are in the iframe CSP** by
  necessity (single-file apps, WebAssembly). The wall is the opaque origin
  and the denied network, not the script policy.
- **Loop budgets are tokens, not dollars, and per loop, not per workspace.**
  There is no workspace-level hard stop and no quiet hours yet (plan item 1).
- **No signed audit log.** `agent_events` is the record of unattended work;
  it is a normal table the operator can edit.

## j. Reporting a vulnerability

Email **`security@<your-domain>`** — the operator of a deployment sets the
real address with `SECURITY_CONTACT` in the environment, and it is published
by `GET /api/security` and in Settings. If you are reading this on the
repository and no deployment-specific address is set, open a private
security advisory on the GitHub repository instead of a public issue.

Please include: the affected surface (API route, tool, bridge op, channel),
steps to reproduce, and what an attacker gains. Do not include real user
data or credentials you may have encountered; describe them.

**What to expect:** acknowledgement within **3 business days**, an initial
assessment within **10 business days**, and a fix or mitigation plan for
confirmed issues within **30 days** of acknowledgement, with credit in the
changelog below if you want it. We will tell you when the fix ships.

**Safe harbour.** Good-faith research against your own deployment or a test
instance — including reading this document and probing the behaviours it
describes — will not be met with legal action by the maintainers, provided
you avoid accessing or modifying other people's data, do not degrade a
service others depend on, and give us a reasonable window before public
disclosure. Testing against a hosted instance you do not operate requires the
operator's permission.

## k. Changelog of security-relevant changes

From `git log`, newest first. Dates are commit dates.

| Date | Commit | Change |
|---|---|---|
| 2026-11-02 | evals | The self-modification boundary as data (plan item 31): every self-change path consults one table; agents get a card for propose-changes in every mode, are sent to `org_propose_experiment` for experiment-changes, and are refused never-changes, which open a critical finding and a minor incident. Decision cards default to deny unless they are reversible and money-free. Delegations are the owner's, never cover the floors, and are audited. Eval replays run record-only in a sandbox within a USD cap and block a regressing rollout (`docs/boundary.md`, `docs/evals.md`, `docs/owners-seat.md`) |
| 2026-11-02 | experiments | Experiments, prediction ledger and reconciliation (plan item 30): changes are applied only within their bounds and governed by mode; revert recipes are taken before the change and run automatically on harm or an inconclusive result; verdicts and forecast scores come only from samples, runs and recorded results; calibration can only hold back a trust promotion; a daily claimed-versus-measured sweep raises signals and minor incidents and feeds the auditor's sample. No public routes (`docs/experiments.md`) |
| 2026-11-02 | incidents | Incidents and degradation (plan item 29): `org_incidents` with model-free detection, severity-tiered narrowing containment recorded for undo, one owner event, the `incident` postmortem trigger and `emitOrgIncident`; frozen action classes; provider failover to another family with parity (same tools, memory and prompt) and a recovery probe; degraded connections refusing only their own actions and skipping their polls with one signal; the CEO's spot checks of the auditor with precision/recall, auditor rotation, and record-only red-team runs whose sandbox intercepts every call before any executor (`docs/incidents.md`) |
| 2026-11-02 | sensing | Sensing and executable acceptance (plan item 27): metric sources with provenance-stamped samples that agents can never write or activate (`metric_source` approval in both modes), secret headers sealed and referenced by name, SSRF-guarded https-only fetches, a token-authenticated public ingest route (`POST /api/metrics/:sourceId/ingest`), key results whose value comes only from their source, model-free task checks that can accept work or return it as a review round but never accept by erroring (`docs/sensing.md`) |
| 2026-11-02 | trust | Action contract and trust ledger (plan item 28): every non-read call classed by reversibility (unknown → `external_reversible`), idempotency keys with replay of succeeded outward calls, staging (`gmail_send` → draft, promoted on a key), outbound rate limits per channel and class with money off by default, two-key execution for irreversible and money calls (owner/CEO key or a different-family agent co-signer, single-family flagged, failing closed), per-agent per-class trust levels under owner ceilings with automatic demotion on incidents, reverts and rejection streaks, `supervised` as a ceiling preset; every level change audited (`docs/actions-and-trust.md`) |
| 2026-11-01 | capital | Capital (plan item 23): plan preview with a veto window before autonomous structural change (`org_plans`, applied through the tools' own paths with caps re-checked, vetoable, dry runs apply nothing), model routing by task class with the CEO's agent pin always winning (`routing_set` decision rows, a `routing` approval kind), allocations per objective, a model-free burn forecast signal and a replay of any day with the chain segment verified (`docs/company-vision.md` §7–§8) |
| 2026-11-01 | memory | Memory (plan item 22): playbooks as parked skills gated by a reviewer ≠ author, postmortem retros with model-free agendas and a per-ref cooldown, retro lessons as attributed `loop` rows, `charter_change` approval cards with the diff applied through `acceptCharter`, decision-log rows for every approval and autonomous action, ask-the-company as a read-only restricted chief turn (`RunCtx.aux`) with verified citations and a USD cap, the model-free knowledge graph (`docs/company-vision.md` §6) |
| 2026-11-01 | blueprints | Blueprints (plan item 24): `COMPANY.json` v1 with a strict validator (size, roles, depth, fan-out, unknown fields, invisible unicode) on every door, data-only import (no code, connections, grants, memory, files; connection scopes dropped and recommended; playbooks as drafts; tunables clamped), one `blueprint` approval card for supervised staffing, registry kind `company` through the same scan and two-step install, opt-in anonymous outcome counters (`shareBlueprintOutcomes`, `POST /api/registry/public/:id/outcome` public), `employee` human role with addressed task events and `human_review` cards decided only by the addressee or the CEO (`docs/blueprints.md`) |
| 2026-11-01 | assurance | Assurance (plan item 20): model-free `org_signals` deduplicated per day and routed to owner / lead / chief / CEO, SLO samples and `slo_breach` signals, the auditor role as a read-only run (`restrictTo` filter in the turn loop, budget cap, different-family selection or a `single-model audit` flag), findings as signals, per-org tunables clamped to code-level bounds (`docs/company-vision.md` §1b, §5) |
| 2026-11-01 | units | Units (plan item 17): `org_units` derived from the reports-to tree, unit channels whose membership the server keeps equal to the chart (lead + reports + CEO/board; no tool changes it), unit-scoped lead tools refused outside the unit, `#goal:` references as data (a mention entry that notifies nobody) (`docs/group-chat.md` §7) |
| 2026-11-01 | groupchat | Group chat (plan item 15): channels with membership-gated `channel_post`, wakes as the human author in hidden Ask-mode sessions (`runAs`), unprompted replies behind a cheap relevance check and hard bounds (rate, two per message, no reply-to-reply, daily budget), 3-round agent chain cap with a system pause, approvals addressed to the poster (`channel_approval` + addressed inbox event), mention notifications as addressed events with deep links, private channels invisible to non-members, no membership tool (`docs/group-chat.md`) |
| 2026-11-01 | this | Organization mode on the workspace (plan item 16): `workspaces.orgMode off/supervised/autonomous`, 1:1 `organizations` row, workspace-scoped API and kill switch, autonomous chief executing hire/reorg/scope/budget/terminate only within code-enforced caps (depth, fan-out, agent cap, company envelope, meet rule, no inheritance) with refusals never queued, `auto_*` audit rows with reason, `#company` announcements through the Announcer seam, board-event and daily structure reviews reserved against budgets (`docs/group-chat.md` §5) |
| 2026-11-01 | shared | Shared workspaces (plan item 8, company phase D): invited members with roles acting inside the owner's account through `WorkspaceAccessGuard` (`X-Yaam-Workspace`, rebind + `checkRole`), hashed 7-day invite tokens bound to the invitee's verified address, per-member connection grants with initiator-based selection and no implicit cross-member use, approvals routed to the connection's owner as addressee-only inbox events (TTL-denied, invisible to others), lesson and profile audiences with default-deny `workspace_flow_rules` the owner alone writes, `<connection-content>` wrapping, attributed-not-authoritative messages in shared sessions, per-member channel pairings, `org_humans` with board/observer roles, `decidedBy` and human actors in the audit chain (`docs/shared-agents.md`) |
| 2026-11-01 | this | Desktop computer control: paired outbound companion, hashed companion token on four routes (`CompanionGuard`), user-chosen narrow-only scopes, every `computer_*` tool Ask-gated in every mode with acting tools never remembered, loop/channel refusal, `computer_actions` audit, Pause/Disconnect/`COMPUTER_CONTROL_ENABLED` kill switches (`docs/computer-control.md`) |
| 2026-11-01 | this | Autonomous company (plan item 14 A–C): atomic task claims, pre-call budget reservation with hard stop, approvals-only structural change, meet-rule scopes, charter drift detection, hash-chained `org_audit`, org kill switch and `COMPANIES_ENABLED` |
| 2026-11-01 | accounts | Tenancy: `accountId` on every table with a boot-time sweep and a reflection test, account-scoped Drizzle handle, per-request/per-sweep account context; `AUTH_MODE=accounts` with hashed one-use magic links, HttpOnly session cookies, link rate limits; plans with server-side 402 ceilings; experimental suite-JWT strategy |
| 2026-10-31 | this | Email channel (HMAC-signed inbound webhook, envelope-sender pairing, `<email>` framing, quarantined lessons) and web push (VAPID + aes128gcm on node:crypto); `POST /api/channels/email/inbound` the second non-GET public route |
| 2026-10-31 | browser | Credential-free, viewable browser tool: Cloudflare Browser Rendering / local Playwright, incognito per turn, password-field refusal, SSRF guard on every request, `<page-content>` framing, `browser_act` mutation-class and loop-queued |
| 2026-10-31 | this | `docs/security.md`, `SECURITY.md`, `GET /api/security`, `SECURITY_CONTACT` |
| 2026-08-02 | `8c844c2` | Auth guard behind a swappable `AuthStrategy` seam; `GET /api/status` the only public route |
| 2026-08-02 | `a1456db` | Memory with provenance: lessons table, trusted vs quarantined sources, visible and revocable digest |
| 2026-08-02 | `5e7bc15` | Mini-app connections by fixed shape (no app-shaped requests), compute over the sandboxed runner |
| 2026-08-02 | `57ef204` | Per-app bridge rate limits (sliding window per op class) and read provenance |
| 2026-08-02 | `befe9fc` | Iframe sandbox sealed: `default-src 'none'` CSP on every frame, PDF preview sandboxed, full skill text at hire review, JSON-escaped custom-tool bodies, denial quota on confirms |
| 2026-08-02 | `e152db3` | Tier-1 code execution: Seatbelt/bubblewrap local sandbox and Cloudflare Sandboxes, mutation-class, loop-origin queuing |
| 2026-08-01 | `fd4137f` | Provider API keys sealed at rest with AES-256-GCM (`secretbox`) |
| 2026-08-01 | `021b108` | Real SSRF guard: literal IP forms, DNS resolution checks, redirect re-validation, MCP and OAuth endpoint coverage |
| 2026-08-01 | `713157a` | Optional bearer auth (`YAAM_API_TOKEN`), CORS allowlist, inert file serving (`nosniff`, attachment for active types) |
| 2026-08-01 | `b57d67a` | Fail-fast env validation; boot warning when the encryption key is missing |
| 2026-08-01 | `b51b3db` | Outbound provider and MCP fetches bounded by timeouts |
| 2026-08-01 | `a9634eb` | Approval TTL auto-deny; client disconnect aborts the turn |
| 2026-08-01 | `e61a5d3` | MCP OAuth 2.1 client (PKCE, discovery) |
| 2026-08-01 | `07ddcc7` | Calendar write tier; loop-origin connection mutations queue as `action_pending` |
| 2026-07-18 | `60bcf17` | Permission model for agent-built things: skills as drafts, custom tools disabled until reviewed with literal hosts, SELF_MOD tools excluded from blanket grants |
| 2026-07-17 | `8610f27` | Tool loop with Ask/Auto approvals: read-only auto-runs, mutations pause, remembered grants per chat |
