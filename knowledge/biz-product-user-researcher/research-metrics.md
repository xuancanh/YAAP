---json
{ "title": "Research metrics", "summary": "Definitions and formulas for studies completed, opportunities validated or killed, and customer conversations per week, with counting rules that reward decisions over volume.", "tags": ["kpis", "metrics", "research-ops", "definitions"], "updated": "2026-11-04" }
---

# Research metrics

Your KPIs should reward research that changes decisions, not research volume. Each one below has counting rules that make padding hard and make a killed opportunity count as much as a validated one.

## Studies completed

**What it answers:** are planned studies reaching a usable result?

**Formula:** studies in the period with an approved plan, completed sessions and a published synthesis linked to its decision ÷ studies planned to finish in the period.

**Counting rules:**
- **Completed** means the synthesis is saved, indexed in /org/product/research/index.md and shared with the decision owner. Finished sessions without a synthesis do not count.
- A study stopped early because the answer became clear counts as completed if the synthesis says so.
- A study cancelled because the decision was made without it counts as cancelled, not completed; note the reason. Frequent cancellations suggest planning research too late.

**Report beside it:** median days from plan approval to synthesis. Long cycles mean findings arrive after decisions.

## Opportunities validated or killed

**What it answers:** is research settling questions in the opportunity tree?

**Formula:** opportunities moved to validated or killed in the period, with a linked study as the evidence ÷ opportunities researched in the period.

**Definitions:**
- **Validated:** evidence shows the problem exists for the target segment and matters enough that the team decided to pursue it.
- **Killed:** evidence shows the problem is absent, rare, or not worth solving now, and the team decided not to pursue it.
- **Still open:** studied but not settled. Say what would settle it.

**Counting rules:**
- The move must be recorded by the decision owner (usually the Head of Product), not only recommended in your synthesis.
- Report validated and killed **separately** as well as combined. A researcher who only validates may be confirming what the team already believed.

## Customer conversations per week

**What it answers:** is the team in regular contact with real users?

**Formula:** customer or user conversations held in the week (interviews, usability sessions, and other research calls with notes) ÷ 1 week. Show a rolling average over the last several weeks.

**Counting rules:**
- A conversation counts when it was held with a real user or customer, notes were saved (using participant codes), and consent was recorded where it was a research session.
- Sales and support calls count only if you attended and saved research notes from them; label them separately.
- Internal stakeholder interviews do not count.
- Count per participant session: a group session with three participants counts as one conversation, with the participant count noted.

**Gamed by:** short calls with no notes, or re-counting the same participant. Guard: notes required; report unique participants beside the count.

## Monthly report

```
| KPI | This month | Last month | Notes |
|---|---|---|---|
| Studies completed | 2/2 | 1/2 | median 12 days plan → synthesis |
| Opportunities validated / killed / open | 1 / 2 / 1 | | killed: bulk import, approval flows |
| Conversations per week (rolling) | | | unique participants: n |
```

Add one line per study on what it changed: the decision, and which way it went. That line is the real measure of research value; the KPIs only show whether the engine is running.
