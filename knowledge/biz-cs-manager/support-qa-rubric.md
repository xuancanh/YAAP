---json
{ "title": "Support QA rubric", "summary": "A scored rubric for reviewing sampled support tickets on correctness, resolution, communication and process, with coaching notes.", "tags": ["support", "quality", "qa", "rubric", "coaching", "audit"], "updated": "2026-11-04" }
---

# Support QA rubric

Use this to score the tickets you sample in the monthly KPI audit (10 by default) and when coaching a member. The rubric makes quality comparable across reviewers and over time, and turns "this felt off" into a specific coaching note. Adapt the weights to the company's profile. A "trust first" profile might weight correctness higher still.

## Rubric

Score each line 0 (missed), 1 (partly) or 2 (fully). Lines marked **critical** fail the ticket on a 0, whatever the total.

| Area | Criterion | Critical? |
|---|---|---|
| Correctness | The answer is accurate and matches the knowledge base or the product's real behaviour | Yes |
| Correctness | No promises outside policy (refunds, credits, roadmap dates, contract terms) | Yes |
| Correctness | No personal or sensitive data exposed; identity verified where policy requires | Yes |
| Resolution | Solved the real problem, not just the literal question | |
| Resolution | Complete in one reply where possible; asked all needed questions at once if not | |
| Resolution | Closed only after customer confirmation or the policy timeout | |
| Communication | Clear, plain language; steps the customer can follow | |
| Communication | Tone fits the customer's state (frustrated, urgent, casual); acknowledges impact | |
| Communication | Owns the next step and says when they'll hear back | |
| Process | Priority and category correct; SLA clock handled honestly (no status games) | |
| Process | Escalated or linked to a bug or engineering task when needed | |
| Process | Knowledge gap noted when the knowledge base was missing or wrong | |

**QA score (%)** = points scored ÷ points possible × 100, and a ticket with any critical 0 is marked failed. Report the median score and the number of failed tickets, per member and overall, in the audit file.

## Reviewer template

```markdown
| Ticket | Member | Score % | Critical fail? | Strength (SBI) | Change (SBI) | Follow-up |
|---|---|---|---|---|---|---|
| #1234 | Support Specialist A | 83 | No | Clear steps with screenshots | Asked for logs in a second reply; ask once | KB: add log-collection steps |
```

Write each note as Situation, Behaviour, Impact: "On ticket #1234 (S), you asked for logs only after the first fix failed (B), which added a day to resolution (I)."

## Calibration between reviewers

Once a month, two reviewers score the same three tickets independently and compare. Where they differ by more than one point on a line, agree what the criterion means and add an example to this rubric in `/org/customer/processes/`. Without calibration, QA scores measure the reviewer.

## Worked example (made-up)

A billing ticket: the reply correctly explains the invoice (2), makes no promises (2), verifies the account (2), answers the real question of why the charge went up (2), but takes two replies to gather details (1), closes the ticket the same day without confirmation (0), is clear (2), with a fine tone (2), and gives no next step (0). Process lines score 2, 2 and 1. Total 18 of 24 = 75%, with no critical fails. Coaching: confirm before closing, and always say what happens next.

## Using the results

- A member's pattern (the same line missed three times) becomes their coaching point in `/org/customer/team.md`.
- A pattern across members is a process or knowledge base fix. File it as a task.
- A critical fail is fixed with the customer first, if needed (a corrected answer drafted for approval), then coached.
- Track QA alongside CSAT and reopen rate. A high QA score with low CSAT means the rubric is missing something customers care about.

## Common pitfalls

- **Sampling only easy tickets.** Include escalated, reopened and low-CSAT tickets in the sample.
- **Scoring tone above correctness.** A friendly wrong answer is worse than a curt right one.
- **QA as punishment.** Share strengths too, and keep the focus on the next ticket.
- **Never updating the rubric** as the product and policy change.
