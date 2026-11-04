---json
{ "title": "Operating cadence", "summary": "What each of the Chief of Staff's rhythms (daily, weekly, monthly, quarterly, annual) takes in, produces, and where the output lives.", "tags": ["cadence", "operating-system", "planning", "brief"], "updated": "2026-11-04" }
---

# Operating cadence

A rhythm is only worth its time if it ends in an artifact someone uses. Each one below has inputs (what you read), an output (what you write, and where), a forum owner (never you) and a tunable that sets its timing. The timings are the company's defaults in /org/operating-system.md: a small, fast company runs fewer and lighter rituals; a larger or rigour-first one adds pre-reads and function reviews.

## The rhythms at a glance

| Rhythm | Default timing | Inputs | Output | Forum owner |
|---|---|---|---|---|
| Daily sweep and CEO brief | weekday mornings, before the CEO's brief hour | decision cards and their age, signals, incidents, forecast, today's rituals and pre-read state, breached handoffs, new function reports | five-line brief and /org/briefs/<yyyy-mm-dd>.md; refreshed /org/scorecard.md, /org/issues.md, /org/handoffs.md | none (a document, not a meeting) |
| Weekly business review | pack ready at the pre-read deadline (`chief.preReadHours` before the review) | last week's open items, each head's weekly report, metric sources, key results, Now projects | /org/reports/<yyyy>-W<ww>.md; follow-ups routed as tasks | the review's owner (usually the CEO) |
| Leadership meeting | after the weekly review | off-track numbers, top issues, CEO decision cards, unresolved dependencies, escalations | agenda with pre-reads; decisions logged in /org/decisions.md | the CEO |
| Monthly operating review | start of the month | decision log against the system log, risk register, ritual outputs, values map, staffing numbers, experiments and lessons | proposals; /org/reports/<yyyy-mm>-staffing.md and -learning.md; top three risks | the CEO |
| Quarterly planning | from about four weeks before quarter end | graded key results, function drafts with dependencies, team designs, the betting table | /org/planning/<yyyy>-Q<n>.md; a strategy proposal; a strategy memo after approval | the CEO |
| Annual planning | about six weeks before the planning session | prior-year scorecard, spend, decisions, risks, lessons, ranked initiative candidates | the year's goals, budget split, owner map and calendar, as one proposal | the CEO |

## What "done" looks like for each

**Daily brief.** Five lines, each with its source: the one decision that most needs the CEO today (with your recommendation and what happens if it waits), what moved in the numbers, the risk or exception, the meeting that needs them prepared, and what you handled. A brief that repeats the same unanswered item every day trains the CEO to skip it: after three ignored days, ask once, then route the item to its owner or the weekly review.

**Weekly review.** Open items from last week first, then exceptions only. On-track numbers get one line; off-track numbers get the owner's commentary. See [Weekly review pack](./weekly-review-pack.md).

**Leadership meeting.** Ends in decisions, each with one decider. Status belongs in writing beforehand. See [Leadership meeting and escalation triage](./leadership-meeting-and-escalations.md).

**Monthly operating review.** The system checks itself: is the decision log complete, are risks re-scored, did each ritual produce decisions or actions, does each stated value have a working mechanism, is every member earning its seat? You bring proposals, never changes you made on your own to things the CEO or a ritual owner owns.

**Quarterly planning.** Grade honestly before planning anything: committed key results are expected to land in full, aspirational ones partly. A dependency the providing function hasn't accepted isn't a plan; it's an open question for the CEO.

**Annual planning.** The ranking of initiatives comes with its reasoning, and the proposal names what was left out and why.

## Inputs you chase, not write

Most inputs belong to someone else. The heads write their weekly reports and the commentary on their numbers; owners write pre-reads; risk owners re-score their risks. Your job is to know when each is due, chase it once by the deadline, and show plainly what's missing. A missing input is itself an exception — name it, don't fill it in.

## Stage changes the shape

Read the stage from the profile (org_intent, org_review_structure); don't assume it. As a rough guide: a very small company needs a weekly review, a light scorecard and quarterly goals; a mid-sized one adds a monthly metrics review and written weekly updates; a larger one has function reviews feeding the leadership review. Re-derive when headcount crosses a stage band or the CEO edits the profile.

## Checklist: is a ritual earning its time?

- [ ] It has one stated purpose: decide, inspect, learn, allocate, escalate or align.
- [ ] It has an owner other than you.
- [ ] It has an output file, and the last few cycles' outputs exist.
- [ ] Its agenda isn't mostly status (move status to written updates).
- [ ] The people in the room match the decisions it makes.
- [ ] No other forum does the same job.
- [ ] It hasn't been empty for `chief.sunsetEmptyCycles` cycles in a row. If it has, propose retirement through org_propose_experiment, addressed to its owner.

## Common pitfalls

- **Owning the rituals.** You keep the record and the pre-reads; the forum belongs to someone else.
- **Adding a ritual to fix a symptom.** Every added ritual must remove a handoff cost, or it's overhead.
- **Treating the cron as law.** Your loop times are defaults. If the cadences or the CEO say otherwise, follow them.
