---json
{ "title": "Verifying sources", "summary": "A step-by-step check that a reference exists, says what you claim, and hasn't been retracted, plus how to mark what can't be verified.", "tags": ["citations", "verification", "retractions", "doi", "integrity"], "updated": "2026-11-04",
  "sources": [
    { "title": "DOI Foundation: resolve a DOI", "url": "https://www.doi.org/" },
    { "title": "Crossref: news on Crossref and Retraction Watch (database acquired and opened, 12 Sep 2023)", "url": "https://www.crossref.org/blog/news-crossref-and-retraction-watch/" }
  ] }
---

# Verifying sources

A reference is verified when three things are true: the record exists, its details match what you wrote, and it still says what you claim. Anything short of that is UNVERIFIED and is labeled that way.

## The five-step check

1. **Resolve the identifier.** If there's a DOI, open `https://doi.org/<doi>`. It should land on the publisher's page for that exact article. No DOI? Find the record in the venue's own site, a library catalogue, PubMed, arXiv or similar. A search-engine snippet alone is not a record.
2. **Match the metadata.** Authors (spelling and order), year, title, venue, volume and pages. Fabricated or garbled references often get one of these wrong: a real author with a made-up title, or a real title in the wrong journal.
3. **Read the part you cite.** At least the abstract plus the section that supports your claim. Note the page or section. If you only read the abstract, say so in sources.md.
4. **Check status.** Look for a retraction, expression of concern or correction on the publisher's page. Crossref has held the Retraction Watch database since September 2023 and made it openly available, so retraction data is searchable there too. Re-check status before submission; papers get retracted after you cite them.
5. **Pick the version of record.** If a preprint was later published, cite the published version unless you need the preprint specifically. If findings changed between versions, note it.

## Recording it

In sources.md, each entry carries:

```
- Author A, Author B (2021). Title. Venue 12(3): 45-67. https://doi.org/...
  Checked: 2026-11-04 · Read: abstract + section 4 · Status: no retraction found
  Summary (own words): ...
  Relevance: supports theme 2 (method X fails on small samples)
```

Unverified items look like this, and never move into a draft without the tag:

```
- UNVERIFIED: "Smith 2019 on X" (mentioned in a talk; no record found in DOI, venue site or catalogue on 2026-11-04)
```

## Common mistakes

- **Citing the citation.** Paper A says "B found X". Unless you read B, you're citing A's reading of B. Either read B or write "as reported by A".
- **Trusting reference managers blindly.** Imported metadata is often wrong (missing authors, preprint year). Spot-check against the landing page.
- **Quote drift.** A quote copied from a secondary source loses words. Quote only from the original you opened.
- **Overstating.** The paper found an association in one population; the draft says it "shows" a cause. Match the strength of your verb to the study design.
- **Placeholder references.** "(Author, 20XX)" left in a draft becomes a fake reference at 2 a.m. Use an explicit `[TODO: cite]` instead.

## Pre-submission audit

- [ ] Every in-text citation appears in the reference list, and the reverse.
- [ ] Every reference resolved within the last month.
- [ ] No UNVERIFIED or TODO tags left.
- [ ] Retraction status re-checked for every reference that carries a key claim.
- [ ] Quotes checked word-for-word against the original.

If something can't be verified before the deadline, cut the claim or soften it. Don't ship a reference you couldn't find.
