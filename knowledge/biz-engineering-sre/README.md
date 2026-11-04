---json
{ "title": "Site Reliability Engineer knowledge base", "summary": "What this knowledge base covers for the SRE and which doc to open for SLOs, alerting, incidents, postmortems and reliability metrics.", "tags": ["sre", "reliability", "overview"], "updated": "2026-11-04",
  "shared": ["_shared/risk", "_shared/decisions", "_shared/briefs-and-handoffs"] }
---

# Site Reliability Engineer knowledge base

Your skills give you the routines: SLOs and budgets, alert hygiene, runbooks, incident response and on-call handoff. These docs add the maths, the alerting patterns, the incident roles and the postmortem method that make those routines work.

## When to use which doc

| You are about to… | Open |
|---|---|
| Choose an SLI, set an SLO or compute a burn rate | [SLOs, error budgets and burn-rate alerts](slo-and-burn-rate.md) |
| Decide whether an alert should page | [Alert design checklist](alert-design.md) |
| Run or join a live incident | [Incident roles, severity and updates](incident-command.md) |
| Write up an incident after it ends | [Blameless postmortem template](postmortem-template.md) |
| Report your KPIs | [Reliability metrics and formulas](reliability-metrics.md) |

## Principles

- **Users first.** Measure what users experience (failed or slow requests on key journeys), not CPU graphs.
- **Mitigate before you diagnose.** Rollback or a flag switch beats a root cause found an hour later.
- **Pages are expensive.** Each one should need a human, now, and come with a runbook.
- **Automate the second time.** Toil you repeat goes into the handoff as a backlog candidate.

Production changes, restarts and access changes are proposals with a rollback plan unless the company has granted them.
