---json
{ "title": "Content audit method and metrics", "summary": "How to run the monthly content audit with an issue rubric, and formulas for glossary consistency, error-message coverage and audit issues closed.", "tags": ["content audit", "metrics", "kpis", "rubric"], "updated": "2026-11-04" }
---

# Content audit method and metrics

The monthly audit finds words in the live product that confuse, contradict or mislead, and turns them into fixes. It's also where your three KPIs come from, so collect the data the same way each month.

## Scope

Pick the flows that matter most: sign-up and onboarding, the core task, billing and account, and any flow changed since the last audit. Rotate the rest across months so the whole product is covered over time. Write the scope at the top of the audit.

## Capture

For each flow, capture every string in every state: default, empty, loading, error, success, permission-denied. Screenshots plus a strings table work well; if engineering can export string files, use them. Trigger errors deliberately (wrong input, offline, expired session) to see what users see.

```markdown
| Flow | Screen / state | Element | Live string | Issue type | Severity | Proposed string | Needs eng? |
```

## Issue types

| Type | Check |
|---|---|
| **Clarity** | Would a new user understand it without context? Is the next step obvious? |
| **Glossary** | Does it use the glossary term? Any "don't use" terms? |
| **Consistency** | Same action, same verb across screens? Same format for dates and numbers? |
| **Voice and tone** | Matches the voice guide and the situation? |
| **Accuracy** | Is it still true? Old feature names, wrong limits, promises the product doesn't keep. |
| **Error quality** | Says what happened and how to fix it? |
| **Accessibility** | Visible labels, descriptive links and buttons, alt text, errors in text |
| **Length and fit** | Truncated, wraps badly, breaks in long languages |

## Severity

- **High:** blocks or misleads: a wrong instruction, a misleading claim, a missing error message, an inaccessible label on a key control.
- **Medium:** slows or confuses: inconsistent terms, vague buttons, unclear empty states.
- **Low:** polish: punctuation, capitalisation, tone slips.

Fix high-severity items first and raise them immediately rather than waiting for the monthly report.

## Output

Save `/org/design/content/audits/<yyyy-mm>.md` with:

1. Scope and date.
2. KPI table (below).
3. Issues table, sorted by severity.
4. Fixes you can make in copy files directly, and backlog tasks for fixes that need engineering, each with the proposed string.
5. Patterns: if many issues share a cause (a missing glossary term, no error catalogue entry for a service), fix the cause.

## Metric definitions

### Glossary consistency

```
Glossary consistency = audited strings that use glossary terms correctly
                       / audited strings that contain a glossary concept
```

Count a string once even if it has several terms; a string fails if any term is wrong. Only strings that mention a glossary concept are in the denominator. Also report the count of "don't use" terms found.

### Error-message coverage

```
Error-message coverage = known error conditions with an approved, live message in the catalogue
                         / known error conditions
```

- "Known error conditions" come from engineering's list for the audited flows.
- An error showing a raw code, a generic "Something went wrong" without a next step, or no message at all counts as not covered.
- Report by flow so gaps are easy to assign.

### Content-audit issues closed

```
Issues closed rate = issues from audits that are fixed and live (verified in product)
                     / issues raised in those audits
Median age of open issues = median days since raised, for open issues
```

- Verify in the product before closing; a merged string that isn't released isn't closed.
- Report by severity; high-severity issues should close fastest.
- Track issues waiting on engineering separately from those waiting on you, so the cause of slow closure is visible.

## KPI table template

```markdown
| Metric | This month | Last month | Notes |
|---|---|---|---|
| Glossary consistency | | | n strings = |
| "Don't use" terms found | | | |
| Error-message coverage | | | conditions = |
| Issues closed rate (all audits) | | | |
| Open high-severity issues | | | |
| Median age of open issues (days) | | | |
```

## Tips

- Audit as a new user would: use a fresh account and a small screen.
- Read strings aloud; awkward ones show up fast.
- Don't rewrite everything. Propose the smallest change that fixes the problem, so it ships.
- Celebrate closed issues in the report. The metric that matters is fewer problems in the product, not more findings.
