---json
{ "title": "Health score design", "summary": "How to build, weight, calibrate and explain an account health score that actually predicts renewal.", "tags": ["health-score", "customer-success", "churn", "method"], "updated": "2026-11-04" }
---

# Health score design

A health score is only useful if a red score is followed by churn or contraction more often than a green one. Design it to predict, then check that it does.

## The four signal families

Pick one to three signals per family. More signals add noise, not insight.

| Family | Example signals | Watch out for |
|---|---|---|
| **Product usage** | active users ÷ licensed seats, use of the features tied to the success plan, trend over the last 4–8 weeks | raw logins reward noise; measure the behaviour that delivers the outcome |
| **Support** | open high-priority tickets, repeat issues, ticket sentiment | many tickets can mean engagement; look at severity and repetition |
| **Relationship** | sponsor still in role, last executive contact, business review held, survey response | a single champion is a risk even when they are happy |
| **Commercial** | invoices overdue, seat reductions, procurement asking about notice terms, budget cuts | these are late signals; by the time they show, you are in save mode |

## Building the score

1. **Write each signal as a rule with thresholds** the team agrees on, for example "seat utilisation: green ≥ target set in success plan, amber within a quarter of it, red below". Record the thresholds in the account playbook, not in your head.
2. **Score each signal 0, 1 or 2** (red, amber, green). Simple ordinal scores are easier to explain than decimals.
3. **Weight the families.** Start equal. Change the weights only after calibration shows one family predicts better.
4. **Combine** into a 0–100 number: `health = 100 × Σ(weight × signal score) ÷ Σ(weight × 2)`.
5. **Map to bands** (green, amber, red) and write what each band triggers: amber → next action within a week; red → save plan.
6. **Add an override.** A CSM can set the band by hand with a written reason ("sponsor left last week"). Track overrides; many overrides mean the model is missing a signal.

## Calibrating it

Every quarter, take accounts that renewed, contracted or churned in the last period and look at their score 90 days before the outcome.

- If churned accounts were mostly green, the score is missing the real signal. Read their files and find what they had in common.
- If renewed accounts were often red, a threshold is too strict or a signal measures the wrong thing.
- Keep the calibration file with the date, sample and what you changed, so changes are explainable.

Small books give small samples. Say so, and do not over-tune on a handful of accounts.

## Explaining a score

Never report a number alone. A good health note has three lines:

> **Amber (58), down from 71.** Seat utilisation fell after their team restructure; two P2 tickets on SSO this month. Next: call the new ops lead by Friday to reset the success plan owner.

The reader should know what changed, why it matters and who does what next.

## Pitfalls

- **Vanity signals.** NPS alone, logins, email opens. They move without the outcome moving.
- **Stale data.** A score built on last month's export looks precise and is wrong. Show the data date.
- **Score as goal.** If the team is rewarded for green scores, scores turn green. Reward retention and the score stays honest.
- **One score for every segment.** A ten-seat customer and a thousand-seat enterprise behave differently. Separate thresholds by segment when you have enough data.
- **No action.** A score that nobody acts on is a dashboard, not a system. Each band needs a written next step.
