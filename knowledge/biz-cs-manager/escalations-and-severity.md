---json
{ "title": "Escalations and severity", "summary": "A default severity matrix, roles, update rhythms and templates for customer updates and the post-escalation review.", "tags": ["escalation", "severity", "incident", "communication", "template"], "updated": "2026-11-04" }
---

# Escalations and severity

An escalation goes well when three things are clear from the first hour: how bad it is, who owns it, and when the customer will hear from us next. The severity matrix below is a default. The company's version lives in `/org/customer/escalation-policy.md`, and that one wins.

## Severity matrix (default)

| Severity | Customer impact | Examples | Owner | Customer update rhythm | Internal escalation |
|---|---|---|---|---|---|
| S1 | Many customers, or a strategic account, blocked; data exposure or wrong external action suspected | Outage, data loss, security concern, billing error at scale | Head of Customer names an owner within the hour | Every few hours until stable (exact interval in policy) | Engineering on-call, chief; org_report_incident; CEO for public statements or credits beyond the limit |
| S2 | One customer blocked, no workaround | Core workflow broken for one account | CSM or senior support | Daily, or on each material change | Engineering task with dueAt |
| S3 | Degraded, workaround exists | Slow feature, partial failure | Support specialist | On change, at least every few days | Normal backlog |
| S4 | Question or minor issue | How-to, cosmetic bug | Support queue | Per SLA | None |

**Raise the severity** when the account is strategic, a renewal is close, the issue touches security, data or money, or the customer's own customers are affected. **Lower it** only with the customer's agreement or a confirmed workaround.

## Roles

- **Escalation owner:** drives to resolution, keeps the timeline, pulls in other teams through briefed tasks.
- **Communication owner:** drafts every customer update for human approval (unless sending is granted) and keeps the cadence. For S1, this isn't the person fixing the issue.
- **Decision owners:** credits, refunds, contract terms and public statements belong to the people the company names. Bring them the case; don't decide.

## Customer update template

```markdown
Subject: <Issue> — update <n> (<date time, timezone>)

What's happening: <one or two sentences in plain words; impact on them>
What we've done since the last update: <facts>
What we know / don't know yet: <be honest; no guesses as facts>
What you can do now: <workaround, if any>
Next update: <time>, or sooner if something changes
Contact: <owner name>
```

Rules: no blame on individuals or vendors, no speculative root cause, no promised fix time unless engineering has committed to one, and no compensation offers unless the decision owner approved them.

## Timeline log (keep it as you go)

```markdown
| Time | Event | Source | Who |
|---|---|---|---|
| 09:12 | Customer reports export failing | Ticket #… | Support |
| 09:30 | Classified S2; owner assigned | — | Head of Customer |
```

## Closing and the post-review

Close only when the customer confirms the fix (or the policy timeout passes) **and** the root cause is recorded. Within a week, write `/org/customer/escalations/<date>-<account>.md`:

```markdown
# Escalation review: <account> — <date>
Severity: <S> · Duration: <opened → resolved> · Owner: <…>
Summary: <what happened, impact>
Timeline: <key points>
Root cause: <from engineering/product; cite the task>
What went well / what didn't: <detection, response, communication>
Changes: <action, owner, date> (each a task)
Playbook candidate: yes/no — <why>
```

Write it blameless: focus on systems and process, not individuals.

## Worked example (made-up)

A mid-size customer reports their exports have failed since this morning. No other customers report it, and there's no workaround, so it's S2. Their renewal is in 45 days, and the raise rule allows S1, but the head judges S2 with a tighter rhythm is enough and writes why on the task. Owner: their CSM. Communication owner: a support specialist. Updates go out twice daily plus on each change. Engineering gets a briefed task with dueAt. The customer asks for a credit, which is filed for the decision owner with the impact facts. The fix ships on day two, the customer confirms, and the review identifies a missing alert as the change.

## Common pitfalls

- **Silence between updates.** "No news yet, next update at 15:00" is a good update.
- **The fixer also writing the updates** in an S1. Both jobs suffer.
- **Promising an ETA** engineering didn't give.
- **Closing on our fix, not their confirmation.**
- **Skipping the review** because it worked out. The lesson is what prevents the next one.
