---json
{ "title": "Blameless postmortems", "summary": "When a postmortem is due, a copyable template, and how to turn contributing causes into prevent, detect and mitigate actions that get done.", "tags": ["incidents", "postmortem", "engineering", "reliability"], "updated": "2026-11-04",
  "sources": [
    { "title": "Site Reliability Engineering, chapter 15: Postmortem Culture: Learning from Failure", "url": "https://sre.google/sre-book/postmortem-culture/", "publisher": "Google", "accessed": "2026-11-04" }
  ] }
---

# Blameless postmortems

Your engineering-incident-review playbook gives the steps. This doc holds
the trigger list, the template, and the judgment calls that separate a
postmortem that changes something from one that gets filed and forgotten.

## When one is due

Agree the triggers before an incident happens and write them into
`/org/engineering/kpis.md`. A common starting set, adapted from Google's SRE
book; the company sets every threshold:

- user-visible downtime or degradation beyond a set duration;
- any data loss, or data exposed to someone who shouldn't see it;
- on-call had to intervene: a rollback, a traffic shift, a manual fix;
- time to restore beyond a set threshold;
- the problem was found by a person or a customer, not by monitoring;
- the same minor incident a third time (repeats are one postmortem, not
  three tickets).

Anyone can ask for a postmortem. Saying yes is cheap; skipping one teaches
the team that only big outages count.

## What "blameless" means here

Assume everyone acted in good faith on what they knew at the time. The
question is never "who did this" but "what let a reasonable person, or
agent, do this and not notice". Blameless does not mean soft: you still
name the change, the missing test and the gap in the runbook. You just
don't stop at a name. "The engineer didn't run the migration check" leads
straight to "why was the check optional?".

Agents are no exception. When an agent's change caused it, the causes are
the brief, the done_when, the checks and the review, the same as for a
person.

## Template

Save as `/org/engineering/postmortems/<date>-<slug>.md`.

```markdown
# <Title: what users saw, not the internal cause>
Severity: minor | major | critical    Status: draft | reviewed | actions open | closed
Incident: <org_incidents id>    Author: <member>    Reviewer: <member>

## Summary
Two or three sentences: what broke, for whom, for how long, how it was fixed.

## Impact
- Users/customers affected: <number and source, or "unknown, estimating via …">
- Duration: <start → restored, UTC>
- Data lost or exposed: <none / what>
- Error budget consumed: <% of period budget, if an SLO exists>

## Timeline (UTC)
| Time | Event | Who | Evidence |
|---|---|---|---|
| 09:12 | Deploy 4821 to production | CI | deploy log |
| 09:31 | First customer report | Support | ticket link |
| 09:40 | Acknowledged by on-call | SRE | page log |
| 09:58 | Rolled back; errors back to baseline | SRE | dashboard |

Time to detect: <first impact → detection>. Time to restore: <first impact → restored>.

## Contributing causes
Each a fact with evidence. Several are normal; "root cause" is usually plural.

## What went well
Detection, a runbook that worked, a quick rollback: keep these.

## Actions
| Kind | Action | Owner | Due | Task |
|---|---|---|---|---|
| prevent | Make migration check blocking in CI | Software Engineer | <date> | ENG-… |
| detect | Alert on 5xx rate per endpoint | SRE | <date> | ENG-… |
| mitigate | Add a rollback step to the runbook | SRE | <date> | ENG-… |
```

## Getting from causes to actions

Ask "why" until you reach something the team controls, but don't force it
to five, and don't follow a single chain. Incidents usually need several
things to go wrong together: a risky change, a missing test, an alert that
didn't fire, a slow rollback. Each is a place to act.

Good actions are specific, owned and small enough to land soon. "Improve
testing" is not an action; "add an integration test for the refund path
that runs on every PR" is. Prefer actions that change the system (a guard,
an alert, an automated check) over actions that ask people to be more
careful. At least one should land within the next sprint, or the
postmortem was a report, not a review.

## Checklist before you post it

- [ ] Timeline built from evidence (logs, deploy records, messages), not
      memory.
- [ ] Impact has numbers with their source, or says it's unknown.
- [ ] No sentence blames a person or agent; causes are conditions.
- [ ] Every action is a briefed task with owner and dueAt.
- [ ] Someone who wasn't involved has reviewed it (`org_request_review`).
- [ ] Customer-facing wording, if any, is a draft for a human.

## Common pitfalls

- **Actions that never close.** Track them in the weekly review; an action
  past its date goes into the report as a risk.
- **Too many actions.** Ten actions means none get done. Pick the three
  with the most effect and log the rest in the backlog.
- **Writing it weeks later.** Memory fades and logs roll over. Draft the
  timeline within a day or two of restoring service.
- **Stopping at "human error".** It names the symptom, not the cause.
