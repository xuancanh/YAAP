# Meetings: lifecycle, minutes and the calendar

A meeting is a bounded ritual held in a channel thread (the design is
`docs/company-vision.md` §3; the mechanics are `docs/group-chat.md` §8). This
page covers what every meeting leaves behind — its **minutes** — and where
people find meetings past and coming: the **list** and the **calendar**.
Meetings need organization mode; every meeting is a row of `org_meetings`.

## Lifecycle

| Status | How it gets there |
|--------|-------------------|
| `scheduled` | created: a cadence fired on the minute tick, `/meeting [kind] [#unit] [agenda…]` in a channel, Start meeting in the Company → Meetings pane, or `POST …/org/meetings` |
| `postponed` | quiet hours at start; the tick retries when the window ends |
| `running` | the agenda is posted as the thread root; rounds run (one turn per agent attendee, at most three rounds, one for a standup) |
| `done` | the meeting ended: the facilitator closed it (`meeting_close`), the rounds ran out, the per-meeting USD cap was reached, or a person said "stop" / "end meeting" in the thread |
| `cancelled` | before it started: the daily cap, no channel, the kill switch; or while running: the API cancel or the kill switch, effective at the next turn |

Upcoming meetings are not rows: they are the cadences (`org_cadences`, a
five-field cron per unit and kind, server-local time) expanded on demand.

## Minutes at the end

When a meeting that started ends — any of the `done` paths, or a cancel
while running — `OrgMeetingRuntime` hands the record to
`OrgMeetingMinutesService` (`server/src/org/meeting-minutes.service.ts`):

1. **Narrative.** The summary is the facilitator's own `meeting_close` note
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
2. **Execution** (unchanged, no model): actions become briefed tasks on the
   unit board, decisions decision-log rows, risks audit rows, questions go to
   the CEO's brief. A cancelled meeting executes nothing.
3. **Document.** Markdown written through `WorkspaceFs`, authored by the
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
4. **Record and posts.** `org_meetings.minutesPath` and `summary` (migration
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
| Ended | closed by the facilitator · 3 rounds · $0.42 |
| Thread | #company · 1a2b3c4d |

## Agenda
## Summary
## Discussion            (key points, one line each)
## Decisions             (title — decision; decided by; `#decision:<id8>`; why; alternatives)
## Action items          (| Action | Owner | Due | Done when | Task |, the task linked to the board)
## Open questions and risks
## Lessons               (retros only)
## Next meeting          (the unit's next fire of the same cadence, or none)
```

Board tasks carry no due date, so the Due column reads "—"; the done-when
rubric is the commitment. Action items link only the tasks the meeting
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

In the SPA (`src/components/MeetingsBoard.tsx`, helpers in
`src/lib/meetings.ts`) the same component sits in **Company → Meetings**
(the company, or the unit picked in the unit chips) and in each channel's
**Meetings** tab:

- **List** — upcoming (soonest first, a running meeting on top), then past
  (latest first), each with when, the cadence in words, the facilitator, the
  summary, and buttons for the minutes and the thread.
- **Calendar** — a Monday-first month grid (three meetings per day, "+N
  more" lists the day); at phone width the week's agenda instead. Previous /
  Today / Next move the range.
- Clicking a past meeting opens its minutes file in Artifacts; an upcoming
  one (or one without minutes yet) opens its details: when, the cadence in
  words, facilitator, attendees, the thread.

The view choice is remembered per browser; the data refreshes every minute.
