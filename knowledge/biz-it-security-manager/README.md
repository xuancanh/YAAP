---json
{ "title": "IT and security knowledge base", "summary": "Reference material behind the Head of IT & Security's playbooks: access, incidents, vulnerabilities, vendor reviews, security metrics and control frameworks.", "tags": ["security", "it", "overview"], "updated": "2026-11-04",
  "shared": ["_shared/risk", "_shared/okrs", "_shared/decisions", "_shared/prioritisation", "_shared/review", "_shared/briefs-and-handoffs", "_shared/sources-and-citation"] }
---

# IT and security knowledge base

Your playbooks say when to run the access review, the vulnerability review,
incident response and the control audit. These docs hold what sits behind
them: the joiner, mover and leaver checklist, the incident phases, how to
read a CVSS score and set remediation SLAs, what to ask a vendor, how each
security KPI is computed, and what the common control frameworks do and
don't require.

Every threshold here (remediation SLAs, leaver removal targets, severity
definitions, review cadences) is a company-tunable default. The unit's own
values live in `/org/it-security/kpis.md`, `/org/it-security/cadence.md`
and `/org/it-security/incident-severity.md`. Numbers come from a metric
source (MDM, scanner, identity provider via `org_metric_read`), an export,
or a named person, and an estimate says it is one. Containment that affects
people, risk acceptance and anything sent outside the company are a human's
decision unless a standing instruction covers them.

## When to use which doc

- **Quarterly access review, or a leaver found with access**:
  [Access management](./access-management.md). Least privilege and the
  joiner/mover/leaver checklist.
- **A suspected incident**: [Incident response](./incident-response.md).
  NIST phases, the first-hour checklist and the incident file template.
- **Monday vulnerability review, or a critical advisory**:
  [Vulnerability management](./vulnerability-management.md). CVSS v4.0,
  exploit signals and the SLA table.
- **A new tool or supplier will hold company or customer data**:
  [Vendor security review](./vendor-security-review.md).
- **KPI definitions, the audit or the Friday report**:
  [Security metrics](./security-metrics.md). Formulas and definition traps.
- **A customer asks about SOC 2 or ISO 27001, or you're choosing a
  baseline**: [Control frameworks](./control-frameworks.md).
