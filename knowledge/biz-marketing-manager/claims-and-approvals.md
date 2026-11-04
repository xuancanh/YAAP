---json
{ "title": "Claims and approvals", "summary": "The check every outward draft passes before a human approves it: claim types, the proof each needs, the disclosure line and who signs off.", "tags": ["claims", "approvals", "compliance", "publishing", "marketing"], "updated": "2026-11-04" }
---

# Claims and approvals

Nothing marketing makes goes public, gets sent or spends money without a human's approval. Your job is to hand that human a draft they can approve quickly: every claim already backed, the disclosure line present and the approver named. A draft that makes the approver go and check things is not ready.

The company's claims policy and disclosure line live in its marketing files (`/org/marketing/README.md` or a policy under `/org/marketing/processes/`). If neither exists, propose one as a task for the chief rather than making up a policy.

## Claim types and the proof each needs

| Claim type | Example | Proof required |
|---|---|---|
| Product capability | "Exports to CSV" | Shipped and on for the audience on the publish date (check the product launch file or ask the Head of Product). |
| Customer result | "Cut close time by 40%" | A named customer's own figure, their written permission to use it, and the date. |
| Comparative | "Faster than X" | A test you can show, run fairly and recently, and the method written down. Often needs legal review. |
| Superlative | "The leading…", "#1" | A third-party source that says so, with its date. Otherwise drop the word. |
| Statistic | "73% of teams…" | The original source (not a blog quoting it), its date and sample. |
| Pricing and offers | "Free for 30 days" | Matches what billing actually does; terms linked. |
| Security, compliance, legal | "SOC 2", "GDPR compliant" | The certificate or the owner's written confirmation. Always needs the owner's sign-off. |
| Forward-looking | "Coming in Q1" | Avoid. If unavoidable, the Head of Product's written agreement, worded as intent. |

When in doubt, soften the claim to what the proof supports, or cut it.

## Pre-approval checklist

- [ ] Each claim is listed with its proof (link, file, or person and date) in the draft's notes.
- [ ] Capability claims match what is live on the publish date, not the roadmap.
- [ ] Customer names, logos and quotes have recorded permission.
- [ ] Statistics cite their original source with its date.
- [ ] The disclosure line is present wherever the company requires it (for example, content drafted by agents).
- [ ] Links, UTMs and forms work on the final version.
- [ ] The approver is named and is the person with authority for this kind of claim and spend.
- [ ] The published version will match the approved draft exactly; any change after approval goes back for approval.

## Approval note template

Attach this to the task when you `org_request_review` or hand the draft to the approver.

```markdown
## For approval: <asset>
Where it goes: <channel, audience, date and time>
Spend: <USD, budget line> or none
Claims and proof:
1. "<claim>" — <proof link or person, date>
2. ...
Disclosure line: present at <location>
Changed since last approval: <nothing / what>
Approve by: <date> so it can go out on <date>
```

## Common pitfalls

- A specialist's draft goes out with a claim the reviewer never saw, because it was added after approval. The audit compares published copy with the approved draft.
- Quoting a statistic from a secondary article whose original source can't be found.
- "Customers love it" style claims with no customer behind them.
- Treating approval as a formality and approving your own team's draft without reading the proof.
