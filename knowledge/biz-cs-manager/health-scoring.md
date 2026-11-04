---json
{ "title": "Health scoring", "summary": "How to design, weight, band and validate an account health score so it predicts churn instead of decorating a dashboard.", "tags": ["health-score", "customer-success", "churn", "retention", "model"], "updated": "2026-11-04" }
---

# Health scoring

A health score is a forecast: it should turn red before a customer leaves. Judge it by one question: were the accounts that churned red beforehand? Keep the model simple enough that a CSM can explain any account's score in one sentence. The definition lives in `/org/customer/kpis.md`, and the monthly audit checks it against outcomes.

## Pick inputs that lead, not lag

Choose four to six signals you can measure for every account from a real source:

| Signal | Example measure | Why it matters |
|---|---|---|
| Product usage | Active users ÷ seats purchased; core feature used in last 30 days | Value delivered |
| Usage trend | Change in active users vs previous 30 days | Direction beats level |
| Support experience | Open high-priority tickets; CSAT on recent tickets | Friction |
| Relationship | Executive sponsor engaged in last quarter; champion still in role | Who will defend the renewal |
| Commercial | Overdue invoices; downgrade request; contract dispute | Explicit risk |
| Outcomes | Customer-stated goals met (from the last QBR) | The reason they bought |

Avoid inputs you can't measure for most accounts. A missing input is flagged as missing, never treated as healthy.

## Scoring

1. Score each signal 0, 1 or 2 (red, amber, green) against thresholds written in kpis.md. Example: seat utilisation below 40% scores 0, 40-70% scores 1, above 70% scores 2. These cut-offs are illustrative, and the company sets its own.
2. Weight the signals. Start with equal weights and adjust only when the validation below shows a signal predicts churn better.
3. Health = weighted sum ÷ maximum possible × 100.
4. Bands: green, amber and red at cut-offs set in cadence.md.
5. **Override rule:** certain events force red whatever the score, for example the champion leaving, a written intent to cancel, or an open S1 escalation. A CSM may also override with a written reason and a review date.

### Worked example (made-up)

Five equally weighted signals, maximum 10 points. An account scores usage 2, trend 0 (active users down a third), support 1, relationship 0 (sponsor left last month), commercial 2. That's 5 ÷ 10 = 50, amber on the score. The sponsor leaving triggers the override, so it's red, and it gets a save plan (see [Churn-risk save checklist](./churn-risk-save.md)).

## Validate it

Each month, as part of the KPI audit:

- **Churned accounts:** what was each one's band 60-90 days before it left? A churn from green is a finding about the model.
- **Red accounts that renewed:** what made them look risky? A signal that's often red on healthy accounts is noise.
- **Coverage:** % of accounts with every input present. Low coverage makes the score unreliable.
- **Overrides:** how many, and whether they turned out right. Frequent overrides mean the model is missing something.

With enough history, compare churn rates by band (churned ÷ accounts in band at the start of the period). If red doesn't churn noticeably more than green, the model needs work. Don't claim predictive accuracy you haven't measured.

## Model card for kpis.md

```markdown
### Account health
- Signals and thresholds: <signal: 0 if …, 1 if …, 2 if …>
- Weights: <…>   Formula: weighted sum ÷ max × 100
- Bands: green ≥ <x>, amber <y>-<x>, red < <y>
- Forced-red events: <…>
- Missing-input rule: flag; exclude from score; count coverage
- Sources: <usage, helpdesk, CRM, billing>
- Last validated: <date>; churns from green last quarter: <n>
```

## Common pitfalls

- **Too many inputs.** Twenty signals average each other out and nobody can explain the score.
- **Only lagging signals.** NPS and renewal sentiment move late, while usage trend and sponsor changes move early.
- **Scoring by gut** and backfilling the numbers. If CSMs routinely override, fix the model.
- **Treating amber as fine.** Amber accounts with a renewal inside 90 days need a plan too.
- **Health as a CSM performance metric.** It invites gaming. Measure CSMs on retention outcomes and save-plan quality.
