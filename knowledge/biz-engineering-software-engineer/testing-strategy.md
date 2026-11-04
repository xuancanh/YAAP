---json
{ "title": "Testing strategy: what to test and at which level", "summary": "How to choose the right kind and number of tests for a change, using the test pyramid and a few rules for reliable tests.", "tags": ["testing", "test pyramid", "unit tests", "integration tests"], "updated": "2026-11-04",
  "sources": [{ "title": "Ham Vocke, The Practical Test Pyramid (martinfowler.com)", "url": "https://martinfowler.com/articles/practical-test-pyramid.html" }] }
---

# Testing strategy

Test each behaviour at the lowest level that can catch its failure. Lower-level tests are faster, more precise about what broke, and less flaky. Go higher only for what lower levels cannot see.

## The pyramid, in practice

The test pyramid (described well in Ham Vocke's *The Practical Test Pyramid*) says: many small fast tests at the bottom, fewer broader tests above, very few end-to-end tests at the top.

| Level | Tests | Use it for | Avoid it for |
|---|---|---|---|
| Unit | One function or class, no I/O | Logic, branches, calculations, parsing, edge cases | Checking that two systems agree |
| Integration | Your code with a real dependency (database, queue, file system) or a contract with another service | Queries, migrations, serialisation, transactions, API contracts | Exhaustive edge cases (too slow) |
| End-to-end | The running system through its UI or public API | A handful of critical user journeys | Anything a lower level can check |

A warning sign is the "ice-cream cone": most coverage in slow UI tests, few unit tests. Every failure then takes a long time to diagnose.

## Deciding what a change needs

Ask these questions in order:

1. **What new behaviour exists?** Each rule or branch gets a unit test.
2. **What crosses a boundary?** A new query, migration, API endpoint or message format gets an integration test.
3. **Does it touch a critical journey** (sign-in, the core action, payment)? Check the existing end-to-end test still covers it; add one only if the journey is new.
4. **Is it a bug fix?** Write the regression test first, watch it fail, then fix.

## Rules for tests that stay useful

- **Test behaviour, not implementation.** Assert what the caller sees. Tests that mirror internal calls break on every refactor and teach nothing.
- **One reason to fail.** A test name should read as a sentence: `rejects_refund_above_original_amount`.
- **Arrange, act, assert.** Set up, do one thing, check the result. Long tests hide which step broke.
- **Control time, randomness and the network.** Inject a clock, seed random generators, stub external calls. Real sleeps and real third-party APIs make tests flaky.
- **Isolate data.** Each test creates what it needs and does not depend on another test's leftovers or on run order.
- **Use realistic examples.** Real-looking names, amounts and dates catch encoding and rounding bugs that `"foo"` and `1` miss.
- **Keep fakes honest.** If you fake a dependency, have at least one integration test against the real thing, so the fake cannot drift.

## Coverage

Line coverage tells you what was never executed; it does not tell you what was checked. Use it to find untested branches in the code you changed, not as a target. A changed function with no test at all is the gap to fix; chasing a percentage leads to tests that assert nothing.

## Flaky tests

A test that sometimes fails without a code change is worse than no test: people learn to ignore red. When you meet one:

1. Re-run it in isolation to confirm.
2. Look for the usual causes: timing and sleeps, shared state, order dependence, real time zones or dates, network.
3. Fix it, or quarantine it with a task and tell the QA Engineer. Never silently retry until green.

## Before you hand off

Run the suite that covers your change after your last edit, and paste the command and result into the PR description. If you could not run something (for example, a test needing access you do not have), say so.
