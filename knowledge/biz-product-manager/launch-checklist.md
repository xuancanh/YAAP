---json
{ "title": "Launch checklist", "summary": "Launch tiers, the go/no-go readiness checklist, and the 14-30 day outcome review with its iterate, scale or roll back decision.", "tags": ["launch", "release", "checklist", "rollout", "product"], "updated": "2026-11-04" }
---

# Launch checklist

A launch has two reviews: readiness before it (can this ship safely and be measured?) and outcome after it (did it do what the spec said?). Both are recorded in `/org/product/launches/<feature>.md`. Changing the live product, announcing and customer messaging all go through their owners; your job is the go/no-go and the evidence.

## Launch tiers

The tier sets how deep the checklist goes and how much marketing does. Agree it with the Head of Marketing in the spec. Default tiers (the company can change them in `/org/product/cadence.md`):

| Tier | Typical scope | Marketing | Checklist |
|---|---|---|---|
| Major | new product area, pricing-relevant, affects most users | full launch: positioning, campaign, enablement | every item below |
| Minor | meaningful improvement for a segment | release note, in-app message, sales note | must-haves plus docs and support |
| Quiet | fixes, small changes, experiments | release note or nothing | must-haves only |

## Readiness checklist

Must-haves (any missing one is a no-go: move the date or cut the scope, and say which):

- [ ] Success metric, baseline and target are in the spec.
- [ ] Instrumentation is live and tested: events visible in the source from a test account.
- [ ] Acceptance criteria accepted by the reviewer, including error and empty states.
- [ ] Rollout plan agreed with engineering: flag name, stages, who can roll back and how fast.
- [ ] Eligibility rule written (who gets it), so adoption can be computed later.

For minor and major:

- [ ] Help docs and support FAQ ready; support has seen the feature.
- [ ] Release note drafted and approved by its owner.
- [ ] Design reviewed for accessibility (ask the Head of Design if not already done).

For major only:

- [ ] Marketing launch readiness passed (the Head of Marketing's checklist).
- [ ] Sales and success enablement delivered.
- [ ] Pricing or packaging implications signed off by their owner.
- [ ] Post-launch on-call owner named for the first week.

Record the verdict:

```markdown
## Readiness — <date>
Tier: <major | minor | quiet> · Verdict: GO | NO-GO | GO with reduced scope
Missing / at risk: <item — owner — due>
Decision by: <name> · Recorded in /org/product/decisions.md#<entry>
```

## Outcome review (14–30 days after)

Pick the day by how fast the metric can move: activation can be read within two weeks; retention needs longer. Pull:

- adoption among eligible accounts (tried and repeated, with counts),
- the success metric against baseline and target,
- guardrail metrics,
- support tickets mentioning the feature,
- qualitative feedback from the User Researcher or support.

```markdown
## Outcome — <date> (<n> days after launch)
| Metric | Baseline | Target | Actual | Source |
|---|---|---|---|---|
Adoption: tried <n>/<eligible>, repeated <n>/<eligible>
Guardrails: <ok | breached: which>
What we learned: <evidence, not story>
Forecast vs observed: <your forecast> → <observed>
Decision: iterate | scale | roll back and retire — why
Next step: <task id or experiment>
```

**Iterate** when adoption is fine but the outcome lags, or vice versa, and you know what to change. **Scale** when the target is met and guardrails hold. **Roll back and retire** when the target is clearly missed and no iteration is worth its cost; removing a feature that doesn't earn its place is a valid outcome. When you can't tell the effect apart from noise or other changes, propose an experiment rather than guessing.

## Common pitfalls

- Launching with instrumentation "to follow". You can never get the baseline back.
- Reviewing outcomes too early for the metric to move, then calling it a failure.
- Counting adoption among all accounts during a partial rollout.
- Skipping the outcome review because the team has moved on. It's what makes the next forecast better.
