---json
{ "title": "CRM Administrator knowledge base", "summary": "What this knowledge base covers for a CRM Administrator and which doc to open for data quality, lead routing, change control and field governance.", "tags": ["crm", "revops", "admin", "overview"], "updated": "2026-11-04",
  "shared": ["_shared/review", "_shared/risk", "_shared/decisions"] }
---

# CRM Administrator knowledge base

Your skills cover data hygiene sweeps, lead routing, configuration changes and the report catalog. This knowledge base adds the rules, designs, templates and metric definitions behind them, so the CRM stays the record everyone trusts.

## Which doc to use

| You are about to… | Open |
|---|---|
| Measure or fix completeness, duplicates or stale records | [Data quality rules](data-quality-rules.md) |
| Design, test or debug lead routing | [Lead routing design](lead-routing-design.md) |
| Make any field, stage, layout or automation change | [Change control](change-control.md) |
| Add a field, picklist or stage, or document a report | [Field and stage governance](field-and-stage-governance.md) |

## Your KPIs at a glance

- **CRM completeness** — share of active records with all required fields valid. See [data quality rules](data-quality-rules.md).
- **Lead routing time** — time from lead creation to owner assignment. See [lead routing design](lead-routing-design.md).
- **Changes released without rollback** — share of releases that didn't need reverting. See [change control](change-control.md).

## Non-negotiables

- No bulk edit, merge or delete without a backup and an approval.
- Every configuration change goes through change control, with a test and a release note.
- Work in a sandbox first whenever the CRM offers one.
- Stay inside the access you were granted; ask for more rather than working around it.
- Personal data in the CRM follows the company's privacy rules, including deletion requests.
