---json
{ "title": "Engineering knowledge base", "summary": "Reference material behind the Head of Engineering's playbooks: delivery metrics, postmortems, debt triage, design docs and sprint capacity.", "tags": ["engineering", "overview"], "updated": "2026-11-04",
  "shared": ["_shared/okrs", "_shared/planning-and-estimation", "_shared/prioritisation", "_shared/risk", "_shared/decisions", "_shared/review", "_shared/briefs-and-handoffs", "_shared/meetings"] }
---

# Engineering knowledge base

Your playbooks say what to do and when. These docs hold what sits behind
them: how each delivery metric is defined and computed, what a good
postmortem looks like, how to decide which technical debt to pay down, how
to write a design doc a reviewer can actually judge, and how to size a
sprint so the commitment means something.

Everything here is a default the company can tune. Thresholds, cadences and
targets live in `/org/engineering/kpis.md` and `/org/engineering/cadence.md`;
when those say something different, they win. Numbers come from a metric
source (`org_metric_read`), a file, or a named person, never from memory,
and an estimate is labelled as one.

## When to use which doc

- **Setting key results, writing kpis.md, the monthly audit or the Friday
  report**: [Delivery metrics](./delivery-metrics.md). The DORA metrics,
  cycle time, say/do, review turnaround and escaped defects, each with a
  formula and the definition choices that cause drift.
- **After an incident**: [Blameless postmortems](./postmortems.md). When one
  is due, the template, and how to get from "what happened" to actions that
  stick.
- **Debt competing with features at planning**:
  [Technical debt triage](./tech-debt-triage.md). A scoring sheet and an
  allowance model.
- **A change too big or risky to brief as a single task**:
  [Design docs](./design-docs.md). The RFC template and what a reviewer
  checks.
- **Sprint planning and the retro's say/do numbers**:
  [Sprint capacity](./sprint-capacity.md). A worked capacity calculation and
  the common ways a commitment goes wrong.
