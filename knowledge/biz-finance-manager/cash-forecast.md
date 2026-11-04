---json
{ "title": "13-week cash forecast", "summary": "How to build and roll a direct-method 13-week cash forecast, set collection assumptions, and read runway and the lowest cash week from it.", "tags": ["finance", "cash", "forecast", "runway", "liquidity"], "updated": "2026-11-04",
  "sources": [
    { "title": "Business case study: 13-week cash flow forecasting (direct method)", "url": "https://pystatsv1.readthedocs.io/en/latest/business_ch19_cash_flow_forecasting_direct_method_13_week.html", "publisher": "pystatsv1 workbook", "accessed": "2026-11-04", "note": "Structure of receipts and payments in a direct-method weekly forecast" },
    { "title": "13 week cash flow forecast", "url": "https://www.atlar.com/learn/what-is-the-13-week-cash-flow-forecast", "publisher": "Atlar", "accessed": "2026-11-04", "note": "Why the direct method suits a weekly short-horizon view" }
  ] }
---

# 13-week cash forecast

The 13-week forecast answers one question: **will we have enough cash every week for the next quarter, and if not, when do we find out?** It uses the **direct method**, meaning actual receipts and payments by week rather than profit adjusted back to cash. That's because timing is what matters on this horizon: payroll on the 25th and a large invoice paid on the 3rd are very different weeks.

## Structure

One column per week (week 1 = the current week), one row per cash line:

```
Opening cash (= last week's closing)
+ Receipts
    Customer collections        (from AR ageing and new billing)
    Other receipts              (refunds, interest, grants)
− Payments
    Payroll and payroll taxes   (from the payroll calendar)
    Vendors and payables        (by due date from AP)
    Rent, software, contracts   (by contract date)
    Agent spend                 (org_forecast projection)
    Taxes                       (filing calendar)
    Capital expenditure
= Operating cash flow
± Financing                     (loan draws/repayments, equity: only if signed)
= Closing cash
Minimum cash buffer (kpis.md)    → flag weeks below it
```

Keep financing on its own line so operating burn stays visible. Only include a financing inflow once it's signed. A term sheet isn't cash.

## Collection assumptions

Collections are where the forecast is usually wrong. Build them per customer for the largest invoices, and by ageing bucket for the rest:

- For the largest open invoices: expected pay date = due date + that customer's usual delay, worked out from their payment history in AR.
- For everything else: apply a collection rate per ageing bucket, based on what actually happened in your own history. Write the rates and their source in the forecast file.
- New billing: invoice date from the billing schedule + payment terms + typical delay.
- Disputed invoices: leave them out until they're resolved, and list them under the table.

If you don't have history yet, label the rates as estimates and replace them as weeks of actuals build up.

## The weekly roll

1. Replace last week's forecast column with actuals from the bank. Note the statement date.
2. Variance per line = actual − forecast. Write a one-line reason for any material miss.
3. Drop the finished week and add a new week 13.
4. Update the next 13 weeks from AR, AP, payroll, the tax calendar, committed spend and org_forecast.
5. Read off closing cash by week, the **lowest cash week** with its date, net burn and runway.
6. Keep the variance history. If one line misses in the same direction every week, the assumption is wrong. Change the assumption rather than explaining the miss again each week.

**Worked example (made-up figures).** Opening cash 400,000. Week 3 has payroll of 150,000 and a quarterly tax payment of 60,000, against forecast collections of 80,000. Closing cash in week 3 = 400,000 + 80,000 − 210,000 − 40,000 (vendors) = 230,000. If the buffer in kpis.md is 250,000, week 3 is flagged now, while there's still time to chase two overdue invoices or move a discretionary vendor payment.

## Levers, in weeks of runway

When you list actions, give each one's effect in cash and in weeks of runway:

| Lever | Cash effect | Weeks of runway | Who decides |
|---|---|---|---|
| Collect overdue invoices over 60 days | +x | +n | Finance (dunning drafts for human send) |
| Delay discretionary spend | +x | +n | Budget owner / chief |
| Renegotiate vendor terms | +x | +n | Human signs |
| Reduce agent spend in an envelope | +x | +n | Chief (envelope change) |

Every lever that contacts a customer or vendor, or changes a commitment, is a draft for a human.

## Common pitfalls

- Starting from the P&L and calling it a cash forecast. Accruals, deferred revenue and prepayments make the timing wrong.
- Assuming customers pay on their due date.
- Forgetting the lumpy items: annual software renewals, quarterly taxes, bonuses, insurance, deposits.
- Counting financing that hasn't been signed.
- Overwriting last week's forecast without keeping it, so you can never measure accuracy.
- Reporting runway without the lowest cash week. A dip below the buffer is the decision, not the average.
