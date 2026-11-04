---json
{ "title": "Onboarding metrics", "summary": "Definitions and formulas for time to value, onboarding completion and first-week usage, with how to report them honestly.", "tags": ["metrics", "time-to-value", "onboarding", "adoption"], "updated": "2026-11-04" }
---

# Onboarding metrics

Three metrics tell you whether onboarding works. Define the start and end points the same way every time, or the trend means nothing.

## Time to value (TTV)

```
TTV (days) = date first value milestone confirmed − contract start date
```

- **Start point**: use the contract start date (or signature date, if the company prefers). Choose one, write it down and keep it.
- **End point**: the date the customer confirms the milestone agreed at kickoff, not the go-live date.
- **Report** the median across onboardings completed in the period, plus the count. One very slow enterprise onboarding distorts an average; the median resists that.
- **Segment** by plan or customer size; a small self-serve customer and a large enterprise have different normal ranges.

Also track **time to kickoff** (`kickoff date − contract start date`). Delay before kickoff is often the easiest days to remove.

## Onboarding completion

Two views, both useful:

```
Completion rate = onboardings that reached first value in the period
                  ÷ onboardings that were due to reach it in the period
```

```
Checklist completion (per account) = steps done ÷ steps in plan
```

"Due" means the agreed target date fell in the period. Report onboardings still open past their target separately as **overdue**, with the reason.

## First-week usage

Measures whether trained users actually start working in the product.

```
First-week usage = users active in the 7 days after go-live
                   ÷ users invited at go-live
```

- Define "active" as performing a core task, not just signing in. Pick the task from the training plan (for example, "resolved a ticket").
- Read the numbers from product analytics; label any self-reported number as such.
- Break down by user group so you can follow up with the team that lags.

## Leading indicators to watch

These tell you early that a metric will miss:

- Days since the last completed step
- Customer-side tasks past due
- Training sessions rescheduled
- Admins who have not signed in after setup

## Reporting template

```
Period: <dates>  Source: <CRM / product analytics>, pulled <date>
Onboardings completed: n   Median TTV: x days (range a–b)
Completion rate: y% (m of k due)   Overdue: list with reason
First-week usage: z% (median across go-lives)
What changed: …   What we'll do next: …
```

## Pitfalls

- **Moving the goalposts.** Redefining first value mid-onboarding to hit a date makes TTV meaningless. If the milestone must change, log the reason and keep the original date in the record.
- **Counting go-live as value.** Users can be live and still not get the outcome.
- **Averages on small samples.** With a handful of onboardings, show each one, not just a summary statistic.
- **Ignoring stalled accounts.** Excluding onboardings that never finished makes TTV look better than it is; report them.
