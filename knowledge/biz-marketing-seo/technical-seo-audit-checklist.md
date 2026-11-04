---json
{ "title": "Technical SEO audit checklist", "summary": "A checklist for the quarterly technical audit (crawling, indexing, canonicals, speed, structure) and how to prioritise and file the fixes.", "tags": ["technical seo", "audit", "checklist", "core web vitals", "indexing"], "updated": "2026-11-04",
  "sources": [
    { "title": "Google Search Central: Introduction to robots.txt (accessed 2026-11-04)", "url": "https://developers.google.com/search/docs/crawling-indexing/robots/intro" },
    { "title": "Google Search Central: How to specify a canonical URL (accessed 2026-11-04)", "url": "https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls" },
    { "title": "web.dev: Web Vitals (accessed 2026-11-04)", "url": "https://web.dev/articles/vitals" }
  ] }
---

# Technical SEO audit checklist

A technical audit finds what stops search engines from crawling, understanding or ranking our pages. Run it quarterly and after any site change (migration, redesign, new CMS). Output: `/org/marketing/seo/audit-<date>.md` with prioritised fixes filed to the site owner.

## Tools and inputs

- Search Console: page indexing report, Core Web Vitals report, sitemaps, manual actions, URL inspection.
- A crawl of the site (a crawler tool, or a sitemap plus spot checks).
- Analytics for organic landing pages, to weight issues by traffic.

## 1. Crawling

- [ ] `robots.txt` exists, loads, and doesn't block important pages, CSS or JS.
- [ ] Remember: robots.txt manages crawling; it does **not** keep a page out of search. A blocked URL can still be indexed without a description. To keep a page out, use `noindex`, password protection or removal.
- [ ] No important pages only reachable through search boxes or scripts with no links.
- [ ] Server errors (5xx) and timeouts are rare in Search Console crawl stats.

## 2. Indexing

- [ ] Page indexing report: review "not indexed" reasons. Excluded by noindex, duplicates and crawled-not-indexed each have different fixes.
- [ ] Important pages are indexed (URL inspection on a sample).
- [ ] No accidental `noindex` on live templates (a common leftover from staging).
- [ ] XML sitemap lists only canonical, indexable, 200-status URLs, and is submitted.
- [ ] Thin or near-duplicate pages (tag pages, filters, empty categories) are consolidated or kept out of the index on purpose.

## 3. Duplicates and canonicals

Google treats these as signals, strongest first: permanent redirects, then `rel="canonical"`, then sitemap inclusion (weak). Using them together, consistently, strengthens the signal.

- [ ] Each page has one canonical URL; a self-referencing canonical on canonical pages is recommended.
- [ ] Canonicals use absolute HTTPS URLs and agree across methods (tag, header, sitemap).
- [ ] No `noindex` used to choose a canonical, and no robots.txt used for canonicalisation.
- [ ] One version of the site: HTTP redirects to HTTPS; www or non-www chosen and redirected; trailing-slash handling consistent.
- [ ] Internal links point to canonical URLs, not redirecting or duplicate versions.

## 4. Status codes and redirects

- [ ] No internal links to 404s; broken pages that had traffic or links are redirected to the closest relevant page.
- [ ] Redirects are permanent where the move is permanent, and single-hop (no chains or loops).
- [ ] Soft 404s (error pages returning 200) are fixed.

## 5. Page experience and speed

Core Web Vitals, measured at the 75th percentile of real page loads, separately for mobile and desktop. "Good" thresholds as of the access date:

| Metric | Measures | Good |
|---|---|---|
| Largest Contentful Paint (LCP) | Loading | 2.5 s or less |
| Interaction to Next Paint (INP) | Responsiveness | 200 ms or less |
| Cumulative Layout Shift (CLS) | Visual stability | 0.1 or less |

- [ ] Search Console Core Web Vitals report: which URL groups are "poor" or "needs improvement".
- [ ] Common causes to name in tickets: oversized images, render-blocking scripts, slow server response, layout shifts from images or ads without size, heavy third-party scripts.
- [ ] Pages work on mobile: readable text, tappable controls, no content hidden on mobile that exists on desktop.
- [ ] HTTPS everywhere, valid certificate.

## 6. Structure and on-page

- [ ] Unique, descriptive title and meta description per page; one clear H1.
- [ ] Important pages are a few clicks from the home page, and linked from relevant hubs.
- [ ] No orphan pages (pages in the sitemap with no internal links).
- [ ] Clean, readable URLs.
- [ ] Images have alt text; important content is in HTML text, not only in images.
- [ ] Structured data, where used, is valid and matches visible content.
- [ ] International sites: language and region versions are declared correctly (hreflang) and point to each other.

## 7. Security and manual actions

- [ ] No manual actions or security issues in Search Console.
- [ ] No injected spam pages (search `site:` for odd URLs or content).

## Prioritising fixes

Score each issue:

```
Priority = impact (pages/traffic affected: 1–3) × severity (blocks indexing = 3,
           hurts ranking = 2, hygiene = 1) ÷ effort (1–3)
```

File each as a ticket for the site owner:

```markdown
**Issue:** <what's wrong>   **Priority:** <score>
**Evidence:** <URLs, report screenshot or export, date>
**Why it matters:** <crawling/indexing/ranking/user impact>
**Fix:** <specific change>   **How to verify:** <check after fix>
```

Re-check fixed items in the next audit and note them as closed.
