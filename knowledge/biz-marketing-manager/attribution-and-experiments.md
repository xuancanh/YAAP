---json
{ "title": "Attribution and channel experiments", "summary": "How attribution models skew channel numbers, what each one undercounts, and how to test a channel shift as an experiment before moving budget.", "tags": ["attribution", "experiments", "channels", "budget", "marketing"], "updated": "2026-11-04",
  "sources": [
    { "title": "First click, linear, time decay, and position-based attribution models are going away", "url": "https://support.google.com/google-ads/answer/13427716", "publisher": "Google Ads Help", "date": "2023-04-06", "accessed": "2026-11-04", "note": "Google Ads and GA4 kept only last click and data-driven attribution." }
  ] }
---

# Attribution and channel experiments

Attribution decides which channel gets credit for a conversion. Every model is a rule, not a measurement of cause. Use it to compare channels under the same rule, and use experiments when you need to know whether spend actually causes results.

## The models and what each one hides

| Model | Credit goes to | Undercounts | Overcounts |
|---|---|---|---|
| Last touch | the final touch before conversion | content, brand, events, anything early | branded search, retargeting, direct |
| First touch | the first known touch | nurture, sales enablement, late content | top-of-funnel channels |
| Linear | every touch equally | nothing in particular, but tells you little | channels with many cheap touches (email) |
| Position-based (U-shaped) | mostly first and last, the rest split | the middle | first and last |
| Data-driven | an algorithm's estimate from the platform's own data | touches the platform can't see (offline, other platforms) | that platform's own channels |
| Self-reported ("how did you hear about us?") | what the buyer remembers | forgettable touches | memorable ones (podcasts, word of mouth) |

Google retired first-click, linear, time-decay and position-based models from Google Ads and GA4 in 2023, leaving last click and data-driven. If a report uses those older models, it was computed elsewhere (CRM or a spreadsheet); say where.

**Rules for the channel review:**

1. Write the model and the window (for example, "last touch, 30-day lookback") in `/org/marketing/kpis.md`. Changing either breaks the series; if you must, report both for one month.
2. Report CRM-attributed numbers as the main figure. Ad-platform numbers go in a separate column labelled with the platform, because each platform credits itself.
3. Name the caveat next to any verdict that rests on attribution. "Content: cut candidate, last touch" is weaker than it looks, because last touch undercounts content.
4. Compare self-reported source with modelled source once a quarter. Where they disagree badly, trust neither alone.

## When to run an experiment instead

Run one before any shift you couldn't easily reverse, any cut to a channel that attribution systematically undercounts, and any scale-up big enough to move CAC. Propose it with `org_propose_experiment`.

Designs, from strongest to weakest:

- **Holdout**: withhold the channel (or the campaign) from a random share of the audience or from matched regions, and compare conversion. The difference is the incremental effect.
- **On/off (time-based)**: pause the channel for a fixed window and compare with the windows before and after. Cheap, but seasonality and other campaigns muddy it; note what else changed.
- **Spend step**: change spend by a set step and watch cost per SQL and SQL volume. Tells you about diminishing returns, not about cause.
- **Platform lift study**: the ad platform's own test. Useful, but marked by the platform; note who ran it.

## Experiment template

```markdown
# Experiment: <channel or campaign> — <yyyy-mm>
Hypothesis: If we <change>, then <metric> will <direction and size>, because <reason>.
Key result served: <KR>
Design: holdout | on/off | spend step | lift study
Audience / split: <who is in test and control, how assigned>
Primary metric and source: <e.g. SQLs per week, CRM via org_metric_read>
Guardrail metrics: <e.g. blended CAC, pipeline sourced>
Window: <start> to <end> (long enough for the sales cycle to show in the metric)
Decision rule (set before starting): ship if <threshold>; stop if <guardrail breached>
Budget: <USD, inside the envelope; increases are a backlog task for the chief>
Owner / reviewer: <member> / <different member>
Result: <filled in afterwards, with counts, not only percentages>
```

## Worked example (made-up figures)

Paid social shows a last-touch cost per SQL of $900 against a $600 target, two months running: a cut candidate. But last touch undercounts awareness channels, so instead of cutting, the Demand Gen Marketer runs a four-week regional holdout. Test regions keep paid social; matched control regions pause it. Test regions produce 22 SQLs, control regions 19. The increment is 3 SQLs for $5,400 of spend: $1,800 per incremental SQL. The verdict becomes "cut", now with evidence rather than a model's opinion, and the counts are small enough that the report says so.

## Common pitfalls

- Treating a model's output as cause. Attribution says who touched last, not who made it happen.
- Setting the decision rule after seeing the result.
- A window shorter than the sales cycle, so the experiment ends before SQLs can show up.
- Changing two things at once (new creative and new audience), so you can't say which one worked.
- Cutting brand or content on last-touch numbers alone.
