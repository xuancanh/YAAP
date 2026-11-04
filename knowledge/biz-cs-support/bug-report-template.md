---json
{ "title": "Bug report template", "summary": "A bug report template with reproduction method and severity guidance so engineering can act without asking back.", "tags": ["bug-report", "template", "engineering", "support"], "updated": "2026-11-04" }
---

# Bug report template

A bug report is ready when an engineer who has never seen the ticket can reproduce the problem from it alone. Every question they have to ask back costs a day.

## Reproduce first

1. **Get the facts** from the customer: what they did, what they expected, what happened, when, which browser or app version, error text or screenshot.
2. **Try it yourself** in a test account or sandbox with the same plan and settings. Never use the customer's account to experiment unless policy allows and they agree.
3. **Narrow it down**: does it happen every time? With another browser? Another user role? Only with certain data? Change one thing at a time.
4. **Check if it is known**: search existing bugs, release notes and the status page. If it exists, add the ticket to that bug instead of filing a new one.

If you cannot reproduce, say so in the report and include everything you tried.

## Template

```
Title: [Area] What fails, under what condition
  e.g. "[Invoices] CSV export is empty when date range spans two years"

Summary: one or two sentences on the impact.

Environment:
  Product area / feature:
  Plan / account type:
  Browser or app version, OS:
  Date and time first seen (with time zone):

Steps to reproduce:
  1.
  2.
  3.

Expected result:
Actual result:   (exact error text; screenshot or recording attached)

Reproducible: always / sometimes (n of m tries) / not reproduced
What I tried: browsers, roles, data variations and results

Impact:
  Customers affected: count and links to tickets (no customer data in the body)
  Workaround: yes / no — describe it
  Business impact: what they cannot do

Severity (proposed): S1 / S2 / S3 / S4 with one-line reason
Logs / IDs: request IDs, error codes, timestamps
```

## Severity guidance

Severity describes the defect; priority (set by engineering) decides when it is fixed. Propose severity from impact:

- **S1**: core function down, data loss or corruption, security exposure, no workaround
- **S2**: major function broken for many users, or workaround is painful
- **S3**: function partly broken, reasonable workaround exists
- **S4**: cosmetic or minor inconvenience

Use the company's scale if it has one; this is a default.

## Protecting customer data

- Link to tickets rather than pasting customer emails, names or records.
- Redact screenshots: names, emails, payment details, tokens.
- If engineering needs real data to reproduce, follow the company's data access process.

## After filing

- Link the bug to every related ticket.
- Tell the customer it has been reported, what the workaround is and that you'll update them when there's news. Do not give fix dates unless engineering has committed one.
- When the fix ships, update linked tickets and confirm with the customer that it works.

## Pitfalls

- **Titles like "Doesn't work".** Say what fails and when.
- **Missing expected result.** Engineers need to know what "right" looks like.
- **Several bugs in one report.** File one per defect and link them.
- **Severity inflation.** Calling everything S1 means nothing is. Use the impact rules.
