---json
{ "title": "Decomposing a metric change", "summary": "A method for explaining why a metric moved: rule out data issues, split into components, separate mix from rate effects, with a worked example.", "tags": ["metric explainer", "decomposition", "mix effect", "root cause"], "updated": "2026-11-04" }
---

# Decomposing a metric change

When a key metric moves, people want to know why, fast. The method: rule out measurement problems, break the metric into parts, and find which parts moved.

## Step 1: Is it real?

Before explaining a change, check it is not an artefact. In order:

1. **Data freshness and tests.** Is the latest data complete? Any failing tests on the source tables?
2. **Tracking or definition changes.** A release that changed an event, a new filter in the metric definition, a migration.
3. **Calendar effects.** Day-of-week mix, holidays, month length, a partial period.
4. **Size of the move.** Compare with normal variation: how much does this metric usually move week to week? A move inside the usual range may need no explanation.

If any of these explains it, stop and say so.

## Step 2: Break the metric into parts

Write the metric as a formula of components, then see which component moved.

- **Revenue** = customers × average revenue per customer
- **Signups** = visitors × signup rate
- **Conversion rate** = sum over segments of (segment share × segment rate)
- **Active users** = retained users + new users + reactivated users

Compute each component for both periods. Usually one or two components account for most of the change.

## Step 3: Cut by dimension

Split the change by the dimensions that plausibly matter: channel, country, plan, device, new versus existing, product area. Rank segments by their contribution to the total change, not by their own percentage change. A small segment that doubled may matter less than a large one that dipped slightly.

```
segment contribution = segment value (this period) − segment value (last period)
share of change      = segment contribution / total change
```

## Step 4: Separate mix from rate

A blended rate can move because the segments' rates changed, or because the mix of segments shifted, even if every rate stayed the same.

For two periods (0 and 1), segment share `s` and rate `r`:

```
total change = Σ s1·r1 − Σ s0·r0
rate effect  = Σ s0 · (r1 − r0)       (rates change, mix held)
mix effect   = Σ (s1 − s0) · r0       (mix changes, rates held)
interaction  = Σ (s1 − s0) · (r1 − r0)
```

The three add up to the total change.

### Worked example

Signup conversion fell from 5.0% to 4.4%.

| Channel | Share P0 | Rate P0 | Share P1 | Rate P1 |
|---|---|---|---|---|
| Search | 0.60 | 6.0% | 0.40 | 6.0% |
| Social | 0.40 | 3.5% | 0.60 | 3.3% |

- Blended P0 = 0.6×6.0 + 0.4×3.5 = 5.0%. P1 = 0.4×6.0 + 0.6×3.3 = 4.38%.
- Rate effect = 0.6×0 + 0.4×(−0.2) = −0.08 points.
- Mix effect = (−0.2)×6.0 + (0.2)×3.5 = −0.50 points.
- Interaction = (−0.2)×0 + 0.2×(−0.2) = −0.04 points.
- Total = −0.62 points. ✔

Explanation: almost all of the drop is mix. More traffic came from social, which converts lower. Social's own rate barely moved. The decision question becomes "is the extra social traffic worth having?", not "what broke in signup?".

## Step 5: Write it up

```markdown
## <Metric> moved from X to Y (<period vs period>)
Real? <yes / partly artefact: reason>
Main driver: <component or segment, with its share of the change>
Secondary: <...>
Not the cause: <things checked and ruled out>
What it means: <one sentence for the decision>
Query: <saved path>
```

## Pitfalls

- Stopping at the first segment that moved. Check the share of change it explains.
- Explaining noise. If the move is within normal variation, say so plainly.
- Claiming cause from timing alone ("the release went out Tuesday"). Say "coincides with" unless there is stronger evidence.
