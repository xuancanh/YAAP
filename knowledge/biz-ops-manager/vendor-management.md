---json
{ "title": "Vendor management", "summary": "How to keep the vendor register, watch renewal and notice dates, score vendors, and frame a renew, renegotiate, right-size, consolidate or exit recommendation for the chief.", "tags": ["vendors", "procurement", "spend", "renewals", "template"], "updated": "2026-11-04" }
---

# Vendor management

Vendor spend leaks in predictable ways: auto-renewals nobody noticed, seats nobody uses, two tools doing one job, and price rises accepted because the notice date passed. The register and the renewal calendar catch most of it. You recommend; the chief (or the CEO) commits.

## The register

/org/operations/vendors.md, kept by the Procurement Specialist. One row per contract.

```markdown
| Vendor | Purpose | Internal owner | Annual cost | Billing | Term start | Term end | Notice date | Auto-renew? | Paid seats / units | Used | Security review | Data held | Last updated |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| <name> | <job it does> | <member> | <from invoice/contract> | monthly / annual | | | <term end − notice period> | yes/no | | <source, date> | <date / due> | none / internal / customer | |
```

Every cost comes from an invoice, a contract or org_costs, never from memory. The **notice date** matters more than the term end: it's the last day you can exit or renegotiate without rolling over.

## Renewal calendar

Sort the register by notice date. Your vendor review playbook looks 90 days ahead and starts significant renewals about 60 days before; those are company defaults in cadence.md. For each upcoming notice date, the owner confirms: still needed, usage, satisfaction, and alternatives looked at. A notice date only days away with no decision goes to the chief at once (org_escalate), with the default (what happens if nobody acts) stated.

## Vendor scorecard

For significant vendors, once a quarter:

| Vendor | Spend vs budget | Seat utilisation | SLA met? | Incidents | Support quality | Owner's view | Overlap with | Security review current? |
|---|---|---|---|---|---|---|---|---|

- **Spend variance** = (actual − budget) ÷ budget.
- **Seat utilisation** = active seats ÷ paid seats. The usage floor that flags a vendor is set in cadence.md.
- **SLA met** from the vendor's own reports and your incident record, not the vendor's marketing page.

## The decision options

| Option | When | What the case needs |
|---|---|---|
| Renew as is | needed, used, fairly priced, performing | one line of evidence for each |
| Renegotiate | needed, but price, terms or SLA aren't right | target terms, your leverage (volume, term length, alternatives, timing), walk-away point |
| Right-size | needed, but over-provisioned | current vs needed seats or tier, the saving |
| Consolidate | two vendors do one job | which one stays, migration effort, the saving, who's affected |
| Exit | not needed, or a better alternative exists | switching cost, data export and deletion, migration plan, risk, the date by which notice must be given |

Leverage is real only if you'd act on it: an alternative you've actually evaluated, a willingness to move the date, a longer term you can commit to.

## Case template for the chief

```markdown
## Vendor decision: <vendor> — <option>

Notice date: <date> · Default if no decision: <auto-renews at <amount> | service ends>
Annual cost now: <amount, source> · Proposed: <amount> · Change: <amount>
Usage: <used>/<paid> (<source, date>) · Performance: <SLA, incidents>
Recommendation: <option> because <reason>
Alternatives: <renew as is / other vendor / do without>, each with cost and risk
Security: <review current / needed from IT & Security before renewal>
Confidence: <0–1>
```

## Checklist before recommending

- [ ] Cost and usage come from a source with a date.
- [ ] The notice date is confirmed from the contract.
- [ ] The internal owner gave their view.
- [ ] Security-relevant vendors have a current review from IT & Security, or the case says one is needed.
- [ ] Data held by the vendor is known, and exit says how it's returned or deleted.
- [ ] Alternatives include "do without".

## Common pitfalls

- **Missing the notice date.** The renewal happens by default. Track notice dates, not term ends.
- **Committing.** You never accept a quote, sign or tell a vendor yes. Any outward message to a vendor is a draft for a human.
- **Counting seats from the invoice.** Paid isn't used. Read usage from the source.
- **Ignoring switching cost.** A cheaper vendor can cost more to move to.
- **Owner-less vendors.** Every row needs an internal owner, or nobody notices when it stops being useful.
