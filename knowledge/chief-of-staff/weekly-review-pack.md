---json
{ "title": "Weekly review pack", "summary": "A copyable template for the weekly business review pack, with rules for exception lines, controllable inputs and unexplained variance.", "tags": ["cadence", "reporting", "wbr", "scorecard", "template"], "updated": "2026-11-04",
  "sources": [
    { "title": "Colin Bryar on the practice of Amazon's Weekly Business Review", "url": "https://commoncog.com/colin-bryar-amazon-weekly-business-review/", "publisher": "Commoncog", "note": "Background on the WBR's split between controllable input metrics and output metrics." }
  ] }
---

# Weekly review pack

The pack is modelled on Amazon's Weekly Business Review, which separates **controllable input metrics** (things the team does) from **output metrics** (results like revenue) and spends the meeting on what's off. Your version keeps three habits from it: open items first, exceptions only, and "I don't know" over a made-up cause.

The pack lives at /org/reports/<yyyy>-W<ww>.md, using the ISO week of the review. It's ready by the pre-read deadline (`chief.preReadHours` before the meeting, a company tunable).

## Template

```markdown
# Weekly business review — <yyyy>-W<ww>

Prepared by Chief of Staff · review owner: <name> · pre-read deadline: <date time>
Sources: function reports under /org/<function>/reports/, /org/scorecard.md, org_metric_read, org_intent, org_projects

## 1. Last week's open items
| # | Item | Owner | Due | Status | Link |
|---|---|---|---|---|---|
| 1 | <follow-up from last review> | <owner> | <date> | open / closed | [task:…] |

## 2. Missing inputs
- <Function> sent no report this week (last report: <path>, <date>).

## 3. Scorecard — exceptions
| Metric | Owner | Target | This week | 6-week trend | Status | Source |
|---|---|---|---|---|---|---|
| <off-track metric> | <owner> | <target> | <value> | <trend> | off track | <source, date> |

**<Metric>** — <owner's commentary, quoted or linked: what moved it, what they're doing, by when>.

## 4. Scorecard — on track (no discussion)
<Metric> on track (<value> vs <target>, <source>). One line each.

## 5. Unknowns
| Variance | Investigator | Due | Issue |
|---|---|---|---|
| <what moved> | <name> | <date> | /org/issues.md#<row> |

## 6. Key results and projects
- Key results off track for `chief.offTrackWeeks` weeks with no issue raised: <list>
- Now projects: <project> — lead's call <on_track/at_risk/off_track> because <reason>; signals: progress <x>, blocked <n>, appetite used <x>; <agree / disagree with the call>
- Update missing: <project, lead>

## 7. Decisions and asks for the review
- <question> — decider <name>, recommender <name>, pre-read <link>
```

## Writing an exception line

An exception line says what moved, who owns it, and what they're doing about it, in the owner's words. You compile; you don't write the commentary. If the owner hasn't answered by the deadline, the line says so.

Example (figures made up for illustration):

> **First-response time (support)** — owner: Head of Customer. Target 4h, this week 6.5h, rising three weeks running. Owner: "Two specialists paused for a model change; queue doubled Tuesday. Rebalanced Wednesday, expect back under target by W46." Source: org_metric_read support.first_response, read Thu 16:00.

Not this:

> First-response time is up, probably due to seasonal demand.

The second invents a cause and has no owner. When nobody can explain a variance, write `unknown — investigating`, name the investigator, add the row to /org/issues.md with a due date, and carry it to next week's open items.

## Inputs over outputs

When an output (revenue, retention, cost) is off, ask the owner about the inputs that feed it: calls made, releases shipped, response time, items reviewed. An input the team controls can be acted on this week; an output can only be watched. If an input moves and its output never follows over several weeks, that's worth raising: the input may be the wrong one.

## Checklist before publishing

- [ ] Every open item from last week is listed with its status.
- [ ] Every function without a report this week is named.
- [ ] Every number has a source and a read time; stale sources are marked stale.
- [ ] Every self-reported number not backed by a source is marked "estimate".
- [ ] Every off-track line has the owner's commentary or says it's missing.
- [ ] Every unexplained variance is in Unknowns with an investigator.
- [ ] Where a lead's project health call disagrees with the signals, the pack says so.
- [ ] The pack is linked in the review's agenda.

## Common pitfalls

- **The watermelon.** Green outside, red inside: a project reads on track while its progress hasn't moved in two updates. Name it.
- **Discussing what's on track.** It eats the meeting. One line each.
- **Rewriting a head's report.** Quote or link it. The account is theirs.
- **Losing follow-ups.** Log them during the meeting, route each as a task to its owner straight after, and put them at the top of next week's pack.
