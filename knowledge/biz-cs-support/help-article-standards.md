---json
{ "title": "Help article standards", "summary": "Article types, a template and a maintenance routine for help articles written from solved tickets.", "tags": ["knowledge-base", "help-centre", "writing", "kcs"], "updated": "2026-11-04",
  "sources": [{ "title": "Consortium for Service Innovation — KCS v6 Practices Guide (accessed 2026-11-04)", "url": "https://library.serviceinnovation.org/KCS/KCS_v6/KCS_v6_Practices_Guide" }] }
---

# Help article standards

Help articles exist so the next customer solves the problem without a ticket, and the next agent answers it in a minute. Write them from real tickets, in the customer's words, and keep them true.

## Capture knowledge while you work

The Knowledge-Centered Service (KCS) method from the Consortium for Service Innovation captures and structures knowledge in the workflow of solving tickets, and treats every reuse of an article as a review of it ("reuse is review"): the people who use knowledge daily are the best ones to create and improve it. In practice:

- When you solve a ticket and no article covers it, draft one before you close the ticket.
- When you use an article and it is incomplete or wrong, fix it (or flag it) right then.
- Use the words customers used in their tickets for titles and search terms, not internal names.

## Article types

| Type | Use for | Title pattern |
|---|---|---|
| **How-to** | a task with steps | "How to export invoices" |
| **Troubleshooting** | a symptom with causes and fixes | "Invoice export is empty" |
| **Reference** | settings, limits, definitions | "Billing roles and permissions" |
| **Concept** | how something works and why | "How invoice numbering works" |

Pick one type per article. Mixed articles are hard to scan.

## Template (how-to and troubleshooting)

```
Title: the task or the symptom, in customer words
Applies to: plans, roles, platforms
Summary: one sentence — what this article helps you do

Before you start: permissions or setup required

Steps:  (how-to)
  1. One action per step, with exact UI names in bold
  2. …
  Result: what they should see when it worked

Causes and fixes:  (troubleshooting)
  Cause 1 — how to check — how to fix
  Cause 2 — …

Still stuck? How to contact support and what to include
Related: links to 2–3 related articles
Last reviewed: date, owner
```

## Writing rules

- Lead with the outcome. Put the most common cause first.
- Short sentences. One action per step.
- Use screenshots only where they save words, and redact any data.
- Name buttons and menus exactly as they appear.
- State plan or role limits up front so readers don't follow steps that won't work for them.
- Never include internal-only information, workarounds that bypass security, or roadmap promises.

## When to write or update

Your skill names the trigger (the same question three or more times, or a wrong article). Also update when:

- A release changes the UI or behaviour
- An article's search term returns tickets anyway (it is not answering the question)
- A customer replies "that didn't work" after being sent the article

## Maintenance routine

- Every article has an owner and a "last reviewed" date.
- Review high-traffic articles after each release that touches their area.
- Archive articles for retired features; redirect links if the tool supports it.
- Track **article-linked resolutions**: tickets solved by sending an article. A rising count means the help centre is working.

## Review checklist

- [ ] Title matches what customers search for
- [ ] Steps tested on the current version
- [ ] Applies-to line correct
- [ ] No customer data in text or images
- [ ] Linked from related articles and tagged
- [ ] Reviewer approved (per the company's publishing process)
