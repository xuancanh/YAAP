---json
{ "title": "Patching and MFA standards", "summary": "How to run patch rings, prioritise urgent patches, rank MFA methods by strength, and handle exceptions so compliance numbers mean something.", "tags": ["patching", "mfa", "phishing-resistant", "compliance"], "updated": "2026-11-04",
  "sources": [{ "title": "CISA, Implementing Phishing-Resistant MFA (fact sheet, 2022)", "url": "https://www.cisa.gov/sites/default/files/publications/fact-sheet-implementing-phishing-resistant-mfa-508c.pdf" },
              { "title": "CISA, More than a Password (MFA guidance, read 2026-11-04)", "url": "https://www.cisa.gov/MFA" },
              { "title": "CISA, Known Exploited Vulnerabilities Catalog (read 2026-11-04)", "url": "https://www.cisa.gov/known-exploited-vulnerabilities" }] }
---

# Patching and MFA standards

## Patching

### Patch rings

Roll out updates in stages so a bad patch hits a few devices first:

1. **Pilot:** a small group, including IT, that tolerates issues.
2. **Broad:** most devices, after the pilot shows no problems for an agreed short period.
3. **Sensitive or critical:** devices where downtime hurts most, last, but within the deadline.

Configure automatic updates in device management for operating systems and browsers. Manual patching does not scale.

### Deadlines by urgency

Set deadlines with the Head of IT & Security and write them in `/org/it-security/kpis.md`; the patch compliance KPI is measured against them. A sensible shape:

- **Actively exploited** vulnerabilities, or those on CISA's Known Exploited Vulnerabilities (KEV) catalog: the shortest deadline. CISA strongly recommends that organisations outside the US federal government also prioritise KEV entries.
- **Critical and high** severity: a short deadline.
- **Others:** the normal cycle.

For actively exploited issues, go straight to broad rollout after a brief pilot, and coordinate with the Security Analyst, who tracks them.

### What to cover

- Operating systems on laptops and phones.
- Browsers and their extensions.
- Common apps that handle untrusted content: office suites, PDF readers, chat and meeting clients.
- Network equipment and anything internet-facing that IT manages.

Servers and production systems usually belong to Engineering or the SRE; agree who owns what in writing.

### Compliance rules

- A device is compliant when its OS and managed apps are at or above the required version **and** it has checked in recently. A device that has not checked in is unknown, not compliant.
- Devices past the deadline get a reminder, then the person's manager, then escalation per policy (for example, restricted access until updated).

## MFA

### Strength ladder

CISA describes phishing-resistant MFA as FIDO/WebAuthn or PKI-based (smart cards), and calls FIDO/WebAuthn the only widely available phishing-resistant option. Rank methods roughly like this:

| Rank | Method | Notes |
|---|---|---|
| Strongest | Security keys or platform passkeys (FIDO2/WebAuthn); PKI smart cards | Resist phishing and push fatigue |
| Good | Authenticator app with number matching | Better than plain push; still phishable |
| Weaker | Authenticator app one-time codes; plain push approval | Phishable; plain push is open to "fatigue" spam |
| Weakest | SMS or voice codes | Use only when nothing else works |

Require the strongest method for admins, finance and anyone with access to sensitive data. Check current CISA guidance before changing policy; recommendations evolve.

### Rollout

1. Enforce MFA at the identity provider for all SSO apps.
2. For apps outside SSO, enable their own MFA and record it in the inventory.
3. Give admins phishing-resistant methods first.
4. Disable legacy protocols that bypass MFA where the provider allows.
5. Set up recovery: at least two methods per person, and a verified process for resets. Account recovery is a common attack path.

## Exceptions

Some devices cannot be patched yet, and some apps cannot do MFA.

Record each exception with: what, why, the risk, compensating controls (network restriction, extra monitoring, limited users), the owner, the approver and an expiry date. Review expired exceptions monthly. Report exceptions alongside the compliance rate; never quietly exclude them.

The formulas for patch compliance and MFA coverage are in [IT admin metrics](it-admin-metrics.md).
