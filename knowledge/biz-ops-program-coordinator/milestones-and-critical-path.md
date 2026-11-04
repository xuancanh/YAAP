---json
{ "title": "Milestones and the critical path", "summary": "Write milestones as checkable states, find the critical path through cross-team dependencies, and track slips so the status shows what really threatens the end date.", "tags": ["milestones", "critical-path", "dependencies", "planning"], "updated": "2026-11-04" }
---

# Milestones and the critical path

The status report's RAG rule turns on the critical path: a late milestone on it makes the program red. So you need to know which milestones are on it, and that answer changes as work moves.

## Writing milestones

A milestone is a state you can check, not an activity.

| Weak (activity) | Strong (state) |
|---|---|
| Design review | Final screens approved by the product lead |
| Data migration | All customer records in the new system, row counts reconciled |
| Training | Every support agent has completed the new-tool course; quiz results logged |

For each milestone record: owner (one, by unit), target date, the "done when" test, and what it depends on. Agree the date with the owner; a date you set for someone else is a wish.

## Mapping dependencies

List, for each milestone, what must be true before it can start or finish. Mark each dependency's type:

- **Finish-to-start** (most common): B cannot start until A is done.
- **Start-to-start:** B can start once A has started (for example, writing docs once the build has begun).
- **External:** something outside the program (a vendor delivery, a legal sign-off).

A dependency on another unit is also a RAID dependency row with an owner and a needed-by date.

## Finding the critical path

The critical path is the longest chain of dependent work from now to the end. Any delay on it delays the end date; delays elsewhere only use up slack.

A simple way to find it without software:

1. Write each milestone with its remaining duration (an estimate from the owner) and its dependencies.
2. Starting from today, compute each milestone's **earliest finish** = the latest earliest finish of its dependencies + its own duration.
3. The program's end is the largest earliest finish.
4. Walk back from the end: the chain of dependencies whose earliest finish sets the next one's start is the critical path.
5. For milestones not on it, **slack** = how much later they could finish without moving the end date.

Recompute when an estimate changes by more than a few days, or when a dependency is added. The critical path can switch to a different chain, and the status should say so: "Critical path now runs through vendor onboarding."

## Tracking slips

Keep the original target date beside the current forecast:

| Milestone | Owner | Original date | Forecast | Slip | On critical path | Reason |
|---|---|---|---|---|---|---|

- A milestone is **at risk** when its forecast is inside the slack remaining, or when a dependency is unaccepted.
- It is **late** when the forecast is past its target date.
- A slip on a non-critical milestone that eats all its slack makes it critical; flag that change.

Never overwrite the original date. A plan whose dates are edited weekly with no history looks on time forever.

## Shortening a late path

When the critical path is late, the options are the classic ones; present them to the decision-maker with their costs:

- **Cut scope** on the path (move a deliverable to a later phase).
- **Add capacity** to a critical item (the owning unit decides whether it can).
- **Overlap work** that was sequential (start-to-start instead of finish-to-start), accepting rework risk.
- **Move the date.**

You lay out the options with their effects; the decision-maker named in the charter chooses.

## Pitfalls

- Milestones so large that one is always "in progress"; split until each has a clear done-when inside a few weeks.
- Durations collected from one optimistic person; ask the owner for a likely date and what could make it later.
- Ignoring external dependencies because they feel outside your control. They are often the critical path.
