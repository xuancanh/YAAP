---json
{ "title": "Appetite decision memo", "summary": "Prepare an extend, cut-scope or kill decision for the lead's manager within a day of the breaker, with a template and a worked example.", "tags": ["appetite", "circuit-breaker", "scope", "decision"], "updated": "2026-11-04" }
---

# Appetite decision memo

The appetite is how much the company chose to spend on a bet, not an estimate of what it will cost. When spend nears it, you prepare a decision; you do not quietly extend. Your KPI is a breaker decision within a day, so the memo has to be fast to write and fast to read.

## When to write one

- **At the warning share:** post a health update that states spend and days used against the appetite and what remains. No memo yet, but start collecting the facts.
- **When the breaker trips:** new claims pause. Write the memo the same day.
- **When a re-plan would pass the appetite:** the re-plan is the trigger. Write the memo before changing any dates.

## What the decider needs

The decider wants to know three things: what the money already bought, what more money would buy, and what happens if we stop. Everything in the memo serves one of those.

## Template

```
Project: <key> — <name>        Appetite: <amount / days>   Used: <x%>
Key result: <metric> — baseline <b>, now <n>, target <t> (source, date)

Done: <what is live or proven, with evidence>
Left: <what remains for the done_when, sized>
Forecast: <date and spend to finish as briefed>, confidence <low/med/high> because <reason>

Options
A. Extend by <amount>. Buys: <the rest of the scope>. Risk: <what could still slip>.
B. Cut scope to fit. Ship: <the slice>. Drop: <named items>. Effect on KR: <expected>.
C. Kill. Keep: <what we retain — code, research, learning>. Cost of stopping: <cleanup>.

Recommendation: <A/B/C> — <one-sentence reason>. Confidence: <low/med/high>.
```

## Writing each option well

- **Extend** must say what the extra spend buys in terms of the key result, not just "finish the tasks". If the honest answer is "the same uncertainty for longer", say so.
- **Cut scope** names exactly what goes. "Reduce polish" is not a cut; "drop CSV export and the admin settings page" is.
- **Kill** lists what is kept. A killed project often leaves reusable research, a working spike, or a clear "no", which has value.

Always include all three, even when one is obviously wrong. It shows the decider you considered them, and it gives them a real choice.

## Worked example

> Project CHK — self-serve checkout. Appetite 6 weeks; used 5 (83%).
> KR: trial-to-paid conversion — baseline measured last quarter, now unchanged (checkout not yet live).
> Done: card payments working in staging; pricing page live.
> Left: tax calculation for two more regions, invoice emails, refund flow.
> Forecast: 3 more weeks to finish as briefed, medium confidence — the tax provider integration is uphill.
>
> A. Extend 3 weeks. Buys the full brief. Risk: tax provider still unknown.
> B. Cut to card payments in the home region with manual invoices. Ships in 1 week. Drop: other regions' tax, automated refunds. KR can start moving for most trials.
> C. Kill. Keep: staging integration and pricing page. Conversion stays manual.
>
> Recommendation: B — gets the KR measured a month sooner and leaves the uncertain part for its own bet. Confidence medium.

## After the decision

- **Cut:** the same day, cancel or move out every task that no longer fits, with the reason, and re-plan the milestones.
- **Extend:** update the plan's milestones and post a health update with the new appetite.
- **Kill:** run the close as a kill: what shipped, what was learned, team released.

Never extend your own project beyond your manager's share. Beyond that is the CEO's call.

## Pitfalls

- Writing the memo as a defence of the team. The decider needs options, not justification.
- Sunk-cost framing ("we've spent 83%, we must finish"). The spend is gone either way; compare the options from today.
- Leaving the recommendation out to seem neutral. You know the project best; recommend.
