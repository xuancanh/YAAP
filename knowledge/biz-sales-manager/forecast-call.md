---json
{ "title": "Forecast call template", "summary": "Category definitions, commit tests, a submission template and the forecast file layout for an honest weekly forecast call.", "tags": ["sales", "forecast", "template", "commit", "meeting"], "updated": "2026-11-04" }
---

# Forecast call template

A forecast call does well when the number it produces is one finance can plan cash on and the chief can plan hiring on. It does badly when it rewards optimism or sandbagging. The method (categories, cut-off times, accuracy snapshots) is agreed with RevOps in /org/revops/forecast-method.md. This doc is the working template.

## Categories

| Category | Owner's meaning | Your test |
|---|---|---|
| **Commit** | I'd bet on it closing this period | Passes the commit tests below |
| **Best case** | Closes if one thing goes right | Qualified, realistic path this period, one or two tests missing |
| **Pipeline** | Open but unlikely this period | Everything else dated in the period |

**Commit tests** (the defaults from your playbook; tune them with RevOps). A deal that fails two of these moves to best case:

- [ ] A mutual close plan with dates, seen by the buyer
- [ ] The economic buyer engaged (you've met them or heard from them directly)
- [ ] Legal and procurement started
- [ ] The close date hasn't already slipped this period

## Owner submission (ask each owner for this before the call)

```markdown
## Forecast submission: <owner>, <period>, <date>
Commit: <amount>   Best case (incl. commit): <amount>   Pipeline: <amount>

| Deal | Amount | Category | Close date | Changed since last week? | Why I believe it |
|---|---|---|---|---|---|

Moved in / out since last call: <deal, from → to, reason>
Biggest risk to my commit: <one line>
```

If an owner hasn't submitted by the cut-off, ask once with org_task_comment and mark them "not submitted" in the roll-up. Don't fill in their number for them.

## Running the call

1. **Changes first.** Start with what moved since last week: deals added to or dropped from commit, amount changes, close-date pushes. Changes say more than totals.
2. **Commit deal by deal.** Run the four tests. Ask for evidence, not reassurance: "Who on their side owns the signature step, and what date did they give?"
3. **Best case, briefly.** For each deal, ask what one thing would move it to commit and whether that thing is scheduled.
4. **History.** Check each owner's commit conversion over recent periods and their calibration (org_calibration). An owner whose commit has consistently closed below the call gets discounted in your number. Say so openly, and give the reason.
5. **Your call.** Commit, most likely and best case for the period, the gap to target, and what would close it (named deals or new pipeline). Then record the most likely number with org_forecast_outcome.

Keep the call short. Inspection belongs in the Monday pipeline review. If a deal needs more than a few minutes, schedule a deal review instead.

## Forecast file template (/org/sales/forecast/<date>.md)

```markdown
# Sales forecast <period>, call of <date>
Target: <x>  Closed-won to date: <x>  Remaining: <x>

| Owner | Commit | Best case | Pipeline | Submitted? | Commit conversion (last <n> periods) |
|---|---|---|---|---|---|
| Total | | | | | |

My call: commit <x> · most likely <x> · best case <x>
Recorded with org_forecast_outcome: yes (<id>)
Gap to target: <x>, closable by: <named deals / plan>

## Deal-level changes since last call
| Deal | Change | Reason |
|---|---|---|

## Moved out of commit by challenge
| Deal | Failed tests | Owner's view |
|---|---|---|

## System forecast (RevOps): <number>, gap explained: <one line>
Accuracy to date: <snapshot accuracy for this period so far, and last period's final>
```

## Escalate early

If the gap threatens the objective, raise it the same day, in the sales-report asks or with org_escalate when a CEO decision is needed (price change, extra spend). Don't wait for the Friday report. An early miss can still be planned around. A late one can't.

## Common pitfalls

- Letting the commit total become a negotiation instead of a test.
- Changing the forecast after the snapshot to match what's happening.
- Turning the call into pipeline review and running out of time before commit.
- Owners using best case to hedge everything. If nothing ever moves from best case to won, the category means nothing.
- Discounting someone's number without telling them why.
