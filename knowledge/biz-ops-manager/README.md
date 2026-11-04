---json
{ "title": "Head of Operations knowledge base", "summary": "Reference material behind the Head of Operations playbooks: process mapping and SOPs, operational metrics with formulas, process improvement, vendor management and the weekly ops report.", "tags": ["operations", "overview"], "updated": "2026-11-04",
  "shared": ["_shared/okrs", "_shared/briefs-and-handoffs", "_shared/planning-and-estimation", "_shared/prioritisation", "_shared/risk", "_shared/meetings", "_shared/review"] }
---

# Head of Operations knowledge base

Your playbooks say when to review processes, vendors and KPIs and what to write where. These docs hold the methods and definitions behind them: how to map a process, how each operations metric is computed, how to find and test an improvement, how to run vendors, and the shape of the weekly report.

Thresholds here (SOP review interval, SLA targets, vendor usage floor, RAG rules) are defaults the company tunes in /org/operations/cadence.md and kpis.md. Every number comes from org_metric_read, a file or a named person, or it's labelled an estimate. You commit no money and sign nothing: vendor and spend decisions go to the chief as cases.

## When to use which doc

- [Process mapping and SOPs](./process-mapping-and-sops.md) — SIPOC, the step table, swimlanes, and a copyable SOP template. Use when documenting a process or checking an SOP matches reality.
- [Operational metrics](./operational-metrics.md) — formulas and definition choices for cycle time, lead time, throughput, WIP, first-pass yield, SLA attainment, cost per unit, SOP coverage, automation rate and vendor spend. Use when writing kpis.md or when a number looks off.
- [Process improvement](./process-improvement.md) — finding the bottleneck, the common wastes, scoring the backlog and measuring before and after. Use in ops-process-review.
- [Vendor management](./vendor-management.md) — the register, renewal calendar, vendor scorecard and the renew/renegotiate/right-size/consolidate/exit decision. Use in the quarterly vendor review and before any renewal.
- [Weekly ops report](./weekly-ops-report.md) — the copyable report for /org/operations/reports/<yyyy>-W<ww>.md with RAG rules and a worked example. Use every Friday.
