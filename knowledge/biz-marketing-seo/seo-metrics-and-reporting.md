---json
{ "title": "SEO metrics and reporting", "summary": "Definitions and formulas for organic clicks, conversions and rankings, how Search Console counts them, and a monthly report structure.", "tags": ["seo metrics", "search console", "reporting", "kpis", "rankings"], "updated": "2026-11-04",
  "sources": [
    { "title": "Search Console Help: What are impressions, position, and clicks? (accessed 2026-11-04)", "url": "https://support.google.com/webmasters/answer/7042828" },
    { "title": "Google Analytics Help: Engagement rate and bounce rate (accessed 2026-11-04)", "url": "https://support.google.com/analytics/answer/12195621" },
    { "title": "Google Search Status Dashboard (accessed 2026-11-04)", "url": "https://status.search.google.com/" }
  ] }
---

# SEO metrics and reporting

Your KPIs are organic clicks and conversions, and rankings for target queries. Define them the same way every month and always say which tool each number came from. The report goes to `/org/marketing/seo/report-<yyyy-mm>.md`.

## How Search Console counts

- **Click:** a click from Google search results that takes the user to our site. Clicks that stay within Google don't count.
- **Impression:** a link to our site was shown in results. Items in carousels or expandable sections usually count only when scrolled into view or expanded.
- **Position:** where our link appeared, 1 being the top. Averaged across queries using the topmost position we held for each query.
- **CTR:** clicks / impressions.
- Data is aggregated by property or by page, which gives different totals. Page-level counts each URL separately. Don't mix the two views in one table.

## Your KPIs

### Organic clicks

```
Organic clicks (period)        = Search Console clicks, web search, for the property
Non-brand organic clicks       = clicks on queries not containing brand terms
```

Report non-brand separately: brand searches mostly reflect awareness built elsewhere, not SEO work. Keep the brand-term filter list in the report and don't change it silently.

### Organic conversions

```
Organic conversions      = key events (sign-up, demo request, download) in sessions
                           whose channel is organic search (analytics tool)
Organic conversion rate  = organic conversions / organic sessions
Conversions per page     = organic conversions with that landing page
```

- Search Console clicks and analytics sessions never match exactly. Different tools, consent and tracking. Use Search Console for clicks and analytics for conversions; don't divide one by the other.
- Name the attribution basis (usually the session's channel, a last-touch view).

### Rankings for target queries

```
Average position (query) = Search Console average position for that query, for the target URL
Share of targets in top 3 / top 10 = target queries with avg position ≤ 3 (≤ 10) / total target queries
Visibility trend          = impressions for target query set, month over month
```

- Average position is an average across many searches, locations and devices. A position of 4.6 doesn't mean "we're 4th". Use it for trends.
- Third-party rank trackers give a point-in-time position from one location. Say which you used.
- Low-impression queries swing; show impressions next to position.

### Engagement for organic landing pages

In GA4, engagement rate = engaged sessions / sessions, where an engaged session lasts over 10 seconds, has a key event, or has two or more page views. Useful to spot pages that rank but don't satisfy.

## Monthly report structure

```markdown
# Organic report — <yyyy-mm>

## Summary (three lines)
- What moved, why we think so, what we'll do.

## KPIs (vs last month and same month last year, if available)
| Metric | This month | Last month | YoY | Source |
| Non-brand organic clicks | | | | Search Console |
| Organic conversions | | | | Analytics |
| Target queries in top 10 | | | | Search Console |

## Winners and losers
- Top pages by click gain and loss, with likely cause (evidence, not guesses)

## Target query table
| Cluster | Query | Target URL | Avg position | Impressions | Clicks | Change |

## Technical health
- Open audit items, any new indexing or Core Web Vitals issues

## Next actions (prioritised)
- Refresh <url>: <reason>   - Brief <cluster>   - Ticket <issue>
```

## Reading changes honestly

- **Compare like with like:** month over month is affected by seasonality; year over year is better if the site existed.
- **Check for outside causes** before crediting or blaming our work: search engine incidents and notable ranking updates (Google announces these on its Search Status Dashboard and Search Central blog), site changes, tracking changes, holidays.
- **Impressions up, clicks flat:** we're appearing for more queries but lower down, or the results page is answering the query directly. Check CTR by position.
- **Rankings stable, clicks down:** demand dropped, or results-page features took clicks.
- **Clicks up, conversions flat:** the traffic is informational; check internal links and CTAs on those pages.

Write "associated with" rather than "caused by" unless you have evidence like a controlled change.
