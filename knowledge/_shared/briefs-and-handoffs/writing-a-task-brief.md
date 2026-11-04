---json
{ "title": "Writing a task brief", "summary": "How to brief a task so another agent or person can do it without coming back to ask: goal, context, done-when, constraints, inputs, deadline.", "tags": ["briefs", "delegation", "tasks", "templates"], "updated": "2026-11-04" }
---

# Writing a task brief

A brief is everything the person doing the work needs and doesn't already have. A good one gets the work done right first time. A bad one gets you a question back a day later, or the wrong thing done well.

Write it for someone smart who wasn't in the room: they don't know the backstory, the acronyms or what you tried last week.

## The six parts

1. **Goal**: the outcome in one or two sentences, and why it matters. "So that…" is often the most useful clause in the whole brief.
2. **Context**: what the reader needs to know to make good calls. That means the history, who asked, what's been tried and related work. Link to files instead of pasting them.
3. **Done when**: the checkable conditions that end the task. This becomes the task's `done_when` on the board, and the reviewer checks against it. Write it so a stranger could tick each line yes or no.
4. **Constraints**: the limits. Budget, tools, tone, what not to touch, what needs approval first, and anything that's out of scope.
5. **Inputs**: where to find what they need, with exact file paths, links and the people to ask. Say which metric source to use so they don't go hunting or guess.
6. **Deadline**: a date, and what happens if it slips. Say whether it's hard (a launch, a meeting) or soft.

Add an **owner** and a **reviewer** if the board doesn't already show them.

## Template

```markdown
# Brief: <short task name>

**Goal.** <Outcome in 1–2 sentences.> So that <why it matters>.

**Context.**
- <Background the reader needs; link files, don't paste them>
- Already tried: <what and how it went, or "nothing yet">

**Done when.**
- [ ] <Checkable condition 1>
- [ ] <Checkable condition 2>
- [ ] Output saved at </org/path/file.md> and review requested from <reviewer>

**Constraints.**
- <Budget / tools / tone / approvals needed>
- Out of scope: <what not to do>

**Inputs.**
- <File path or link> — <what it's for>
- Numbers: <metric source or file>; label anything else as an estimate
- Ask <named person/agent> about <topic>

**Deadline.** <YYYY-MM-DD>, <hard/soft>. If it'll slip, tell <owner> by <date>.
```

## Worked example

```markdown
# Brief: Pricing page competitor scan

**Goal.** A one-page comparison of how our three closest competitors price
team plans, so the CEO can decide in Thursday's meeting whether to add a
per-seat tier.

**Context.**
- We charge a flat workspace fee today (see /org/pricing/current.md).
- Two lost deals last month cited "no per-seat option" (/org/sales/lost-deals.md).
- Already tried: nothing.

**Done when.**
- [ ] Table of the 3 competitors in /org/sales/competitors.md: plan names,
      price, unit (seat/workspace), free tier, and the date each was checked
- [ ] Every price links to the public pricing page it came from
- [ ] 3–5 sentence "what this means for us", with facts and opinions marked
- [ ] Saved to /org/research/pricing-scan-2026-11.md; review requested from CEO

**Constraints.** Public sources only; don't contact competitors. Under 600 words.

**Inputs.** Competitor list: /org/sales/competitors.md. Ask the Sales lead
which plan we lose deals against.

**Deadline.** 2026-11-05 end of day, hard (needed for Thursday).
```

## Checklist before you send it

- [ ] Could someone new do this without asking you anything?
- [ ] Is every done-when line checkable yes/no?
- [ ] Are all inputs exact paths or links, not "the usual doc"?
- [ ] Is what's out of scope written down?
- [ ] Does the deadline say hard or soft?
- [ ] Is it short? Cut any background that doesn't change a decision the reader will make.

## Common pitfalls

- **Describing the activity, not the result.** "Look into pricing" has no end. "A comparison table saved at X" does.
- **Hidden constraints.** If you'll reject anything over budget or off-brand, say so up front.
- **Vague done-when.** "High quality" and "comprehensive" can't be checked. Name the sections, the length, the format and the reviewer.
- **Prescribing the method.** Say what and why. Leave how to the doer unless the how really matters.
- **Asking for numbers without saying where they come from.** You'll get guesses back. Name the source, or ask for estimates labelled as estimates.

When the work changes hands partway through, write a handoff instead. See [writing a handoff](./writing-a-handoff.md).
