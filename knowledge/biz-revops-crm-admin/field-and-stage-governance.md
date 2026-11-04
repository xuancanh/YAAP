---json
{ "title": "Field and stage governance", "summary": "Naming conventions, a field definition template, picklist and stage rules, and the report catalog entry format.", "tags": ["governance", "fields", "stages", "picklists", "report-catalog", "crm"], "updated": "2026-11-04" }
---

# Field and stage governance

A CRM decays when fields are added for one-off needs and never removed. Governance keeps the data model small, documented and meaningful.

## Before adding a field

Ask, in order:

1. Does an existing field already capture this? (Search the data dictionary.)
2. Who will use it, in which report or decision?
3. Who fills it, when, and how will we keep it accurate?
4. Is it a fact about the record (a field) or an event (an activity or a related record)?

If there's no named user and decision, don't add it.

## Naming conventions

- Labels in plain words users understand: "Next step date", not "NSD".
- One concept, one field. No "Amount 2" or "Close Date (new)".
- API names consistent and descriptive, with a prefix for integration-owned fields if the company uses one (e.g. `billing_`), so people know not to edit them.
- Help text on every custom field: what it means and when to fill it.

## Data dictionary entry

```
Object / field label / API name
Definition: what it means, in one sentence
Type: text, number, currency, date, picklist, lookup
Allowed values: picklist values or valid range
Required when: stage, record type or condition
Filled by: user role, automation or integration (which)
Used in: reports, dashboards, automations, integrations
Owner: the person who decides changes
Created / last reviewed: dates
```

## Picklist rules

- Keep values mutually exclusive and few; include "Other" only with a required free-text explanation.
- Deactivate old values rather than deleting them, so history keeps its meaning; map them to new values if needed.
- Changing a value's label changes historical reports' meaning. Treat it as a medium-risk change.

## Stage definitions

Stages are owned by the sales leadership; you configure them. For each stage, document:

```
Stage name / order / default probability (if used)
Meaning: what is true about the buyer
Exit criteria: what must be true to move on
Required fields at this stage
Automations triggered on entry
```

Changing stages affects forecasts, conversion analysis and every report on stage history. Plan stage changes at a period boundary with the Revenue Analyst, and record a mapping from old to new.

## Deprecating fields

1. Confirm no report, automation or integration uses it (dependency check).
2. Mark the label "[Deprecated]" and remove it from layouts.
3. Wait one full reporting cycle for complaints.
4. Export the data (backup), then delete if the company's policy allows.
5. Update the data dictionary and change log.

## Report catalog entry

Every standard report or dashboard in the catalog has:

```
Name / link / owner
Question it answers: one sentence
Definitions used: link to the metric definitions
Filters: population, date range, exclusions
Audience and cadence: who uses it, when (e.g. weekly forecast call)
Last validated: date and against what (e.g. reconciled with finance bookings)
Status: active / under review / retired
```

When someone asks for a new report, check the catalog first; often an existing report with a filter answers the question. If a new one is needed, add it to the catalog the day it's built.

## Quarterly review

- Fields with low fill rates or no recent use → candidates to deprecate
- Reports not opened recently → retire or confirm
- Picklists with heavy "Other" use → add or clarify values
- Automations without owners → assign or turn off
