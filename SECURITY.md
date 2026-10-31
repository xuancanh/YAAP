# Security policy

The full threat model — what yaam-chat defends against, how each defence is
implemented, the approval taxonomy, the prompt-injection posture, what we
never do, and the honest list of known gaps — is in
[`docs/security.md`](docs/security.md). A running instance serves the same
headline summary and its disclosure contact at `GET /api/security`.

## Supported versions

yaam-chat is pre-1.0 and ships from `main`. Only the current `main` (and the
most recent tagged release, once releases exist) receives security fixes.
Self-hosted operators should track `main`.

## Reporting a vulnerability

Please do not open a public issue for a security problem.

- **Hosted instance you use:** write to the address that instance publishes
  at `GET /api/security` (the operator sets it with `SECURITY_CONTACT`; the
  placeholder is `security@<your-domain>`).
- **The code itself:** open a private security advisory on this repository
  (GitHub → Security → Advisories → Report a vulnerability).

Include the affected surface (API route, tool, bridge op, channel), steps to
reproduce, and the impact. You can expect an acknowledgement within 3
business days, an assessment within 10, and a fix or mitigation plan for
confirmed issues within 30 days of acknowledgement. Good-faith research
against your own or a test deployment is covered by the safe-harbour
statement in `docs/security.md` §j.
