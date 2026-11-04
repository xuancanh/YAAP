---json
{ "title": "Campaign plan template", "summary": "A campaign plan template with offer, channel, budget and tracking fields, a UTM naming convention, and a pre-launch checklist.", "tags": ["campaign planning", "template", "tracking", "utm"], "updated": "2026-11-04" }
---

# Campaign plan template

A campaign plan answers four questions before you spend anything: who are we reaching, what are we offering them, how will we know it worked, and what will we do if it doesn't. Save it as `/org/marketing/campaigns/<name>.md`.

## The template

```markdown
# Campaign: <name>

**Key result served:** <quoted KR>
**Owner:** <you>   **Approver:** Head of Marketing
**Dates:** <start> – <end>   **Budget:** <amount> (from /org/marketing/budget.md line <x>)

## Audience
- Segment: <industry, size, role, region>
- Pain or trigger: <why now>
- Exclusions: <current customers, open opportunities, competitors>
- Size estimate: <from platform audience tools or CRM count; source>

## Offer
- What they get: <guide, trial, webinar, assessment, demo>
- Why it's worth their contact details: <one sentence>
- Landing page: <url or "to build">, owner <name>

## Channels and budget split
| Channel | Budget | Expected leads | Expected SQLs | Basis for estimate |
|---|---|---|---|---|
| <paid search> | | | | <last similar campaign / benchmark from our own data> |

## Targets (from the funnel definitions)
- Leads <n>, MQLs <n>, SQLs <n>, pipeline sourced <amount>
- Cost per SQL ceiling: <amount>. Above this for two weeks, we pause or change.

## Tracking
- UTM pattern: see below
- Conversion events: <form submit, trial start> verified in <tool>
- CRM campaign record: <id>, lead source values: <values>

## Follow-up
- Who follows up MQLs and how fast (SLA agreed with sales): <…>
- Nurture for non-MQLs: <email sequence name>

## Risks and kill criteria
- <risk> → <mitigation>
- We stop or change if: <condition>

## Creative and copy
- Assets needed, owners, due dates (Brand Designer, Content Marketer)
```

## Estimating expected results

Base estimates on our own history first: the funnel readouts and previous campaign files. Write the basis next to each number. If there's no history, say "no baseline", set a small test budget first, and set the real target after the test. Don't put an industry "average conversion rate" from a blog in the plan as if it were ours.

```
Expected SQLs = budget / expected CPL × expected lead→MQL × expected MQL→SQL
```

## UTM naming convention

Consistent tags are what make channel reporting possible. Use lowercase, hyphens, no spaces:

| Parameter | Meaning | Example |
|---|---|---|
| `utm_source` | The site or platform | `google`, `linkedin`, `newsletter` |
| `utm_medium` | The type of channel | `cpc`, `paid-social`, `email`, `event`, `partner` |
| `utm_campaign` | This campaign's name | `2026-q4-close-checklist` |
| `utm_content` | Which ad or link | `video-a`, `cta-footer` |
| `utm_term` | Keyword (paid search) | `month-end-close` |

Rules:

- Keep a list of allowed source and medium values with RevOps. A new value breaks channel grouping.
- Never put UTMs on internal links within the site; it overwrites the real source of the session.
- Record each tagged URL in the campaign file.

## Pre-launch checklist

- [ ] Plan approved by the Head of Marketing; spend fits the allocation.
- [ ] Conversion events fire (test submit, then check the analytics debug view and the CRM record).
- [ ] Hidden form fields capture UTMs into the CRM lead source fields.
- [ ] Exclusion lists uploaded (customers, open opportunities).
- [ ] Sales knows the campaign, the offer and the follow-up SLA.
- [ ] Landing page loads fast on mobile and the form works.
- [ ] Ad copy and claims checked against current ad platform policies and approved claims. Platform policies change; review them for each new campaign type.
- [ ] Privacy: consent banner and form notices meet the company's privacy policy for each region targeted. Check with Legal for new regions.
- [ ] Kill criteria and first review date in the calendar.

## After launch

- Day 2–3: check tracking end to end with real data, not just test submits.
- Weekly: [paid media optimisation](paid-media-optimisation-playbook.md) and the funnel readout.
- End: a short results note in the campaign file: target vs actual, cost per SQL, what we'd repeat, what we'd drop.
