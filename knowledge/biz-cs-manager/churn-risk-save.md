---json
{ "title": "Churn-risk save checklist", "summary": "How to diagnose a churn risk, write a save plan with dated actions, and know when to let an account go, without promising what you don't own.", "tags": ["churn", "retention", "save-plan", "renewals", "checklist"], "updated": "2026-11-04" }
---

# Churn-risk save checklist

A save plan starts with the real reason the customer might leave. Discounts rarely fix a value problem, and a new feature rarely fixes a lost sponsor. Every red account, and every renewal inside 90 days that isn't green, gets a plan from its CSM (cs-health-review). You review it. Commercial concessions go to their owners with the case.

## 1. Diagnose: what kind of risk is it?

| Risk type | Signals | Typical response |
|---|---|---|
| Value not realised | Low or falling usage, goals unmet, "we don't use it much" | Re-onboard, success plan tied to their goals, training |
| Relationship | Sponsor or champion left, no exec contact, unanswered outreach | Map new stakeholders, ask for an introduction, EBR |
| Product gap | Repeated feature requests, a competitor evaluation | Clarify the need, offer a workaround, product conversation (no dates unless approved) |
| Service | Recent escalation, low CSAT, slow responses | Fix the issue, review with the customer, show what changed |
| Commercial | Budget cuts, price objection, consolidation, acquisition | Right-size the plan, adjust the timing; concessions go to their owner |
| Uncontrollable | Business closed, acquired and moved to the parent's tools, project cancelled | Graceful exit, a door left open, learnings recorded |

Write down the evidence for the diagnosis: the usage trend, the email where they said it, the escalation id. "Feels at risk" isn't a diagnosis.

## 2. Save plan template

```markdown
# Save plan: <account>   Owner: <CSM>   Reviewed by: <Head of Customer>
Renewal: <date> · Value: <from billing/CRM> · Health: <band, score, why>
Risk type: <from table> · Evidence: <links/ids>
Root cause (one sentence): <…>
Customer's goal we're failing to meet: <their words>

| Action | Owner | Due | Done when |
|---|---|---|---|
| <e.g. Stakeholder map + intro request to new VP> | CSM | <date> | Meeting booked |
| <e.g. Training for team X> | Onboarding | <date> | Session held, usage tracked |

Help needed: <product / engineering / sales / exec sponsor; each as a task>
Commercial asks (not ours to grant): <what, why, filed to whom>
Leading indicator we'll watch: <metric and target, by date>
Decision point: <date>; if no improvement → <escalate / adjust / prepare exit>
Forecast: likely renew / at risk / likely churn (confidence 0-1)
```

## 3. Checklist before the plan is accepted

- [ ] Root cause is specific and backed by evidence.
- [ ] Actions address that cause, not a generic "more check-ins".
- [ ] Every action has an owner, a date and a checkable done-when.
- [ ] Cross-functional help is filed as briefed tasks, not just mentioned.
- [ ] No promise of credits, discounts, roadmap dates or contract changes. Those are filed to their owners.
- [ ] A leading indicator and a decision point are set.
- [ ] The forecast is recorded with org_forecast_outcome, so calibration can be checked later.
- [ ] Customer-facing messages are drafts for human approval unless sending is granted.

## 4. Timing against the renewal

Defaults to tune in cadence.md: start at 90 days with diagnosis and the plan, check progress at 60 days and involve an executive sponsor if it's still red, and at 30 days settle commercial terms with their owners or prepare an orderly exit. A plan started inside 30 days is usually too late for a value problem.

## Worked example (made-up)

Renewal in 75 days. Usage is down by a third over two months, the champion left, and the new team lead hasn't replied to two emails. Diagnosis: relationship plus value at risk, evidenced by the usage source and the CRM contact history. Actions: ask the account's exec sponsor for an introduction to the new lead (CSM, this week), a 30-minute goals session once introduced, and a re-onboarding session for the team. Leading indicator: weekly active users back to the prior level within 30 days. Decision point at 45 days before renewal. Forecast: at risk, 0.5.

## When to let go

If the customer has clearly decided for reasons we can't affect, say so in the forecast. Help them leave well (data export, a clean handover), capture the reason honestly for the churn analysis, and keep the relationship. A churn recorded as "price" when the real cause was "never adopted" teaches the company the wrong lesson.

## Common pitfalls

- **Leading with a discount.** It trains customers to threaten churn and doesn't fix value.
- **Saving every account equally.** Prioritise by value at risk and how savable it is.
- **Optimistic forecasts.** Record your honest probability, because calibration is reviewed.
- **Plans that live in the CSM's head.** Put them in the file and the tasks.
- **No post-mortem on churn.** Feed reasons into the health model and the product themes.
