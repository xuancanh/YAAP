---json
{ "title": "Paid media optimisation playbook", "summary": "A weekly method for diagnosing paid campaigns from the funnel backwards, choosing one change, and testing creative and audiences without fooling yourself.", "tags": ["paid media", "optimisation", "testing", "ads"], "updated": "2026-11-04" }
---

# Paid media optimisation playbook

Weekly optimisation is diagnosis, then one deliberate change, then patience. The common failure is changing many things every week in response to noise, which resets platform learning and makes it impossible to say what worked.

## The weekly routine

1. **Pull the data** for each live campaign: spend, impressions, clicks, conversions (leads), and downstream MQLs and SQLs from the CRM, for the last 7 days and the last 28 days.
2. **Check tracking first.** A sudden drop to zero conversions is usually tracking, not performance. Compare platform conversions with CRM leads.
3. **Compare against the plan:** cost per SQL vs the ceiling, pacing vs budget.
4. **Diagnose** with the tree below.
5. **Choose at most one or two changes per campaign,** write them in `/org/marketing/campaigns/<name>-changes.md` with the reason and the date you'll judge them.
6. **Stay inside the allocation.** Moving budget between your own campaigns is fine if the plan allows; anything beyond goes to your manager.

## Diagnosis tree: work from the bottom of the funnel up

The metric to optimise is cost per SQL (or pipeline), not cost per click. Cheap leads that sales rejects are expensive.

```
Cost per SQL above ceiling?
├─ MQL→SQL rate low?   → lead quality: audience, offer or targeting is wrong
│                        → check rejected-lead reasons from sales; tighten audience,
│                          add exclusions, raise intent of offer
├─ Lead→MQL rate low?  → the offer attracts the wrong people, or scoring is off
│                        → review offer fit; check the lead scoring guide
├─ Landing conversion low (leads / clicks)? → page or form problem
│                        → page speed, message match with the ad, form length
├─ Click-through low (clicks / impressions)? → creative or relevance
│                        → new creative angles; check ad matches audience pain
└─ Cost per click high? → competition or narrow audience
                         → broaden carefully, test bid strategy, check quality signals
```

Fix the lowest broken stage first. Better creative won't help if the leads are the wrong people.

## Formulas you'll use

```
CTR                  = clicks / impressions
CPC                  = spend / clicks
Landing conversion   = leads / clicks (or landing sessions)
CPL                  = spend / leads
Cost per SQL         = spend / SQLs (cohort)
Pacing               = spend to date / (budget × share of period elapsed)
```

See the [funnel metric definitions](funnel-metric-definitions.md) for cohort rules.

## Making changes well

- **Respect learning periods.** Automated bidding systems need conversion volume to settle. Big budget or targeting changes can restart that learning. Check the platform's current guidance on how much change triggers it.
- **Change budgets in steps,** not sudden doublings, and give each step time before judging.
- **Pause, don't delete,** so history stays available.
- **Exclusions are cheap wins:** existing customers, employees, job seekers (if relevant), irrelevant search terms from the search-terms report.

## Creative and audience tests

A test needs a question, one variable and enough data to answer it.

1. **Hypothesis:** "A pain-led headline will get more SQLs per spend than a feature-led one for finance leads."
2. **One variable:** change the headline only; keep image, audience, offer and budget the same.
3. **Success metric:** chosen before you start, ideally downstream (MQLs or SQLs), with CTR as an early signal.
4. **Run time:** long enough to cover weekly patterns (at least a full week) and to collect enough conversions. If volume is too small for a clear answer, say "inconclusive" rather than calling a winner.
5. **Record** the result and the decision in the changes file, including losers. They're useful.

With small conversion numbers, differences of a few leads are noise. Prefer fewer, bigger tests (a new angle or offer) over many tiny ones (button colour).

## Creative fatigue

Signs: frequency rising, CTR falling, CPC rising on an unchanged audience. Refresh with a new angle, not just a new colour. Keep a library of angles tried and their results.

## Policies and compliance (time-sensitive)

Each ad platform has its own policies on claims, restricted categories, targeting of sensitive characteristics, and personal data use. They change often and vary by region. Before a new campaign type, read the platform's current policy pages; if an ad is disapproved, fix the cause rather than rewording to get around review. Claims in ads must be ones the company can substantiate.

## Weekly change log entry

```markdown
## 2026-11-03 — <campaign>
- Observed: cost per SQL 310 vs ceiling 250 (28d); MQL→SQL 12% vs 20% plan
- Diagnosis: sales rejected 9 of 14 as "too small"
- Change: added company-size exclusion < 20 employees
- Judge on: 2026-11-17, metric: MQL→SQL and cost per SQL
```
