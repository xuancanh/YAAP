---json
{ "title": "Search guidelines and red lines", "summary": "Which SEO tactics break Google's published spam policies, what to do instead, and how to judge AI-assisted content.", "tags": ["spam policies", "guidelines", "link building", "ai content", "compliance"], "updated": "2026-11-04",
  "sources": [
    { "title": "Google Search Central: Spam policies for Google web search (accessed 2026-11-04)", "url": "https://developers.google.com/search/docs/essentials/spam-policies" },
    { "title": "Google Search Central: Creating helpful, reliable, people-first content (accessed 2026-11-04)", "url": "https://developers.google.com/search/docs/fundamentals/creating-helpful-content" },
    { "title": "Google Search Central: Qualify your outbound links (accessed 2026-11-04)", "url": "https://developers.google.com/search/docs/crawling-indexing/qualify-outbound-links" }
  ] }
---

# Search guidelines and red lines

Your charter says you follow search engines' published guidelines, never buy links and never generate thin pages. This doc makes that concrete. The policies below are Google's, as listed on the access date; they're updated over time, so check the source before relying on a detail. Other search engines publish similar guidelines.

## Red lines: Google's named spam policies

Breaking these can lead to lower rankings or removal from results. Never do them, never recommend them, and flag any vendor or request that proposes them.

| Policy | What it means | What tempts people into it |
|---|---|---|
| Cloaking | Showing search engines different content than users | "SEO versions" of pages |
| Doorway abuse | Many similar pages that funnel to one destination | One page per city or keyword variant with swapped words |
| Expired domain abuse | Buying a lapsed domain to rank low-value content | "Authority" domains for sale |
| Hacked content | Content added through security flaws | Not us, but audit for it |
| Hidden text and links | Text or links users can't see | White text, tiny fonts, links behind elements |
| Keyword stuffing | Unnatural repetition of keywords | "Keyword density" targets |
| Link spam | Creating or trading links to manipulate rankings, including paid links without qualifying attributes | Paid guest posts, link exchanges, link packages, private blog networks |
| Machine-generated traffic | Automated queries to Google | Rank-tracking by scraping without permission |
| Malicious practices | Malware, unwanted software, deceptive behaviour | Aggressive scripts |
| Misleading functionality | Pages that pretend to offer a tool or service | Fake calculators to capture traffic |
| Scaled content abuse | Mass-producing low-value pages (by AI, scraping or stitching) to manipulate rankings | "Publish 500 pages a month" |
| Scraping | Republishing others' content without added value | Rewritten competitor articles |
| Site reputation abuse | Third-party content published on a host site mainly to exploit its ranking signals | Paid placements on high-authority sites |
| Sneaky redirects | Sending users somewhere different from what search engines see | Conditional redirects |
| Thin affiliation | Affiliate pages copying merchant content with nothing added | Comparison sites with no testing |
| User-generated spam | Spam through forums, comments, uploads | Unmoderated community areas |

## What to do instead

- **Instead of buying links:** earn them with things worth citing: original data, useful tools, templates, expert commentary. Ask partners and customers to link where it's genuinely useful to their readers. When links are paid or sponsored, they must carry the appropriate qualifying attribute (such as `rel="sponsored"` or `nofollow`), and that's the site owner's call to implement.
- **Instead of doorway pages:** one strong page per real topic; location or variant pages only when each has distinct, useful content.
- **Instead of scaled content:** fewer pages, each meeting the people-first test below.
- **Instead of keyword stuffing:** write naturally for the reader, cover the related questions.

## AI-assisted content

Google's guidance says AI-generated content isn't banned in itself: it's judged on effort, originality, skill and accuracy, like any content. Generating many pages without human review and curation is treated as low effort, and using automation to manipulate rankings breaches the scaled content policy.

For us that means:

- AI can help with research, outlines and drafts; a reviewer checks every fact and adds the original value.
- No page exists just to target a keyword variant.
- Disclose how content was produced where readers would reasonably wonder.
- Bylines and author information are real. No invented authors or credentials.

## The people-first self-check

Use these questions (adapted from Google's guidance) before recommending any new page:

1. Does it offer original information, analysis or experience?
2. Is it substantially better than what already ranks, not just a rewrite?
3. Would our audience find it useful if they came to the site directly, not from search?
4. Is it clear who wrote it and why they're credible?
5. Will readers leave having achieved their goal?
6. Is it mainly made to attract search visits? If yes, don't make it.

## When you see a red-line request

Say no plainly, explain the risk in one or two sentences, and offer the legitimate alternative. If it came from outside the marketing unit or from a vendor, tell the Head of Marketing.

## If something already breaks a policy

Check Search Console for a manual action. Fix the cause (remove or qualify paid links, consolidate doorway pages, remove scraped content), document what was done, and, if there was a manual action, the site owner can request a review once it's fixed.
