---json
{ "title": "Critique standards", "summary": "How to give crit and review feedback that is tied to the brief, labelled by severity and actionable, with a submission template and a crit notes template.", "tags": ["critique", "review", "feedback", "crit", "design"], "updated": "2026-11-04" }
---

# Critique standards

Crit exists to make the work better before it ships, not to rank designers or pick the critic's favourite. Feedback is judged by one test: could the designer act on it, and does it trace back to the brief, a user, or a written standard? "I don't like the blue" fails that test; "the blue link fails contrast on the grey card (2.9:1, needs 4.5:1)" passes.

## Submission (what the designer brings)

```markdown
## Crit submission: <work>
Brief: <link> · Stage: exploration | refinement | final
The question I want answered: <one specific question>
What changed since last crit: <...>
Known gaps: <states not done yet, open decisions>
Files / prototype: <link>
```

Match the feedback to the stage. In exploration, debate the approach and flow; don't nitpick spacing. In final, the approach is settled; focus on system use, accessibility, content and edge states.

## Order of review

Work top-down; a polished screen that solves the wrong problem is the most expensive kind of rework.

1. **Problem fit**: does it solve the problem in the brief, for the user in the brief?
2. **Flow**: can the user get from start to goal? Where would they hesitate or get lost? Use the [usability heuristics](./usability-heuristics.md) as a shared vocabulary.
3. **System and accessibility**: system components used correctly; the [accessibility checklist](./accessibility-checklist.md) passes.
4. **Content**: labels, errors and empty states are clear and in the voice guide.
5. **Visual polish**: hierarchy, alignment, spacing, consistency.

## Writing each piece of feedback

- **Observation, then reason, then (optionally) a suggestion.** "A first-time admin may not see the bulk option, because it sits below the fold on a laptop screen. Consider moving it next to the single invite field."
- **Label it.** *Must-fix*: blocks shipping (breaks the brief, a heuristic at severity 3–4, an accessibility failure, a system violation without a governance proposal). *Consider*: would improve it, designer's call.
- **Tie it to a source**: the brief, research, a heuristic, a WCAG criterion, a system rule. If you can't name one, say it's an opinion and label it consider.
- **One point per comment**, so each can be resolved separately.
- **Answer the designer's question** first, before anything else.

## Crit notes template

Save to `/org/design/crit/<date>.md`:

```markdown
# Design crit — <date>
## <work> (<designer>, <stage>)
Question asked: <...> → Answer: <...>
Must-fix:
- <observation — reason/source> → action owner, due
Consider:
- <...>
Decisions: <recorded with meeting_propose_decision or task comment>
## Patterns this week
- <issue seen in more than one piece of work> → proposed principle or system update
```

## As reviewer in `org_review`

Accept when the done_when evidence is present and no must-fix is open. Request changes with the specific must-fix items listed; never "needs work". After the third round, escalate rather than continuing the loop: the brief or the constraints are probably wrong.

## Common pitfalls

- Feedback as preference ("I'd make it bigger") with no reason.
- Redesigning the work in the crit instead of naming the problem and letting the designer solve it.
- Pixel feedback on exploration work, approach feedback on final work.
- Must-fix and consider mixed together, so the designer can't tell what blocks shipping.
- Patterns noticed weekly but never turned into a principle or system change.
