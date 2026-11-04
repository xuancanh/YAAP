---json
{ "title": "Technical debt triage", "summary": "How to log, score and fund technical debt so it competes fairly with feature work at sprint planning.", "tags": ["engineering", "tech-debt", "prioritisation", "planning"], "updated": "2026-11-04",
  "sources": [
    { "title": "Technical Debt Quadrant", "url": "https://martinfowler.com/bliki/TechnicalDebtQuadrant.html", "author": "Martin Fowler", "date": "2009-10-14", "accessed": "2026-11-04" }
  ] }
---

# Technical debt triage

Technical debt is any shortcut in the code or system that makes future
change slower or riskier: a missing test suite, a hand-run deploy step, a
module everyone is afraid to touch, an unsupported dependency. It loses
every planning argument against features unless it is written down,
scored, and given a standing share of capacity. This doc is how.

## Log it where planning can see it

Keep debt items in `/org/engineering/backlog.md` (or as backlog tasks),
tagged `debt`, each with a one-line cost statement. "The billing module is
messy" can't be scored. "Every billing change takes about two extra days
because there are no tests; four changes planned this quarter" can. Mark
the figure as an estimate and say whose.

Martin Fowler's quadrant is a useful label for the cause: debt can be
deliberate or inadvertent, and prudent or reckless. Prudent, deliberate
debt ("ship now, refactor after the launch") is a fair trade if it is
logged with a payback date. Reckless debt is a process finding for the
retro, not just a backlog item.

## Score it

Score each item 1 to 3 on four questions; the score sorts the list, your
judgment makes the call.

| Factor | 1 | 2 | 3 |
|---|---|---|---|
| Drag: how much does it slow planned work? | rarely touched | touched some sprints | in the path of a current key result |
| Risk: what happens if it bites? | annoyance | an incident or a bad release | data loss, security exposure, outage |
| Trend: is it getting worse? | stable | growing slowly | compounding (each change adds more) |
| Cost to fix | more than a sprint | a few days | under a day |

Priority = Drag + Risk + Trend + Cost-to-fix (higher first). Anything with
Risk 3 is reviewed on its own merits whatever the total: a security or
data-loss item may need to jump the queue, and if it involves an access or
data exposure it also goes to the Head of IT & Security.

## Fund it

Pick one model, write it in `/org/engineering/cadence.md` with the reason,
and keep to it:

- **Standing allowance**: a fixed share of each sprint's capacity for debt
  and maintenance. The company sets the share from its operating profile;
  a speed-first early product may keep it small, a reliability-first one
  larger. Unused allowance is not banked.
- **Boy-scout rule**: debt in the area a feature touches is paid as part of
  that feature, and its done_when says so.
- **Dedicated project**: for large items (a migration, a rewrite of a
  module), propose a project with `org_create_project`, a key result it
  moves (lead time, change fail rate, escaped defects) and an appetite.

Rewrites deserve extra care. Prefer incremental replacement behind a stable
interface to a big-bang rewrite, and set the appetite before starting.

## Worked example (made-up figures)

Three items at planning, sprint capacity for debt is 6 engineer-days:

| Item | Drag | Risk | Trend | Cost | Total | Est. days |
|---|---|---|---|---|---|---|
| No tests on refund path | 3 | 3 | 2 | 2 | 10 | 3 |
| Manual DB backup check | 1 | 3 | 1 | 3 | 8 | 0.5 |
| Old logging library | 2 | 1 | 2 | 1 | 6 | 8 |

Take the first two (3.5 days). The logging library is over the allowance;
it becomes a project proposal tied to the reliability key result, or waits.

## Pitfalls

- **A "debt sprint" once a quarter.** It gets cancelled the first time a
  deadline looms. A steady allowance survives.
- **No cost statement.** Without one the item can't compete, and the team
  feels ignored.
- **Treating all old code as debt.** Code that works and nobody needs to
  change costs nothing. Drag is what matters.
- **Paying debt nobody can see.** Report what the allowance bought (a test
  suite, a removed manual step) and which metric it should move, so the
  chief sees the return.
