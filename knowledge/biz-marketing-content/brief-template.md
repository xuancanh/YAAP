---json
{ "title": "Content brief template", "summary": "A fill-in brief template with a worked example, so every piece starts with a clear reader, job, angle and target.", "tags": ["content brief", "template", "planning"], "updated": "2026-11-04" }
---

# Content brief template

A brief is a one-page contract between you and the reviewer. If the reviewer approves the brief, they have approved the reader, the job and the angle, so the draft review is only about execution. Keep it short enough to read in two minutes.

## The template

Copy this into `/org/marketing/content/briefs/<slug>.md`.

```markdown
# Brief: <working title>

**Key result served:** <the KR from org_why, quoted>
**Format:** <guide | article | case study | newsletter lead | landing copy>
**Owner / reviewer:** <you> / <reviewer>
**Due:** <date for draft>

## Reader
- Role and context: <who they are, what tools they use>
- Problem they are trying to solve: <in their words>
- What they already know: <so we skip it>
- What would make them stop reading: <jargon, sales pitch, length>

## Job of the piece (pick one)
<rank for "<query>" | convert to <offer> | arm sales for <objection> | retain <segment>>

## Angle
What we can say that the top existing pieces don't: <our data, a customer story, a sharper framework, a strong opinion we can defend>

## Outline
- H2: <section> — key point: <one sentence> — support: <source or example>
- H2: …

## Sources to gather
- <source> — <what claim it supports> — <status: have / need>

## Call to action
<one primary CTA and where it goes>

## Success metric
<metric> — target <number> by <date> — measured in <source>

## Constraints
<length range, legal or claims review, words to avoid, deadline drivers>
```

## How to fill it well

- **Reader:** write it so someone could pick the reader out of a crowd. "Marketers" is too broad; "a solo marketer at a 20-person SaaS company who owns the blog and the newsletter" is useful.
- **One job only.** A piece that tries to rank, convert and enable sales at once does none well. If you need two jobs, write two pieces and link them.
- **Angle is the hardest field.** Read the top results for the topic first. If your outline matches theirs, you don't have an angle yet. Ask product, sales or support for a story or data point only we have.
- **Every H2 has support.** An outline line without a source or example is where unsourced claims creep in later.
- **Target is a number and a date,** taken from what similar pieces did (see the performance log), not a guess. If there is no history, say "baseline: first piece of this type" and set the target after 30 days.

## Worked example (abridged)

```markdown
# Brief: How to run a month-end close with a two-person finance team

**Key result served:** "Grow trial sign-ups from finance leads by 20% this quarter"
**Format:** guide

## Reader
- Role: finance lead at a 30–80 person company, often the first finance hire
- Problem: the close takes too long and depends on them remembering steps
- Knows: accounting basics, uses a spreadsheet checklist today
- Stops reading if: it turns into a product tour in the first screen

## Job
Convert to the free close-checklist template (gated by email).

## Angle
Our anonymised task data shows which close steps slip most; no top result has
real data on this. Plus one customer story (approved for use).

## Outline
- H2: What a close actually includes — key point: five stages — support: our checklist
- H2: Where closes slip — key point: reconciliations and approvals — support: product data (ask data team)
- H2: A day-by-day schedule — support: customer story
- H2: Get the template — CTA

## Success metric
Template downloads from this page — target 150 in 60 days — measured in analytics events.
```

## Before you submit the brief

- [ ] The reader and job are specific enough that a reviewer could disagree.
- [ ] The angle is something competitors can't easily copy.
- [ ] Every outline point has a source or example, or a named owner to get one.
- [ ] The metric exists in a source you can read (`org_metric_read` or an export).
- [ ] The SEO keyword brief, if any, is linked and its target query is in the job field.
