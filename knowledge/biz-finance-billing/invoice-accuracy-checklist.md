---json
{ "title": "Invoice accuracy checklist", "summary": "Line-by-line invoice checks, proration methods with a worked example, and the error causes to log so invoices go out right first time.", "tags": ["invoicing", "checklist", "proration", "accuracy"], "updated": "2026-11-04" }
---

# Invoice accuracy checklist

An invoice is right when the customer can check it against their contract and find nothing to query. Run these checks before review, not after the customer replies.

## Per invoice

**Who**
- [ ] Legal entity name and address match the contract (not the brand name or the sales contact's company).
- [ ] Billing contact and email are current. Bounce-backs are an AR problem waiting to happen.
- [ ] Customer's PO number included if they require one. Many customers' payables teams reject invoices without it.

**What**
- [ ] Each line maps to a contract item: product or service, quantity, unit price.
- [ ] Price matches the contract, including any discount, uplift date or price-lock.
- [ ] Quantities match usage records or the seat count at the billing date.
- [ ] Service period stated and correct (e.g. "1–30 Nov").
- [ ] One-off charges (set-up, professional services) are in the contract or have a signed change order.

**How much**
- [ ] Currency matches the contract.
- [ ] Tax applied per the company's tax set-up for that customer's location and status. Rules vary by jurisdiction; ask when a customer or country is new.
- [ ] Totals add up; rounding is consistent.
- [ ] Compared with last period. Any move beyond the threshold in your playbook has a written reason.

**When**
- [ ] Invoice date and due date follow the contract's payment terms.
- [ ] Payment instructions are the company's current ones.

## Proration

Proration is the most common source of errors. Use the method the contract specifies; if it's silent, use the company's policy and keep it consistent.

**Daily proration**: amount = monthly price × days used ÷ days in that month.

**Worked example.** A customer on 10 seats at 30 per seat per month adds 4 seats on 21 November. November has 30 days; the new seats are used for 10 days (21–30 inclusive).
- Proration for November: 4 × 30 × 10 ÷ 30 = 40.
- December invoice: 14 × 30 = 420.
- Show the proration as its own line with the dates so the customer can follow it.

**Common proration mistakes:**
- Counting days exclusive instead of inclusive (or the reverse) without checking the policy.
- Prorating upgrades but forgetting to credit downgrades if the contract allows them.
- Prorating on annual contracts as if they were monthly.
- Charging the full new period and the proration, so the customer pays twice for overlapping days.

## Usage-based charges

- Pull usage from the system of record, not a dashboard estimate, and note the extract time.
- Check the usage period lines up with the billing period (time zones and cut-off hours matter).
- Apply tiers and included allowances in the order the contract defines.
- Keep the usage file with the run so the customer's query can be answered quickly.

## Run-level checks

- [ ] Every active contract with a billing date in the period has an invoice, or a recorded reason it doesn't (paused, terminated, prepaid).
- [ ] No terminated contracts are being billed.
- [ ] Total billed reconciles to expected billings from the contracts register.
- [ ] New customers and price changes are flagged for the monthly accuracy sample.

## Logging errors

When the accuracy check or a customer finds an error, log it with one cause:

| Cause | Typical fix |
|---|---|
| Wrong price | Update the billing system from the contract; check for other customers on the same plan |
| Missed or wrong proration | Fix the rule or the date the change was entered |
| Wrong quantity | Fix the usage or seat-count feed |
| Wrong tax | Check the customer's tax status and location data |
| Wrong contact or entity | Update the customer record from the contract |
| Billed after termination | Tighten the handoff when contracts end |

Two of the same cause in a month is a process problem. Propose a playbook change instead of fixing invoices one by one.
