---json
{ "title": "Product ops KPIs", "summary": "Definitions and formulas for feedback themes triaged, release notes per release and metrics pack on time, with counting rules and a monthly self-report.", "tags": ["kpis", "metrics", "product-ops", "definitions"], "updated": "2026-11-04" }
---

# Product ops KPIs

Your KPIs measure whether the product machine runs on time and covers everything. They are service measures for the rest of the company: product, support and sales rely on you to have triaged feedback, documented releases and a pack they can quote.

## Feedback themes triaged

**What it answers:** is incoming feedback being turned into themes and routed, with nothing left in a pile?

**Primary formula:** feedback items received in the period that were normalised, assigned a theme and routed by the next weekly triage ÷ feedback items received in the period.

**Counting rules:**
- An item is **triaged** when it has the full record (problem, type, theme, source link) and has been routed (bug to engineering, urgent to the customer team, theme count updated).
- Items marked "unclear problem" count as triaged if they have a theme and a follow-up question to the source.
- Items received after the cut-off for this week's run count in next week's period.

**Report beside it:**
- **Backlog of untriaged items** at the end of the run.
- **Themes reviewed in discovery:** of the top five themes sent, how many were discussed. This shows whether triage is reaching decisions.
- **Routing time for urgent items:** time from receipt to the customer team being told.

**Gamed by:** assigning everything to a catch-all "other" theme. Guard: report the share of items in "other" and keep it small by adding or merging themes.

## Release notes per release

**What it answers:** does every release get notes, internal and external, when it ships?

**Formula:** releases in the period with both internal and customer-facing notes approved by release day ÷ releases in the period.

**Counting rules:**
- A **release** is whatever the company defines as one (a version, a weekly deploy with user-facing change). Releases with no user-facing change need only an internal note, and count as covered with it.
- **By release day** means notes approved before or on the day the change reaches customers. Late notes count as misses.
- Notes later found to describe something not live count as misses for that release.

**Report beside it:** corrections made after publication, and their cause (rollout status not confirmed, wrong UI wording).

## Metrics pack on time

**What it answers:** does the monthly pack arrive when the Head of Product needs it, complete?

**Formula:** monthly packs delivered by the agreed day with every standard metric present (or marked unavailable with a reason) ÷ packs due.

**Counting rules:**
- The **agreed day** comes from the product report cadence; write it in /org/product/kpis.md.
- **Complete** means every metric in the standard layout has a value or a stated reason, and the data notes section is filled.
- A pack later corrected for a computation error counts as on time but log the correction.

**Report beside it:** corrections after delivery, and metrics marked unavailable with the reason.

## Monthly self-report

```
| KPI | This month | Last month | Notes |
|---|---|---|---|
| Feedback triaged | 112/118 | | 6 arrived after cut-off |
| Untriaged backlog | 6 | | |
| "Other" theme share | | | |
| Release notes on release day | 4/4 | 3/4 | |
| Metrics pack on time and complete | yes | yes | retention delayed by export issue, noted |
```

For each miss, add the cause and the fix. A pattern of misses with the same cause (for example, rollout status unconfirmed) is a process change to propose, not just a reminder to try harder.
