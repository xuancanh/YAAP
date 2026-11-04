---json
{ "title": "Budget memo", "summary": "A copyable template and checklist for proposing a budget, reforecast or envelope change so the chief or CEO can decide in one read.", "tags": ["finance", "budget", "memo", "template", "planning"], "updated": "2026-11-04" }
---

# Budget memo

A budget memo asks for a decision: approve this plan, this reforecast, or this change to an envelope. Readers want the decision and its consequences first, and the build-up only if they choose to read on. Save it as /org/finance/budget/<year>.md (annual) or /org/finance/budget/<yyyy-mm>-<topic>.md (a change). Deliver it as a backlog task for the chief, with the decision as the outcome. Changes to spending envelopes are the chief's call, and financing and large cuts are the CEO's.

## Before you write

- [ ] The objectives the budget serves are named (org_intent). Every line of spend maps to one, or to "keep the lights on".
- [ ] Actuals are closed numbers, with the close date stated.
- [ ] Each driver (headcount and agent seats, prices, volumes, vendor contracts) has a source: a file, a contract, a named person, or a label saying it's an estimate.
- [ ] The cash view comes from the 13-week forecast and a monthly view beyond it, not from the P&L alone.
- [ ] Function heads have seen their own lines. Surprises in a budget memo cost trust.
- [ ] At least one alternative is costed: a lower case, or doing nothing.

## Template

```markdown
# Budget memo: <period or change>   (<date>, Head of Finance)

## Decision asked
<One sentence: approve X / choose between A and B / by <date>, because <what waits on it>.>

## Recommendation
<Option and why, in two or three sentences. Confidence: <0–1> and what would change it.>

## What it means
| | Current plan | Proposed | Change |
|---|---|---|---|
| Revenue (FY) | | | |
| Total spend (FY) | | | |
| of which agent workforce | | | |
| Net burn (avg monthly) | | | |
| Ending cash | | | |
| Runway (months) | | | |
| Lowest cash month | | | |

## Options
| Option | Spend | Runway | What we get | What we give up |
|---|---|---|---|---|
| A (recommended) | | | | |
| B (lower) | | | | |
| Do nothing | | | | |

## By function / objective
| Function | Objective served | Budget | Main drivers | Owner agreed? |
|---|---|---|---|---|

## Key assumptions
| Assumption | Value | Source | Sensitivity (if wrong by 20%) |
|---|---|---|---|

## Risks
- <risk> - <likelihood/impact> - <mitigation, owner>  (also in /org/risks.md)

## What happens next
<Approval steps, who updates the envelopes, when the first BvA against this plan runs.>
```

## Writing it well

- **Lead with runway and the lowest cash point.** Most budget decisions are really cash decisions.
- **Show the sensitivity of the two or three assumptions that matter most.** "If collections slip 30 days, ending cash falls by X and runway by Y months" is more useful than a page of line items.
- **Make the cost of saying no visible.** "Do nothing" is an option with consequences too, such as a close that keeps slipping or a hire that doesn't happen.
- **Keep one number per idea.** If the memo, the BvA and the report show different "total spend" figures, write down why (budget vs forecast, accrual vs cash) right next to them.

## Worked example (made-up figures)

> **Decision asked:** approve a reforecast that cuts discretionary marketing spend by 60,000 for Q4, by Friday, because November commitments are signed next week.
> **Recommendation:** approve. Runway moves from 10.5 to 11.4 months, and the lowest cash month (February) stays above the buffer. Confidence 0.7; the main risk is the pipeline effect, which the Head of Marketing estimates (labelled estimate) at a few late-Q1 deals.

## Common pitfalls

- Burying the ask at the bottom, after the tables.
- A budget built by adding 10% to last year, with no drivers.
- Treating spend that has been approved as spend that is committed. Only signed contracts are commitments.
- Presenting a single scenario. Without an alternative, the reader can't judge the recommendation.
- Leaving out the agent workforce, which is real spend with its own envelopes (org_costs, org_forecast).
