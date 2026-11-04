---json
{ "title": "Route day-sheet template", "summary": "A day-sheet template per driver, a method for sequencing stops around time windows, and an exceptions log.", "tags": ["routing", "day sheet", "time windows", "exceptions", "template"], "updated": "2026-11-04" }
---

# Route day-sheet template

Each driver should start the day with one sheet that answers: where, in what order, by when, and what to do if it goes wrong.

## Day sheet template

```
Date:          Driver:          Vehicle:          Start: depot HH:MM
Planned driving time:          Planned finish:          Breaks planned at:

| # | Stop / customer | Address + access notes | Window | Planned arrival | Job (deliver/collect) | Items / ref | Contact | Done / time | Notes |

Load checklist: <items, in reverse stop order>
Paperwork: <delivery notes, proof of delivery method>
If stuck: call <dispatcher name, number>
```

## Sequencing stops

1. **Fixed windows first.** Place stops with narrow time windows on the timeline.
2. **Cluster by area.** Fill in other stops around the fixed ones, so the route doesn't zigzag.
3. **Direction of travel.** Many routes are best as a loop: out on one side, back on the other.
4. **Rush hours and restrictions.** Avoid city centres at peak times; check loading restrictions, low bridges, weight limits and low-emission zones for the vehicle.
5. **Buffer.** Add slack after the tightest windows, not just at the end of the day.
6. **Breaks.** Plan them at real stopping points within the applicable [driver-hours rules](driver-hours-rules.md).
7. **Check the totals:** driving time and working time fit the rules with margin.

Route-planning software helps with large stop counts. For a handful of stops a day, a map and these rules work well.

## Loading

Load in reverse stop order so the first drop is nearest the door. Secure loads properly; an unsecured load is both a safety risk and a common roadside offence.

## Exceptions log

Anything that didn't go to plan:

```
| Date | Driver | Stop | What happened | Time lost | Action taken | Follow-up needed |
```

Common exception types: customer not in, wrong address, refused, damaged goods, access blocked, vehicle problem, traffic delay.

Review the log weekly. Repeat exceptions point to a fix: an address note, a different window, a call-ahead step.

## Proof of delivery

Agree with each customer what counts: signature, photo, safe-place note. Record it the same way every time so disputes are easy to settle.

## Worked example

Five stops for one van. Stop 3 has a 09:00–10:00 window; stop 5 a 14:00–16:00 window; the rest are any time. Sequence: depot 07:45 → stop 1 (on the way) → stop 2 → stop 3 at 09:30 (buffer after) → stops 4 and 5 clustered in the afternoon area → break before stop 5 → depot. Exceptions: stop 4 customer not in; card left, redelivery booked for tomorrow's sheet.

## Common mistakes

- Sequencing by the order jobs came in.
- No buffer after the tight windows.
- Ignoring vehicle restrictions (height, weight, emissions zones).
- Exceptions handled by phone and never logged.
