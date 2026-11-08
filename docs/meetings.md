# Meetings: lifecycle, minutes and the calendar

A meeting is a bounded ritual held in its own **sub-channel** of the
channel it is called in — `#company`, a unit's channel, the channel a
`/meeting` was typed in (`docs/group-chat.md` §9; meetings held before
that are threads and stay readable as they were). The design is
`docs/company-vision.md` §3; the mechanics are `docs/group-chat.md` §8. This
page covers how a meeting is prepared (**before**), the **room** people
watch and steer while it runs (**during**), what every meeting leaves behind
— its **minutes** and its **cost** (**after**) — and where people find
meetings past and coming: the **list** and the **calendar**.
Meetings need organization mode; every meeting is a row of `org_meetings`.

## Lifecycle

| Status | How it gets there |
|--------|-------------------|
| `scheduled` | created: prepared `meeting.prepMinutes` before a cadence fires, a cadence fired on the minute tick, `/meeting [kind] [#unit] [agenda…]` in a channel, Start meeting in Company → Meetings or a channel's Meetings tab, or `POST …/org/meetings` |
| `postponed` | quiet hours at start; the tick retries when the window ends |
| `running` | its sub-channel `meeting-<kind>-<yyyy-mm-dd>` opens (the parent gets one link card, *live*) and the agenda is its first message; rounds run (one turn per agent attendee in the first round; later rounds only those with an open thread; at most three rounds plus Extend, one for a standup) |
| `done` | the meeting ended: the facilitator closed it (`meeting_close`), the rounds ran out, everyone passed in a round, the agenda items were done, the per-meeting USD cap was reached, a person pressed End, or a person said "stop" / "end meeting" in the meeting; the sub-channel closes (read-only) and the card says *ended* with the outcome |
| `skipped` | a scheduled ritual (created by its cadence, with no agenda of a person's) had nothing on its agenda and skipped itself without a model call (`meeting.autoSkip`) |
| `cancelled` | before it started: the daily cap, no channel, the kill switch, a prepared meeting whose cadence did not fire; or while running: the API cancel or the kill switch, effective at the next turn |

## Where it runs: the meeting's sub-channel

When a meeting starts, `OrgMeetingRuntime.run` opens a sub-channel of the
channel it was called in through the `MeetingChannels.openSub` seam
(`server/src/org/org-announcer.ts`, bound by the group chat):

- **Slug and title.** `meeting-<kind>-<yyyy-mm-dd>` (de-duplicated:
  `…-2`), named after the meeting; purpose `meeting`, `meetingId` set.
- **Members.** The agent attendees who speak, the human attendees and the
  parent channel's people. Visibility follows the parent.
- **The record.** `org_meetings.channelId` becomes the sub-channel,
  `parentChannelId` the channel it was called in (migration 0082); the
  calendar and a channel's Meetings tab list a meeting under either.
  `threadRootId` stays the agenda message.
- **Inside.** Everything happens at the sub-channel's top level: the
  agenda, every round's turns, people's messages (heard at the next round,
  or the next turn once they joined), the room's system lines, the
  proposals with their Approve / Reject / Answer, and the structured
  minutes message. The transcript the turns and the minutes read is the
  sub-channel's whole stream. The agents' working sessions are
  `#meeting-<kind>-<date> · <agent>`, so the Work log shows each meeting
  as its own session; spend counts against the parent's daily budget.
  Mentions and follows work there as in any channel.
- **The parent.** Only the link card (*live* while the meeting runs, then
  *ended* with the summary) and, at the end, the one line
  `Minutes of <title>: … · #meeting-… · Minutes: /<path>`. Action items
  become tasks linked to the parent and the card, so their status lines
  land under the card, not in the closed sub-channel.
- **The end.** Done or cancelled, the sub-channel closes (`closeSub`):
  read-only, folded into the parent's "Past discussions". The minutes file
  is written where it always was (the unit's `/org/meetings/…`, or the
  parent channel's `meetings/` folder).
- **Fallback.** Without the seam (a test double, the group chat unbound)
  or when the meeting is called inside a sub-channel, it runs as a thread,
  exactly as before.

The full-screen room reads the sub-channel's stream; a sub-channel
holding a meeting shows the room above its messages.

## The room's tunables

Every number below is a `meeting.*` tunable on the shared registry
(`org_tune`, `PUT …/org/tunables`, the settings card), with its bound in
code. The operating-system derivation (`deriveMeetingTunables` in
`meeting-tunables.ts`, appended to `chief-os.ts`'s plan) sets them from the
profile — a heuristic: speed → five-minute items, no extra round, an hour's
preparation; rigour or a control culture → fifteen-minute items, a day's
preparation, rituals held even when quiet; a clan culture → everyone every
round.

| Key | Default | Bound | What it does |
|---|---|---|---|
| `meeting.selectiveRounds` | 1 | 0–1 | rounds after the first hear only the facilitator and attendees with an open thread |
| `meeting.itemMinutes` | 10 | 1–60 | the time box of each agenda item |
| `meeting.extendRounds` | 1 | 0–2 | rounds a person may add with Extend (the fence is 3 + 2) |
| `meeting.prepMinutes` | 120 | 0–1440 | how far ahead a ritual is prepared (pre-read, agenda proposals) |
| `meeting.reminderMinutes` | 10 | 0–120 | the "starts in N min · Join" reminder to the people attending |
| `meeting.autoSkip` | 1 | 0–1 | an empty ritual skips itself |

## Before: preparation, proposals, the reminder, auto-skip

- **Prepared.** On the minute tick, a cadence whose next fire is within
  `meeting.prepMinutes` (or the reminder window) gets its meeting row now
  (status `scheduled`, `scheduledFor` = the fire, audited
  `meeting_prepared`). The facilitator's **pre-read** is compiled from the
  record without a model (`OrgMeetingsService.preRead`): goal check-ins
  since the last meeting of this kind (on pace / at risk — the scorecard
  deltas), at-risk goals, what moved and what was done on the unit's board,
  what is blocked. It is kept on the room and attached to the agenda at the
  start. A unit's meeting also gets its **agenda file** beside its minutes —
  `orgPath.agenda` in `server/src/files/layout.ts`
  (`…/<yyyy-mm-dd>-<kind>-agenda.md`): the items, the open items, the
  pre-read and the proposals, authored by the facilitator and rewritten when
  it is prepared, when a proposal arrives and when it starts (the room keeps
  `agendaPath`; the room header's Agenda button opens it). The calendar shows the prepared meeting instead of the cadence's
  occurrence. A prepared meeting whose cadence never fired is cancelled ten
  minutes after its time.
- **Agenda proposals.** Until it starts, an agent attendee may call
  `meeting_propose_agenda {item, why?, meeting?}` (offered, with the list of
  open meetings in its context, only while one is open) and a person may
  propose from the room (`POST …/org/meetings/:id/agenda {text, why?}`); at
  most eight, duplicates refused. Each becomes an agenda item and is listed
  "Proposed by attendees" in the root.
- **Reminder.** `meeting.reminderMinutes` before, each person attending gets
  a `meeting` inbox event "<title> starts in N min · Join" (payload
  `{link, meetingId, channelId, action: 'join'}`), once; quiet hours defer
  its push (`deliveryFor`).
- **Auto-skip.** When a ritual created by its cadence, without a person's
  agenda, has no deltas (nothing moved, no check-in, nothing at risk), no
  open items from the last meeting, no blocked task and no proposal, it
  skips itself: status `skipped`, minutes `{endedBy: 'skipped'}` on the row
  (no minutes file), one line in the channel ("… skipped itself: nothing on
  the agenda … (no model call)"), audited `meeting_auto_skipped`. No model
  is called. **Empty cycles** — skipped meetings and held ones without a
  decision or action that stood (`OrgMeetingsService.emptyStreak`) — count
  toward the chief's ritual-retirement review: at `chief.sunsetEmptyCycles`
  the channel line says so, the chief gets an inbox event, and its
  heartbeat context lists the ritual (`OrgChiefService.state().emptyRituals`).
  The chief proposes; it never retires a ritual on its own.

## During: the room

The room is `org_meetings.room` (JSON, migration `0050-meeting-room`):
agenda items and the current one, round and round cap, who is speaking,
this round's attendance, the passes, the people present, the proposals, the
pre-read, the open items, the people's verdicts, answers and controls. Every
change emits `meeting_update` on the workspace event stream; the speaker's
reply streams as `channel_typing` / `channel_stream` with the thread as
`replyRootId`, like a channel wake's.

- **Open items first.** Every ritual (not an ad-hoc meeting) opens with the
  previous meeting of the same unit and kind's action items, classified from
  the board tasks they became: done, blocked, late (past its due date, or
  not moved since that meeting), open, dropped. They are the first section
  of the agenda and its first item.
- **Agenda items.** The person's bullet lines ("- x", "1. x"), else the
  kind's standard items (an ad-hoc meeting: its agenda's first line), after
  the open items and before the proposals; at most eight. One is current;
  it moves on when the facilitator calls `meeting_next_item`, when a person
  presses Skip item, or when its time box (`meeting.itemMinutes`) runs out —
  checked at each turn boundary, with a system line in the thread. When the
  last item is done the rounds end and the facilitator closes.
- **Turns.** `meeting_pass {reason?}` posts nothing — the room shows the
  attendee passed; a round in which every speaker passed ends the rounds.
  With `meeting.selectiveRounds`, rounds after the first hear the
  facilitator and only the attendees with an open thread since their last
  turn: named in the thread by someone else, given an action by someone
  else, or a question of theirs answered. The facilitator also has
  `meeting_park {text}` (the minutes' parking lot; a backlog task on the
  unit board when the minutes are executed) and `meeting_next_item`.
  `meeting_propose_action` takes an optional `due` (yyyy-mm-dd or ISO): it
  is set on the task (`dueAt`) and shown in the minutes and the next
  meeting's open items.
- **People.** Join (`POST …/:id/join`) marks a person present and adds them
  to the attendees: their messages in the thread are heard by the next
  speaker in the same round. Others are heard at the next round, as before.
  Under a proposed decision or action the CEO, a board member or the person
  who started the meeting may Approve or Reject (`POST …/:id/verdict {kind,
  index, verdict, note?}`): a rejected proposal stays in the minutes but is
  not executed (no decision-log row, no task); an approved decision is
  logged with the person as its decider. Under a question for the CEO, the
  CEO or a board member may Answer (`POST …/:id/answer {index, answer}`):
  the answer is posted in the thread as the person, kept on the minutes, and
  the question no longer goes to the brief.
- **Controls** (`POST …/:id/control {action}`; the CEO or the person who
  started it): **Extend** adds a round (up to `meeting.extendRounds`, never
  for a standup, still under the USD cap); **Skip item** moves the agenda
  on; **End** ends the rounds after the current turn and lets the
  facilitator close (unlike "stop", which skips the closing turn). Each is
  audited `meeting_control` and posted as a system line.

### The room header (in the thread)

In the SPA (`src/components/MeetingRoom.tsx`) the room heads the thread
panel of ChannelView (full width on a phone), above the scrolling messages,
as **one compact line**: the status dot, the title, the current item as a
chip ("3/6 · Pricing…", clamped, the whole item as its tooltip), "R2/3",
the item's time box as a small meter ("7/10m"), tokens and $, the attendee
avatars ringed by their state (speaking pulses; the speaker first), **Join**,
a **⋯** menu with Extend / Skip item / End (only for those who steer), and
**⤢ Expand**, which opens the full-screen room. As the panel narrows (a
container query) the cost, then the meter and all avatars but the speaker's,
then the round drop out of the line; nothing wraps. The item chip toggles a
**drawer** under the line: round, item and elapsed time with the cost; the
whole agenda with each item's state (done / skipped / parked / now / up next,
one line each, clamped with a tooltip); the attendees with their state; the
open items from the last meeting; the pre-read; the agenda file; before the
start, the proposals and the propose box. The drawer is **collapsed by
default** and remembered per viewer in this browser
(`yaam-meeting-drawer:<actorId>` in localStorage, read and written in
try/catch), and capped at 42% of the height, so the messages always keep
most of it. `ProposalActions` (built on `ProposalControls`) draws Approve /
Reject and Answer under the proposals. Controls and verdicts follow the
server's rules on the client too (`roomStanding`, from `GET …/org/humans`):
the CEO or the starter steers; the CEO, a board member or the starter rules;
the CEO or a board member answers; until the role is known they show, and
the server still refuses.

### The full-screen room

`#/ws/<workspaceId>/meeting/<meetingId>` (`src/components/MeetingView.tsx`;
the route helpers `openMeetingView`, `closeMeetingView`, `useMeetingRoute`
in `src/lib/meetings.ts`) fills the main area, rail and all: Expand in the
thread's header, **Room** on the agenda root in the channel, **Join** (it
joins first) and **View** on the Meetings list and Company → Meetings'
"Running now" open it. Moving anywhere else in the app, ‹, or Back closes
it; **Thread** opens the meeting where its messages live.

- **Top bar** — the title, Live / Ended / Starts …, the kind and channel,
  the current item; under it the **agenda ribbon**: one segment per item,
  sized by its time box (or the time it took when longer), done segments
  green, skipped hatched, parked amber, the current one filling as its box
  runs and turning red when it is over.
- **Left** — the agenda: each item with its state (done, current, upcoming,
  parked — the facilitator parked a point naming it —, skipped; the room's
  `itemLog` says how each item ended: settled, skipped by a person, or its
  time box ran out) and its time (m:ss taken, the running item against its
  box with a meter, the box for those ahead); the open items from the last
  meeting with their tasks; the pre-read (open before the start, folded
  after); the agenda proposals with, before the start, the propose box
  (item and why).
- **Center** — the live transcript: the agenda root folded to one line,
  each attendee's consecutive messages folded into one turn (a long turn is
  clipped with "Show the whole turn"), system lines, people's messages, a
  proposal with its Approve / Reject / Answer in place, the minutes card,
  the speaker's reply streaming in; under it Join ("the next speaker hears
  you") and the thread composer (heard at the next turn when present, else
  at the next round).
- **Right** — the stats (elapsed against the whole box, round N/M, this
  item, skips, extends, tokens and $; before the start, when it starts),
  Extend / Skip item / End for those who steer ("You are watching" for the
  rest), **On the floor** (the speaker and the tail of their live reply),
  the attendees (speaking now / spoke / passed / waiting / not called;
  people present / not joined), the **Proposed** board (decisions, actions,
  risks, questions for the CEO, with the verdicts and answers given and the
  inline controls) and the **parking lot**.
- **After the end** the center opens on the **Summary**: how it ended,
  rounds, minutes taken, tokens and $; the summary; **Open the minutes**
  (the file in Artifacts); the decisions taken (with their
  `#decision:` link; rejected ones struck through), the action items with
  their task keys (opening the board), the questions. The transcript is a
  tab away.
- On a phone the three columns are tabs: Agenda, Transcript (Summary), Room.

It is live through the workspace stream — `meeting_update` refetches the
row; `channel_message`, `channel_typing` and `channel_stream` of the
meeting's messages update the transcript — and polls as the fallback
(every 15 seconds while it runs, every minute otherwise).

**Where the messages come from** is an adapter, `MeetingStream`
(`src/lib/meetings.ts`): the channel, the composer target (a thread root, or
null for a channel's top level), the opening message, `load()`, and
`owns` / `ownsLive` to pick the meeting's messages and live replies off the
stream. `meetingStream` derives it from the row: a meeting held in its own
sub-channel (`parentChannelId` set, docs/group-chat.md §9) is
`subChannelStream` — the sub-channel's top level, the composer posting
there, Channel opening it — and one held in a thread is `threadStream`.
`MeetingView` also takes a `stream` prop.

Upcoming meetings are not rows: they are the cadences (`org_cadences`, a
five-field cron per unit and kind, server-local time) expanded on demand.

## Minutes at the end

When a meeting that started ends — any of the `done` paths, or a cancel
while running — `OrgMeetingRuntime` hands the record to
`OrgMeetingMinutesService` (`server/src/org/meeting-minutes.service.ts`):

1. **Verdicts and answers** from the room are applied to the proposals.
2. **Narrative.** The summary is the facilitator's own `meeting_close` note
   when it gave one (no extra call). Otherwise — a standup, a stop, the USD
   cap, a cancel — the facilitator's model gets **one** tool-free call: the
   agenda, the proposals and the thread (capped at 12,000 characters), at
   most 700 output tokens, a 60-second limit, reserved and settled against the
   org budget like a turn and skipped when the meeting's USD cap has no
   headroom left. It answers `{summary, discussion[]}`. When the call is
   skipped, fails or answers something unparseable, the summary and the
   discussion points are composed from the record and the transcript without
   a model. The narrative is settled before the minutes are materialised, so
   the stored minutes and the audited hash carry the final summary.
3. **Execution** (no model): actions become briefed tasks on the unit board
   (with their due date), decisions decision-log rows, parked points backlog
   tasks, risks audit rows, unanswered questions go to the CEO's brief;
   rejected proposals are skipped. A cancelled meeting executes nothing. A
   **retro's** (and a postmortem's) actions are different: they become capped
   improvement proposals — the top `improve.perMeeting`, each with its
   category, target, evidence and expected metric — and only a concrete
   repair of one defect stays a task, inside the admission caps; the rest
   stay in the minutes as *not raised* with the reason (docs/improvements.md
   §3). An action task the admission gate refuses is noted on the minutes
   (and, in a retro, parked as a proposal).
4. **Document.** Markdown written through `WorkspaceFs`, authored by the
   facilitator agent (`system` when there is none):
   - a unit's meeting → `/org/meetings/<unit-slug>/<yyyy>/<yyyy-mm-dd>-<kind>.md`
     (the unit's meetings together, a year per folder; the agenda the chief
     prepares sits beside it as `…-<kind>-agenda.md`; the path comes from
     `orgPath.minutes` in `server/src/files/layout.ts`)
   - a meeting in a channel that is not a unit channel → `/channels/<slug>/meetings/<yyyy-mm-dd>-<title-slug>.md`
     (the channel's folder, so it shows in the channel's Files tab; an
     ad-hoc `/meeting` is titled "Meeting: <first words of the agenda>")

   Dates are server-local. A second meeting at the same path the same day
   gets `-HHMM` appended; nothing is overwritten.
5. **Record and posts.** `org_meetings.minutesPath` and `summary` (migration
   `0049-meeting-minutes`) are set; the structured minutes message in the
   thread links the file (so the thread's followers see it, `docs/follows.md`),
   and the one line in the channel ends with `· Minutes: /<path>` and carries
   the file as an attachment. The `meeting_end` audit row records the path and
   how the summary was written (`minutesBy: facilitator | model | record`).

### The minutes document

```markdown
# Minutes — Weekly review · Company

| | |
|---|---|
| When | Fri 2026-11-06 16:00–16:12 (server time) |
| Meeting | Weekly review · Company (#company) |
| Facilitator | Chief |
| Attendees | Chief, Writer, Editor (agents); Ann (people) |
| Ended | closed by the facilitator · 3 rounds · $0.42 · 12,400 tokens (9,800 in, 2,600 out) |
| Thread | #company · 1a2b3c4d |

## Agenda
## Summary
## Discussion            (key points, one line each)
## Decisions             (title — decision; decided by; `#decision:<id8>`; why; alternatives)
## Action items          (| Action | Owner | Due | Done when | Task |, the task linked to the board — or the proposal it became, or why it was not raised; approved / rejected noted)
## Open questions and risks  (answers given in the room included)
## Parking lot           (when something was parked; each with its backlog task)
## Lessons               (retros only)
## Next meeting          (the unit's next fire of the same cadence, or none)
```

The Due column is the action's `due` when the proposer gave one (it is the
task's `dueAt`), else "—"; the done-when rubric is the commitment. Action items link only the tasks the meeting
machinery created; there is no second task system.

## The list and the calendar

`GET /api/workspaces/:id/meetings?unitId=&channel=&from=&to=` (no model):

- **past and current** — the meeting rows whose start (or scheduled time)
  falls in the range, with status, facilitator, attendees (agents and
  people, by name), `minutesPath`, `summary`, counts of decisions and
  actions, the thread;
- **upcoming** — each enabled cadence of a kind the company holds (and that
  its mode allows) expanded from its cron between now and `to`
  (`source: 'cadence'`, `status: 'upcoming'`, at most 200 per cadence; a
  retro keeps its two-week gap from the last run). Titles name the unit
  ("Standup · Company", "Standup · Writer"), so two units' 09:30 standups
  are told apart.
- **filters** — `unitId`; `channel` (slug or id: the meetings held in it and
  the cadences of the unit whose channel it is); `from` / `to` as ISO or
  `yyyy-mm-dd` (a date `to` includes that day). Defaults: 30 days either side
  of now; at most 93 days per request. A workspace without an organization
  answers `{ hasOrg: false, meetings: [] }`.

### Cost

Every meeting keeps the tokens its turns and its minutes call used
(`org_meetings.tokensIn` / `tokensOut`, migration 0050) next to its USD. The
room header, the Meetings list (running and held meetings), the calendar
endpoint, the minutes message, the channel line and the minutes document
show them.

### Start a meeting

Company → Meetings and every channel's Meetings tab have **Start meeting**
(`src/components/MeetingStartDialog.tsx`): kind, the unit (or the channel),
the attendees — the unit's or the channel's agents, and "Me (join the
room)" — a title and the agenda. It calls `POST …/org/meetings` (the same
start path as `/meeting`); a channel that is not a unit channel is
facilitated by the chief when it attends, else the first agent picked.

In the SPA (`src/components/MeetingsBoard.tsx`, helpers in
`src/lib/meetings.ts`) the same component sits in **Company → Meetings**
(the company, or the unit picked in the unit chips) and in each channel's
**Meetings** tab:

- **List** — upcoming (soonest first, a running meeting on top), then past
  (latest first), each with when, the cadence in words, the facilitator, the
  summary, tokens and $, and buttons for the minutes and the thread —
  **Join** for a running meeting (present in the room, then the full-screen
  room), **View** for one held or scheduled (the full-screen room; its
  summary once it ended).
- **Calendar** — a Monday-first month grid (three meetings per day, "+N
  more" lists the day); at phone width the week's agenda instead. Previous /
  Today / Next move the range.
- Clicking a past meeting opens its minutes file in Artifacts; an upcoming
  one (or one without minutes yet) opens its details: when, the cadence in
  words, facilitator, attendees, the thread.

The view choice is remembered per browser; the data refreshes every minute.
