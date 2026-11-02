# Mission control: an agent's page and the org chart

*Shipped 2 November 2026. It extends Home (`docs/home.md`) from the
company to the one agent, and turns the org chart into a live view of who
is doing what.*

Home answers "is anything on fire, and does anything need me?" for the
whole company. Two more screens answer the next questions:

- **An agent's page**: what is this agent doing, why is it failing, what
  needs you, what is it stuck on, what is next, and is it healthy?
- **The org chart** (Company → People & money → Org chart): who in the
  company is doing what, who is stuck, and on whom?

Both read the same per-agent status as Home's team grid, so the three
screens always agree.

Code:

- `server/src/home/agent-status.ts`: the shared status (`agentStatuses`,
  `deriveState`, `blockerOf`, `primaryError`, `fixHint`, `sortTeam`,
  `toHomeAgent`)
- `server/src/chats/live-turns.ts`: the live-turn registry the turn loop
  writes (`liveTurns`, `describeToolCall`)
- `server/src/home/overview.service.ts` (`OverviewService`),
  `overview.controller.ts`, `overview.types.ts`
- `src/components/AgentDashboard.tsx` (`AgentHeader` and `AgentDashboard`,
  presentational; `useAgentPage`, data and actions; `AgentOverviewPanel`,
  the compact side panel)
- `src/components/AgentsView.tsx` (`AgentHome`: the header above six tabs)
- `src/lib/agent-tabs.ts` (the tabs, their sections and the old names; pure)
- `src/components/OrgMissionControl.tsx` (`MissionControlBoard`,
  presentational; `MissionControlPane`, data and the side panel)
- `src/lib/overview.ts` (the words, the signals, the merged activity, the
  filters, the hierarchy and the waiting chains; pure)
- tests: `tests/backend-overview.test.ts`, `web-tests/agent-dashboard.test.tsx`,
  `web-tests/mission-control.test.tsx` (and `tests/backend-home.test.ts`
  for the shared status on Home)

## The shared status

`agentStatuses` takes the workspace's agents, the company (if any), its
tasks and members, and returns one status per agent that is not
terminated:

| Field | Meaning |
|---|---|
| `state` | error, paused, blocked, working or idle, in that precedence (`deriveState`) |
| `doing` | the current task, the review it owes, or "Blocked on … : reason" |
| `errors` | the latest turn failed, an unread loop error or budget stop, a no-progress breaker, a degraded provider; each with its run (`sessionId`) or task (`taskId`) |
| `live` | a turn running now, with the tool call in progress |
| `doingSince` | when the current task was claimed |
| `blocked` | each blocked task with `blockerOf`'s answer: the reason, what it waits on, since when |
| `waitingOnYou` | how many of those wait on the CEO |
| `open` | open tasks (the WIP count) |
| `lastBeatAt`, `lastRunAt`, `lastActiveAt` | heartbeat state, org runs, the latest turn |

The rules for each state are in `docs/home.md` ("One status
everywhere"). A degraded provider is listed but does not turn an agent
red on its own: its turns fall back to another provider.

### What a blocked task waits on

`blockerOf` reads a blocked task's blockers, newest first:

- `escalated: <reason>` (an escalation to the CEO, `OrgTasksService.escalate`):
  it waits on **you**;
- `escalated to <name>: <reason>` (`escalateTo`, up the chain): it waits on
  that member;
- a task id or its 8-character prefix: it waits on that task, and so on its
  assignee;
- otherwise, an unmet dependency (`dependsOn`) waits on that task;
- a pending escalation card for the task also means it waits on you;
- anything else is free text: the reason, waiting on nothing named;
- no line at all: an empty reason (the page says "no reason recorded" and
  asks).

"Since" is the task's last update, the nearest the row records.

### Live turns

The turn loop records a turn when it starts, each tool call as it starts,
and drops the turn when it ends, however it ends. A running turn makes an
idle agent "working", and its tool call is put in words
(`describeToolCall`): "writing org/sales/reports/2026-W45.md", "reading
drafts/plan.md", "searching the web for "pricing"", "updating a task to in
review".

The registry is in memory and per process. A restart forgets it, which is
right (the turn died with the process). On a deployment with several
server instances, each sees only its own turns; the persisted record of a
turn stays `chat_turns`.

## An agent's page

`GET /api/agents/:id/overview` returns `AgentOverview`. It is scoped to
the agent's workspace: the workspace must be visible to the caller.

*Redesigned 2 November 2026: the first version stacked thirteen sections
under ten tabs, the error said "the last turn failed" while the cause sat
deep in the week's activity, and the one thing waiting on the owner was at
the bottom. The page now leads with the cause and with what needs you,
and puts everything else in one work card, one timeline and a side
column.*

### The header (every tab)

Avatar, name, role (or its title in the company) and model, then one
status pill and one sentence:

- **Working**: "Working on **Draft three newsletter issues** · 2 h in" (the
  title opens the task);
- **Blocked**: "Blocked on 3 tasks · waiting on you for 1";
- **Idle**: "Next heartbeat in 14 min" (or the next loop, whichever is first);
- **Paused**: "Nothing runs until you resume it" (or "The company is paused");
- **Erroring**: the cause itself, "Tool round limit (24) reached", in red.

While erroring, a second line says what to do when the message makes it
obvious (`fixHint`), **See the run** opens the failing run's conversation,
**Open the task** opens the task a breaker tripped on, and **Fix it** goes
to the tab that fixes it (Settings for a model the provider rejects, Work ›
Schedule for a loop out of token budget). While a turn runs, a line says
what it is doing now ("Now writing org/sales/reports/2026-W45.md · 4
calls · 3 min") and the pill pulses. Below: the next wake, the last beat,
and whether the heartbeat is off.

Quick actions: **Chat** (a new conversation), **Beat now** (the gated
heartbeat), **Pause** / **Resume** (the seat in the company, or the
heartbeat for an agent outside one), and **•••** for Import memory,
Export AGENT.json and Publish to the market.

### The cause

`agent-status.ts` records each error with where it happened: a failed turn
with its conversation (`sessionId`), a loop error with the loop's
conversation, a breaker trip with its task (`taskId`). A failed turn that
recorded no message of its own takes the reason from the loop error of the
same conversation (or within the hour), read or not, so Home, the org
chart and this page say "tool round limit (24) reached" rather than "the
last turn failed"; that loop error is then not listed a second time.

`cause` is the error the page leads with (`primaryError`): a red one before
a degraded provider, one with a fix before one without, a specific message
before a generic one, then the newest. Its `fix` (`fixHint`) covers the
tool round limit (split the work or raise `MAX_TOOL_ROUNDS`), a loop's
token budget, a spending cap, a no-progress breaker, a refused key, a model
the provider rejects, rate limits and a connection that failed to poll.

### The page (Overview)

**1. Signals.** A strip of small tiles, each a number and a note, that
turn amber or red when off (`signals` in `src/lib/overview.ts`):

| Tile | Amber | Red | A click |
|---|---|---|---|
| Doing | — | — | the Now tab |
| Blocked | anything blocked | something waits on you | the Blocked tab |
| Queue | — | — | the Up next tab |
| WIP (open / `capacity.wipPerMember`) | at the limit | over it | the Now tab |
| Budget (this month / the agent's envelope) | from 80% | at or over the cap | Health |
| Errors (last two days) | a degraded provider only | any other error | Health |

Without an envelope the budget tile says "Spend" with no colour; outside a
company there is no WIP tile.

**2. Needs you**, only when something waits on the owner (`needsYou`),
oldest first: background actions it queued (Approve / Dismiss), connections
another member's turn asks to use (Allow / Deny, shown only to that
member), escalations of its tasks to you and approvals it asked for
(Decide, which opens Approvals). The title opens the conversation or the
task.

**3. Work.** One card with tabs: Now, Blocked (n), Up next (n), Reviews (n,
only when it owes any) and Done. It opens on Now, or on Blocked when there
is no current task, or Up next. Each task is one line: the title, then a
short reason or its age, and a chip for what it waits on ("Waiting on
you", red; "Waiting on Writer", amber) or its status. A click expands the
row in place: the outcome and the done-when (three lines, then **more**),
the last comment, the files it may write and wrote, and the actions:

| Button | What it does | Route |
|---|---|---|
| Decide | opens Approvals, where the escalation card is (only when it waits on you) | — |
| Answer | a comment on the task's timeline, which wakes the assignee | `POST …/org/tasks/:id/comment` |
| Reassign | another agent of the workspace takes it | `POST …/org/tasks/:id/assign` |
| Open task | the task's drawer (`app.openOrgTask`), or Work › Tasks for its own board | — |

A blocked task with no reason recorded says so in amber, "no reason
recorded", with **Ask**, which opens the answer box. Up next is numbered:
deadline first, then the oldest, because the order is the plan.

**4. Activity.** One timeline, newest first: loop runs (routine ones
collapsed into "Writer · 10 heartbeat checks, nothing new", as on Home; the
ones that did something stand alone), loop errors and budget stops, tasks
it finished or that got blocked, its comments and posts, and the files it
wrote. Filters: All, Runs, Tasks, Files, Comments. Ten rows, then **Show
all**.

**5. The side column.** **Team**: its manager, the unit it leads, a line
per report (state, what it is doing) and people who report to it; a line
opens that agent's page. **Health**: the errors (each with its run or
task), spend this month against its envelope with a meter and a 30-day
sparkline (the chat ledger, `health.spend.series`), today and 30 days, the
heartbeat cadence and runs today, the next loop, and a link to its trust
levels. **Goals it owns**, with progress and the RAG colour of Home's
goals, and **Following** when a follow has news.

**6. Its notes**, folded: the markdown it keeps with `update_dashboard`.

Recent conversations are not repeated here (the Chats tab and the rail
list them), trust chips moved to Settings › Trust, and the 30-day usage
chart became Health's sparkline.

Side by side above about 700 px, one column below it; on a phone the page
keeps a 16 px gutter and never scrolls sideways (the tab bars scroll in
their own box).

### The tabs

Six tabs (`src/lib/agent-tabs.ts`), two with sections:

| Tab | Sections | What it holds |
|---|---|---|
| Overview | — | the page above |
| Work | Tasks, Schedule | its own task board; its loops and heartbeat |
| Chats | — | its conversations, searchable |
| Artifacts | — | its files |
| Memory | — | its file brain and lessons |
| Settings | General, Skills & tools, Mini apps, Trust | identity, model, heartbeat, charter, shared folder, ratings, workspace, danger zone; skills, tools and connections; the apps it built; trust levels and held actions |

Every older name still lands (`resolveAgentTab`), in `?tab=`, in
`app.openAgent(id, tab)` and in the store's one-shot tab request:
Dashboard → Overview; Tasks → Work › Tasks; Schedule → Work › Schedule;
Mini apps, Skills & tools and Trust → those Settings sections; Files →
Artifacts. `Tab:Section` works too ("Settings:Trust", "Work:Schedule"),
and the fix hints use it. The Overview tab shows how many things wait on
you; Work shows its open tasks.

## The org chart

`GET /api/workspaces/:id/org/mission-control` returns `MissionControl`
for the workspace's company (404 when it runs none).

**The strip.** How many agents are erroring, blocked, working, idle and
paused (erroring and blocked are filters too); tasks in flight (claimed,
in progress, in review); what waits on you (pending approvals and
escalations, opens Approvals); spend today, and this month against the
company envelope with a meter. Spend uses Home's sources: org runs this
month, plus today's chat ledger.

**The filters.** Everyone, Needs attention (blocked, erroring, or waiting
on you), Blocked, Erroring; a unit (its lead and everyone under it); a
search over name, title and what it is doing. Managers of a matching
agent stay on the chart, faded, so the hierarchy still reads.

**The chart.** The hierarchy follows reports-to: the chief, then the heads
(members with reports lead a unit), then their members, and human
employees under the member they report to. Each card shows:

- avatar, name, title (or "Chief of staff");
- the state in its colour, a pulsing dot while a turn runs;
- one line: what it is doing and the live tool call, or "Blocked on “Pricing”
  · waiting on you", or the error message;
- open tasks against the WIP limit (amber at the limit), its last
  heartbeat, today's spend;
- "waits on you" when it does, the unit it leads with its open tasks (opens
  the unit's board), and a fold for its reports.

The tree is drawn with connectors and scrolls sideways inside its own box,
never the page. More than four reports that are all leaves stack in a
column under their manager, so a 20-person team stays readable. Below 720
px the chart is an indented list instead.

**Waiting chains.** Every blocked task that waits on a member or on you is
an edge (`edges`: `from` waits on `to`, `ceo` = you). Picking an agent
outlines everyone on its chain, both ways, and names it: "Waiting chain:
Writer → Content Head → You".

**The side panel.** Picking an agent opens its overview in compact form
(the status and its cause, the signals, and the work card, whose rows open
the task), with **Open page**, **Chat** and **Board** (its unit's board).

**Edit structure.** The structure editor is one click away and unchanged:
add a member, hire, scopes, pause, terminate, accept a changed charter, the
humans (board, observers, employees) and the unit boxes. **Back to mission
control** returns.

## Live

Both screens draw from one request and then:

- refresh, debounced 1.5 s, on workspace stream events: a file written, a
  task moving, a channel approval, and (for the agent page) the agent
  replying in a channel; the org chart also refreshes on any agent typing
  in a channel;
- poll while the tab is visible: the agent page every 30 s, every 8 s while
  the agent is working or a turn is live; the org chart every 20 s;
- the agent page refreshes when the window regains focus.

Org events and tool calls are not on the workspace stream; the poll
carries them.
