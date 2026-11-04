---json
{ "title": "Risk registers", "summary": "How to write and keep /org/risks.md: if-then risk statements, likelihood × impact scoring, an owner, mitigation and contingency, triggers, and a review cadence.", "tags": ["risk", "risk-register", "planning", "templates"], "updated": "2026-11-04" }
---

# Risk registers

A risk is something that *might* happen and would hurt a goal if it did. An issue is something that already has. The risk register (`/org/risks.md`) lists the risks worth watching, who owns each one, and what's being done about them, so surprises arrive with a plan attached.

## Write the risk as "if… then…"

A vague risk ("vendor problems") can't be owned or measured. Write the cause and the consequence:

```
If <cause / event>, then <effect on a goal, date, cost or customer>.
```

- Weak: "Data quality."
- Strong: "If the billing export keeps arriving late, then the monthly revenue report misses the board meeting on the 5th."

If you can't name the effect on something that matters, it isn't a risk worth listing.

## Score it: likelihood × impact

Rate each on a 1–5 scale and multiply. Agree the scale once, in the register's header, so scores mean the same thing to everyone.

| Score | Likelihood | Impact |
|---|---|---|
| 1 | Very unlikely | Negligible: absorbed within the task |
| 2 | Unlikely | Minor: small delay or cost, one team |
| 3 | Possible | Moderate: misses a milestone or a KR moves noticeably |
| 4 | Likely | Major: misses a committed goal, customers notice |
| 5 | Almost certain | Severe: legal, safety, data loss or a large financial hit |

Score = L × I, from 1 to 25. A common banding: 1–6 low, 8–12 medium, 15–25 high. Adjust it to your company. Scores are judgments, so say what each one rests on, and don't invent probabilities. "Likely (3 of the last 4 exports were late, source: /org/finance/export-log.md)" beats "70%".

## Owner, mitigation, contingency, trigger

Each risk needs:

- **Owner**: one named person or agent who watches it and acts. Not "everyone".
- **Mitigation**: what you do *now* to lower the likelihood or impact.
- **Contingency**: what you'll do *if it happens*. Decide this in advance, while you're calm.
- **Trigger**: the observable signal that it's happening, or about to, and that starts the contingency.
- **Response type**: avoid (change the plan so it can't happen), reduce, transfer (insurance, contract, vendor) or accept (consciously, with a reason).

## Template

```markdown
# Risk register

Scale: likelihood and impact 1–5 (see the scale table above); score = L × I.
High ≥ 15 · Medium 8–12 · Low ≤ 6. Reviewed: <cadence>. Last review: <date>.

| ID | Risk (if… then…) | L | I | Score | Owner | Mitigation (now) | Trigger | Contingency (if it happens) | Status | Updated |
|---|---|---|---|---|---|---|---|---|---|---|
| R-07 | If the billing export is late again, then the revenue report misses the board meeting on the 5th | 4 | 3 | 12 | Finance manager | Ask Ops to schedule the export for the 1st; pull a manual copy on the 2nd | Export not in /org/finance/ by the 2nd, 12:00 | Send the report from the manual copy, marked "provisional", and tell the CEO | Open | 2026-11-04 |
```

Keep closed risks in a "Closed" section below, with the date and what happened. That history improves future scoring.

## Review cadence

A register nobody reads is decoration. Review it on a fixed cadence (your company sets it, and planning or OKR check-ins are a natural moment):

- Re-score each open risk. Did likelihood or impact change?
- Check the triggers. Has any fired? If so, it's now an issue: run the contingency and tell the owner of the affected goal.
- Close risks that have passed.
- Add new risks from recent plans, decisions and pre-mortems (see [pre-mortems](./pre-mortems.md)).

High risks get looked at more often than low ones, and the owner of the goal at stake should know about every high risk.

## When to add a risk

- In planning: every dependency you don't control.
- When a KR turns yellow or red for a reason outside the team.
- When a decision is accepted with known downsides.
- When a reviewer flags something that isn't fixed before shipping.

## Checklist

- [ ] Written as "if… then…" with an effect on a goal, date, cost or customer
- [ ] L and I scored on the shared scale, with the basis noted
- [ ] One owner
- [ ] Mitigation now and contingency later, both concrete
- [ ] An observable trigger
- [ ] Reviewed on cadence, with the date updated

## Common pitfalls

- **Listing worries, not risks.** No cause and effect, no owner, no entry.
- **Fake precision.** "23% likely" with no data behind it. Use the scale and say what it's based on.
- **Mitigation that's just "monitor".** Monitoring is the trigger. Mitigation changes the odds or the damage.
- **Stale registers.** An old "last reviewed" date tells readers to ignore the whole thing.
- **Hiding risks to look on track.** A flagged risk with a plan is good news. A surprise isn't.
