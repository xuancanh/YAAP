---json
{ "title": "People metrics", "summary": "Definitions and formulas for the people key results (time to hire, offer acceptance, stage conversion, attrition, regretted attrition, eNPS, onboarding completion) and how to write them down.", "tags": ["metrics", "kpis", "people", "attrition", "enps", "hiring"], "updated": "2026-11-04",
  "sources": [{ "title": "Measuring Your Net Promoter Score", "url": "https://www.netpromotersystem.com/about/measuring-your-net-promoter-score/", "publisher": "Bain & Company", "accessed": "2026-11-04", "note": "eNPS borrows the NPS scale and formula; question reworded for employees." },
              { "title": "The One Number You Need to Grow", "url": "https://hbr.org/2003/12/the-one-number-you-need-to-grow", "author": "Frederick F. Reichheld", "publisher": "Harvard Business Review", "date": "2003-12" }] }
---

# People metrics

Most arguments about people numbers turn out to be arguments about definitions: when the clock starts, who counts as a leaver, which headcount is the denominator. Pick one definition per metric, write it in `/org/people/kpis.md`, and compute it the same way every time. The monthly audit checks for drift. Every value comes from the ATS or HR system (via org_metric_read or a granted source), a file, or a named person. If you have to estimate, label it.

## Hiring

**Time to hire (days)** = date offer accepted − date requisition opened. Report the median per role family, not the mean, because one long search distorts an average. Some companies start the clock at the candidate's application instead. That's a different metric (it measures candidate experience, not the search), so name it differently if you track both.

**Offer acceptance rate (%)** = offers accepted ÷ offers decided (accepted + declined) × 100, for offers decided in the period. Leave pending offers out of both numbers.

**Stage conversion (%)** = candidates who reached stage N+1 ÷ candidates who exited stage N (advanced or rejected) × 100. Compute it on closed cohorts. Counting candidates still in a stage understates conversion.

**Stage age (days)** = today − date the candidate entered the current stage. Compare it with the response target in `/org/people/cadence.md`.

**Quality of hire** is whatever the company chose to measure: a hiring-manager rating at 90 days on a fixed scale, or the probation pass rate (hires passing probation ÷ hires whose probation ended × 100). Treat it as a slow, noisy signal and never as a judgement on one person in a shared file.

## Retention

**Average headcount** = (headcount at start of period + headcount at end) ÷ 2. If you have monthly snapshots, average them instead.

**Attrition (turnover) rate (%)** = leavers in period ÷ average headcount × 100. Say whether it includes involuntary exits. Many companies report total, voluntary and involuntary separately.

**Annualised rate** = period rate × (12 ÷ months in period). Label it as annualised, and be careful with small teams: one leaver in a team of eight is a big percentage and says little.

**Regretted attrition (%)** = regretted leavers ÷ average headcount × 100, usually annualised. "Regretted" is decided by the manager when the exit happens, against a written definition (for example "we would rehire them into the same role"). It isn't decided afterwards to make the number look better.

**Early attrition (%)** = leavers within their first N months ÷ hires in the cohort × 100. It's a strong signal about hiring and onboarding quality.

## Engagement

**eNPS** borrows the Net Promoter Score method that Reichheld introduced in Harvard Business Review in 2003. People answer "How likely are you to recommend <company> as a place to work?" on a 0-10 scale. Promoters answer 9-10, passives 7-8, detractors 0-6.

eNPS = % promoters − % detractors. The range is −100 to +100. Passives count in the total but not in the score.

**Participation rate (%)** = responses ÷ people invited × 100. A score with low participation is weak evidence. Report both.

**Anonymity threshold:** don't report any cut (team, location, tenure band) with fewer respondents than the threshold in cadence.md (five by default). Merge small groups or leave them out.

## Onboarding

**Onboarding completion within 30 days (%)** = starters who finished every required onboarding step within 30 days ÷ starters who reached day 30 × 100. The required steps are the checklist in [Onboarding 30/60/90](./onboarding-30-60-90.md).

## Worked example (made-up figures)

A quarter starts with 40 people and ends with 44. Three people left, two of them regretted.

- Average headcount = (40 + 44) ÷ 2 = 42
- Quarterly attrition = 3 ÷ 42 × 100 ≈ 7.1%, annualised ≈ 28.6%
- Regretted attrition = 2 ÷ 42 × 100 ≈ 4.8%, annualised ≈ 19.0%

The survey went to 42 people and 30 answered: 12 promoters, 10 passives, 8 detractors. Participation ≈ 71%. eNPS = 40% − 26.7% ≈ +13.

The report says "annualised from one quarter; small base" next to each rate.

## kpis.md entry template

```markdown
### <Metric name>
- Formula: <numerator> ÷ <denominator> × 100
- Clock / inclusion rules: <start and stop events; who counts>
- Source: <system or file; org_metric_sources id>
- Cadence: <how often computed>   Owner: <role>
- Target: <value> (set by <who>, <date>)
- Caveats: <small-base, anonymity threshold, annualisation>
```

## Common pitfalls

- **Benchmarks from nowhere.** Don't quote an "industry average" attrition or eNPS unless it comes from a cited source that matches your company's size and sector. Targets are the company's to set.
- **Mixing voluntary and involuntary exits** in one rate without saying so.
- **Mean time to hire** hides the long tail. Use the median, and list outliers.
- **Slicing until someone is identifiable.** A team-level eNPS for a team of three is a personal disclosure.
- **Changing a definition mid-quarter** without restating the start value.
