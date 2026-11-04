---json
{ "title": "Total cost and option scoring", "summary": "Compute total cost of ownership over the contract term and score options against weighted requirements so the recommendation is defensible.", "tags": ["tco", "vendor-comparison", "scoring", "purchase-request"], "updated": "2026-11-04" }
---

# Total cost and option scoring

A comparison is fair when every option is costed over the same period and scored against the same requirements, written before you looked at the vendors.

## Total cost of ownership (TCO)

Cost every option over the same horizon: the contract term, or a fixed period (for example the next two or three years) when terms differ.

| Cost line | What to include |
|---|---|
| Licences / subscription | Price × seats or usage tier, for each year of the horizon |
| Expected price change | Any renewal uplift stated in the terms; if none is capped, note the risk rather than inventing a figure |
| Overage | Expected usage above the tier × overage rate |
| Setup | Implementation fees, data migration, integration build (internal hours × a loaded hourly cost from Finance) |
| Training and change | Hours for people to learn it |
| Running | Admin hours per month, add-ons, required higher tiers for SSO or audit logs |
| Exit | Data export, overlap period with the old tool, early-termination fees |

**TCO** = sum of all lines over the horizon. Show it per year as well, so a cheap first year with a large uplift is visible.

**Cost per active user** = TCO ÷ (expected active users × years). Use expected active users, not seats paid, so an oversized plan looks as expensive as it is.

Label each line's source: quote, public price page, vendor email, estimate. Vendor quotes change; date them.

## Scoring options

1. **List requirements first**, from the request: must-haves and nice-to-haves. A must-have is pass/fail: an option that fails one is out, however cheap.
2. **Weight the nice-to-haves.** Give each a weight that adds to 100. Agree the weights with the requester before scoring.
3. **Score each option** 0–3 on each nice-to-have: 0 absent, 1 partial or workaround, 2 meets, 3 exceeds in a way the requester values. Note the evidence (demo, docs, trial).
4. **Weighted score** = Σ (weight × score) ÷ 3, giving 0–100.
5. **Add non-scored checks:** security review status, data handled and where it is stored, contract risk from the [contract terms checklist](contract-terms-checklist.md).

Keep cost separate from the score. Show both side by side and let the decider see the trade-off; folding cost into the score hides it.

## The comparison table

```
| | Use what we have | Option A | Option B |
|---|---|---|---|
| Must-haves met | 3/4 (no SSO) | 4/4 | 4/4 |
| Weighted score | 40 | 78 | 71 |
| TCO (horizon) | 0 extra | ... | ... |
| Cost per active user / yr | — | ... | ... |
| Security review | n/a | needed | passed (date) |
| Contract flags | — | auto-renew, no uplift cap | — |
| Exit cost | — | export via API only | CSV export |
```

Always include "do nothing" or "use what we have" as a column. It is often the right answer, and it anchors the value of buying.

## Writing the recommendation

> **Recommend Option B.** Meets all must-haves, scores slightly lower than A on reporting, but costs less over the horizon and has a capped renewal. A would need an uplift cap negotiated before it is competitive. Security review passed for B; A not yet reviewed. Decision needed by <date> to meet the requester's deadline.

Lead with the choice, then the two or three facts that drive it, then what the decider must still do.

## Pitfalls

- Comparing a monthly price with an annual one, or list price with a discounted quote.
- Scoring features the requester never asked for because a vendor demo made them look good.
- Leaving out internal hours. Setup and admin time are real costs.
- Treating a free tier as free: check its limits against expected usage and its data terms.
- Recommending without the security and legal reviews the policy requires. Flag them as open instead.
