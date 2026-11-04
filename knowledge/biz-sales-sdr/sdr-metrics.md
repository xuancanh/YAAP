---json
{ "title": "SDR metrics", "summary": "Formulas and counting rules for qualified meetings, pipeline created, lead response time and lead-to-meeting conversion.", "tags": ["metrics", "meetings", "pipeline", "response-time", "conversion"], "updated": "2026-11-04" }
---

# SDR metrics

You're measured on results that matter to the business — qualified meetings and the pipeline they create — not on activity. Use the company's definitions if RevOps has set them; these defaults show what to make explicit.

## Qualified meetings

```
Qualified meetings = meetings held in the period and accepted by the AE
```

- **Held**: the prospect attended. Booked-but-no-show meetings don't count.
- **Accepted**: the AE confirmed it met the acceptance criteria.
- Report alongside: **meetings booked**, **show rate** (`held ÷ booked`) and **acceptance rate** (`accepted ÷ held`).

## Pipeline created

```
Pipeline created = Σ amount of opportunities created in the period
                   from meetings you sourced
```

- Count at opportunity creation with the AE's first amount estimate; note that amounts change.
- Report by source (inbound vs outbound) and segment.
- Also report **opportunity rate**: `opportunities created ÷ qualified meetings`.
- Later, track **sourced bookings**: closed-won amount from opportunities you sourced, over a longer window, because deals take time to close.

## Lead response time

```
Response time (per lead) = time of first human response − time lead was created
```

- First response means a real reply to the person, not an automated email.
- Report the **median** and a high percentile (for example, the 90th), separately for business hours and out of hours if the company staffs differently.
- Measure it from the CRM timestamps, not from memory.

## Lead-to-meeting conversion

```
Lead-to-meeting conversion = leads that became qualified meetings
                             ÷ leads received
```

- Use **cohorts**: leads received in a period, followed for a fixed window (for example, meetings held within 30 days of the lead). Otherwise leads from late in the month look like failures.
- Split by lead source and ICP tier; a blended number hides where the work pays off.

## Outbound diagnostics (for improving, not for targets)

```
Reply rate = replies ÷ prospects contacted
Positive reply rate = interested replies ÷ prospects contacted
Meeting rate = meetings booked ÷ prospects contacted
Opt-out rate = opt-outs ÷ prospects contacted
Bounce rate = bounces ÷ emails sent
```

Use these to compare messages and segments. A rising opt-out or bounce rate is a warning about list quality or relevance, and it affects deliverability for the whole company.

## Worked example

In October, 200 inbound leads arrived. Within 30 days, 24 became meetings, 20 were held, 16 accepted, creating 10 opportunities worth $180,000.

```
Show rate = 20 ÷ 24 = 83%
Acceptance rate = 16 ÷ 20 = 80%
Qualified meetings = 16
Lead-to-meeting conversion = 16 ÷ 200 = 8%
Opportunity rate = 10 ÷ 16 = 63%
Pipeline created = $180,000
```

## Rules

- State the period, the cohort window, the source and the pull date.
- Show counts beside every percentage.
- Don't chase activity counts (emails sent, calls made). They are inputs; report them only to explain a result.
