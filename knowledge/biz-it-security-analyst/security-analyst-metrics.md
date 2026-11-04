---json
{ "title": "Security analyst metrics", "summary": "Definitions and formulas for remediation within SLA, alert false-positive rate and phishing failure rate, with counting rules and pitfalls.", "tags": ["metrics", "kpi", "vulnerability management", "alerts", "phishing"], "updated": "2026-11-04" }
---

# Security analyst metrics

Security numbers are easy to make look good by changing what is counted. Fix the counting rules in `/org/it-security/kpis.md` and report the context next to each number.

## Remediation within SLA

Each finding (or grouped fix) gets a priority and a due date from the SLA table (see [vulnerability prioritisation](vulnerability-prioritisation.md)).

```
remediation within SLA = items closed on or before their due date
                         / items due in the period
```

"Items due in the period" includes items still open past their due date. This stops an open, overdue item from vanishing from the denominator.

Rules:

- **Closed** means verified fixed by a rescan or equivalent evidence, not "the owner says it's done".
- **Risk-accepted** items are reported as a separate count, never as closed.
- Count at the same level you assign work (grouped fix, or finding per asset), and say which.
- Report by priority. Overdue P1s matter far more than overdue P4s.

Companion numbers:

```
overdue items       = open items past due date (by priority, with ages)
median time to fix  = median(closed date − discovered date), per priority
```

## Alert false-positive rate

From the triage log:

```
false-positive rate (per rule) = alerts triaged as false positive
                                 / alerts triaged, for that rule
```

Definitions:

- **False positive:** the rule fired but the activity did not match what the rule is meant to detect (a known service IP flagged as unusual).
- **Benign true positive:** the rule worked correctly and the activity was real but expected (an admin doing a planned change). Track separately; it points to missing context, not a bad rule.
- **True positive:** suspicious activity, escalated.

Report per rule as well as overall. An overall rate hides the few noisy rules that consume most time. The rules with the highest volume of false positives are the first tuning candidates.

Pitfall: tuning a rule to zero false positives often makes it miss real attacks. Every tuning change should state what it excludes and why that exclusion is safe.

## Phishing failure rate

Define it once and keep it. Most often:

```
phishing failure rate = recipients who submitted credentials (or, if the
                        company chooses, clicked) / recipients delivered
```

Always report alongside:

```
report rate = recipients who reported / recipients delivered
```

Rules:

- Count unique recipients, not events.
- Exclude recipients whose message bounced or was blocked before delivery.
- Compare only with campaigns of similar difficulty, and record difficulty each time.
- Small populations make rates noisy; show counts.

Details on running campaigns are in the [phishing simulation guide](phishing-simulation-guide.md).

## Reporting format

```markdown
| Metric | This period | Last period | Target | Note |
| Remediation within SLA (P1/P2/all) | 2/2, 80%, 85% | … | <kpis.md> | 3 P2 overdue (listed) |
| Risk-accepted items | 4 | 3 | | 1 new, expires <date> |
| False-positive rate (overall) | 35% | 50% | | Tuned "new country sign-in" |
| Top FP rule | <name> 70% | | | Tuning proposed |
| Phishing failure rate (submit) | 6% | 9% | | Similar difficulty |
| Phishing report rate | 41% | 30% | | |
```

Leave targets blank where none is agreed; don't invent industry benchmarks.
