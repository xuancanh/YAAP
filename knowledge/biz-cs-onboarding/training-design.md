---json
{ "title": "Training design", "summary": "How to design role-based customer training that changes what users do, with a session plan template and follow-up checklist.", "tags": ["training", "onboarding", "enablement", "template"], "updated": "2026-11-04" }
---

# Training design

Training works when users leave able to do their real tasks, not when they have seen every feature. Design backwards from the tasks each role must perform in the first weeks.

## Start from tasks, not features

For each user group, write the three to five tasks they must do to reach first value. For example, a support agent: answer a ticket, use a macro, escalate to tier two, find a customer's history. A team lead: assign work, read the queue report.

Everything not on that list goes in follow-up material, not the session.

## Session plan template

```
Audience: role, number of people, current tool
Goal: by the end, they can … (list the tasks)
Prerequisites: accounts created, sample data loaded, sandbox ready
Agenda:
  1. Why this matters to them (2–3 minutes, tied to the first value milestone)
  2. Task 1: show, then they do it
  3. Task 2: show, then they do it
  …
  N. Where to get help
Check: each person completes one real task before leaving
Materials: quick reference, recording, links to help articles
```

## Show, do, check

For each task:

1. **Show** it once, slowly, with their own data or realistic sample data.
2. **Do**: they repeat it themselves straight away. Watching is not learning.
3. **Check**: confirm each person finished. Note who struggled for a follow-up.

Keep each segment short. If a task needs long explanation, the configuration may be wrong; tell the project owner.

## Tailor by role

| Role | Focus |
|---|---|
| **Admins** | setup, permissions, user management, where settings live, how to get support |
| **Daily users** | the core tasks, shortcuts, what to do when stuck |
| **Managers** | reports, assigning work, checking adoption |
| **Occasional users** | one or two tasks only, a one-page guide |

## Follow-up materials

- [ ] Recording, trimmed, with chapter markers if the tool supports them
- [ ] One-page quick reference per role: the tasks, in order, with screenshots
- [ ] Links to the relevant public help articles
- [ ] A named contact for questions during the first weeks
- [ ] A follow-up check a few days later: are people doing the tasks? (see first-week usage in [onboarding metrics](onboarding-metrics.md))

## Accessibility and inclusion

- Share materials before the session for people who prefer to read first.
- Use captions on recordings where the tool supports them.
- Describe what you click, not just "click here", so people listening can follow.
- Offer time zone–friendly repeats for distributed teams.

## Pitfalls

- **Feature tour.** Showing everything means remembering nothing.
- **Training before setup.** If accounts, data or permissions are not ready, the "do" part fails. Check prerequisites the day before.
- **Training once.** New hires on the customer side need the same path; leave them the materials and the recording.
- **No measure.** Attendance is not success. Check behaviour in the product afterwards.
