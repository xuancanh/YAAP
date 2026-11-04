---json
{ "title": "Experiment design checklist", "summary": "Everything an experiment design must pin down before launch: hypothesis, unit, metrics, guardrails, power, duration and the decision rule.", "tags": ["experiments", "ab testing", "design", "checklist"], "updated": "2026-11-04" }
---

# Experiment design checklist

An experiment is only as good as what was decided before it started. Use this checklist to write the design; anything left open becomes a temptation to choose after seeing the data.

## Hypothesis

- [ ] **Change:** exactly what differs between control and treatment.
- [ ] **Mechanism:** why it should work, in one sentence. "Showing the price on the plan page earlier reduces surprise at checkout, so more people who start checkout finish it."
- [ ] **Expected direction and rough size** of the effect, and where that estimate comes from (past experiments, analysis, judgement).
- [ ] **Decision it informs:** what we will do if it wins, loses or is inconclusive.

## Unit of randomisation

- [ ] Pick the unit that receives the experience consistently: user, account/workspace, session, or region.
- [ ] Randomise at the level where people interact. If users in one workspace see each other's work, randomise by workspace, or effects leak between groups.
- [ ] The unit of analysis matches the unit of randomisation. If you randomise by workspace and analyse by user, the standard errors are wrong.
- [ ] Assignment is sticky: the same unit always sees the same variant.

## Metrics

- [ ] **One primary metric** that decides the result. Defined in `/org/data/metrics.md`, measured per unit.
- [ ] It is sensitive (can move within the experiment window) and aligned with the goal (moving it is actually good).
- [ ] **Guardrail metrics** that must not get worse: revenue, error rates, latency, unsubscribe or cancellation, support contacts. State the worst acceptable change for each.
- [ ] **Secondary metrics** for understanding, clearly labelled as not deciding.
- [ ] The metric window: from exposure to measurement (for example, converts within 14 days of first exposure).

## Population and exposure

- [ ] Who is eligible, and who is excluded (internal, test, existing customers on a contract).
- [ ] Trigger: analyse only units who could see the difference (reached the changed page), to avoid diluting the effect, but count them identically in both groups.
- [ ] Split ratio (usually 50/50; uneven splits need more total sample).

## Power and duration

- [ ] Minimum detectable effect (MDE): the smallest effect worth acting on.
- [ ] Sample size per group and the resulting duration, from [sample size and power](sample-size-and-power.md).
- [ ] Duration covers whole weekly cycles, so weekday and weekend behaviour are both included.
- [ ] If the required duration is unreasonable, say so now. Options: larger MDE, a more sensitive metric, a wider population, or not running it.

## Analysis plan

- [ ] Statistical test and significance level, chosen in advance.
- [ ] Stopping rule: a fixed end date, or a sequential method designed for early looks. No stopping "when it looks significant".
- [ ] Planned segments (if any), limited and named in advance.
- [ ] Data checks to run before reading results: sample ratio, exposure logging, pre-period balance.

## Decision rule

Write it before launch:

| Outcome | Action |
|---|---|
| Primary improves, interval excludes zero, guardrails OK | Recommend keeping |
| Primary flat or interval includes zero | No evidence of effect; keep or drop on other grounds, say so |
| Any guardrail breached | Recommend not shipping, whatever the primary shows |
| Data check fails | Result invalid; fix and re-run |

## Risks and ethics

- [ ] Could the treatment harm users, money or trust? Add a kill switch and a guardrail alert.
- [ ] Pricing, personal data and communications experiments may carry legal and policy constraints that vary by jurisdiction; check with your manager and Legal before proposing.
- [ ] Will other experiments run on the same users at the same time? Note interactions.

## Design doc skeleton

```markdown
# Experiment: <name>
Hypothesis: … Mechanism: … Decision: …
Unit: …  Population: …  Split: …
Primary: … (window …)  Guardrails: … (limits)  Secondary: …
MDE: …  n per group: …  Duration: … (from … to …)
Test: …  α: …  Stopping rule: …
Pre-checks: SRM, logging, balance
Decision rule: (table)
Risks: …
```
