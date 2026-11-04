---json
{ "title": "Acceptance criteria guide", "summary": "Write testable Given/When/Then acceptance criteria that cover edge cases and analytics, and accept or reject delivered work against them consistently.", "tags": ["acceptance-criteria", "gherkin", "given-when-then", "acceptance"], "updated": "2026-11-04",
  "sources": [{ "title": "Cucumber, Gherkin reference, accessed 2026-11-04", "url": "https://cucumber.io/docs/gherkin/reference/" }] }
---

# Acceptance criteria guide

Acceptance criteria are the contract between you and engineering for one story. Good criteria make acceptance a check, not a negotiation; vague ones make it an argument.

## The Given/When/Then form

The Gherkin format (used by tools like Cucumber) splits each scenario into:

- **Given** — the starting context: the system's state before anything happens.
- **When** — the action or event.
- **Then** — the expected outcome, observable from outside the system.
- **And / But** — continue the step above.

```
Scenario: Filter report by one cost centre
  Given I am a finance lead viewing the October report
  And the report has spend for cost centres "Ops" and "Sales"
  When I select the cost centre filter "Ops"
  Then I see only the rows for "Ops"
  And the total shows the sum for "Ops" only
  And the event report_filtered fires with cost_centre_count = 1
```

When the same scenario varies only in data, list the variations as a table (Gherkin calls this a Scenario Outline with Examples) instead of copying the scenario.

## What makes a criterion testable

| Untestable | Testable |
|---|---|
| The page loads quickly | The filtered report appears within the agreed response-time target on the standard dataset |
| The error message is clear | When the export fails, the message "Export failed — try again" appears and the filter stays applied |
| Works for all users | A user without the finance role sees no filter control |
| Handles large reports | A report with the largest expected number of rows filters without timing out |

If a number matters (a time limit, a row count), agree it with engineering and write it down. If it does not matter yet, leave it out rather than inventing one.

## Coverage checklist for each story

- [ ] The main success scenario.
- [ ] Empty state (no data).
- [ ] Validation errors and what the user sees.
- [ ] System errors (timeouts, failed saves) and recovery.
- [ ] Permissions: who can and cannot do it.
- [ ] Boundaries: zero, one, many; the largest expected size.
- [ ] The analytics event(s) and their properties.
- [ ] Anything the spec's states table lists for this flow.

Not every story needs every line. Tick what applies and note "n/a" for the rest, so reviewers know you considered it.

## Accepting delivered work

1. **Read the criteria first,** then the evidence: demo notes, staging link, test results.
2. **Check every criterion yourself,** in order. Don't accept on a summary.
3. **Verify the analytics event fires** with the right properties, in staging or the event debugger.
4. **Try the edge cases** listed in the spec for this flow.
5. **Decide:**
   - All criteria met → accept with org_review.
   - A criterion not met → request_changes, quoting the exact criterion and what you saw: "Criterion 3: total still shows all cost centres after filtering (staging, 4 Dec)."
   - Something new you want that was not in the criteria → accept the story and write a new story. Do not reject for criteria that were never agreed.

## When criteria were wrong

Sometimes engineering builds exactly what the criteria said and it is still not right. That is spec rework, and it counts against your rework metric, not theirs. Accept or close the story as built if it is shippable, record what was missed, and write the follow-up story with corrected criteria.

## Pitfalls

- Criteria that describe implementation ("uses a dropdown") instead of behaviour.
- Criteria added after the sprint starts without telling the team.
- Accepting with "minor issues" outstanding. Either they block acceptance or they become new stories.
- Forgetting the event, then losing the launch-week data.
