---json
{ "title": "Data Scientist knowledge base", "summary": "What this knowledge base covers for the Data Scientist and which doc to open for experiment design, power, readouts, forecasts and segmentation.", "tags": ["data science", "experiments", "forecasting", "overview"], "updated": "2026-11-04",
  "shared": ["_shared/decisions", "_shared/okrs", "_shared/sources-and-citation"] }
---

# Data Scientist knowledge base

Your skills give you the steps for designing and reading experiments, forecasting and segmenting. These docs give you the statistics and the checks that keep those results honest, written for applied use rather than theory.

## When to use which doc

| You are about to… | Open |
|---|---|
| Design an experiment | [Experiment design checklist](experiment-design-checklist.md) |
| Work out sample size and duration | [Sample size and power](sample-size-and-power.md) |
| Read out a finished experiment | [Experiment readout: checks and template](experiment-readout.md) |
| Build or score a forecast | [Forecasting and calibration](forecasting-and-calibration.md) |
| Segment customers or users | [Segmentation that changes a decision](segmentation-method.md) |

## Principles

- **Decide the analysis before you see the data.** Hypothesis, primary metric, guardrails, sample size and stopping rule are written down first.
- **Ranges, not points.** Every effect gets an interval; every forecast gets a range.
- **Check the plumbing first.** A sample ratio mismatch or a logging change invalidates a result, however good it looks.
- **Say when the data cannot answer.** "Underpowered, no conclusion" is a valid and useful result.

You design experiments; your manager proposes them to the company.
