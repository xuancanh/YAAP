# Home: the owner's mission control

*Shipped 2 November 2026. It applies `docs/owners-seat.md` ("exceptions,
not approvals") to the first screen the owner sees.*

The product is a company of agents: a Chief of Staff, function heads and
specialists. The owner opens Home to find out four things, in this order:

1. Is anything on fire, and does anything need me?
2. What happened while I was away?
3. Are we on track?
4. Where do I go to look closer?

The landing page used to be the agent directory. The directory is still
there, as **All agents** (section `agents`, `?section=agents`).

Code:

- `server/src/home/home.service.ts` (`HomeService`), `home.controller.ts`, `home.types.ts`
- `server/src/home/agent-status.ts` (the per-agent status Home shares with
  the agent overview and the org mission control, `docs/mission-control.md`)
- `src/components/HomeView.tsx` (data, live updates, decisions, navigation)
- `src/components/HomeBoard.tsx` (the page, presentational)
- `src/lib/home.ts` (the copy and the link targets, pure)
- `server/src/home/home-activity.ts` (what a loop run did, routine runs
  collapsed, rituals merged; pure)
- tests: `tests/backend-home.test.ts`, `web-tests/home.test.tsx`,
  `web-tests/home-activity.test.tsx`

## One request

`GET /api/workspaces/:id/home` returns `HomeData`
(`server/src/home/home.types.ts`, mirrored in `src/lib/api.ts` and checked
loosely by `homeDataSchema` in `src/lib/schemas.ts`).

The endpoint owns no logic of its own. It reads from the services that
already own each fact:

| Section | Source |
|---|---|
| Needs you | `OrgApprovalsService.pending` held by the CEO (decision cards, with `chain` when a card climbed through managers, docs/owners-seat.md §7), `OrgCapitalService.plans('pending')`, `ActionsService.list('held' / 'staged')`, `OrgIncidentsService.list`, `OrgSignalsService.list` (owner or CEO, warn and critical), agent events `action_pending` |
| Since you were last here | org tasks done since the visit, the org audit (`auto_*`, `approval_default`, `delegated_decision`, `member_add`, `member_pause`, `member_terminate`), the decision log, `OrgBriefService.latest`, `OrgSloService.pulse`, `WorkspaceFs.recent` |
| Goals | `OrgIntentService.intentTree` |
| Team | agents, org members, the board, the latest chat turn per agent, agent events, `heartbeat_state`, org runs, `ProviderHealthService` |
| Activity | the board, the audit, meetings, incidents, agent events (a loop run's tool calls from its turn in `chat_turns`), `WorkspaceFs.recent` |
| Spend and health | `OrgRuntimeService.spendTree`, `OrgCapitalService.forecast`, `UsageService.workspaceUsage`, the workspace token budget, incidents, `OrgAuditorService.list` |
| Coming up | scheduled meetings, enabled cadences (with their unit), task deadlines, card deadlines, plan apply times, agent loop crons in the next day |
| Recent files | `WorkspaceFs.recent` (new: `workspace_files` by `updatedAt`) |

Each section is computed on its own. If one fails, its name goes into
`partial[]`, the page says so, and the rest still renders.

Without a company (organization mode off, or `COMPANIES_ENABLED=false`),
the org sources are skipped and `company` is `null`.

### The last visit

"Since you were last here" needs to know when that was. The server keeps
it per person: an `app_settings` row `home.visit:<workspace>:<actor>`
holding `{ since, at }`.

- A request without `since` records the visit and returns the window.
  - The first visit looks back one day (`firstVisit: true`).
  - A visit more than 30 minutes after the last one starts its window at
    the last one.
  - A visit within 30 minutes continues the same session and keeps its
    window.
- The page then refreshes with `?since=<that window>`, which does not
  touch the record. The summary does not shrink while you read it.

The route is a GET, so a viewer of a shared workspace gets a Home too.
`home.*` rows are hidden from `GET /api/settings`.

## The page, in order of attention

*Redesigned 4 November 2026 as a command center: the old page was one long
column of equal-weight sections led by a giant sentence.*

**Layout.** A centred container (max 1360 px) on a 12-column grid. Wide
(Home's own width 1040 px and up, measured with a `ResizeObserver` on the
view, not the window) the main column takes 8 and the side column 4:

```
[ header: greeting, company, mode, run state ]
[ state banner, only when needed             ]
[ key numbers: one strip of tiles            ]
[ Needs you            ] [ Team              ]
[ Messages             ] [ Goals             ]
[ Roadmap              ] [ Coming up         ]
[ Since you were here  ] [ Spend and health  ]
[ Highlights           ] [ Recent files      ]
```

Narrower it is one column in priority order (needs, messages, team,
roadmap, goals, since, coming up, highlights, spend, files); on a tablet
the short side panels pair up two by two. On a phone (under 600 px) it is
one column with a 16 px gutter and never scrolls sideways.

**The card system.** Every section is a panel: one radius (12 px), one
border, one padding scale (16 px). Labels are small caps; titles strong;
meta in the dim text colour (never the faint one, which is too
low-contrast to read); status colours only where they mean something
(red failing or off track, amber blocked or watch, green done or on
track); numbers in tabular figures; icons from `src/lib/icons`. Rows have
hover states and every control a visible focus ring (a small `<style>`
scoped to `.hm`, since inline styles cannot say `:hover`); loading shows a
skeleton of the page, still under `prefers-reduced-motion`.

**1. Header.** A small greeting, the company name, the mode (Supervised or
Autonomous) and the run state (Running, or Paused in red; it links to the
Company header where the kill switch is), then one quiet line: "Overnight
your team closed 12 tasks. 3 things need you. Atlas is chief of staff,
with 7 members." Sections that failed to load are named here.

**State banner** (`stateBanners`, `src/lib/home.ts`), only when needed, with
its primary action:

| When | Banner | Action |
|---|---|---|
| the company is paused | "Acme is paused. Nothing runs until you resume" | Resume in Company (the kill switch) |
| month spend at or over the envelope | "Spend is over the monthly envelope" | Raise the envelope (Spend) |
| the forecast state is `stop` | "On pace to pass the envelope" | See spend |
| the token budget is used up | "The token budget is used up" | See spend |

**Key numbers.** One strip of tiles, each a link:

- **Needs you**: the count, and how many are critical or due within 6 h
  (opens the Inbox);
- **Spend vs envelope**: the month against the envelope as a meter (spent
  solid, the month-end forecast soft, the envelope a tick), the forecast and
  today's spend (opens Spend). Without an envelope: the month, today or the
  token budget, and a 14-day sparkline;
- **Done this week**: tasks done in the last 7 days, the change against the
  7 before (`weekOverWeek`) and a 14-day sparkline (`recap.doneSeries`);
- **Blocked**: tasks blocked now;
- **Agents working**: working of all, and how many are failing (opens All
  agents);
- **Pulse** (a company): the score and its breaches.

**2. Needs you.** Cards are ranked by severity, then nearest deadline,
then oldest, as compact rows. Each row has:

- a kind chip (Decision, Escalation, Needs your key, Pending change,
  Incident, Signal, Queued action), coloured by severity; a high or
  critical one also gets a bar at its edge;
- a one-line title (`needHeadline`). An escalation's server title wraps
  its task in quotes (`task "Make the kill criterion…": User decision on…`);
  the row leads with the ask and names the task by its key (`HomeNeed.task`,
  a chip that opens the task). Detail that only repeats the title is
  dropped (`needBody`);
- one meta line: who asked (the machinery, such as `migration`, reads
  "System"), the age, the default in a few words ("Denies in 3 h",
  "Applies in 20 min", `defaultShort`) and the recommendation chip
  ("Recommends approve, 70%");
- the inline decisions, each through the route that already owns it:

| Card | Buttons | Route |
|---|---|---|
| decision card, escalation, two-key card | Approve / Reject | `…/org/approvals/:id/decide` |
| held or staged action without a card | Give key / Deny | `…/actions/:id/keys` |
| plan | Veto / Apply now | `…/org/plans/:id/veto`, `…/apply-now` |
| signal | Acknowledge | `…/org/signals/:id/ack` |
| queued background action | Approve / Dismiss | `/api/agents/:id/events/:eventId/act` |
| incident | Review (opens Incidents) | — |

The chevron (or the title) expands the detail: the task, the body, the
route the card climbed, the proposer's case ("Chief recommends approve.
70% sure. Reversible."), the default in full ("If you don't answer, it
will be denied in 3 h") and a link to the full context.

A held action that already has a two-key card is listed once, as the
card. The page shows five; **N more** shows the rest the page carries, and
**See all in Inbox** has everything.

**Messages from your team.** What agents wrote to you with
`message_owner` (`docs/agent-messages.md`), unread first, at most five:
the agent, its urgency (Urgent or FYI), when, the text as plain text and
the task keys or files it refers to. A row opens the agent's direct chat,
where your reply goes, and marks that chat's messages read. The section is
hidden when nobody wrote; the heading counts the unread ones. It is the
owner's: a member of a shared workspace does not see it.

**3. Roadmap** (work tracking, `docs/work-tracking.md`). For a company: the
lanes in one line ("3 in Now, 2 next, 1 later"), then the projects in Now
(`portfolio.nowProjects`, in rank order) as rows: a health dot, the key and
title, the flags (off track, a tripped appetite breaker, update missing, at
risk, over budget, late) with the reason or ask, the lead, blocked tasks, a
progress bar (done of total) and the target date ("Target 21 Nov", or "4 d
late" in red). Projects flagged outside Now follow under **Also flagged**.
A row opens the project page; **Open roadmap** opens Company › Direction ›
Roadmap. With nothing in Now and nothing flagged it is one line and
**Propose a bet**, not a strip of zeros. The data is `HomeData.portfolio`
(`OrgProjectsService.portfolio`); also `GET …/org/portfolio?since=`.

**4. Since you were here.** One block for the window since the last visit
("Overnight", "Since yesterday"), replacing the two overlapping recaps:

- how many decisions were taken without the owner and how many files
  changed;
- the chief of staff's latest brief, shortened to its first three bullets
  (`briefSummary`; else its first paragraph), with **Read the brief**;
- the decisions taken without the owner (on its own, by default, by a
  delegate, logged), each linked to where it was made;
- hires, pauses and departures;
- on the roadmap: tasks done per project (from `doneAt`) and the project
  changes (health calls, lane moves, breakers and decisions on them,
  milestones, projects done).

Tasks done count by `doneAt`, the moment a task was accepted, not "last
touched while done".

**5. Goals.** A compact panel: each active objective with its RAG word and
the reason it is at risk, and up to three key results as bars with their
value ("12 / 40 students"); at most four objectives, the rest behind
**Vision and goals**. At risk comes first.

- Red: the model-free assessment says at risk.
- Amber: behind its pace against target.
- Green: on pace.
- Grey: not measured.

A low confidence number alone no longer makes a key result amber (it made
most of them amber by construction); confidence is shown beside the mark
and still feeds the at-risk rule when it drops twice in a row. The worst
health the leads wrote on the projects that move the key result is shown
beside it, never averaged in (`docs/work-tracking.md`).

**6. Team.** A compact roster: one row per agent with its avatar and
status dot, name and role, a state pill and one line of what it is doing
(the current task, a review, or the blocker; else when it was last
active). A count line sums the states ("3 working, 1 blocked"). Failing
agents are pinned on top, then the server's order (the chief of staff,
blocked, working, paused, idle). Eight rows show; **Show N more** the rest.

Errors are loud. A row turns red, with the message and **Fix** (opens the
agent) and **Open the run** (the failing run's conversation) or **Open the
task** (where a breaker tripped), when any of these happen:

- the agent's latest turn failed (for example, the provider rejected the
  model name);
- an unread loop error or budget stop since the agent last ran;
- a no-progress breaker on one of its tasks (two runs or more without
  progress);
- its provider is degraded (listed, but on its own it does not turn the
  tile red: the turn falls back to another provider).

**All agents** opens the full directory.

**One status everywhere.** The tile's state comes from
`server/src/home/agent-status.ts` (`agentStatuses`), the same helper behind
an agent's page (its Overview tab) and the org chart's mission control
(`docs/mission-control.md`), so an agent is never "working" on one screen
and "blocked" on another. The precedence is error, paused, blocked,
working, idle:

- **error**: one of the loud errors above, other than a degraded provider;
- **paused**: its seat or the whole company is paused;
- **blocked**: nothing in progress, and one of its tasks is blocked;
- **working**: a task in progress or claimed, a review it owes, a task on
  its own board marked doing, or a turn running right now (the in-process
  live-turn registry, `server/src/chats/live-turns.ts`);
- **idle**: none of these.

A blocked tile says what the task waits on: the latest blocker line, read
by `blockerOf` (an escalation to you, an escalation to a teammate, a task
it depends on), not the raw blockers list.

**7. Highlights.** The notable part of the week (`highlights`): tasks done
or blocked, decisions, people, meetings held, incidents and loop runs that
did something, each with a kind mark, who and when. File edits fold into
one row per person ("Tutor Engineer edited 6 files"), which expands into
the files; routine runs are left out. Eight rows show; **N more
highlights** the rest. **All activity** switches to the full feed: every
event, filter chips for the kinds present, and routine runs.

Most loop runs are heartbeats that find nothing to do, so a run is news
only when it did something. The server reads the run's tool calls (the
latest turn of its loop session before the run was recorded) and calls it
notable when a call that went through:

- moved a task to a new status (`org_task_update`, `update_task` with a
  status), created, assigned, reviewed, took, commented on or escalated
  one;
- posted in a channel or sent a message;
- wrote, edited or deleted a file, other than the notes an agent keeps for
  itself on every beat (`JOURNAL.md`, `LESSONS.md`, `NOTES.md`,
  `MEMORY.md`, `DASHBOARD.md` and the like);
- changed the company (a hire, a pause, a tunable, a cadence, a goal or key
  result, a report, an incident), or acted outward (mail, calendar, HTTP).

Reading, a note on its own task, the dashboard and sandbox code are
routine. A notable run is its own row, titled by what it did ("Heartbeat:
moved task 91ef6d61 to blocked, posted in #company, wrote launch.md") and
linked to the task it changed. Routine runs collapse into one line per
agent per day ("Unit Test Writer · 10 heartbeat checks, nothing new") that
folds out into the runs (the latest 30). A failed run is a `loop_error` and
is never collapsed. The **Agent runs** chip lists every run raw, notable or
not.

**8. Spend and health.** Today's spend and the month's spend against the
company envelope, with the month-end forecast (the meter itself is in the
key numbers, amber or red with the forecast state). Below that:

- the workspace token budget, when one is set;
- health: normal, degraded or incident, with open incidents and degraded
  providers;
- the last audit and its top findings.

**9. Coming up.** Meetings, rituals, deadlines, card deadlines and plan
apply times for the week, plus loops due in the next day, grouped by day.

Rituals and loops carry their cron, and the page puts it in words in the
viewer's time zone: "Fridays at 4:00 PM", "every weekday at 9:30 AM", "1st
of each month at 8:00 AM", "every 2 hours". Crons are server-local; the
time comes from the next fire the server computed, and the weekday moves
with it when the server's day is not the viewer's. Anything odder shows
the raw cron.

Every unit gets the default cadences (standup, weekly review, retro), so a
company with two units used to list each ritual twice at the same minute.
The same title at the same time is one row that names the units: "Weekly
review · Sales, Engineering". The server merges them, and the page merges
again whatever still matches.

**10. Recent files.** The last files written in the workspace, with who
wrote them. A file opens in Artifacts.

### The series behind the sparklines

Two small fields feed the key numbers, both the last 14 UTC days, oldest
first (`dayBuckets`, `SERIES_DAYS` in `home.service.ts`):

- `recap.doneSeries`: tasks done per day (org tasks by `doneAt`; without a
  company, agent tasks by their last update while done);
- `spend.series`: spend per day, company runs (`OrgRuntimeService.spendTree`)
  plus chat, loop and channel turns (`UsageService.workspaceUsage`, asked
  for at least 14 days; the month total sums this month's days).

`HomeNeed.task` carries the key and title of the task a card is about
(escalations and reviews, from the card's `taskId`), and
`portfolio.nowProjects` the Now projects for the roadmap snapshot.

### Without a company

Home is simpler without a company, in the same visual system: the
greeting is the title; the key numbers are Needs you, Spend this month
(with the token budget and a sparkline), Done, Blocked and Agents; then
needs, team, what changed, coming up (loops due), highlights, spend and
recent files. No roadmap, goals or pulse.

A dashed line invites the owner to start a company, which opens the
onboarding wizard. An empty workspace (no agents yet) gets **Start a
company with a Chief of Staff** or **Create one agent**, then only Needs
you and Spend: no strip of zeros, no empty panels.

## Inbox

The Inbox lists what waits on you now. Decisions go to the requester's
direct manager first (`docs/owners-seat.md` §7), so a card one of your
managers still holds is not listed yet. The Approvals header counts those
cards as "in review by your managers".

A card that climbed to you shows its route, such as "Writer → Head of
Content → Chief → you", with each manager's recommendation. A person who
manages a member sees that member's cards here, with Approve, Reject, Send
back and Escalate. A **Waiting / History** toggle sits
at the top, and Waiting is the default.

**Messages.** The **Messages** filter lists what agents wrote to you
directly (`docs/agent-messages.md`) over the last two weeks: unread first,
then newest, each with the agent, a **new** marker while unread and its
urgency when it is not normal. An unread message also waits in **All** and
counts in the Inbox badge. Opening one opens the agent's direct chat —
your reply there continues the conversation — and marks that chat's
messages read. Messages stay in their chats, so History has no Messages
filter. `GET /api/workspaces/:id/inbox/messages` returns `{ items, unread }`
and `POST /api/workspaces/:id/inbox/messages/read {eventId | sessionId}`
marks one chat's messages read; both are the owner's.

**History** lists everything that used to wait on you and is now
resolved, newest first. It has the same filters as Waiting (Approvals,
Keys, Escalations, Plans, My tasks, Incidents, Following), a search box, a
date range (7, 30 or 90 days, or all time; 30 by default) and **Decided
without you**. **Load more** fetches the next page. Each row shows:

- what it was;
- the outcome;
- who resolved it: you, another person, a delegate (a person or an agent
  role, named), the default at the deadline, an agent or the system;
- when.

A row opens its record. A task opens through its link, and a key opens
the conversation it ran in. A card opens the Approvals pane. A plan or an
incident opens in its pane, and a followed thread opens at its link. Rows
that a default or a delegate decided carry a **decided without you**
badge, so you can audit them.

Some rows can be walked back through a route that already exists, behind
a confirm:

- a card decided by a delegation that is still active offers **Revoke**
  (CEO only);
- a task offers **Reopen** (not for viewers).

`GET /api/workspaces/:id/inbox/history?kind=&q=&from=&to=&cursor=&limit=&without=`
returns `{ items, nextCursor }`. It owns no state and reads each
resolution from the record that holds it:

| Kind | Source | Outcomes |
|---|---|---|
| approvals, escalations | `org_approvals` past pending (`decidedVia`: by hand, `default`, `delegate:…`); `two_key` cards are left to their key | approved, rejected, sent back, expired |
| keys | `action_log` rows that were held or staged, attributed through their `two_key` card when a default or a delegate decided it | released, failed, denied, refused |
| plans | `org_plans`; applied when the window closed counts as the default; the veto time comes from the audit row | applied, vetoed, expired |
| incidents | `org_incidents`; who comes from the audit row | contained, resolved |
| my tasks | org tasks assigned to you or reviewed by you | done, cancelled |
| following | your follows, by `lastSeenAt` | seen |

Everything is scoped to the workspace and the account. A member sees the
company records they can already read, plus only their own tasks and
follows.

## Links

A single org task opens through its deep link,
`#/ws/<workspaceId>/org/board?task=<taskId>` (`src/lib/links.ts`; the
server writes the same shape, `orgTaskLink` in
`server/src/follows/follows.service.ts`). It opens the Company section,
the board and the task's drawer. When the task is not on the loaded board
(another unit, or done or cancelled), the board fetches it with
`GET /api/workspaces/:id/org/tasks/:taskId` (an id or its short prefix).

- The link stays in the address while the drawer is open, so reload
  reopens it. Opening a card pushes the link; closing the drawer pushes the
  board, so back and forward move between them. Leaving the board drops it.
- `app.openOrgTask(taskId)` is the one way in: Home (Needs you for an
  escalation, activity, decisions), the Inbox (Following, My tasks),
  follow notifications, channel task chips and minutes, signal and
  why-chain rows, reference buttons and the escalation card.

## Live

The first request draws the page. After that:

- workspace stream events (`file.changed`, `task_update`,
  `channel_approval`) trigger a debounced refresh (1.5 s);
- a 60-second poll runs while the tab is visible, because org events are
  not on the stream yet;
- the page also refreshes when the tab regains focus.

A decision removes its card at once. The page then refreshes behind it,
and the Inbox badge is refreshed.
