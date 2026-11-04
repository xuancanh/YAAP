---json
{ "title": "Priority and SLA guide", "summary": "An impact-by-urgency priority matrix, SLA clock rules and cluster detection for consistent ticket triage.", "tags": ["triage", "priority", "sla", "support"], "updated": "2026-11-04" }
---

# Priority and SLA guide

Priority decides the order of work and which SLA clock runs. Set it from two questions, the same way for every ticket, so customers with the same problem get the same treatment.

## The two questions

**Impact: how much is affected?**
- **High**: many users or a whole customer cannot use a core function; data loss or security exposure; payments failing
- **Medium**: one team or a key feature degraded; a workaround exists but is painful
- **Low**: one user; a cosmetic issue; a how-to question

**Urgency: how fast does it get worse?**
- **High**: business stopped now, or a hard deadline is today
- **Medium**: work is slowed; the deadline is days away
- **Low**: no time pressure

## Priority matrix

| Impact ↓ / Urgency → | High | Medium | Low |
|---|---|---|---|
| **High** | P1 | P2 | P2 |
| **Medium** | P2 | P3 | P3 |
| **Low** | P3 | P4 | P4 |

The targets for each level come from the company's support policy and any customer contract. Look them up; do not assume. Contracted SLAs override the default for that customer.

## Special cases

- **Security or privacy reports**: treat as P1 for triage and follow the company's security process; do not discuss details in the ticket thread beyond what is needed.
- **Possible outage**: if several customers report the same failure, raise it as an incident with engineering at once, then link the tickets.
- **Billing and refunds**: priority by impact as usual, but the decision belongs to whoever the policy names.
- **Angry tone** does not change priority. Impact and urgency do. Respond with care, but triage by facts.

## SLA clock rules

Agree these with your manager and apply them every time:

- **First response clock** starts when the ticket is created and stops at the first human (or approved agent) reply that addresses the issue. An automatic acknowledgement does not count.
- **Resolution clock** starts at creation and stops when the ticket is solved.
- **Pending on customer**: if the policy allows pausing, pause only when you have asked the customer a specific question you need answered to proceed.
- **Business hours vs calendar hours**: check which applies to the customer's plan.
- **Re-prioritising**: if priority changes, note why in the ticket. The company's tool decides whether the clock resets; know which.

## Queue sweep checklist

On each sweep:

- [ ] Unassigned tickets: assign or triage
- [ ] Tickets near SLA breach: act or escalate now
- [ ] Pending tickets with no customer reply: follow up per policy, then close with a note
- [ ] P1/P2 tickets: status update due?
- [ ] Clusters: same error, same feature, same customer segment

## Spotting clusters

Three or more tickets with the same symptom in a short window is a signal. When you see one:

1. Tag the tickets with a shared tag.
2. Check recent releases, status page and known issues.
3. If it looks like a defect, file one bug report with all ticket links (see [bug report template](bug-report-template.md)) rather than many.
4. If it is a how-to, it is a help article candidate (see [help article standards](help-article-standards.md)).
5. Tell the queue owner so replies stay consistent.
