---json
{ "title": "Control frameworks: SOC 2, ISO 27001, CIS Controls", "summary": "What SOC 2, ISO/IEC 27001 and the CIS Controls each are, how they differ, and how to talk about them without overclaiming.", "tags": ["security", "compliance", "soc2", "iso27001", "cis-controls", "grc"], "updated": "2026-11-04",
  "sources": [
    { "title": "2017 Trust Services Criteria (with revised points of focus, 2022)", "url": "https://www.aicpa.org/resources/download/2017-trust-services-criteria-with-revised-points-of-focus-2022", "publisher": "AICPA", "date": "2022-09", "accessed": "2026-11-04", "note": "2022 revision changed points of focus only, not the criteria." },
    { "title": "ISO/IEC 27001:2022 Information security management systems — Requirements", "url": "https://www.iso.org/standard/27001", "publisher": "ISO/IEC", "date": "2022-10", "accessed": "2026-11-04" },
    { "title": "CIS Controls v8.1", "url": "https://www.cisecurity.org/controls/v8-1", "publisher": "Center for Internet Security", "accessed": "2026-11-04" },
    { "title": "CIS releases CIS Controls v8.1 with new governance recommendations", "url": "https://www.cisecurity.org/about-us/media/press-release/center-for-internet-security-releases-cis-controls-v8-1-with-new-governance-recommendations", "publisher": "Center for Internet Security", "date": "2024-06-25", "accessed": "2026-11-04" }
  ] }
---

# Control frameworks: SOC 2, ISO 27001, CIS Controls

Customers ask "are you SOC 2?", the strategy memo says "win enterprise",
and the GRC Specialist needs a list of controls to test. These three
frameworks come up most. They do different jobs; knowing which is which
keeps you from building the wrong thing or saying something untrue.

## At a glance

| | SOC 2 | ISO/IEC 27001 | CIS Controls |
|---|---|---|---|
| What it is | An attestation report by an independent CPA firm | A certifiable standard for an information security management system (ISMS) | A prioritised list of technical safeguards |
| Who issues it | AICPA criteria; a CPA firm audits | ISO/IEC; an accredited certification body certifies | Center for Internet Security; self-assessed |
| Output | A report (Type I or Type II) shared under NDA | A certificate with a scope, plus surveillance audits | Your own assessment |
| Best for | Proving controls to US-centred B2B customers | International customers, a management-system approach | Deciding what to implement first |

## SOC 2

Built on the AICPA's **Trust Services Criteria** (2017 criteria; points of
focus revised in 2022, criteria unchanged). Five categories: **Security**
(the common criteria, always in scope), plus optional **Availability**,
**Processing Integrity**, **Confidentiality** and **Privacy**. The company
chooses which optional ones to include, usually driven by what customers
ask.

- **Type I**: are the controls suitably designed, as of a point in time.
- **Type II**: did they also operate effectively over a period (often
  several months to a year; the auditor and company agree the period).

The company designs its own controls to meet the criteria; there is no
fixed control list. Evidence of operation over the period (access reviews
done, changes reviewed, leavers removed on time) is what Type II tests,
which is why your audits keep evidence.

## ISO/IEC 27001

The current edition is **ISO/IEC 27001:2022**. Its main clauses require a
management system: scope, risk assessment and treatment, leadership,
objectives, internal audit, management review and continual improvement.
**Annex A** lists 93 reference controls in four themes: organisational
(37), people (8), physical (14) and technological (34). You choose which
apply based on your risk assessment and justify each choice in a
**Statement of Applicability**. ISO/IEC 27002 gives guidance on each
control. Certification is for a defined scope, with surveillance audits
between recertifications.

## CIS Controls

**CIS Controls v8.1** (June 2024) has 18 controls, each broken into
safeguards, grouped into three **Implementation Groups**. IG1 is the basic
set CIS describes as essential cyber hygiene for every organisation; IG2
and IG3 add to it. v8.1 was an iterative update to v8: it added a Govern
security function aligned with NIST CSF 2.0, revised asset classes and
clarified wording, without changing the Implementation Groups. There is no
certificate; it's a good answer to "what should we do first?", and CIS
publishes mappings to other frameworks.

## Choosing

- **No customer demand yet**: start from CIS IG1 as the baseline; it makes
  a later SOC 2 or ISO 27001 much easier.
- **US enterprise customers asking**: SOC 2, Type I first to get a report
  sooner, then Type II.
- **International or public-sector customers, or a request for a
  certificate**: ISO 27001.
- Committing to an audit means auditor fees, tool costs and months of
  evidence: a decision for the CEO with the cost (estimated, labelled) and
  the deals it unlocks.

Keep one control list in `/org/it-security/controls.md`, each control
mapped to the framework requirements it satisfies, so one test produces
evidence for several frameworks.

## Saying it accurately

What you may say depends on the evidence. Customer-facing statements are
drafts for a human.

| True situation | Accurate | Not accurate |
|---|---|---|
| Controls aligned, no audit | "Our controls are aligned with the CIS Controls" | "We are SOC 2 compliant" |
| Audit under way | "Our SOC 2 Type II audit period runs to <date>" | "We are SOC 2 certified" |
| Type II report issued | "We have a SOC 2 Type II report for <period>; available under NDA" | "SOC 2 certified" (it's an attestation, not a certificate) |
| ISO certificate | "ISO/IEC 27001:2022 certified for <scope>" | Certified, without the scope |

## Common pitfalls

- **Framework before risk.** Implementing controls because a list says so,
  in the wrong order for your actual risk.
- **Policies without evidence.** A written policy nobody follows fails a
  Type II test and an ISO audit.
- **Scope creep in claims.** A certificate for one product says nothing
  about the others.
- **Treating compliance as security.** Passing an audit shows the controls
  operated as described, not that the company can't be breached.
