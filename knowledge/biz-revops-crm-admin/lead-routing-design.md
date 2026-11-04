---json
{ "title": "Lead routing design", "summary": "Routing methods, a rule-order template, test cases and the lead routing time metric for fast, fair assignment.", "tags": ["lead-routing", "assignment", "territories", "sla", "crm"], "updated": "2026-11-04" }
---

# Lead routing design

Routing gets each lead to the one right owner, fast, and fairly across the team. Most routing problems come from rules in the wrong order or from data the rules can't read.

## Routing methods

| Method | How it works | Use when |
|---|---|---|
| **Account match** | lead's domain or company matches an existing account → account owner | always first, so known accounts stay with their owner |
| **Territory** | rules on region, segment, industry or size → territory owner or team | clear territory model exists |
| **Round robin** | rotate among a pool of reps | equal pool, no territory distinction |
| **Weighted round robin** | rotate with weights (e.g. ramping reps get fewer) | uneven capacity |
| **Load-based** | assign to the rep with the fewest open leads | volume varies a lot |

Most companies combine them: account match → territory → round robin within the territory team.

## Rule-order template

Rules run top to bottom; the first match wins.

```
1. Existing customer (domain matches a customer account) → CSM or account owner, notify
2. Open opportunity on the account → opportunity owner
3. Existing account owned by a rep → account owner
4. Named / strategic account list → named account owner
5. Territory rules (region → segment → industry) → territory team round robin
6. Partner-sourced → partner manager
7. Missing data (no country, no company) → enrichment queue, then re-route
8. Catch-all → RevOps queue with alert (should be rare; investigate every one)
```

Write each rule with its inputs, the outcome, an owner of the rule and the date it was last reviewed.

## Data the rules need

Routing is only as good as its inputs: country, company size, domain, segment. Plan for:

- **Enrichment** before routing, with a short wait or a fallback if enrichment fails
- **Free email domains** (gmail.com etc.) that can't match accounts — route by other fields
- **Normalised values** (country list, size bands) so rules don't miss "U.S." vs "United States"

## Fairness and availability

- Exclude reps who are out of office or at capacity; reassign their pool's leads.
- Review distribution monthly: did each rep in a pool get a fair share, adjusted for weights?
- Document how ties and re-routes are handled.

## Test cases

Before any routing change, run these through the sandbox or a test mode and record the result:

- [ ] Existing customer domain
- [ ] Domain matching an account with an open opportunity
- [ ] Named account
- [ ] Each territory boundary (one case either side of each rule)
- [ ] Free email domain
- [ ] Missing country
- [ ] Rep in the pool is marked unavailable
- [ ] Duplicate lead for an existing contact
- [ ] Lead from a newly added source

## Lead routing time

```
Routing time (per lead) = owner assignment time − lead creation time
```

- Report the **median** and a high percentile (for example the 90th); a few stuck leads hide in a median.
- Count leads in the catch-all queue as unrouted until assigned.
- Pair it with **speed to first touch** (`first rep activity − assignment time`) so routing and rep response can be told apart.
- Report **misroutes**: leads reassigned manually after routing ÷ leads routed. A rising rate means a rule is wrong.

## When to review routing

- Territories or team changes
- A new lead source or form
- Routing time or misroute rate misses target
- On a regular schedule (quarterly is common), even without complaints

## Pitfalls

- **Rules nobody owns.** Old exceptions pile up. Every rule has an owner and a review date.
- **Changing rules mid-quarter** without telling the team.
- **Routing before enrichment** sends leads to the catch-all.
- **No alert on the catch-all.** Unrouted leads go cold.
