---json
{ "title": "Marketing metrics and formulas", "summary": "Definitions and formulas for the funnel, CAC, pipeline, ROAS and LTV:CAC, with a worked example and the mistakes that make them lie.", "tags": ["metrics", "cac", "pipeline", "funnel", "kpis", "marketing"], "updated": "2026-11-04" }
---

# Marketing metrics and formulas

Write each definition into `/org/marketing/kpis.md` before you set a target against it. The KPI audit checks what was computed against what's written there, so a metric with no written definition is a finding waiting to happen.

## The funnel

| Stage | Definition you must write down |
|---|---|
| Lead | A contact who gave details (form, sign-up, event scan). |
| MQL (marketing qualified lead) | A lead meeting criteria marketing sets: fit (segment, size, role) and intent (actions taken). |
| SQL (sales qualified lead) | An MQL that sales has reviewed and accepted as worth pursuing. Sales owns acceptance, not marketing. |
| Opportunity / pipeline | An SQL with a deal and an expected value in the CRM. |
| Won | A closed deal. |

Agree the MQL and SQL definitions with the Head of Sales and record the agreement as a decision. If sales changes its acceptance rules mid-quarter, conversion moves for reasons that have nothing to do with marketing; note the date in the report.

**Stage conversion** = count reaching stage N+1 ÷ count that entered stage N, for the same cohort (for example, leads created in the same month). Mixing cohorts (this month's SQLs over this month's MQLs when sales takes three weeks to accept) understates recent months. State the cohort rule in kpis.md.

## Cost metrics

- **Cost per lead / MQL / SQL** = spend in the period ÷ count at that stage in the period, per channel.
- **Paid CAC** = paid acquisition spend ÷ new customers attributed to paid channels.
- **Blended CAC** = all sales and marketing cost (paid media, tools, content production, agent and people cost, events) ÷ all new customers in the period, whatever their source.

Paid CAC flatters paid channels because it ignores the organic and brand work that made the click cheap. Blended CAC is the honest company number. Report both, and write in kpis.md exactly which costs each includes. "Which costs were included" is the commonest drift an audit finds.

- **CAC payback (months)** = CAC ÷ (monthly revenue per new customer × gross margin %). Compute it only when revenue and margin come from a source (finance or billing); otherwise leave the cell empty.
- **LTV (lifetime value)**, simple form = monthly revenue per customer × gross margin % ÷ monthly churn rate. It's only as good as the churn figure, which in a young company rests on too little history to trust. Label it an estimate.
- **LTV:CAC** = LTV ÷ CAC. Plenty of articles quote a "good" ratio; don't adopt one by default. The company sets its threshold in kpis.md, with the reason.

## Pipeline

- **Pipeline sourced**: opportunity value whose first (or agreed) touch was marketing. One opportunity is sourced by exactly one function.
- **Pipeline influenced**: opportunity value where marketing touched the account at any point before close. One opportunity can be influenced by several functions, so influenced totals across functions add up to more than the pipeline. Never add sourced and influenced together, and never compare your influenced figure with sales' sourced figure.

## Channel and reach

- **ROAS (return on ad spend)** = revenue attributed to the ad spend ÷ ad spend. It inherits every weakness of the attribution model (see [Attribution and channel experiments](./attribution-and-experiments.md)). Platform-reported ROAS uses the platform's own attribution and often claims more than the CRM shows.
- **Share of voice** = your mentions (or impressions, or ranked keywords) ÷ the total for a named competitor set, in the same window and source. Write the competitor set and the source down; change either and the series breaks.
- **Organic sessions / sign-ups**: from the analytics source, with bots and internal traffic filtered by a stated rule.

## Worked example (made-up figures)

A month with $12,000 paid media, $8,000 of other marketing cost, 400 leads, 120 MQLs, 30 SQLs and 6 new customers, 4 of them attributed to paid:

- MQL→SQL = 30 ÷ 120 = 25%
- Paid CAC = 12,000 ÷ 4 = $3,000
- Blended CAC = (12,000 + 8,000) ÷ 6 ≈ $3,333
- Cost per SQL across all spend = 20,000 ÷ 30 ≈ $667

The gap between $3,000 and $3,333 is the cost the paid number hides.

## Common pitfalls

- Reporting a ratio without its counts. Always show the numerator and denominator.
- Counting a lead in the month it became an MQL in one table and the month it was created in another.
- Ad-platform numbers reported as if they were CRM numbers. Label the source on every row.
- Small counts: 2 SQLs to 4 SQLs is "doubled" and means little. Say the counts.
- A metric that jumps right after a tracking change. Check what changed before you celebrate.
