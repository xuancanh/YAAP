---json
{ "title": "Month-end close reference", "summary": "What each close block must produce, what a supported reconciliation looks like, and how to run the flux review, with a copyable close file template.", "tags": ["finance", "close", "reconciliation", "accruals", "checklist"], "updated": "2026-11-04" }
---

# Month-end close reference

The close playbook gives you the sequence. This doc covers the standard each step is judged against. A close is done when every balance on the balance sheet is supported, not when the checklist is ticked.

## What "supported" means for a reconciliation

A reconciliation is done when it has all of these:

- [ ] The ledger balance at period end, with the account and the date.
- [ ] An independent balance it's compared with: a bank or card statement, a sub-ledger (AR, AP, fixed assets), a payroll report, a contract schedule or a calculation.
- [ ] The difference broken into reconciling items. Each item has a date, an amount, a description and a plan (clears next period, needs a journal, under investigation).
- [ ] No unexplained remainder. "Rounding" is an explanation only for the amount that's actually rounding.
- [ ] A preparer and a different reviewer, each named and dated.
- [ ] A link to the evidence, kept in the close file.

Items older than the ageing limit in kpis.md (30 days by default) are listed as exceptions with an owner, whatever their size.

## What each close block produces

| Block | Output that proves it's done |
|---|---|
| Cut-off | Revenue and expenses in the right month; invoices and bills dated near month end checked against delivery or service dates |
| Bank and cards | Each account reconciled to its statement |
| AR and AP | Sub-ledger totals tie to the general ledger; ageing saved |
| Accruals | A list of costs incurred but not billed, each with its basis (contract, usage report, PO); last month's accruals reversed |
| Prepaids | A schedule with start, end and monthly release; closing balance ties |
| Deferred revenue | Roll-forward: opening + billed − recognised = closing, by contract |
| Payroll | Journal ties to the payroll report; liabilities (tax, benefits) reconciled |
| Fixed assets | Additions, disposals and depreciation; register ties to the ledger |
| Tax | Liabilities reconciled to returns or calculations |
| Intercompany | Balances agree on both sides and net to zero on consolidation |

## Flux review

Flux review compares this month with last month and with budget, line by line, so you notice what changed before someone else does.

1. Put every P&L line and major balance sheet account in one table: this month, last month, budget, change in amount and %.
2. Flag every line over the threshold. The default is both a % and a materiality amount, so small lines with big percentages don't drown out the real moves.
3. Each flagged line gets a one-line reason from its owner, plus the evidence (the invoice, the hire date, the contract).
4. Read the explanations together. Three lines explained as "timing" in the same direction is a pattern worth asking about.

Unexplained is not done. "Higher spend" isn't an explanation. "New monitoring vendor, contract signed in the month, 12-month term" is.

## Close file template

```markdown
# Close <yyyy-mm>

Target: WD<n> · Started: <date> · Signed off: <date or open> · Days to close: <n>

## Checklist
| Block | Owner | Due | Status | Support |
|---|---|---|---|---|
| Bank and cards | | WD2 | | <link> |
| AR / AP tie-out | | WD2 | | |
| Accruals and prepaids | | WD3 | | |
| Deferred revenue | | WD3 | | |
| Payroll | | WD3 | | |
| Fixed assets | | WD3 | | |
| Balance sheet recs | | WD4 | | |
| Flux review | Head of Finance | WD4 | | |
| Sign-off | Head of Finance | WD5 | | |

## Flux (lines over threshold)
| Line | This month | Last month | Budget | Δ | Reason | Evidence |
|---|---|---|---|---|---|---|

## Exceptions carried forward
| Account | Item | Amount | Age (days) | Owner | Plan | Reason for carrying |
|---|---|---|---|---|---|---|

## Lessons for the retro
-
```

## Common pitfalls

- Signing off with "small" unreconciled differences. They add up, and they hide errors that offset each other.
- The same agent preparing and reviewing a reconciliation. Segregation of duties applies to agents too.
- Forgetting to reverse last month's accruals, so the cost is counted twice.
- Booking a big manual journal on the last day with no support. This is the first thing an auditor samples.
- Letting the close slip quietly. If WD-targets are missed, note it in the close file the same day and say why.
- Treating "matches last month" as evidence. A balance that never moves still needs its support.
