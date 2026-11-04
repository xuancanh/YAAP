---json
{ "title": "Code review checklist", "summary": "What to check, in what order, when reviewing a change, and how to write comments that get acted on.", "tags": ["code review", "checklist", "quality"], "updated": "2026-11-04" }
---

# Code review checklist

Review in passes, from the most expensive mistakes to the cheapest. Stop and comment early if the first pass fails: there is no point polishing names in a change that solves the wrong problem.

## Pass 1: Is this the right change?

- [ ] Does it do what the task's done_when asks, no more and no less?
- [ ] Is the approach reasonable, or is there a much simpler one? If so, say it now, before line comments.
- [ ] Is it small enough to review well? If not, ask for a split rather than skimming.

## Pass 2: Is it correct?

- [ ] Trace the main path with a concrete input. Does the output match?
- [ ] Edge cases: empty, null, zero, one, many, duplicates, very large, unicode, time zones and daylight-saving changes.
- [ ] Failure paths: what happens when the network, database or a dependency fails? Is anything left half-written?
- [ ] Concurrency: two users or two jobs doing this at once. Any race on read-then-write?
- [ ] Off-by-one, inclusive versus exclusive ranges, integer versus float, rounding of money.
- [ ] State: are caches, retries and idempotency handled? Will a retry double-charge or double-send?

## Pass 3: Is it safe?

- [ ] Input from users or other systems is validated and never concatenated into SQL, shell commands or HTML.
- [ ] Authorisation is checked on the server for every new endpoint or action, not just hidden in the UI.
- [ ] No secrets, tokens or personal data in code, logs, error messages or test fixtures.
- [ ] Migrations: reversible, safe on a large table, compatible with the code version running during deploy.
- [ ] Public interfaces stay backward compatible, or the break is called out.

## Pass 4: Is it tested?

- [ ] New behaviour has tests; a bug fix has a test that would have failed before.
- [ ] Tests assert outcomes, not implementation details, so a refactor does not break them.
- [ ] Tests are deterministic: no sleeps, real clocks, random seeds or network calls without control.
- [ ] The evidence in the description matches the code you are reading.

## Pass 5: Will the next person understand it?

- [ ] Names say what things are. Functions do one thing.
- [ ] Comments explain why, not what.
- [ ] No duplicated logic that already exists elsewhere in the codebase.
- [ ] Dead code, debug output and unused imports are gone.

## Writing comments

Label each comment so the author knows what is required:

- **Blocking:** must change before merge. Say why: the bug, the risk, the broken case.
- **Suggestion:** better in your view; author decides.
- **Question:** you do not understand something. Often reveals a missing comment or test.
- **Nit:** cosmetic. Group nits in one comment, or skip them if a formatter could catch them.

Good comments are specific and actionable. Not "this is confusing" but "I read `active` as 'logged in'; does it mean 'not archived'? Consider `isArchived`."

Point at the code, not the person: "this loop misses the last item", not "you forgot the last item".

## Verdict

End with one clear verdict:

- **Approve:** no blocking comments.
- **Approve with nits:** merge after the small changes, no second review needed.
- **Request changes:** list the blocking items in one summary so the author can fix them in one pass.

If you only checked part of the change (for example, you are not qualified on the migration), say what you did not review so someone else can.

## Reviewing your own change first

Read your own diff as a reviewer before you request review. Most first-review rejections are things the author would have caught in a self-review: stray debug lines, a missed test, a description that no longer matches the code.
