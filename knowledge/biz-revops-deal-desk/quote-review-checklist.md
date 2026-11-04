---json
{ "title": "Quote review checklist", "summary": "A line-by-line checklist for reviewing quotes and order forms against the price book and policy, with common errors and the return format.", "tags": ["quote-review", "order-form", "checklist", "pricing", "cpq"], "updated": "2026-11-04" }
---

# Quote review checklist

A quote review catches errors before a customer sees them and confirms the deal is inside policy. Review every quote the same way, top to bottom, and return all findings in one pass.

## Customer and deal

- [ ] Legal entity name and address match the customer's records (not a nickname or a subsidiary by mistake)
- [ ] Billing contact and billing address present
- [ ] Linked to the right opportunity and account in the CRM
- [ ] Currency allowed by policy for that region
- [ ] Quote expiry date set and within policy

## Products and prices

- [ ] Every product is on the current price book; no retired SKUs
- [ ] List prices match the price book for that currency and region
- [ ] Quantities match what the buyer asked for and what the AE's notes say
- [ ] Required add-ons included (e.g. a platform fee a module depends on), incompatible ones excluded
- [ ] Unit of measure correct (per user, per month, per year)
- [ ] One-time fees (setup, training) shown separately from recurring fees

## Discounts

- [ ] Discount per line and in total calculated correctly (see [deal desk metrics](deal-desk-metrics.md))
- [ ] Within the band the policy grants the requester; otherwise an approved exception is attached
- [ ] Discount type allowed (percentage, fixed, free months) for this product
- [ ] Free or "zero-priced" items handled as the policy says (often they need approval too)

## Term and billing

- [ ] Start date, end date and term length consistent
- [ ] Billing frequency and payment terms standard, or approved
- [ ] Ramps (prices that change over the term) and multi-year prices calculated correctly, year by year
- [ ] Price uplift on renewal stated per policy
- [ ] Co-terming with existing subscriptions done correctly (prorated amounts, aligned end dates)
- [ ] Taxes handled per finance's rules (usually calculated on the invoice, not on the quote)

## Terms

- [ ] Standard terms referenced (the correct version)
- [ ] Any non-standard term listed and approved by its owner (legal, finance) — see [non-standard terms primer](non-standard-terms-primer.md)
- [ ] No side promises in free-text fields ("will include feature X", "price locked forever")

## Totals

- [ ] Line totals add up to the quote total
- [ ] ACV, TCV and ARR fields on the opportunity match the quote
- [ ] Amounts match what the AE is forecasting

## Common errors to look for first

- Wrong currency or region price book
- Discount applied twice (line and header)
- Term dates off by a day, creating a gap or overlap with an existing subscription
- Multi-year deal priced as year 1 × years, missing the agreed uplift or ramp
- Free text that changes terms ("customer may cancel any time")
- Legal entity mismatch, which delays signature and invoicing

## Return format

```
Quote: <ID> / opportunity / AE / reviewed <date, time>
Result: approved / approved with changes / returned / needs exception
Findings:
  1. <line or field> — issue — required change
  2. …
Exception needed: yes/no — what, approver per policy
Notes for finance or legal: …
```

Log the result, the time received and the time returned, for quote turnaround.

## Pitfalls

- **Fixing it yourself in a sent document.** Return it; the AE re-issues.
- **Approving by precedent.** "We gave them this last year" isn't policy; check whether that was an exception.
- **Partial reviews.** Returning the first error you find and missing three others costs another round trip.
