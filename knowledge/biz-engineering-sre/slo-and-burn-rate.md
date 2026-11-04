---json
{ "title": "SLOs, error budgets and burn-rate alerts", "summary": "How to pick SLIs, compute error budgets and burn rates, and set multiwindow burn-rate alerts with worked numbers.", "tags": ["slo", "sli", "error budget", "burn rate", "alerting"], "updated": "2026-11-04",
  "sources": [{ "title": "Google SRE Workbook, Alerting on SLOs (read 2026-11-04)", "url": "https://sre.google/workbook/alerting-on-slos/" },
              { "title": "Google SRE Book, Service Level Objectives", "url": "https://sre.google/sre-book/service-level-objectives/" }] }
---

# SLOs, error budgets and burn-rate alerts

## Terms

- **SLI (indicator):** a ratio of good events to valid events, measured where users feel it. `SLI = good events / valid events`.
- **SLO (objective):** the target for the SLI over a window, for example 99.5% of sign-in requests succeed over 30 days.
- **Error budget:** the share of events allowed to fail. `budget = 1 − SLO`.
- **Burn rate:** how fast you spend the budget compared with spending it evenly over the window. `burn rate = observed error rate / (1 − SLO)`. A burn rate of 1 uses exactly the budget by the end of the window.

## Choosing SLIs

For each critical journey pick one or two:

| Type | Good event | Valid event |
|---|---|---|
| Availability | Request returned a non-error response | All requests, excluding ones rejected for bad client input |
| Latency | Request completed under the threshold | All successful requests |
| Freshness (pipelines) | Data updated within the threshold | All checks |
| Correctness (jobs) | Job output passed validation | All job runs |

Measure as close to the user as you can: the load balancer or client, not a single server. Write down exactly which status codes count as errors and which requests are excluded, so the number is reproducible.

## Worked budget example

SLO 99.5% availability over 30 days, about 2,000,000 requests a month.

```
budget            = 1 − 0.995 = 0.005
allowed failures  = 0.005 × 2,000,000 = 10,000 requests
as time (if traffic were even) = 0.005 × 30 days × 24 h ≈ 3.6 hours
```

Halfway through the month, 6,000 requests have failed. Budget used = 60% at 50% of the window: you are burning faster than sustainable, so watch it and flag risky releases.

## Burn-rate alerting

Alerting on "error rate above X" is either noisy or slow. Alert on burn rate instead: it ties the page to how much budget is at risk.

The Google SRE Workbook recommends **multiwindow, multi-burn-rate** alerts. Its example for a 99.9% SLO over 30 days:

| Severity | Long window | Short window | Burn rate | Budget consumed |
|---|---|---|---|---|
| Page | 1 hour | 5 minutes | 14.4 | 2% |
| Page | 6 hours | 30 minutes | 6 | 5% |
| Ticket | 3 days | 6 hours | 1 | 10% |

An alert fires only when **both** windows exceed the burn rate. The long window proves it is significant; the short window makes the alert clear soon after the problem stops.

To translate a burn rate into an error-rate threshold for your SLO:

```
error-rate threshold = burn rate × (1 − SLO)
```

For a 99.5% SLO and burn rate 14.4: `14.4 × 0.005 = 0.072`, so page when more than 7.2% of requests fail over both the last hour and the last five minutes.

The budget-consumed column follows from: `budget consumed = burn rate × long window / SLO window`. For example `14.4 × 1 h / 720 h = 2%`.

### Low traffic

With few requests, one failure can be a large share of an hour. Options: lengthen windows, alert on a minimum count of failures as well as the rate, add synthetic checks to create steady traffic, or combine similar low-traffic journeys into one SLI.

## Acting on the budget

Agree the policy with the Head of Engineering in advance, and write it in `slos.md`, so the response is not argued during a bad week. A typical shape:

- **Healthy:** release normally.
- **Burning fast:** warn the Head of Engineering; review recent changes; pause risky launches.
- **Exhausted:** propose a freeze on feature releases until reliability work brings the SLI back, as your skill describes.

## Pitfalls

- An SLO of 100% leaves no room for change. Pick a target users would actually notice falling below.
- Too many SLOs. Start with the few journeys that matter; more SLOs dilute attention.
- SLOs that nobody acts on. If budget exhaustion changes nothing, the SLO is decoration; raise it in the weekly review.
