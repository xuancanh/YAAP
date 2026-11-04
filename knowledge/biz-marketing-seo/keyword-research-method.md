---json
{ "title": "Keyword research method", "summary": "A repeatable method to find, classify by intent, cluster and prioritise keywords into a map tied to the funnel.", "tags": ["keyword research", "search intent", "keyword map", "prioritisation"], "updated": "2026-11-04" }
---

# Keyword research method

A keyword map is a list of topics we should own, each mapped to one page, with intent and priority. It is not a spreadsheet of every keyword a tool can export. The output goes to `/org/marketing/seo/keyword-map.md`.

## Step 1: start from the business, not the tool

Gather seeds from:

- The positioning doc: the problems we solve, the category, the alternatives buyers compare.
- Sales and support: questions prospects and customers ask, in their words.
- Search Console: queries we already get impressions for but rank poorly on (quick wins).
- Our product: features, integrations, use cases.
- Competitor and alternative names (for comparison content, kept fair).

## Step 2: expand

Use keyword tools and the search results themselves: related searches, "people also ask"-style questions and autocomplete. Tools differ in their volume estimates. Treat volumes as rough relative sizes, not facts, and note which tool they came from.

## Step 3: classify intent

Search each candidate and look at what ranks. The results reveal the intent better than the words do.

| Intent | Signals in the results | Funnel stage | Page type |
|---|---|---|---|
| Informational | Guides, definitions, videos | Awareness | Guide, glossary, blog |
| Commercial investigation | "Best", comparisons, reviews | Consideration | Comparison, use-case page |
| Transactional | Product, pricing, sign-up pages | Decision | Product or landing page |
| Navigational | One brand's site | Any | Our own pages (brand terms) |

Note anything the results page shows that changes the job (video results, local results, a direct answer box). Some queries are answered on the results page, so expect fewer clicks.

## Step 4: cluster

Group keywords that the same page should answer. Two keywords belong together if the top results for both are mostly the same pages. One cluster = one target page. This prevents two of our pages competing for the same query (cannibalisation).

## Step 5: prioritise

Score each cluster 1–3 on four factors and write the reasoning:

| Factor | Question |
|---|---|
| **Business value** | If they found us here, could they become customers? Is it close to the product? |
| **Demand** | Relative search interest (from tools, rough) and our impressions |
| **Ability to win** | Can we create something clearly better? Do we have authority on the topic? What ranks now (big brands, forums, thin pages)? |
| **Effort** | New page, or improve an existing one? |

```
Priority score = business value × 2 + demand + ability to win − effort
```

Weights are a team choice; keep them fixed so quarters compare. Improving existing pages that already rank on page two often scores high: lower effort, known demand.

## Step 6: write the map

```markdown
| Cluster | Main query | Secondary queries | Intent | Stage | Target URL (existing/new) | Priority | Notes |
|---|---|---|---|---|---|---|---|
| month-end close | month end close checklist | close process steps, … | Info/how-to | Awareness | /guides/month-end-close (new) | 9 | Our data angle |
```

Also record:

- **Owner and status** per cluster (briefed, drafted, live, refreshing).
- **Internal link hubs:** which pillar page each cluster links to and from.
- **Out of scope:** clusters you rejected and why, so they aren't researched again next quarter.

## Quarterly refresh

1. Pull Search Console queries for the last quarter; add new queries with impressions.
2. Check live clusters: are we ranking and converting? See [metrics](seo-metrics-and-reporting.md).
3. Re-check intent on top clusters. Results pages change.
4. Re-score and reorder; hand the top items to the content calendar with briefs.

## Pitfalls

- Chasing high-volume terms with no buying intent.
- One page per keyword variation (thin, near-duplicate pages; see [red lines](search-guidelines-and-red-lines.md)).
- Ignoring the results page and writing the wrong format.
- Treating tool volume estimates as exact numbers in reports.
