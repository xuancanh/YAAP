---json
{ "title": "Customer metrics", "summary": "Definitions and formulas for retention (GRR, NRR, logo churn), sentiment (CSAT, NPS, CES) and support (first response, resolution, SLA attainment, backlog age) metrics.", "tags": ["metrics", "kpis", "retention", "nrr", "csat", "nps", "support"], "updated": "2026-11-04",
  "sources": [{ "title": "Measuring Your Net Promoter Score", "url": "https://www.netpromotersystem.com/about/measuring-your-net-promoter-score/", "publisher": "Bain & Company", "accessed": "2026-11-04" },
              { "title": "The One Number You Need to Grow", "url": "https://hbr.org/2003/12/the-one-number-you-need-to-grow", "author": "Frederick F. Reichheld", "publisher": "Harvard Business Review", "date": "2003-12" },
              { "title": "Stop Trying to Delight Your Customers", "url": "https://hbr.org/2010/07/stop-trying-to-delight-your-customers", "author": "Matthew Dixon, Karen Freeman, Nick Toman", "publisher": "Harvard Business Review", "date": "2010-07" }] }
---

# Customer metrics

Write one definition per metric in `/org/customer/kpis.md` and compute it the same way every time. Most disagreements are about the denominator, the clock, or how downgrades count. Values come from the billing, CRM or helpdesk source. Don't quote industry benchmarks unless they come from a cited source that fits the company's segment; targets are the company's to set.

## Retention (revenue measured as recurring revenue, MRR or ARR)

Take the cohort of customers who existed at the **start** of the period. Revenue from customers acquired during the period is excluded from both metrics.

**Gross revenue retention (GRR, %)** = (starting recurring revenue − churned revenue − contraction) ÷ starting recurring revenue × 100. Expansion isn't counted, so GRR can't exceed 100%.

**Net revenue retention (NRR, %)** = (starting recurring revenue + expansion − contraction − churned revenue) ÷ starting recurring revenue × 100. It can exceed 100% when expansion outweighs losses.

**Logo churn (%)** = customers from the starting cohort who left during the period ÷ customers at start × 100.

State in kpis.md: monthly or annual measurement, how a downgrade at renewal counts (contraction), whether price increases count as expansion, and how currency is handled.

### Worked example (made-up figures)

Start of year: 50 customers, 1,000,000 ARR. During the year 4 customers churn (80,000), others downgrade by 30,000 and expand by 150,000.

- GRR = (1,000,000 − 80,000 − 30,000) ÷ 1,000,000 = 89%
- NRR = (1,000,000 + 150,000 − 30,000 − 80,000) ÷ 1,000,000 = 104%
- Logo churn = 4 ÷ 50 = 8%

## Sentiment

**CSAT (%)** = satisfied responses ÷ all responses × 100. On a 1-5 scale "satisfied" usually means 4 or 5, and kpis.md says which. Report the response rate alongside it.

**NPS** (Reichheld, Harvard Business Review, 2003; Bain & Company): "How likely are you to recommend us to a friend or colleague?" on a 0-10 scale. Promoters answer 9-10, passives 7-8, detractors 0-6. NPS = % promoters − % detractors, from −100 to +100. Passives count in the total but not in the score.

**CES (customer effort)** comes from Dixon, Freeman and Toman's 2010 Harvard Business Review article, which argued that reducing customer effort builds loyalty more than delighting customers does. A common form asks after an interaction how far the customer agrees that the company made it easy to handle their issue, on a 1-7 agreement scale. Report the mean or the % who agree (5-7), say which, and keep the question and scale fixed.

## Support

**First response time** = time of the first public reply to the customer − ticket creation time. Use the median per priority. Say whether auto-acknowledgements count (usually not) and whether the clock runs in business or calendar hours.

**Time to resolution** = time solved − time created. Use the median per priority. Say how reopened tickets count: the clock continues, or a new ticket is opened.

**SLA attainment (%)** = tickets whose SLA target fell due in the period and was met ÷ all tickets whose SLA target fell due in the period × 100. Compute it separately for first response and resolution.

**Backlog age** = now − creation time for each open ticket. Report the count of open tickets past their SLA and the oldest or 90th-percentile age, not just the mean.

**Reopen rate (%)** = solved tickets reopened within the window in kpis.md ÷ tickets solved × 100. A low reopen rate keeps resolution-time gains honest.

## kpis.md entry template

```markdown
### <Metric>
- Formula: <numerator> ÷ <denominator> × 100
- Population / clock: <cohort, which tickets, business vs calendar hours, pauses>
- Source: <billing / CRM / helpdesk; org_metric_sources id>
- Cadence: <daily / weekly / monthly>   Owner: <role>
- Target: <value> (set by <who>, <date>)
- Caveats: <response rate, small base, currency>
```

## Common pitfalls

- **Including new customers** in the retention denominator or numerator.
- **Status games:** setting tickets to pending to stop the SLA clock, or closing before the customer confirms. The audit looks for both.
- **Means for time metrics.** A few old tickets distort the mean. Use medians plus a tail measure.
- **Survey sentiment with no response rate.** Ten answers from happy customers aren't a trend.
- **Mixing ARR and MRR** across reports, or annual GRR against monthly churn.
