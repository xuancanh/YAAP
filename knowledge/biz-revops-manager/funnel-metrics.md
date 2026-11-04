---json
{ "title": "Funnel and retention metrics", "summary": "Formulas and measurement rules for funnel conversion, velocity, pipeline coverage, win rate and NRR/GRR/churn, so every unit reports the same number.", "tags": ["revops", "funnel", "metrics", "nrr", "churn", "conversion"], "updated": "2026-11-04",
  "sources": [
    { "title": "How to Supercharge Your Sales Velocity for Quicker Wins", "url": "https://www.salesforce.com/blog/sales-velocity/", "publisher": "Salesforce", "accessed": "2026-11-04", "note": "Sales velocity formula" },
    { "title": "Gross Revenue Retention (GRR) Formula", "url": "https://churnzero.com/churnopedia/gross-revenue-retention/", "publisher": "ChurnZero", "accessed": "2026-11-04", "note": "GRR formula; NRR adds expansion to the same base" }
  ] }
---

# Funnel and retention metrics

Most fights about revenue numbers come down to definitions: whether a figure is counted by count or by value, which date it's measured on, and whether it's a cohort or a period. For each metric, decide those three things, write them into /org/revops/funnel.md, and keep them.

## Funnel conversion

```
Stage conversion (N → N+1) = records that reached stage N+1 ÷ records that reached stage N
```

Two ways to measure it, and you can't mix them:

- **Cohort**: take the records that entered stage N in a window (for example, the MQLs from March) and count how many have reached N+1 so far. This is accurate but it lags: a recent cohort hasn't had time to convert yet, so compare cohorts of the same age.
- **Period**: count stage N entries and stage N+1 entries in the same week. This is fast but approximate, and it's distorted whenever volumes change, because this week's opportunities came from earlier leads.

Use cohort for the funnel review and to set targets. Use period only for quick weekly trends, and label it.

**Time in stage** = median days from entering a stage to leaving it, forwards or out. Use the median, because one deal stuck for 300 days wrecks an average.

## Pipeline

```
Pipeline coverage        = open pipeline closing in the period ÷ remaining target for the period
Weighted pipeline        = Σ (amount × stage probability)
Pipeline created         = Σ amount of opportunities created (or qualified) in the period
```

Write down whether pipeline counts from the date an opportunity was **created** or the date it was **qualified**. Use one or the other everywhere. Coverage only means something if close dates are honest, so run the hygiene checks before you compute it.

## Win rate, deal size, cycle

```
Win rate (count) = won ÷ (won + lost)            deals closed in the period
Win rate (value) = won amount ÷ (won + lost amount)
Average deal size = won amount ÷ won count
Sales cycle      = median days from opportunity created to closed-won
```

Leave open deals out of the win-rate denominator. Including them makes the rate move with how much pipeline is open, not with how well you sell. Report count and value separately: a team winning lots of small deals and losing the big ones looks good on count alone.

## Sales velocity

```
Sales velocity (per day) = (open opportunities × average deal size × win rate) ÷ sales cycle (days)
```

**Worked example (made-up figures):** 40 open opportunities × 10,000 average deal × 0.25 win rate ÷ 60-day cycle = **1,667 per day**. Velocity is useful because it shows which of the four levers moved. Doubling deal size while the cycle doubles leaves velocity unchanged.

## Retention

Measure retention on recurring revenue from a starting set of customers over a period. Monthly and annual views are both common; say which one you're using.

```
GRR = (starting recurring revenue − churned − contraction) ÷ starting recurring revenue
NRR = (starting recurring revenue − churned − contraction + expansion) ÷ starting recurring revenue
Logo churn     = customers lost in the period ÷ customers at the start
Revenue churn  = (churned + contraction) ÷ starting recurring revenue
```

GRR can't exceed 100%, while NRR can. Revenue from new customers won during the period is never part of either. **Worked example (made-up):** starting ARR 1,000,000, churn 60,000, contraction 40,000, expansion 150,000. GRR = 90%. NRR = 105%.

**NRR attribution coverage** (one of your KPIs) = the share of expansion and contraction revenue that has a recorded reason and owner (product, price, seats, usage). Unattributed movement can't be acted on.

## Lead routing

**Lead routing time** = median minutes or hours from a lead becoming routable to its first owner touch. Also report the share of leads handled within the company's SLA, because the median hides the leads nobody picked up.

## Common pitfalls

- Mixing cohort and period conversion in one table.
- Win rate including open deals, or calculated on count in one report and value in another.
- Coverage computed on pipeline with past-dated close dates.
- Reporting NRR without stating the period and whether it's monthly or annual.
- Comparing to a published benchmark nobody sourced. Your own trend and target are the comparison.
- Two units pulling "the same" metric from different reports. Pick one source, attach it with org_metric_sources, and let the others read it.
