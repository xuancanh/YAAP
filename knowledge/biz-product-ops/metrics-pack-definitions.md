---json
{ "title": "Metrics pack definitions", "summary": "Standard definitions and formulas for activation, retention cohorts, feature adoption and NPS, plus the caveats to note so the monthly pack can be trusted.", "tags": ["metrics", "activation", "retention", "adoption", "nps"], "updated": "2026-11-04",
  "sources": [{ "title": "Bain & Company, Introducing the Net Promoter System, accessed 2026-11-04", "url": "https://www.bain.com/insights/introducing-the-net-promoter-system-loyalty-insights/" }] }
---

# Metrics pack definitions

The company's own definitions live in /org/product/kpis.md and always win. This doc gives standard shapes for the common product metrics so you can spot a missing piece in a definition and ask for it to be fixed, and so the pack states each metric the same way every month.

Every metric definition needs: the unit (user, account, workspace), the event or condition, the time window, and the denominator. If any is missing, ask before computing.

## Activation

**What it answers:** of new sign-ups, how many reached the first real value?

**Formula:** accounts that completed the activation event within N days of sign-up ÷ accounts that signed up in the cohort period.

- The **activation event** is a specific action that predicts staying (for example "created a first report and shared it"). It is chosen by the product team; record which.
- **N** is fixed in the definition. Report by sign-up cohort (week or month) so recent cohorts are shown only once their window has closed.

## Retention cohorts

**What it answers:** of the accounts that started in a period, how many are still active later?

**Formula:** for cohort C and period k: accounts in C active in period k ÷ accounts in C.

- **Active** must be defined (a core action, not just a login).
- Present as a cohort table: rows are start cohorts, columns are periods since start.
- Read the shape: does the curve flatten (a retained core) or keep falling?
- For revenue products, Finance may report revenue retention separately; do not mix it with user retention in one figure.

## Feature adoption

**What it answers:** of the people who could use a feature, how many do?

**Formula:** active accounts (or users) that used the feature in the period ÷ active accounts (or users) that had access to it in the period.

- The denominator is **eligible** users: those on a plan that includes it and with the flag on. Using all users understates adoption for gated features.
- Optionally add **depth**: average uses per adopting account, and **retention of the feature**: share of adopters who used it again in the next period.

## Net Promoter Score (NPS)

Per Bain, NPS comes from one question — how likely the respondent is to recommend the product to a friend or colleague, on a 0–10 scale. Respondents scoring 9–10 are promoters, 7–8 passives, 0–6 detractors.

**Formula:** NPS = % promoters − % detractors. It ranges from −100 to +100.

- Report the **response count** and response rate beside it. A score from few responses moves a lot by chance.
- Report the **segment mix** of respondents; a shift in who answered can move the score with no change in sentiment.
- Read the comments as feedback; route them through triage.

## Caveats to record every month

Add a "Data notes" section to the pack and list, for the month:

- **Instrumentation changes:** events added, renamed or fixed; from what date.
- **Outages or tracking gaps:** dates and which metrics they affect.
- **Small samples:** any metric whose denominator is small enough that changes may be noise; show the count.
- **Definition changes:** what changed, and whether history was restated or the trend is broken.
- **One-off events:** a launch, a pricing change, a migration of accounts.

## Layout per metric

```
| Metric | Definition (short) | This month | Target | Last 3 months | Trend | Note |
```

- Use the same order every month.
- Show the target from the key result where one exists.
- Label any number from an export rather than a metric source.
- Don't add interpretation you can't support; "fell after the onboarding change" is a hypothesis unless tested. Write it as one.
