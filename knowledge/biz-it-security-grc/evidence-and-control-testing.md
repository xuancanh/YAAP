---json
{ "title": "Evidence and control testing", "summary": "What makes evidence acceptable, how to sample and test a control, how to file evidence, and formulas for control test pass rate and evidence on time.", "tags": ["evidence", "control testing", "audit", "metrics", "kpi"], "updated": "2026-11-04" }
---

# Evidence and control testing

Evidence is what turns "we do this" into "we can show we did this". Collect it as the work happens, not in the weeks before an audit.

## What good evidence looks like

| Quality | Means | Example |
|---|---|---|
| **Dated** | Shows when it happened, inside the period | Ticket with created and closed timestamps |
| **Attributable** | Shows who did or approved it | Approver's name on the access request |
| **Complete** | Covers the full population, or a sample drawn from the full population | Export of all leavers in the quarter, not a hand-picked few |
| **System-generated** where possible | Harder to fabricate, easier to repeat | Identity provider export, not a typed list |
| **Unaltered** | Original file or screenshot with visible context | Screenshot showing URL, date and setting |
| **Relevant** | Directly shows the control statement | For "MFA enforced", the policy setting, not the onboarding guide |

A screenshot of a setting shows it at one moment. For period-based controls (a Type II audit), pair settings with logs or periodic samples across the period.

## Testing a control

1. **Read the statement.** What exactly must be true?
2. **Get the population.** All events in the period (all leavers, all production changes, all access reviews).
3. **Sample.** For frequent controls, pick a sample at random from the population. Agree sample sizes with your auditor or follow the company's testing procedure; small populations are often tested in full.
4. **Check each item** against the statement: done, on time, by the right person, with the approval required.
5. **Record the result:** pass, or exception with details (which item, what was missing).
6. **For exceptions:** find out whether it is a one-off or a pattern, tell the control owner, and agree remediation. A control with exceptions is not "operating" until fixed and retested.

Write down the test so someone else could repeat it: population source, sample method, items checked, result.

## Filing evidence

Use one structure, for example:

```
/org/it-security/evidence/<control-id>/<yyyy-mm>/<short-description>.<ext>
```

With each period's folder, keep a short note: who collected it, from where, the population, and the sample. Remove or redact personal data that the test does not need.

## The evidence calendar

From the controls matrix, list every evidence item with its due date. Remind owners ahead of the due date, collect, check quality, file, and mark it done. A missed item is chased the same week; old gaps cannot be filled later.

## Metrics

### Control test pass rate

```
control test pass rate = controls tested in the period with no exceptions
                         / controls tested in the period
```

Rules:

- Count a control once per test cycle.
- A control that could not be tested (no evidence) counts as **failed**, not excluded; report it as "not evidenced".
- Report the list of failed controls and their remediation status, not just the rate.

### Evidence on time

```
evidence on time = evidence items filed, and passing the quality check,
                   by their due date
                   / evidence items due in the period
```

Rules:

- Items filed late count against the period they were due in.
- Items filed but failing the quality check (wrong period, incomplete population) are not on time until replaced.
- Report the overdue items with their owners.

### Reporting format

```markdown
| Metric | This period | Last period | Note |
| Control test pass rate | 42/45 | 40/44 | 2 exceptions, 1 not evidenced (listed) |
| Evidence on time | 88% | 80% | 4 items late: owners notified |
```

## Pitfalls

- Creating evidence after the fact ("we did review access; here is a document dated today"). It is a gap; record it honestly.
- Testing only the examples the owner sends. Draw the sample yourself from the full population.
- Marking a control operating after a single good month in a twelve-month audit period.
