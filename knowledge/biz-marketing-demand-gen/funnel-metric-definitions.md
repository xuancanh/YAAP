---json
{ "title": "Funnel metric definitions", "summary": "Exact definitions and formulas for MQLs, SQLs, pipeline sourced, cost per lead and SQL, CAC by channel and stage conversion, so every readout is consistent.", "tags": ["metrics", "funnel", "kpis", "mql", "sql", "cac"], "updated": "2026-11-04" }
---

# Funnel metric definitions

These are the numbers you own. Use the same definitions every week; if you change one, note the change and the date in the readout and don't compare across it without saying so.

## Stages

| Stage | Definition | Who decides |
|---|---|---|
| **Lead** | A person with contact details who entered the database in the period (form fill, event scan, trial sign-up). | Automatic |
| **MQL** (marketing-qualified lead) | A lead whose score crossed the MQL threshold, or who took a hand-raise action (demo request, contact sales). | Scoring rules (see [lead scoring guide](lead-scoring-guide.md)) |
| **SAL** (sales-accepted lead) | An MQL that sales reviewed and accepted for follow-up. | Sales |
| **SQL** (sales-qualified lead) | A lead sales has qualified as a real opportunity, usually when an opportunity is created. | Sales |
| **Opportunity / pipeline** | An open deal in the CRM with an amount and stage. | Sales |
| **Closed won** | The deal signed. | Sales |

Your company may skip SAL or call SQL something else. Follow the CRM's definitions, set by RevOps, and write them at the top of each readout.

## Volume and conversion

```
MQLs (period)          = leads that became MQL during the period
SQLs (period)          = leads/contacts that became SQL during the period
Lead → MQL rate        = MQLs from leads created in cohort / leads in cohort
MQL → SQL rate         = SQLs from MQLs in cohort / MQLs in cohort
SQL → Won rate         = won deals from SQLs in cohort / SQLs in cohort
```

**Cohort vs period.** "MQLs this week" counts events in the week. "MQL → SQL rate" should use a cohort (MQLs created in a given week, and how many of *them* later became SQL), otherwise slow conversion makes rates swing. Say which you used. Recent cohorts are immature; mark them.

## Pipeline sourced

```
Pipeline sourced (channel) = sum of opportunity amount, created in period,
                             where the original/first source is the channel
```

- "Sourced" means marketing generated the first touch or the hand-raise, according to the source field in the CRM. "Influenced" (any marketing touch before the opportunity) is a different, larger number. Never mix them.
- Use opportunity amount at creation, or at a fixed stage; state which.

## Cost metrics

```
Cost per lead (CPL)    = channel spend / leads from channel
Cost per MQL           = channel spend / MQLs from channel
Cost per SQL           = channel spend / SQLs from channel
Pipeline ROI (sourced) = pipeline sourced by channel / channel spend
```

- **Spend** is media spend plus any direct programme cost (event fee, sponsorship, tool that only this channel uses). State whether salaries and shared tools are included. Usually they aren't at channel level.
- Match spend period to lead period. For lagging stages (SQL), use cohort spend: the spend that generated the cohort's leads.

## CAC by channel

```
Channel CAC = (channel programme spend + allocated people/tool cost) / new customers sourced by channel
Blended CAC = total sales and marketing cost / total new customers
```

- Finance usually owns blended CAC; you report channel CAC with your allocation method written down.
- Paired metrics: **CAC payback** (CAC / monthly gross margin per new customer) and **LTV:CAC**, owned by Finance. Quote theirs; don't compute your own versions.
- CAC by channel depends on attribution. See the [attribution primer](attribution-primer.md) and state the model.

## Velocity

```
Funnel velocity (per day) = (# open opportunities × win rate × average deal size) / average sales cycle length in days
Time to MQL / to SQL     = median days between stages
```

Use medians for time-to-stage; a few slow leads distort averages.

## Readout hygiene

- Every table shows: date range, source, definition version, and whether the cohort is mature.
- Show week-over-week and against the plan target from the campaign plan.
- Small numbers move a lot. Say when a channel has too few leads to draw conclusions, and look at four-week trends.
- Note anything that breaks comparability: tracking outage, form change, scoring change, holiday.

## Worked example

Paid search, October:

- Spend 4,000; leads 200; MQLs 80; SQLs (from October MQL cohort, as of 4 Nov) 16; pipeline sourced 96,000.
- CPL = 4,000 / 200 = 20. Cost per MQL = 50. Cost per SQL = 250.
- MQL → SQL = 16 / 80 = 20% (cohort still maturing).
- Pipeline ROI = 96,000 / 4,000 = 24×.

These are illustrative numbers only; use your sources.
