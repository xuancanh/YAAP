# Meetings: lifecycle, minutes and the calendar

A meeting is a bounded ritual held in a channel thread (the design is
`docs/company-vision.md` §3; the mechanics are `docs/group-chat.md` §8). This
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
| `running` | the agenda is posted as the thread root; rounds run (one turn per agent attendee in the first round; later rounds only those with an open thread; at most three rounds plus Extend, one for a standup) |
| `done` | the meeting ended: the facilitator closed it (`meeting_close`), the rounds ran out, everyone passed in a round, the agenda items were done, the per-meeting USD cap was reached, a person pressed End, or a person said "stop" / "end meeting" in the thread |
| `skipped` | a scheduled ritual (created by its cadence, with no agenda of a person's) had nothing on its agenda and skipped itself without a model call (`meeting.autoSkip`) |
| `cancelled` | before it started: the daily cap, no channel, the kill switch, a prepared meeting whose cadence did not fire; or while running: the API cancel or the kill switch, effective at the next turn |

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

In the SPA (`src/components/MeetingRoom.tsx`) the room heads the thread
panel of ChannelView (full width on a phone): the items with the current
one, "Round N of M", the item's minutes against its box and the meeting's
elapsed time against the whole box, tokens and $, the attendee strip, Join
and the controls; before the start, the pre-read and the proposal box.
`ProposalActions` draws Approve / Reject and Answer under the proposals.


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
   rejected proposals are skipped. A cancelled meeting executes nothing.
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
## Action items          (| Action | Owner | Due | Done when | Task |, the task linked to the board; approved / rejected noted)
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
  **Join** for a running meeting (present in the room, then the thread),
  **View** for one held.
- **Calendar** — a Monday-first month grid (three meetings per day, "+N
  more" lists the day); at phone width the week's agenda instead. Previous /
  Today / Next move the range.
- Clicking a past meeting opens its minutes file in Artifacts; an upcoming
  one (or one without minutes yet) opens its details: when, the cadence in
  words, facilitator, attendees, the thread.

The view choice is remembered per browser; the data refreshes every minute.
