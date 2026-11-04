---json
{ "title": "Pre-delivery QA checklist", "summary": "The final checks before a translation goes to the client, with the two-pass revision method and the most common slip-ups.", "tags": ["qa", "revision", "checklist", "delivery"], "updated": "2026-11-04" }
---

# Pre-delivery QA checklist

Most delivery errors aren't translation errors. They're a dropped sentence, a transposed number or an inconsistent term. A fixed checklist catches them because it doesn't rely on memory at the end of a long job.

## Revision: two passes, in this order

1. **Target-only read.** Read the translation as if it were original writing, without looking at the source. Does it read naturally? Is the register right for the audience? Mark anything that sounds translated.
2. **Against-source read.** Compare segment by segment. Is anything added, left out or shifted in meaning? Are negations, modal verbs ("may" or "must") and the people or things being referred to correct?

Let the draft rest between drafting and revision, overnight if the deadline allows. Professional translation standards (such as ISO 17100) build in revision by a second linguist. When the translator works alone, a rest period and the two-pass method are the closest substitute.

## The checklist

**Completeness**
- [ ] Segment count in the target matches the source.
- [ ] Headers, footers, captions, tables, footnotes, alt text and text in images are handled as the brief says.
- [ ] No source-language text left behind (search for common source words).

**Numbers and data**
- [ ] Every number checked against the source, including in tables.
- [ ] Dates, times, currencies and units formatted for the locale (see [Locale conventions reference](locale-conventions-reference.md)).
- [ ] Phone numbers, reference codes, URLs and emails unchanged.
- [ ] Totals and percentages still correct if any conversion was done.

**Terminology**
- [ ] Glossary sweep done. Each term's renderings listed, and any variation either justified or fixed by the translator.
- [ ] Product names, trademarks and UI strings match the client's references exactly.
- [ ] Names of people and organisations verified, and titles rendered the agreed way.

**Language**
- [ ] Spelling and grammar check run in the correct locale (en-GB and en-US checkers flag different things).
- [ ] Formality (T/V) consistent throughout.
- [ ] Locale punctuation and spacing applied.

**Format**
- [ ] Layout matches the source: headings, lists, bold and italics, and page breaks where they matter.
- [ ] Tags or placeholders intact (`{name}`, `%s`, `<b>`), if it's a software or CAT-tool file.
- [ ] Text expansion checked where space is fixed (UI, slides, forms).

**Package**
- [ ] Query sheet: answered items applied, open items listed in the delivery note.
- [ ] Translator's notes included if the brief asks for them.
- [ ] File naming and format as requested.
- [ ] For certified work, the certification checklist is complete (see [Certified and sworn translation](certified-and-sworn-translation.md)).

## Worked example: the segment-count catch

The source has 312 segments and the target 311. A diff by segment number shows that segment 188 is missing. It's a one-line safety warning that was merged into 187 by accident during editing. Restore it, re-check 187 and 188 against the source, and note the fix in the job log.

## The most common slip-ups

- **Negation flips** in long sentences ("not less than" becomes "less than").
- **False friends** in the language pair. Keep a list for each pair in the glossary's "forbidden alternatives" column.
- **Number formats** changed in one table but not in another.
- **Copy-paste leftovers** from a previous similar job, such as the wrong client name.
- **Silent correction** of a source error. Translate what's there and flag it to the client, unless the brief says otherwise.

## Delivery note template

```
Delivery — <project>, <language pair/locale>, <date>
Files: <list>
Word count (source): <n>
Open queries: <n> — see query sheet items <#, #>
Notes: <localisation decisions the client should know about>
Glossary: <n> new terms proposed for your approval (attached)
```
