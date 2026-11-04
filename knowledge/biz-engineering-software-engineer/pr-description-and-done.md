---json
{ "title": "PR description template and definition of done", "summary": "A fill-in pull request description and the checklist a change must pass before you ask for review.", "tags": ["pull request", "definition of done", "review", "template"], "updated": "2026-11-04" }
---

# PR description and definition of done

A reviewer should understand what changed, why, and how you know it works without opening the task. Write the description for someone who wasn't there.

## Template

```markdown
## What and why
<One or two sentences in the words of the task's done_when. Link the task.>

## How
<The approach in a few bullets. Name the files or modules that matter.
If you wrote a design note, link it and say where you deviated.>

## Evidence
- Tests: <command run> → <result, e.g. "212 passed">
- New tests: <names, and the behaviour each covers>
- Manual check: <steps and what you saw, or a screenshot for UI>

## Risk and rollback
- Blast radius: <who or what breaks if this is wrong>
- Data or schema changes: <none | migration name, reversible? backfill?>
- Rollback: <revert the commit | disable flag X | down-migration>

## Out of scope / follow-ups
<What you deliberately did not do, as task candidates.>
```

## Writing tips

- **Lead with the outcome**, not the history of how you got there.
- **Name the trade-off** you made if a reviewer might pick differently. It saves a round-trip.
- **Flag the part you are least sure of.** Reviewers spend their attention where you point it.
- **Keep refactors separate.** If you moved code and changed behaviour, split it into two changes or two clearly marked commits.

## Definition of done

Do not request review until each line is true or explicitly waived in the description.

**Behaviour**
- [ ] The done_when of the task is met, item by item.
- [ ] Edge cases from the design note are handled: empty input, missing permissions, concurrent edits, very large input.
- [ ] Errors are handled where they can happen and tell the user or caller something useful.

**Tests**
- [ ] New behaviour has tests at the lowest level that can catch the failure (see [testing strategy](testing-strategy.md)).
- [ ] A bug fix has a regression test that failed before the fix.
- [ ] The relevant test suite passes locally in your sandbox; you ran it after the last edit.

**Code**
- [ ] Lint and type checks pass.
- [ ] No debug output, commented-out code or stray TODOs without a task.
- [ ] Names say what things are; no new abbreviations a newcomer would not know.
- [ ] No secrets, tokens or personal data in code, tests, fixtures or logs.

**Change hygiene**
- [ ] One reason for the change; diff contains only what that reason needs.
- [ ] Migrations are reversible or the description says why not.
- [ ] Public interfaces (APIs, events, file formats) are backward compatible, or the break is called out with who must change.
- [ ] Docs or comments that describe the changed behaviour are updated.

**Hand-off**
- [ ] Description follows the template above.
- [ ] The review request names what kind of review you want (design, correctness, quick sanity check).

## When the change is too big

If the description needs more than about a screen to explain "How", the change is probably too big. Options, in order of preference:

1. Split by layer: data model first, then logic, then UI.
2. Split by slice: one user path end to end, then the next.
3. Land behind a feature flag that stays off until the last slice is in.

Tell your manager on the task when you split, with the new plan.
