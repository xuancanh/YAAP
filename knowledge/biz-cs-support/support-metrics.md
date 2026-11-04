---json
{ "title": "Support metrics", "summary": "Definitions and formulas for first response time, resolution time, SLA attainment, CSAT and reopen rate, with reporting rules.", "tags": ["metrics", "sla", "csat", "response-time", "support"], "updated": "2026-11-04" }
---

# Support metrics

Use these definitions so your numbers can be compared week to week. If the support tool calculates a metric differently, report the tool's number and note the difference.

## First response time (FRT)

```
FRT (per ticket) = time of first substantive reply − ticket creation time
```

- Exclude automatic acknowledgements.
- Measure in business hours or calendar hours according to the customer's plan; say which.
- Report the **median** and a high percentile (for example the 90th) by priority. Averages hide long waits.

## Resolution time

```
Resolution time (per ticket) = time solved − ticket creation time
```

- If the policy pauses the clock while waiting on the customer, subtract paused time and say so.
- For reopened tickets, measure to the final solve.
- Report median and a high percentile by priority and category.

## SLA attainment

```
SLA attainment = tickets that met the target ÷ tickets with that SLA target
```

Report separately for first response and resolution, and by priority. A single blended number hides P1 misses behind many easy P4s.

Also list **breaches** with the reason (staffing, waiting on engineering, mis-triaged). Reasons point at the fix.

## Customer satisfaction (CSAT)

```
CSAT = satisfied responses ÷ total responses
```

- Define "satisfied" the way the survey does (for example the top two options on a five-point scale, or "good" on a good/bad survey).
- Always show the **response count** and **response rate** (`responses ÷ surveys sent`). A high score from a handful of replies is weak evidence.
- Read the comments. The low-score comments tell you whether the problem was the answer, the speed or the product.

## Reopen rate

```
Reopen rate = tickets reopened after being solved ÷ tickets solved
```

- Count a reopen when the customer replies that the issue is not fixed, not when they reply "thanks".
- Use the same window each time (for example, reopened within a set number of days after solve).
- High reopen rates usually mean incomplete answers or closing too early.

## First contact resolution (supporting metric)

```
FCR = tickets solved with one agent reply and no reopen ÷ tickets solved
```

Useful alongside reopen rate to show whether the first answer was complete.

## Reporting template

```
Period: <dates>  Source: <helpdesk>, exported <date>  Hours basis: business / calendar
Tickets: created n, solved m, backlog k
FRT median / p90: by P1–P4
Resolution median / p90: by P1–P4
SLA attainment: FRT x%, resolution y% (by priority); breaches with reasons
CSAT: z% from r responses (response rate q%); top themes from comments
Reopen rate: w%
Clusters and actions: …
```

## Pitfalls

- **Gaming FRT** with empty "looking into it" replies. A first response must move the ticket forward.
- **Closing to stop the clock.** It shows up as reopens and low CSAT.
- **Mixing channels.** Chat and email have different norms; report them separately.
- **Ignoring backlog.** Good times on solved tickets can hide old tickets nobody touched; report backlog age too.
