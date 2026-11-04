---json
{ "title": "Contract review checklist", "summary": "The clauses to check in a commercial contract, the questions to ask of each, and the issues-list template the business can act on.", "tags": ["contracts", "review", "checklist", "liability", "indemnity"], "updated": "2026-11-04" }
---

# Contract review checklist

Review against the company's playbook (`/org/legal/playbook.md`), not against an ideal contract. The output is an issues list the business can decide on and a redline for human counsel to approve. It is never a signed or sent document. This isn't legal advice. Where the governing law, the value or the clause is outside the playbook, flag it for a qualified lawyer.

## Before you read the clauses

- [ ] What is the deal? Parties (exact legal entities), product or service, value, term, who asked and by when.
- [ ] Which paper: ours, theirs, or an amendment to an existing agreement? For an amendment, read the master agreement too.
- [ ] What else attaches: order forms, statements of work, DPAs, security schedules, online terms "incorporated by reference" (fetch and read those as well).
- [ ] Order of precedence: which document wins if they conflict.

## Key clauses and what to check

**Limitation of liability**
- Is there a cap? Is it mutual? What is it tied to (fees paid in a period, a fixed amount)?
- What is excluded from the cap (often confidentiality breach, indemnities, data protection, wilful misconduct)? Uncapped exclusions can swallow the cap.
- Are indirect and consequential losses excluded? Is lost profit or lost data listed specifically?
- Does it match what finance and insurance can carry? The playbook has the number. Don't invent one.

**Indemnities**
- Who indemnifies whom, for what (third-party IP claims, data breaches, personal injury, breach of law)?
- Is it limited to third-party claims or open to direct losses?
- Is there a process: prompt notice, control of the defence, cooperation, no settlement without consent?
- Is it capped or uncapped, and does that match the liability clause?

**Intellectual property**
- Who owns what each party brought (background IP) and what's created under the contract (foreground IP, deliverables)?
- Licences: scope, territory, exclusivity, sublicensing, term, what survives termination.
- Customer data and outputs: who owns them, and can the supplier use them (for example to train models or for analytics)?
- Feedback clauses that hand over rights to suggestions.

**Confidentiality**
- Definition, exclusions (public, already known, independently developed, received from a third party), duration, return or destruction. See [NDAs](./ndas.md).

**Data protection and security**
- Is personal data processed? If yes, a DPA or data processing terms are needed. See [Privacy basics](./privacy-basics.md).
- Security commitments, breach notice timing, audit rights, subprocessors, international transfers.

**Term, renewal and termination**
- Initial term. **Auto-renewal**: does it renew automatically, for how long, and what's the notice window to stop it? Record the notice date in `/org/legal/obligations.md`. A missed window is a common and avoidable loss.
- Termination for convenience (who, notice, fees owed), termination for cause (cure period), and effects of termination (data return, transition help, survival clauses).

**Payment and price**
- Fees, invoicing, payment terms, late interest, price increases on renewal, taxes, disputed invoices. Check with finance or sales.

**Warranties and service levels**
- What's warranted, for how long, the remedy (re-perform, refund), disclaimers. SLA credits as the sole remedy or not.

**Governing law and disputes**
- Which law, which courts or arbitration, where. A jurisdiction nobody on the team can cover means outside counsel.

**Assignment and change of control**
- Can either party assign without consent? Does a change of control trigger termination rights? This matters in fundraising and M&A.

**Other**
- Non-solicitation, exclusivity, most-favoured-customer, publicity and logo use, insurance requirements, notices (address and method), entire agreement, and how amendments must be made.

## Issues-list template

```markdown
# Issues list: <counterparty> <agreement> (matter <id>)
Reviewed: <version/date>   Reviewer: <agent>   For: <requester>   Approver needed: <level>

| # | Clause | Their position | Playbook position | Proposed fix | Risk (H/M/L) | Needs approval from |
|---|---|---|---|---|---|---|
| 1 | Liability cap | Uncapped for data breach | Capped at <playbook level> | Cap data breach at <fallback 1> | H | General Counsel |
| 2 | Auto-renewal | 3-year renewals, 90-day notice | 1-year renewals, 30-day notice | Fallback: 1-year, 60-day | M | Contracts Specialist |

Business decisions needed: <plain-language questions for the requester>
Out of playbook / needs qualified counsel: <items>
Obligations to record if signed: <renewal notice date, reporting duties, caps>
```

## Common pitfalls

- **Reviewing only the main body** and missing terms incorporated by reference or order forms that override it.
- **Treating "mutual" as automatically fair.** A mutual uncapped indemnity can hurt the smaller party more.
- **Not checking the cap's exclusions**, where most of the real exposure sits.
- **Losing the renewal date.** Every signed contract's notice dates go in obligations.md the same day.
- **Silent deviations.** Every change from the playbook is on the issues list with its approver, even small ones.
- **Legal jargon in the issues list.** The business needs "if their data is breached, our exposure has no ceiling", not a clause number.
