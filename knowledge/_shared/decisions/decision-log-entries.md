---json
{ "title": "Decision log entries", "summary": "How to log a decision in /org/decisions.md so it can be found and trusted later, and how to be clear about who decides (DACI, RAPID).", "tags": ["decisions", "decision-log", "roles", "daci", "rapid"], "updated": "2026-11-04",
  "sources": [
    { "title": "DACI: a decision-making framework", "url": "https://www.atlassian.com/team-playbook/plays/daci", "publisher": "Atlassian Team Playbook", "accessed": "2026-11-04" },
    { "title": "RAPID: Bain's tool to clarify decision accountability", "url": "https://www.bain.com/insights/rapid-decision-making/", "publisher": "Bain & Company", "date": "2023-10-13", "accessed": "2026-11-04" }
  ] }
---

# Decision log entries

The decision log (`/org/decisions.md`) is the company's memory of *why*. When someone asks "why do we do it this way?", the answer should be one search away. Without a log, settled questions get argued again, and new people undo good choices by accident.

## What to log

Log a decision when any of these is true:

- It's a one-way door: hard or costly to undo. See [making a decision](./making-a-decision.md).
- It changes a target, a budget, a price, a policy or a published commitment.
- It affects another team's work.
- Someone could reasonably undo it later if they didn't know the reason.
- It drops or resets a key result.

Don't log routine two-way calls that stay inside one task. A line in the task or handoff covers those.

## The entry format

Newest first. Keep each entry short, and link to the full record or file for detail.

```markdown
## 2026-11-04 — Add a per-seat team plan
- **Decision.** Add a per-seat team plan alongside the flat workspace plan from 2027-01-01.
- **Why.** Two lost deals cited no per-seat option (/org/sales/lost-deals.md); all three
  close competitors offer one (/org/research/pricing-scan-2026-11.md).
- **Options considered.** Per-seat only; add per-seat; do nothing.
- **Decider.** CEO. **Consulted.** Sales lead, Finance manager. **Informed.** All heads.
- **Door.** One-way (public price). **Revisit.** 2027-03-31, or if team-plan sign-ups
  stay below target for 2 months (source: billing report).
- **Record.** /org/decisions/2026-11-per-seat-plan.md
```

Required fields: date, decision, why (with sources), decider. The others are strongly recommended.

When a decision is reversed, don't edit the old entry. Add a new one that says "Supersedes <date> — <title>", and add "Superseded by <date>" to the old entry's first line.

## Who decides

Most stalled decisions are stalled on who, not what. Before you start, name one decider. Two common frameworks make the roles explicit.

**DACI** (Atlassian's Team Playbook):

- **Driver**: runs the process, gathers input and gets it decided by a date.
- **Approver**: the one person who makes the call. Atlassian stresses there is only one.
- **Contributors**: have knowledge and a voice, but not a vote.
- **Informed**: told the outcome.

**RAPID** (Bain & Company):

- **Recommend**: drives the process and makes the proposal.
- **Agree**: must sign off that it meets hard requirements (legal, regulatory).
- **Perform**: carries it out.
- **Input**: gives expertise or facts.
- **Decide**: makes the final call and commits the organisation.

Use whichever your company uses. If it uses neither, a simple version works: *one decider, the people consulted, the people informed.* Usually the agent writing the record is the Driver or Recommender, not the decider. When it's unclear who decides, ask your manager or the Chief of Staff before you do the analysis, not after.

## Writing the entry well

- **Lead with the decision**, phrased as what will happen, not as a topic. "Add a per-seat plan from 2027-01-01", not "Pricing discussion".
- **Put the reason in one or two sentences**, with links to the evidence.
- **Source every number**, or mark it as an estimate.
- **Add a revisit trigger** for anything uncertain: a date or a signal that would reopen it.
- **Use names or roles, not "we".** Readers need to know who to ask.

## Checklist

- [ ] Worth logging (one-way, cross-team, or changes a commitment)
- [ ] Decision written as an action, with a date
- [ ] Why, with linked sources
- [ ] One named decider
- [ ] Revisit date or trigger
- [ ] Old entry marked as superseded if this reverses something

## Common pitfalls

- **Logging discussions, not decisions.** If nothing was decided, it isn't a log entry. It's an open question in the minutes.
- **Editing history.** Reversals get new entries, so the trail stays intact.
- **Decided by nobody.** "The team agreed" can't be followed up. Name the decider.
- **Logging and not telling.** The Informed people still need a message. Logging alone doesn't inform anyone.
