---json
{ "title": "Consistency review rubric and metrics", "summary": "A scoring rubric for the monthly brand consistency review and formulas for brand consistency, asset turnaround and template reuse.", "tags": ["brand consistency", "review", "rubric", "metrics", "kpis"], "updated": "2026-11-04" }
---

# Consistency review rubric and metrics

The monthly review should produce numbers you can compare month to month, plus fixes aimed at causes. A list of nitpicks without a pattern doesn't change anything.

## Sampling

- Sample across owners and channels: site pages, social posts, emails, decks, documents, product marketing assets, and support or sales material if it goes to customers.
- Use the same mix each month, roughly, so scores compare. Before a big launch, add launch assets.
- Record each item: link, owner, channel, date, and whether it was made from a template.

## Rubric

Score each item on six criteria. Each criterion is **pass** (2), **minor drift** (1) or **off-brand** (0).

| Criterion | Pass | Minor drift | Off-brand |
|---|---|---|---|
| **Logo** | Correct version, size, clear space | Slightly small or tight | Distorted, recoloured, wrong version |
| **Colour** | Palette and approved pairs | Off-palette accent | Unapproved colours or failing contrast |
| **Typography** | Brand or approved fallback fonts and scale | Inconsistent sizes or weights | Wrong typeface |
| **Imagery** | Matches style; rights recorded | Style mismatch | Off-style or unlicensed |
| **Layout** | Grid and template structure | Crowded or misaligned | Ignores structure; unreadable at size |
| **Tone of copy** | Matches voice guide | Small slips | Wrong voice, off-message |

Item rating from the total (out of 12):

- **Consistent:** 11–12, no zero on any criterion.
- **Minor drift:** 8–10, or any one zero that is cosmetic.
- **Off-brand:** below 8, or a zero on logo or contrast.

Accessibility failures (contrast below the approved pairs, missing alt text) count as off-brand on their criterion. They exclude people, not just look wrong.

## Metric definitions

### Brand consistency of sampled output

```
Consistency rate = items rated consistent / items sampled
Average score    = sum of item scores / (items sampled × 12)
```

Report both, with sample size. Small samples swing, so look at three-month trends.

### Asset turnaround

```
Turnaround (asset set) = approval date − brief-complete date (working days)
First-pass approval rate = asset sets approved without a second round / asset sets delivered
```

- Report the median turnaround, not the mean; one complex campaign skews the average.
- Track **brief wait** (request date to brief-complete) separately, so slow briefs are visible and fixable.

### Template reuse

```
Template reuse rate = sampled items of a templated format made from the current template
                      / sampled items of a templated format
```

Also compare consistency rates: items made from templates vs not. If templated items aren't more consistent, the template needs work.

## Finding causes

For each drift, ask why it happened:

| Pattern | Likely cause | Fix |
|---|---|---|
| Same mistake by different people | Guideline unclear or template missing | Clarify rule, add or fix template |
| One owner, many issues | Not aware of guidelines or templates | Short walkthrough, point to templates |
| Old logo or colours | Stale files in circulation | Archive old files, update shared folders |
| Off-brand fonts in documents | Brand font not installed or not licensed for that tool | Approved fallback in templates |
| Contrast failures | Palette pairs not documented | Add accessible pairs table |

## Report template

```markdown
# Brand review — <yyyy-mm>

## Scores
| Metric | This month | Last month | 3-month trend | Sample |
| Consistency rate | | | | n= |
| Average score | | | | |
| Median turnaround (days) | | | | sets= |
| Template reuse rate | | | | |

## Items
| Item | Owner | Channel | Template? | Score | Rating | Main issue |

## Patterns and causes
## Fixes requested (commented to owners)
## Proposed guideline or template changes
```

Save it to `/org/design/brand/reviews/<yyyy-mm>.md`, comment specific fixes to each owner with the rule broken and how to fix it, and keep the tone helpful. The goal is fewer issues next month, not a long list this month.
