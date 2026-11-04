---json
{ "title": "Weekly marketing report", "summary": "The fixed shape of the Friday marketing report: the RAG rule, funnel and spend tables, and a filled-in example, so trends are comparable week to week.", "tags": ["reporting", "weekly", "rag", "marketing"], "updated": "2026-11-04" }
---

# Weekly marketing report

The report goes to `/org/marketing/reports/<yyyy>-W<ww>.md` and keeps the same shape every week, so the chief can read trends across weeks without re-learning the layout. Length follows the operating profile (one screen by default). Change the shape only at a quarter boundary, and say so in the first report that uses the new one.

## Rules for the numbers

- Every figure comes from a source; say which in the table (`CRM`, `analytics`, `ad platform`, `self-reported`, `estimate`).
- Show counts, not only rates.
- "Trend" compares with the same metric over the last four weeks, not just last week, so one noisy week doesn't drive a verdict.
- If a source broke or a definition changed, say so on the row instead of hiding the gap.

## Template

```markdown
# Marketing report — <yyyy>-W<ww>
Status: GREEN | AMBER | RED — <one line why>
RAG rule: green = every KR on pace and CAC at or under target; amber = one KR behind pace or CAC over target by more than <tolerance from cadence.md>; red = pipeline sourced below plan with no credible recovery, or a KR at risk two weeks running.

## Funnel
| Metric | Target (week) | Actual | 4-week trend | Source |
|---|---|---|---|---|
| Sessions | | | | analytics |
| Leads | | | | CRM |
| MQLs | | | | CRM |
| SQLs (accepted by sales) | | | | CRM |
| Pipeline sourced (USD) | | | | CRM |

## Spend and CAC
| Channel | Spend | SQLs | Cost per SQL | Target | Source |
|---|---|---|---|---|---|
Blended CAC (month to date): <value> vs target <value>
Spend vs envelope: <spent> of <envelope> (<%>), forecast <value>

## Key results
| KR | Current | Target | Confidence | Note |
|---|---|---|---|---|

## Shipped this week
- <campaign or asset> — what it produced so far (counts)

## Next week
- <launches, campaigns going live, decisions due>

## Risks
- <risk> — owner, mitigation, date

## Asks
- <ask> — of whom, needed by <date>, what happens if not
```

## Filled-in example (made-up figures)

```markdown
# Marketing report — 2026-W44
Status: AMBER — SQLs behind pace (9 vs 12 planned); CAC on target.

## Funnel
| Metric | Target | Actual | 4-week trend | Source |
| SQLs (accepted by sales) | 12 | 9 | down from 11 avg | CRM |
| Pipeline sourced (USD) | 60,000 | 48,000 | flat | CRM |

## Risks
- Sales acceptance slowed: 14 MQLs waiting more than 5 days — owner: Head of Sales (handoff row filed); mitigation: joint review Tuesday.

## Asks
- Chief: decide by Wed whether the webinar moves to W46 (design capacity) — if not, W45 SQLs drop further.
```

## Common pitfalls

- Green with no stated rule, or a rule that changes week to week.
- Explaining a miss with a plausible story instead of evidence. "Unknown, investigating" is acceptable; a guess presented as cause is not.
- Asks without a deadline or without saying what happens if nobody answers.
- Dropping a metric from the table the week it looks bad.
