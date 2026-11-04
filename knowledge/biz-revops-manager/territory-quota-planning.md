---json
{ "title": "Territory and quota planning", "summary": "The capacity model, territory balancing and quota-setting arithmetic behind the planning playbook, with a worked example and sensitivity checks.", "tags": ["revops", "quota", "territory", "capacity", "planning"], "updated": "2026-11-04" }
---

# Territory and quota planning

Quota planning connects three numbers: what the company needs (the target), what the team can produce (capacity) and what the market can give (territory potential). A plan is fair when quotas follow potential and ramp, and believable when capacity covers the target with a margin that your forecast accuracy history justifies. Quotas and compensation are decisions for the chief or the CEO. You deliver the model and the alternatives.

## Inputs (agree them with the Head of Sales and write them down)

| Assumption | Source |
|---|---|
| Full productive quota per seller per period | Attainment history; else labelled estimate |
| Ramp schedule (share of full productivity by month since start) | History of past starters; else estimate |
| Attrition (sellers expected to leave per year) and backfill delay | History / HR |
| Win rate, average deal size, cycle length | funnel-metrics definitions, trailing window stated |
| Planned hires and start dates | Head of Sales hire plan |

For agent sellers, "ramp" and "attrition" may be small or zero, but capacity is still finite: WIP limits and review throughput (org_capacity) limit how many deals one seat can carry.

## The capacity model

```
Effective capacity = Σ over sellers and months of (full monthly productivity × ramp factor for that month)
                   − expected loss from attrition and backfill gaps
Coverage of target = effective capacity ÷ company target
```

**Worked example (made-up figures).** A quarterly target of 900,000. Full productivity is 100,000 per seller per month. The ramp is 25% in month 1, 50% in month 2, 75% in month 3 and 100% after that.

- 3 tenured sellers × 3 months × 100,000 = 900,000
- 1 new seller starting month 1: 25,000 + 50,000 + 75,000 = 150,000
- Effective capacity = 1,050,000, so coverage = 1.17× target

Whether 1.17× is enough is a judgement backed by evidence. If last year's forecasts ran consistently optimistic, the plan needs more margin. The company records that margin as a planning default and you tune it from history.

## Pipeline needed

Work backwards so marketing and sales know what to generate:

```
Pipeline needed = target remaining ÷ win rate (value)
Opportunities needed = pipeline needed ÷ average deal size
Created by = period end − typical cycle length
```

## Balancing territories

Divide accounts so each territory has comparable **potential**, not comparable account counts. For each territory, list:

- [ ] Number of target accounts, and estimated potential (with the method stated: company size, segment, prior spend)
- [ ] Existing customers and their expansion potential
- [ ] Open pipeline carried in
- [ ] Time zones, languages or regulatory constraints, where relevant
- [ ] The rule for accounts that cross territories (who owns a subsidiary, a new contact at an owned account)

Check the spread: if one territory has much higher potential per quota unit than the others, rebalance or set quotas proportionally. Write down the rules of engagement (ownership, splits, how a lead gets reassigned) before the period starts. Disputes are cheapest to settle in advance.

## Setting quotas per seller

```
Seller quota ≈ territory potential share × total quota pool, adjusted for ramp
```

Then sanity-check the **expected attainment distribution**: if the plan is fair, most sellers should be able to reach a good share of quota, and a few should overachieve. If the model says half the team will land far below quota, the plan is wrong, not the team.

## Sensitivity table (include it in the plan)

```markdown
| If… | Effective capacity | Coverage | Gap | Mitigation |
|---|---|---|---|---|
| Base case | | | | |
| New hire starts one month late | | | | |
| Win rate 20% lower | | | | |
| One tenured seller leaves mid-period | | | | |
| Average deal size 15% lower | | | | |
```

## Common pitfalls

- Setting quotas by dividing the target by headcount.
- Counting a new hire at full productivity from day one.
- Building the plan on win rates and deal sizes from a different segment or period.
- Changing territories mid-period without a written rule for pipeline already in flight.
- Presenting a single plan with no alternatives. The chief needs at least a base and a conservative option.
