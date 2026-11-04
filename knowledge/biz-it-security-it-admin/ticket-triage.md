---json
{ "title": "Ticket triage and SLAs", "summary": "A priority matrix, categories, reply templates and a knowledge-base article format for working the IT queue within SLA.", "tags": ["tickets", "service desk", "sla", "triage", "knowledge base"], "updated": "2026-11-04" }
---

# Ticket triage and SLAs

Triage is deciding quickly what each ticket is, how urgent it is, and who handles it. Done well, the urgent ones never wait behind the easy ones.

## Priority matrix

Set priority from **impact** (how many people or how important the system) and **urgency** (how soon harm happens).

| | Urgency high (blocked now) | Urgency medium (degraded) | Urgency low (can wait) |
|---|---|---|---|
| **Impact high** (many people, or a critical system) | P1 | P2 | P3 |
| **Impact medium** (a team, or one important person's core work) | P2 | P3 | P4 |
| **Impact low** (one person, workaround exists) | P3 | P4 | P4 |

SLA targets per priority (first response, resolution) are set in `/org/it-security/kpis.md`. Use those; don't make up your own.

**Security first:** anything that might be a security issue (suspicious email or login, lost device, account acting oddly) goes to the Security Analyst at once, whatever its priority looks like.

## Categories

Use a small, stable set so trends are visible:

- Access request (needs approval)
- Account problem (locked, MFA reset, password)
- Device (hardware, OS, performance)
- Software or SaaS app (how-to, error)
- Network and connectivity
- Purchase or licence request
- Security report (route to Security Analyst)
- Other (review monthly; recurring "other" becomes a category)

## Daily routine

1. **New tickets:** categorise, set priority, assign. Send a first response within SLA, even if it is only "Got it; working on it, expect an update by <time>".
2. **Near SLA:** sort by time left. Work or escalate the ones about to breach.
3. **Waiting on requester:** nudge once; close after the policy's waiting period with a note on how to reopen.
4. **Patterns:** three tickets about the same thing today means an outage or a missing article. Check before answering one by one.

## Identity checks for account requests

MFA resets and password resets are favourite attacks. Before resetting:

- Verify the requester through a channel you already trust (a call to the number on file, the manager confirming on a known channel), not the channel the request came in on.
- Never reset based only on information an attacker could find (name, job title, manager's name).
- Record how you verified.

## Reply templates

**First response**
> Thanks — I've got this. It's <priority> and I'll update you by <time>.

**Need more information**
> To fix this I need: <one or two specific items>. Once I have them I'll pick it straight back up.

**Resolved**
> Fixed: <what was wrong, one line>. <What I did>. If it happens again, <self-help step or article link>. Reply here if it isn't working.

Keep replies short, specific and free of jargon.

## Knowledge-base articles

Write an article when the same question comes in twice or when the answer is a set of steps a person can follow.

```markdown
# <Task in the user's words: "Set up MFA on a new phone">
Applies to: <who, which devices>   Updated: <date>

## Before you start
<What you need.>

## Steps
1. <One action per step, exact names of buttons and menus.>
2. ...

## If it doesn't work
<The two or three most common problems and fixes.>
<When to open a ticket instead.>
```

Link the article in every reply that it answers, and count how often it is used. Update the date when the steps change.

## Pitfalls

- Treating the oldest ticket first regardless of priority.
- Closing tickets as resolved without the requester's confirmation where the policy requires it.
- Fixing the same problem repeatedly instead of finding the cause.

SLA formulas are in [IT admin metrics](it-admin-metrics.md).
