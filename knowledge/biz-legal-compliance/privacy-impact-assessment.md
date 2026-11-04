---json
{ "title": "Privacy impact assessment method", "summary": "When a privacy impact assessment is needed, the minimum contents, a likelihood-severity scoring method, mitigations that work and when to escalate.", "tags": ["pia", "dpia", "gdpr", "article-35", "risk"], "updated": "2026-11-04",
  "sources": [
    { "title": "GDPR Article 35, Data protection impact assessment (gdpr-info.eu), accessed 2026-11-04", "url": "https://gdpr-info.eu/art-35-gdpr/" },
    { "title": "GDPR Article 36, Prior consultation (gdpr-info.eu), accessed 2026-11-04", "url": "https://gdpr-info.eu/art-36-gdpr/" }
  ] }
---

# Privacy impact assessment method

An assessment is worth doing when it changes the design. Run it early, while the team can still choose to collect less, keep it shorter or restrict access.

## When it's required

GDPR Article 35(1) requires a data protection impact assessment before processing that's likely to result in a high risk to people's rights and freedoms, especially with new technologies. Article 35(3) names three cases that always need one:

- systematic and extensive evaluation of people based on automated processing, including profiling, where decisions have legal or similarly significant effects;
- large-scale processing of special category data or criminal offence data;
- systematic monitoring of a publicly accessible area on a large scale.

Supervisory authorities publish their own lists of processing that needs an assessment; check the lists for the countries where the company operates.

**Screening questions** (any "yes" means do a full assessment, or record why not):
- Does it make or support decisions about people (hiring, credit, pricing, access)?
- Does it use special category data (health, ethnicity, religion, sexual orientation, biometrics) or data about children?
- Does it combine data sets in ways people wouldn't expect?
- Does it monitor people (employees, users, a location)?
- Does it use a new technology, including AI models trained or prompted with personal data?
- Is it large in scale, or does it transfer data outside the region?

## Minimum contents

Article 35(7) requires at least: a systematic description of the processing and its purposes; an assessment of necessity and proportionality; an assessment of risks to people; and the measures to address them. Use this structure:

1. **Description.** What data, whose, purpose, systems, vendors, retention, who has access, data flow from collection to deletion.
2. **Necessity and proportionality.** Is each data item needed for the purpose? Could it work with less, with pseudonymised or aggregated data, or for a shorter time? What lawful basis applies?
3. **Risks to people.** Not risks to the company. Think: unauthorised access, data used for something unexpected, inaccurate data leading to a wrong decision, discrimination, loss of control over their data, chilling effect of monitoring.
4. **Measures and residual risk.** For each risk, the mitigation and what's left after it.
5. **Sign-off.** Who reviewed, the decision, and the review date.

## Scoring risk

Score each risk before and after mitigation, on the company's risk scale if it has one. If not, use three levels for each:

| | Low | Medium | High |
|---|---|---|---|
| **Likelihood** | Would need several things to go wrong | Plausible | Expected unless prevented |
| **Severity** | Minor inconvenience, easily reversed | Significant distress or cost, reversible with effort | Serious, lasting or irreversible harm |

High likelihood or high severity, after mitigation, means high residual risk. Severity is about the individual's experience, so think from their side.

## Mitigations that change the risk

- **Collect less.** Drop fields that aren't needed. The strongest control.
- **Keep it shorter.** A retention period with automatic deletion.
- **Restrict access.** Role-based access, logging, regular review.
- **Separate identifiers.** Pseudonymise for analytics; keep the key elsewhere.
- **Tell people.** A clear notice at collection; no surprises.
- **Give control.** Easy opt-out or objection, human review of automated decisions.
- **Contract terms.** Vendor obligations, no secondary use, sub-processor limits.
- **Test.** Check accuracy and bias of any model or automated decision before launch.

"We'll be careful" is not a mitigation. Each one should be a specific control with an owner.

## Escalation

Under Article 36, where the assessment shows high risk that the controller can't sufficiently reduce, the controller must consult the supervisory authority before processing. High residual risk always goes to the General Counsel, who decides on redesign, outside advice or consultation. Don't advise launching with high residual risk.

## Pitfalls

- Doing the assessment after launch, as paperwork.
- Assessing the vendor's security and calling it a privacy assessment. Security is one risk among several.
- Copying a previous assessment without checking what changed.
- Forgetting the review date. Processing drifts; reassess when purpose, data or scale changes.
