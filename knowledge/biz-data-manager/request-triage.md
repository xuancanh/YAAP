---json
{ "title": "Data request triage", "summary": "An intake template, the clarifying questions, a sizing guide and a simple priority rule for analytics requests, plus how turnaround is measured.", "tags": ["data", "requests", "intake", "prioritisation"], "updated": "2026-11-04" }
---

# Data request triage

The data-request-intake playbook says to clarify, size, prioritise and
route. This doc gives the forms and the rules of thumb, so intake takes
minutes per request and requesters know what to expect.

## The intake row

Each request gets a row in `/org/data/requests.md` and, once accepted, a
briefed task.

```markdown
| id | Requester | Question (as asked) | Decision it informs | Deadline (why) | KR served | Size | Status | Owner | Expected |
|---|---|---|---|---|---|---|---|---|---|
| DR-31 | Marketing head | "Which channel brings the best customers?" | Shift Q1 spend between paid search and partners | 12 Dec (budget lock) | CAC payback KR | M | accepted | BI Analyst | 9 Dec |
```

## Clarifying questions

Ask these on the request (`org_task_comment`), not in a meeting. Most
requests change shape after the first two.

1. What will you do differently depending on the answer?
2. What answer do you expect? (Shows the hypothesis, and whether a quick
   check would do.)
3. Which definition: whose "active", "customer", "churn"? Point at the
   catalogue.
4. What period, which segment, what's excluded?
5. When is it needed, and what happens if it's late?
6. Would a rough answer today beat a precise one next week?

No decision attached after asking: decline politely, or offer an existing
dashboard. Curiosity requests can queue behind decision requests.

## Sizing

| Size | What it is | Typical route |
|---|---|---|
| S | Answered by an existing dashboard, saved query or prior answer | BI Analyst; often same day |
| M | New analysis on modelled, catalogued data | BI Analyst or Data Scientist |
| L | Needs new modelling, a new source or a new metric definition | Analytics Engineer first, then analysis |
| XL | A project: multiple sources, an experiment, a forecast model | `org_create_project` with an appetite |

Always check `/org/data/answers/` and `org_decisions` before sizing; the
cheapest answer is the one already written.

## Priority rule

Score and sort; your judgment breaks ties.

```text
priority = decision value (1–3) × urgency (1–3) ÷ size (S=1, M=2, L=3, XL=5)
decision value: 3 = moves a company key result or a large spend; 1 = nice to know
urgency:        3 = a fixed decision date this week; 1 = no date
```

Requests that feed a key result check-in or a data-quality incident skip
the queue.

## Writing the brief

The task's outcome is the decision, not the chart. Constraints name the
definitions to use and the privacy rules. done_when: the saved, re-runnable
query; totals reconciled with the source; a one-paragraph answer stating
the number, its confidence and its caveats; filed in `/org/data/answers/`.

## Turnaround

```text
request turnaround = median of (answered_at − requested_at), in working days
```

Write down whether the clock starts at the request or at acceptance after
clarification, and whether declined requests count. Starting at acceptance
looks better and hides slow clarification; whichever you pick, keep it.

## Common pitfalls

- **Answering the question as asked.** "Best channel" by signups may be
  the worst by revenue. Answer the decision.
- **Queue by loudness.** The rule exists so the most senior requester
  doesn't always win.
- **Silent waiting.** Every request has a status and an expected date;
  update it when it slips.
- **Bespoke everything.** The same M request three times is a dashboard or
  a modelled table waiting to be built.
