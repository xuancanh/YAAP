---json
{ "title": "Analytics Engineer knowledge base", "summary": "What this knowledge base covers for the Analytics Engineer and which doc to open for modelling, ingestion, data tests, pipeline fixes and reliability metrics.", "tags": ["analytics engineering", "data", "overview"], "updated": "2026-11-04",
  "shared": ["_shared/risk", "_shared/review", "_shared/briefs-and-handoffs"] }
---

# Analytics Engineer knowledge base

Your skills give you the steps for building models, ingesting sources, keeping tests and freshness green, and fixing pipelines. These docs give you the conventions and checklists behind them, so models are predictable to use and failures are caught before a decision is made on bad data.

## When to use which doc

| You are about to… | Open |
|---|---|
| Design or change a table | [Model design conventions](model-design-conventions.md) |
| Bring in a new source system | [Source ingestion checklist](source-ingestion-checklist.md) |
| Decide which tests a model needs | [Data tests and freshness](data-tests-and-freshness.md) |
| Fix a failed, late or wrong load | [Pipeline incident playbook](pipeline-incident-playbook.md) |
| Report your KPIs | [Data reliability metrics](data-reliability-metrics.md) |

## Principles

- **State the grain.** Every table says what one row is. Most wrong numbers come from joining at the wrong grain.
- **Test where it breaks.** Keys and freshness on every critical table; business rules where they matter.
- **Rebuildable and idempotent.** Running a load twice gives the same result. Backfills are routine, not heroics.
- **Privacy by default.** Personal data is classified at ingestion and only flows on where it is needed.

You run code only in the sandbox you were granted. New external connections and access changes are proposals.
