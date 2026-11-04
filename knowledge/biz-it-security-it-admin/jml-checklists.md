---json
{ "title": "Joiner, mover, leaver checklists", "summary": "Detailed checklists for starting, changing role and leaving, so access matches the role on day one and is gone on the last day.", "tags": ["joiner mover leaver", "onboarding", "offboarding", "access management"], "updated": "2026-11-04" }
---

# Joiner, mover, leaver checklists

Access problems cluster at transitions: new starters waiting for tools, movers keeping old access, leavers keeping any access at all. These checklists close those gaps. Adapt them to the company's actual tools and keep the adapted version in `/org/it-security/`.

## Role-based access

Keep an access matrix: for each role, the groups, apps and permission levels it gets by default. Then:

- Joiners get the role's bundle, nothing more.
- Movers swap one bundle for another.
- Leavers lose everything.
- Anything outside the bundle is a request with an approver and, where possible, an end date.

Grant through groups in the identity provider wherever apps support it. Single sign-on (SSO) means one switch turns access off.

## Joiner

**Before day one**
- [ ] Request received from People Ops or the hiring manager with name, role, start date, manager, location.
- [ ] Identity account created in the identity provider; username follows the naming standard.
- [ ] Role bundle assigned: groups, email, chat, core apps.
- [ ] Device assigned in the inventory, enrolled in device management, encrypted, updated.
- [ ] Any extra access requested and approved by the manager (and the app owner for sensitive systems).

**Day one**
- [ ] Credentials delivered through a secure channel, never in the same message as the username, and never by email to a personal address unless the company process says so.
- [ ] MFA enrolled before the first real work session. Prefer phishing-resistant methods (see [patching and MFA standards](patching-and-mfa.md)).
- [ ] Password manager set up, if the company uses one.
- [ ] Short security basics: how to report phishing, where to raise tickets.

**First week**
- [ ] Ask the person and manager: anything missing? Add it to the role bundle if others will need it too.

## Mover

- [ ] Request with old role, new role and effective date.
- [ ] New bundle added on the effective date.
- [ ] Old bundle removed on the effective date, or after a short agreed overlap for handover, with the end date recorded.
- [ ] Privileged and sensitive access reviewed one by one: does the new role need it?
- [ ] App owners of sensitive systems told of the change.
- [ ] Inventory and access records updated.

Movers are the most common source of access creep: people collect permissions with every role change. Treat the removal half as mandatory.

## Leaver

Timing matters most. Agree the exact time with People Ops: for a normal departure, the end of the last working day; for a sensitive or involuntary departure, at or before the conversation.

**At the agreed time**
- [ ] Identity account disabled (not deleted yet) in the identity provider.
- [ ] Active sessions revoked and refresh tokens invalidated, where the provider supports it.
- [ ] MFA methods and app passwords removed.
- [ ] Apps outside SSO: accounts disabled one by one from the inventory's list of apps the person had.
- [ ] Shared credentials the person knew are rotated (service accounts, shared vault items).
- [ ] Personal API tokens and keys revoked.

**Same day or next**
- [ ] Email handled per policy: forward to the manager, auto-reply, or convert to a shared mailbox.
- [ ] Files and ownership transferred: documents, calendars, repositories, scheduled jobs, owned groups.
- [ ] Device return arranged; remote lock or wipe only per the approved checklist.
- [ ] Licences reclaimed.

**Later**
- [ ] Account deleted after the retention period in the policy.
- [ ] Device wiped and reissued or disposed of securely, with the record in the inventory.

## Records

For every JML event record: request, approver, timestamps for each step, and any exceptions. These records are audit evidence for the GRC Specialist and the source for the leaver removal time KPI (see [IT admin metrics](it-admin-metrics.md)).

## Pitfalls

- Deleting instead of disabling on day one, losing data the company needs.
- Forgetting apps outside SSO. The inventory's per-person app list is the fix.
- Contractors and agents managed outside the process. Same checklists, with end dates set at creation.
- Waiting for the device to come back before removing access. Remove access first.
