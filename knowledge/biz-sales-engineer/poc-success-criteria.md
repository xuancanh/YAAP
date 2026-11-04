---json
{ "title": "POC success criteria", "summary": "A POC scope template, how to write testable success criteria and how to run and close a proof of concept on time.", "tags": ["poc", "pilot", "success-criteria", "template", "presales"], "updated": "2026-11-04" }
---

# POC success criteria

A proof of concept is a test with a pass mark agreed in advance. Without written criteria, an end date and a decision at the end, it becomes free consulting that never closes.

## Should there be a POC at all?

Run one only when:

- A specific risk can't be settled by a demo, references or documentation (an integration, performance on their data, a workflow fit)
- The buyer commits people and time
- Passing leads to a decision — ideally the buyer agrees in writing what happens if it passes

If the buyer wants to "try it out" with no criteria, offer a guided trial or a deeper demo instead.

## Writing testable criteria

Each criterion is **specific, measurable, owned by the buyer, and tied to a decision criterion**.

| Weak | Testable |
|---|---|
| "Integrates with our CRM" | "New CRM contacts appear in the product within the agreed sync interval, with fields A, B, C mapped, for a test set of records" |
| "Is fast" | "The monthly report for their sample dataset generates within the time they agreed on their test machine" |
| "Users like it" | "Three named users complete tasks X and Y without help after the training session" |

Avoid criteria the product cannot meet by design; if one is essential, flag the fit risk to the AE before starting.

## Scope template

```
Account / opportunity / SE / AE
Business goal: the decision criterion this POC settles
In scope: use cases, integrations, data, users
Out of scope: everything else, explicitly
Success criteria:
  1. <criterion> — how measured — who confirms
  2. …
Environment: who provides it; data (sample or anonymised; no production personal data without an agreement)
Buyer resources: named people, hours per week
Our resources: SE time, support, product contacts
Timeline: start, check-ins, end date
Exit: on pass → <next step, e.g. proposal review with economic buyer by date>
      on fail → <review, decide whether to continue or stop>
Agreed by: buyer name, date
```

## Running it

- **Kickoff**: walk through the scope document and confirm criteria; record any changes.
- **Check-ins**: short, regular; track each criterion as not started / in progress / passed / failed.
- **Scope creep**: write new requests down. Add them only by agreement and adjust the end date; otherwise park them for after the decision.
- **Stalls**: if the buyer misses two check-ins or doesn't provide resources, raise it with the AE; a stalled POC usually means low priority on their side.
- **Data**: follow the company's security rules for any buyer data.

## Closing it

1. Hold a results meeting on the end date, with the decision-maker.
2. Present each criterion with evidence: passed, failed or partly met.
3. Ask for the decision the scope promised.
4. Write up results and lessons in the deal record.

A failed criterion handled honestly can still win the deal; a hidden one rarely does.

## Pitfalls

- **Open-ended POCs.** No end date means no urgency.
- **Our criteria, not theirs.** If the buyer didn't write or agree them, they won't feel bound by them.
- **Too many criteria.** Test what decides the deal; keep the list short.
- **POC as first meeting.** Without discovery, you don't know what to prove.
