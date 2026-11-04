---json
{ "title": "Alert design checklist", "summary": "Rules for deciding what pages, what tickets and what is only a dashboard, and a checklist every alert must pass.", "tags": ["alerting", "on-call", "paging", "monitoring"], "updated": "2026-11-04" }
---

# Alert design checklist

Every page interrupts someone, possibly at night. An alert earns the right to page only if a human must act now to protect users. Everything else is a ticket or a dashboard.

## Three destinations

| Destination | When | Example |
|---|---|---|
| **Page** | Users are affected or will be soon, and a human must act now | Checkout SLO burning at a page-level rate |
| **Ticket** | Needs a human within working days; no user harm yet | Certificate expires in two weeks; disk will fill in ten days |
| **Dashboard / log** | Useful for diagnosis, no action on its own | CPU at 80% while latency is fine |

If you cannot say what the on-call should do when an alert fires, it is not a page.

## Symptoms over causes

Page on what users feel: errors, latency, freshness on key journeys (ideally as SLO burn rates; see [SLOs and burn-rate alerts](slo-and-burn-rate.md)). Cause-based signals (a host down, a queue growing) are often absorbed by redundancy and are better as tickets or as context on the symptom alert.

Exceptions where a cause should page: imminent, certain user harm that symptoms will catch too late, such as a backup job failing repeatedly or a security signal.

## Checklist for every alert

- [ ] **Actionable:** the on-call can do something about it now.
- [ ] **Urgent:** waiting until working hours would harm users. If not, make it a ticket.
- [ ] **Owned:** a named team or role receives it.
- [ ] **Runbook linked:** the alert text contains the runbook link.
- [ ] **Clear title:** says the symptom and the scope: "Checkout errors at 7% (EU)".
- [ ] **Context included:** current value, threshold, time window, link to the dashboard.
- [ ] **Not a duplicate:** one incident should not produce ten pages. Group or inhibit related alerts.
- [ ] **Tested:** you have seen it fire (in a test or a past incident) and clear.
- [ ] **Resolves itself:** clears automatically when the condition ends.

## Reviewing noisy alerts

For each alert that fired in the period, record what the on-call did. Then:

| Outcome | Change |
|---|---|
| Real issue, action taken | Keep. Check runbook accuracy. |
| Real issue, but no action needed (self-healed) | Lengthen the window or raise the threshold; consider a ticket instead. |
| False alarm | Fix the query or threshold; if unfixable, delete it. |
| Duplicate of another alert | Merge or add an inhibition rule. |
| Incident with no alert, or alert came late | Add a symptom alert or shorten the window. |

Delete alerts no one acts on. An alert that is always ignored is training the on-call to ignore pages.

## On-call load

Track pages per shift and out-of-hours pages (formulas in [reliability metrics](reliability-metrics.md)). When load is above the target in `/org/engineering/kpis.md`, the fix is fewer, better alerts and automation of repeated fixes, not more people absorbing pages.

## Alert text template

```
[SEV?] <Symptom> on <journey/service> (<scope>)
Now: <value> over <window>; threshold <value>
Impact: <who is affected, if known>
Runbook: <link>   Dashboard: <link>
```

## Pitfalls

- Static thresholds on metrics that follow daily traffic patterns: they fire every night or never. Use rates and ratios.
- Alerting on averages: an average latency can look fine while a fifth of users wait. Use the share of requests under a threshold.
- Paging on warnings "just in case". Send them to a ticket queue and review weekly.
