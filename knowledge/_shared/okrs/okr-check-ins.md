---json
{ "title": "OKR check-ins", "summary": "How to run a short, regular confidence check-in on each key result, and what to do when one turns red.", "tags": ["okrs", "goals", "check-ins", "cadence"], "updated": "2026-11-04",
  "sources": [
    { "title": "Set goals with OKRs", "url": "https://rework.withgoogle.com/en/guides/set-goals-with-okrs", "publisher": "Google re:Work", "accessed": "2026-11-04" }
  ] }
---

# OKR check-ins

A key result you look at once a quarter is a wish. A short check-in on a regular cadence catches drift while there's still time to act. Weekly is common, but use whatever cadence your company has set.

## What a check-in records

Record four things for each KR:

1. **Current value**, with its source. Pull it from the metric source or file. If you can't get it, write "no reading" and why. Never fill the gap with a guess.
2. **Confidence** that you'll hit the target by the date: green, yellow or red, or a 0–10 number if your company uses one.
3. **What changed** since last time, in one line.
4. **Next step**: the one thing that will move it, with an owner.

Confidence is a forecast, not a progress bar. A KR at 20% of target in week two can be green. A KR at 80% with a flat trend and four weeks left can be red.

| Colour | Means |
|---|---|
| Green | On track, no help needed |
| Yellow | At risk, with a plan to recover |
| Red | Won't hit it on the current path, needs a decision |

## Template

```markdown
## OKR check-in: 2026-11-04

### O1 New customers get value in their first week (committed)

| KR | Baseline | Now | Target | Conf. | Source |
|---|---|---|---|---|---|
| KR1 Week-one activation | 40% | 44% | 60% | yellow | analytics: activation_w1 |
| KR2 Median time to first task | 3 d | 2.5 d | 1 d | green | analytics |
| KR3 Onboarding tickets/month | 30 | no reading | 15 | yellow | helpdesk export overdue (asked Support lead) |

- Changed: checklist shipped Tuesday; KR1 up 4 points.
- Next: KR1, test the empty-state prompt (owner: Growth lead, by 2026-11-11).
- Help needed: none.
```

Keep check-ins in one file, for example `/org/okrs/2026-q4-checkins.md`, newest first, so the history shows the trend.

## When a KR turns red

Red is information, not failure. Don't hide it, and don't quietly lower the target. Work through these steps in order:

1. **Check the number.** Is the source right, and does it measure what you think? A broken dashboard looks just like a red KR.
2. **Find the cause.** Was it the wrong bet, not enough effort, a blocker, or a target that was never realistic?
3. **Pick a response** and write it down:
   - *Change the approach*: new tasks on the board, each with a done_when.
   - *Add effort*: move work off a lower-priority item, and say what you're dropping. See [prioritisation](../prioritisation/impact-effort-and-rice.md).
   - *Unblock*: name the blocker and ask its owner directly.
   - *Reset the target*: only if the objective's owner agrees. Log it in `/org/decisions.md` with the reason.
   - *Drop the KR*: the same rule applies. Dropping is allowed. Doing it silently isn't.
4. **Tell the owner.** A red KR goes to the objective's owner the same day, in two or three sentences: what happened, why, and what you propose.
5. **Add a risk** if the miss affects other people's work. See [risk registers](../risk/risk-registers.md).

## Two reds in a row

If a KR stays red for two check-ins and the approach hasn't changed, raise it as a decision: keep going, change course, or stop. Saying "red, working on it" twice isn't a plan.

## Checklist

- [ ] Every KR has a current value with a source, or "no reading" with a reason
- [ ] Confidence is a forecast, not percent complete
- [ ] Every yellow and red has a next step with an owner and a date
- [ ] Reds go to the objective owner the same day
- [ ] Target changes and drops are logged as decisions

## Common pitfalls

- **Watermelon status**: green outside, red inside. Report what you actually believe.
- **Long check-ins.** A check-in takes minutes. Deep dives are separate tasks.
- **Updating the number without its source.** The next reader can't trust it.
- **Moving the goalposts at the end of the cycle.** Change targets early and in the open, as a logged decision.

For writing the KRs themselves, see [writing key results](./writing-key-results.md).
