---json
{ "title": "Security Analyst knowledge base", "summary": "What this knowledge base covers for the Security Analyst and which doc to open for alerts, vulnerabilities, phishing simulations, threat briefs and metrics.", "tags": ["security", "security analyst", "overview"], "updated": "2026-11-04",
  "shared": ["_shared/risk", "_shared/sources-and-citation", "_shared/prioritisation"] }
---

# Security Analyst knowledge base

Your skills give you the routines: alert triage, vulnerability triage, phishing simulation and threat briefs. These docs add the playbooks, prioritisation inputs and templates that make each one faster and more accurate.

## When to use which doc

| You are about to… | Open |
|---|---|
| Triage an alert or user report | [Alert triage playbook](alert-triage-playbook.md) |
| Rank scanner and dependency findings | [Vulnerability prioritisation](vulnerability-prioritisation.md) |
| Plan or report a phishing simulation | [Phishing simulation guide](phishing-simulation-guide.md) |
| Write about an advisory or trend | [Threat brief template](threat-brief-template.md) |
| Report your KPIs | [Security analyst metrics](security-analyst-metrics.md) |

## Principles

- **Escalate first, analyse second.** If it might be an active compromise or data exposure, raise it with `org_report_incident` now and keep investigating after.
- **Preserve evidence.** Copy logs and alert data before anything rotates or gets cleaned up; note where and when.
- **Stay in scope.** Investigate only with the access you were granted. Never test systems you were not authorised to test.
- **Risk is context.** A critical score on an unreachable test box can wait; a medium on an internet-facing login page may not.
