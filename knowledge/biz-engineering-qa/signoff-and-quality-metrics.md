---json
{ "title": "Release sign-off and quality metrics", "summary": "A release sign-off template with verdict rules, and formulas for escaped defects, regression pass rate, flaky tests and critical-flow coverage.", "tags": ["release", "sign-off", "metrics", "kpi", "qa"], "updated": "2026-11-04" }
---

# Release sign-off and quality metrics

## The sign-off

A sign-off is a verdict with evidence. It is not a promise that nothing is broken; it states what you tested, what you found, and what risk remains.

```markdown
# QA sign-off: <release / version>
Date: <date>   Build verified: <exact build>

## Verdict
<GO | GO WITH RISKS | NO-GO> — <one sentence why>

## Tested
| Area / risk item | How | Result |
<From the test plan: automated suite run, exploratory charters, manual checks.>

## Regression suite
<Run ID>: <passed>/<run> passed. Quarantined: <n>, listed below.

## Open defects
| Bug | Severity | Decision (fix before / ship with workaround / defer) | Owner |

## Not tested
<Everything in scope that was not covered, and why. Repeat the plan's
out-of-scope items that matter for this release.>

## Residual risk
<What could still go wrong, how likely, and how we would notice:
monitoring, alert, support channel.>
```

### Verdict rules

Agree these with the Head of Engineering and write them into the test plan's exit criteria. A common shape:

- **NO-GO** if any open critical defect, any critical flow failing, or a top-risk item untested.
- **GO WITH RISKS** if open major defects have an agreed workaround or decision, or some planned coverage was skipped, and you list each risk.
- **GO** when exit criteria are met.

The release decision belongs to the Head of Engineering. Your job is a verdict they can trust.

## KPI formulas

Measure over a fixed period (release or month) and say which.

### Escaped defects

```
escaped defects = defects found in production in the period
                  that existed in a build QA signed off
```

Report the count by severity, and also the rate so it is comparable across busy and quiet periods:

```
escape rate = escaped defects / (escaped defects + defects found before release)
```

Count defects in areas the sign-off listed as "not tested" too, but tag them. They show whether the out-of-scope choices were wise.

### Regression pass rate

```
regression pass rate = tests passed / tests run   (per run of the blocking suite)
```

Track it on the release candidate build and as a trend. Exclude quarantined tests from the denominator but report their number next to it, so a high pass rate cannot hide a growing quarantine.

### Flaky tests

```
flaky tests = tests that both passed and failed on the same code
              within the period
flaky rate  = flaky tests / tests in the suite
```

Also track the age of each quarantined test; old quarantine is lost coverage.

### Critical-flow coverage

```
critical-flow coverage = critical flows with a passing automated
                         end-to-end or API test / critical flows listed
```

The list of critical flows comes from the company (the SRE's user journeys are a good source). A flow counts only if its test ran on the release build. Report which flows are uncovered by name, not just the percentage.

## Reading the numbers together

- Pass rate high and escapes rising: the suite tests the wrong things. Look at the escaped-defect log.
- Pass rate low and few escapes: the suite is noisy. Fix flakiness before adding tests.
- Coverage of critical flows below the full list: that is the first gap to close, ahead of new feature tests.
