---json
{ "title": "Blameless postmortem template", "summary": "When to write a postmortem, a template, and how to find contributing causes and write action items that actually prevent a repeat.", "tags": ["postmortem", "blameless", "incident review", "template"], "updated": "2026-11-04",
  "sources": [{ "title": "Google SRE Book, Postmortem Culture: Learning from Failure (read 2026-11-04)", "url": "https://sre.google/sre-book/postmortem-culture/" }] }
---

# Blameless postmortem template

A postmortem exists to change the system so the same failure cannot happen the same way again. It assumes everyone acted in good faith on what they knew at the time. If people fear blame, they hide the details you need.

## When to write one

Google's SRE book lists triggers like these; agree your own with the Head of Engineering:

- user-visible downtime or degradation beyond an agreed threshold;
- any data loss;
- on-call intervention such as a rollback or rerouting traffic;
- resolution time above a threshold;
- a monitoring failure, meaning a person found the problem before an alert did.

Anyone can ask for one. Write the timeline draft within a day while memory is fresh.

## Template

```markdown
# Postmortem: <title> — <date>
Severity: <n>   Lead: <name>   Status: <draft | reviewed | actions done>

## Summary
<Three sentences: what users experienced, for how long, what fixed it.>

## Impact
- Duration: <start> to <end> UTC (<minutes>)
- Users / requests affected: <number or estimate, labelled as such>
- Error budget consumed: <% of the month's budget>
- Data: <lost / corrupted / none>
- Customer communications: <what was sent, by whom>

## Timeline (UTC)
<From the incident timeline. Include detection, each decision, mitigation, recovery.>

## Detection
<How we found out. How long between start and detection. Did an alert fire?>

## Contributing causes
<The conditions that together made this possible. See method below.>

## What went well
<Things to keep: a fast rollback, a good runbook.>

## What was hard
<Missing dashboards, unclear ownership, slow access, confusing alerts.>

## Action items
| Action | Type | Owner | Due | Task |
```

## Finding contributing causes

Incidents rarely have one root cause. Look for the chain of conditions.

1. **Start from the trigger** (a deploy, a traffic spike, an expiring certificate).
2. **Ask why it caused harm**, then why that was possible, several levels deep. Keep each answer about systems and processes: "the deploy pipeline allowed a migration without a dry run", not "X forgot".
3. **Ask why detection and recovery took as long as they did.** These are often the cheapest wins.
4. **Check the defences that should have stopped it:** tests, review, canary, alert, rate limit. Which existed? Which failed, and why?

If an answer is "human error", keep going: what made the error easy to make and hard to notice?

## Action items that prevent repeats

Each action should be specific, owned, dated and tracked as a task. Mix types:

| Type | Purpose | Example |
|---|---|---|
| Prevent | Stop the trigger | Migrations require a dry run on a copy |
| Detect | Find it sooner | Burn-rate alert on the import job's freshness SLI |
| Mitigate | Reduce harm | Feature flag around the new importer |
| Process | Improve response | Runbook for "import backlog growing" |

Avoid vague actions ("be more careful", "improve monitoring"). Prefer fewer actions that get done over a long list that does not. Close the postmortem only when the actions are done or explicitly dropped with a reason.

## Review

Share the draft with everyone involved before the incident review. Ask: is the timeline right, is anything missing, would these actions have stopped it? Then hand it to the Head of Engineering's review.
