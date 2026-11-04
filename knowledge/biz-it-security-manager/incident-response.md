---json
{ "title": "Security incident response", "summary": "How NIST frames incident response (SP 800-61 Rev. 3 and the older Rev. 2 phases), a first-hour checklist, evidence handling and the incident file template.", "tags": ["security", "incidents", "incident-response", "nist"], "updated": "2026-11-04",
  "sources": [
    { "title": "NIST SP 800-61 Rev. 3: Incident Response Recommendations and Considerations for Cybersecurity Risk Management: A CSF 2.0 Community Profile", "url": "https://csrc.nist.gov/pubs/sp/800/61/r3/final", "publisher": "NIST", "date": "2025-04-03", "accessed": "2026-11-04", "note": "Supersedes Rev. 2." },
    { "title": "NIST SP 800-61 Rev. 2: Computer Security Incident Handling Guide (withdrawn)", "url": "https://csrc.nist.gov/pubs/sp/800/61/r2/final", "publisher": "NIST", "date": "2012-08-06", "accessed": "2026-11-04" },
    { "title": "NIST Cybersecurity Framework 2.0", "url": "https://www.nist.gov/cyberframework", "publisher": "NIST", "date": "2024-02-26", "accessed": "2026-11-04" }
  ] }
---

# Security incident response

Your incident-response playbook gives the steps. This doc gives the frame
behind them, what to do in the first hour, and the file that keeps the
response defensible later.

## How NIST frames it

**SP 800-61 Rev. 2 (2012)**, still the model most people know, describes a
four-phase life cycle: Preparation; Detection and Analysis; Containment,
Eradication and Recovery; and Post-Incident Activity.

**SP 800-61 Rev. 3 (April 2025)** supersedes it. It is written as a
community profile of the NIST Cybersecurity Framework 2.0 and places
incident response inside overall risk management, using CSF 2.0's six
functions: Govern, Identify, Protect, Detect, Respond and Recover. The
practical shift: preparation and lessons learned are continuous work across
all functions, not bookends to an incident.

You don't need to cite either to run a response. Use the Rev. 2 phases as
the working checklist and the Rev. 3 view for the ongoing work around it:
playbooks, logging, backups, access hygiene and reviews.

## Severity

Use `/org/it-security/incident-severity.md`. The playbook's default:

| Severity | Default trigger |
|---|---|
| critical | confirmed customer data exposure, or active compromise |
| major | likely compromise of one account or system |
| minor | anything else suspicious that needs handling |

When in doubt, start higher and downgrade with a reason; the reverse costs
hours.

## First-hour checklist

- [ ] **Record it** with `org_report_incident`; check `org_incidents` for a
      related open one.
- [ ] **Name one coordinator** (you, unless delegated) and a channel for
      updates.
- [ ] **Scope**: what was seen, by whom, when; which accounts, systems and
      data may be involved; is it still happening?
- [ ] **Preserve evidence before changing things**: export logs, note
      timestamps, keep a copy of suspicious emails with headers. Don't
      reboot or wipe a device you may need to examine.
- [ ] **Propose containment** with the trade-off: disable the account,
      revoke sessions and tokens, isolate the device, rotate a key, block an
      address. Actions affecting people or production are a human decision
      unless a standing instruction covers them; use `org_escalate` when it
      can't wait.
- [ ] **Possible notification duty** (customers, regulators, partners):
      backlog task to Legal straight away with the facts known so far.
      Deadlines can be short and they start from awareness, not from the
      end of the investigation.
- [ ] **Update on a fixed rhythm** (the company sets it) even when there's
      no news.

## Eradication and recovery

Remove the cause (malware, a backdoor account, an exposed key), close the
way in, and restore from known-good state. Watch for recurrence for a
period the company sets before calling it resolved. Recovery of production
systems goes through Engineering as a briefed task.

## The incident file

`/org/it-security/incidents/<date>-<slug>.md`:

```markdown
# <What happened, plainly>
Severity: <…>   Status: open | contained | resolved | reviewed
Incident: <org_incidents id>   Coordinator: <member>   Opened: <UTC>

## Facts known
What was observed, systems and data in scope, what is still unknown.

## Timeline (UTC)
| Time | Action or observation | Actor | Evidence |
|---|---|---|---|

## Decisions
| Time | Decision | Decided by | Reason |
|---|---|---|---|

## Evidence preserved
What, where it's stored, who has access.

## People informed
Who, when, by whom (internal, Legal, customers via a human).

## Review
Cause; why controls didn't catch it earlier; at most three changes with owner and date.
```

## Worked example (made-up)

A staff member reports entering their password on a fake login page 20
minutes ago. Severity major (likely compromise of one account). Logged,
evidence of the email kept, sign-in logs exported. Containment proposed:
reset password, revoke sessions, check for new mail forwarding rules and
MFA devices. A standing instruction covers resetting a reported
compromised account, so the IT Administrator does it at once. Logs show one
foreign sign-in that read mail, so Legal gets a task about possible
exposure. Review change: phishing-resistant MFA for that group.

## Common pitfalls

- **Destroying evidence while fixing.** Snapshot, then change.
- **Silence.** Stakeholders who hear nothing assume the worst or act alone.
- **Declaring it over too soon.** Attackers who had access often left a way
  back; check accounts, tokens and forwarding rules.
- **Outward statements by an agent.** Any message to customers, press or
  regulators is a draft for a human.
