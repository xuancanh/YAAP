---json
{ "title": "Metric specs", "summary": "A copyable metric spec for /org/data/metrics.md and the definition questions that decide whether two people get the same number.", "tags": ["data", "metrics", "governance", "definitions"], "updated": "2026-11-04" }
---

# Metric specs

A metric is only trustworthy if anyone who follows its spec gets the same
number. Most disputes between functions are not about the data at all: one
team counts trials, the other doesn't; one uses calendar months, the other
rolling 30 days. The spec settles those choices once, in writing, with an
owner.

## The spec

One block per metric in `/org/data/metrics.md`. Fill every field; "n/a" is
an answer, a blank is not.

```markdown
### <Metric name>  (id: <slug>, version <n>)
- Definition: one plain sentence a non-analyst understands.
- Formula: numerator ÷ denominator (or the aggregate), with each term defined.
- Grain: what one row is (per account per day, per order, per session).
- Time window: calendar day/week/month, rolling N days, as-of date; time zone.
- Filters / exclusions: test accounts, internal users, refunds, trials, bots.
- Source: table or metric source id (org_metric_sources); query link.
- Freshness: how often it updates and the SLA (see quality/critical.md).
- Owner: the function head who decides the definition; steward: the data member.
- Used by: key results, dashboards, reports that depend on it.
- Caveats: known gaps, backfills, breaks in history.
- Change log:
  - <yyyy-mm-dd> v<n>: what changed, why, effect on history, who agreed.
```

## Questions that settle a definition

Walk through these with the owning function head before you publish.

1. **Who or what is counted?** Users, accounts, seats, orders? Is a
   reactivated customer new?
2. **What is excluded?** Internal and test accounts, free tiers, refunds,
   fraud, bots. Exclusions belong in the spec, not in someone's query.
3. **Which timestamp?** Created, paid, shipped, recognised. Revenue
   metrics differ most here; agree with finance.
4. **Which time zone and window?** A "day" in UTC and a day in the
   company's local time give different daily numbers.
5. **Ratio of what to what?** For any rate, name both terms. "Conversion"
   could mean visitors→signups, signups→paid, or trials→paid.
6. **Mean or median?** Skewed values (revenue per customer, response time)
   usually need a median, or both.
7. **What happens to history?** When the definition changes, do you
   restate the past or mark a break?

## Worked example (made-up)

"Active customers" is disputed: Sales counts any account with a contract;
Product counts accounts with a login in the last 30 days. The spec records
both as separate metrics with honest names: `contracted_accounts` and
`active_accounts_30d`. The key result "grow active customers" is tied to
`active_accounts_30d` because that is what the objective means; the
decision goes in `/org/decisions.md` and the Product head agrees as owner.

## Key results and sources

Every company key result should point at a catalogued metric and a live
metric source. When it doesn't:

- propose the source with `org_propose_metric_source` (the CEO approves);
- until then the key result is **self-reported**, and the report says so;
- record coverage: key results with an approved source ÷ all company key
  results × 100. That is the definition coverage KPI.

Monthly, read a sample value with `org_metric_read` and recompute it from
the spec. A mismatch is a finding, whichever side is wrong.

## Common pitfalls

- **Same name, different metric.** Two dashboards both say "MRR" and
  differ. Rename one or retire it.
- **Silent definition changes.** A change without a change-log entry and an
  `org_message` makes every trend line a lie.
- **Ratios of averages.** Average of per-segment rates is not the overall
  rate; compute from the totals.
- **Definition by query.** If the only definition is the SQL, nobody
  outside the data team can check it. Write the sentence first.
- **No owner.** The data unit stewards definitions; the function that uses
  the metric owns what it means.
