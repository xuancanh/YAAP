---json
{ "title": "Usability heuristics", "summary": "Nielsen's 10 usability heuristics with what to look for, Nielsen's 0-4 severity scale, and how to run and record a heuristic evaluation.", "tags": ["heuristics", "usability", "evaluation", "severity", "design"], "updated": "2026-11-04",
  "sources": [
    { "title": "10 Usability Heuristics for User Interface Design", "url": "https://www.nngroup.com/articles/ten-usability-heuristics/", "author": "Jakob Nielsen", "publisher": "Nielsen Norman Group", "date": "1994", "note": "The 1994 list, still current; the article has had minor wording updates." },
    { "title": "How I Developed the 10 Usability Heuristics", "url": "https://jakobnielsenphd.substack.com/p/usability-heuristics-history", "author": "Jakob Nielsen", "accessed": "2026-11-04", "note": "History: first list with Rolf Molich in 1989; revised 1994 from a factor analysis of 249 usability problems." },
    { "title": "Severity Ratings for Usability Problems", "url": "https://www.nngroup.com/articles/how-to-rate-the-severity-of-usability-problems/", "author": "Jakob Nielsen", "publisher": "Nielsen Norman Group" }
  ] }
---

# Usability heuristics

Jakob Nielsen's ten heuristics (1994, building on a first list with Rolf Molich) are broad rules of thumb for interaction design. Use them as a shared vocabulary in crit and as the checklist for a heuristic evaluation: a quick expert review that finds likely problems before (not instead of) testing with users.

## The ten heuristics and what to look for

1. **Visibility of system status**: the user always knows what's happening. Look for: loading and progress indicators, confirmation after saving, the current step in a multi-step flow.
2. **Match between the system and the real world**: the user's words and concepts, not internal jargon. Look for: labels a new user would understand, sensible ordering, familiar metaphors.
3. **User control and freedom**: a clear way out. Look for: undo, cancel, back, closing a dialog without losing work.
4. **Consistency and standards**: the same thing looks and works the same way everywhere, and follows platform conventions. Look for: one-off components, the same action named two ways.
5. **Error prevention**: stop errors before they happen. Look for: constraints and good defaults, confirmation before destructive actions, inline validation.
6. **Recognition rather than recall**: show options instead of making users remember them. Look for: visible choices, recent items, context carried between steps.
7. **Flexibility and efficiency of use**: shortcuts for frequent users that don't get in novices' way. Look for: keyboard shortcuts, bulk actions, saved settings.
8. **Aesthetic and minimalist design**: no content competing with what matters. Look for: clutter, rarely needed information shown by default, weak visual hierarchy.
9. **Help users recognize, diagnose, and recover from errors**: error messages in plain language that say what went wrong and how to fix it. Look for: codes without explanation, blame, messages far from the field.
10. **Help and documentation**: help that's easy to find, task-focused and short, ideally in context.

## Severity scale

Nielsen's scale for rating each problem:

| Rating | Meaning | Default action |
|---|---|---|
| 0 | Not a usability problem | none |
| 1 | Cosmetic: fix if time allows | consider |
| 2 | Minor: low priority | consider, or backlog |
| 3 | Major: important to fix, high priority | must-fix before ship |
| 4 | Usability catastrophe: must fix before release | must-fix, blocks ship |

Severity combines how often the problem occurs, how hard it is to overcome, and whether it keeps bothering users once they know it. One evaluator's ratings are unreliable; where you can, have two or more members rate independently and take the average. The mapping from rating to action is a company default in `/org/design/kpis.md`.

## Running a heuristic evaluation

1. Pick the flows from the brief and the user it's for.
2. Each evaluator goes through the flows alone, twice: once for the overall flow, once screen by screen, noting each problem, where it occurs and the heuristic it breaks.
3. Merge the lists, remove duplicates, then rate severity independently and average.
4. Record and file must-fixes as tasks.

```markdown
# Heuristic evaluation: <flow> — <date>
Evaluators: <members> · Brief: <link> · Build/file: <link>
| # | Location | Problem | Heuristic | Severity (avg) | Action |
|---|---|---|---|---|---|
| 1 | Invite dialog | Error "E104" on invalid email | 9 | 3 | must-fix: task <id> |
Summary: <count by severity>; next usability round to check items <#s>
```

## Common pitfalls

- Treating a heuristic evaluation as user evidence. It finds likely problems; testing confirms which ones users actually hit.
- Citing a heuristic to win an argument about taste. Name the specific user impact.
- Rating severity alone, or rating everything 3 so all of it becomes must-fix.
- Only one evaluator: different people find different problems.
