---json
{ "title": "Campaign brief", "summary": "A copyable campaign brief that fixes the goal, audience, offer, success metric and approvals before any work starts, plus a review checklist.", "tags": ["campaigns", "briefs", "calendar", "marketing"], "updated": "2026-11-04" }
---

# Campaign brief

Every campaign on the monthly calendar gets a brief before work starts. The brief is where the success metric is set, and the KPI audit checks that it was set before launch, not written in afterwards. Save it as `/org/marketing/campaigns/<yyyy-mm>-<slug>.md` and link it from the calendar row and from every task under it.

## Template

```markdown
# Campaign: <name>
Owner: <member> · Reviewer: <a different member> · Status: draft | approved | live | closed
Calendar: /org/marketing/calendar/<yyyy-mm>.md · Positioning: /org/marketing/positioning.md

## Goal
Key result served: <KR name and id>
Outcome: <what changes if this works, e.g. "20 SQLs from mid-market finance teams">

## Audience
Segment: <who, defined by targetable characteristics>
Where they are: <channels, lists, keywords>
Excluded: <current customers, competitors, ...>

## Offer and message
Offer: <what they get: a guide, a trial, a webinar, a demo>
Core message: <one line drawn from the positioning pillars>
Proof points: <each with its source>

## Channels and assets
| Channel | Asset | Owner | Due | Depends on |
|---|---|---|---|---|

## Budget
Spend: <USD> from <budget line in /org/marketing/budget.md>
Stop-loss: pause if <cost per SQL> exceeds <amount> after <days or spend>

## Success metric (set before launch)
Primary: <metric> target <value> measured from <source> by <date>
Leading signal: <e.g. landing page conversion> target <value>
Tracking: UTMs <pattern>, events <names>, dashboard <link>

## Approvals (nothing outward without them)
- Copy and claims: <approver>
- Spend: <approver>
- Disclosure line present: yes / no

## Dates
Launch: <date> · End: <date> · Results check: <date>

## Result (filled in at close)
Actual vs target, with counts; what we'd repeat; what we'd drop.
```

## How to brief the work under it

Each task you create from the campaign uses the four-field brief from your team-management playbook. Its done_when should be checkable against this brief, for example: "landing page live on staging with the core message from the brief, UTMs matching the pattern, form event firing in the analytics source, copy approved by <approver>".

## Review checklist

- [ ] The key result is named, and the campaign is the best use of the budget for it this month.
- [ ] The audience can actually be reached through the listed channels.
- [ ] The message comes from the positioning doc, not invented for this campaign.
- [ ] The success metric has a target, a source and a date, and was written before launch.
- [ ] The stop-loss rule exists for any paid spend.
- [ ] Tracking is specified concretely enough for someone else to test it.
- [ ] Assets that depend on design or product are tasks with `dependsOn` and accepted handoffs, not hopes.
- [ ] Approvals are named people, and the disclosure line is in every outward draft.
- [ ] Owner WIP checked with `org_capacity`.

## Worked example (made-up)

"Month-end close guide" serves the KR "SQLs accepted by sales: 60 this quarter". Audience: finance leads at 50–500 person companies, reached through search and a partner newsletter. Offer: a downloadable checklist. Primary metric: 15 SQLs from the campaign's UTMs in the CRM by the 30th. Stop-loss: pause paid search if cost per SQL is above $700 after $2,000 spent. At close, the result section reads "11 SQLs (target 15), $640 per SQL; partner newsletter produced 7 of them; repeat the newsletter, drop the generic keywords".

## Common pitfalls

- A goal of "awareness" with no metric. If it serves brand, name the brand measure and its source.
- A brief written after launch to match the result.
- Too many channels for the budget, so no channel gets enough spend to read.
- The result section left empty, so next month's calendar can't learn from it.
