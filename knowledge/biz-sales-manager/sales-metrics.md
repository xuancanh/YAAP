---json
{ "title": "Sales metrics", "summary": "Formulas and definition choices for bookings, pipeline created, coverage, win rate, cycle length, deal size, attainment and forecast accuracy.", "tags": ["sales", "metrics", "kpis", "win-rate", "coverage", "velocity"], "updated": "2026-11-04",
  "sources": [
    { "title": "How to Supercharge Your Sales Velocity for Quicker Wins", "url": "https://www.salesforce.com/blog/sales-velocity/", "publisher": "Salesforce", "accessed": "2026-11-04", "note": "Sales velocity formula" }
  ] }
---

# Sales metrics

Your audit playbook checks whether this month's numbers were computed the way kpis.md says. This doc lists the choices each metric needs written down. Agree them with RevOps, who own the shared funnel definition: sales and RevOps should never report two different win rates.

## Outcome metrics

| Metric | Formula | Choices to pin down in kpis.md |
|---|---|---|
| **Bookings / new ARR** | Σ annualised recurring value of contracts signed in the period | Signature date or start date? New only, or new + expansion? Multi-year: first-year value or total contract value? |
| **Quota attainment** | Seller bookings ÷ seller quota | Ramp-adjusted quota for new members? |
| **Attainment distribution** | Share of sellers at each band (e.g. under 50%, 50–80%, 80–100%, over 100%) | The bands |
| **Forecast accuracy** | 1 − abs(actual − forecast) ÷ actual, at a fixed snapshot | Which snapshot (e.g. week 4 of quarter); which call (commit or most likely) |

## Pipeline metrics

| Metric | Formula | Choices to pin down |
|---|---|---|
| **Pipeline created** | Σ amount of opportunities created (or qualified) in the period | Created date or qualified date; by source and owner |
| **Coverage** | Open pipeline closing in the period ÷ remaining target | Weighted or unweighted; only after hygiene fixes |
| **Weighted pipeline** | Σ (amount × stage probability) | Probabilities from your own history, from kpis.md |
| **Stage conversion** | Deals reaching stage N+1 ÷ deals reaching stage N | Cohort (preferred) or period |

## Efficiency metrics

| Metric | Formula | Choices to pin down |
|---|---|---|
| **Win rate** | Won ÷ (won + lost), for deals closed in the period | Count or value (report both); what counts as lost vs disqualified early |
| **Average deal size** | Won amount ÷ won count | Exclude outliers or show the median as well |
| **Sales cycle** | Median days from opportunity created to closed-won | Created date or qualified date |
| **Sales velocity** | (Open opps × avg deal size × win rate) ÷ cycle days | Same definitions as the parts |

Leave open deals out of the win-rate denominator, otherwise the rate moves with pipeline volume. Use the median for cycle length, because one ancient deal distorts an average.

## Worked example: is the quarter reachable? (made-up figures)

Remaining target 300,000. Open pipeline closing this quarter 750,000. Historical win rate by value 30%. Six weeks left; median cycle 70 days.

- Coverage = 750,000 ÷ 300,000 = 2.5×
- Expected from current pipeline = 750,000 × 0.30 = 225,000
- Gap = 75,000. New pipeline created now is unlikely to close this quarter, because the cycle is longer than the time left. So the gap has to come from moving existing deals forward or from expansion, which is a different plan from "generate more pipeline".

The coverage ratio alone ("2.5×, looks fine") hid the answer. Always convert coverage into an expected number using your own win rate.

## Leading vs lagging

Pair every lagging key result (bookings, win rate) with a leading one you can move this week (pipeline created, stage conversion, deals with a mutual close plan). Activity counts (emails sent, calls made) are inputs, not results. Coach on them only when an outcome metric points to them.

## Agent sales team specifics

- Measure each specialist agent on outcomes in its scope: SDR on qualified meetings accepted by the AE, AE on stage conversion and win rate, Sales Engineer on technical-validation pass rate and cycle time in its stages.
- First-review acceptance (from org_review) and forecast calibration (org_calibration) are quality metrics worth tracking per member.

## Common pitfalls

- Bookings counted on invoice date in the sales report and on signature date in finance's.
- Win rate quoted without saying whether it's count or value.
- Pipeline "created" that was really re-opened or re-dated old pipeline.
- Comparing your numbers to a benchmark from a blog post. Compare against plan and your own trend.
- Celebrating coverage while the close dates behind it are stale.
