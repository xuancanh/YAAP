---json
{ "title": "Problem framing template", "summary": "A one-page framing template (user, job, pain, evidence, success measure, constraints) with prompts that catch a brief solving the wrong problem.", "tags": ["problem framing", "template", "discovery", "jobs to be done"], "updated": "2026-11-04" }
---

# Problem framing template

Framing is cheap and redesigning is expensive. Spend the time here to agree what problem you're solving, for whom, and how you'll know it worked. Save as `/org/design/work/<slug>/frame.md` and get the product owner's agreement before flows.

## The template

```markdown
# Frame: <slug>

## The user
- Who: <role, context, experience level with the product>
- When: <the situation or trigger in which they hit this problem>

## The job
"When <situation>, I want to <motivation>, so I can <expected outcome>."

## Current experience and pain
- What they do today: <steps, workarounds, tools outside the product>
- Where it hurts: <the specific failure: time, errors, confusion, drop-off>

## Evidence
- <research note, support tickets, analytics, sales feedback — with links>
- Confidence: <high / medium / low> and why

## Success measure
- Primary: <task success rate / time on task / conversion / error rate> — baseline <x> — target <y>
- Guardrail: <what must not get worse, e.g. support tickets, other flows' completion>

## Scope
- In: <what this design covers>
- Out: <what it deliberately doesn't>

## Constraints
- Technical: <platform, data available, performance>
- Business: <pricing, legal, deadlines>
- Design system: <components available, gaps>
- Accessibility: WCAG 2.2 AA baseline (see accessibility-baseline)

## Open questions and assumptions
- Assumption: <…> — how we'll check: <…>

## Is this the right problem?
<your honest view, see prompts below>
```

## How to fill it well

**The user.** Specific enough to recruit for a test. "Admins" is a group; "an admin setting up the workspace for the first time, alone, on a deadline" is a person in a situation.

**The job statement.** Describes the motivation, not the feature. "I want a bulk-edit button" is a solution; "I want to fix the category on 200 imported transactions without doing it one by one" is the job.

**Evidence.** Link it. If there's none, label the frame low-confidence and plan a quick check first: five support tickets, a short analytics query or two interviews, before designing.

**Success measure.** Pick a measure you can actually collect: in a usability test (task success, time on task) or after release (completion rate, errors, tickets). Write the baseline. If there's no baseline, measure the current flow in the first test round.

**Guardrail.** Changes often move problems elsewhere. Name what must not get worse.

## Prompts that catch the wrong problem

Ask these before agreeing the frame. If several land, say so in the last section and to the product owner:

- Is the requested solution baked into the brief ("add a filter")? What's the underlying job?
- Does the evidence come from one loud customer or a pattern?
- Would better defaults, copy or an existing feature solve it without new UI?
- Is the pain caused upstream (bad data in, wrong permissions, a confusing earlier step)?
- If this works perfectly, which metric moves, and does anyone care about that metric?
- Who loses if we build it? (Other users, support, performance.)

## Worked example (abridged)

```markdown
## The user
A finance lead closing the month, after importing bank transactions.

## The job
"When I import a month of transactions, I want to correct miscategorised ones
quickly, so I can finish the close on time."

## Current pain
Edits one transaction at a time; support tickets mention "hours of clicking".

## Evidence
14 tickets in last 90 days tagged categorisation (link); 3 interview notes.
Confidence: medium.

## Success measure
Primary: time to recategorise 50 transactions in test — baseline 11 min (pilot run) — target under 3 min.
Guardrail: miscategorisation rate after edit does not rise.

## Is this the right problem?
Partly. Tickets suggest the auto-categoriser is wrong for one bank format.
Recommend fixing that with engineering in parallel; bulk edit still helps.
```

## Before moving to flows

- [ ] The product owner agrees with the frame (comment or approval recorded).
- [ ] The success measure has a baseline or a plan to get one.
- [ ] Open assumptions have an owner and a check.
- [ ] Any "wrong problem" concerns are written down and raised.
