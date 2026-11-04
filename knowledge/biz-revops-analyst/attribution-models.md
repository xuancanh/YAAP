---json
{ "title": "Attribution models", "summary": "The common rule-based attribution models, what each one is good for, attribution coverage as a metric and how to state the limits.", "tags": ["attribution", "marketing", "pipeline", "models", "coverage"], "updated": "2026-11-04" }
---

# Attribution models

Attribution assigns credit for pipeline and bookings to the sources and campaigns that touched them. Every model is a simplification. Pick one per question, state it, and show its limits.

## Rule-based models

| Model | Credit goes to | Good for | Blind spot |
|---|---|---|---|
| **First touch** | the first recorded touch | which channels bring new people in | ignores everything that nurtured the deal |
| **Last touch** (often last touch before opportunity creation) | the final touch before the conversion | which channels convert | ignores how they found us |
| **Linear** | split equally across all touches | a balanced view | treats a banner view like a demo request |
| **U-shaped (position-based)** | most credit to first touch and lead creation, rest spread | demand-gen teams focused on acquisition | arbitrary weights |
| **W-shaped** | most credit to first touch, lead creation and opportunity creation | B2B funnels with clear milestones | arbitrary weights; needs clean milestone dates |
| **Time decay** | more credit to touches closer to conversion | long cycles where recent activity matters | undervalues early awareness |

Weights for U- and W-shaped models are conventions, not laws; write down the weights you use.

**Data-driven (algorithmic) models** estimate credit statistically from converting and non-converting paths. They need a lot of clean data, and their output is harder to explain. Use only with enough volume and with the method documented.

## Self-reported attribution

Asking "How did you hear about us?" on a form or in discovery catches channels that tracking misses (word of mouth, podcasts, communities). Report it alongside tracked attribution; when they disagree, that's information, not an error.

## Attribution coverage

```
Attribution coverage = pipeline amount with a valid, known source
                       ÷ total pipeline amount created
```

- "Valid" means a source value from the agreed list, not blank, "other" or "unknown".
- Report by count and by amount, and by segment.
- Low coverage means the model's conclusions are about a subset of deals. Say which subset.
- Raising coverage is usually a data-hygiene job: required source fields, UTM standards, campaign membership rules. Work with the CRM Administrator.

## Method

1. **State the question**: "Which channels create pipeline in the mid-market segment?" is answerable; "What is marketing worth?" is not, with attribution alone.
2. **Choose the model** that fits the question; consider showing two (e.g. first and last touch) side by side.
3. **Define the touch set**: which activities count (form fills, event attendance, sales meetings), and the lookback window.
4. **Define the conversion**: opportunity created, or closed-won.
5. **Run it** from a saved query; record coverage.
6. **Report** with the model, window, coverage and caveats in the header.

## Limits to state every time

- Attribution shows correlation with touches, not causation. A channel that only reaches people who would have bought anyway still gets credit.
- Offline and dark-social touches are under-recorded.
- Privacy controls and cookie consent reduce tracking; coverage of web touches varies by region and browser.
- Long cycles mean recent periods are incomplete for closed-won attribution.

For budget decisions, suggest testing (a holdout region, a paused channel) when the stakes justify it; tests show causation where attribution can't.

## Pitfalls

- **Switching models between reports** without saying so; trends become meaningless.
- **Summing credit across models.** Each model distributes the same total; don't add them up.
- **Reporting precise percentages** on low coverage. Round, and lead with the coverage number.
