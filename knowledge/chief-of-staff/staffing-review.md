---json
{ "title": "Staffing review", "summary": "How to review a hiring plan, a hire case and each member's performance against key results, the envelope and the agent cap, with templates for the case and the staffing report.", "tags": ["staffing", "hiring", "performance", "org-design", "template"], "updated": "2026-11-04" }
---

# Staffing review

You staff the heads and the Program Managers; the heads staff their own units. So most of your staffing work is review: does a head's design, hire or pause hold up? Your own hires are few and each needs a full case.

## The hire case

Every hire, yours or one sent to you, should carry these fields. An incomplete case goes back with the missing fields named (org_task_comment); you don't complete it from guesses.

```markdown
## Hire case: <role:id> for <unit>

Requested by: <head or chief> · Reports to: <member>
Key result served: <goal id and name> (chain: org_why)
Expected effect: <which number moves, roughly how, by when — labelled estimate>
Monthly cost: <from the role catalog> · Unit envelope: <allocated / used, org_costs, org_forecast>
Agent cap headroom: <from org_review_structure>
Load evidence: <org_capacity: WIP over limit for <n> cycles, or the missing skill>
Alternatives: do nothing / rebalance WIP / borrow via a PM allocation / a plugin or kit / <other>
Recommendation: <hire / don't / defer until trigger> · Confidence: <0–1>
```

## Checklist: reviewing a head's team design or hire

- [ ] Each seat traces to a key result (org_why). A seat that serves no key result is a question.
- [ ] The cost fits the unit's envelope and the company forecast.
- [ ] The cap has headroom.
- [ ] No other unit already has this seat; cross-functional work goes through PM allocations, not duplicate hires.
- [ ] The design matches the profile: a frugal company gets fewer, cheaper seats; a reliability-first one may justify review capacity.
- [ ] Deferred seats have a trigger that brings them in (for example a WIP limit hit two weeks running).
- [ ] The hire is inside the design you accepted. If not, the design changes first.
- [ ] Someone owns onboarding.

If it doesn't hold, send it back with the evidence. Never rewrite a head's design or hire their specialists for them.

## The member review

Monthly, every member, from outcomes only. Keep one table in /org/reports/<yyyy-mm>-staffing.md:

| Member | Role | Unit | Accepted tasks | First-review acceptance | Avg review rounds | Cost per accepted task vs role median | Calibration | Incidents | Head's note | Case |
|---|---|---|---|---|---|---|---|---|---|---|

Source each column: org_pulse, org_costs, org_calibration, org_incidents, and /org/<function>/team.md for the head's note. Where a column has no data, say so rather than leaving it blank.

Two useful ratios:

- **First-review acceptance** = tasks accepted at their first review ÷ tasks reviewed in the period.
- **Cost per accepted task** = member spend in the period ÷ tasks accepted in the period. Compare with the role's median, not across roles.

## Reading the table

| Pattern | Likely case | Path |
|---|---|---|
| New member not ready after two cycles | onboarding or brief quality | head coaches; then model change, charter change or pause |
| Below the role's bar two periods running | fit, model or brief | head re-briefs; model change after org_eval_role passes |
| Idle two periods | no demand | pause or redeploy; never keep for show |
| Overloaded | WIP | rebalance first, then a hire by the head within its envelope |
| Spend with no accepted work | stuck or looping | review timeline; pause with evidence |
| Tripped the loop breaker twice in a month | brief or capability | rebrief smaller, or a model change |

Changes go through their gates: model changes replay the golden set first (a regression is never proposed); charter changes are experiments; termination only after a pause showed the role isn't needed or can't be fixed; a unit lead's removal is the CEO's decision via reorg-proposal.

## Worked example (made up)

The Head of Marketing hires a second content writer. The design you accepted has one writer seat and a deferred second one triggered by "WIP over limit two weeks running". org_capacity shows the first writer over limit for three weeks; the cost fits the unit's envelope; the cap has headroom. The hire holds: note it in the brief as "Marketing: second writer hired per accepted design (trigger met)". Had the trigger not been met, it would go back to the head as a design change first.

## Common pitfalls

- **Hiring from the catalog, not the objectives.** Start with what the key results need.
- **One seat per task.** One seat per distinct competency the work needs now.
- **Judging on activity.** Run counts and messages aren't outcomes; accepted work is.
- **Punishing calibration.** Overconfident forecasting is coached, not penalised.
- **Forgetting onboarding.** A hire without an onboarding owner is half done.
