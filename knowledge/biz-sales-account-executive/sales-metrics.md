---json
{ "title": "Sales metrics", "summary": "Formulas and counting rules for bookings, win rate, forecast accuracy and close-plan coverage, with a worked example.", "tags": ["metrics", "bookings", "win-rate", "forecast-accuracy", "close-plan"], "updated": "2026-11-04" }
---

# Sales metrics

These are the numbers you are measured on. Use the company's definitions if RevOps has written them; these defaults show the usual choices and where to be explicit.

## Bookings

```
Bookings = Σ contract value of deals closed-won in the period
```

Say which value you use and keep it consistent:

- **ACV** (annual contract value): first-year or average annual value of recurring fees
- **TCV** (total contract value): full value over the contract term, including one-time fees
- **New ARR**: annual recurring revenue added

Exclude one-time services from ARR. Multi-year deals inflate TCV; report ACV or ARR alongside.

## Win rate

```
Win rate = deals won ÷ (deals won + deals lost)
```

- Count deals that **closed** (won or lost) in the period, from a stated stage onward (e.g. from Evaluation). Deals lost in early discovery make win rate look worse and mean something different.
- Include "no decision" as a loss unless the company tracks it separately; say which.
- Also report **value win rate**: `won amount ÷ (won amount + lost amount)`.

## Forecast accuracy

Compare what you called with what happened.

```
Forecast accuracy = 1 − |actual bookings − forecast| ÷ actual bookings
```

- Use the forecast submitted at a fixed point (for example, the first week of the period) so you can't improve accuracy by updating late.
- Track **commit conversion** too: `commit amount that closed ÷ commit amount called`.
- Note the direction: over-forecasting and under-forecasting have different fixes.

If actual bookings are zero, accuracy is undefined; report the absolute miss instead.

## Close-plan coverage

```
Close-plan coverage = late-stage deals with a current, buyer-confirmed close plan
                      ÷ all late-stage deals
```

- **Late-stage**: Proposal and Negotiation, or the company's equivalent.
- **Current**: updated within the agreed window (for example, the last two weeks).
- **Buyer-confirmed**: the buyer has seen and agreed the steps and dates.

Report it by count and by amount.

## Pipeline coverage (supporting)

```
Pipeline coverage = open pipeline amount closing this period ÷ remaining quota
```

There is no universal "right" multiple; it depends on your historical win rate. Divide remaining quota by your win rate to see how much pipeline you need.

## Worked example

In a quarter you closed 4 deals worth $240,000 ACV and lost 6 worth $360,000 (from Evaluation onward). In week one you forecast $300,000.

```
Bookings (ACV) = $240,000
Win rate = 4 ÷ (4 + 6) = 40%
Value win rate = 240 ÷ (240 + 360) = 40%
Forecast accuracy = 1 − |240 − 300| ÷ 240 = 75%  (over-forecast)
```

Of 5 late-stage deals, 3 had close plans confirmed by the buyer in the last two weeks:

```
Close-plan coverage = 3 ÷ 5 = 60%
```

## Rules

- State the period, the stage boundary, the value type and the source (CRM report name, pull date).
- Small numbers swing; show counts next to percentages.
- Don't compare your win rate to a colleague's without the same segment and stage boundary.
