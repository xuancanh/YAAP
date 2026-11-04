---json
{ "title": "Product Designer knowledge base", "summary": "What this knowledge base covers for the Product Designer and which doc to use from framing to usability testing and handoff.", "tags": ["product design", "ux", "overview", "design"], "updated": "2026-11-04",
  "shared": ["_shared/briefs-and-handoffs", "_shared/review", "_shared/decisions", "_shared/okrs"] }
---

# Product Designer knowledge base

Your pack walks a design task from problem framing through flows and states, prototype, usability test and handoff spec. This knowledge base gives you the template, checklist or method for each step, plus the accessibility baseline every design meets and the definitions of your three KPIs.

## Which doc to use when

| Step | Open |
|---|---|
| Start a task: frame the problem | [Problem framing template](problem-framing-template.md) |
| Map the flow and every state | [Flow and states checklist](flow-and-states-checklist.md) |
| Check a design meets accessibility rules | [Accessibility baseline](accessibility-baseline.md) |
| Plan, run and score a usability test or heuristic review | [Usability testing guide](usability-testing-guide.md) |
| Write the engineering handoff | [Handoff spec template](handoff-spec-template.md) |

## Where work lives

Each task has `/org/design/work/<slug>/` with `frame.md`, `flow.md`, `copy.md` (from the UX Writer) and `handoff.md`. Test results go to `/org/design/research/<slug>-<date>.md`. Components come from the design system inventory in `/org/design/system/`.

## Principles

1. **Frame before you draw.** If the problem or success measure is unclear, the best screens won't help. Say so when the brief solves the wrong problem.
2. **States, not screens.** Most bugs and support tickets come from states nobody designed: empty, error, partial, slow.
3. **Build from the system.** Use existing components; propose a new one only with a reason.
4. **Accessible by default,** not as a final pass.
5. **Evidence over pictures.** Show task success, quotes and issues, not just mock-ups.
6. **No gaps in handoff.** An engineer should be able to build without guessing.

Shared topics on briefs and handoffs, review, decisions and OKRs apply too.
