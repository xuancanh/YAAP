---json
{ "title": "Roadmaps and RICE", "summary": "Now/Next/Later and outcome roadmap formats, RICE scoring with Intercom's scales and a worked example, and a roadmap file template.", "tags": ["roadmap", "prioritisation", "rice", "strategy", "product"], "updated": "2026-11-04",
  "sources": [
    { "title": "RICE: Simple prioritization for product managers", "url": "https://www.intercom.com/blog/rice-simple-prioritization-for-product-managers/", "author": "Sean McBride", "publisher": "Intercom", "date": "2018-01-05", "accessed": "2026-11-04" },
    { "title": "Why I Invented the Now-Next-Later Roadmap", "url": "https://www.prodpad.com/blog/invented-now-next-later-roadmap/", "author": "Janna Bastow", "publisher": "ProdPad", "date": "2022-10", "accessed": "2026-11-04" }
  ] }
---

# Roadmaps and RICE

A roadmap says which problems the company will work on and in what order, and why. It isn't a release schedule. Dates on far-off items create commitments nobody can keep; the Head of Product owns the roadmap, but a date promised to a customer is the CEO's call.

## Now / Next / Later

Janna Bastow (ProdPad co-founder) created the format: three time horizons instead of dates.

- **Now**: committed this quarter, scoped and broken into work, fitted to engineering's capacity with a buffer.
- **Next**: likely next, understood as a problem but not yet scoped in detail.
- **Later**: problems worth keeping in view; no scope, no commitment.

Each item is written as a problem or outcome tied to a key result ("New teams can't see value before inviting colleagues — activation KR"), not as a feature name. Detail and certainty drop from left to right; that's the point.

## Outcome roadmap

A variant that groups items under the outcome (key result) they move. Use it when the CEO or chief asks "what are we doing about retention?": each outcome row shows its current value, target, and the bets in Now, Next and Later against it. A bet with no outcome row needs a stated strategic reason (a platform migration, a compliance duty) or it goes.

## RICE scoring

Sean McBride at Intercom published RICE in 2018:

**RICE score = (Reach × Impact × Confidence) ÷ Effort**

- **Reach**: people or accounts affected per period (per quarter), from data where possible.
- **Impact** per person, on Intercom's scale: 3 massive, 2 high, 1 medium, 0.5 low, 0.25 minimal.
- **Confidence**: 100% high, 80% medium, 50% low. Below 50% is a moonshot: treat it as a discovery item, not a roadmap item.
- **Effort**: total team time. Intercom uses person-months; your playbook uses engineering's estimate in person-weeks. Either is fine if every item uses the same unit.

The score ranks; it doesn't decide. McBride's own caveat is that it isn't a hard rule. Record why you overrode it (a dependency, a commitment, strategic fit) in the decision.

### Worked example (made-up figures)

| Item | Reach / qtr | Impact | Confidence | Effort (pw) | Score |
|---|---|---|---|---|---|
| Bulk invite | 400 accounts | 2 | 80% | 4 | 160 |
| Report templates | 900 accounts | 1 | 50% | 6 | 75 |
| SSO | 40 accounts | 3 | 100% | 8 | 15 |

Bulk invite leads. SSO scores lowest but may still be Now if the sales objective depends on enterprise deals; that's a trade-off with another function's objective, so it becomes a backlog task for the chief with both scores attached.

## Capacity check

Committed effort (sum of Now items) ≤ engineering's planned capacity − keep-the-lights-on and debt allocation − buffer. The allocation and buffer are company defaults in `/org/product/cadence.md`; the capacity figure comes from the engineering lead, never your guess.

## Roadmap file template

```markdown
# Product roadmap — updated <date>
Decision: /org/product/decisions.md#<entry> · Capacity: <pw> available, <pw> committed

## Now (committed <quarter>)
| Problem / outcome | KR | RICE | Owner | Status |
|---|---|---|---|---|

## Next
| Problem / outcome | KR | Why next, not now |

## Later
| Problem | Evidence so far |

## Cut this review
| Item | Why cut | Revisit when |
```

## Common pitfalls

- Features with dates in Later. If it has a date, it's a commitment; if it isn't committed, drop the date.
- Gaming the inputs: confidence at 100% on a guess. Confidence should reflect evidence, and an audit can check it.
- Effort from product rather than from engineering's estimate.
- Filling Now to 100% of capacity, so any surprise slips a commitment.
- Changing the roadmap without recording the decision and its alternatives.
