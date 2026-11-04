---json
{ "title": "Deal desk metrics", "summary": "Formulas for effective discount (including multi-year, ramps and free months), quote turnaround and exception rate, with worked examples.", "tags": ["metrics", "discount", "turnaround", "exceptions", "pricing"], "updated": "2026-11-04" }
---

# Deal desk metrics

Discount is easy to understate. A headline "15% off" can hide free months, free products and ramps that make the real discount much deeper. Effective discount puts everything on one basis.

## Effective discount

```
Effective discount = 1 − (net contract value ÷ list contract value)
```

Calculate both values over the **same term and products**:

- **List contract value**: the list price of everything on the quote, over the full term, at the price book's prices.
- **Net contract value**: what the customer actually pays over that term.

Include recurring fees; report one-time fees (services, setup) separately because they often have different margins and policies.

### Free months

A 12-month contract at list $10,000/month with 2 months free:

```
List = 12 × 10,000 = 120,000
Net = 10 × 10,000 = 100,000
Effective discount = 1 − 100,000 ÷ 120,000 = 16.7%
```

The quote may show "0% discount", but the effective discount is 16.7%.

### Ramps

Three-year deal, list $100,000/year. Net: year 1 $60,000, year 2 $80,000, year 3 $100,000.

```
List = 300,000   Net = 240,000
Effective discount = 1 − 240,000 ÷ 300,000 = 20%
```

Year 1 alone is 40% off; report the whole-term figure and the first-year figure.

### Free products

A $5,000/year add-on included at zero is a discount of $5,000/year on the list total. Include it in the list value.

## Discount reporting

- Report effective discount **weighted by list value** across deals: `1 − Σ net ÷ Σ list`. A simple average of percentages lets small deals dominate.
- Break down by segment, product, deal size, rep and quarter-end timing (deals closed in the final days vs the rest).
- Compare discount with outcomes: win rate, deal size, renewal and churn. Whether a discount "buys anything" is the core question in the discount analysis skill.

## Quote turnaround

```
Turnaround (per quote) = time review returned − time quote submitted for review
```

- Measure in business hours and say so.
- Report the **median** and a high percentile (for example the 90th).
- Exclude time the quote was waiting on the AE (returned for changes) if you track it; otherwise report total cycle time and explain.
- Split by "standard" vs "needed exception": exceptions take longer because they wait on approvers. Report approver wait time separately.

## Exception rate

```
Exception rate = quotes needing at least one approval beyond the requester's band
                 ÷ quotes reviewed
```

- Also report by type (discount, payment terms, legal terms) and by approver level.
- Report the **approval rate** of exceptions: `exceptions approved (fully or partly) ÷ exceptions requested`. A very high approval rate suggests the band is too tight, or that approvals are rubber-stamped; either way, a policy conversation.
- A rising exception rate is a signal for the pricing-policy review, not a failure of the deal desk.

## Worked example (monthly summary)

```
Quotes reviewed: 40   Median turnaround: 4 business hours (p90: 2 days)
Exceptions: 10 (25%) — 7 discount, 2 payment terms, 1 legal
Exceptions approved: 8 of 10 (80%)
Effective discount (list-weighted): 18%; quarter-end week: 24%; rest: 15%
```

The quarter-end gap is the finding to bring to the pricing review.

## Rules

- Use the same list price book for all comparisons in a period.
- Convert currencies at a fixed rate for the analysis.
- State the source (CPQ, CRM, exception log) and pull date.
