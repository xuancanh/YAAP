---json
{ "title": "Product Owner metrics", "summary": "Definitions and formulas for backlog readiness, spec rework rate and accepted versus committed stories, with counting rules and how each is gamed.", "tags": ["kpis", "metrics", "backlog-readiness", "spec-rework", "acceptance"], "updated": "2026-11-04" }
---

# Product Owner metrics

Your three KPIs measure whether engineering has good work to pull, whether your specs hold up, and whether sprints deliver what was planned. They are inputs to the outcome; the product's key results remain the real test.

## Backlog readiness (two sprints refined)

**What it answers:** if planning happened today, would the team have enough ready work for the next two sprints?

**Formula:** sum of estimates of ready items at the top of the backlog ÷ (2 × the team's average completed estimate per sprint over recent sprints), shown as a percentage. 100% or more means two sprints are ready.

If the team does not estimate in points, use item counts and average items completed per sprint instead. State which.

**Counting rules:**
- Count only items that pass the [readiness checklist](backlog-readiness.md).
- Count from the top of the ordered backlog down; ready items far down the list don't help next sprint.
- Measure at the same moment each cycle (for example, the day before planning).

**Gamed by:** marking items ready without engineering's estimate, or inflating estimates. Guard: readiness needs an estimate from engineering.

## Spec rework rate

**What it answers:** how often do specs or stories have to change after work starts because something was missing or wrong?

**Formula:** stories in the period that needed a material criteria or spec change after entering the sprint ÷ stories that entered sprints in the period.

**What counts as rework:**
- Acceptance criteria changed after the sprint started (other than typo fixes).
- A story rejected at acceptance because the criteria were wrong or incomplete, not because the build missed them.
- A new story created to cover a case the original spec should have covered.

**What does not count:**
- A story that failed acceptance because the build did not meet clear criteria (that is build rework).
- Planned follow-up slices.
- Changes driven by new evidence after launch (that is learning; record it separately).

Tag each rework instance with its cause: missing state, missing edge case, wrong assumption, unclear metric, missed dependency. The cause tally tells you which part of the [spec checklist](spec-template.md) to strengthen.

## Accepted stories versus committed

**What it answers:** does the team deliver what it planned in sprint planning?

**Formula:** stories accepted by the end of the sprint ÷ stories committed at sprint planning, per sprint. Show a rolling average over several sprints rather than one sprint.

**Counting rules:**
- Committed = in the sprint at the end of planning. Stories added mid-sprint are reported separately and excluded from the ratio.
- Accepted = passed acceptance review against its criteria by sprint end. Done-but-not-reviewed counts as not accepted; that points at your acceptance speed.
- Split stories: count the original as not accepted unless the accepted slice was agreed as the commitment during the sprint, and note the split.

**Reading it:** a low ratio can mean over-commitment, unready stories, mid-sprint disruption, or slow acceptance. Look at the cause before acting. This measure belongs to the whole team; use it to improve readiness and acceptance, not to judge engineers.

## Reporting

```
| KPI | This period | Rolling | Notes |
|---|---|---|---|
| Backlog readiness | 120% | | |
| Spec rework rate | 2/14 | | both: missing empty state |
| Accepted vs committed | 9/11 | | 1 awaiting acceptance at sprint end |
```

Pair each miss with its cause and the change you will make.
