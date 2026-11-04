---json
{ "title": "Flow and states checklist", "summary": "How to map a user flow and a checklist of every screen state and edge case to design before visual work starts.", "tags": ["user flow", "states", "edge cases", "checklist"], "updated": "2026-11-04" }
---

# Flow and states checklist

A flow map shows every path a user can take; the states list shows what each screen looks like in every condition. Do both before visual design. Engineers will build every state whether you design it or not, so undesigned states ship as accidents.

## Mapping the flow

Write it as text first; diagrams can come later. Save as `/org/design/work/<slug>/flow.md`.

```markdown
# Flow: <slug>

Entry points:
- From <screen> via <action>
- From email/notification link
- Direct URL / deep link

Happy path:
1. <screen> — user does <action> — system <response>
2. …
End: <success state>, then <where they go next>

Branches:
- At step 2, if <condition> → <alternate path>
- At step 3, user cancels → <where they land, what's kept>

Exits and returns:
- Leaves mid-flow → is progress saved? where do they return?
```

Questions that find missing paths:

- How else can someone arrive here? (Link from an email, shared URL, back button, a second tab.)
- What if they're not signed in, or signed into a different workspace?
- What if they don't have permission for one step?
- What if they stop halfway and come back tomorrow?
- What if two people do this at the same time on the same object?

## The states checklist

For every screen or component in the flow, design or explicitly decide each of these:

| State | Questions to answer |
|---|---|
| **Empty, first use** | What does a new user see? How do they get started? |
| **Empty, no results** | Filters or search returned nothing. How do they recover? |
| **Loading** | Initial load and refresh. Skeleton, spinner or progressive content? What if it's slow? |
| **Partial** | Some data loaded, some failed or is still loading. |
| **Ideal** | Typical amount of real data. |
| **Too much** | Long names, many items, large numbers, long translations. Truncation, wrapping, pagination. |
| **Error: validation** | What field-level messages, where? (Work with the UX Writer.) |
| **Error: system** | Request failed, timeout, offline. Is input kept? Retry? |
| **Permission** | Can view but not edit; can't view at all. |
| **Success** | Confirmation, next step, undo. |
| **Disabled** | Why is it disabled and how does the user find out? |
| **Destructive** | Confirmation or undo; what's affected. |

For interactive components, also: default, hover, focus (visible), active, selected, disabled, error.

## Edge cases to check

- [ ] Smallest supported screen and largest; landscape on mobile if relevant.
- [ ] Zoom and larger text settings (layouts don't break or hide content).
- [ ] Keyboard-only path through the whole flow.
- [ ] Screen reader order makes sense (headings, labels, focus moves to dialogs and back).
- [ ] Slow network: what does the user see, and can they double-submit?
- [ ] Time zones, date and number formats, currencies, right-to-left languages if supported.
- [ ] Data limits: max lengths, max items, files too big or wrong type.
- [ ] Session expiry mid-flow.
- [ ] Concurrent edits.
- [ ] First-time vs returning user.

## State matrix (handy for handoff)

```markdown
| Screen / component | Empty | Loading | Partial | Ideal | Too much | Error | Permission | Success |
|---|---|---|---|---|---|---|---|---|
| Transaction list | ✔ frame 4 | ✔ skeleton | ✔ frame 6 | ✔ | ✔ paginate 50 | ✔ frame 7 | n/a | — |
| Bulk edit panel | n/a | ✔ | — | ✔ | ✔ 500 limit msg | ✔ | ✔ read-only | ✔ toast + undo |
```

Mark each cell: designed (link to frame), "n/a" with reason, or "open" with an owner. No blank cells at handoff.

## Working with others

- Share the flow and states list with the UX Writer early so they write strings for every state, and with engineering to confirm which states are technically possible (they often know about error cases you don't).
- Check the design system for existing patterns for empty, loading and error states before inventing new ones.

## Common misses

- Designing only the ideal state with perfect sample data.
- No way back from an error except refreshing.
- Loading states that cause layout shift when content arrives.
- Permission states that show a button which then fails.
- Success with no next step.
