---json
{ "title": "Contract metrics", "summary": "Definitions and formulas for turnaround (days with legal), deviations flagged and obligations captured, how to clock-stop fairly and how to report.", "tags": ["metrics", "kpis", "turnaround", "contracts"], "updated": "2026-11-04" }
---

# Contract metrics

Your metrics answer two questions the business cares about: how long does legal hold up a deal, and does legal catch what matters? Measure both; speed without catching issues is just fast signing.

## Turnaround (days with legal)

Measure only the time the contract is waiting on us, not time with the counterparty or the deal owner.

> **Days with legal** = sum of (date returned by legal − date received by legal) across every round of a request

- Use working days, and say so.
- The clock starts when the request is complete (contract, deal context, deal owner named). If information is missing, record the date you asked and the date you got it; that wait is "waiting on business", not legal time.
- Each round is clocked separately: their redline arrives (clock starts), we send ours back (clock stops).

**Report by request type**, because an NDA and a large customer agreement aren't comparable:

| Type | Requests | Median days with legal | Longest | Against service target |
|---|---|---|---|---|
| NDA (template) | | | | |
| Template agreement | | | | |
| Third-party paper review | | | | |

Use the **median** (and the longest) rather than the average; one stuck contract can distort an average.

**Supporting measures**
- **Rounds per contract**: many rounds suggest the playbook positions are far from the market or the first redline wasn't prioritised.
- **Elapsed time to signature**: total from request to signature, all parties. Useful context, but not only ours to fix.

## Deviations flagged

A deviation is any term in a draft or executed contract that differs from the playbook's preferred or fallback positions.

> **Deviations flagged** = deviations identified and recorded in the issues list, by topic, in the period

What makes this metric useful is what you do with it:
- **Deviation rate by topic** = contracts with a deviation on that topic ÷ contracts reviewed. If one topic deviates constantly (say auto-renewal notice), the playbook may need a new fallback; suggest it to the General Counsel.
- **Approved deviations** = deviations accepted with the right approval recorded. Every accepted deviation should have one.
- **Missed deviations** = deviations found later (at signature check, in a dispute, in an audit) that weren't flagged in review. The target is none; each one gets a short cause note.

Don't inflate the count by splitting one issue into several. One issue per playbook topic per contract.

## Obligations captured

> **Obligations captured %** = executed contracts in the period with obligations entered in the register within the target number of days ÷ executed contracts in the period

- Also count **missed dates**: obligations whose date passed without action (a renewal rolled over unintentionally, a report not sent). Each one is a finding with a cause.
- Spot-check: once a quarter, pick a few executed contracts at random and re-extract them. Compare with the register to see what's being missed.

## Reporting format

Monthly to the General Counsel:

| Metric | This month | Last month | Note |
|---|---|---|---|
| Median days with legal (by type) | | | |
| Requests over service target | | | causes |
| Deviations flagged / approved / missed | | | |
| Top deviating topics | | | playbook suggestion? |
| Obligations captured | | | |
| Missed dates | | | |

End with one improvement: a template change, a new fallback to propose, an intake field to add.

## Pitfalls

- Stopping the clock when you send a question to the deal owner, then forgetting to restart it when they answer.
- Counting a request as done when the first redline goes out. Each round counts.
- Reporting zero missed deviations because nobody looked. Run the spot-check.
