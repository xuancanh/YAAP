---json
{ "title": "Records of processing guide", "summary": "The fields a record of processing activities needs, how to find activities nobody listed, how to record lawful basis and retention, and the vendor contract check.", "tags": ["ropa", "gdpr", "article-30", "lawful-basis", "vendors"], "updated": "2026-11-04",
  "sources": [
    { "title": "GDPR Article 30, Records of processing activities (gdpr-info.eu), accessed 2026-11-04", "url": "https://gdpr-info.eu/art-30-gdpr/" },
    { "title": "GDPR Article 6, Lawfulness of processing (gdpr-info.eu), accessed 2026-11-04", "url": "https://gdpr-info.eu/art-6-gdpr/" },
    { "title": "GDPR Article 28, Processor (gdpr-info.eu), accessed 2026-11-04", "url": "https://gdpr-info.eu/art-28-gdpr/" }
  ] }
---

# Records of processing guide

The record of processing activities (often "RoPA") is the map every other privacy task depends on. If a request, an assessment or a breach response needs to know where data lives, the answer should be here.

## What GDPR requires

Under GDPR Article 30(1), a controller's record includes: its identity and contact details (and any joint controller, representative and data protection officer); the purposes; the categories of people and of personal data; the categories of recipients, including in third countries; transfers to third countries and their safeguards where applicable; where possible, erasure time limits for each category; and where possible, a general description of security measures.

Article 30(5) gives organisations with fewer than 250 people a partial exemption, but not where the processing is likely to risk people's rights, isn't occasional, or includes special category or criminal offence data. Ongoing processing such as payroll or customer accounts is not occasional, so most companies keep a record anyway. It's also the only practical way to answer requests on time.

## One row per activity

An activity is a purpose, not a system. "Payroll" is an activity; the payroll tool is where it happens.

| Field | What to write |
|---|---|
| Activity | e.g. "Customer support tickets" |
| Purpose | Why we do it, in one sentence |
| Owner | The function and role accountable |
| People | Categories: customers, employees, candidates, website visitors |
| Data | Categories: contact, account, payment, usage, support content; flag special category data |
| Lawful basis | One of the six in Article 6(1), with a note on why (below) |
| Systems | Where the data is stored and processed |
| Recipients | Vendors (processors), other controllers, authorities |
| Transfers | Countries outside the region, and the safeguard relied on |
| Retention | How long, and what triggers deletion |
| Security | Key measures: access control, encryption, logging |
| Applicable laws | As decided by the General Counsel |
| DPA on file | Yes / no / not needed, per vendor |
| Last reviewed | Date |

## Lawful basis

Article 6(1) lists six: consent, contract, legal obligation, vital interests, public task, legitimate interests. For each activity write which one and why in a sentence.

- **Contract** fits processing genuinely needed to deliver what the person signed up for. It doesn't stretch to marketing.
- **Legal obligation** needs a specific law (tax records, employment records).
- **Legitimate interests** needs a balancing test written down: our interest, why the processing is necessary, and why it doesn't override the person's rights.
- **Consent** must be freely given, specific and withdrawable; record how and when it was collected.

Choosing a basis is a legal judgment. Propose one with reasoning; the General Counsel confirms.

## Finding activities nobody listed

Activities go missing when a team adopts a new tool. Check these sources each quarter:

- IT & Security's tool and vendor inventory: every tool that stores people data needs a row.
- Finance's vendor list: new subscriptions often mean new processors.
- Marketing: new forms, tracking, email lists, events.
- People: hiring tools, background checks, benefits providers.
- Product: new features that collect or infer data, analytics, AI features.
- Shared folders and spreadsheets with names, emails or ids.

## Retention

Write a period and a trigger: "6 years after the end of the financial year" or "12 months after the last contact". "As long as necessary" isn't a retention period. Statutory retention periods (tax, employment) vary by country; get them from the General Counsel or the Head of Finance, not from memory.

## Vendor contracts

For every vendor that processes personal data on our behalf, there should be a contract that meets Article 28(3). Check it covers: processing only on our documented instructions; confidentiality of staff; security measures; rules for sub-processors; help with data subject requests and with security, breach and assessment obligations; deletion or return at the end; and audit and information rights. Missing or weak terms go to the Contracts Specialist as a task.

## Quarterly review checklist

- [ ] New tools and vendors reconciled against the record.
- [ ] Each owner confirmed their rows (or changes recorded).
- [ ] DPA status checked for new processors.
- [ ] Retention actually happening (ask for evidence of deletion runs).
- [ ] Gaps raised as tasks with owners and due dates.
- [ ] Review date updated.
