---json
{ "title": "CS metrics and formulas", "summary": "Exact definitions and formulas for book retention, GRR, NRR, renewal rate, expansion and health distribution, with a worked example.", "tags": ["metrics", "retention", "nrr", "grr", "renewal", "expansion"], "updated": "2026-11-04" }
---

# CS metrics and formulas

Use these definitions so your book's numbers match RevOps and finance. If the company has its own written definitions, they win; note any difference in your report.

## Book retention

Measure in recurring revenue (ARR or MRR) for a fixed starting set of accounts over a period.

- **Starting ARR**: ARR of the accounts in your book on the first day of the period.
- **Expansion**: ARR added to those same accounts (upsell, cross-sell, price uplift).
- **Contraction**: ARR lost from accounts that stayed (seat or plan reductions).
- **Churn**: ARR of accounts that left.

**Gross revenue retention (GRR)**

```
GRR = (Starting ARR − Contraction − Churn) ÷ Starting ARR
```

GRR can never exceed 100%. It shows how well you keep what you had.

**Net revenue retention (NRR)**

```
NRR = (Starting ARR + Expansion − Contraction − Churn) ÷ Starting ARR
```

NRR includes growth from the same accounts. New customers signed during the period are excluded from both.

**Logo retention**

```
Logo retention = accounts at start still customers at end ÷ accounts at start
```

## Renewal rate

Count only renewals that came due in the period.

```
Renewal rate (ARR) = ARR renewed ÷ ARR up for renewal
Renewal rate (logos) = contracts renewed ÷ contracts up for renewal
```

State whether renewed ARR is measured at the old price (pure retention) or the new price (includes uplift). Do not mix the two across periods.

## Expansion

```
Expansion rate = Expansion ARR ÷ Starting ARR
```

Also report the count of accounts that expanded and the main reason (seats, new product, uplift). Expansion concentrated in one account is a risk, not a trend.

## Health distribution

```
% green = accounts in green band ÷ accounts scored
ARR at risk = Σ ARR of red accounts (+ amber, reported separately)
```

Report ARR at risk next to the counts: one red enterprise account outweighs ten red small ones.

## Worked example

A quarter starts with 20 accounts and $1,000,000 ARR.

- Two accounts churn: −$80,000.
- Three accounts cut seats: −$30,000.
- Four accounts expand: +$150,000.
- One new customer signs for $50,000 (excluded).

```
GRR = (1,000,000 − 30,000 − 80,000) ÷ 1,000,000 = 89%
NRR = (1,000,000 + 150,000 − 30,000 − 80,000) ÷ 1,000,000 = 104%
Logo retention = 18 ÷ 20 = 90%
```

## Rules that keep the numbers honest

- **Fixed period, fixed cohort.** Never add accounts that joined mid-period to the starting set.
- **Annualise consistently.** Monthly contracts × 12 for ARR; do the same every time.
- **Timing.** Count churn when the contract ends, not when notice is given; track notices separately as "committed churn".
- **Source and date.** Every number in a report names its source (CRM, billing export) and pull date.
- **Small samples.** A book of twenty accounts swings a lot. Show counts beside percentages.
