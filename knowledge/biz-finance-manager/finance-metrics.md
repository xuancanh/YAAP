---json
{ "title": "Finance metrics and formulas", "summary": "Definitions and formulas for the core finance KPIs, so kpis.md, reports and audits compute every number the same way.", "tags": ["finance", "metrics", "kpis", "runway", "dso", "margin"], "updated": "2026-11-04",
  "sources": [
    { "title": "What does Days Sales Outstanding mean and how do you calculate it?", "url": "https://agicap.com/en/article/days-sales-outstanding/", "publisher": "Agicap", "accessed": "2026-11-04", "note": "DSO formula and the credit-sales variant" }
  ] }
---

# Finance metrics and formulas

A metric is only useful if it means the same thing every month. Put each one in /org/finance/kpis.md with its formula, period, source and owner, and compute it from closed numbers. When a formula below has variants, pick one, write it down and stick with it. Changing it later is a decision: log it and restate the history, or break the trend line on purpose and say so.

## Cash and runway

- **Gross burn** = total operating cash paid out in the period.
- **Net burn** = operating cash out − operating cash in. Leave financing out (equity raised, loans drawn), so that raising money doesn't make the business look healthier.
- **Runway (months)** = cash on hand ÷ average monthly net burn. Say which burn figure you used. The skill uses the trailing 3-month average. Also show the current month when it's very different.
- **Lowest cash point** = the lowest weekly closing balance in the 13-week forecast, with its date. A company can have 12 months of runway and still run out of cash in week 6.

Worked example (made-up figures): cash is 1,200,000. Net burn over the last three months was 90,000, 110,000 and 100,000, so average net burn is 100,000 and runway is 12.0 months. If the current month's burn is 130,000, also report "9.2 months at the current rate".

## Margins

- **Gross margin %** = (revenue − cost of revenue) ÷ revenue. Write down what counts as cost of revenue (hosting, third-party fees, support staff, agent spend on delivery work) and don't change it.
- **Contribution margin** = revenue − all variable costs (cost of revenue plus variable selling costs such as payment fees and commissions). Contribution margin % = contribution margin ÷ revenue.
- **Operating margin %** = operating income ÷ revenue.

## Unit economics

- **CAC (customer acquisition cost)** = sales and marketing cost of acquiring new customers in a period ÷ new customers won in that period. Say whether it's fully loaded (salaries, tools, agent costs) or media-only.
- **CAC payback (months)** = CAC ÷ (new monthly recurring revenue per new customer × gross margin %). Use gross margin, not revenue, or the payback period looks shorter than it really is.
- **LTV**: don't use it unless churn has been measured long enough to mean something. Report CAC payback and retention instead.

## Working capital

- **Working capital** = current assets − current liabilities.
- **DSO (days sales outstanding)** = accounts receivable ÷ credit revenue for the period × days in the period. Use credit (invoiced) revenue, not cash sales. Some teams use average receivables instead. Pick one.
- **DPO (days payables outstanding)** = accounts payable ÷ cost of goods sold (or purchases) for the period × days in the period.
- **DIO (days inventory outstanding)** = inventory ÷ cost of goods sold × days. Only applies if the company holds stock.
- **Cash conversion cycle** = DIO + DSO − DPO.
- **AR ageing**: receivables grouped as current, 1–30, 31–60, 61–90 and 90+ days past due. Ageing shows what DSO hides, such as one large invoice that's badly overdue.

Worked example (made-up): a 91-day quarter, invoiced revenue of 900,000 and closing AR of 300,000. DSO = 300,000 ÷ 900,000 × 91 ≈ 30 days.

## Planning accuracy

- **Budget variance %** = (actual − budget) ÷ budget, by line and by cost centre. Say which sign means unfavourable. For costs, spending over budget is unfavourable.
- **Forecast accuracy %** = 1 − |actual − forecast| ÷ actual. Measure it against a forecast frozen at a fixed point, such as the one made at the previous month end. Also track **bias** = (forecast − actual) ÷ actual, keeping the sign. Accuracy tells you how far off you were. Bias tells you whether you're always off in the same direction.
- **Days to close** = working days from month end to sign-off. Count working days, not calendar days.

## Agent workforce

- **Agent cost per accepted task** = agent spend in the period (org_costs) ÷ tasks accepted in review in the period. Break it down by task class, because an average across very different kinds of work hides the outliers.

## Common pitfalls

- Mixing cash and accrual numbers in one ratio, for example cash collections against accrued revenue.
- Computing runway from gross burn in one report and from net burn in the next.
- Treating annual prepayments as recurring cash. This flatters burn in the month they arrive.
- Quoting a metric without its period and date. "DSO 30" means nothing; "DSO 30 days, Q3, closed books" does.
- Comparing yourself to an outside benchmark nobody has sourced. Compare against your own plan and your own trend.
