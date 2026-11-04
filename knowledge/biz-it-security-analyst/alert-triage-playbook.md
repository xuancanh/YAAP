---json
{ "title": "Alert triage playbook", "summary": "Questions to ask for any alert, quick playbooks for common alert types, escalation triggers and how to preserve evidence.", "tags": ["alert triage", "incident response", "identity", "phishing", "evidence"], "updated": "2026-11-04",
  "sources": [{ "title": "NIST SP 800-61 Rev. 3, Incident Response Recommendations and Considerations for Cybersecurity Risk Management (April 2025)", "url": "https://csrc.nist.gov/pubs/sp/800/61/r3/final" },
              { "title": "NIST, The NIST Cybersecurity Framework (CSF) 2.0 (CSWP 29, February 2024)", "url": "https://nvlpubs.nist.gov/nistpubs/CSWP/NIST.CSWP.29.pdf" }] }
---

# Alert triage playbook

Triage answers four questions fast: is it real, how far does it go, how bad is it, and what happens next? NIST SP 800-61 Rev. 3 (April 2025, superseding Rev. 2) frames incident response as a Community Profile of the NIST Cybersecurity Framework 2.0, whose six functions are Govern, Identify, Protect, Detect, Respond and Recover; triage is where Detect hands over to Respond.

## Five questions for any alert

1. **What exactly fired?** Rule name, source, time (with zone), entity: user, device, IP, app.
2. **Is this normal for this entity?** Role, usual locations and devices, working hours, recent tickets (a new phone, travel, a role change).
3. **What else happened around it?** Other alerts for the same user, device or IP in the surrounding hours. Sign-ins, MFA changes, mailbox rules, file sharing, admin actions.
4. **What is at stake?** Asset sensitivity: an admin account, finance, customer data, production access.
5. **Is it still happening?** Active sessions, ongoing downloads, repeated attempts.

Then decide: false positive, benign true positive, or suspicious.

## Escalate immediately if

- a sign-in succeeded from an unexpected place and was followed by sensitive activity;
- MFA was changed, or approved after a burst of prompts the user did not expect;
- there are signs of data leaving: mass downloads, external sharing, forwarding rules to outside addresses;
- an admin or service account behaves unusually;
- malware is confirmed or a device is behaving like it is controlled remotely;
- a user reports entering credentials on a suspicious page.

Raise it with `org_report_incident`, notify your manager on the task, and keep investigating. Do not take containment actions beyond your standing instructions.

## Quick playbooks

**Unusual sign-in (new country, impossible travel)**
- Check for VPN or travel; ask the user through a known channel, not by replying to anything the alert involved.
- Check whether MFA was satisfied and how.
- Check activity after sign-in: mailbox rules, file access, new app grants.
- Suspicious and successful → escalate. Failed only → watch for repeats; consider password spray if many accounts are hit.

**Many MFA prompts or unexpected approval**
- Ask the user whether they initiated it.
- If they approved a prompt they did not start, treat as compromised credentials → escalate.

**Reported phishing email**
- Get the original message with headers (not a forward that strips them).
- Check sender, links and attachments in a safe way your tools support; do not open attachments on a normal device.
- Search for the same message in other mailboxes if you have access; others may have clicked.
- Anyone who entered credentials → escalate for reset and session revocation.

**New third-party app granted access to accounts (OAuth)**
- What permissions? Read mail, files, offline access are high risk.
- Who granted it, and is the app known in the inventory?
- Unknown app with broad permissions → escalate; recommend revoking the grant.

**Endpoint malware alert**
- Was it blocked or did it run? On which device, whose account?
- Ran or unclear → escalate; recommend isolating the device under the approved checklist.

## Preserving evidence

- Export the alert and related logs to the incident folder before they age out. Record source, query, time range and export time.
- Take notes with timestamps as you go.
- Don't alter the evidence: no logging into the affected account, no deleting the suspicious email until it has been captured.
- Keep evidence access limited to those who need it; it may contain personal data.

## Closing an alert

Write the decision and the reason in one or two lines, in `/org/it-security/alerts/<date>.md`:

```
<time> | <rule> | <entity> | FP / benign TP / escalated | <reason> | <tuning proposal?>
```

For false positives, propose a specific tuning change (exclude a known service IP, raise a threshold) rather than a general complaint. These records drive the false-positive rate KPI in [security analyst metrics](security-analyst-metrics.md).
