---json
{ "title": "CRM definitions and data hygiene", "summary": "A template for lifecycle and stage definitions, required fields, hygiene checks and change control, so the CRM stays complete, comparable and trusted.", "tags": ["revops", "crm", "data-quality", "lifecycle", "definitions"], "updated": "2026-11-04" }
---

# CRM definitions and data hygiene

A metric is only as good as the definition of the stage it counts. Every stage needs an **entry criterion** (what must be true for a record to enter it), an **exit criterion** (what moves it on) and an **owner unit**. Write them once in /org/revops/funnel.md. Marketing, sales and customer success all read that file, and nobody keeps a private version.

## Lifecycle and stage template

Adapt the stage names to the company. The structure is what matters.

```markdown
# Funnel definition  (version <n>, decided <date>, see /org/revops/decisions.md)

| Stage | Entry criterion (verifiable) | Exit criterion | Owner unit | Max time in stage |
|---|---|---|---|---|
| Lead | Contact with a valid email/company, any source | Meets MQL rule | Marketing | — |
| MQL | <fit + intent rule, e.g. ICP fit and a high-intent action> | Accepted or rejected by sales | Marketing | <SLA> |
| SAL (sales-accepted) | Sales agrees it's worth a conversation | Discovery held | Sales | <SLA> |
| Opportunity / SQL | Discovery done: pain, a buyer and a timeline identified | Proposal sent | Sales | |
| Proposal | Written proposal or quote sent | Verbal yes or loss | Sales | |
| Closed-won | Signed order form (date = signature) | Onboarding started | Sales → CS | |
| Closed-lost | Loss reason from the picklist | — | Sales | |
| Onboarded | <first value event> | — | Customer success | |
| Renewed / expanded / churned | Contract event dated | — | Customer success | |

Rejected MQLs: reason picklist <list>. Recycled leads: rule <…>.
```

Entry and exit criteria should be checkable from the record: a field, a date, a document. "Customer is interested" can't be audited. "Discovery call logged with pain and decision date filled" can.

## Required fields

Decide which fields are required at each stage, then measure them.

| From stage | Required fields |
|---|---|
| Lead | Source, owner, created date |
| Opportunity | Account, amount, close date, stage, next step, next-step date, primary contact |
| Proposal | Proposal link, decision process notes, competitor (or "none known") |
| Closed-won | Signed order form link, booked amount matching it, term, start date |
| Closed-lost | Loss reason (picklist), competitor if any, a one-line note |

**CRM completeness** = records with every field required at their current stage filled ÷ records in that stage. Report it per stage and per owner, so the gaps have a name next to them.

## Picklists that keep data comparable

- **Loss reasons**: a short, mutually exclusive list (for example price, product gap, timing, lost to competitor, no decision, disqualified). Keep "Other" off the list, or require a note with it and audit it.
- **Lead source**: two levels (channel → specific source), defined once and never free text.
- **Stage names**: fixed. A new stage is a change request.

## Monthly hygiene checks

- [ ] Duplicates: accounts and contacts sharing a domain, email or name. Merge rule written down (which record survives).
- [ ] Open opportunities with a close date in the past.
- [ ] Opportunities with no activity within the stale-deal limit in cadence.md.
- [ ] Stage doesn't match its exit criteria (for example Proposal with no proposal link).
- [ ] Closed-won amount ≠ signed order form.
- [ ] Closed-lost without a specific reason, or with "Other" and no note.
- [ ] Missing source attribution on opportunities created this month.
- [ ] Ownerless records, and records owned by members who are paused or have left.

Fix the cause, not only the record. If the same field is empty on most new records, the form or the automation is the problem. That becomes a task for your team, not a reminder to sellers.

## Change control

Every change to a field, stage, picklist, automation or integration needs:

1. **Request**: what, why, who asked, which reports it touches.
2. **Impact check**: which metrics' history it changes, and whether old records get backfilled or the trend gets a marked break.
3. **Test**: in a sandbox, or on a small set, with the expected and actual results written down.
4. **Release note**: a dated note in /org/revops/ saying what changed, from when, and how to read old and new numbers.
5. **Rollback**: how to undo it, and who can.

A change that alters reported history is a decision with an owner. Record it in /org/revops/decisions.md, and take material ones to the chief.

## Common pitfalls

- Stage names that mean different things to marketing and to sales.
- Making a field required without a picklist, which produces junk data.
- Quietly editing old records to make a definition change "consistent".
- Measuring completeness only overall, so one owner's gap is invisible.
- Building automations that move stages without the exit criteria being met.
