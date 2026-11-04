---json
{ "title": "Change control", "summary": "A change request template, risk tiers, test and rollback plans, release notes and the changes-released-without-rollback metric.", "tags": ["change-control", "release", "rollback", "testing", "crm"], "updated": "2026-11-04" }
---

# Change control

Every configuration change can break someone's report, automation or integration. Change control makes changes deliberate: you know why, you tested, you can undo and people know it happened.

## Change request template

```
ID / title / requester / date
Why: the problem or need, and who it affects
What: objects, fields, stages, layouts, automations, reports touched
Risk tier: low / medium / high (see below)
Dependencies: reports, dashboards, automations, integrations, permissions that use what changes
Test plan: cases and expected results
Rollback plan: exact steps to undo, and the backup taken
Communication: who needs to know, release note draft
Approver: name (per the unit's policy)
Release window: date and time
```

## Risk tiers

| Tier | Examples | Requirements |
|---|---|---|
| **Low** | help text, layout order, a new report | test in sandbox or on a test record; release note |
| **Medium** | new field, picklist change, new validation rule, report used in a dashboard | sandbox test; dependency check; approver sign-off; release note |
| **High** | stage changes, automations that update records, routing, integration mappings, deletions, permission changes | sandbox test with realistic data; full dependency check; backup; approver sign-off; scheduled window; monitoring after release |

When unsure, use the higher tier.

## Dependency check

Before changing or removing anything, find what uses it:

- Reports and dashboards filtering or grouping on it
- Automations, workflows, validation rules and formulas
- Integrations that read or write it (marketing automation, billing, support tools, data warehouse)
- Page layouts and permission sets

Use the CRM's "where used" or dependency features if available, and ask the owners of downstream tools.

## Testing

- Test in a sandbox where possible; otherwise on clearly marked test records.
- Write expected results before testing.
- Test as the users affected (their profile or permission set), not only as an admin.
- For automations, test the edge cases: blank values, bulk updates, records created by integrations.

## Rollback plan

Write rollback steps before you release:

- For field or layout changes: the previous configuration, recorded.
- For data-changing automations: the backup of affected records and how to restore.
- For deletions: prefer hiding or deprecating first; delete after a waiting period with no complaints.

## Release note

```
What changed: plain words
Why: the problem it solves
Who is affected and what they need to do
When: date and time
Questions: where to ask
```

Post it where the affected users will see it, and add it to the change log.

## After release

- Monitor for errors, failed automations and user reports for a set period (high-tier changes: watch closely).
- Close the request with the outcome.
- If you rolled back, record why and what you'll do differently.

## Changes released without rollback

```
Changes released without rollback = releases in the period not reverted
                                    within the monitoring window
                                    ÷ releases in the period
```

- Count a partial revert or a hotfix needed to restore normal work as a rollback.
- Report by risk tier; a rollback on a high-tier change is more serious.
- The aim is not zero rollbacks at any cost. A fast, clean rollback is better than living with a broken change. The metric shows test quality; read every rollback's cause.

## Pitfalls

- **Changing production directly** "because it's small". Small changes cause most surprises.
- **No owner for automations.** Every automation needs a named owner and a description.
- **Bundling** unrelated changes in one release makes rollback hard. One change, one request.
