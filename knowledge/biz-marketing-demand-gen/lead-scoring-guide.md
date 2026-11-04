---json
{ "title": "Lead scoring guide", "summary": "How to build and calibrate fit and engagement scoring against what sales accepts, with a monthly review method and common failure modes.", "tags": ["lead scoring", "mql", "sales alignment", "crm"], "updated": "2026-11-04" }
---

# Lead scoring guide

Lead scoring exists to send sales the leads most likely to become pipeline, and to keep the rest in nurture. A scoring model is a hypothesis; the monthly review tests it against what sales actually accepted and converted.

## Two dimensions: fit and engagement

Score them separately, then combine. One number hides why a lead scored high.

| Dimension | Question | Typical inputs |
|---|---|---|
| **Fit** | Is this the kind of buyer we win? | Company size, industry, region, role and seniority, tech used |
| **Engagement** | Are they showing interest now? | Demo request, pricing page visits, trial activity, webinar attendance, content downloads, email clicks |

A simple grid works better than a single threshold:

| | High engagement | Low engagement |
|---|---|---|
| **High fit** | MQL now | Nurture, target with ads |
| **Low fit** | Check, often route to self-serve | Nurture or ignore |

**Hand-raisers skip scoring.** A demo or contact-sales request from a reasonable-fit lead should route straight to sales.

## Building weights from evidence

1. Pull closed-won and closed-lost (or SQL vs rejected) leads from the last two or three quarters, as many as you have.
2. For each attribute or action, compare how often it appears among converted leads vs non-converted leads.
3. Give points to attributes that are clearly more common among converted leads; negative points to ones that predict rejection (students, competitors, personal email domains if that matters for your business).
4. Set the MQL threshold where sales can follow up on all MQLs within the agreed SLA. A threshold sales can't keep up with produces ignored MQLs.
5. Write the model in `/org/marketing/lead-scoring/<date>.md`: every rule, its points and the evidence.

With small samples, keep the model simple (a few strong rules) and say so.

## Engagement decay

Interest fades. Reduce engagement points over time (for example, halve or remove points for activity older than a set number of days) so a lead who downloaded something a year ago isn't scored as hot. Choose the window from your typical sales cycle.

## The monthly review

Inputs: last month's MQLs with their score breakdown, sales status (accepted, rejected with reason, converted) and the current model.

```
MQL acceptance rate  = MQLs accepted by sales / MQLs routed
MQL → SQL rate       = SQLs from MQL cohort / MQL cohort
Rejection mix        = count of rejections by reason / total rejections
Missed-good rate     = SQLs that were never MQL (came via other routes) / total SQLs
```

Questions to answer:

1. **Are we sending junk?** Low acceptance: look at the rejection reasons. Which rule let those leads through?
2. **Are we missing good leads?** High missed-good rate: which attributes did those SQLs have that we don't score?
3. **Are we flooding sales?** Is follow-up within SLA? If not, raise the threshold or tighten fit.
4. **Did anything change?** New forms, new content, new segments, changes in sales qualification criteria.

Propose changes as a short table: rule, current points, proposed points, evidence, expected effect. Agree changes with sales (and RevOps if they own the CRM) before applying. Note the change date so the funnel readout can mark it.

## Rejection reasons

Ask sales to pick from a fixed list. Free text can't be counted:

- Not a fit (size, industry, region)
- No need or no project
- Student, job seeker, competitor or vendor
- Duplicate or existing customer
- Unreachable or bad data
- Already in an active deal

## Common failure modes

- **Scoring content consumption too high.** Readers of top-of-funnel guides are often learners, not buyers.
- **No negative scoring,** so irrelevant leads accumulate points by browsing.
- **Changing the model and the MQL definition the same month as a big campaign,** so you can't tell which caused the change.
- **Gaming the threshold** to hit an MQL target. MQLs are a means; SQLs and pipeline are the result.
- **Score as a black box to sales.** Show the top reasons on the lead record so reps know what to open with.

## Privacy note

Scoring uses personal data. Use only data collected under the company's privacy notice, avoid sensitive characteristics, and check with Legal before adding new data sources such as enrichment vendors. Rules vary by jurisdiction.
