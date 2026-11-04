---json
{ "title": "Writing policies people follow", "summary": "A policy structure, plain-language rules, the difference between policy, standard and procedure, and a review checklist that keeps policies true.", "tags": ["policy", "security policy", "writing", "governance"], "updated": "2026-11-04" }
---

# Writing policies people follow

A security policy is a promise the company makes to itself, its customers and its auditors. An auditor will test it. If it promises more than the company does, it creates a finding; if nobody can understand it, nobody follows it.

## Policy, standard, procedure

Keep three levels apart so the policy stays short and stable:

| Level | Says | Changes | Example |
|---|---|---|---|
| **Policy** | What must be true and who is responsible | Rarely; approved by leadership | "All access to company systems requires MFA." |
| **Standard** | The specific, measurable requirement | When technology changes | "Admins use phishing-resistant MFA; SMS is not allowed for admins." |
| **Procedure** | Step-by-step how | Often; owned by the team | The IT Administrator's MFA enrolment steps |

Link down from the policy to the standards and procedures. Auditors usually test the policy against what the procedures and evidence show.

## Structure

```markdown
# <Policy name>
Owner: <role>   Approved by: <role>   Effective: <date>   Next review: <date>
Version: <n> — <one-line change summary>

## Purpose
<One or two sentences: the risk this policy manages.>

## Scope
<Who and what it covers: people (staff, contractors, agents), systems, data.
 What it does not cover.>

## Policy
<Numbered statements. Each one is a "must" that someone can check.>

## Roles and responsibilities
<Who does what; who approves exceptions.>

## Exceptions
<How to request one, who approves, how long it lasts, where it's recorded.>

## Related
<Standards, procedures, other policies, controls in the matrix.>
```

## Plain-language rules

- **One requirement per statement**, numbered so it can be referenced.
- **"Must"** for requirements, **"should"** only for recommendations, and use them consistently. Avoid "shall endeavour to".
- **Name roles, not people.**
- **Concrete over abstract:** "within one working day" instead of "promptly"; but put numbers that change often in a standard.
- **Short sentences, everyday words.** Explain any acronym the first time.
- **No aspirations.** If something is planned but not yet done, it goes in the roadmap or risk register, not in the policy.

## Making sure it is true

Before you propose a policy or a change:

- [ ] For each statement, find the evidence that it happens today, or the control in the matrix that covers it.
- [ ] Ask the owners of affected processes whether they can follow it as written.
- [ ] Check that the frequencies and deadlines match the evidence calendar.
- [ ] Check for conflicts with other policies and with contracts (customer agreements may promise specific things).
- [ ] Mark anything legal or regulatory (privacy, retention, breach notification) for review by Legal; these vary by jurisdiction.
- [ ] Map it to the framework requirements it supports.

Statements that fail the first check go back as either a rewrite to match reality or a gap with a plan.

## The core set

Most small companies pursuing SOC 2 or ISO 27001 end up with policies covering roughly these areas. Scope and names vary; check your auditor's expectations:

- information security (umbrella) and acceptable use;
- access control;
- asset management and data classification;
- change management and secure development;
- incident response;
- business continuity and backup;
- vendor management;
- risk management;
- human resources security (onboarding, training, offboarding).

Fewer, clearer policies are better than many overlapping ones.

## Review

- Each policy on its review date (yearly is common), after a significant incident, and when systems or frameworks change.
- Record the review even when nothing changes: date, reviewer, "no changes".
- Announce material changes to the people affected, in a short note saying what changed and what they need to do.

## Pitfalls

- Template policies with someone else's controls in them.
- Policies that duplicate procedures in detail, so they go stale.
- No exception process, which pushes people to ignore the policy quietly.
