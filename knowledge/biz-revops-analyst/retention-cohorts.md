---json
{ "title": "Retention cohorts", "summary": "How to build GRR and NRR cohort tables, the exact formulas, a worked example and the traps that inflate retention.", "tags": ["retention", "cohorts", "grr", "nrr", "churn"], "updated": "2026-11-04" }
---

# Retention cohorts

A cohort table shows how a group of customers who started together retains and grows over time. It separates "are we keeping customers?" from "are we adding new ones?", which blended numbers mix up.

## Definitions

For a starting cohort (customers active at the start of a period, or customers who started in a given month or quarter), over a measurement window:

- **Starting ARR**: the cohort's ARR at the start.
- **Expansion**: ARR increases from those customers (seats, upsell, cross-sell, price).
- **Contraction**: ARR decreases from customers who stayed.
- **Churn**: ARR of customers who left.

```
GRR = (Starting ARR − Contraction − Churn) ÷ Starting ARR      (max 100%)
NRR = (Starting ARR + Expansion − Contraction − Churn) ÷ Starting ARR
Logo retention = customers still active ÷ customers at start
```

New customers who joined after the start are never part of the cohort.

## Two common views

**Trailing twelve months (point in time)**: take every customer active twelve months ago, compare their ARR then with their ARR now. Gives one GRR and one NRR for "the business today".

**Acquisition cohorts (triangle table)**: group customers by start quarter; show each cohort's ARR as a percentage of its starting ARR at each later quarter.

```
Start qtr | Q0   | Q+1  | Q+2  | Q+3  | Q+4
2025-Q1   | 100% | 97%  | 101% | 104% | 106%
2025-Q2   | 100% | 95%  | 96%  | 99%  |
2025-Q3   | 100% | 98%  | 103% |      |
```

(Illustrative numbers.) Read down a column to compare cohorts at the same age; read across a row to see one cohort mature.

## Worked example

A cohort starts with 40 customers and $2,000,000 ARR. Twelve months later: 4 customers churned ($150,000), 6 contracted ($60,000), 10 expanded ($310,000).

```
GRR = (2,000,000 − 60,000 − 150,000) ÷ 2,000,000 = 89.5%
NRR = (2,000,000 + 310,000 − 60,000 − 150,000) ÷ 2,000,000 = 105%
Logo retention = 36 ÷ 40 = 90%
```

## Reasons, not just rates

Pair the numbers with reason codes from the churn and expansion logs, agreed with the customer success lead:

- Churn: never adopted, lost sponsor, product gap, price, budget, acquired, competitor, other
- Expansion: seats, new product, plan upgrade, price uplift

Report ARR by reason. Price uplift should be shown separately, since it isn't the same as customers choosing to buy more.

## Data rules

- **ARR source**: billing or subscription data is usually better than CRM amounts. State which.
- **Customer identity**: roll subsidiaries up to the parent account consistently, or a migration between entities looks like churn plus new business.
- **Timing**: count churn at contract end, not notice date. Track notices as committed churn separately.
- **Currency**: convert at a fixed rate for the analysis, or changes in exchange rates show up as expansion and contraction.
- **Downgrades to free**: decide whether they're churn or contraction, write it down, keep it.
- **Re-activations**: a customer who leaves and returns — new customer or retained? Pick one rule.

## Segmenting

Show GRR and NRR by segment (size, plan, region, acquisition channel). Blended retention can hide a weak segment behind a strong one. Keep the counts visible; small segments are noisy.

## Pitfalls

- **Including new customers** in the numerator. NRR will look great and mean nothing.
- **Averaging percentages** across cohorts of different sizes. Weight by starting ARR, or sum the dollars first.
- **Incomplete cohorts**: the latest cohorts haven't had time to churn or expand; mark them.
- **Mixing monthly and annual contracts** without saying so; they churn on different clocks.
