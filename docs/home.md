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
- `src/components/HomeView.tsx` (data, live updates, decisions, navigation)
- `src/components/HomeBoard.tsx` (the page, presentational)
- `src/lib/home.ts` (the copy and the link targets, pure)
- tests: `tests/backend-home.test.ts`, `web-tests/home.test.tsx`

## One request

`GET /api/workspaces/:id/home` returns `HomeData`
(`server/src/home/home.types.ts`, mirrored in `src/lib/api.ts` and checked
loosely by `homeDataSchema` in `src/lib/schemas.ts`).

The endpoint owns no logic of its own. It reads from the services that
already own each fact:

| Section | Source |
|---|---|
| Needs you | `OrgApprovalsService.pending` (decision cards), `OrgCapitalService.plans('pending')`, `ActionsService.list('held' / 'staged')`, `OrgIncidentsService.list`, `OrgSignalsService.list` (owner or CEO, warn and critical), agent events `action_pending` |
| Since you were last here | org tasks done since the visit, the org audit (`auto_*`, `approval_default`, `delegated_decision`, `member_add`, `member_pause`, `member_terminate`), the decision log, `OrgBriefService.latest`, `OrgSloService.pulse`, `WorkspaceFs.recent` |
| Goals | `OrgIntentService.intentTree` |
| Team | agents, org members, the board, the latest chat turn per agent, agent events, `heartbeat_state`, org runs, `ProviderHealthService` |
| Activity | the board, the audit, meetings, incidents, agent events, `WorkspaceFs.recent` |
| Spend and health | `OrgRuntimeService.spendTree`, `OrgCapitalService.forecast`, `UsageService.workspaceUsage`, the workspace token budget, incidents, `OrgAuditorService.list` |
| Coming up | scheduled meetings, enabled cadences, task deadlines, card deadlines, plan apply times, agent loop crons in the next day |
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

**1. Header.** A greeting and one sentence about the state of the company,
for example: "Overnight your team closed 12 tasks. 3 things need you.
$4.20 spent today, $12.40 of $20.00 this month." The sentence is the one
large element on the page. Below it:

- the mode (Supervised or Autonomous);
- the run state, which links to the Company header where the kill switch
  is. A paused company shows in red: "Paused: nothing runs until you
  resume".
- the chief of staff and the member count.

**2. Needs you.** This is the most prominent section. Cards are ranked by
severity, then nearest deadline, then oldest. Each card shows:

- what it is and who asked;
- the proposer's case, for example "Chief recommends approve. 70% sure.
  Reversible.";
- what happens if the owner says nothing, for example "If you don't
  answer, it will be denied in 3 h" or "Applies on its own in 18 min
  unless you veto it";
- the inline decisions, each through the route that already owns it:

| Card | Buttons | Route |
|---|---|---|
| decision card, escalation, two-key card | Approve / Reject | `…/org/approvals/:id/decide` |
| held or staged action without a card | Give key / Deny | `…/actions/:id/keys` |
| plan | Veto / Apply now | `…/org/plans/:id/veto`, `…/apply-now` |
| signal | Acknowledge | `…/org/signals/:id/ack` |
| queued background action | Approve / Dismiss | `/api/agents/:id/events/:eventId/act` |
| incident | Review (opens Incidents) | — |

A held action that already has a two-key card is listed once, as the
card. The page shows six cards; **See all in Inbox** has the rest.

**3. Since you were last here.** Counts of tasks done, tasks blocked,
decisions taken without the owner, files changed and the pulse. Then:

- the decisions taken without the owner (on its own, by default, by a
  delegate, logged), each linked to where it was made;
- hires, pauses and departures;
- the chief of staff's latest brief, rendered as markdown, folded after a
  few lines.

**4. Goals.** Active objectives with their key results' progress, a RAG
mark and confidence. At risk comes first.

- Red: the model-free assessment says at risk.
- Amber: behind pace, or confidence below 50%.
- Green: on pace.
- Grey: not measured.

**5. Team.** One tile per agent: what it is doing (the current task, a
review, or the blocker), when it was last active, and its last heartbeat.
The chief of staff comes first, then failing, blocked, working, paused
and idle agents.

Errors are loud. A tile turns red, with the message, when any of these
happen:

- the agent's latest turn failed (for example, the provider rejected the
  model name);
- an unread loop error or budget stop since the agent last ran;
- a no-progress breaker on one of its tasks (two runs or more without
  progress);
- its provider is degraded.

**All agents** opens the full directory.

**6. Activity.** Notable events of the week: tasks done or blocked,
people, decisions, meetings held, incidents, files created or edited, and
agent loop runs. Filter chips appear for the kinds present.

**7. Spend and health.** Today's spend and the month's spend against the
company envelope, with the month-end forecast. The meter turns amber or
red with the forecast state. Below that:

- the workspace token budget, when one is set;
- health: normal, degraded or incident, with open incidents and degraded
  providers;
- the last audit and its top findings.

**8. Coming up.** Meetings, rituals, deadlines, card deadlines and plan
apply times for the week, plus loops due in the next day, grouped by day.

**9. Recent files.** The last files written in the workspace, with who
wrote them. A file opens in Artifacts.

Docked wide (1180 px and up), the page has two columns. Needs you, the
recap, goals and activity are on the left. Team, spend, coming up and
files are on the right. Narrower, it is one column in the order above.
On a phone it uses a 16 px gutter and never scrolls sideways.

### Without a company

Home is simpler without a company:

- agent status;
- background actions waiting for approval;
- tasks done;
- activity;
- spend against the workspace budget;
- loops due;
- recent files.

A line invites the owner to start a company, which opens the onboarding
wizard. An empty workspace gets **Start a company with a Chief of Staff**
or **Create one agent**.

## Live

The first request draws the page. After that:

- workspace stream events (`file.changed`, `task_update`,
  `channel_approval`) trigger a debounced refresh (1.5 s);
- a 60-second poll runs while the tab is visible, because org events are
  not on the stream yet;
- the page also refreshes when the tab regains focus.

A decision removes its card at once. The page then refreshes behind it,
and the Inbox badge is refreshed.
