---json
{ "title": "Funnel and velocity", "summary": "Formulas for pipeline creation, stage conversion, cycle time and sales velocity, and the cohort method that keeps them honest.", "tags": ["pipeline", "funnel", "conversion", "velocity", "analytics"], "updated": "2026-11-04" }
---

# Funnel and velocity

Funnel analysis tells the company where revenue is made and lost. The main trap is mixing opportunities from different periods; use cohorts and fixed definitions.

## Core measures

**Pipeline created**

```
Pipeline created = Σ amount of opportunities created in the period
```

Report by segment, source and owner. Use the amount at creation for consistency; report current amount separately if useful.

**Stage conversion (cohort method)**

```
Conversion A→B = opportunities that reached stage B
                 ÷ opportunities that entered stage A
```

Take the opportunities that **entered stage A in a given period** and follow them until they reach B, close lost or age out of a fixed window. Don't divide "reached B this month" by "entered A this month"; those are different deals.

**Win rate**

```
Win rate = won ÷ (won + lost), for opportunities that closed in the period, from a stated stage onward
```

**Cycle time**

```
Cycle time = close date − created date, for won opportunities
```

Report the median, and per stage (`time in stage = exit date − entry date`) to find where deals stall.

**Average deal size**

```
Average deal size = won amount ÷ won deals
```

The median is often more representative; report both if a few large deals dominate.

## Sales velocity

```
Velocity (per day) = (open opportunities × win rate × average deal size) ÷ cycle time (days)
```

Velocity is a diagnostic, not a forecast. Its value is in seeing which of the four levers moved between periods. Use the same segment, stage boundary and window for all four inputs.

## Worked example

A segment has 50 qualified open opportunities, win rate 25%, average deal $20,000, median cycle 80 days.

```
Velocity = (50 × 0.25 × 20,000) ÷ 80 = $3,125 per day
```

If next quarter the cycle grows to 100 days with all else equal, velocity falls to $2,500/day — a prompt to look at time-in-stage.

## Stage history is required

Stage conversion and time in stage need stage history (entry and exit dates per stage). If the CRM only stores current stage, ask the CRM Administrator to enable field history or snapshots, and say in every report that conversion is approximate until then.

## Segmentation rules

- Segment by attributes fixed at creation (segment, source, region), not ones that change during the deal.
- Keep segments big enough to mean something; merge small ones or show counts.
- Report owner-level numbers carefully: small samples per owner swing a lot, and the purpose is coaching, not ranking.

## Weekly funnel review output

```
Period / segments / source and pull date
Pipeline created vs prior periods and vs target
Stage conversion (cohort) and change
Median time in stage and change
Win rate, deal size, cycle time
Velocity and which lever moved
Three observations, each with the evidence and confidence
```

## Pitfalls

- **Survivorship**: measuring cycle time only on won deals hides how long lost deals took. Report lost-deal cycle time too.
- **Stage skipping**: deals that jump stages make conversion look odd. Count a skipped stage as reached.
- **Re-opened deals**: decide once how to treat them and write it down.
- **Amount changes**: pipeline "created" that later doubles or halves distorts comparisons; stick to creation amount for trends.
- **Recency**: recent cohorts haven't finished converting. Mark incomplete cohorts clearly.
