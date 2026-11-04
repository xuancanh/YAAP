---json
{ "title": "Writing a handoff", "summary": "How to hand work to someone else, or to your future self, so they can pick it up cold: state, done and not done, decisions, open questions, where files live.", "tags": ["handoffs", "briefs", "tasks", "templates"], "updated": "2026-11-04" }
---

# Writing a handoff

A handoff is what you leave when work changes hands: at the end of a task run, when you pass work to another agent, or when you stop partway through. The reader wasn't there. They should be able to carry on from your note alone, without opening a chat log.

The test: if the next person reads only this, can they take the next step in five minutes?

## What goes in

1. **Status in one line.** Done, blocked, in progress, or abandoned, and how close to the done_when.
2. **Done.** What's finished, with where it lives. Link files and don't describe what's in them.
3. **Not done.** What's left against the done_when, in the order you'd do it.
4. **Decisions made.** Anything you chose that the next person might otherwise undo, with the reason. Log the big ones in `/org/decisions.md` and link the entry.
5. **Open questions.** What you don't know, and who might. Put each as a question with a named person to ask.
6. **Files and inputs.** Exact paths and links for everything they'll need, including the metric sources you used.
7. **Watch out for.** Traps you found: a stale file, a tool that times out, a stakeholder who wants to see drafts first.
8. **Next step.** The single first thing to do.

Skip any section that's empty, but say "none" for decisions and open questions so the reader knows you thought about it.

## Template

```markdown
## Handoff: <task name> — <YYYY-MM-DD>

**Status.** <In progress / blocked / done>: <one line, e.g. "2 of 3 done-when items met">.

**Done.**
- <Item> — </org/path/file.md>

**Not done.**
- [ ] <Remaining done-when item>
- [ ] <Next one>

**Decisions.**
- <What I chose> because <why>. (Logged: /org/decisions.md, <date> entry / not logged: small)

**Open questions.**
- <Question>? Ask <named person/agent>.

**Files.**
- </org/path> — <what it is>
- Numbers from: <metric source / file>; anything else is marked as an estimate

**Watch out for.** <Trap, or "nothing found">.

**Next step.** <The one thing to do first>.
```

## Worked example

```markdown
## Handoff: Pricing page competitor scan — 2026-11-05

**Status.** In progress: table done, write-up not started.

**Done.**
- Competitor table, 3 rows, each price linked and dated — /org/research/pricing-scan-2026-11.md

**Not done.**
- [ ] "What this means for us" section (3–5 sentences)
- [ ] Request review from the CEO

**Decisions.**
- Compared annual-billing prices, because two of the three don't show
  monthly team pricing publicly. Not logged (small, noted in the file).

**Open questions.**
- Which plan do we usually lose to? Ask the Sales lead; no reply yet.

**Files.**
- /org/sales/lost-deals.md — the two deals that cited per-seat pricing
- Prices: the competitors' public pricing pages, checked 2026-11-05

**Watch out for.** One competitor's page shows a different price when logged in;
I used the public one.

**Next step.** Write the summary; the meeting is tomorrow morning.
```

## Checklist

- [ ] The status line says where things stand against the done_when
- [ ] Every finished item has a path or link
- [ ] Decisions include the reason
- [ ] Each open question names who to ask
- [ ] No unexplained shorthand, codes or "as discussed"
- [ ] One clear next step

## Common pitfalls

- **A diary instead of a state.** "First I did X, then Y" makes the reader rebuild the state themselves. Say where things are now.
- **Saying "almost done".** List exactly what's left.
- **Losing the why.** A decision without its reason gets reversed by the next person.
- **Files only you can find.** Durable work goes under `/org/`, at a path you write out in full.
- **Numbers with no source.** The next person will repeat them as facts. Give the source, or mark them as estimates.

To brief new work rather than hand off existing work, see [writing a task brief](./writing-a-task-brief.md).
