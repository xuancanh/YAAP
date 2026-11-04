---json
{ "title": "Attribution primer", "summary": "Plain explanations of attribution models, what each is good and bad for, and how to report channel credit honestly.", "tags": ["attribution", "measurement", "channels", "reporting"], "updated": "2026-11-04" }
---

# Attribution primer

Attribution decides which channel gets credit for a lead, SQL or deal. Every model is a simplification. Choose one, say which one, keep it stable, and don't let a model choice masquerade as a performance change.

## The common models

| Model | How credit is assigned | Good for | Misleads when |
|---|---|---|---|
| **First touch** | 100% to the first known interaction | "Which channels bring new people in?" | It ignores everything that convinced them later |
| **Last touch** | 100% to the last interaction before conversion | "What closed the conversion?" | Brand search and direct visits look like heroes |
| **Lead source (CRM)** | The source field set when the lead was created | Pipeline sourced reporting | The field is overwritten or set manually and inconsistently |
| **Linear** | Equal split across all touches | A balanced view | Trivial touches get the same credit as decisive ones |
| **Position-based** | Larger shares to first and last, the rest split | Valuing both discovery and conversion | The weights are arbitrary |
| **Time decay** | More credit to touches closer to conversion | Short cycles | Long-cycle discovery channels are undervalued |
| **Data-driven** | Credit from statistical comparison of paths | Large volumes of tracked paths | Low volume; it's opaque, hard to explain |

**Your default:** pipeline sourced uses the CRM's original lead source (first touch, effectively). Report **influenced** pipeline (any marketing touch before opportunity creation) separately, as context, never added to sourced.

## What attribution can't see

- **Dark social and word of mouth:** someone hears about us in a private chat or a podcast and types the URL. It shows as direct or brand search.
- **Cross-device and blocked tracking:** cookie consent, ad blockers and browser privacy features drop touches.
- **Offline:** events, calls and sales conversations, unless logged.
- **Brand effect of spend:** awareness campaigns that make later search clicks more likely.

Add a "How did you hear about us?" free-text or pick-list field on high-intent forms (self-reported attribution). Report it next to tracked attribution; differences between them are informative.

## Testing incrementality

Attribution says who touched the deal; incrementality asks whether the spend caused extra results. When a big budget decision depends on it, propose a test to your manager:

- **Holdout or geo test:** pause or run a channel in comparable regions or audiences and compare results.
- **On/off test:** pause a channel for a defined period and watch total SQLs, not just that channel's credited SQLs.
- **Platform lift studies,** where available and the volume is sufficient.

These need enough volume and a clean comparison. State the uncertainty plainly in the result.

## Reporting rules

1. Name the model at the top of every channel table.
2. Never switch models mid-quarter without a note, and recompute the prior period on the new model if you do.
3. Show total SQLs and pipeline alongside channel credit, so a shift in credit isn't mistaken for growth.
4. When channels "compete" for credit (paid search vs content), present both first- and last-touch views before recommending budget moves.
5. Don't claim causation from attribution alone. Write "credited to" rather than "drove".

## Example: same deal, different credit

A buyer reads a guide from organic search (touch 1), attends a webinar from a LinkedIn ad (touch 2), then searches the brand name and requests a demo (touch 3).

- First touch: organic search 100%.
- Last touch: brand search 100%.
- Linear: each one-third.
- Lead source: whatever the form captured at creation, often organic.

None of these is "true". Pick the model that matches the question you're answering, and say so.
