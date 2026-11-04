---json
{ "title": "Roadmap comms by audience", "summary": "Tailor the roadmap for leadership, sales and support, and customers: what each needs, what to leave out, commitment language, and a sales talk-track template.", "tags": ["roadmap", "communication", "enablement", "stakeholders"], "updated": "2026-11-04" }
---

# Roadmap comms by audience

One roadmap, several versions. Each audience needs a different level of detail and a different level of certainty. The most common failure is giving customers or sales the internal version, which turns plans into promises.

## The audience matrix

| | Leadership | Sales and support | Customers |
|---|---|---|---|
| **Needs** | Outcomes, bets, trade-offs, what we chose not to do | What is coming, roughly when, what not to promise, how to talk about it | Direction and themes; reassurance their problem is understood |
| **Detail** | Bets with key results and appetites | Features and status | Themes and problems |
| **Timing** | Quarters, with confidence | Now / next / later; dates only if committed | Now / next / later; no dates unless committed |
| **Leave out** | Task-level detail | Internal debates, unconfirmed scope | Internal names, dates not committed, competitor references |

## Commitment language

Use the same words every time so readers learn what they mean:

- **Committed:** in the current cycle with a date the Head of Product has approved. The only status that may carry a date outside the product team.
- **Planned (next):** we intend to do this next; scope and timing may change.
- **Exploring (later):** we are researching the problem; no decision to build.
- **Not planned:** we decided not to do this now. Say so plainly; it saves sales from guessing.

Never upgrade a status in translation. If the roadmap says exploring, the customer version says exploring.

## Leadership version

```markdown
## Roadmap update — <date>
Changes since last version: <added / moved / dropped, with the reason>
| Bet | Key result | Status | Confidence | Trade-off |
Decisions we made: <what we chose not to do and why>
Risks: <top two>
```

Lead with changes; leadership already knows the rest.

## Sales and support version

```markdown
## What's coming — <date>
### Now (committed)
- <feature> — <who it's for> — <date if committed>
### Next (planned)
- <feature> — <problem it solves>
### Later (exploring)
- <problem area>
### Not planned
- <request> — what to say instead
### What changed since last time
```

Add a **talk track** for each item likely to come up:

```
Customer asks about: <topic>
Say: "<what we can say, in plain words>"
Don't say: <the promise to avoid>
If they push for a date: "<agreed line>" and log it as feedback with the account.
Owner for questions: <role>
```

Support also needs: which existing tickets or known issues each item will close, so they can follow up when it ships.

## Customer version

Themes, not features, unless committed. For example:

> **Now:** making monthly reporting faster for finance teams.
> **Next:** easier ways to bring in data from the tools you already use.
> **Later:** exploring approval workflows for larger teams.

Every customer-facing version goes through the company's approval before it is shared.

## Changes since last version

Every version lists what moved and why, briefly. Readers who see an item disappear without explanation assume the worst. "Moved bulk invite to Next: the import work it depends on took longer than planned" is enough.

## Distribution

- Save to /org/product/roadmap-comms/<date>.md, one section per audience.
- Post the internal summary with org_message: the three biggest changes in one line each.
- Tell sales and support where the talk tracks live; they will not search for them.

## Pitfalls

- Dates leaking from the leadership version into the sales one.
- "Coming soon" with no definition. Use the commitment words above.
- Updating the roadmap without updating the talk tracks.
- Hiding "not planned" items. Sales will keep promising them.
