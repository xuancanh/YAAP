---json
{ "title": "Handoff spec template", "summary": "An engineering handoff spec template with acceptance checks, plus a completeness checklist and the handoff completeness formula.", "tags": ["handoff", "specification", "template", "kpis", "engineering"], "updated": "2026-11-04" }
---

# Handoff spec template

A complete handoff means an engineer can build the design without asking you what happens in any state. Questions after handoff aren't failures, but each one is a gap the spec could have closed. Save as `/org/design/work/<slug>/handoff.md`.

## The template

```markdown
# Handoff: <slug> — v<n> — <date>

## Summary
- Problem and success measure: <link to frame.md, one line each>
- What's changing: <short description>
- Test evidence: <link to research note; task success before/after>
- Out of scope: <list>

## Flows
- Flow map: <link to flow.md>
- Entry points and exits: <list>

## Screens and states
| Screen / component | State | Frame / prototype link | Notes |
(use the state matrix; no blank cells)

## Components
| Component | From design system? | Variant / props | Notes |
| Button | Yes | primary, size md | |
| BulkEditPanel | New | — | Proposal: <link>; why existing ones don't fit |

## Tokens and layout
- Colour, type, spacing and radius tokens used (by name, not raw values)
- Breakpoints and layout behaviour at each
- Any token not in the system: <flag for the design system owner>

## Behaviour
- Interactions: <click, hover, keyboard, drag + alternative>
- Validation rules and when they run
- Loading behaviour and timeouts
- Undo, confirmation and destructive actions
- Animations: <what, duration, easing, reduced-motion behaviour>
- Data: <sorting, pagination, limits, empty data, permissions>

## Copy
- Strings: <link to copy.md from the UX Writer, with string IDs>
- Error messages: <catalogue IDs>

## Accessibility
- Focus order for complex screens and dialogs
- Accessible names for icon-only controls
- Heading levels and landmarks
- Status messages to announce
- Keyboard shortcuts, if any

## Analytics
- Events to track success measures: <event name, when it fires, properties>

## Acceptance checks
- [ ] <Given / when / then for each key behaviour and state>

## Open questions
| Question | Owner | Due |
```

## Writing acceptance checks

Acceptance checks turn the design into tests the engineer and QA can run. Write them for behaviour and states, not pixels.

```
Given I have selected 5 transactions
When I choose a category in the bulk edit panel and select "Apply"
Then all 5 show the new category, a status message "5 transactions updated" is announced,
and "Undo" is available for at least the time shown in the toast

Given the update fails for 2 of 5 transactions
Then the 3 that succeeded keep the new category, the 2 failures are listed with a reason,
and I can retry just the failures
```

Cover: the happy path, every error state, permission states, empty and too-much data, keyboard-only use.

## Handoff completeness

This is one of your KPIs. Measure it the same way every time:

```
Handoff completeness = required spec items present / required spec items applicable
```

Required items (mark "n/a" with a reason where they don't apply):

1. Frame and success measure linked
2. Flow map with entry points and exits
3. State matrix with no blank cells
4. Every component identified as system or new (with reason)
5. Tokens named; non-system tokens flagged
6. Responsive behaviour per breakpoint
7. Interaction and validation behaviour
8. Copy linked with string IDs; errors in the catalogue
9. Accessibility notes (focus order, names, announcements)
10. Analytics events for the success measure
11. Acceptance checks covering states and errors
12. Open questions with owners

A follow-up signal to track alongside: **post-handoff clarifications**, the number of questions engineering asked that the spec should have answered. Note each one and add the missing item to the template if it recurs.

## Handoff meeting or async walkthrough

- Walk through the flow and the riskiest states, not every frame.
- Ask the engineer to explain back the hardest behaviour.
- Agree how design review of the build will work (which environment, when).

## After build

Review the implementation against the acceptance checks and states. Log differences as bugs or agreed changes, and update the spec so it stays the source of truth.
