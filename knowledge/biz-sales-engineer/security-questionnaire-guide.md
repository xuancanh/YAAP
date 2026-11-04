---json
{ "title": "Security questionnaire guide", "summary": "Common questionnaire formats, how to answer from the approved library, the answer statuses to use and how to keep the library current.", "tags": ["security-questionnaire", "due-diligence", "caiq", "sig", "answer-library"], "updated": "2026-11-04",
  "sources": [{ "title": "Cloud Security Alliance — What is CAIQ? (accessed 2026-11-04)", "url": "https://cloudsecurityalliance.org/blog/2021/09/01/what-is-caiq" },
              { "title": "Cloud Security Alliance — STAR Registry now accepting CAIQ v4 (accessed 2026-11-04)", "url": "https://cloudsecurityalliance.org/articles/cloud-security-alliance-s-star-registry-now-accepting-version-4-of-caiq" }] }
---

# Security questionnaire guide

A security questionnaire is a promise in writing. Every answer may end up in the contract. Answer fast from approved material, and never guess.

## Formats you will meet

- **Buyer's own spreadsheet or portal**: the most common. Questions vary but cluster around the same topics.
- **CAIQ** (Consensus Assessments Initiative Questionnaire) from the Cloud Security Alliance: a yes/no-style questionnaire that is the question form of CSA's Cloud Controls Matrix. Providers can publish a completed CAIQ in CSA's public STAR Registry as a self-assessment.
- **SIG** (Standardized Information Gathering) questionnaire from Shared Assessments: a broader third-party risk questionnaire, usually exchanged privately between buyer and vendor.
- **Requests for evidence**: SOC 2 report, ISO/IEC 27001 certificate, penetration test summary, policies. These are shared only under the company's rules (often with an NDA).

If the company has published a completed standard questionnaire or a trust page, offer it first; many buyers accept it and skip their own.

## Typical topic areas

Access control and authentication, encryption in transit and at rest, data location and retention, subprocessors, incident response and breach notification, business continuity and backups, vulnerability management and penetration testing, secure development, employee security (background checks, training), physical security of data centres (usually inherited from the cloud provider), privacy and data subject rights, certifications and audits.

## Answer statuses

Give every answer one of these, internally, before it goes out:

| Status | Meaning |
|---|---|
| **Library** | taken unchanged from an approved, current library answer |
| **Adapted** | library answer reworded for this question; meaning unchanged |
| **New — needs approval** | no library answer; drafted from documentation; must be reviewed by the security owner |
| **Gap** | we don't do this; state it plainly, with a compensating control only if one really exists |
| **Not applicable** | with a one-line reason |

Send nothing in "new" status without approval.

## Method

1. **Triage** the questionnaire: count questions, map them to topics, note the deadline and any that need evidence documents.
2. **Fill from the library** first; mark each answer's status.
3. **Draft new answers** from current policies and documentation, and route them to the security owner.
4. **Write gaps honestly**: "We do not currently support customer-managed encryption keys." Add roadmap status only if product confirmed it in writing.
5. **Review** the whole response for consistency: the same question asked twice must get the same answer.
6. **Return** through the AE with a summary of gaps, so the deal team is not surprised.
7. **Update the library** with every newly approved answer.

## Writing good answers

- Answer the question asked, first. "Yes. All customer data is encrypted at rest using …" then the detail.
- Be precise about scope: which products, which plans, which regions.
- Don't overclaim: "aligned with" a framework is not "certified to" it; a report covering one product does not cover another.
- Keep answers short; link to a document for depth.
- Avoid absolute words ("never", "guaranteed") unless they are literally true.

## Keeping the library current

- Each answer has an owner and a last-reviewed date.
- Review the whole library after any audit, new certification, policy change or major infrastructure change.
- Retire answers that reference old tools or reports.

## Pitfalls

- **Copying last time's answers** from a past questionnaire without checking they're still true.
- **Answering for the cloud provider.** You can cite inherited controls, but say they are the provider's.
- **Sending evidence documents** without the required agreement.
