---json
{ "title": "Controls matrix guide", "summary": "The columns a controls matrix needs, how to write a testable control, how SOC 2 and ISO 27001 are structured, and how to map one control to both.", "tags": ["controls matrix", "soc 2", "iso 27001", "framework mapping"], "updated": "2026-11-04",
  "sources": [{ "title": "AICPA, 2017 Trust Services Criteria (With Revised Points of Focus – 2022)", "url": "https://www.aicpa-cima.com/resources/download/2017-trust-services-criteria-with-revised-points-of-focus-2022" },
              { "title": "ISO, ISO/IEC 27001:2022 Information security management systems — Requirements", "url": "https://www.iso.org/standard/27001" },
              { "title": "NIST, The NIST Cybersecurity Framework (CSF) 2.0 (CSWP 29, February 2024)", "url": "https://nvlpubs.nist.gov/nistpubs/CSWP/NIST.CSWP.29.pdf" }] }
---

# Controls matrix guide

The controls matrix is the single list of what the company does to manage security risk, who does it, how often, and what proves it. Frameworks are mapped onto it, not the other way round.

## Columns

| Column | Example |
|---|---|
| Control ID | AC-03 |
| Control statement | Access for leavers is removed by the end of their last working day. |
| Owner | IT Administrator |
| Frequency | Per event; reviewed monthly |
| Type | Preventive / detective / corrective; manual / automated |
| Evidence | JML ticket with timestamps; identity provider disable log |
| Evidence schedule | Monthly sample, filed by the 5th |
| Framework mapping | SOC 2 CC6.x; ISO 27001 A.5.18 (access rights) |
| Status | Designed / operating / gap / not applicable |
| Last tested, result | 2026-10, pass |

Check the exact criterion and control numbers against the current published framework or your auditor's mapping before relying on them.

## Writing a testable control

A control statement says **who** does **what**, **when**, and leaves **evidence**.

- Weak: "Access is managed appropriately."
- Strong: "The IT Administrator reviews access to production systems each quarter; the system owner approves removals; the review and removals are recorded in a ticket."

Tests for a good statement:

- Could an auditor pick a sample and check it? If not, it is too vague.
- Is it what the company actually does? If not, rewrite it or record a gap.
- Is the frequency realistic for the owner?

## SOC 2 in brief

SOC 2 is an attestation by an independent CPA firm against the AICPA's Trust Services Criteria. The five categories are **Security, Availability, Processing Integrity, Confidentiality and Privacy**. Security (the "common criteria", numbered CC1 to CC9) is always in scope; the others are chosen for what the service does.

- A **Type I** report covers whether controls are suitably designed at a point in time.
- A **Type II** report also covers whether they operated effectively over a period, so it needs evidence across that period.

SOC 2 criteria are outcomes; the company chooses its own controls to meet them.

## ISO/IEC 27001 in brief

ISO/IEC 27001:2022 specifies an information security management system (ISMS): scope, risk assessment and treatment, leadership, objectives, internal audit, management review and continual improvement (the clauses), plus Annex A, a reference list of controls. In the 2022 edition Annex A has 93 controls in four themes: organisational, people, physical and technological.

Key artefact: the **Statement of Applicability (SoA)**, listing each Annex A control, whether it applies, why, and whether it is implemented. Exclusions need a justification from the risk assessment. Certification is by an accredited certification body.

## Other references

The NIST Cybersecurity Framework 2.0 organises outcomes under six functions: Govern, Identify, Protect, Detect, Respond and Recover. Even if the company does not adopt it, it is a useful checklist for spotting missing areas.

## Mapping one control to many requirements

1. Start from your controls, not from the framework text.
2. For each framework requirement, find the controls that meet it. One requirement may need several controls; one control may satisfy several requirements.
3. A requirement with no control is a **gap**: add a control, or record it on the [risk register](risk-register-method.md) with a plan.
4. A control mapped to nothing may still be valuable; keep it if it addresses a real risk.

## Maintenance

- Quarterly: confirm owners, frequencies and statuses; add controls for new systems and processes.
- After incidents and audits: update controls that failed or were missing.
- When the company adopts a new framework: map it onto existing controls before writing new ones.

## Pitfalls

- Copying a template matrix full of controls the company does not perform. It fails the first test.
- Controls owned by a team instead of a role. Name a role so someone is accountable.
- Status "operating" without a recent test. See [evidence and control testing](evidence-and-control-testing.md).
