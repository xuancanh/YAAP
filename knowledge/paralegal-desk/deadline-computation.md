---json
{ "title": "Deadline computation method", "summary": "A step-by-step method for computing and documenting deadlines, with US federal Rule 6 as a worked example and a checklist of the traps that cause missed dates.", "tags": ["deadlines", "computation", "calendar", "frcp", "jurisdiction-specific"], "updated": "2026-11-04",
  "sources": [{ "title": "Federal Rules of Civil Procedure, Rule 6 — Computing and extending time (Cornell LII)", "url": "https://www.law.cornell.edu/rules/frcp/rule_6" }] }
---

# Deadline computation method

A missed deadline can end a case. The method below makes every computation visible, so a second person can check it. **For attorney review. Verify against the current controlling rules.**

## The method

1. **Identify the trigger.** What event starts the clock (service, filing, entry of an order, a hearing date)? Record its exact date and, if it matters, the time and method of service.
2. **Identify the controlling rules,** in order of specificity: a court order or the judge's procedures, local rules, the court's general rules, statute. Note each source and the version date.
3. **Find the period** and its unit (days, court days, business days, months, hours) and direction (after the trigger, or before a later event such as a hearing).
4. **Apply the counting rules** for that jurisdiction: which day to exclude, whether weekends and holidays count, what happens if the last day falls on a weekend or holiday.
5. **Apply any extensions** for the service method, if the jurisdiction has them.
6. **Check the end-of-day rule:** when does the last day end for e-filing versus paper filing?
7. **Write it down** in the calculation format below.
8. **Second check** by another person, independently.
9. **Calendar** with a lead-time ladder (e.g. 14 days, 7 days, 2 days, due).

## Calculation format

```
Deadline: <what is due>
Trigger:  <event>, <date>, served by <method>
Rule(s):  <citation(s)>, version checked <date>
Period:   <n> days after <trigger>
Count:    Day 1 = <date> … Day n = <date>
Adjust:   <weekend/holiday roll-forward, service extension>
Due:      <date>, by <time + time zone> (<e-filing / paper>)
Checked by: <name>, <date>
FLAG: verify against current rules and any order in this case.
```

## Worked example: US federal civil (illustration only)

Under the Federal Rules of Civil Procedure, Rule 6(a)(1), for periods stated in days: exclude the day of the triggering event, count every day including weekends and legal holidays, and include the last day; if the last day is a Saturday, Sunday or legal holiday, the period runs to the next day that isn't. Under Rule 6(a)(4), for electronic filing the last day ends at midnight in the court's time zone; for other filing, when the clerk's office is scheduled to close. Rule 6(d) adds three days after the period would otherwise expire when service was made by mail, by leaving with the clerk, or by other means consented to. (Electronic service was removed from Rule 6(d) in 2016.)

Example: a 14-day period triggered by service by mail on Friday 6 November 2026.

```
Trigger: served by mail, Fri 6 Nov 2026
Count:   Day 1 = Sat 7 Nov … Day 14 = Fri 20 Nov 2026
Rule 6(d): +3 days → Mon 23 Nov 2026
Weekend/holiday check: Mon 23 Nov is a weekday, not a federal holiday
Due: Mon 23 Nov 2026, 11:59 pm court's time zone (e-filing)
FLAG: verify against FRCP current text, local rules, and any order.
```

The specific period for any filing comes from the rule that creates it; this example shows the counting only.

## Traps checklist

- [ ] Counting backwards from a hearing date (different rules often apply)
- [ ] "Court days" or "business days" versus calendar days
- [ ] State and local holidays (Rule 6(a)(6) includes state holidays where the court sits, for forward-counted periods)
- [ ] Court closures or weather closures
- [ ] Service extensions that apply in one jurisdiction but not another
- [ ] Periods in months (which day of the month?)
- [ ] Time zone of the court, not the office
- [ ] An order in the case that changes the default
- [ ] Limitation periods (statutes of limitations), which have their own rules for when they start and can be paused or extended. These are attorney determinations; never compute one as final.

## Common mistakes

- Computing once, without a second check.
- Calendaring only the due date, with no ladder.
- Applying federal counting rules in state court, or the reverse.
- Relying on a deadline calculator without reading the rule.
