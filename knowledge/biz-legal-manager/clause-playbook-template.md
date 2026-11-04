---json
{ "title": "Clause playbook template", "summary": "The structure for /org/legal/playbook.md: per clause a standard position, ordered fallbacks, a walk-away point and the approver for each level, with a worked entry.", "tags": ["contracts", "playbook", "template", "negotiation"], "updated": "2026-11-04" }
---

# Clause playbook template

A clause playbook lets the Contracts Specialist turn standard deals quickly and consistently, and makes every deviation visible. Its positions come from the company: risk appetite from the profile, liability levels from finance and insurance, security terms from IT & Security, and payment terms from sales and finance. You draft, and human counsel approves the playbook and each version of it. Positions here are placeholders, not recommendations.

## Structure per clause

```markdown
## <Clause name>
Why it matters: <one line in business terms>
Owner consulted: <function(s)>

| Level | Position | Approver |
|---|---|---|
| Standard | <our template wording / position> | none (Contracts Specialist applies) |
| Fallback 1 | <first concession> | Contracts Specialist |
| Fallback 2 | <second concession> | General Counsel |
| Walk-away | <beyond this we don't sign without a CEO decision> | CEO (via org_escalate) |

Never accept: <positions outside any fallback, e.g. unlimited liability for all claims>
Notes: <interpretation tips, typical counterparty asks, linked clauses>
Last changed: <date>, <why>, <decision link in /org/legal/decisions.md>
```

## Clauses to cover first

Limitation of liability, indemnities, warranties, IP ownership and licences, confidentiality, data protection and security, term, renewal and termination, payment terms, governing law and disputes, assignment and change of control. The [contract review checklist](./contract-review-checklist.md) lists what to check in each.

## Worked entry (made-up positions)

```markdown
## Auto-renewal and notice
Why it matters: missed notice windows lock us into another term we may not want.
Owner consulted: Finance, Sales

| Level | Position | Approver |
|---|---|---|
| Standard | No auto-renewal on contracts we buy; on contracts we sell, 12-month renewals with 30 days' notice | none |
| Fallback 1 | Auto-renewal for 12 months with at least 60 days' notice | Contracts Specialist |
| Fallback 2 | Auto-renewal for up to 24 months with at least 90 days' notice and a price-increase cap | General Counsel |
| Walk-away | Renewal terms longer than 24 months, or notice longer than 90 days | CEO |

Never accept: renewal with no right to stop it.
Notes: always record the notice date in /org/legal/obligations.md on signature. Check local consumer auto-renewal rules before selling to consumers; they differ by jurisdiction.
Last changed: <date>, initial version.
```

## Keeping it current

- **Quarterly:** count which clauses were negotiated and which fallbacks were used (from the matter log). A fallback used in a large share of deals is a candidate to become standard, and the company sets that share (the legal-playbook-governance skill uses one third by default). A deviation that keeps recurring needs a written position.
- **On a change in law or business:** a new product line, new markets, new privacy rules or a change in insurance cover. Update with the reason and date.
- **Version it:** every change gets a line in `/org/legal/decisions.md` (what, why, approved by whom, effective date).

## Checks

- [ ] Every level names an approver, and the approvers match the company's delegation of authority.
- [ ] Numbers (caps, notice periods, payment days) come from the owning function or a named person, never from the drafter.
- [ ] Linked clauses agree with each other (an indemnity exclusion matches the liability cap's carve-outs).
- [ ] A qualified human lawyer approved this version.

## Common pitfalls

- **Positions without reasons.** Without the "why", reviewers can't judge an unusual ask.
- **Only one fallback.** The specialist then escalates everything and turnaround suffers.
- **Approvers above the people who actually decide.** It slows deals and gets bypassed.
- **A playbook nobody uses.** Turn the review steps into a company playbook (org_write_playbook) and audit against it monthly.
