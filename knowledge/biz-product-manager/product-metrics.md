---json
{ "title": "Product metrics and formulas", "summary": "Definitions and formulas for activation, cohort retention, stickiness, feature adoption, NPS, roadmap predictability and discovery throughput, with a worked example and pitfalls.", "tags": ["metrics", "activation", "retention", "adoption", "nps", "kpis", "product"], "updated": "2026-11-04",
  "sources": [
    { "title": "The One Number You Need to Grow", "url": "https://hbr.org/2003/12/the-one-number-you-need-to-grow", "author": "Frederick F. Reichheld", "publisher": "Harvard Business Review", "date": "2003-12", "note": "Origin of the Net Promoter Score." }
  ] }
---

# Product metrics and formulas

Write each event and window into `/org/product/kpis.md` before you measure. The KPI audit compares what was computed with what's written, and most product metric errors are definition errors: the wrong population, the wrong window, or an event that quietly stopped firing.

## Activation

**Activation rate** = users (or accounts) who reach the activation event within N days of sign-up ÷ users who signed up in the same period.

Write down three things: the event (a behaviour that predicts retention, such as "created and shared a first report", not "logged in"), the unit (user or account; for team products usually account), and N. Pick the event from evidence: compare retention of users who did and didn't do the candidate action. Revisit it when the product changes what "value" means.

## Retention (cohorts)

**Week-k retention for a cohort** = members of the sign-up cohort active in week k ÷ cohort size.

- Define "active" as a meaningful action, not a page view.
- Use a fixed cohort (everyone who signed up in week W) and read each column down the cohort table. A single blended "retention rate" mixes old loyal users with new ones and hides change.
- Choose the window to fit natural usage: weekly for a daily tool, monthly for a monthly job (payroll, invoicing).
- Recent cohorts haven't reached later weeks yet; leave those cells empty rather than zero.

Revenue retention (net and gross) belongs to finance; if you report it, take the figure from their source.

## Stickiness

**DAU/MAU** = average daily active users over the month ÷ monthly active users. It reads as "on an average day, what share of this month's users show up". It only makes sense for products meant to be used daily; for weekly-use products use WAU/MAU or skip it.

## Feature adoption

**Adoption rate** = eligible accounts that used the feature at least X times in the window ÷ eligible accounts.

"Eligible" is the part people get wrong: exclude accounts on plans without the feature, accounts not yet in the rollout, and inactive accounts. Write the eligibility rule in the launch file. Report "tried once" and "used repeatedly" separately; the gap between them is the feature's real story.

## NPS and CSAT

**NPS** = % promoters (score 9–10) − % detractors (score 0–6), from "How likely are you to recommend…?" on a 0–10 scale. Range −100 to +100. Passives (7–8) count in the total but in neither group. Reichheld introduced it in 2003.

Report the response count and who was asked. NPS on 30 responses swings widely, and asking only active users inflates it. **CSAT** on a flow = satisfied responses (top two boxes, say 4–5 on a 5-point scale) ÷ all responses; write the scale and the cut-off.

## Delivery and discovery

- **Roadmap delivery predictability** = committed Now items shipped in the quarter ÷ committed Now items at quarter start. Items added mid-quarter don't count in either; items cut by a recorded decision are listed separately.
- **Discovery throughput** = opportunities validated + opportunities killed in the month, each with a recorded decision. Killing an idea on evidence counts as much as validating one.

## Worked example (made-up figures)

Week 40 cohort: 200 sign-ups across 80 accounts. 34 accounts created and shared a first report within 7 days: account activation = 34 ÷ 80 = 42.5%. Week-4 retention: 28 of the 80 accounts active in week 4 = 35%. Bulk invite launched to 120 eligible accounts; 54 used it once, 18 used it three or more times: tried 45%, repeated 15%. The report shows all four counts, not just the rates.

## Common pitfalls

- Activation defined as a vanity event (sign-in, onboarding screen viewed).
- Mixing user and account units between activation and retention.
- Adoption computed over all accounts instead of eligible ones, which makes a gradual rollout look like a failure.
- A metric jump right after an instrumentation change. Check the event's history before reporting the movement.
- Reporting NPS without the response count and the sampling rule.
