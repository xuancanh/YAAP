---json
{ "title": "Feedback taxonomy and counting", "summary": "Normalise raw feedback into problem statements, group them into stable themes, count them consistently, and route each item to the right place.", "tags": ["feedback", "triage", "themes", "voice-of-customer"], "updated": "2026-11-04" }
---

# Feedback taxonomy and counting

Themes are useful only if the same feedback lands in the same theme every week and the counts mean the same thing over time. That takes a fixed record format, stable theme names and explicit counting rules.

## Normalise each item

For every piece of feedback, write one record:

| Field | Example |
|---|---|
| Source | support ticket / sales call / in-app / survey (with link) |
| Date | |
| Segment | plan or company size, role |
| Account value | where known, from the CRM (not pasted personal data) |
| Raw request | "Please add CSV export to the report" |
| Problem | "Can't get monthly spend into the finance tool without retyping" |
| Type | bug / problem / request / praise / question |
| Theme | Reporting › getting data out |

**Write the problem, not the request.** Ask: what was the person trying to do, and what got in the way? If you can't tell from the source, write "unclear" and keep the raw request. Several different requests often share one problem, and that is what the theme should capture.

## Theme structure

Keep a two-level tree: **area › theme**. For example:

- Reporting › getting data out
- Reporting › filtering and slicing
- Onboarding › connecting the first data source
- Billing › understanding the invoice

Rules:
- **Name themes by the user's problem,** not by the solution. "Getting data out", not "CSV export".
- **Add a theme only when an item doesn't fit any existing one.** Note the date it was created.
- **Merge, don't fork.** If two themes keep receiving the same kind of item, merge them and keep the old name as an alias.
- **Review the tree quarterly** with the Head of Product: retire empty themes, split overloaded ones.

## Deduplication and counting

Report several counts, because each answers a different question:

- **Mentions:** every feedback item in the theme.
- **Unique accounts:** distinct accounts mentioning it. Five tickets from one account is one account.
- **Segment spread:** how many segments it appears in.
- **Account value affected** (where known): sum of the value of the unique accounts. Note that this favours large accounts and say so beside it.

Counting rules:
- A thread or ticket counts once, however many messages it has.
- The same person raising it again in a new channel within the period counts once in unique accounts, but as a separate mention.
- Sales-reported feedback is labelled as such: it is second-hand and often a summary.
- Keep counts for the period and a rolling total; label which you show.

## Representative quotes

Pick one or two quotes per theme that state the problem clearly. Remove names, emails, company names and anything identifying. Link to the source record instead.

## Routing

| Type | Goes to | How |
|---|---|---|
| Bug | Engineering backlog | Task with steps, impact and count; severity from support |
| Urgent account problem | Customer team | Comment back on the source ticket the same day |
| Problem / request | Theme file; top themes to discovery | Weekly themes update |
| Question the docs should answer | Docs owner | Note with the question and count |
| Praise | Marketing (with permission rules) and the team | Weekly note |

Bring the **top five themes** to the discovery session ranked by unique accounts, with mentions, segment spread and the trend versus last period. Link each to any existing opportunity.

## Weekly update to themes.md

```
## Week of <date>
New items: n (support n, sales n, in-app n, survey n)
| Theme | Mentions (period) | Unique accounts | Trend | Linked opportunity |
New themes: <name> — why
Merged: <a> into <b>
```

## Pitfalls

- Counting votes for a proposed solution as evidence for the problem.
- Letting the loudest channel dominate: sales notes and big accounts are louder, not necessarily more common.
- Theme names that change weekly, which destroys the trend.
- Pasting full tickets, with customer details, into the shared file.
