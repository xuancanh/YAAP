---json
{ "title": "Privacy basics", "summary": "A high-level, sourced primer on GDPR lawful bases, processor contracts (DPAs), data subject request deadlines and breach notification, plus a CCPA comparison point.", "tags": ["privacy", "gdpr", "ccpa", "dpa", "data-subject-requests", "breach"], "updated": "2026-11-04",
  "sources": [{ "title": "GDPR Art. 6: Lawfulness of processing", "url": "https://gdpr-info.eu/art-6-gdpr/", "accessed": "2026-11-04" },
              { "title": "GDPR Art. 12: Transparent information, communication and modalities", "url": "https://gdpr-info.eu/art-12-gdpr/", "accessed": "2026-11-04" },
              { "title": "GDPR Art. 28: Processor", "url": "https://gdpr-info.eu/art-28-gdpr/", "accessed": "2026-11-04" },
              { "title": "GDPR Art. 33: Notification of a personal data breach to the supervisory authority", "url": "https://gdpr-info.eu/art-33-gdpr/", "accessed": "2026-11-04" },
              { "title": "California Consumer Privacy Act (CCPA)", "url": "https://oag.ca.gov/privacy/ccpa", "publisher": "State of California Department of Justice", "accessed": "2026-11-04" }] }
---

# Privacy basics

This is a map, not legal advice. Privacy law depends on where the company is established, where its users are and what it does with data, and it changes. Use this doc to spot the issue, get the clock right and route the matter. The Privacy & Compliance Officer owns the detail, and a qualified lawyer signs off on positions. Always cite the article or section you rely on, and check the current text.

## GDPR lawful bases (Art. 6(1))

Under the EU GDPR, processing personal data is lawful only if at least one of six bases applies:

1. **Consent** to processing for one or more specific purposes.
2. **Contract:** needed to perform a contract with the person, or to take steps at their request before entering one.
3. **Legal obligation** the controller is subject to.
4. **Vital interests:** protecting someone's life.
5. **Public task:** a task in the public interest or under official authority.
6. **Legitimate interests** of the controller or a third party, unless overridden by the person's interests, rights and freedoms (especially a child's).

Pick and record the basis per purpose before processing starts, in the record of processing. Switching bases later is hard to justify. Special categories of data (health, for example) need more than an Art. 6 basis. Route those to counsel.

## Controllers, processors and DPAs (Art. 28)

When a vendor processes personal data on the company's behalf, the company is usually the controller and the vendor the processor. Art. 28(3) requires a contract (the DPA) that sets out the subject matter, duration, nature and purpose of processing, the types of data and data subjects, and requires the processor to:

- [ ] act only on the controller's documented instructions (including on international transfers);
- [ ] ensure the people processing are bound by confidentiality;
- [ ] apply the security measures of Art. 32;
- [ ] follow the agreed conditions for using sub-processors;
- [ ] help the controller answer data subject requests and meet its Art. 32-36 duties (security, breach notification, impact assessments);
- [ ] delete or return the data at the end of the service;
- [ ] provide the information needed to show compliance, and allow audits;
- [ ] tell the controller straight away if an instruction seems to infringe data protection law.

Use this list as the DPA review checklist. International transfers outside the EEA need their own mechanism, and that's counsel's call.

## Data subject requests: the clock

- **GDPR (Art. 12(3)):** respond to requests under Arts. 15-22 (access, rectification, erasure, restriction, portability, objection) without undue delay and **within one month of receipt**. This can be extended by **two further months** for complex or numerous requests, but the person must be told about the extension and the reasons within the first month.
- **CCPA (California):** per the California Attorney General, businesses have **45 calendar days** to respond to a request to know or delete, extendable once by **45 more days** with notice to the consumer.

Log every request the day it arrives (the clock starts on receipt, not when legal sees it), verify identity proportionately, and diarise the deadline in the regulatory calendar.

```markdown
| DSR id | Received | Jurisdiction | Type | Identity verified | Due | Extended to (reason, notified on) | Owner | Closed |
|---|---|---|---|---|---|---|---|---|
```

## Personal data breaches (Art. 33)

Under GDPR the controller notifies the supervisory authority without undue delay and, where feasible, **no later than 72 hours after becoming aware** of a breach, unless it's unlikely to result in a risk to people. A late notification must explain the delay. Separate rules can require telling the affected people. Processors must tell the controller without undue delay. Other jurisdictions have their own deadlines.

On any suspected breach: org_report_incident, escalate the same day, preserve evidence, and let the humans and counsel decide on notification. Don't draft public statements without them.

## Common pitfalls

- **Starting the clock late.** It starts when the company receives the request or becomes aware of the breach, not when legal is told.
- **Assuming GDPR is the only law.** UK GDPR, US state laws and sector rules each have their own terms and deadlines.
- **Consent as the default basis.** It must be freely given and can be withdrawn. Another basis may fit better.
- **No DPA with a vendor** that handles customer or employee data.
- **Quoting a number from memory.** Cite the article and check the current text.
