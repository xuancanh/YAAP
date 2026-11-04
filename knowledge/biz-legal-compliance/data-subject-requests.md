---json
{ "title": "Data subject requests", "summary": "The rights people can exercise, the GDPR response deadline and extension, proportionate identity checks, a search checklist and response templates.", "tags": ["dsr", "dsar", "gdpr", "rights", "templates"], "updated": "2026-11-04",
  "sources": [
    { "title": "GDPR Article 12, Transparent information and modalities (gdpr-info.eu), accessed 2026-11-04", "url": "https://gdpr-info.eu/art-12-gdpr/" },
    { "title": "GDPR Chapter 3, Rights of the data subject, Articles 12-23 (gdpr-info.eu), accessed 2026-11-04", "url": "https://gdpr-info.eu/chapter-3/" }
  ] }
---

# Data subject requests

A request is a deadline from the moment it arrives, whichever channel it comes through: a support ticket, an email to sales, a message to an agent. Log it the same day.

## The deadline (GDPR)

Article 12(3) says the controller responds without undue delay and in any event within one month of receipt. The period can be extended by two further months where necessary, given the complexity and number of requests, but the person must be told about the extension, with reasons, within the first month.

Other privacy laws set different deadlines and rights. Check the processing records for which laws apply to the person, and use the shortest deadline that applies. When unsure, ask the General Counsel.

## Rights you'll see

| Request | GDPR article | What they get |
|---|---|---|
| Access | 15 | A copy of their data and information about how it's used |
| Correction | 16 | Inaccurate data fixed, incomplete data completed |
| Deletion | 17 | Erasure, where one of the grounds applies |
| Restriction | 18 | Data kept but not used, e.g. while accuracy is disputed |
| Portability | 20 | Data they provided, in a machine-readable format, where the basis is consent or contract |
| Objection | 21 | Processing stops unless there are compelling grounds; for direct marketing, always stops |
| Automated decisions | 22 | Human review of a solely automated decision with significant effect |

People rarely name the article. "What do you have on me?" is an access request; "stop emailing me and delete my account" is an objection plus a deletion request.

## Steps

1. **Log** in the DSR log with a reference id, received date, request type, channel, legal deadline and the internal target (well before the deadline). Personal details stay in the secure system, not the log.
2. **Acknowledge** promptly, giving the reference and expected date.
3. **Verify identity proportionately.** If the request comes from the email address on the account, that's often enough. Ask for more only when the data is sensitive or the request looks suspicious. Don't ask for more data than you need to verify, and don't use verification to delay.
4. **Clarify** only if genuinely unclear; record the date you asked.
5. **Search** every system in the processing records for that person (checklist below), via tasks to each system owner with a due date.
6. **Apply exemptions** only where the law allows, and record which and why. Common ones involve other people's data in the same record, legal privilege, and legal retention duties. Exemptions are legal judgments; get the General Counsel's view.
7. **Draft the response** for review.
8. **Record completion** date and outcome.

## Search checklist

- [ ] Product database and account records
- [ ] Support tickets and chat transcripts
- [ ] CRM and sales notes
- [ ] Email marketing platform and lists
- [ ] Billing and payment records
- [ ] Analytics and event data tied to an id
- [ ] Shared drives, spreadsheets and documents
- [ ] Backups (note how they're handled: often excluded from immediate deletion but overwritten on schedule)
- [ ] Vendors processing on our behalf (ask them, per their contract)
- [ ] Agent memory, workspace files and conversation logs that mention the person

## Response templates

**Acknowledgement**
> Thanks for your request, received on {date}. Your reference is {ref}. We'll respond by {date}. {If needed: To protect your data, please confirm {verification step}.}

**Extension (send within the first month)**
> We're working on your request {ref}. Because {reason: the number of systems involved / several related requests}, we need more time and will respond by {new date}.

**Access response**
> Attached is a copy of the personal data we hold about you, with: why we use it, the categories, who we share it with, how long we keep it, where it came from, and your other rights, including the right to complain to a supervisory authority.

**Deletion completed**
> We've deleted the personal data linked to {ref} from our systems on {date}. {We keep {item} because {legal reason} until {date}.} Backups are overwritten by {date}.

**Refusal (in whole or part)**
> We can't {action} because {specific reason and legal ground}. You can complain to a supervisory authority or seek a judicial remedy.

## Pitfalls

- Starting the clock when the request reaches you instead of when it reached the company.
- Releasing other people's data inside the requester's records (redact).
- Deleting data that must be kept for a legal duty, or keeping data "just in case".
- Forgetting the vendors.
