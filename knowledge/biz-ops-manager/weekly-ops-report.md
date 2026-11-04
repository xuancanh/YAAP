---json
{ "title": "Weekly ops report", "summary": "A copyable template for the weekly operations report to the chief of staff, with the RAG rule written at the top and a short worked example.", "tags": ["reporting", "template", "rag", "weekly"], "updated": "2026-11-04" }
---

# Weekly ops report

The chief reads every head's report in the same pass and copies your numbers into the company scorecard with your report as the source. So: same shape every week, the rule behind your status written down, every number sourced, and asks phrased so the chief can act on them.

Save as /org/operations/reports/<yyyy>-W<ww>.md (ISO week). Length follows the profile: one screen by default, shorter for a terse culture.

## Template

```markdown
# Operations — <yyyy>-W<ww>

Status: GREEN | AMBER | RED — <one sentence why>
Rule: green when every key result is on pace and no SLA breach repeated; amber when one key result is behind pace or an SLA missed twice; red when a key result is at risk two weeks running, a critical process failed, or spend is projected over budget. (Company default; see /org/operations/cadence.md.)

## KPIs
| KPI | Target | This week | Last week | Trend (6 wk) | Source |
|---|---|---|---|---|---|
| Median cycle time — <process> | | | | | org_metric_read <id>, <date> |
| SLA attainment — <process> | | | | | |
| Cost per unit — <process> | | | | | |
| SOP coverage | | | | | /org/operations/processes.md |
| Automation rate | | | | | |
| Vendor spend vs budget | | | | | /org/operations/vendors.md, org_costs |

## Key results
| Key result | Current | Target | Confidence (0–1) | Change since last week |
|---|---|---|---|---|

## Programs and projects
- <project> — <on_track | at_risk | off_track>: <reason>; ask: <if any>

## Highlights
- <what moved and why, with a link>

## SLA breaches and process failures
- <process>: <n> breaches, cause: <one line or "unknown — investigating (owner)">; one-off / pattern

## Risks
| Risk | Owner | Likelihood × impact | Mitigation | Review |
|---|---|---|---|---|

## Asks
| Ask | Of | By | Why (key result) | Task |
|---|---|---|---|---|

## Team and spend
Seats filled / deferred / refused: <…> · Unit spend vs envelope: <amount / amount, org_costs>
```

## Rules for filling it in

- **The status follows the rule.** If you think the status should differ from what the rule gives, report the rule's answer and say why you disagree. Don't quietly override it.
- **Every number has a source and a date.** A number you counted by hand or that a specialist reported without a source is "estimate (<who>)".
- **Causes are known or unknown.** "Unknown — investigating, <owner>, by <date>" is a good line; a plausible guess isn't.
- **Missing data is reported as missing,** not left blank or carried over from last week.
- **Asks are specific.** Who, what, by when, and which key result it serves. Each ask that needs the chief also becomes a backlog task; a CEO-only decision is an org_escalate on its task.
- **Trends need the same definition.** If a KPI definition changed, note the break.

## Worked example (made up)

```markdown
# Operations — 2026-W45

Status: AMBER — order-to-ship SLA missed twice this week; other key results on pace.
Rule: (as above)

## KPIs
| KPI | Target | This week | Last week | Trend (6 wk) | Source |
|---|---|---|---|---|---|
| Median cycle time — order-to-ship | 48 h | 51 h | 46 h | flat, then up | org_metric_read ops.order_to_ship, Fri 14:00 |
| SLA attainment — order-to-ship | 95% | 91% | 96% | down this week | same |
| SOP coverage | 80% | 75% | 70% | rising | /org/operations/processes.md |

## SLA breaches and process failures
- Order-to-ship: 2 breaches on Tuesday, cause: carrier pickup missed (carrier's notice, linked); one-off unless it repeats next week.

## Asks
| Ask | Of | By | Why | Task |
|---|---|---|---|---|
| Decide on the carrier renewal (notice date 2026-11-20) | Chief of Staff | 2026-11-14 | SLA attainment KR | [task:…] |
```

## Common pitfalls

- **Status by mood.** Without the rule, green drifts into "nothing on fire".
- **Watermelon reporting.** Every KPI green while the key result falls behind. Report both and say they disagree.
- **Rewriting the shape.** A new layout every week hides trends.
- **Burying the ask.** If the chief has to search for what you need, you won't get it.
