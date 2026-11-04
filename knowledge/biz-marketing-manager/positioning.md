---json
{ "title": "Positioning", "summary": "April Dunford's positioning components and the order to work them, with a template for the positioning doc every campaign and launch draws on.", "tags": ["positioning", "messaging", "product-marketing", "launches", "marketing"], "updated": "2026-11-04",
  "sources": [
    { "title": "A Quickstart Guide to Positioning", "url": "https://www.aprildunford.com/post/a-quickstart-guide-to-positioning", "author": "April Dunford", "date": "2021-03-15", "accessed": "2026-11-04" },
    { "title": "Obviously Awesome: How to Nail Product Positioning so Customers Get It, Buy It, Love It", "url": "https://www.aprildunford.com/obviously-awesome", "author": "April Dunford", "date": "2019", "note": "The book behind the framework." }
  ] }
---

# Positioning

Positioning is the context you set so the right buyers see why the product matters to them. Messaging, landing pages, ads and sales decks all come out of it, so when they disagree with each other, the fix is usually upstream in positioning, not in copy.

The Product Marketer owns the positioning doc; you approve it. Keep it at `/org/marketing/positioning.md` and link it from every campaign brief.

## The components (April Dunford)

Dunford's framework has five components, worked in this order because each depends on the one before:

1. **Competitive alternatives**: what customers would do if your product didn't exist. Often a spreadsheet, an agency, an intern or doing nothing, not only named competitors.
2. **Differentiated capabilities**: what you have that those alternatives don't.
3. **Value**: what those capabilities let customers do, in their terms ("close the month in two days"), with proof.
4. **Target customers**: the customers who care most about that value. Defined by characteristics you can find and target, not a persona's hobbies.
5. **Market category**: the frame that makes the value obvious to those customers. Choosing the category sets which competitors buyers compare you with and which features they assume you have.

Start from customers who already love the product: what did they compare it with, and why did they choose it? That evidence beats a workshop of opinions. Pull it from sales win/loss notes in `/org/sales/` and the User Researcher's interviews in `/org/product/`.

## Positioning doc template

```markdown
# Positioning: <product or offer>
Updated: <date> · Owner: <Product Marketer> · Approved: <Head of Marketing, date>

## Competitive alternatives
- <alternative> — why customers use it today; where it falls short (evidence: <source>)

## Differentiated capabilities
- <capability> — which alternatives lack it

## Value (and proof)
| Capability | Value to the customer | Proof (source, date) |
|---|---|---|

## Target customers
Characteristics: <segment, size, situation, trigger event>
Who is NOT a fit: <and why>

## Market category
<category> — why this frame; what buyers will assume because of it

## Messaging hierarchy
One-liner: <...>
Three pillars: <value 1> / <value 2> / <value 3>, each with its proof point

## Open questions and evidence still needed
```

## Checklist before approving

- [ ] Every alternative and value claim cites evidence (interview, win/loss note, usage data), not opinion.
- [ ] Each value maps to a capability the product has shipped today, not a roadmap item.
- [ ] The target customer can be found: a list, a channel or a keyword reaches them.
- [ ] The "not a fit" line exists. Positioning that fits everyone sells to no one.
- [ ] Sales has read it and its objections are logged under open questions.
- [ ] The proof points pass the [claims check](./claims-and-approvals.md).

## When to revisit

On a major launch, a new segment, a change in what wins or loses deals, or when the conversion rate on core pages stalls with no tracking change behind it. Record a positioning change as a decision with the alternatives you considered.

## Common pitfalls

- Starting with the category or the tagline. Category is the last step, chosen to fit the value.
- Listing features as value. "AI-powered" is a capability; value is what changes for the customer.
- Ignoring "do nothing" as the main competitor.
- Writing positioning once and letting campaigns drift from it. The campaign brief links it so reviewers can check.
