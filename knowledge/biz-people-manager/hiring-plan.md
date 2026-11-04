---json
{ "title": "Hiring plan", "summary": "A template and checks for justifying, sizing and scheduling a new role before its requisition opens.", "tags": ["hiring", "people", "planning", "template"], "updated": "2026-11-04" }
---

# Hiring plan

A requisition that opens without a plan tends to drift. The level shifts mid-search, the budget gets argued at offer stage, and the timeline is whatever happens. Write the plan first, get the accountable humans to approve it, then open the role. The plan lives in `/org/people/hiring/plan-<yyyy>-Q<n>.md` (one section per role). The approval is a decision recorded in `/org/decisions.md`.

## What every role needs before it opens

- **Role and outcomes.** What this person will have delivered after six and twelve months, in plain terms. Not a list of duties.
- **Why now.** The key result or project it serves, and what breaks or slows if the seat stays empty another quarter. "We're busy" isn't a reason. "Support first response has missed target for six weeks with the current team at capacity" is.
- **Alternatives considered.** Contractor, agency, redistributing work, an agent seat, automation, doing nothing. Say why each was rejected.
- **Level and band.** The level in the company's framework and the approved pay band. Pay is set by the humans who own compensation. You record what they approved and never invent a band.
- **Budget.** Fully loaded cost for the rest of the year (salary, employer costs, equipment, recruiting fees), taken from finance or a named person, or clearly labelled as an estimate.
- **Hiring manager and panel.** Who decides, who interviews, and whether they're available in the planned weeks.
- **Timeline.** The target start date worked backwards through notice period, offer, final interviews, screens and sourcing. If the start date is fixed, the open date follows from it.
- **Must-haves vs nice-to-haves.** Three to five must-haves that the scorecard will test. Everything else is a nice-to-have and shouldn't screen anyone out.

## Template

```markdown
## Role: <title> (<team>)
- Hiring manager: <name>   Approver(s): <names>
- Serves: <key result / project id>
- Why now: <what slips if unfilled, with the number and its source>
- Alternatives rejected: <contractor / redistribute / automate / wait, and why>
- Outcomes at 6 months: <1-3 lines>   at 12 months: <1-3 lines>
- Level: <level>   Band: <approved band, source: name/date>
- Budget this year: <amount> (<source, or "estimate: basis">)
- Must-haves (tested in scorecard): 1. … 2. … 3. …
- Nice-to-haves: …
- Panel: <names and stages>
- Timeline: open <date> → first screens <date> → finals <date> → offer <date> → start <date>
- Assumptions: <funnel ratios, notice period, market availability>
- Status: draft | approved (<decision link>) | open | filled | paused
```

## Worked example (made-up figures)

A support lead asks for a second support specialist. The plan says it serves the "first response time" key result. Why now: median first response has been above target for six straight weeks per the helpdesk source, and both current specialists are above their WIP limit. Alternatives: deflection content is in progress but won't cut volume enough on its own; a contractor was rejected because the product-knowledge ramp is too long for a short engagement. The target start is 1 March. With a four-week notice period and about three weeks of interviewing, the role has to open by early January. The budget comes from finance's forecast file, and the band from the compensation owner's note of 12 December.

Timeline maths uses the company's own history where it has it (median days per stage from past hires). Where it doesn't, label the assumption: "assumed 3 weeks screen-to-offer; no history yet".

## Checks before you mark it approved

- [ ] Why-now names a key result and a number with a source.
- [ ] Band and budget come from a named owner or a file, not from you.
- [ ] Must-haves are few, testable and job-related (see [Structured interviews](./structured-interviews.md)).
- [ ] Panel availability is confirmed for the interview weeks.
- [ ] The approver is a human with authority for this spend, and the approval is recorded.

## Common pitfalls

- **Writing the job description first.** It anchors on a past person instead of the outcomes the role needs.
- **Long must-have lists.** Every extra must-have shrinks the pool and invites filtering on proxies (school, past employer) that aren't the job.
- **Opening before budget is approved.** It wastes candidates' time and hurts the company's reputation when the role is pulled.
- **No pause rule.** Say what happens if plans change mid-search (freeze, reorg): who tells candidates, and how fast.
- **Forgetting that the start date is the goal.** Time to hire measures the process. The business cares about when the person is productive.
