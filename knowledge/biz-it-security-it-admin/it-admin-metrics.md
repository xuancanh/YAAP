---json
{ "title": "IT admin metrics", "summary": "Definitions and formulas for ticket SLA, patch compliance, MFA coverage and leaver removal time, with what to count and what to exclude.", "tags": ["metrics", "kpi", "sla", "mfa", "patching"], "updated": "2026-11-04" }
---

# IT admin metrics

Each KPI has a numerator, a denominator and a rule for edge cases. Write the rules once in `/org/it-security/kpis.md` and apply them the same way every week, or the trend means nothing.

## Ticket SLA

Two clocks per ticket: first response and resolution, each with a target per priority (see [ticket triage](ticket-triage.md)).

```
response SLA met   = tickets with first response within target
                     / tickets opened in the period
resolution SLA met = tickets resolved within target
                     / tickets resolved in the period
```

Rules to fix in writing:

- Whether the clock runs in business hours or around the clock, per priority.
- Whether time "waiting on requester" pauses the clock (usually yes, recorded as a status).
- How reopened tickets count (usually the original ticket continues, clock resumes).
- Tickets re-prioritised mid-flight use the final priority's target, or the original; pick one.

Report by priority. A good overall rate can hide breached P1s. Also show the open backlog and the oldest open ticket.

## Patch compliance

```
patch compliance = managed devices at or above the required versions
                   and checked in within the agreed window
                   / managed devices in use
```

Rules:

- The denominator is devices **in use** in the inventory, not only those that report. A device that has not checked in counts as non-compliant (or reported separately as "unknown"; never dropped).
- "Required version" is set per deadline in [patching and MFA standards](patching-and-mfa.md). A device inside the deadline for a new patch is still compliant.
- Report approved exceptions as a separate count; do not remove them from the denominator silently.

Useful splits: by OS, by patch urgency, and devices past deadline with their age.

## MFA coverage

Two views. Report both.

```
account MFA coverage = active accounts with MFA enrolled and enforced
                       / active accounts
app MFA coverage     = apps where MFA is enforced (via SSO or the app)
                       / apps in the inventory that hold company data
```

Rules:

- "Enforced" means sign-in is impossible without it, not just that the person enrolled.
- Include admin, service and break-glass accounts in the account view; service accounts that cannot use MFA are exceptions with compensating controls.
- Optionally track **phishing-resistant coverage** separately, especially for admins: accounts whose required method is FIDO2/WebAuthn or PKI, divided by active accounts.

## Leaver removal time

```
leaver removal time (per leaver) = time all access was removed
                                   − agreed removal time
```

"All access removed" means the identity account is disabled, sessions revoked, and every non-SSO app account from the inventory disabled. Record the last of these timestamps.

Report:

- median and maximum removal time for the period;
- the share of leavers whose access was fully removed by the agreed time:

```
on-time leaver removal = leavers fully removed by the agreed time
                         / leavers in the period
```

A negative removal time (removed before the agreed time) counts as on time. A leaver whose access was not fully removed is reported by name to your manager, not averaged away.

## Reporting format

```markdown
| Metric | This week | Last week | Target | Note |
| Response SLA met (P1/P2/all) | 2/2, 95%, 97% | … | <kpis.md> | |
| Patch compliance | 93% | 90% | | 4 unknown devices; 2 exceptions |
| Account MFA coverage | 100% | 99% | | |
| App MFA coverage | 88% | 88% | | 3 apps lack MFA (listed) |
| On-time leaver removal | 3/3 | 2/2 | | median 0 h |
```

Leave targets blank where none is agreed.
