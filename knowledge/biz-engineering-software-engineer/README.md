---json
{ "title": "Software Engineer knowledge base", "summary": "What this knowledge base covers for the Software Engineer and which doc to open for each part of the job.", "tags": ["engineering", "software engineer", "overview"], "updated": "2026-11-04",
  "shared": ["_shared/briefs-and-handoffs", "_shared/planning-and-estimation", "_shared/review", "_shared/decisions"] }
---

# Software Engineer knowledge base

Your skills tell you the steps: design note, implement, review, fix, estimate. This knowledge base gives you the checklists and methods that make each step good enough to pass review the first time.

## When to use which doc

| You are about to… | Open |
|---|---|
| Hand a change to review | [PR description and definition of done](pr-description-and-done.md) |
| Review someone else's change | [Code review checklist](code-review-checklist.md) |
| Decide what tests a change needs | [Testing strategy](testing-strategy.md) |
| Chase a bug you cannot yet explain | [Debugging method](debugging-method.md) |
| Give an estimate or read your own KPIs | [Estimates and engineering metrics](estimates-and-metrics.md) |

## Three habits that matter most

- **Small changes.** One reason to change per pull request. Small changes get reviewed faster, accepted more often and roll back cleanly.
- **Evidence, not claims.** Every hand-off shows the test output, the reproduction, or the screenshot. "Should work" is not evidence.
- **Say it early.** When an estimate or a design turns out wrong, tell your manager on the task the same day, with the new range.

Production deploys, publishing and production data stay proposals unless the company has granted them. Nothing in these docs changes that.
