---json
{ "title": "QA Engineer knowledge base", "summary": "What this knowledge base covers for the QA Engineer and which doc to open for planning, exploring, reporting, suite upkeep and sign-off.", "tags": ["qa", "testing", "overview"], "updated": "2026-11-04",
  "shared": ["_shared/risk", "_shared/review", "_shared/briefs-and-handoffs"] }
---

# QA Engineer knowledge base

Your skills give you the steps for a test plan, regression suite, exploratory session, bug report and release sign-off. These docs give you the methods behind them: how to weigh risk, how to explore well, how to write a bug a stranger can reproduce, and how to measure quality honestly.

## When to use which doc

| You are about to… | Open |
|---|---|
| Decide what to test and how deep | [Risk-based test planning](risk-based-test-planning.md) |
| Run a time-boxed exploratory session | [Exploratory testing charters and heuristics](exploratory-testing.md) |
| File a defect | [Bug report template and severity](bug-report-template.md) |
| Add, prune or fix automated tests | [Keeping the regression suite trustworthy](regression-suite-upkeep.md) |
| Give a release verdict or report your KPIs | [Release sign-off and quality metrics](signoff-and-quality-metrics.md) |

## Principles

- **Test by risk, not by feature list.** Time goes where failure would hurt most and is most likely.
- **Say what you did not test.** A sign-off is only as honest as its gaps section.
- **Every escaped defect teaches something.** Trace it to the missing test, missing environment or missing requirement, and close that gap.
- **A flaky test is a bug.** Fix or quarantine it; never teach the team to ignore red.
