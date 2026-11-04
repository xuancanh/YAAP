---json
{ "title": "Bug report template and severity", "summary": "A bug report template anyone can reproduce from, with severity and priority definitions and examples.", "tags": ["bug report", "severity", "priority", "template"], "updated": "2026-11-04" }
---

# Bug report template and severity

A good bug report lets someone who has never seen the feature reproduce the failure on the first try. If an engineer has to ask you a question, the report was missing something.

## Template

```markdown
# <Short title: what fails, where, under what condition>
e.g. "Refund total doubles when a partial refund is retried after timeout"

Severity: <critical | major | minor | trivial>   Priority: <set with the owner>
Build / version: <exact>   Environment: <test env, browser, device, OS>
Account / data: <test user, role, IDs of records used>
Found by: <session, regression test, user report>   Frequency: <always | n of m tries>

## Steps to reproduce
1. <Starting state: logged in as X, with Y existing>
2. <One action per step, exact values typed>
3. ...

## Expected
<What should happen, and where that expectation comes from:
requirement, done_when, existing behaviour, common sense.>

## Actual
<What happened. Exact error text. Copy, don't paraphrase.>

## Evidence
<Screenshot, short recording, log excerpt with timestamp, request ID,
failing test name. Remove any personal data.>

## Notes
<Workaround, related bugs, what you tried that did NOT reproduce it,
first build where it appears if known.>
```

## Writing the title

Format: **what fails + where + condition**. Search-friendly, specific.

- Weak: "Refunds broken"
- Strong: "Refund total doubles when a partial refund is retried after timeout"

## Severity versus priority

**Severity** is how bad the effect is. You set it from evidence.
**Priority** is how soon to fix it. The owner or manager sets it, weighing severity, frequency, who is affected and the release plan.

| Severity | Meaning | Examples |
|---|---|---|
| Critical | Data loss or corruption, security or privacy exposure, money wrong, or a critical journey fully blocked with no workaround | Wrong amount charged; another workspace's data visible; sign-in fails for everyone |
| Major | Important function fails or gives wrong results, a workaround exists or only some users are affected | Export omits the last row; invites fail for addresses with a plus sign |
| Minor | Function works but is awkward, inconsistent or misleading in a limited way | Error message unclear; sort order wrong in a rarely used list |
| Trivial | Cosmetic with no effect on use | Misaligned icon; typo in a tooltip |

A rare critical bug is still critical; its frequency affects priority, not severity.

## Reproduction tips

- **Reduce it.** Remove steps until the bug disappears, then put the last one back. Shorter reports get fixed faster.
- **Try one variation** each way: another browser, another role, fresh data. Note which reproduce.
- **Intermittent?** Record the number of attempts and failures, timestamps, and any request IDs. Do not label it "can't reproduce" without trying at least a few times.
- **Check for duplicates** before filing; add your evidence to an existing report instead.

## After filing

- Link the bug to the test plan item or exploratory session that found it.
- When it is fixed, re-test with the original steps and at least one nearby variation, then close with the build you verified on.
- If it escaped to production, also record the gap that let it through (see [release sign-off and quality metrics](signoff-and-quality-metrics.md)).

## Pitfalls

- Several bugs in one report. File one per failure so each can be fixed and closed.
- Opinions as bugs. "I don't like this layout" is feedback; file it as a suggestion and name the user problem.
- Personal data in screenshots or logs. Use test accounts, or redact.
