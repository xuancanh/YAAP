---json
{ "title": "Unit economics definitions", "summary": "Precise formulas, inputs and pitfalls for CAC, payback, gross margin, LTV, net revenue retention and cost per accepted task, with a worked example.", "tags": ["unit-economics", "cac", "ltv", "payback", "gross-margin", "definitions"], "updated": "2026-11-04" }
---

# Unit economics definitions

Unit economics answer one question: does each new customer earn back what it cost to win and serve them, and how fast? The definitions below are common and defensible. Whatever you use, write it down in `/org/finance/kpis.md` and keep it fixed so the trend is real.

## Gross margin

> **Gross margin %** = (revenue − cost of revenue) ÷ revenue

Cost of revenue is what it costs to deliver the service: hosting and infrastructure, third-party software inside the product, payment processing, customer support, and the agent spend that delivers customer work. Sales, marketing and R&D are not cost of revenue. Decide where each cost goes once and document it.

## CAC (customer acquisition cost)

> **CAC** = sales and marketing cost in the period ÷ new customers acquired in the period

- **Fully loaded** includes salaries, tools, agent spend for sales and marketing work, programmes and paid media. **Paid-only CAC** includes only media spend; useful for channel decisions, misleading for the business. Say which.
- Lag: spend this quarter often wins customers next quarter. If the sales cycle is long, compare spend in one period with customers in the next, and say so.
- By segment where possible; a blended CAC hides an expensive segment.

## CAC payback

> **Payback (months)** = CAC ÷ (average new-customer monthly revenue × gross margin %)

Use gross margin, not revenue. A payback on revenue looks better than reality.

## LTV (customer lifetime value)

> **LTV** = average monthly revenue per customer × gross margin % ÷ monthly churn rate

- 1 ÷ monthly churn is the implied average lifetime in months. At low churn this gives very long lifetimes and a very large LTV; many teams cap the lifetime (e.g. at a fixed number of years) to stay conservative. State any cap.
- With little history, churn is noisy. Show the sample size and say the LTV is indicative.
- **LTV:CAC** is a ratio of two estimates. Report it with the inputs, never alone.

## Churn and retention

> **Customer churn rate (monthly)** = customers lost in the month ÷ customers at the start of the month
> **Gross revenue retention (GRR)** = (starting recurring revenue − churned − contraction) ÷ starting recurring revenue
> **Net revenue retention (NRR)** = (starting recurring revenue − churned − contraction + expansion) ÷ starting recurring revenue

Measure GRR and NRR on a fixed cohort (customers at the start of the period), usually over 12 months. New customers in the period are excluded.

## Cost per accepted task (agent workforce)

> **Cost per accepted task** = agent spend in the period ÷ tasks accepted in the period

- Read it from `org_costs`; don't estimate. Split by task class or agent where the tool allows, since a research task and a short reply are not comparable.
- **Cost per objective** = agent spend attributed to an objective ÷ objectives achieved (or per key result moved). Note how attribution was done.
- Trend matters more than level: is the same kind of work getting cheaper as playbooks improve?

## Worked example

Quarter: sales and marketing cost 120,000; 40 new customers; average new-customer revenue 400 per month; gross margin 75%; monthly churn 2%.

- CAC = 120,000 ÷ 40 = 3,000.
- Monthly gross margin per customer = 400 × 0.75 = 300.
- Payback = 3,000 ÷ 300 = 10 months.
- LTV = 300 ÷ 0.02 = 15,000 (implied lifetime 50 months; if capped at 36 months, LTV = 10,800).
- LTV:CAC = 5.0 uncapped, 3.6 capped. Report both and the cap.

## Caveats to always state

- Period and data sources; whether figures are from closed books.
- Sample size (number of customers, months of churn history).
- Anything excluded (a large one-off deal, a promotional cohort).
- Definition changes since last quarter, with restated prior figures.
