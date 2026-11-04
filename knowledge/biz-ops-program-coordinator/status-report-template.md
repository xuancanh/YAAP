---json
{ "title": "Status report template", "summary": "A weekly program status template with the RAG rule applied, a worked example, and a checklist for status that says plainly what is late and who owns the fix.", "tags": ["status", "rag", "template", "reporting"], "updated": "2026-11-04" }
---

# Status report template

The reader of a status wants three answers in the first two lines: is it on track, what is wrong, and what do they need to do. Everything else is reference.

## The RAG rule (state it, then apply it)

- **Red:** a milestone on the critical path is late, or a high-impact issue has no owner.
- **Amber:** any milestone is at risk.
- **Green:** otherwise.

Apply the rule mechanically. If you think the rule gives the wrong answer, keep the rule's colour and explain in the why line. Changing colours by feel is how status loses trust.

## Template

```markdown
# <Program> — status <date>
**<RAG>** — <one line: the main reason>.
**Decisions needed:** <decision> — <who> by <date>. (or "none")

## Milestones
| # | Milestone | Owner | Target | Forecast | State |
|---|---|---|---|---|---|

## Done this week
- <outcome, not activity>

## Next week
- <what will be true by next Thursday>

## Top RAID items
1. <ID> <one line> — owner, next step, date
2.
3.

## Changes since last status
<scope, dates or owners that changed, and who approved>
```

## Worked example

```markdown
# Support tool rollout — status 4 Dec
**Amber** — M3 (agents trained) at risk: training environment rejects logins.
**Decisions needed:** none this week.

## Milestones
| # | Milestone | Owner | Target | Forecast | State |
| M1 | Tool configured with our queues | Support lead | 20 Nov | 20 Nov | Done |
| M2 | Historical tickets imported and reconciled | Data analyst | 2 Dec | 3 Dec | Done (1 day late) |
| M3 | All agents trained | Support lead | 11 Dec | 13 Dec | At risk |
| M4 | Old tool switched off | IT admin | 18 Dec | 18 Dec | On track |

## Done this week
- All historical tickets imported; counts reconciled against the old tool.

## Next week
- Training environment fixed; first two training sessions held.

## Top RAID items
1. I2 Training logins failing — IT admin, fix by 5 Dec.
2. R4 Holiday cover may thin out training attendance — Support lead, schedule by 6 Dec.
3. D3 Finance to confirm old-tool cancellation date — Finance, by 10 Dec.

## Changes since last status
M2 forecast moved 2 → 3 Dec (data check took an extra day); approved by sponsor.
```

Note what makes it work: the colour follows the rule (M3 at risk but not on a late critical path), the reason is specific, every RAID item has an owner and a date, and the slip is recorded rather than hidden.

## Writing tips

- **Outcomes, not activity.** "Held three meetings about import" is activity. "Import reconciled" is an outcome.
- **Name the gap, not the blame.** "Logins failing since Tuesday" rather than "IT hasn't fixed logins".
- **Decisions need a decider and a deadline**, or they are not decisions needed, just topics.
- **Keep it stable.** Same sections in the same order every week, so readers can scan.
- **The one-line summary** you post with org_message is the RAG and the why line, verbatim.

## Checklist before posting

- [ ] Colour follows the stated rule.
- [ ] Every milestone has a forecast read from the board this week, not copied from last week.
- [ ] Every late or at-risk milestone has a reason.
- [ ] Every top RAID item has an owner and a date.
- [ ] Decisions needed are also comments on your task for the Head of Operations.
- [ ] Changes since last status are listed, with approver.
