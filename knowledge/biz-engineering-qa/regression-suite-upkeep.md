---json
{ "title": "Keeping the regression suite trustworthy", "summary": "Rules for what to automate, how to handle flaky tests, and how to prune the suite so a red run always means something.", "tags": ["regression", "automation", "flaky tests", "qa"], "updated": "2026-11-04" }
---

# Keeping the regression suite trustworthy

The suite is only useful if people believe it. Green should mean "safe to release on what we cover"; red should mean "something real broke". Every flaky or redundant test erodes that.

## What to automate

Automate a check when all three hold:

1. **It will run many times:** a critical flow, a rule that changes often, or an escaped bug.
2. **The expected result is clear** and stable enough to assert.
3. **It can run at a low level.** Prefer unit or API tests; use UI tests only for the critical journeys themselves.

Always automate:

- Each critical flow end to end, once (sign-in, the core action, payment or whatever the company lists as critical).
- Each escaped defect, at the lowest level that would have caught it.
- Each high-risk item from the test plan.

Leave to exploration: new, fast-changing UI; judgement calls (is this copy clear?); one-off checks.

## Writing tests that stay green for the right reasons

- **Wait for conditions, not time.** Wait until an element or response appears; never sleep a fixed number of seconds.
- **Own your data.** Each test creates and cleans up its own records. Shared accounts cause order-dependent failures.
- **Stable selectors.** Target test IDs or accessible names, not CSS paths or text that marketing may change.
- **One behaviour per test**, named as a sentence.
- **Control the outside world.** Stub third-party services in most tests; keep a small, separate set of contract tests against the real ones.

## Flaky tests

A flaky test passes and fails on the same code.

**When one appears:**

1. Confirm by re-running it in isolation several times on the same build.
2. Record it in the flaky list with the first date seen and the failure message.
3. Look for the usual causes:
   - timing (fixed sleeps, animations, async work not awaited);
   - shared or leftover data, test order dependence;
   - real clock, time zone or date;
   - network or third-party calls;
   - resource limits in the test environment.
4. Fix it, or **quarantine** it: move it out of the blocking run, open a task with an owner, and keep running it separately so you know when it is fixed.
5. A quarantined test that stays unfixed past the team's agreed limit is deleted or rewritten; a test nobody trusts is not coverage.

Never add automatic retries to make the suite green without also tracking which tests needed a retry. Hidden retries hide real intermittent bugs.

## Pruning

Review the suite each sprint or month:

- **Duplicates:** two tests that fail for the same reason. Keep the faster one.
- **Dead tests:** cover removed features.
- **Slow tests:** can the same check move down a level?
- **Never-fail tests:** a test that has not failed in a long time is fine if it guards a critical rule; question it if it asserts nothing meaningful.

## Linking escaped defects

For each defect found in production, record:

| Field | Example |
|---|---|
| Defect | Link |
| Why it escaped | No test; test existed but wrong assertion; environment differs from production; requirement missing |
| Gap closed by | New API test `refund_retry_is_idempotent` |
| Level | Unit / integration / end-to-end |

This log is your best guide to where the suite is weak. Patterns ("three escapes from time zone handling") become test plan risk items.

## Measuring the suite

See [release sign-off and quality metrics](signoff-and-quality-metrics.md) for the formulas for regression pass rate, flaky tests and critical-flow coverage.
