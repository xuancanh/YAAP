---json
{ "title": "Data quality rules", "summary": "Completeness, validity, duplicate and staleness rules with formulas, matching logic and a safe merge procedure.", "tags": ["data-quality", "completeness", "duplicates", "hygiene", "crm"], "updated": "2026-11-04" }
---

# Data quality rules

Data quality has four parts you can measure: complete, valid, unique and current. Define each as a rule, measure it the same way every week and send fixes to the record owner.

## Completeness

Agree a short list of **required fields per object and stage** with sales and RevOps leads. For example, an opportunity in Proposal needs amount, close date, next step, next step date, primary contact and source.

```
Completeness = active records with all required fields valid
               ÷ active records
```

- "Active" means open opportunities, accounts with open pipeline or customers, leads not yet converted or disqualified — define it once.
- Measure per object and per required field, so you can see which field drags the score down.
- Report by owner to direct fixes; avoid public rankings.

## Validity

A filled field can still be wrong. Common validity rules:

- Close date not in the past for open opportunities
- Amount greater than zero and within a sane range for the segment
- Next step date within the next few weeks for late-stage deals
- Picklist values from the current list only
- Email and phone in valid formats; country from a standard list
- Stage consistent with other fields (e.g. Closed-lost has a loss reason)

Use validation rules in the CRM to prevent bad data at entry where possible; it's cheaper than cleaning later. Add them through change control, because a strict rule can block users' work.

## Duplicates

**Matching rules** — start strict, loosen carefully:

| Object | Strong match | Possible match (review) |
|---|---|---|
| Account | same website domain | similar normalised name + same country |
| Contact / lead | same email | same name + same account |

Normalise before matching: lower-case, trim spaces, strip legal suffixes ("Inc", "Ltd") and "www."

```
Duplicate rate = records flagged as duplicates ÷ active records
```

## Safe merge procedure

1. Export the records involved (backup) and save it with the date.
2. Choose the surviving record by rule: most activity, oldest, or the one linked to open opportunities.
3. Check what will happen to related records (opportunities, activities, campaign membership) and owner.
4. For more than a handful of records, get approval and run in a sandbox or on a small sample first.
5. Merge; spot-check results.
6. Log what was merged, by rule, with the backup location.

Never merge accounts that are legitimately separate (subsidiaries with separate contracts) without the account owners' agreement.

## Staleness

```
Stale rate = active records not updated (or with no activity) in N days
             ÷ active records
```

Pick N per object (for example, a shorter window for open opportunities than for accounts). Stale open opportunities are the most damaging: they inflate pipeline and the forecast.

## The weekly sweep

1. Run the saved data quality reports (completeness, validity, duplicates, stale).
2. Send each owner one list of their records to fix, with the rule each one breaks.
3. Before the forecast call, re-run the opportunity checks and flag remaining gaps to the sales manager.
4. Track the scores week over week in the hygiene log.

## Fix at the source

If the same problem keeps appearing, the fix is upstream:

- A form that doesn't require the field → change the form
- An integration that writes blanks → fix the mapping
- A field nobody understands → rename, add help text, or remove it
- A step reps skip → make it part of the stage exit

## Pitfalls

- **Too many required fields.** Users fill them with junk. Require only what someone uses.
- **Cleaning without owners.** If you fix everything yourself, the owners never change behaviour.
- **Silent bulk updates.** Even correct ones surprise people. Announce, back up, log.
