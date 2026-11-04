---json
{ "title": "Pre-mortems", "summary": "How to run a pre-mortem: imagine the plan has already failed, list the reasons independently, then turn the strongest into fixes and risk-register entries.", "tags": ["risk", "pre-mortem", "planning", "facilitation"], "updated": "2026-11-04",
  "sources": [
    { "title": "Performing a Project Premortem", "url": "https://hbr.org/2007/09/performing-a-project-premortem", "publisher": "Harvard Business Review", "author": "Gary Klein", "date": "2007-09", "accessed": "2026-11-04" }
  ] }
---

# Pre-mortems

A post-mortem explains why something failed after the fact. A pre-mortem, described by Gary Klein in Harvard Business Review in 2007, does it before the work starts. You assume the plan has already failed, then explain why. Saying "it failed, why?" makes it normal to voice doubts that people would otherwise keep to themselves, because nobody wants to be the one attacking a plan everyone likes.

Use one before any big commitment: a launch, a quarter plan, a one-way-door decision, a hire, a large spend.

## How to run one

It takes well under an hour. It works with a group, and it also works alone when you write the plan yourself.

1. **Share the plan.** Everyone has the same short description: the goal, the approach, the dates. Link the plan file.
2. **Set the scene.** "It's <date after the deadline>. The project failed badly. What happened?" Make the failure definite. Don't ask "what *might* go wrong".
3. **Write reasons independently.** Each participant lists every plausible cause on their own, in a few minutes of silent writing, before anyone shares. This stops the first speaker setting the frame for everyone else.
4. **Collect one at a time.** Go round and take one reason from each person per round, until every list is empty. Write them all down without debating them yet.
5. **Pick the ones that matter.** Group duplicates. For each cause, ask how likely it is and how bad it would be. Keep the few that are both.
6. **Change the plan.** For each important cause, decide whether you change the plan now (mitigation) or prepare a response (contingency). Add each one to `/org/risks.md` as an if-then risk with an owner and a trigger (see [risk registers](./risk-registers.md)).
7. **Revisit.** Look at the list again at milestones. Some causes will have become more or less likely.

When you run one alone, deliberately take different viewpoints in step 3: the customer, finance, the engineer who'll maintain it, a competitor, and the colleague whose help you're assuming.

## Prompts that surface good reasons

- What did we assume that turned out false?
- Which dependency didn't arrive? Whose "yes" did we never actually get?
- Where did the numbers come from? Were any of them estimates we treated as facts?
- What did the customer actually do, compared with what we expected?
- What took far longer than planned?
- What did we stop doing to make room for this, and what broke because of it?
- Who wasn't told, and objected late?

## Template

```markdown
# Pre-mortem: <plan name> — <YYYY-MM-DD>
**Plan.** </org/path/plan.md>   **Participants.** <names>
**Scenario.** It's <date>. <Plan> failed. Why?

## Reasons (all, grouped)
- <cause> (raised by n people)

## Top causes and response
| Cause | L | I | Response | Change to plan / contingency | Risk ID | Owner |
|---|---|---|---|---|---|---|

## Plan changes made
- <change> — in </org/path/plan.md>
```

## Worked example

Plan: *launch the per-seat team plan on 2027-01-01.* Imagined failure: "Launch slipped to March and the first customers were billed wrong." The reasons collected include an untested billing migration, the pricing page not being approved by legal in time, support not being briefed on the new plan, and seat counts being estimated rather than taken from the billing system. Two were scored high. The billing migration got a test run on a copy by mid-December, added as a milestone. The legal review became a dependency confirmed in writing, with a risk entry and a trigger: "no approval by 12-10". The support briefing became a task with a done_when.

## Common pitfalls

- **Asking "what could go wrong?"** It produces cautious, vague answers. State the failure as fact.
- **Debating during collection.** Collect first and judge later. Otherwise the quieter reasons never come out.
- **A list with no follow-through.** Reasons that don't become plan changes or risk entries were wasted effort.
- **Only blaming outside factors.** Include your own team's likely mistakes: estimates, handoffs, unclear ownership.
- **Running it after commitment.** Once the plan is locked, people defend it. Run it while change is still cheap.
