---json
{ "title": "Threat brief template", "summary": "How to judge sources, check the company's exposure and write a short threat brief that leads to action, with a template.", "tags": ["threat intelligence", "advisories", "threat brief", "template"], "updated": "2026-11-04" }
---

# Threat brief template

A threat brief answers one question for this company: does this matter to us, and what should we do? If the answer is "nothing", the brief is one paragraph saying why.

## Choosing what to brief

Write a brief when an advisory or trend:

- affects a product, version or service in the inventory;
- targets the company's sector, size or tech stack;
- describes an attack technique the company's controls may not stop;
- is getting attention internally and people need an accurate read.

Skip general news that has no exposure. Monthly, roll minor items into one short note.

## Judging sources

Prefer, in order:

1. **The vendor's own security advisory** for the affected product (versions, fixes, workarounds).
2. **Government and national CERT advisories** (for example CISA advisories and the KEV catalog).
3. **Established security research** from named teams with technical detail.
4. **Press coverage** only to find the primary source; do not cite it as the source.

For each claim note what kind of source it came from. Treat social media posts as leads, not facts. Label anything unconfirmed as unconfirmed.

## Checking exposure

- **Inventory:** do we run the affected product or a dependency of it? Which versions, where, internet-facing?
- **Vendors:** does a vendor that holds our data run it? Check with the GRC Specialist's vendor list; ask the vendor if needed.
- **Controls:** would our existing controls stop or detect the technique (MFA strength, email filtering, endpoint protection, network rules)?
- **Evidence:** any sign of the indicators in our logs? Search within your granted access; if you find any, escalate at once rather than finishing the brief.

## Template

```markdown
# Threat brief: <short name> — <date>
Relevance: <High | Medium | Low | None> to us

## Summary
<Three sentences: what it is, who is affected, whether it is being exploited.>

## Are we exposed?
<Yes / No / Unknown, with evidence: inventory matches, versions,
 internet exposure, vendor status.>

## What we should do
| Action | Priority | Owner | Due |
<Patch to version X; apply workaround; add detection rule; send awareness note.>

## What would change this assessment
<New exploitation reports; vendor confirms we're affected; a fix is released.>

## Sources
- <Vendor advisory, link, date read>
- <CERT advisory, link, date read>
```

## Writing tips

- Lead with relevance and the action. Many readers will stop after the summary.
- Use plain words for impact: "an attacker on the internet could take over the server" instead of a list of acronyms.
- Give exact versions and exact fixed versions.
- Keep it short; link to sources for detail.
- Do not overstate. "Being exploited in the wild per CISA KEV" is precise; "hackers everywhere are using this" is not.

## After sending

- Turn actions into tasks with owners (`org_create_task`) and track them in the vulnerability list if they are vulnerabilities.
- Revisit high-relevance briefs when the situation changes, and update the same file with a dated note rather than starting a new one.
