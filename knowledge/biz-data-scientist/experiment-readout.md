---json
{ "title": "Experiment readout: checks and template", "summary": "The validity checks to run before reading a result, the common traps (peeking, multiple comparisons, novelty), a readout template and the formula for valid readouts.", "tags": ["experiments", "readout", "srm", "statistics", "kpi"], "updated": "2026-11-04",
  "sources": [{ "title": "Fabijan et al., Diagnosing Sample Ratio Mismatch in Online Controlled Experiments (KDD 2019, Microsoft Research)", "url": "https://www.microsoft.com/en-us/research/?p=651990" }] }
---

# Experiment readout

A readout says what happened, how sure we are, and what to do. It follows the design's pre-registered plan; anything new is labelled exploratory.

## Validity checks first

Run these before looking at the primary result. If one fails, the result is invalid until explained.

1. **Sample ratio mismatch (SRM).** Compare the observed split with the planned one using a chi-square goodness-of-fit test. A significant mismatch means assignment or logging is broken, and the effect estimate cannot be trusted. Fabijan and colleagues (KDD 2019) give a taxonomy of SRM causes: assignment bugs, redirects, bots, triggering and logging differences between variants.
2. **Exposure logging.** Both variants log exposure the same way, at the same point in the flow.
3. **Pre-period balance.** Groups look similar on the primary metric measured before the experiment.
4. **Experiment ran as designed.** Planned dates, population and split; no mid-test changes to the treatment.
5. **Data complete.** Metric window elapsed for all enrolled units; no pipeline incidents in the period.

## Reading the result

Report the **effect with a confidence interval**, not just a p-value.

```
effect (absolute) = treatment mean − control mean
effect (relative) = effect / control mean
95% CI (difference of rates) ≈ effect ± 1.96 × √( p_t(1−p_t)/n_t + p_c(1−p_c)/n_c )
```

How to read it:

- **Interval excludes zero, in the good direction:** evidence of a positive effect. The interval shows the plausible size range.
- **Interval includes zero:** no reliable evidence of an effect. If the interval is narrow around zero, the effect is likely small; if wide, the test could not tell.
- **Interval excludes zero, bad direction:** evidence of harm.

A p-value is the probability of data at least this extreme if there were no effect. It is not the probability that the treatment works.

## Traps

- **Peeking.** Checking repeatedly and stopping when significant inflates false positives well above α. Stop at the planned end, or use a sequential method designed for interim looks.
- **Multiple comparisons.** Many metrics or segments mean some will look significant by chance. Only the primary metric decides; correct secondary and segment results (for example, Bonferroni or Benjamini–Hochberg) or label them exploratory.
- **Post-hoc segments.** "It worked for mobile users in Germany" found after the fact is a hypothesis for the next test, not a result.
- **Novelty and learning effects.** Behaviour right after a change can differ from steady state. Plot the effect by day; if it fades, say so.
- **Guardrails ignored.** A primary win with a breached guardrail is not a win; follow the decision rule.
- **Underpowered "no effect".** Absence of evidence is not evidence of absence. State the interval and the MDE the test could detect.

## Template

```markdown
# Readout: <experiment>   Dates: … Units: n_c / n_t
## Verdict
<Keep | Don't keep | Inconclusive> — one sentence.
## Validity
SRM: p = … (pass/fail)  Logging: …  Balance: …  Ran as designed: …
## Primary metric
Control … Treatment … Effect … (95% CI … to …)
## Guardrails
| Metric | Effect | CI | Limit | OK? |
## Secondary (not deciding)
…
## Exploratory (not pre-registered)
…
## Recommendation and confidence
<What to do, what is uncertain, what to test next.>
```

## KPI: experiments read out validly

```
experiments read out validly = readouts that passed all validity checks,
                               followed the pre-registered primary metric
                               and stopping rule, and reported an interval
                               / readouts delivered in the period
```

A readout that correctly declares a result invalid (for example, SRM found and explained) counts as valid work: the readout was honest. Track the causes of failures to fix the experimentation process.
