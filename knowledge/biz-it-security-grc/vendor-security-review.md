---json
{ "title": "Vendor security review", "summary": "How to tier vendors by risk, what to request and check at each tier, how to read a SOC 2 report, and the formula for vendor reviews current.", "tags": ["vendor management", "third-party risk", "soc 2 report", "due diligence", "kpi"], "updated": "2026-11-04",
  "sources": [{ "title": "AICPA, 2017 Trust Services Criteria (With Revised Points of Focus – 2022)", "url": "https://www.aicpa-cima.com/resources/download/2017-trust-services-criteria-with-revised-points-of-focus-2022" }] }
---

# Vendor security review

A vendor that holds your data extends your attack surface. The review is proportionate: the more sensitive the data and the deeper the access, the more you check.

## Tier the vendor first

| Tier | Typical profile | Review depth |
|---|---|---|
| **High** | Holds customer or personal data at scale, has production or admin access, or is critical to the service | Full review; annual re-review |
| **Medium** | Holds internal or limited personal data; important but replaceable | Standard review; re-review at renewal or on a set interval |
| **Low** | No company data, or public data only | Basic check; re-review if usage changes |

Ask Procurement and the requester: what data, how much, whose, what access (SSO, API, admin), and what happens to the service if the vendor goes down?

## What to request and check

**All tiers**
- [ ] What data the vendor will hold or access, and where it is stored.
- [ ] Supports SSO and MFA for our users, or at least MFA.
- [ ] Public security page or trust centre exists.
- [ ] Any public reports of serious breaches, and how they were handled.

**Medium and high**
- [ ] An independent assurance report: SOC 2 Type II report, or ISO/IEC 27001 certificate with its scope and Statement of Applicability. A short security questionnaire if neither exists.
- [ ] Encryption in transit and at rest.
- [ ] Sub-processors list.
- [ ] Incident notification commitment in the contract.
- [ ] Data deletion and return at contract end.
- [ ] Data processing terms where personal data is involved. Privacy requirements vary by jurisdiction; Legal reviews these.

**High only**
- [ ] Penetration test summary or attestation from the last year.
- [ ] Business continuity and backup approach, with recovery targets.
- [ ] Access controls for vendor staff who can reach our data.
- [ ] Right to audit or obtain updated reports.

## Reading a SOC 2 report

Don't stop at the cover page. Check:

1. **Type.** Type II covers operating effectiveness over a period; Type I covers design at a point in time only.
2. **Period.** When does it end? If it ended a while ago, ask for a bridge letter (the vendor's statement covering the gap) and the date of the next report.
3. **Scope.** Is the product you are buying in scope, and which Trust Services categories are covered (Security is always included; Availability, Processing Integrity, Confidentiality and Privacy are optional)?
4. **Opinion.** Unqualified (clean) or qualified? A qualified opinion means the auditor found material issues.
5. **Exceptions.** Read the test results for exceptions, and the vendor's responses. Do they touch controls you rely on?
6. **Complementary user entity controls (CUECs).** Controls the vendor expects *you* to perform (for example, managing your own users and MFA). Add the relevant ones to our controls matrix.
7. **Sub-service organisations.** Carved-out providers (such as their cloud host); their assurance is separate.

For an ISO 27001 certificate, check the certification body, validity dates and whether the scope covers the service you use.

## Writing up

```markdown
# Vendor review: <vendor> — <date>
Tier: <H/M/L>   Data: <types>   Access: <type>   Requester: <team>
Evidence reviewed: <report, period; certificate; questionnaire>
Findings:
| Finding | Risk | Mitigation (vendor or ours) |
CUECs adopted: <list>
Recommendation: <approve | approve with conditions | do not approve>
Conditions: <MFA enforced, data minimised, contract clause>
Next review: <date>
```

Open findings that remain after approval go on the [risk register](risk-register-method.md) with an owner.

## KPI: vendor reviews current

```
vendor reviews current = active medium- and high-tier vendors whose
                         last review is within its re-review interval
                         / active medium- and high-tier vendors
```

Rules:

- The vendor list comes from the asset inventory and Procurement's contracts, reconciled; a vendor missing from both is a gap to find, not one to ignore.
- A review is current only if completed (recommendation recorded), not just started.
- Report overdue vendors by name with their tier and renewal date. A high-tier vendor overdue at renewal is the first to chase.
