---json
{ "title": "Phishing simulation guide", "summary": "How to design a fair, realistic phishing simulation, what to measure, how to read the results and how to follow up without blaming people.", "tags": ["phishing", "security awareness", "simulation", "training"], "updated": "2026-11-04" }
---

# Phishing simulation guide

A simulation measures how the company responds to phishing and gives people safe practice. The best outcome is not "nobody clicked"; it is "many people reported it quickly". Treat it as training, not a trap.

## Ground rules

- **Approval first.** Your manager approves scenario, audience and timing in writing. People Ops should know it is happening.
- **No real credentials collected.** The landing page records that something was submitted, never what.
- **No cruelty.** Avoid lures about bonuses, layoffs, health, family or personal crises. They damage trust and teach little.
- **No impersonation that embarrasses a real colleague.** Use a generic sender (a SaaS notification, a supplier) rather than a named internal person.
- **Results are private by person.** Report by team or overall. Individual results go only to the person, and to their manager only if policy says so.
- **Check the rules.** Monitoring employees and processing their data is regulated differently by jurisdiction; confirm with your manager that the plan fits the company's policy.

## Designing the scenario

Base it on what attackers actually send to companies like this one: the threat briefs and reported phishing are your best guide.

Common realistic lures:

- A file shared with you from a document tool.
- A SaaS login or password-expiry notice.
- An invoice or payment request from a supplier.
- A meeting invite with a link.
- A delivery notice.

Vary difficulty across campaigns and record it, so trends are comparable. Include the red flags people can learn: mismatched sender domain, link that does not match the text, urgency, unexpected attachment.

## Running it

1. Allow the simulation domain and sender in email security, coordinated with the IT Administrator, so it is delivered like real mail.
2. Send in waves over a few days, not all at once; people talk.
3. Keep the report button or address working as normal. Thank people who report.
4. Watch for real phishing at the same time; don't dismiss a report as "just the simulation" without checking.

## What to measure

Per campaign, using unique recipients:

```
click rate            = recipients who clicked the link / recipients delivered
credential-submit rate = recipients who submitted the form / recipients delivered
report rate           = recipients who reported the email / recipients delivered
```

Also useful:

- **Time to first report:** how quickly the first person reported; that is how quickly a real attack could be caught.
- **Report before click:** people who reported without clicking.

The KPI "phishing failure rate" should be defined once in `/org/it-security/kpis.md`. A common choice is the credential-submit rate, because submitting credentials is the action that causes harm; some companies use click rate. State which you use in every report.

## Reading the results

- Compare with previous campaigns of similar difficulty only.
- Small teams give noisy rates; report counts beside percentages.
- A rising report rate is progress even if click rate holds steady.
- Look at what made people click: a believable sender, a mobile client hiding the real address, a tool the company really uses.

## Follow-up

- **Immediately after a click:** a short, kind landing page explaining what the clues were. No shaming.
- **For everyone:** a brief note after the campaign with the example, the red flags and how to report.
- **For repeated clickers:** short targeted training, offered privately.
- **For the system:** each campaign should produce at least one control idea: stronger MFA, a banner on external email, blocking a lookalike domain.

## Report outline

```markdown
# Phishing simulation <yyyy>-Q<q>
Scenario: <lure, difficulty>   Sent: <dates>   Delivered: <n>
| Metric | This | Last (similar difficulty) |
| Click rate | | |
| Credential-submit rate | | |
| Report rate | | |
| Time to first report | | |
What worked / what fooled people: …
Training plan: …
Control improvements proposed: …
```
