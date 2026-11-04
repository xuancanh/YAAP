---json
{ "title": "Payables controls and fraud red flags", "summary": "Three-way matching, duplicate checks, coding rules and the payment-fraud red flags to stop on before a bill reaches a payment run.", "tags": ["payables", "controls", "fraud", "three-way-match", "payment-run"], "updated": "2026-11-04",
  "sources": [{ "title": "FBI IC3 public service announcement on business email compromise (PSA240911, 11 Sep 2024), accessed 2026-11-04", "url": "https://www.ic3.gov/PSA/2024/PSA240911" }] }
---

# Payables controls and fraud red flags

A bill earns its place in a payment run by passing four checks: real vendor, right amount, delivered, not paid before. Anything that fails one check waits; anything that smells of fraud stops and goes to the Head of Finance.

## The match

**Three-way match** (when there is a purchase order): the PO, the receipt (someone confirms delivery), and the invoice agree on vendor, item, quantity and price.

**Two-way match** (no PO, e.g. a subscription): the invoice agrees with the contract or the last approved invoice, and the budget owner confirms the service is in use.

Where they don't agree:

| Mismatch | Action |
|---|---|
| Price differs from PO or contract | Hold; ask the buyer or budget owner; don't pay the higher price by default |
| Quantity billed > quantity received | Hold the difference; pay what was received if policy allows |
| No receipt confirmation | Ask the requester; don't schedule |
| No PO when policy requires one | Route to the budget owner for approval after the fact, and log it |

## Duplicate checks

Duplicates are the most common payables error. Before coding, search for:

- the same vendor and invoice number;
- the same vendor and amount within a few weeks;
- the same amount and date from two vendor records (the vendor may exist twice);
- a statement or reminder being processed as if it were an invoice.

## Coding

Code by what was bought, not who bought it: account by nature (software, contractors, travel), cost centre by the team that owns the budget, period by when the service happens.

- Split bills that cover future periods to prepayments (see [accruals, prepaids and deferrals](accruals-prepaids-deferrals.md)).
- Split capital items to fixed assets per the capitalisation policy.
- Tax on bills (VAT, GST, sales tax, withholding) follows local rules that vary by country and change over time. Use the codes the company's tax set-up defines; ask when a vendor or country is new.

## Fraud red flags: stop and confirm

Business email compromise is a well-documented, large-scale fraud. The FBI's IC3 advises using a secondary channel to verify requests to change account information. Treat each of these as a stop:

- A request to change a vendor's bank details, however routine it looks.
- A new payee asked to be paid quickly, or before the usual approval.
- An email from a known vendor or executive with a slightly different address or reply-to.
- Urgency or secrecy: "pay today", "keep this between us", "the CEO asked".
- An invoice for a vendor nobody in the company recognises, or for services no one ordered.
- Bank account in a different country or name from the vendor's records.

**What you do:**
1. Don't schedule the bill and don't reply to the request in the same thread.
2. Raise it to the Head of Finance on the task with what you saw.
3. The confirmation happens through a contact already on file (a phone number from the vendor record or the contract), not one given in the message.
4. Record the outcome in the vendor file, confirmed or rejected, with the date and who confirmed.

## Building the payment run

For each bill: vendor, invoice number, amount, currency, due date, early-payment discount and its deadline, approval reference. Then:

- Totals by payment date, and the cash effect for the cash review.
- Bills past due, with the reason.
- Bills held, with the reason and who needs to act.
- Take an early-payment discount only when the Head of Finance's cash policy says to.

The run is a proposal. A human approves and releases it.

## Pitfalls

- Paying from a statement balance instead of matched invoices.
- Coding everything to "general expenses" to save time; it breaks variance analysis.
- Treating a vendor's polite email about new bank details as low risk because the vendor is familiar. Familiar is what fraud imitates.
