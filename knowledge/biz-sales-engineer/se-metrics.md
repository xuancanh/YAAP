---json
{ "title": "SE metrics", "summary": "Definitions and formulas for technical win rate, POC success and questionnaire turnaround, with counting rules.", "tags": ["metrics", "technical-win", "poc", "turnaround", "presales"], "updated": "2026-11-04" }
---

# SE metrics

Your metrics measure whether technical evaluations end in a clear, honest result, quickly. Agree the definitions with the Head of Sales and use them the same way every period.

## Technical win

A **technical win** is recorded when the buyer confirms our solution meets their technical requirements and they will move to commercial decision, regardless of whether the deal later closes. Record it in the deal record with the date and who confirmed it.

A **technical loss** is when the buyer rules us out on technical grounds, or when you advise the AE that we are not a fit.

```
Technical win rate = technical wins ÷ (technical wins + technical losses)
```

Count evaluations that reached a technical decision in the period. Evaluations still open are excluded; report them separately.

Why it's separate from the deal win rate: a deal can be lost on price after a technical win, or won despite a weak evaluation. Looking at both tells you where deals are lost.

Useful breakdown: technical losses by reason (missing capability, integration, performance, security, other). Feed the missing-capability list to product.

## POC success

```
POC success rate = POCs that met their agreed success criteria
                   ÷ POCs that reached their end date
```

- "Met" means all must-have criteria passed, as confirmed by the buyer.
- A POC stopped early because of a clear fit problem counts as not met; note the reason.
- Also track **POC to close**: `POCs that passed and led to closed-won ÷ POCs that passed`. If many passing POCs still don't close, the criteria may not be tied to the real decision.
- And **POC on-time rate**: `POCs that ended on the agreed end date ÷ POCs ended`.

## Questionnaire turnaround

```
Turnaround (per questionnaire) = date returned to the AE or buyer − date received
```

- Use business days and say so.
- Report the **median** across questionnaires in the period, with the count.
- Also report **library hit rate**: `answers taken from the library (unchanged or adapted) ÷ total answers`. A rising hit rate is the main lever on turnaround.
- Track approval wait time separately (time new answers spend with the security owner), so you can see where the delay is.

## Reporting template

```
Period: <dates>  Source: CRM + SE tracker, pulled <date>
Technical decisions: n   Technical win rate: x% (w of n)
  Losses by reason: …
POCs ended: m   Success rate: y%   On time: z%   Passed → closed-won: …
Questionnaires returned: q   Median turnaround: d business days
  Library hit rate: h%   Median approval wait: a days
Gaps raised to product this period: …
```

## Pitfalls

- **Counting AE-declared wins.** A technical win needs the buyer's confirmation.
- **Hiding fit losses.** Advising "not a fit" early is good work; count it, don't avoid it.
- **Turnaround by rushing.** Speed that produces wrong answers costs more later. Track corrections requested after submission.
- **Tiny samples.** With few POCs per period, show each one, not just a rate.
