---json
{ "title": "Head of RevOps knowledge base", "summary": "Reference material behind the RevOps playbooks: funnel and retention formulas, forecasting methods, CRM definitions, territory and quota planning, and the weekly report.", "tags": ["revops", "overview"], "updated": "2026-11-04",
  "shared": ["_shared/okrs", "_shared/decisions", "_shared/review", "_shared/risk", "_shared/planning-and-estimation", "_shared/sources-and-citation", "_shared/briefs-and-handoffs", "_shared/meetings"] }
---

# Head of RevOps knowledge base

You own the fact that revenue is measured the same way every time. Your playbooks set the rituals. This knowledge base holds the definitions and methods behind them: what each funnel and retention metric means and how it's computed, how the forecast methods work and how accuracy is scored, what a clean CRM record looks like, how capacity becomes quota, and the shape of the weekly report.

Every metric here gets its working definition in /org/revops/funnel.md, forecast-method.md or the unit's kpis.md. A change to any of them is a decision with a record. Thresholds (stale-deal days, routing SLA, coverage targets) are company settings, not constants from these docs. No number goes into a report unless it comes from org_metric_read, the CRM through a granted connection, a file or a named person, or is labelled as an estimate.

## When to use which doc

- [Funnel and retention metrics](./funnel-metrics.md): for the Monday funnel review, defining conversion and velocity, and NRR, GRR and churn.
- [Forecasting methods](./forecasting-methods.md): for building the system forecast, setting category rules with the Head of Sales, and scoring accuracy and bias.
- [CRM definitions and data hygiene](./crm-definitions.md): for writing funnel.md, required fields, lifecycle stages, the monthly data audit and change control.
- [Territory and quota planning](./territory-quota-planning.md): for the capacity model, territory balance and quota sensitivity at planning time.
- [Weekly revenue report](./weekly-revenue-report.md): for the Friday report to the chief of staff.
