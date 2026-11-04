---json
{ "title": "Giving review", "summary": "How to review someone's work against its done-when with specific, actionable comments labelled by severity (blocker, should, nit), and how to decide: approve, approve with comments, or request changes.", "tags": ["review", "feedback", "quality", "conventional-comments"], "updated": "2026-11-04",
  "sources": [
    { "title": "Conventional Comments", "url": "https://conventionalcomments.org/", "accessed": "2026-11-04", "note": "Comment labels and blocking / non-blocking decorations" }
  ] }
---

# Giving review

A review answers one question first: **does this meet its done-when?** Everything else (style, preferences, ideas) comes second and should be labelled that way. The goal is to get good work shipped, not to make the work match how you'd have done it.

## Before you start

- **Read the brief and the done-when** on the task. Review against them, not against an ideal in your head.
- **Know what kind of review was asked for:** a quick sanity check, a full review, or a check of one specific part. If it's unclear, ask in one line.
- **Set aside time to read the whole thing** before you comment, so your first comment isn't about something answered later on.

## What to check

1. **Done-when**: is every condition met? Tick each one in your review.
2. **Correctness**: are the facts right? Does every number have a source or an estimate label? Do the links and file paths resolve?
3. **Fit for the reader**: will the person it's for be able to use it? Does it lead with the point?
4. **Risks**: anything that could cause harm, embarrassment, cost or a one-way-door problem if it ships as is?
5. **Polish**: wording, formatting, consistency. Only after the above.

## Make every comment specific and actionable

Each comment should say *where*, *what's wrong* and *what would fix it*:

- Weak: "The numbers seem off."
- Strong: "Section 2, the '40% activation' figure has no source. Is it from the activation_w1 dashboard? If it's an estimate, label it."

Explain why when it isn't obvious. Ask a real question when you're unsure, rather than stating a guess as a problem.

## Label severity

Put a label at the start of each comment so the author knows what must change. A simple three-level set:

| Label | Means | Blocks approval? |
|---|---|---|
| **blocker** | Fails the done-when, is wrong, or is risky. Must be fixed | Yes |
| **should** | A real improvement. Fix it unless there's a good reason not to, and say what that reason is | No, but expect a reply |
| **nit** | Minor or personal preference. Take it or leave it | No |

Also useful: **question** (you need an answer before you can judge) and **praise** (name what's good, so it stays good).

This mirrors [Conventional Comments](https://conventionalcomments.org/), which uses labels like `issue`, `suggestion`, `nitpick`, `question` and `praise`, with `(blocking)` or `(non-blocking)` decorations. If your company already uses that format, use it:

```
issue (blocking): The revenue figure in the summary has no source.
Add the billing report link, or mark it as an estimate.
```

## Decide

End with one clear verdict:

- **Approve**: meets the done-when, no blockers.
- **Approve with comments**: no blockers, but some shoulds or nits. The author can fix them and ship without another review. This should be your most common verdict.
- **Request changes**: at least one blocker. Say exactly what needs to happen for approval, so the next round is the last.

## Template

```markdown
**Review: <task name>** — <verdict>

Done-when:
- [x] <condition> 
- [ ] <condition> — see blocker 1

1. **blocker:** <where> — <what's wrong> — <what would fix it>
2. **should:** <where> — <suggestion> because <why>
3. **nit:** <where> — <small thing>
4. **praise:** <what works well>

To approve: fix 1. The rest is up to you.
```

## Common pitfalls

- **Reviewing against your taste,** not the brief. If it meets the done-when, your preferred approach is a nit.
- **Unlabelled comments.** The author can't tell what's required and treats every comment as a blocker, or none of them.
- **Death by nits.** Twenty nits hide the one blocker. Group them, or drop most.
- **Vague verdicts.** "Looks mostly fine, a few things" leaves the author stuck. Say approve or request changes.
- **Moving goalposts.** Don't raise new blockers in round two that were there in round one, unless they're serious.
- **Rewriting it yourself.** Point out the problem and suggest a fix. Leave the work with its owner.

For the other side, see [receiving review](./receiving-review.md).
