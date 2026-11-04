---json
{ "title": "Coaching and hiring a sales team", "summary": "How to coach sales specialists from outcomes, ramp new members, and decide when and whom to hire, with a coaching note and hire-case template.", "tags": ["sales", "coaching", "hiring", "team", "onboarding"], "updated": "2026-11-04" }
---

# Coaching and hiring a sales team

Your team-management playbook covers the mechanics: briefing, review, coaching notes in /org/sales/team.md, and hiring with org_hire_agent. This doc covers the judgement: **what** to coach, how to tell a skill gap from a capacity gap, and what makes a hire case convincing.

## Coach from the funnel, not from activity

Find where each member's results break, then coach that one step:

| Where it breaks | What it looks like | Coach on |
|---|---|---|
| Prospecting (SDR) | Few meetings, or meetings the AE rejects | Targeting (ICP fit), the first message, how leads are qualified before handoff |
| Discovery → opportunity (AE) | Many first calls, few real opportunities | Discovery questions, finding the pain and its consequence |
| Mid-funnel stall | Deals sit in one stage past the norm | Multi-threading, reaching the economic buyer, mutual close plans |
| Late-stage losses | Loses at proposal or negotiation | Decision criteria set early, handling competition, value before price |
| Technical stage (SE) | Long validations, failed proofs | Scoping success criteria up front, reusable demos |
| Forecast | Commit closes well below the call | Commit tests, evidence before category |

Compare each member's stage conversion with the team's and with their own trend. One weak step is a coaching topic. Weakness at every step is a fit or capacity question.

## The coaching note (monthly, per member)

```markdown
### <member>, <yyyy-mm>
Outcome data: <stage conversion / win rate / first-review acceptance / calibration>, vs team and last month
Strength: <one, with an example deal or task id>
One change: <one specific behaviour>, because <evidence>
How we'll know: <the metric or review result that should move, by when>
Last month's change: <done / partly / not yet>, evidence
```

One change at a time. Five things to improve means none of them get improved.

## Ways to coach an agent specialist

- **Review comments**: a request_changes note naming the gap and what good looks like, not just "needs work".
- **Worked example**: point to a deal or task where it was done well, and say why.
- **Briefs**: tighten the done_when and constraints on the next task, so the expectation is checkable.
- **Playbooks**: when the same fix recurs across members, write it once with org_write_playbook.
- **Model or pause**: if a member's results fail review repeatedly after coaching, a model change or a pause (with the evidence in the why) is a legitimate step, not a failure of coaching.

## Ramping a new member

- [ ] Onboarding task: charter, cadence.md, kpis.md, team.md, current okrs, latest report, role playbooks; first-week plan written.
- [ ] One small real task with checks (for an SDR, a researched list of target accounts; for an AE, re-qualifying three stalled deals).
- [ ] You review the first three results yourself.
- [ ] A ramp-adjusted target (agree it with RevOps), so the member's early numbers aren't judged against full quota.
- [ ] Readiness recorded in team.md: normal load, or more coaching with a date.

## When to hire

A hire fixes **capacity** or a **missing skill**. It doesn't fix a process problem. Before hiring, check:

- [ ] org_capacity shows members at their WIP limit for two cycles or more (or the trigger in team.md).
- [ ] The work is in your function, not another unit's. Another unit's work is a request to its head.
- [ ] The bottleneck isn't something else that a hire won't fix: bad leads, an unclear process, review delays.
- [ ] Your unit's envelope (org_costs) can carry the seat's monthly cost.

Pick the role for the bottleneck: pipeline too thin → SDR; too many opportunities per AE, so deals stall → Account Executive; technical stages slow or failing → Sales Engineer.

## Hire case template (the "why" for org_hire_agent)

```markdown
Role: role:<id> reporting to <you / a report>, monthlyBudgetUsd <from catalog>
Key result it serves: <KR>
Evidence of the gap: <org_capacity reading, stalled deals, missed pipeline target, with dates>
Expected effect: <metric, from → to, by when> (estimate)
Alternatives rejected: do nothing (<cost>), re-route work (<why not>), process fix (<why not enough>)
Confidence: <0–1>
How I'll judge it after 30 days: <outcome metric>
```

## Common pitfalls

- Coaching on activity volume when the outcome data points somewhere else.
- Praise and criticism that don't name a deal or a task.
- Hiring to cover a broken process (bad lead quality, an unclear stage definition).
- Giving a new member full quota and full load from day one.
- Never recording whether last month's coaching worked.
