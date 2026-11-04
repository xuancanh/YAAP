---json
{ "title": "Sampling", "summary": "How the Auditor picks what to test — random, systematic, risk-weighted and judgmental selection — how to reason about sample size without invented numbers, and how to record the sample.", "tags": ["sampling", "method", "audit"], "updated": "2026-11-04",
  "sources": [
    { "title": "ISA (UK and Ireland) 530 Audit Sampling, Appendix 4: Sample selection methods", "url": "https://www.charteredaccountants.ie/chariotindex/text/apb_isa_530_2010/30.html", "publisher": "Chartered Accountants Ireland", "note": "Random, systematic, haphazard and block selection; haphazard not appropriate for statistical sampling; block rarely appropriate for population inferences." }
  ] }
---

# Sampling

You can't read everything, so you read a sample and say honestly what it lets you conclude. Audit standards keep two things apart: **audit sampling** (ISA 530), where every item in the population has a chance of selection so you can say something about the whole, and **selecting specific items** (ISA 500's term), where you pick items because they matter, which tells you about those items only.

## Define the population first

Write down, before selecting anything:

- **What**: accepted tasks, scope widenings, `auto_*` rows, spend commits, reported numbers, decision-log rows.
- **Period**: since the last audit (the date of the last org_audit_close), or the period an assurance request names.
- **Boundaries**: which units and members; whether reopened tasks count.
- **Size**: how many items the population holds (org_read_board, org_audit_query).

A conclusion only reaches the population you defined. "Acceptance looks sound" means "across accepted tasks in this period, in these units".

## Selection methods

| Method | How | Use when | Limits |
|---|---|---|---|
| Random | every item equally likely; pick by a seeded random draw over the ids, and record the seed | you want a fair picture of the whole population | can miss rare, high-risk items |
| Systematic | every k-th item after a random start, where k = population size ÷ sample size | the list has no order that lines up with k | breaks if the list has a pattern (e.g. one reviewer per k items) |
| Risk-weighted | split the population into strata (by member, value, novelty) and sample more heavily from the risky strata | some items carry more risk than others | say how you weighted; don't project one stratum onto another |
| Judgmental / targeted | pick specific items for a reason | assurance requests, items with warn signals, outliers, constraint-touching work | describes only the items picked, never the population |
| Haphazard | "whatever caught my eye" | avoid | ISA 530 calls it unsuitable for statistical sampling; it hides bias |
| Block | a run of consecutive items | avoid for population conclusions | ISA 530 says it's rarely appropriate for inferences about the whole |

A good default is both: a random sample for the population picture, plus a short targeted list for the items you'd be embarrassed to miss. Report them separately.

## Risk factors worth weighting

- work that touched an outward action, money, a constraint or customer data;
- members new to their seat, recently re-modelled, or with incidents;
- self-review, or review on the same model family;
- review accepted in one round on a long or complex task;
- reviewers who accept nearly everything;
- vague or missing done_when rubrics;
- spend far from the role's median per accepted task;
- anything an assurance request names.

## Sample size: reason, don't invent

The company sets the default sample size (an audit tunable); start there. Then adjust and say why. The standard's logic, not a formula you'd have to make up numbers for:

- **Bigger** when the population is riskier, when the profile puts trust or compliance first, when last audit found problems in this area, or when you need more confidence in a "this holds" conclusion.
- **Smaller** when the population is tiny (test all of it instead), when strong system controls already check the same thing, or when the area was clean last time and nothing changed.
- **Test 100%** when the population is small enough to read in full, or every item is high-risk (for example every spend commit past a threshold).

When the run's budget (`auditUsdCap`) can't cover the sample you wanted, test what you can and say plainly that the sample was cut and what that limits.

## What a deviation tells you

When a random sample turns up deviations, ask whether they look like the population or are a one-off. A deviation with an identifiable, isolated cause (one member, one day, one outage) is noted as such; several deviations sharing a cause are a pattern finding. Don't extrapolate a rate from a targeted sample. If you do state a rate from a random sample, show the count: "2 of the 15 tasks sampled", not "13%".

## Record the sample

Put this in the closing summary so anyone can repeat it:

```markdown
Population: accepted tasks, <units>, <from>–<to>, <N> items (source: org_read_board)
Random sample: <n> items, seed <seed>, ids: [task:…], [task:…]
Targeted: [task:…] (assurance request [task:…]), [task:…] (warn signal)
Not tested: <what and why — budget cap, data missing>
```

## Common pitfalls

- Concluding about the population from targeted items.
- Picking "interesting" items and calling it random.
- Changing the population halfway through without saying so.
- Quietly shrinking the sample when time or budget runs short.
