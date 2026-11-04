---json
{ "title": "Dashboard design checklist", "summary": "How to design a dashboard around the decisions it supports, choose charts, show definitions, and decide when to retire it.", "tags": ["dashboards", "data visualisation", "design", "checklist"], "updated": "2026-11-04" }
---

# Dashboard design checklist

A dashboard is used when it answers a recurring question faster than asking you. Design it from the questions, not from the data available.

## Before you build

- [ ] **Audience:** who opens it, how often, and on what device?
- [ ] **Questions:** the three to five questions it must answer, in that person's words. "Are we on track for the quarter's signup target?" not "signups".
- [ ] **Decisions:** what would they do if the answer were bad? If nothing, the chart may not belong.
- [ ] **Existing dashboards:** does one already answer this? Extend it rather than adding another.
- [ ] **Metric definitions:** every metric is in `/org/data/metrics.md`. Missing ones are proposed and agreed first.

## Layout

- **Top left is the answer.** The most important number or status goes where the eye lands first, with its target and trend.
- **Overview, then detail.** Headline numbers at top; breakdowns below; raw tables last or on a separate tab.
- **One question per section**, with a plain heading that is the question.
- **Consistent filters** at the top that apply to everything, with defaults that match the main use (for example, this quarter, excluding test accounts).
- **Few charts.** If it needs scrolling through many charts, split it by audience.

## Choosing charts

| To show | Use | Avoid |
|---|---|---|
| A value against a target | Number with target and change; bullet chart | Gauges and dials (hard to read precisely) |
| Change over time | Line chart | Pie charts; 3D anything |
| Comparison across categories | Horizontal bar, sorted | Unsorted bars; too many colours |
| Part of a whole, few parts | Stacked bar | Pie with many slices |
| Distribution | Histogram | Averages alone |
| Exact values people look up | Table | Charts with data labels everywhere |

Rules for every chart:

- Start bar-chart axes at zero. Line charts may zoom, but say so on the axis.
- Label units (%, currency, per week) and the time zone where it matters.
- Use colour to mean something (over/under target, one highlighted series), not for decoration.
- Show counts next to rates when counts are small.

## Definitions shown

- [ ] Each metric has a tooltip or footnote with its catalogue definition and link.
- [ ] Data freshness is visible: "Data as of <time>".
- [ ] Known caveats are on the page (a tracking gap in a date range, a definition change).
- [ ] The owner is named, so people know whom to ask.

## Before you publish

- [ ] Numbers match a trusted source for one period (see [query hygiene](query-hygiene.md)).
- [ ] Filters behave as expected in combination.
- [ ] It loads in reasonable time; slow dashboards do not get opened.
- [ ] Access matches the data: personal or sensitive data is visible only to those who need it.
- [ ] Walk the main user through it once and watch where they hesitate.

## Usage and retirement

A dashboard nobody opens still costs maintenance and confuses people when it disagrees with another one.

- Check usage on a regular schedule (views and distinct viewers per period, if your tool shows them).
- For low-use dashboards, ask the owner whether it is still needed. Seasonal use is fine.
- Retire by announcing, waiting a short period, then archiving with a pointer to the replacement.

Track usage with the formula in [KPI pack template and analyst metrics](kpi-pack-and-metrics.md).

## Pitfalls

- Building everything the requester listed. Push back to the questions and decisions.
- Two dashboards with different numbers for the same metric. Use the same mart and definition; retire the duplicate.
- No target. A number without a comparison invites "is that good?" every time.
