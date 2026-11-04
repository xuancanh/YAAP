---json
{ "title": "Design metrics and formulas", "summary": "Definitions and formulas for task success, time on task, SUS (with its scoring), design-system adoption, cycle time and rework rate, with worked examples.", "tags": ["metrics", "sus", "usability-testing", "kpis", "design"], "updated": "2026-11-04",
  "sources": [
    { "title": "Measuring Usability with the System Usability Scale (SUS)", "url": "https://measuringu.com/sus/", "author": "Jeff Sauro", "publisher": "MeasuringU", "accessed": "2026-11-04", "note": "Scoring method; average of 68 across about 500 studies." },
    { "title": "Average Task Times in Usability Tests: What to Report?", "url": "https://measuringu.com/wp-content/uploads/2017/07/Sauro_Lewis_CHI2010.pdf", "author": "Jeff Sauro, James R. Lewis", "publisher": "CHI 2010", "date": "2010", "note": "Geometric mean recommended for small samples." }
  ] }
---

# Design metrics and formulas

Write each definition in `/org/design/kpis.md` before setting a target. Usability numbers come from small samples, so always report the counts with the rates, and treat week-to-week changes of one or two participants as noise.

## Task success rate

**Task success** = participants who completed the task unaided and correctly ÷ participants who attempted it.

Write the success criteria for each task before the session (what end state counts, whether a hint means failure). Report per task, not one blended rate across tasks. With 8 participants, 6 of 8 is honest; "75%" alone overstates precision.

## Time on task

Measure from the task prompt to the success state. Usability task times are skewed (a few people take much longer), so the arithmetic mean misleads. Sauro and Lewis (2010) recommend the **geometric mean** for small samples: take the log of each time, average the logs, then convert back (exp of the mean of ln(time)). Report it for successful attempts, and report failures separately rather than mixing in their times.

## System Usability Scale (SUS)

John Brooke created SUS in 1986 as a "quick and dirty" ten-item questionnaire. Participants answer each item from 1 (strongly disagree) to 5 (strongly agree) after using the product:

1. I think that I would like to use this system frequently.
2. I found the system unnecessarily complex.
3. I thought the system was easy to use.
4. I think that I would need the support of a technical person to be able to use this system.
5. I found the various functions in this system were well integrated.
6. I thought there was too much inconsistency in this system.
7. I would imagine that most people would learn to use this system very quickly.
8. I found the system very cumbersome to use.
9. I felt very confident using the system.
10. I needed to learn a lot of things before I could get going with this system.

**Scoring** for one participant:

- odd items (1, 3, 5, 7, 9): response − 1
- even items (2, 4, 6, 8, 10): 5 − response
- SUS = (sum of the ten converted values) × 2.5, giving 0–100.

The study score is the mean across participants. SUS is not a percentage. MeasuringU reports an average of 68 across about 500 studies; use that only as a reference point and let the company set its own target from its baseline.

### Worked example (one made-up participant)

Responses 1–10: 4, 2, 4, 1, 4, 2, 5, 2, 4, 2.
Odd items: (4−1)+(4−1)+(4−1)+(5−1)+(4−1) = 16.
Even items: (5−2)+(5−1)+(5−2)+(5−2)+(5−2) = 16.
SUS = (16 + 16) × 2.5 = 80.

## Process and system metrics

- **Design-system adoption** = shipped screens (or components on them) built from system components ÷ shipped screens audited. Write whether you count screens or component instances, and what counts as "from the system" (an overridden component may not).
- **Design cycle time** = days from brief accepted to design approved, per item. Report the median and the slowest item, since one stuck brief can hide behind an average.
- **Rework rate** = shipped designs reopened within 30 days ÷ designs shipped in the period. Define "reopened" (a new task linked to the design for a defect or a missed requirement, not a planned iteration).
- **Accessibility conformance**: see the [accessibility checklist](./accessibility-checklist.md).

## Reporting rules

- Same tasks, same success criteria, same kind of participants across rounds, or the trend is meaningless; when they change, start a new series and say so.
- Label the source on every number: usability round <date>, audit <month>, analytics.
- Participants recruited from colleagues or the team are a pilot, not a measurement.

## Common pitfalls

- Averaging task success across different tasks.
- Arithmetic mean of task times, with failed attempts mixed in.
- Reporting SUS item by item, or forgetting to reverse the even items.
- Cycle time that starts at "work started" instead of "brief accepted", hiding queue time.
- Counting planned iterations as rework, which punishes good process.
