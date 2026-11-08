# Work tracking: bets, projects and tasks

*Status: built (migration `0060-work-tracking`). Design source:
`reports/Work tracking for agent companies.md` ("Recommended model" and
"Views"); the audit it rests on is
`research_notes/Work tracking for agent companies/yaam_current_state.md`.*

The CEO of an agent company has to answer five questions from data: what
are we working on and why, what is at risk, what needs me, what got done,
and when will X land. Before this change none of them could be answered:
no task linked to a goal, agents kept a second task list beside the board,
"blocked" was written five ways, three quarters of the board was
retro-generated work about work, and "done" had no timestamp. This page
describes the model that replaced it, the mechanisms that keep it honest,
and the views built on it.

## 1. The model: one work graph with three levels

What the graph builds toward is aligned first: an agent's vision, strategy,
objective, key result or project bet is classified and, where it needs it,
aligned with the CEO before tasks are created under it; operating work and
capped discovery are exempt (`docs/alignment.md`).


```
vision → objective → key result      (org_goals: intent, docs/company-vision.md §2)
                          │ 1..n
                       project        (org_projects: the bet, one lead, an appetite, a health stream)
                          │ 1..n
                         task         (org_tasks: one owner, a four-field brief, checklist steps)
```

### Key result

Unchanged in storage (`org_goals`, `kind = key_result`). What changed is
its status rule: **a low confidence number alone no longer turns a key
result amber** (`ragOf`, `server/src/home/home.service.ts`). RAG is red when
the KR is at risk (behind its pace by the tunable tolerance, owner lost,
check-ins overdue, confidence dropping twice in a row — `org-intent.service.ts`),
amber when behind its pace, green on pace, grey when there is no measure
yet. With most owners checking in below 0.5, "confidence < 0.5 ⇒ amber"
had made eight of ten KRs amber by construction. The worst owner-written
health of the projects that move the KR is shown **beside** its RAG on Home
(`HomeKeyResult.projectHealth`), never averaged into it: roll-ups hide red.

### Project (the required middle level)

`org_projects`, extended. Every field:

| Field | Meaning |
|---|---|
| `key` | `P-<n>`, per organization. Projects have their own short key; tasks keep their board's key (see "Keys" below). |
| `ownerAgentId` / `leadHumanId` | The one lead: an agent or a person. Without a named lead, a **Program Manager** (`role:ops-pm`, the member titled "Program Manager" with the fewest open projects) when the company has one, else the proposer. |
| `goalIds` (and `goalId` = the first) | The key result(s) it moves. Agents must name at least one; a person may leave it empty and the roadmap shows "No key result". |
| `brief` | `{ problem, hypothesis, done_when, mvp }` — the lean case in four lines. |
| `startDate`, `targetDate` | Calendar days. The target is optional; the forecast is shown beside it. |
| `milestones` | `[{ id, name, date, done, doneAt }]`. |
| `appetiteDays`, `appetiteUsd` | Shape Up's appetite: what the company is willing to spend, not an estimate. 0 = none set. |
| `lane` | `now` / `next` / `later` — the roadmap. |
| `status` | `proposed` → `shaped` → `active` (in Now) → `done` / `cancelled`; `paused`. |
| `health`, `healthReason`, `healthAsk`, `healthAt` | The latest owner-written health call (`on_track` / `at_risk` / `off_track`). |
| `hill` | Optional hill position 0–1 (0–0.5 figuring it out, 0.5–1 making it happen). Without one the page infers a dot from task states and labels it "inferred". |
| `updateCadenceDays` | Per-project override of the health cadence. |
| `breakerAt`, `appetiteWarnedAt` | The circuit breaker's state. |
| `kind` | `project`, or a system project: `unsorted` / `operating` (below). |
| `channelId` | The project channel `#p-<key>` (its lead and team), opened with the first team member. |
| `standupCron`, `standupNextAt`, `standupLastAt` | The project standup's cadence (below). |
| `unitId` | The lead's unit, for grouping. |

Health updates are their own table, `org_project_updates`: health, reason,
ask, narrative, hill, and a **diff computed, not written** — target date
then and now, scope (tasks total) then and now, tasks done since, spend
against appetite, blocked and aged tasks, milestones done since.

**System projects.** Each live unit has two, created on first use (and by
the migration):

- **Unsorted** — where a task without a project lands. Its unit head (then
  the chief) is asked to place it after `work.orphanGraceHours`.
- **Operating improvements** — where retro and postmortem actions land
  (`source = retro`). Its open tasks are capped by `work.operatingWipCap`:
  over the cap a new retro action is created unassigned in the backlog — a
  proposal, not a task anybody works. A seventeen-action retro becomes a
  short list of proposals with the top few in work.

System projects are always Now, owe no health updates and do not appear on
the roadmap's project rows (the roadmap lists them separately).

### Task

`org_tasks`, the only company task system. New fields:

| Field | Meaning |
|---|---|
| `projectId` | Required in practice: the placement rule (`OrgProjectsService.place`, bound into `OrgTasksService.create`) gives every task one — the one named, else its parent's, else its unit's Unsorted (retro work: Operating improvements). |
| `source` | `plan` · `meeting` · `retro` · `incident` · `escalation` · `agent` · `ceo` · `chat`, shown as a badge. Callers name it (meetings: `retro` for a retro, else `meeting`; the strategy card: `plan`); otherwise it is derived from `createdBy` (`deriveSource`, `work-model.ts`): a person → `ceo` (or `chat` from a channel message), the chief → `plan`, an `Escalation:` child → `escalation`, anything else an agent noticed → `agent`. |
| `blockedOn` | The one structured blocker (§3). |
| `steps` | The checklist: `[{ id, text, done, doneAt, dropped?, from? }]`. Steps have no status of their own, no key and no heartbeat. |
| `startedAt`, `doneAt`, `blockedSeconds` | The clocks (§2). |
| `wakeSig`, `wakeCount`, `nextWakeAt` | Heartbeat back-off state (§4). |
| `failSig`, `failRepeats`, `wakesPausedAt` | Circular-behaviour state (§4). |

### One task system (the kanban merge)

Company members no longer have a second board. **Decision:** the agent
kanban tools stay, and for an active member of an organization they act on
the org board (`KanbanBridge`, bound by `OrgProjectsTools` into
`TurnLoopService`), so every agent prompt, skill and habit that says
`add_task` keeps working and nothing is mirrored:

| Tool | For a company member |
|---|---|
| `list_tasks` | The member's org tasks (open, plus closed in the last week) with their steps. |
| `add_task` | A task the member owns in the backlog of its unit's board (placed in Unsorted unless `project` names one). With `task` — or inside a task run — a checklist step on that task instead. |
| `update_task` | Moves the org task: `doing` → in progress, `todo`, `blocked` (needs `reason`; `waitsOn` and `ref` for the structured blocker), `abandoned` → cancelled, `done` → **review** (company tasks finish through review). `step` ticks, unticks or drops a checklist step. An old kanban key that became a step ticks that step. |
| `delegate_task` | A backlog task owned by the named colleague (same company), plus an inbox event. |

Agents **without** an organization (personal workspaces) keep their own
board in `agent_tasks`, unchanged — it is their bookkeeping and never
appears in company counts. The prompt says which is which
(`turn-context.service.ts`, and the members' work-tracking section from
`OrgProjectsTools.contextFor`).

### Mentions: tagging on a task

People and agents tag the member or person who must act with `@Name` in a
task comment (and in a brief). Names resolve with the channel resolver
(`server/src/groupchat/mentions.ts` `mentionSpans`, unchanged: the longest
display name, any script, markdown-aware, handles such as `@editor-in-chief`,
a person's email local part) against everyone who might be tagged: the
workspace's agents and its people (the owner and the workspace members).
`TaskMentionsService` (`server/src/org/task-mentions.service.ts`, bound into
`OrgTasksService.comment` and the brief paths of `create` / `update`) does
the rest; the resolved mentions are stored on the comment
(`org_messages.mentions`, `[{ kind, id }]`, with `fromUserId` for a
person's comment — migration `0084-task-mentions`).

| Rule | |
|---|---|
| Who may be tagged | The company's live members and the workspace's people. A tag that resolves to an agent outside the company or a let-go member is **refused** with the reason ("X is not a member of Acme, so they cannot see ENG-12") on the comment route and `org_task_comment`; nothing is stored. Internal lines (review notes, `org_task_update` notes) leave such a tag out instead. Another workspace's agents are nobody here. |
| A tagged agent | Follows the task (`mentioned`) and is woken for it with reason `mention` through the org runtime, so every wake gate applies: a paused company or member, budgets (the reservation), the per-task session. Not woken: the author; the owner when the comment already woke it (the comment wake is the one wake); a closed task. The run is a **consulted** seat: the prompt names the task (key, title, status, owner), quotes the comment that tagged it and the recent timeline; it answers with `org_task_comment` and never claims, updates or takes the task over (no claim, no no-progress or circular-behaviour counting against the owner's task). It waits only for its own run on the task, not the owner's. |
| The ping-pong cap | An agent comment that tags another agent counts one round. Once more than `work.mentionChainCap` (default 3, a per-company tunable) rounds followed the last person's comment, a tag wakes nobody (the tool result says so, and the follow fan-out does not wake them either) until a person comments again. A person's tags never count. |
| A tagged person | Follows the task (`mentioned`) and gets one addressed inbox event — `kind: 'mention'`, title `ENG-12 · Writer mentioned you`, payload `{ link, from, orgId, taskId, messageId }` with the task's deep link (`#/ws/<id>/org/board?task=<id>`, which `app.openOrgTask` opens) — pushed through their pairings under the workspace's quiet hours (`deliveryFor(ws, 'mention')`). Their Following row shows "Needs you: … addressed you". |
| No double notify | The tagged are passed to the follow fan-out as `alreadyWoken` / `alreadyNotified` (and capped agents as `alreadyWoken`): a follower who is also tagged is woken or notified once, by the mention; everyone else hears of the comment as follow news. |
| Briefs | A tag new in a brief (on create, or added by an edit) is delivered like a comment's (titled "mentioned you in the brief"); a tag already there is not delivered again. Brief tags are never refused — an invisible one is left out. |

Agents tag with `@Name` in `org_task_comment` text or its `notify: [names]`
argument (resolved the same way; a name that names nobody is refused). The
built-in `org-member-workflow` skill (step 8b) says: tag the one who must
act or answer, never to broadcast; when tagged on a task you do not own,
answer there. In the SPA the task drawer's comment box autocompletes
members and people with their faces (`MentionBox`, `GET
/api/workspaces/:id/org/mentionables`), comments draw the server-resolved
tags as chips, and the Inbox and Home snippets draw `@names` of members and
people as chips; a tagged person finds the task under Inbox → Following.

## 2. Done is an event

`task_transitions` records every status change: from, to, actor, reason,
at. One helper writes it (`OrgTasksService.recordTransition`), called from
every path that changes a status — create, update, assign, claim, release,
review request, accept by review or by check, request changes, escalate,
dependency release. The same helper keeps the clocks on the task:
`startedAt` on the first move into claimed / in progress / review / done,
`doneAt` on every move into done (cleared on a reopen), `blockedSeconds`
when a blocked spell ends; leaving blocked clears the blocker and the
back-off.

Readers use it: Home's "tasks done since you were here" reads `doneAt`
(not "last touched while done"); the project page's throughput and the
forecast read the done transitions. `GET …/org/tasks/:taskId/transitions`
returns a task's history.

## 3. Blocked is one field

```
blockedOn = { kind, ref, reason, since, by, until? }
kind ∈ task | person | agent | manager | ceo | external | decision
```

It replaces the five legacy forms (blocker lines, an empty list with the
reason in a comment, a CEO escalation card, an `Escalation:` child task, a
kanban note). Rules (`OrgTasksService.normalizeBlock`, `routeBlock`):

- **The ask is required.** No task enters blocked without its reason.
- **`since` is set once** and changes only when the blocker itself changes
  (another kind or ref) — a comment no longer resets a blocker's age.
- **Routing** — whoever it waits on hears of it:
  - `ceo` → a decision card in Needs you (`escalation`; `ref` = the card);
  - `manager` → the owner's direct manager, resolved through decision
    routing (`OrgDecisionsService.routeDecision`, docs/owners-seat.md §7;
    bound as the board's `ManagerResolver`): an agent manager gets an inbox
    event; a person, or the CEO for the chief, gets a card the router places
    with them, and the blocker becomes `decision` on that card;
  - `agent` → an inbox event for that member (it reaches its heartbeat);
  - `person` → that person's queue (an addressed inbox event, and
    `…/humans/me/tasks` lists it under `waitingOnYou`); the owner's own
    account is the CEO: a card;
  - `task` → a dependency: the task joins `dependsOn`, waits, and moves to
    todo (with a wake) when that task is done;
  - `decision` → a pending card; deciding it unblocks the task with a wake;
  - `external` → recorded; the back-off re-checks it.
- `org_escalate` keeps working and writes the same field: its card is
  placed with the raiser's manager first, so the task blocks on that
  `decision` (or on the `ceo` when the card went straight there); the
  chain below the CEO writes `manager` / `agent` with the escalation task
  on that member's board.
- A legacy `blockers` line is still written beside it so old readers keep
  working; the board, Home and the agent status read `blockedOn` first
  (`blockerOf`, `agent-status.ts`).

## 4. Mechanisms (every threshold a tunable)

Every number below is a per-workspace tunable with a default and a bound
(`work-tunables.ts`, the one registry of `org-tunables.ts`); onboarding
derives starting values from the operating profile
(`deriveWorkTunables`, called by `chief-os.ts deriveOperatingSystem`): a
speed-valuing company gets a shorter update cadence and back-off, a rigour
or control culture more grace, an earlier appetite warning, a higher
forecast bar and more room for process improvements, an early company a
small meta-work cap, a people-first culture extend-by-default. The chief
tunes them with `org_tune`, the CEO in Settings.

| Tunable | Default | What it governs |
|---|---|---|
| `work.updateCadenceDays` | 7 | Days between a lead's health updates on a Now project. |
| `work.updateMissingGraceDays` | 3 | Days past the due day before the project shows **Update missing**. |
| `work.appetiteWarnShare` | 0.8 | Share of the appetite at which the lead must post. |
| `work.breakerDefaultExtend` | 0 | 0: a tripped project is cancelled by default (Shape Up); 1: extended. |
| `work.extendShare` | 0.5 | How much of the original appetite a manager may add alone. |
| `work.blockedBackoffMinutes` | 60 | First wait before an unchanged blocked task wakes its owner again; doubles. |
| `work.blockedBackoffMaxHours` | 48 | The longest wait. |
| `work.circularRepeats` | 2 | Same failed approach this many runs in a row → wakes pause. |
| `work.mentionChainCap` | 3 | Agent comments tagging another agent on one task since a person last commented, after which a tag wakes nobody ("Mentions"). |
| `work.operatingWipCap` | 3 | Open tasks in a unit's Operating improvements. |
| `work.orphanGraceHours` | 24 | Hours in Unsorted before the head (then the chief) is asked to place it. |
| `work.forecastMinSamples` | 8 | Done tasks needed before a forecast range is shown. |
| `work.nextTaskDelaySeconds` | 30 | Seconds after a task leaves a member's hands before it is woken for its next work (speed 10, a control culture 60). |
| `work.selfAssign` | 1 | Fitting unassigned backlog a member with nothing to do may take itself: 0 off (it asks its manager), 1 in its unit, 2 in its unit or the projects it works on (a control culture 0, clan / adhocracy 2). |
| `work.nextTaskMaxPerHour` | 6 | Next-work wakes per member per hour (a loop guard). |
| `work.chaseAfterHours` | 24 | Hours a task waits on its blocker before the owner is nudged to chase or escalate (speed 8, a control culture 48). |
| `work.headDelegation` | 1 | How a function head with reports treats execution work (anything not head-level: planning, reports, reviews, staffing, decisions, escalations — `isHeadLevelTask`): 0 like any member; 1 its task wake carries the delegate path, its heartbeat reviews its team's board, and it never pulls execution backlog for itself while a report has room; 2 also, fitting backlog on its unit's board goes straight to the best-fit report with room (a control or results culture 2, otherwise 1). |
| `work.delegationSignalTasks` | 2 | Execution tasks a head starts itself within the window, while a report sits idle, before a `delegation_gap` signal opens for it (a control culture 1, an early company 3). |
| `work.delegationWindowHours` | 24 | The window of that signal (speed 12). |
| `work.headReviewsReports` | 1 | 1: a report's finished task is reviewed by its head (its line manager, when that is not the chief); 0: by a member of another model family, as for everyone else. |

**The bet.** Moving a project to Now is the CEO's decision. An agent's
request — `org_create_project` with lane now, or `org_update_project` to
now — becomes a `project_now` card (boundary row `project_bet`, verdict
propose); approving it moves the project to Now, starts it and tells the
lead. An agent's project starts `proposed` (or `shaped` once its brief and
appetite are filled) in Next or Later. Killing a Now project is a
`project_kill` card. A person (the CEO, a board member) changes lanes
directly.

**Health cadence.** A Now project's lead owes a health update every
`work.updateCadenceDays` (or the project's own cadence): on track; at risk
with its **ask** (the support needed and from whom); off track with its
**reason**. "Unknown, still investigating" is a legitimate reason. From the
due day the lead's heartbeat says so; past the grace the project shows
**Update missing** on the CEO's surfaces and the chief's heartbeat lists it
to chase. The chief drafts the diff; the lead owns the call; the lead's
call is always shown beside the signals the lead cannot edit (progress,
blocked count, appetite used, forecast) so a watermelon is visible.

**Heartbeat back-off.** A blocked task wakes its owner when its blocker
changes — the dependency's status, the decision card's status, a new
comment from anyone but the owner — otherwise after
`work.blockedBackoffMinutes`, doubling up to `work.blockedBackoffMaxHours`.
The first sight of a new blocker only arms the timer. The re-check belongs
in the run log, not on the task. A personal agent's kanban backs off the
same way without state: a blocked item wakes when the time since it was
blocked crosses base × (2^k − 1) after the last heartbeat run
(`blockedBackoffDue`, `heartbeat.service.ts`; base = four staleness
intervals).

**Pull next** (`OrgNextWorkService`, `org-next-work.service.ts`). When a
task leaves its owner's hands — done or accepted, sent to review, cancelled
or abandoned, blocked by the owner — or a reviewer finishes a review, the
member's pull is scheduled `work.nextTaskDelaySeconds` later (one per
member; finishes inside the window coalesce; a run still going re-arms it).
Every heartbeat beat runs the same pull first. It is model-free and walks
the member's queue in order, waking it (an ordinary task run, wake reason
`next`; reviews keep `review`) for the first item it can act on:

1. a **review it owes**;
2. its own to-do that was **just unblocked** (the last move came from
   blocked or waiting);
3. its own **to-do**, ranked by project lane (Now first; system projects
   count as Now), urgency (overdue, due within `capacity.dueSoonHours`),
   due date, project rank, age — claimed only when the claim gate allows:
   the WIP limit (`capacity.wipPerMember`), unmet dependencies, a paused
   task, a tripped appetite breaker;
4. with nothing of its own, **unassigned backlog that fits**: in its unit
   (the one it leads or reports into) or a project it works on (leads, or
   holds a task in), matching its role (title, role, charter and the
   catalog role's competencies against the task's title, outcome and
   class) or on a project it works on; never in Operating improvements, a
   project that is not active, or one whose breaker tripped. Under
   `work.selfAssign` it takes it itself (an assignment by `agent:<id>`, so
   the ordinary assignment wake runs it); otherwise it asks its manager —
   a comment on the task and an inbox event for an agent manager — at most
   once a day per task;
   a function head with a report that has room never takes execution
   backlog for itself (`work.headDelegation` ≥ 1): it delegates it, and at
   2 backlog on its unit's board goes straight to the best-fit report with
   room (audited `next_work_delegate`);
5. **nothing at all** → nothing: no wake, no model call.

It respects the org's and the member's status, quiet hours, the spend stop,
the agent and company envelopes, and `work.nextTaskMaxPerHour`. **No double
wakes:** a wake already queued for the member (assignment, comment, review,
dependency, approval, an @mention) or a run in flight skips the pull, and when the
heartbeat's pull queued a run the plain to-do lines leave its reasons. **No
loops:** the task that just left the member's hands is not pulled for ten
minutes; breaker blocks (the system blocking a task: loop, no progress,
budget stop) schedule nothing; a member never takes back backlog it gave
up; a task already self-assigned twice is left to a manager (no ping-pong).

**Blocked work on the heartbeat.** Each beat re-checks the member's
blocked tasks without a model. The wake signature itemizes what the
blocker waits on — the dependency's status, the decision card's status,
replies from whoever it waits on (the member, or a person) and comments
from anyone else since it was blocked, whether its expected date
(`blockedOn.until`, `expectedBy` on `org_task_update`) passed, whether it
waited past `work.chaseAfterHours`. A change wakes the owner with
"blocker changed: …" naming exactly which; crossing the chase threshold
wakes it once to chase the blocker's owner (`org_task_comment`,
@mention) or escalate through its manager, and to pick up other work
meanwhile; nothing changed keeps the back-off. A new blocker the owner set
only re-arms the timer.

**Your next work.** The member's heartbeat prompt carries a section with
the top three next items (newly unblocked first) and why, and its blocked
or waiting tasks with what they wait on and since when.

**Circular behaviour.** A run that fails or makes no progress leaves the
signature of its approach (the tool calls and the error). The same
signature `work.circularRepeats` times in a row pauses the task's wakes —
no claim, no continuation, no heartbeat line — and flags the lead (the
project's lead, else the owner's manager, else the chief) with an inbox
event; the lead's heartbeat lists it. A comment from someone other than the
owner, a reassignment or an edit by someone else lifts the pause.

**Appetite circuit breaker.** Spend per project is the sum of its tasks'
runs (`org_runs`); time used is days since its start. At
`work.appetiteWarnShare` the lead is asked for an update. At 100% (of
either) the breaker trips: new task claims in the project pause (the claim
gate, `OrgProjectsService.claimGate`) and a decision — **extend, cut
scope or kill** — goes to the lead's manager chain:

- who decides is decision routing's answer for the lead (`routeDecision`);
- the lead's manager is an agent → an `Appetite reached:` decision task on
  that manager's board (source `escalation`; it is not gated). The manager
  decides with `org_project_appetite`: extend within `work.extendShare` of
  the original appetite applies at once (boundary row
  `project_appetite:within`); more, or a kill, is a card for the CEO;
- the lead is the chief, reports to a person, or to nobody → a
  `project_appetite` card raised by the lead, which the router places with
  that person or the CEO. Approve extends; reject kills
  (cancels the project and its open tasks); revise cuts scope (a small
  extension, and the lead is told to cancel or move out what does not fit).

Not straight to the CEO unless the lead is the chief: the manager chain is
the default, as for every other decision.

## 5. Views

**Roadmap** (Company › Direction › Roadmap, linked from Home). Two modes:

- **Timeline** — rows are projects grouped by objective → key result (or
  by unit); bars run from start to target date, milestones are diamonds,
  a line marks today, the bar fills with progress (done ÷ total tasks) and
  takes the health colour; budget used and a tripped breaker are marked;
  zoom by month or quarter. **No drag editing** on the timeline: dates are
  owner-approved edits made on the project page, so a stray drag can never
  move a commitment.
- **Now / Next / Later** — three lanes of project cards: lead, health with
  its reason, update freshness, progress, appetite used, hill position, the
  forecast range (or "not enough history"), the key results.

**Project page** — brief, key results, lead, dates and milestones, progress
and the hill, health history with the computed diffs, budget burn, the
forecast range, tasks grouped by status with source badges and blockers,
the blockers list, decisions (cards and decision-log rows that touched the
project or its tasks), files (the tasks' file scopes).

**Forecast.** A Monte Carlo over weekly throughput (done events per week
in the last eight weeks; 1 000 runs; 50th and 85th percentile dates). With
fewer than `work.forecastMinSamples` done events the page says "not enough
history" instead of a range; with too little project history it uses the
company's throughput and says so. It assumes comparably sized tasks.

**Home** (`docs/home.md`) — the **portfolio** for the CEO as a roadmap
snapshot: the lanes in one line, the Now projects (`nowProjects`) as rows
with health, flags and their reason or ask, progress and target date, then
projects flagged outside Now (off track, update missing, at risk, over
budget, late, a tripped breaker); with nothing in Now, one line and
**Propose a bet**. The "since you were here" block carries the digest of
project changes (health calls, lane moves, breakers, milestones, done) and
done-by-project from `doneAt`.

**Unit boards** keep working, filterable by project; cards show the project
key and a source badge; the drawer shows the steps, the structured
blocker and lets a person move the task to another project.

**Pending changes.** The pane that used to be called "Plans" (veto-window
change batches, `org_plans`) is now **Pending changes** in the UI, so
"plan" and "roadmap" mean the model above. API names are unchanged.

### Project teams (cross-functional, 2026-11-04)

A project is staffed as a **matrix**: one owner (a Program Manager by
default) and a **team** drawn from any unit. A member keeps its home unit and
its head — the head stays accountable for its people — and the project
borrows a share of its time. `org_project_members` (migration 0087):
`projectId`, `agentId` or `humanId`, `role` on the project (engineer,
designer, analyst, …), `allocation` (percent of the member's time),
`status` (`active`, `pending`, `left`), `approvalId`, `addedBy`, `joinedAt`,
`leftAt`. Served by `OrgProjectTeamsService`
(`server/src/org/org-project-teams.service.ts`).

- **Proposing a member** (`org_project_add_member`; the lead, its manager
  chain, the chief, or a person): the allocation is the **member's own
  manager's** decision. The tool writes a `pending` row and a
  `project_allocation` decision card that decision routing
  (`docs/owners-seat.md` §7) places with the member's manager —
  `payload.routeAsAgentId` routes it as if the member raised it, whoever
  asked. The authority table lets that manager decide it in any mode (its
  own report, within the cap). When the asker *is* that manager, the chief or
  a person (the CEO, a blueprint import), it applies at once. A rejected card
  drops the pending row.
- **Capacity:** a member's live (active + pending) allocations across open
  projects sum to at most **100%**; a proposal past it is refused with the
  member's current total. The WIP limit (`capacity.wipPerMember`) still
  bounds its open tasks.
- **Assignment across units:** the project's lead assigns the project's
  tasks (`org_assign`, `org_create_task assignee` with `projectId`) to any
  **active team member**, whatever its unit — the allocation is the
  permission. A lead with an active team is offered `org_assign` even when it
  leads no unit. Work outside the project stays the member's head's.
- **Channel:** the first active member opens `#p-<key>` (the lead, the team,
  the CEO and board); members join and leave it with the team, and the
  channel carries joins, departures and the standups.
- **Standup cadence:** `org_project_standup` sets a five-field cron; the
  meetings machinery fires it (`OrgMeetingRuntime.addDueMeetings`) as a
  `standup` in the project channel with the team as attendees and the lead
  facilitating, its agenda the project's open tasks by member. A project
  with no open task skips its standup (audited `meeting_skipped`).
- **Views:** the project page shows the team — each member's role,
  allocation, pending state, home unit and head, total allocation and open
  tasks here — and its tasks across units are the project-scoped board
  (`page.tasks`). `org_project` and `org_project_team` give agents the same.
- **Blueprints** carry projects with their teams by role title
  (`docs/blueprints.md` §1b).

### Program management: the matrix (2026-11-04)

The owner: "Goals and projects should be assigned to [Program Managers],
then they will collaborate with heads to see what kind of resources are
needed. Each goal and project has its own cadence, managed by the program
manager. It's like a matrix management structure."

**What the audit found.** The project-team layer above existed (seats,
allocation cards, the project standup, a PM as the default project lead),
but at runtime nothing exercised it: in the dev company ("Real Jong") no
Program Manager had been hired, every objective, key result and project was
owned by the chief of staff without anything saying so, no project had a
team row, a standup or a health update, goals had no owner other than the
chief and no rhythm of their own, and nothing ran per goal or per project.
The chief's pack said to propose a PM "when two or more Now projects
compete" — two did, and nothing prompted it.

**The model.** Two axes. **Function heads own people and capacity** —
their unit, hiring, skills, the quality of their function's work. **Program
Managers own outcomes** — goals (objectives and key results) and projects
are assigned to a PM as the accountable owner (`ownerAgentId`). A PM may own
several; a small company has one, or none — then the **chief of staff is the
acting PM**, and every view says so (owner role `acting_chief`, "acting PM"
in the UI, "you act as Program Manager" in its briefing, a
`program_acting` signal once it holds two or more items while Now projects
compete). Served by `OrgProgramService`
(`server/src/org/org-program.service.ts`), model-free, every write audited.

- **Ownership.** `org_program_assign` (the chief; the current owner handing
  over; a person on `POST …/org/program/assign`) makes a member the owner of
  a goal or project; an objective's key results the previous owner (or the
  chief) held move with it. A company-level objective or key result the
  chief sets goes to the least-loaded PM at once when the company has one
  (a key result follows its objective's PM); when a PM joins (hired, or a
  member retitled), the items the chief was acting on are handed to the PMs
  by load. Audited `program_assign`; the new owner is told.
- **Resource requests** (`org_resource_requests`, migration 0089): for a
  project it owns the PM asks a head for a **role** (and skills), a **share
  of a member's time** (1–100%), a **window** (start/end), a **budget** and
  the **why** (`org_resource_request`). Name the member (its head — the
  holder decision routing gives — decides) or the head (it picks). The head
  answers within `program.requestAnswerHours` (`org_resource_decide`):
  **approve** (the member gets a project seat at once — `org_project_members`
  stays the allocation record, `OrgProjectTeamsService.grant`), **adjust**
  (another member, a smaller share, a shorter window — with the reason),
  **decline** (with the reason) or **hire** (it hires to fill, then
  approves with the new member). A head lends only its own line. The 100%
  cap holds. A head asking for its own people, or a person, is granted at
  once.
- **Escalation.** The PM escalates a decline, a cut or a slow hire
  (`org_resource_escalate`); an unanswered request climbs on its own at its
  answer-by time. Either way it is a `resource_conflict` card placed **as if
  the head raised it** (`payload.routeAsAgentId`), so decision routing puts it
  with the head's manager first (the chief), then the CEO — the authority
  table lets that manager decide it in any mode. Approved: granted as asked
  (the seat when a member was named, else back to the head as `granted` to
  fill). Rejected or sent back: the head's answer stands (`upheld`).
  Audited `resource_request`, `resource_decide`, `resource_escalate`; the
  feed's **Program** type carries them (and `program_assign`) to the owner.
- **Each goal and project has its own rhythm**, owned by its PM
  (`org_program_cadences`): a **goal review** per objective (its key
  results' pace and confidence, the projects that move them with their
  health and asks, the resources missing) and a **milestone review** per
  project (milestones, team and allocations, appetite), plus the project's
  **sync** (its standup, `org_projects.standupCron`). The PM sets each with
  `org_program_cadence` (a five-field cron) **within bounds the company's
  profile derives** — `program.syncMinDays`–`program.syncMaxDays` and
  `program.reviewMinDays`–`program.reviewMaxDays`, checked on the cron's mean
  interval. The default reviews (`program.reviewDays` at
  `program.cadenceHour`) are seeded **only for items a real Program Manager
  owns** — when it takes them over, and lazily for its older items; the
  project sync is never seeded (standups stay the owner's choice, as before
  the matrix). Items the chief owns as the acting PM get no seeded reviews
  and no review spend unless `program.actingRhythms` is 1 (derived 0), and
  their missing review is not counted stale (`deriveProgramTunables` in `program-tunables.ts`, called
  by `deriveOperatingSystem`: speed syncs twice a week and answers requests
  in hours; a control culture reviews formally and gives heads two days; a
  clan culture flags stretch at 75%). The reviews fire through the meetings
  machinery (`OrgMeetingRuntime.addDueMeetings`, so they run in a
  sub-channel of the objective's unit channel or the project channel) as
  `weekly_review` meetings the PM facilitates, attended by the key-result
  owners, project leads, the team and — for a goal review — the heads
  lending people; a review with nothing to review skips itself (audited
  `meeting_skipped`). Each closes with the PM's status: the project health
  update the roadmap reads ("Update missing") and the key-result check-ins.
  The **status update** (`work.updateCadenceDays`) and the **key-result
  check-in** (`checkInCadenceDays`) are shown beside them. A rhythm is
  **stale** when it is off, or when its output (the health update, the
  latest check-in) is older than `program.staleCadences` intervals.
- **Members serve two managers.** A member's briefing names its line
  manager ("your line manager: your capacity and the quality of your
  work") and each seat with its PM (`P-3 (engineer 40%, PM Pat)`); its
  standing note says which PM assigns which work. **Next work respects the
  allocation**: among equally urgent tasks a member lent to project teams
  works the bucket — each seat, or its home unit for the rest — furthest
  below its share of the work it started in the last week
  (`OrgNextWorkService`). A member allocated past
  `program.allocationWarnPct` is **stretched**: its briefing says so, and a
  `member_stretched` signal goes to its head and to the PM of each project
  it serves.
- **The hire trigger.** While the chief acts as PM for any active
  objective or project and no Program Manager hire is pending, its heartbeat
  prompts it to propose one through the normal hire path
  (`org_hire_agent role:ops-pm`, reporting to the Head of Operations or the
  chief; a card for the CEO in supervised mode) — at most once per
  `program.pmPromptDays` (the staffing-gap window, deduplicated through the
  audit log as `program_pm_prompt`). This is the trigger the audit found
  missing. When the PM joins it takes the items over, and their reviews
  are seeded then.
- **The chief** assigns PMs, acts as one when there is none, proposes the
  first PM hire, decides resource conflicts within its authority, and
  watches the matrix (`org_program`, its heartbeat and signals:
  `program_unowned`, `program_acting`, `member_stretched`, `cadence_stale`).
- **Views.** `GET …/org/program` is the matrix: every active objective,
  key result and project with its owner and owner role, rhythms (next
  occurrence, stale), team and live requests; every member with its line
  manager, unit, seats (and their PMs), what it owns, total allocation and
  stretch; the health counts and the bounds. The roadmap board and project
  page show the PM owner (acting PM for the chief), the rhythms and the
  requests waiting on heads; the goals pane the owner role and the goal
  review; Direction a program card; People a members × projects matrix.

## 6. Tools (agents)

| Tool | Who | Class |
|---|---|---|
| `org_projects`, `org_project` | every member | read |
| `org_create_project` | every member (proposes; Now is a card) | read (a proposal) |
| `org_update_project` | the lead, its manager chain, the unit lead, the chief | internal write; Now / kill / appetite beyond share are cards |
| `org_project_update` | the lead (the chief only for its own projects) | bookkeeping |
| `org_milestone` | the lead and up | internal write |
| `org_project_appetite` | the lead's manager chain | internal write within the share; else a card |
| `org_link_task` | the task's owner, its managers, either project's lead, the chief | internal write |
| `org_task_steps` | the task's owner | bookkeeping |
| `org_project_team` | every member | read |
| `org_project_add_member` | the lead, its manager chain, the chief | a proposal: the member's manager decides (a `project_allocation` card) unless it is the asker |
| `org_project_remove_member` | the lead and up, or the member's own manager | internal write |
| `org_project_standup` | the lead and up | internal write |
| `org_program` | every member | read: what you own, its rhythms, team and requests; the chief: the matrix and its health |
| `org_program_assign` | the chief; the owner handing over | internal write |
| `org_program_cadence` | the owner (PM), its managers, the chief | internal write, within `program.*` bounds |
| `org_resource_request` | the owner (PM), its managers, the chief | a proposal: the head decides |
| `org_resource_decide` | the head it is addressed to, its managers, the chief | internal write (a seat) |
| `org_resource_escalate` | the owner (PM) | a `resource_conflict` card to the head's manager |
| `org_create_task` `projectId` | — | takes a project key (`P-3`) |
| `org_task_update` `waitsOn`, `ref` | — | the structured blocker |
| `org_task_comment` `@Name`, `notify` | every member | tags a member (woken) or a person (notified) — "Mentions" above |

The Chief of Staff pack's `project-portfolio` skill runs the chase (orphans,
missing updates, breakers, the betting table) and never moves a project to
Now, extends an appetite or kills a bet itself; function heads' planning
skills propose a project per bet before creating tasks and post their
projects' health in their weekly report; the built-in `org-member-workflow`
skill tells members which tool is for what.

## 7. Routes

```
GET    /api/workspaces/:id/org/roadmap
GET    /api/workspaces/:id/org/portfolio?since=
GET    /api/workspaces/:id/org/projects                      raw rows (system projects included)
POST   /api/workspaces/:id/org/projects                      a person creates (default Now)
GET    /api/workspaces/:id/org/projects/:projectId           the project page (key, id or id prefix)
PATCH  /api/workspaces/:id/org/projects/:projectId
GET|POST /api/workspaces/:id/org/projects/:projectId/updates
POST   /api/workspaces/:id/org/projects/:projectId/milestones
PATCH  /api/workspaces/:id/org/projects/:projectId/milestones/:milestoneId
POST   /api/workspaces/:id/org/projects/:projectId/appetite  { decision: extend | cut_scope | kill, … }
POST   /api/workspaces/:id/org/projects/:projectId/tasks     { taskId } — move a task under it
GET    /api/workspaces/:id/org/projects/:projectId/team      the team (home units, allocations, channel, standup)
POST   /api/workspaces/:id/org/projects/:projectId/team      { agentId, role?, allocation } — a person adds a member at once
DELETE /api/workspaces/:id/org/projects/:projectId/team/:agentId
POST   /api/workspaces/:id/org/projects/:projectId/standup   { cron | null }
GET    /api/workspaces/:id/org/program                       the matrix (owners, rhythms, teams, requests, members, health, bounds)
POST   /api/workspaces/:id/org/program/assign                { ref, agentId, cascade? }
POST   /api/workspaces/:id/org/program/cadence               { ref, kind: sync|milestone_review|goal_review, cron | null }
GET    /api/workspaces/:id/org/program/requests
POST   /api/workspaces/:id/org/program/requests              { project, role, allocation, agentId?, headAgentId?, skills?, startDate?, endDate?, budgetUsd?, why? }
POST   /api/workspaces/:id/org/program/requests/:requestId/decide   { action: approve|adjust|decline|hire, agentId?, allocation?, endDate?, note? }
POST   /api/workspaces/:id/org/program/requests/:requestId/withdraw
GET    /api/workspaces/:id/org/tasks/:taskId/transitions
POST   /api/workspaces/:id/org/tasks/:taskId/steps           { add | done | undo | drop }
POST   /api/workspaces/:id/org/tasks/:taskId/blocked-on      { kind, ref?, reason } | { clear: true }
POST   /api/workspaces/:id/org/tasks/:taskId/comment         { text, notify? } — @mentions resolved; refused for someone who cannot see the task
GET    /api/workspaces/:id/org/mentionables                  who may be tagged: [{ kind, id, name, status }]
```

Writes need the CEO or a board member; a person who leads a project posts
its updates.

## 8. Migration (0060)

`0060-work-tracking` adds the columns and tables, then runs
`backfillWorkTracking` (`server/src/database/work-tracking-backfill.ts`),
idempotent step by step:

1. projects get a key, `goalIds`, a unit and (when active) the Now lane;
   every live unit gets its Unsorted and Operating improvements projects;
2. tasks get a source (an `Escalation:` child; a task whose thread is a
   meeting's → `meeting`, or `retro` for a retro; a person's → `ceo` or
   `chat`; the chief's → `plan`; else `agent`), orphans a project (retro
   work → Operating improvements, the rest → Unsorted), every blocked task
   a `blockedOn` read from its legacy form — and a CEO block written only
   in text ("User decision on …") gets the decision card it never had;
3. the status history is rebuilt from the audit log (task_create,
   task_update with a status, task_claim, task_assign, review_request,
   review_accept, review_request_changes, task_escalate, task_unblocked),
   then `startedAt` and `doneAt`;
4. **the kanban merge**: each company member's kanban item becomes a
   checklist step on the org task it mirrors — its key named in the item,
   or a title similar enough (token Jaccard ≥ 0.4) on one of the member's
   tasks — or else an org task of its own under the member's unit (in
   Unsorted), **keeping its kanban key** (keys are unique per workspace
   across both boards, so `TUL-1` stays `TUL-1`). The kanban row is kept and
   marked `mergedInto` (`task:<id>` or `step:<id>`), so nothing is lost and
   nothing merges twice; merged rows leave the agent's board. Personal
   agents' boards are untouched.

## 9. Keys

Tasks keep the unit board's prefix (`ENG-12`) — a key never changes when a
task moves between projects, and a project spans units. Projects have
their own `P-<n>` key per organization. See `docs/tasks-keys.md`.
