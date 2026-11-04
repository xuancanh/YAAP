---json
{ "title": "Incident roles, severity and updates", "summary": "Who does what in a live incident, how to set severity, the mitigation-first order of work, and templates for status updates.", "tags": ["incident response", "incident command", "severity", "communication"], "updated": "2026-11-04" }
---

# Incident roles, severity and updates

An incident goes better when roles are clear and updates come on a fixed beat. Even if you are the only responder, act as if the roles exist: it keeps you from fixing while nobody communicates.

## Roles

| Role | Does | Does not |
|---|---|---|
| **Incident lead** | Owns the incident: sets severity, decides on mitigations, assigns work, keeps the timeline | Debug alone in silence |
| **Operations** | Runs diagnostics and executes mitigations the lead approves | Make risky changes without saying so |
| **Communications** | Posts status updates on schedule; drafts customer wording for the customer team | Speculate on cause |
| **Scribe** | Records actions and decisions with times | Filter what seems unimportant |

In a small team the SRE often holds lead and scribe, and asks a Software Engineer to take operations. Hand the lead role over explicitly ("I'm handing lead to X") if you need to go deep.

## Severity

Set it from **user impact**, not from how hard the fix looks. Agree the scale with the Head of Engineering; a common shape:

| Sev | Impact | Response |
|---|---|---|
| 1 | Critical journey down or data loss/exposure for many users | All hands; updates on the shortest interval; leadership informed |
| 2 | Major degradation or a critical journey down for some users | Dedicated responders; regular updates |
| 3 | Minor degradation, workaround exists | Handle in working hours; one update when resolved |

Raise the severity as soon as impact grows; lowering it later is cheap.

## Order of work

1. **Declare.** Raise it with `org_report_incident`, note the start time, open the timeline.
2. **Assess impact.** Which journeys, which users, since when? Check SLO dashboards and recent changes.
3. **Mitigate.** Restore service before finding the cause. In rough order of preference:
   - roll back the latest change;
   - turn off a feature flag;
   - fail over or shift traffic;
   - scale up or shed load;
   - block a misbehaving client.
   Execute only what the company has granted; otherwise propose it to a human with the exact command and rollback.
4. **Verify.** Watch the SLI return to normal for long enough to trust it.
5. **Resolve and hand off.** Record the end time and known impact; start the [postmortem](postmortem-template.md).

## Timeline discipline

Write every action as `HH:MM (UTC) — who — what — result`. Include things you checked that were fine; they save time in the postmortem. Use one time zone throughout.

## Status update template

Post on a fixed interval, even if nothing changed. "No change, next update at…" is a valid update.

```
[Sev 2] Checkout errors — update 3 — 14:20 UTC
Impact: About a third of checkout attempts failing since 13:45 UTC. Other pages fine.
Doing: Rolled back the 13:40 release at 14:10; error rate falling.
Next: Confirm recovery; next update 14:40 UTC.
```

Customer-facing wording is a draft for the customer team. Keep it factual: what is affected, since when, what users can do, when the next update comes. No guesses about cause.

## Pitfalls

- **Root-causing during the outage.** If a safe mitigation exists, apply it first.
- **Several people making changes at once.** All changes go through the lead, so you know what fixed it.
- **Silent periods.** Stakeholders fill silence with escalations. Keep the beat.
- **Declaring too late.** If you are unsure, declare at low severity. Cancelling is free.
- **Ending too early.** Do not resolve until the SLI has been stable for a while and temporary mitigations are recorded in the handoff.
