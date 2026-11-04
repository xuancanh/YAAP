---json
{ "title": "Request triage and the matter log", "summary": "How to risk-tier an incoming legal request, who handles each tier, when to escalate or recommend outside counsel, and the matter log format.", "tags": ["intake", "triage", "risk", "escalation", "template"], "updated": "2026-11-04" }
---

# Request triage and the matter log

Triage decides three things fast: how risky this is, how urgent it really is, and who should handle it. The service targets and the matrix live in `/org/legal/cadence.md`. The tiers below are defaults the company tunes to its risk appetite. None of this is legal advice. Tiers 3 and 4 always end with a qualified human lawyer.

## Risk tiers

| Tier | Typical requests | Handled by | Human sign-off |
|---|---|---|---|
| 0 Self-serve | Standard NDA on our paper, "which template do I use?", FAQ answers | Requester with template or FAQ link | None beyond normal signing authority |
| 1 Standard | Our template with deviations inside playbook fallbacks, routine vendor terms, low-value renewals | Contracts Specialist | Signing authority per delegation |
| 2 Elevated | Third-party paper, deviations to fallback 2, personal data processed, new jurisdiction, notable value | General Counsel (agent) review, issues list | General Counsel (human) or delegate |
| 3 High | Outside the playbook, uncapped exposure, regulated activity, employment exits, IP disputes, data transfers to new countries | General Counsel drafts analysis | Qualified lawyer, plus CEO when a risk is accepted |
| 4 Critical | Threatened or actual claim, regulator or law-enforcement contact, data breach, court papers, anything with a statutory deadline | Escalate same day (org_escalate; org_report_incident for a breach) | Qualified lawyer; CEO decides |

**Raise the tier** when any of these is true: the value at stake is above the company's threshold, the counterparty is a regulator or public body, personal or sensitive data is involved, the deal is irreversible or long-term, it sets a precedent, or a deadline is set by law rather than by the requester.

**Recommend outside counsel** (a backlog task for the chief with the scope and a cost estimate from a named source) when: a licensed lawyer is legally required, the jurisdiction isn't covered, litigation is threatened or underway, or the issue is novel and high-stakes.

## Urgency: real deadline vs requested date

Ask what happens if it's late. A signing scheduled to close a quarter, a regulator's response date, or a statutory clock is real. "ASAP" isn't. Priority comes from tier × real urgency. A tier-4 item is always first.

## Intake questions

1. What do you need, in one sentence?
2. Who is the counterparty (exact entity) and what's the deal value?
3. What's the real deadline, and what happens if we miss it?
4. Is personal data, money, IP or an employee involved?
5. Has anything been signed, sent or promised already?
6. Attach every document, including the counterparty's latest version.

## Matter log format (/org/legal/matters.md)

```markdown
| Id | Opened | Requester (function) | Type | Tier | Counterparty | Value | Owner | Real deadline | Target date | State | With | Closed | Outcome |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| LEG-041 | 2026-11-02 | Sales | Third-party MSA | 2 | Example Corp Ltd | <from CRM> | Contracts Specialist | 2026-11-14 (quarter close) | 2026-11-07 | In review | Legal | | |
```

- **Type:** contract (template / third-party / amendment), advice, regulatory or privacy, dispute, employment, corporate, IP.
- **State:** new, in review, with counterparty, with business for decision, awaiting approval, agreed, closed.
- **With:** legal / counterparty / business. Only time "with legal" counts toward turnaround.
- Keep privileged analysis in the matter's working files, not in the log. The log records that a matter exists and where it stands.

## Turnaround, measured honestly

Turnaround (working days) = days the matter spent in state "with legal", from receipt of a complete request to an agreed draft or answer. Report the median per type. Pausing the clock while waiting on the business is fine. Pausing it while waiting on our own approver isn't.

## Worked example (made-up)

Sales sends a customer's own MSA for a deal they want signed before quarter end in nine working days. Personal data will be processed, the paper is the customer's, and the liability cap is uncapped for data breaches. That's tier 2, raised to 3 because uncapped exposure sits outside the playbook. The deadline is real. Route: Contracts Specialist prepares the issues list within three days, General Counsel reviews, and the uncapped term goes to a qualified lawyer with a recommended fallback. The CEO is asked only if the customer refuses every fallback. The requester gets the dates on the task the same day.

## Common pitfalls

- **Triage by who shouts loudest.** Use the tier and the real deadline.
- **Not asking whether anything is already signed or sent.** It changes the whole matter.
- **Tier 4 handled as a ticket.** A breach, claim or regulator letter is escalated the same day, because legal deadlines may already be running.
- **Logging analysis in shared files.** Privilege can be lost. Say the status, not the advice.
- **Closing without the outcome**, which makes the quarterly playbook review impossible.
