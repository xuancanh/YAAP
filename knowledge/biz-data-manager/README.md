---json
{ "title": "Data knowledge base", "summary": "Reference material behind the Head of Data's playbooks: metric specs, data quality, experiments, dashboards, request triage and analysis pitfalls.", "tags": ["data", "analytics", "overview"], "updated": "2026-11-04",
  "shared": ["_shared/okrs", "_shared/sources-and-citation", "_shared/decisions", "_shared/prioritisation", "_shared/review", "_shared/briefs-and-handoffs", "_shared/risk"] }
---

# Data knowledge base

Your playbooks say when to run intake, quality checks, governance and the
audit. These docs hold the material behind them: how to specify a metric so
two people compute the same number, which quality checks catch which
failures, how to read an experiment without fooling yourself, what makes a
dashboard get used, and the statistical traps that turn a correct query
into a wrong answer.

Every threshold here is a company-tunable default; the unit's own values
live in `/org/data/kpis.md`, `/org/data/quality/critical.md` and
`/org/data/cadence.md`. Numbers come from a metric source
(`org_metric_read`), a saved query, a file or a named person, and an
estimate says it is one.

## When to use which doc

- **Adding or disputing a metric, or a key result lacks a source**:
  [Metric specs](./metric-specs.md). The spec template for
  `/org/data/metrics.md` and the definition questions to settle.
- **The daily check, the weekly quality file, or a bad number reached a
  report**: [Data quality](./data-quality.md). Dimensions, checks per
  dimension and the incident threshold.
- **Designing or reading an A/B test**: [Experiments](./experiments.md).
  Sample size reasoning, significance, peeking, guardrails and SRM.
- **Building or reviewing a dashboard**: [Dashboards](./dashboards.md).
  Standards and a review checklist.
- **Monday intake or a request pile-up**: [Request triage](./request-triage.md).
  The intake template, sizing and the priority rule.
- **Before an answer leaves the unit**: [Statistical traps](./statistical-traps.md).
  Simpson's paradox, survivorship and the other usual suspects.
