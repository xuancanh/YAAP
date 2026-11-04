---json
{ "title": "Implementation tracking", "summary": "A phase template, RAID log and stall rules for tracking an implementation and flagging blockers the week they appear.", "tags": ["implementation", "onboarding", "raid", "checklist", "stall"], "updated": "2026-11-04" }
---

# Implementation tracking

Track an implementation so that anyone can see, in one minute, whether it is on track, what is blocked and who needs to act. Status should come from dates and owners, not from feeling.

## Phase template

Adapt the phases to the product. Each step has an owner (name, not team), a due date and a done condition.

| Phase | Typical steps | Exit condition |
|---|---|---|
| **Set up** | accounts created, admins named, SSO or access configured, security review passed | admins can sign in and manage users |
| **Configure** | settings, workflows, permissions, templates | configuration signed off by the project owner |
| **Integrate / migrate** | integrations connected, data imported and checked | sample data reconciled with the source |
| **Train** | admin training, role-based user training, materials shared | each user group trained or scheduled |
| **Go live** | users invited, old process switched off where agreed | users working in the product |
| **First value** | milestone metric reached and confirmed | customer owner confirms in writing |

## Status rules

Use a plain rule so status means the same thing everywhere:

- **On track**: no step past due; no open blocker
- **At risk**: a step is past due, or a blocker has no resolution date
- **Stalled**: no step completed in the last week, or the customer has not responded to two follow-ups
- **Blocked**: progress cannot continue until a named issue is resolved

Flag "stalled" to your manager the week it happens, with the reason and your proposed fix.

## RAID log

Keep one log per onboarding.

| Type | Entry | Owner | Date | Status |
|---|---|---|---|---|
| **Risk** | something that might happen ("IT approval may slip past month end") | | | |
| **Assumption** | something you are relying on ("their CSV export includes all historic tickets") | | | |
| **Issue** | something that has happened ("SSO metadata rejected") | | | |
| **Dependency** | something outside your control ("their data warehouse migration") | | | |

Review it at each check-in. Close an assumption by confirming it; turn it into an issue if it proves false.

## Common blockers and first moves

- **Access and security approvals**: identify the approver at kickoff, send the security pack early.
- **Data quality**: test a small import first; agree who fixes source data.
- **Customer capacity**: offer fewer, shorter sessions; ask the sponsor to protect time.
- **Scope creep**: write the new request down, check it against the contract and route it to your manager or the CSM; keep the first value milestone unchanged.
- **Silent champion**: escalate through the sponsor after two missed follow-ups.

## Weekly status note

```
Status: on track / at risk / stalled / blocked
Done this week: …
Next week: …
Blockers: issue, owner, needed by
First value: on track for <date> / moved to <date> because …
```

Send it to the customer owner and log it in the account file.

## Handoff readiness checklist

Before handing to the CSM:

- [ ] First value milestone reached and confirmed by the customer
- [ ] All phases closed or open items listed with owners
- [ ] RAID log reviewed; open risks handed over explicitly
- [ ] Stakeholder map current
- [ ] Training materials and recordings linked
- [ ] Metrics recorded: time to value, completion, first-week usage (see [onboarding metrics](onboarding-metrics.md))
