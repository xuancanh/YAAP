---json
{ "title": "Impact, effort and RICE", "summary": "How to rank a list of work with RICE, an impact/effort 2x2, MoSCoW or cost of delay (WSJF), with a worked RICE example.", "tags": ["prioritisation", "rice", "moscow", "wsjf", "roadmap"], "updated": "2026-11-04",
  "sources": [
    { "title": "RICE: Simple prioritization for product managers", "url": "https://www.intercom.com/blog/rice-simple-prioritization-for-product-managers/", "publisher": "Intercom", "author": "Sean McBride", "date": "2018-01-05", "accessed": "2026-11-04" },
    { "title": "WSJF (Weighted Shortest Job First)", "url": "https://framework.scaledagile.com/wsjf", "publisher": "Scaled Agile Framework", "accessed": "2026-11-04" }
  ] }
---

# Impact, effort and RICE

Prioritising means choosing what *not* to do yet. Every method below does the same job: it makes the trade-off visible, so the ranking can be argued about openly instead of decided by whoever spoke last. Pick one method per list and stick with it.

## RICE

Intercom's RICE (Sean McBride, 2018) scores each item on four factors:

**Score = (Reach × Impact × Confidence) ÷ Effort**

- **Reach**: how many people or events it affects in a fixed period, for example customers per quarter. Use real counts from a metric source where you can.
- **Impact**: how much it moves the goal for each person reached. Intercom's scale: 3 = massive, 2 = high, 1 = medium, 0.5 = low, 0.25 = minimal.
- **Confidence**: how sure you are of the other numbers. Intercom uses 100% high, 80% medium, 50% low, and treats anything below 50% as a moonshot.
- **Effort**: total work. Intercom uses person-months. Any consistent unit is fine (person-weeks, agent task runs), as long as every item uses the same one.

Confidence is where honesty goes. If reach is a guess, say so and use 50%. Don't round it up because you like the idea.

### Worked example

Three candidate projects, reach per quarter. The numbers are illustrations.

| Item | Reach | Impact | Confidence | Effort | Score |
|---|---|---|---|---|---|
| A. Onboarding checklist | 500 new users (analytics) | 2 | 80% | 2 | 500×2×0.8÷2 = **400** |
| B. Better error messages | 2,000 users who hit errors (logs) | 0.5 | 50% (impact guessed) | 1 | 2000×0.5×0.5÷1 = **500** |
| C. Team-plan billing | 300 accounts (estimate, sales lead) | 3 | 100% | 4 | 300×3×1.0÷4 = **225** |

B ranks first, but its confidence is low. One cheap move is to raise confidence before committing, for example by checking support tickets for error complaints. C ranks last, but if a deadline depends on it, that's a cost-of-delay argument (below) that RICE doesn't capture. Treat the score as the start of the discussion, not the verdict.

## Impact/effort 2x2

For a quick sort, or when you don't have numbers, place items on two axes:

| | Low effort | High effort |
|---|---|---|
| **High impact** | Quick wins: do now | Big bets: plan and staff them |
| **Low impact** | Fill-ins: if there's slack | Money pits: don't |

It's fast and good for a meeting, but coarse. Use RICE when the list is long or the stakes are high.

## MoSCoW

Sorts scope for a fixed deadline or release:

- **Must**: without it, the release fails or isn't legal or safe.
- **Should**: important, but there's a workaround.
- **Could**: nice to have.
- **Won't (this time)**: explicitly out. Writing this down is the point.

Keep "Must" small. If everything is a must, nothing is prioritised.

## Cost of delay and WSJF

Some work loses value the longer it waits: a seasonal campaign, a contract deadline, a fix that's leaking customers. The Scaled Agile Framework's **WSJF** (Weighted Shortest Job First) divides the cost of delay by job size:

**WSJF = Cost of Delay ÷ Job size**

Cost of delay combines user and business value, time criticality, and risk reduction or opportunity enablement, each scored relative to the other items. Use WSJF when timing matters more than raw value.

## Writing up a ranking

```markdown
## Priorities: <list name> — <YYYY-MM-DD>
Method: RICE (reach per quarter; effort in person-weeks)

| Rank | Item | R | I | C | E | Score | Sources / notes |
|---|---|---|---|---|---|---|---|

**Doing next:** <top items>. **Not doing now:** <items and why>.
**Would change the order:** <new data or deadline that would reshuffle it>.
```

Save it as a file, link it from the board, and log big reorderings in `/org/decisions.md`.

## Common pitfalls

- **Fake precision.** A score of 412 vs 398 isn't a real difference. Treat close scores as ties and use judgment.
- **Invented reach.** Take it from a metric source or a named person, or label it as an estimate and lower the confidence.
- **Ignoring deadlines.** RICE has no sense of time. Check cost of delay.
- **Mixing units.** Effort must use the same unit for every item.
- **Not saying no.** A ranking that doesn't drop anything hasn't done its job. See [saying no](./saying-no.md).
