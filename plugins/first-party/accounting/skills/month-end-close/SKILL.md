---
name: month-end-close
description: Close the month: reconcile cash, chase overdue invoices, review spend by category against budget and write the close note. Use in the first three working days of a month.
---

1. Read cash and receivables (accounting_cash_summary) and the invoices (accounting_list_invoices): overdue first.
2. For each overdue invoice draft a reminder for its owner; a reminder to a customer is outbound and needs the owner keys.
3. Review spend (accounting_list_expenses) against the budget per category and explain every line more than 10% over.
4. Send the invoices drafted for the month only after the amounts are checked against the contract; sending is cosigned by the owner.
5. Write the close note: cash, runway, receivables aging, variances with their explanations, and what is still open.
