---json
{ "title": "Writing key results", "summary": "How to turn an objective into 3–5 measurable key results with a baseline, a target and a metric source, and how to score them.", "tags": ["okrs", "goals", "metrics", "planning"], "updated": "2026-11-04",
  "sources": [
    { "title": "What is an OKR? Definition and examples", "url": "https://www.whatmatters.com/faqs/okr-meaning-definition-example", "publisher": "What Matters (John Doerr)", "accessed": "2026-11-04" },
    { "title": "Set goals with OKRs", "url": "https://rework.withgoogle.com/en/guides/set-goals-with-okrs", "publisher": "Google re:Work", "accessed": "2026-11-04" }
  ] }
---

# Writing key results

An objective says what you want to achieve. Key results (KRs) say how you'll know you got there. A KR is either met or not. If two people could read it and argue about whether it happened, rewrite it.

The method comes from Andy Grove at Intel, and John Doerr made it popular. Doerr's guidance is 3–5 KRs per objective.

## The shape of a good KR

```
<metric> from <baseline> to <target> by <date> (source: <where the number comes from>)
```

Every KR needs all five parts:

- **Metric**: one thing you can count or check.
- **Baseline**: where it is today. If you don't know, the first KR can be "measure it". Don't guess a baseline.
- **Target**: the number that counts as done.
- **Date**: usually the end of the cycle.
- **Source**: the metric source, file or named person the number comes from. A number with no source is an estimate and must be labelled as one.

## Outcomes, not outputs

An output is something you ship. An outcome is the change it causes. Prefer outcomes. Outputs belong on the board as tasks.

| Output (task) | Outcome (KR) |
|---|---|
| Publish 8 blog posts | Organic sign-ups from 120/month to 200/month |
| Launch the onboarding checklist | Share of new workspaces that create a first task in week one, from 40% to 60% |
| Hold 10 customer calls | 3 written case studies approved by the customer |

The numbers above are illustrations, not benchmarks. A quick test: if you could hit the KR and nothing got better for anyone, it's an output.

Output KRs are fine when the outcome is too slow to show inside the cycle, like a first launch or a compliance milestone. Say so in a note so nobody mistakes it for proof of value.

## Leading and lagging

Lagging metrics (revenue, churn) confirm results but move late. Leading metrics (trials started, week-one activation) move early and predict the lagging ones. A healthy objective mixes both: one lagging KR you ultimately care about, plus one or two leading KRs you can watch move week to week.

Pair any KR that can be gamed with a counterweight. "Support replies under 2 hours" goes with "customer satisfaction stays at or above its current level".

## Committed or aspirational

Say which kind each objective is.

- **Committed**: you expect to hit it fully. A miss is a problem to explain.
- **Aspirational**: a stretch. Google's re:Work guide puts the expected average across OKRs at 0.6–0.7 on a 0.0–1.0 scale. If you keep scoring 1.0, your targets are too low.

## Scoring

At the end of the cycle, score each KR from 0.0 to 1.0 (Google's method) or simply met/not met (Grove's). The objective's score is roughly the average of its KRs. Add one line on why: what moved the number and what didn't.

Keep the score honest. A 0.4 with a clear reason is more useful than a 0.9 nobody believes.

## Worked example

Objective: *New customers get value in their first week.*

```
KR1 Week-one activation (created ≥1 task) from 40% to 60% by 2026-12-31
    (source: product analytics, "activation_w1" dashboard)
KR2 Median time to first task from 3 days to 1 day by 2026-12-31
    (source: product analytics)
KR3 Onboarding-related support tickets from 30/month to 15/month
    (source: helpdesk export, /org/metrics/support.csv)
```

KR1 is the outcome. KR2 is a leading signal. KR3 is a counterweight that shows the fix didn't just push the pain onto support. If the activation baseline were missing, KR1 would read "Baseline measured and recorded in /org/metrics/activation.md by 2026-11-15", with the target set once it's known.

## Checklist

- [ ] 3–5 KRs, each with a metric, baseline, target, date and source
- [ ] Mostly outcomes, and any output KR has a note saying why
- [ ] At least one leading KR
- [ ] Every gameable KR has a counterweight
- [ ] Marked committed or aspirational
- [ ] No number without a source or an "estimate" label

## Common pitfalls

- **Task lists dressed up as KRs.** "Ship X" is a task. Put it on the board with a done_when.
- **Invented baselines.** If the number isn't in a metric source, a file or from a named person, measure it first.
- **Too many KRs.** Past five, nobody tracks them. Cut.
- **Vague verbs.** "Improve", "optimise" and "support" aren't KRs without a number.
- **Set and forget.** KRs need a regular check. See [OKR check-ins](./okr-check-ins.md).
