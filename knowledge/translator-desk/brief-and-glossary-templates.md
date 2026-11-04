---json
{ "title": "Brief and glossary templates", "summary": "Copy-ready templates for the client brief, glossary entries and the query sheet, with a short guide to researching a term.", "tags": ["templates", "brief", "glossary", "terminology", "query-sheet"], "updated": "2026-11-04" }
---

# Brief and glossary templates

## Client brief (fill in before quoting)

```
Project: <slug>                 Client: <name>      Date: <date>
Source language/locale: <xx-XX>  Target locale: <xx-XX> (exact)
Purpose: <what the text is for — contract, website, manual, evidence>
Audience: <who reads it; expertise; formality expected>
Volume: <source word count, computed from the actual file>
Format in / out: <docx, xliff, pdf scan…> → <deliverable format>
Reference material: <prior translations, glossaries, style guide — asked for>
Certification: <none / certified / sworn / notarised — receiving body: …>
Deadline: <date/time and time zone>  (revision rest built in: yes/no)
Localisation: <adapt / keep / annotate: currencies, units, cultural references>
Notes wanted: <translator's notes in delivery? yes/no>
Price and terms: <rate basis, minimum, rush/DTP premiums, revisions included>
```

The questions that most often prevent rework:

- "Is this the final source?" Changes to the source after you start are billed as a new job.
- "Do you have previous translations or a glossary?" Earlier work sets precedent.
- "Who reviews it on your side, and what do they care about?"

## Glossary entry

Store glossaries in desk/glossaries/<client>.md and <domain>.md. The client file wins when the two disagree, and the conflict gets a note.

| Source term | Target term | POS | Register / context | Why (and date) | Do not use | Status |
|---|---|---|---|---|---|---|
| *Kündigung* | termination notice | n. | contracts (employment) | client instruction, 2026-03-02 | "dismissal" (too narrow) | approved |
| dashboard | tableau de bord | n. | UI | client UI strings v4 | "dashboard" | approved |

Status values: proposed, approved (with the date and who approved it), or deprecated (with a pointer to the replacement).

## Researching a new term

Try these in order, and stop when you have a confident, sourced answer:

1. **The client's own material**: earlier translations, their target-language website, product UI.
2. **Authoritative terminology databases** for the domain. For EU and legal work, IATE (the EU's terminology database) is a common starting point. For standards and technical fields, use the relevant standards body's vocabulary. Note the source and entry.
3. **Parallel texts**: real documents of the same type, originally written in the target language by reliable publishers (government, the leading companies in the sector).
4. **A domain expert or the client**, through the query sheet.

Write down the source each time. "Why" is the most useful column a year later.

## Query sheet

| # | Segment | Source text | Question | Options proposed | Asked (date) | Answer | Applied |
|---|---|---|---|---|---|---|---|
| 1 | 47 | "the Party" | Which party, given there are three in the agreement? | A: Supplier; B: Licensor | 11-04 | B — Licensor | ✔ |
| 2 | 112 | "€12.000,00" vs "€12,000" in seg. 140 | Source inconsistency. Which is correct? | — | 11-04 | | |

Rules:

- Ask early, and batch the questions. Clients answer one list faster than a drip of messages.
- Offer options where you can. Closed questions get quicker answers.
- Keep answered queries. They're precedent for the next job from that client.

## Draft hand-off label (for raw drafts the desk produces)

```
DRAFT-FOR-REVISION — machine/assistant draft, not reviewed.
Segments <a–b>. Ambiguities flagged with [TN: …].
Alternatives given where register or meaning is uncertain.
```

## Common mistakes

- Quoting from a word count estimated from the page count. Count the actual file, and agree how scans will be handled.
- Glossary entries with no context or reason. Six months later nobody knows whether they still apply.
- Recording only the locale's language ("Spanish") instead of the full locale ("es-MX").
