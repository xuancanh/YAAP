---json
{ "title": "Debugging method", "summary": "A step-by-step method for finding the real cause of a bug instead of guessing, with the common traps.", "tags": ["debugging", "bugs", "root cause"], "updated": "2026-11-04" }
---

# Debugging method

Debugging is running experiments. Each step should shrink the space where the bug can be. If you have changed code three times without learning anything, stop and go back to step 1.

## 1. Reproduce it

You cannot fix what you cannot see fail.

- Get the exact input, user, data, version and environment from the report.
- Reproduce it in your sandbox with the smallest setup you can.
- Write the reproduction down as steps or, better, as a failing test.

If you cannot reproduce it, do not guess-fix. Collect more evidence (logs, timestamps, the user's exact actions) and say on the task what you need.

## 2. Make it smaller

Cut the reproduction down until removing anything makes the bug go away. Fewer moving parts means fewer suspects. Often the minimal case already points at the cause.

## 3. Read the evidence

- Read the full error and the full stack trace, including the first line, not just the last.
- Read the logs around the failure time, before and after.
- Check what changed: recent commits, dependency updates, configuration, data migrations. `git log` and `git bisect` are your friends when something used to work.

## 4. Form one hypothesis and test it

Write it as a sentence: "The total is wrong because discounts are applied after tax." Then design a check that would prove it wrong: a log line, a debugger breakpoint, a unit test of that one function.

- Change one thing at a time.
- Predict the result before you run the check. A surprise means your model of the code is wrong, which is useful information.

## 5. Narrow by halving

When you do not know where the fault is, split the path in half. Is the data correct at the midpoint? Then the bug is downstream; otherwise upstream. Repeat. `git bisect` does this over history; you can do it by hand over a call chain or a data pipeline.

## 6. Fix the cause, not the symptom

A null check that hides the crash is not a fix if the value should never be null. Ask "why?" until you reach the decision or assumption that was wrong. Then fix it at that point.

Check for siblings: if one caller misused a function, others may too. Search for the same pattern.

## 7. Prove it

- The failing test from step 1 now passes.
- The full relevant suite still passes.
- The original reproduction steps no longer fail.

In the PR description, write the cause in one sentence, the fix in one sentence, and why the test would catch a return.

## Common traps

- **Fixing the first suspicious thing you see.** Confirm it actually causes the failure before changing it.
- **Trusting what code "obviously" does.** Print or step through it. Assumptions are where bugs live.
- **Debugging in production data.** Copy the shape of the data into your sandbox; do not experiment on real records.
- **Changing several things at once.** You will not know which one mattered, and you may add a new bug.
- **Ignoring "can't happen" branches.** Logs that say "impossible" are often the clue.
- **Time and place.** Time zones, daylight-saving changes, locale formats, caching and eventual consistency cause bugs that only appear for some users at some times.

## When to escalate

Tell your manager on the task when the bug touches production data integrity, security or money, or when you have spent the estimated time without a confirmed cause. Share what you have ruled out; that is real progress.
