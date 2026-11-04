---json
{ "title": "Driver-based modelling", "summary": "How to structure a driver-based budget or forecast model: the driver tree, the assumptions-calculation-output layout, hygiene rules and the checks before review.", "tags": ["modelling", "budget", "drivers", "forecast"], "updated": "2026-11-04" }
---

# Driver-based modelling

A good model lets someone change one assumption and see the effect everywhere, without hunting for hard-coded numbers. Build it so a reviewer can audit any output back to its inputs in a minute.

## Build the driver tree first

Before opening a sheet, write the tree: each output line broken down into the few drivers that cause it. Stop when a driver is something a person can confirm or decide.

```
Revenue
├── New customers × average starting price
├── Existing customers × retention × (1 + expansion)
└── Services: billable days × day rate
People cost
└── Headcount by month × loaded cost (salary + employer taxes + benefits) × months employed
Software
└── Seats × price per seat (+ annual contracts on their renewal dates)
Agent spend
└── Expected tasks × cost per task by class
Marketing
└── Programme budgets from the marketing plan (fixed) + paid spend tied to lead targets
```

For each driver, name its source (the hiring plan, the price list, pipeline data, the cost tool) and its owner (the person who can tell you it's changed).

## The three-block layout

1. **Assumptions.** Every input in one place, one row each, with units, source, owner and date. Inputs are the only typed numbers in the model.
2. **Calculations.** Formulas only, referencing assumptions. Monthly columns.
3. **Outputs.** P&L by cost centre, cash flow, headcount, key metrics. Formulas only.

If you can't use a spreadsheet, keep the same structure in Markdown: an assumptions table, a calculation table with formulas written out, and an output table.

## Hygiene rules

- **No hard-coded numbers inside formulas.** "× 1.05" hides an assumption; make it a row.
- **One row, one formula.** The same formula across all months; exceptions get their own row with a label.
- **Units in labels.** "Price per seat (per month)", "Headcount (end of month)".
- **Signs consistent.** Decide whether costs are positive or negative and stick to it.
- **Timing explicit.** Hires start mid-month? Annual bills paid upfront? Model the month cash moves separately from the month cost is recognised.
- **Version and date.** The file name or header says which version and when it was last changed, and a change log lists what changed.

## Loaded cost

People cost is usually the biggest line. Loaded cost per head = salary + employer payroll taxes + benefits + other per-head costs (equipment, software seats). Employer taxes and benefit costs vary by country and change over time; take the rates from the Head of People or payroll, not from memory.

## Checks before review

- [ ] Totals equal the sum of cost centres; cost centres equal the sum of lines.
- [ ] Opening position matches the last closed month (balance, headcount, customers).
- [ ] Months already closed show actuals, not plan.
- [ ] Cash and P&L differ where they should (annual prepayments, payment terms, capital items).
- [ ] Every objective the plan claims to fund has a visible line or headcount behind it.
- [ ] Flip test: change the three biggest drivers by a round amount and check outputs move in the direction and size you'd expect.
- [ ] No input without a source.

## Sensitivity table

Show how the key outputs (revenue, burn, runway) move when each top assumption changes. Use the same step for each (for example, a low and a high value the owner considers plausible) so the reader can compare which assumption matters most. Rank by effect; the top few are the ones to track monthly.

## Pitfalls

- Starting from last year's actuals plus a percentage. It carries old mistakes forward and explains nothing.
- Too many drivers. If no one can confirm a driver, it's false precision.
- Building the model alone. Each owner should see and agree to their drivers before review.
- Forgetting that hiring takes time: a role approved for Q1 often starts later. Use the people team's realistic start dates.
