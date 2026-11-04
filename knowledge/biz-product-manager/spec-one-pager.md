---json
{ "title": "Spec one-pager", "summary": "A copyable product spec (PRD one-pager) that engineering can estimate and an audit can check: problem with evidence, success metric, acceptance criteria, non-goals.", "tags": ["spec", "prd", "requirements", "templates", "product"], "updated": "2026-11-04" }
---

# Spec one-pager

A spec exists so engineering and design can estimate and build the right thing, and so you can later tell whether it worked. Keep it to one or two screens: long specs go unread and hide the decisions. The Product Owner writes it; you review it; the engineering lead reviews it for feasibility before it's accepted. Save specs as `/org/product/specs/<slug>.md`.

The KPI audit samples specs for four things: the problem with evidence, a success metric with a target, testable acceptance criteria, and non-goals. A spec missing any of them isn't ready.

## Template

```markdown
# Spec: <name>
Owner: <Product Owner> · Reviewers: <Head of Product>, <engineering lead>, <design lead>
Status: draft | in review | accepted | shipped · Roadmap item: <link> · KR: <name>

## Problem
<Who has the problem, in what situation, and what it costs them.>
Evidence: <interviews, usage data, support tickets, sales losses — each linked>

## Goal and success metric
Outcome: <the behaviour change we expect>
Metric: <definition from /org/product/kpis.md> · Baseline: <value, source> · Target: <value> by <date after launch>
Guardrails: <metrics that must not get worse, e.g. support tickets per account>

## Users and scope
Eligible users: <plans, segments, rollout group>
In scope: <the cases this covers>
Non-goals: <what this deliberately does not do, and why>

## Solution outline
<The approach at the level design and engineering need to estimate; link design files.>
Alternatives considered: <and why not>

## Acceptance criteria
1. Given <context>, when <action>, then <observable result>.
2. ...
Include empty, error and permission states.

## Instrumentation
Events: <name — fires when — properties>
Dashboard / source: <where the success metric will be read>

## Rollout
Flag: <name> · Stages: <internal → % → all> · Rollback: <how, who decides>
Launch tier: <major | minor | quiet>, agreed with the Head of Marketing

## Risks and open questions
- <question> — owner, needed by <date>

## Decision log
- <date> — <decision> (alternatives, who decided)
```

## Review checklist

- [ ] The problem is stated from the user's side and has at least one piece of real evidence.
- [ ] The success metric uses a definition already in kpis.md, has a measured baseline and a target.
- [ ] Every acceptance criterion is observable; "fast" or "intuitive" isn't.
- [ ] Non-goals are written. Scope creep starts where they're missing.
- [ ] Instrumentation is specified before build, not added after launch.
- [ ] The rollout has a rollback path and a named person who decides.
- [ ] No customer commitment or date appears without its owner's written agreement.
- [ ] Engineering has estimated it, and the estimate is theirs.

## Worked example (made-up)

Problem: admins of new team accounts add colleagues one by one; 6 of 8 interviewed admins gave up after three invites (interview notes linked). Metric: account activation (shared first report within 7 days), baseline 42% (analytics, W36–W39), target 50% by six weeks after launch. Non-goal: SCIM provisioning, which belongs to the enterprise SSO item. Acceptance criterion: "Given an admin pastes 20 addresses, when they press Invite, then 20 invites are sent and invalid addresses are listed with the reason."

## Common pitfalls

- Writing the solution first and the problem backwards from it.
- A success metric added at launch time, so the before-and-after can't be compared.
- Acceptance criteria that only cover the happy path.
- Specs that grow with every review instead of moving extras to non-goals or a follow-up.
