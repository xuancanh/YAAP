---json
{ "title": "Usability testing guide", "summary": "How to plan, moderate and score a small usability test or heuristic review, with formulas for task success and time on task and a severity scale.", "tags": ["usability testing", "heuristic review", "metrics", "kpis", "research"], "updated": "2026-11-04",
  "sources": [
    { "title": "Nielsen Norman Group: 10 Usability Heuristics for User Interface Design (accessed 2026-11-04)", "url": "https://www.nngroup.com/articles/ten-usability-heuristics/" }
  ] }
---

# Usability testing guide

A small usability test answers one question: can the intended users complete the key tasks with this design? Your pack sets the default (three to five tasks, five participants, or a labelled heuristic review when no users are available). This guide covers how to do each well and how to score it consistently.

## Plan

```markdown
# Test plan: <slug> — <date>

Goal: <what decision this test informs>
Prototype: <link, version>
Participants: <criteria matching the frame's user>; screen-out: <employees, experts>
Format: <moderated remote / in person / unmoderated>

| # | Task scenario (what the participant reads) | Success criterion | Max time |
|---|---|---|---|
| 1 | "You've just imported last month's transactions. Five of them are in the wrong category. Fix them." | All five recategorised and saved | 5 min |
```

**Writing tasks:**

- Give a goal and context, not instructions. "Fix these five transactions", not "Click Bulk edit".
- Don't use the words on the buttons; you'd be testing word matching, not understanding.
- Define success before the test: what end state counts, and whether help or a wrong path first counts as a fail.
- Order tasks as a real user would meet them.

**Recruiting:** participants should match the frame's user. Colleagues who know the product hide real problems. If you can't recruit real users, say so and lower your confidence in the results.

**Consent:** tell participants what's recorded, how it's used and stored, that they can stop at any time, and that you're testing the design, not them. Follow the company's research and privacy rules.

## Run (moderated)

1. **Intro (2 minutes):** "We're testing the design, not you. There are no wrong answers. Please think aloud."
2. **Warm-up:** one or two questions about their current way of doing this job.
3. **Tasks:** read each scenario, then stay quiet. If they ask "what should I do?", reply "what would you do if I weren't here?" Note where they hesitate, what they try, and what they say.
4. **Don't rescue too early.** Let them struggle up to the time limit or until they give up. Record a fail, then move on (you can show them afterwards).
5. **Debrief:** "What was hardest?" "What did you expect to happen when…?"

Per task, record: success (yes / with difficulty / no), time, errors (wrong paths, mistakes), and quotes.

## Metric definitions

### Task success rate

```
Task success rate (task) = participants who met the success criterion / participants who attempted the task
Overall success rate     = successful task attempts / total task attempts
```

- Decide in the plan whether "succeeded with difficulty" counts as success; report it separately either way.
- With five participants, each person is a fifth of the rate. Report counts ("4 of 5") next to the percentage, and treat the number as directional.

### Time on task

```
Time on task = time from the end of reading the scenario to the success state (or giving up)
Report: median time for successful attempts; list failed attempts separately
```

Medians resist one slow participant. Think-aloud slows people down, so compare times between rounds of the same method, not against a production analytics figure.

### Errors

```
Error rate (task) = errors observed / attempts
```

Define what counts as an error (a wrong path taken, an incorrect entry, an action undone).

## Severity scale for issues

| Severity | Meaning | Action |
|---|---|---|
| **Blocks task** | Participant couldn't complete, or completed wrongly without knowing | Fix before handoff |
| **Slows** | Completed, with confusion, detours or errors | Fix before handoff if cheap; otherwise log |
| **Cosmetic** | Noticed, no effect on completion | Log |

Count how many participants hit each issue; an issue seen by several people outranks one seen once.

## Heuristic review (when no users are available)

Label it clearly as a heuristic review, not a usability test. It finds likely problems; it doesn't measure task success. Walk each task and check the design against Nielsen's ten usability heuristics:

1. Visibility of system status
2. Match between the system and the real world
3. User control and freedom
4. Consistency and standards
5. Error prevention
6. Recognition rather than recall
7. Flexibility and efficiency of use
8. Aesthetic and minimalist design
9. Help users recognize, diagnose, and recover from errors
10. Help and documentation

For each issue: the step, the heuristic, what's wrong, severity, suggested fix. A second reviewer working independently finds issues the first misses; merge the lists.

## Report

Save `/org/design/research/<slug>-<date>.md`:

```markdown
## Summary
Task success overall: 11/15 (73%). Main blocker: <issue>. Recommendation: <…>
## Per task
| Task | Success | Median time (successful) | Key issues |
## Issues by severity
| Issue | Severity | Participants | Evidence (quote/timestamp) | Recommendation |
## What worked
## Method notes and limits
```

If task success is a key result you own, check it in with `org_check_in`. Re-test the changed parts after fixes; one round rarely catches everything.
