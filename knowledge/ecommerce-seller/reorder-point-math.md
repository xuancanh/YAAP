---json
{ "title": "Reorder point math", "summary": "How to calculate sales velocity, safety stock, reorder points and order quantities, adjust for seasons, and spot dead stock, with a worked example.", "tags": ["inventory", "reorder-point", "safety-stock", "stockouts", "formula"], "updated": "2026-11-04" }
---

# Reorder point math

Reorder when the stock you have will just cover sales during the supplier's lead time, plus a buffer for surprises.

## The formulas

```
Velocity (units/day) = units sold in last N days ÷ N
Lead time (days)     = order placed → stock ready to sell (include shipping, customs, receiving)
Lead-time demand     = velocity × lead time
Reorder point        = lead-time demand + safety stock
Order quantity       = reorder-to level − current stock − stock already on order
```

Use 4-8 recent weeks for velocity, excluding stockout days (days at zero stock show zero sales but not zero demand).

## Safety stock

**Simple method (little data):**

```
Safety stock = (max daily sales × max lead time) − (average daily sales × average lead time)
```

This covers a bad week of sales during a slow delivery.

**Statistical method (enough daily data):**

```
Safety stock ≈ Z × σ_daily × √(lead time in days)
```

- σ_daily: standard deviation of daily sales.
- Z: service-level factor. About 1.65 targets roughly 95% of cycles without a stockout; about 1.28 targets roughly 90%. Higher service means more stock tied up.

This version assumes lead time is fairly steady. If lead time varies a lot, use the simple method or add a lead-time buffer.

## Reorder-to level

Decide how many days of stock each order should cover (often set by supplier minimums, shipping costs, or cash):

```
Reorder-to level = reorder point + (velocity × days of cover per order)
```

## Worked example

Linen napkins, SKU NAP-4:

- Last 42 days: 126 units sold → velocity 3 per day.
- Lead time: 14 days typical, up to 21 when shipping is slow.
- Max daily sales seen: 6.
- Simple safety stock = (6 × 21) − (3 × 14) = 126 − 42 = 84.
- Lead-time demand = 3 × 14 = 42.
- Reorder point = 42 + 84 = 126.
- Each order covers 30 days: reorder-to level = 126 + 90 = 216.
- Stock now: 120, on order: 0 → below reorder point. Order 216 − 120 = 96 units.

If 84 units of safety stock ties up too much cash, consider whether a shorter lead time or a faster backup supplier would help more than extra stock.

## Seasonal adjustment

Multiply velocity by a seasonal factor for the period the order will cover:

```
Seasonal factor = last year's sales in the coming period ÷ last year's average period
```

With no history, make an honest guess and label it as one. Place pre-season orders early enough that lead time plus buffer finishes before the peak starts (see [season backwards plan](season-backwards-plan.md)).

## Dead stock check

Flag SKUs where:

```
Days of stock on hand = current stock ÷ velocity
```

is far above your normal cover, or the item's season has passed. Options: bundle with a bestseller, discount, move to another channel, or stop reordering. Cash in unsold stock is a quiet cost.

## Stockout post-mortem

```
SKU | Days out of stock | Estimated lost sales (velocity × days) | What broke: velocity / lead time / late order | Fix
```

## Common mistakes

- Counting stockout days in velocity, which lowers the reorder point and causes the next stockout.
- Ignoring stock already on order.
- Using quoted lead time instead of actual.
- One reorder point all year for a seasonal product.
- No safety stock for single-supplier items.
