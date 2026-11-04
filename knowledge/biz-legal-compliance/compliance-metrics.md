---json
{ "title": "Compliance metrics", "summary": "Definitions and formulas for DSRs within deadline, regulatory deadlines met and records of processing current, with supporting measures and reporting format.", "tags": ["metrics", "kpis", "compliance", "dsr", "ropa"], "updated": "2026-11-04" }
---

# Compliance metrics

These metrics show the General Counsel whether the company meets its obligations and how close it runs to the line. A 100% figure with no detail tells them less than a 95% figure with the near-misses listed.

## DSRs within deadline

> **DSRs within deadline %** = requests closed by their legal deadline ÷ requests whose deadline fell in the period

- Use the deadline that applies to the request: the original one, or the extended one only if the extension was validly notified in time. An extension sent late doesn't count.
- Count by deadline date in the period, not by received date, so open requests aren't hidden.
- Report the open requests and their days remaining too.

**Supporting measures**
- **Median days to close** = median of (closed date − received date) for requests closed in the period.
- **Requests by type and channel**: shows where requests arrive and where intake training is needed.
- **Late intake**: requests that reached you more than a few days after the company received them. The clock started anyway.

## Regulatory deadlines met

> **Deadlines met %** = obligations completed on or before their due date, with evidence ÷ obligations due in the period

- "With evidence" means the receipt, filing confirmation or signed document is attached. Without it, the item isn't counted as met.
- Report **at risk**: items due in the next 30 days that are behind their lead time.
- Report **found late**: obligations added to the calendar after their lead time had started. These are gaps in the list, the most important thing to fix.

## Records of processing current

> **RoPA current %** = processing activities reviewed and confirmed by their owner within the review period ÷ processing activities in the record

- The review period is your quarterly cycle unless the General Counsel sets another.
- Also track **coverage**: tools or vendors handling personal data (from the IT inventory and vendor list) that have no matching activity in the record. Coverage gaps matter more than stale rows, because nobody is managing that data.

> **Coverage gaps** = count of personal-data tools or vendors with no record entry

- **DPA gaps** = processors without a compliant contract on file.

## Assessments

- **Assessments before launch** = assessments completed before the processing started ÷ assessments required in the period. An assessment completed after launch should be counted as late, not as done.
- **Open high residual risks** = count, with owner and plan.

## Reporting format

Monthly to the General Counsel, quarterly with trends:

| Metric | This period | Last period | Note |
|---|---|---|---|
| DSRs within deadline | 11/11 | | 1 extended (notified day 20) |
| Median days to close a DSR | | | |
| Regulatory deadlines met | | | |
| At risk (next 30 days) | | | |
| Found late | | | |
| RoPA current | | | |
| Coverage gaps / DPA gaps | | | |
| Assessments before launch | | | |

Add one line per miss or near-miss: what happened, the cause, and the change made.

## Pitfalls

- Excluding a request because the identity check took time. The deadline still applied.
- Counting a policy review as done when the redline is drafted but not approved.
- Reporting percentages on tiny numbers without the counts.
- Using personal details in the metrics report. Use counts and reference ids.
