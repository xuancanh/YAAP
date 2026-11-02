# Mission control: an agent's page and the org chart

*Shipped 2 November 2026. It extends Home (`docs/home.md`) from the
company to the one agent, and turns the org chart into a live view of who
is doing what.*

Home answers "is anything on fire, and does anything need me?" for the
whole company. Two more screens answer the next questions:

- **An agent's Dashboard tab**: what is this agent doing, what is it stuck
  on, what is next, what did it finish, and is it healthy?
- **The org chart** (Company → People & money → Org chart): who in the
  company is doing what, who is stuck, and on whom?

Both read the same per-agent status as Home's team grid, so the three
screens always agree.

Code:

- `server/src/home/agent-status.ts`: the shared status (`agentStatuses`,
  `deriveState`, `blockerOf`, `sortTeam`, `toHomeAgent`)
- `server/src/chats/live-turns.ts`: the live-turn registry the turn loop
  writes (`liveTurns`, `describeToolCall`)
- `server/src/home/overview.service.ts` (`OverviewService`),
  `overview.controller.ts`, `overview.types.ts`
- `src/components/AgentDashboard.tsx` (`AgentDashboard`, presentational;
  `AgentOverviewPanel`, data and actions)
- `src/components/OrgMissionControl.tsx` (`MissionControlBoard`,
  presentational; `MissionControlPane`, data and the side panel)
- `src/lib/overview.ts` (the words, the filters, the hierarchy and the
  waiting chains; pure)
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
| `errors` | the latest turn failed, an unread loop error or budget stop, a no-progress breaker, a degraded provider |
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
- anything else is free text: the reason, waiting on nothing named.

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

## An agent's Dashboard tab

`GET /api/agents/:id/overview` returns `AgentOverview`. It is scoped to
the agent's workspace: the workspace must be visible to the caller.

The page, top to bottom:

**1. The status sentence.** One sentence, large, with a rule in the state's
colour:

- "Working on **Draft three newsletter issues** · 2 h in" (the title opens
  the task);
- "Blocked on 3 tasks · waiting on you for 1";
- "Idle: next heartbeat in 14 min" (or the next loop, whichever is first);
- "Paused: nothing runs until you resume it" (or "the company is paused");
- "Erroring: provider rejected model claude-opus-4-5".

While a turn runs, a second line says what it is doing now ("Now writing
org/sales/reports/2026-W45.md · 4 calls · 3 min") and the state dot
pulses. Below: the next wake, the last beat, runs today against the daily
cap, and whether the heartbeat is off.

Quick actions: **Chat** (a new conversation), **Beat now** (the gated
heartbeat), and **Pause** / **Resume**: the seat in the company, or the
heartbeat for an agent outside one.

**2. Now.** The current task: title, outcome, done-when, when it started,
when it is due, the last comment on its timeline, and the files it may
write plus those this agent wrote since it started. **Open** goes to the
task through `app.openOrgTask` (an org task) or to the Tasks tab (a task
on the agent's own board). With no task: "Not on a task right now", or the
conversation a running turn is in.

**3. Blocked.** Each blocked task with its reason, what it waits on
("Waiting on you", "Waiting on Writer", "Waiting on “Get the logo”") and
since when. The ways to unblock it, each through the route that owns it:

| Button | What it does | Route |
|---|---|---|
| Decide | opens Approvals, where the escalation card is (only when it waits on you) | — |
| Answer | a comment on the task's timeline, which wakes the assignee | `POST …/org/tasks/:id/comment` |
| Reassign | another agent of the workspace takes it | `POST …/org/tasks/:id/assign` |
| Open | the task's drawer on the board | `app.openOrgTask` |

**4. Up next.** Its todo, waiting and claimed tasks in order (deadline
first, then the oldest), numbered because the order is the plan. Then the
reviews it owes and the follows with something new or needing it
(`docs/follows.md`).

**5. Recently done.** Tasks done in the last two weeks with their outcome;
the files it wrote (the workspace filesystem, by this author); and its
week: loop runs that did something stand alone, described by what they did,
and routine ones collapse into "Writer · 10 heartbeat checks, nothing new"
as on Home; loop errors and budget stops; its comments on task timelines
and its posts to the company log.

**6. Goals it owns.** Objectives and key results whose owner is this agent,
with progress (or current against target), confidence and the RAG colour
of Home's goals. At risk first.

**7. Team.** For a head or the chief: the unit it leads and a tile per
report (state, what it is doing, its last beat), plus people who report to
it. For a specialist: its manager. A tile opens that agent's page.

**8. Health.** Errors (red; a degraded provider amber); spend today, over
30 days (the chat ledger) and this month against its envelope (org runs
against the agent budget), with a meter; WIP against the limit
(`capacity.wipPerMember`); the heartbeat cadence in words and runs today;
the next loop; its trust level per action class (they open the Trust tab).

**9. Below.** Background actions it queued and connections it asks to use
(Approve / Dismiss, Allow / Deny, as before), usage over 30 days, recent
conversations, and the agent's own notes (the markdown it keeps with
`update_dashboard`), folded.

The two columns of sections become one below about 640 px; on a phone the
page keeps a 16 px gutter and never scrolls sideways.

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
(the status, Now, Blocked, the next three, WIP and spend), with **Open
page**, **Chat** and **Board** (its unit's board).

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
