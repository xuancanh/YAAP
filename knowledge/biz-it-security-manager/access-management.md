---json
{ "title": "Access management and least privilege", "summary": "Least-privilege principles, a joiner/mover/leaver checklist, and the evidence an access review needs to stand up in an audit.", "tags": ["security", "access", "identity", "least-privilege", "access-review"], "updated": "2026-11-04",
  "sources": [
    { "title": "CIS Critical Security Controls v8.1 (Control 5 Account Management, Control 6 Access Control Management)", "url": "https://www.cisecurity.org/controls/v8-1", "publisher": "Center for Internet Security", "date": "2024-06", "accessed": "2026-11-04" }
  ] }
---

# Access management and least privilege

A common way into a company is an account: a leaver's login that still
works, a shared admin password, a token with far more rights than it needs.
Access management is unglamorous and much of the risk sits there. In CIS
Controls v8.1, Control 5 is Account Management and Control 6 is Access
Control Management, both with safeguards in the basic implementation group.

## Principles

- **Least privilege**: each account gets the access its role needs now,
  nothing "in case". Admin rights are separate accounts or time-limited
  elevation, not the daily login.
- **Named accounts**: one person (or agent), one account. Shared accounts
  make every action unattributable; where a system forces one, the
  credential lives in a password manager with access logged.
- **MFA everywhere it is offered**, strongest on email, the identity
  provider, code hosting, cloud consoles and finance.
- **Single sign-on where possible**, so removing a person in one place
  removes them everywhere connected.
- **Owners decide, IT executes**: the business owner of each system says
  who should have access; IT applies and records it.
- **Service accounts and API tokens count**: each has an owner, a purpose,
  a scope and an expiry or rotation date.

## Joiner, mover, leaver checklist

Agree the triggers with People operations (`/org/people/`) so IT hears of
every change the day it's decided, not the day it's noticed.

**Joiner**
- [ ] Request from the manager names the role and start date.
- [ ] Accounts created from the role's standard access set, not copied from
      a colleague ("same as Sam" copies Sam's accumulated extras).
- [ ] MFA enrolled before first use; device enrolled in MDM, encrypted.
- [ ] Anything outside the standard set approved by the system owner and
      recorded.

**Mover**
- [ ] New role's access added.
- [ ] Old role's access **removed**: movers accumulate rights more than
      anyone.
- [ ] Owner of each removed system confirms.

**Leaver**
- [ ] Identity provider account disabled within the leaver target (one
      business day by default; same day for a high-risk profile or a
      hostile departure).
- [ ] Accounts outside SSO disabled one by one from the systems list.
- [ ] Sessions and tokens revoked; personal API keys rotated or deleted.
- [ ] Shared credentials the person knew are rotated.
- [ ] Device returned or remotely locked (wiping is a human decision).
- [ ] Mail and files transferred per the company's policy.
- [ ] Dates recorded: leave date, each removal date, who did it.

## Evidence for an access review

An auditor (or the monthly control audit) wants to see that the review
happened, who decided, and that removals were carried out. Per system,
keep in `/org/it-security/access-reviews/<yyyy>-Q<q>/`:

```markdown
## <System>  owner: <name>  reviewed: <date>
Export: <file name>, taken <date> by <member>, <n> accounts
| Account | Role | Last login | Decision (keep/change/remove) | Decided by | Done on | Evidence |
|---|---|---|---|---|---|---|
| j.doe | admin | 2026-09-30 | change → member | <owner> | 2026-10-04 | after-export line 12 |
After-export: <file name>, taken <date>
```

## Worked example (made-up figures)

Quarterly review across 9 in-scope systems. Reconciling against the people
list finds 3 accounts belonging to leavers (one with admin on the cloud
console), 2 unknown accounts and 1 shared login. The admin leaver is raised
the same day, as the playbook says; owners decide on the rest. Eight of nine
systems are reviewed by the due date: access review completion =
8 ÷ 9 × 100 = 89%.

## Common pitfalls

- **Rubber-stamp reviews.** An owner approving 200 accounts in a minute
  hasn't reviewed them. Send them only the exceptions plus a sample, with
  last-login data.
- **Forgetting non-SSO systems.** The spreadsheet tool, the domain
  registrar and the social accounts are where leavers linger.
- **No last-login data.** Accounts unused for 90 days (company-set) are the
  easiest removals; without the column they're invisible.
- **Agents with broad standing access.** Agent members follow least
  privilege like anyone; their access is granted by the company, scoped,
  and reviewed in the same cycle.
