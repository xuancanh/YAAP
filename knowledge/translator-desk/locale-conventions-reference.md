---json
{ "title": "Locale conventions reference", "summary": "Common date, number, quotation-mark and spacing conventions for frequent target locales, and how to build per-locale notes.", "tags": ["localization", "locale", "typography", "dates", "numbers"], "updated": "2026-11-04",
  "sources": [{ "title": "Unicode CLDR — Common Locale Data Repository", "url": "https://cldr.unicode.org/" },
              { "title": "ISO 8601 — Date and time format", "url": "https://www.iso.org/iso-8601-date-and-time-format.html" }] }
---

# Locale conventions reference

Use this as a starting point, not the final word. Conventions vary with the client's house style, the publisher and the region. When it matters, check the Unicode CLDR data (the standard locale database that software uses) and the client's style guide, then record the decision in desk/locales/<locale>.md.

## Quick table: common defaults

| Locale | Date (short) | Decimal / thousands | Quotation marks | Notes |
|---|---|---|---|---|
| en-US | 11/04/2026 (month first) | 1,234.5 | “double” then ‘single’ | Commas and full stops usually go inside closing quotes |
| en-GB | 04/11/2026 (day first) | 1,234.5 | ‘single’ or “double”, depending on house style | Check the client's preference |
| de-DE | 04.11.2026 | 1.234,5 | „unten oben“ or »guillemets« | Nouns capitalised. Spaced en dash for parentheticals. |
| fr-FR | 04/11/2026 | 1 234,5 (narrow no-break space) | « guillemets » with inner spaces | Space before ; : ! ? and inside guillemets |
| es-ES | 04/11/2026 | 1.234,5 | «angular» then “inglesas” | Opening ¿ and ¡ |
| es-MX | 04/11/2026 | 1,234.5 | “inglesas” common | Decimal point, unlike Spain |
| pt-BR | 04/11/2026 | 1.234,5 | “aspas” | Spelling and vocabulary differ from pt-PT |
| it-IT | 04/11/2026 | 1.234,5 | «caporali» or “alte” | |
| ja-JP | 2026/11/04 or 2026年11月4日 | 1,234.5 | 「かぎ括弧」 and 『』 for nested | Full-width punctuation |
| zh-CN | 2026/11/4 or 2026年11月4日 | 1,234.5 | “” or 「」, depending on region and house style | Full-width punctuation |

**Unambiguous option:** ISO 8601 (2026-11-04) is safe in technical and data contexts. In running prose, writing the month as a word ("4 November 2026") avoids the confusion over which number is the day.

## The locale mechanics checklist

For each project, decide and record:

- [ ] **Dates:** format, and whether day and month names are translated
- [ ] **Times:** 12-hour or 24-hour, and how time zones are written
- [ ] **Numbers:** decimal mark, thousands separator, and whether short numbers get a separator at all
- [ ] **Currency:** convert, annotate or keep? Symbol placement and spacing (12,50 € or €12.50)
- [ ] **Units:** convert (and round sensibly), or keep the original with the conversion in brackets? Never convert inside quoted legal text
- [ ] **Names:** given or family name order, and honorifics
- [ ] **Addresses and phone numbers:** keep the original format if it's a real address in the source country
- [ ] **Punctuation and typography:** quotation marks, spacing before punctuation, dashes
- [ ] **Formality (T/V):** tu/vous, du/Sie, tú/usted and so on. Record the decision per client and per document type

## Building a desk/locales note

```
# <locale> — conventions notes
Sources: <CLDR, client style guide, publisher guide> (checked <date>)
Dates: ...
Numbers: ...
Quotes: ...
Spacing: ...
Formality default: ... (client overrides: ...)
Traps seen: ...
```

Add to "Traps seen" every time something catches you out. Over time it becomes the most useful part of the note.

## Worked example

Source (en-US): "The fee is $1,250.50, due 03/04/2026."

Target fr-FR, with a brief that says "keep USD, localise formats":

- The date is ambiguous on its own. Check with the client whether it means March 4 (US order). It does, so write "4 mars 2026" or "04/03/2026".
- Amount: "1 250,50 $ US", with a narrow no-break space as the thousands separator.
- Result: « Les frais s'élèvent à 1 250,50 $ US, à régler le 4 mars 2026. »

Add a query-sheet entry recording that the client confirmed the US date order.

## Common mistakes

- Converting a date without first confirming the source's day/month order.
- Line breaks in the middle of "12 %" or "« mot »" because ordinary spaces were used. Use no-break spaces.
- Applying es-ES number formats to Latin American Spanish, or the reverse.
- Converting units in a technical specification where the original values are binding.
