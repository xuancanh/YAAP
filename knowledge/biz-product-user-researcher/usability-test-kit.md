---json
{ "title": "Usability test kit", "summary": "Write realistic tasks, run think-aloud sessions without leading, record the standard measures, and rate issues by severity using frequency, impact and persistence.", "tags": ["usability-testing", "severity", "tasks", "think-aloud"], "updated": "2026-11-04",
  "sources": [{ "title": "Nielsen Norman Group, Severity Ratings for Usability Problems, accessed 2026-11-04 (via secondary summaries; page blocked automated fetch)", "url": "https://www.nngroup.com/articles/how-to-rate-the-severity-of-usability-problems/" }] }
---

# Usability test kit

A usability test answers "can people do this?" by watching them try. Its value comes from realistic tasks, a facilitator who stays out of the way, and issues rated consistently enough that the team fixes the right ones first.

## Writing tasks

A good task gives a goal and context, not instructions.

| Weak | Strong |
|---|---|
| "Click Reports and use the filter." | "Your manager wants October's spend for the Ops team. Find it." |
| "Try the export feature." | "You need this month's numbers in your finance spreadsheet. Get them there." |

For each task, write:
- **Scenario** (the goal, in the user's terms, without UI words).
- **Success criteria:** what end state counts as done.
- **Expected path:** for your reference only; never show it.
- **Time expectation:** a rough limit after which you'll note it as a struggle.

Order tasks the way a real user would meet them. Start with an easy one to settle the participant.

## Running a session (think-aloud)

1. Explain: "We're testing the design, not you. Please think out loud as you go."
2. Give one task at a time, in writing if remote.
3. **Don't help.** If asked "Should I click this?", reply "What would you do if I weren't here?"
4. Prompt only when they go silent: "What are you thinking now?"
5. Let them fail. Stop a task only at the time limit or if they're distressed, and note it as a failure.
6. After each task: "How did that go?" After all tasks: what was easiest, what was hardest.

## What to record per task, per participant

| Measure | Definition |
|---|---|
| Success | Completed / completed with difficulty / failed (agree the rules before the first session) |
| Time on task | From reading the task to reaching the end state or giving up |
| Errors | Wrong paths taken, with where they went |
| Quotes | Verbatim, with timestamp |
| Assists | Any help given; a task with help counts as not independently completed |

**Task success rate** = participants who completed the task (without assists) ÷ participants who attempted it. With small samples, report as "4 of 5" rather than a percentage.

## Rating severity

Nielsen's widely used approach rates severity from three factors:

- **Frequency:** how many users hit it.
- **Impact:** how hard it is to overcome when they do.
- **Persistence:** a one-time problem users learn past, or one that bothers them every time.

His scale runs 0–4: 0 not a usability problem, 1 cosmetic, 2 minor, 3 major, 4 catastrophe that must be fixed before release. Your playbook uses three levels; map them like this:

| Playbook level | Nielsen scale | Meaning |
|---|---|---|
| Blocker | 4 | Users can't complete the task, or lose data or money |
| Major | 3 | Users complete it with significant difficulty, errors or time |
| Minor | 1–2 | Annoyance or confusion that users get past |

Rate together with a second reviewer where possible; single-person ratings vary. Write the evidence beside each rating so others can check it.

## Report structure

```
Study: <name>  Prototype/build: <version>  Participants: n (segment)
Tasks and success: | Task | Success (x of n) | Median time | Notes |
Issues:
| # | Issue | Where | Severity | Frequency (x of n) | Evidence | Suggested fix |
What worked well:
Recommended next round: <what to retest after fixes>
```

Blockers become backlog tasks for the Product Owner with the evidence attached.

## Pitfalls

- Tasks that contain the UI's words, so participants just look for the matching label.
- Explaining the design mid-session.
- Counting a helped completion as a success.
- Reporting issues without frequency, so a single participant's confusion looks like a pattern.
- One big test at the end instead of small rounds with fixes between.
