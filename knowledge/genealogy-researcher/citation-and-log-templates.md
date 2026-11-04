---json
{ "title": "Citation and log templates", "summary": "Copyable templates for citing common record types and for research-log entries, including negative results.", "tags": ["citations", "research-log", "templates", "documentation"], "updated": "2026-11-04" }
---

# Citation and log templates

A citation answers four questions: **who** created the record, **what** it is, **where** it is held (and how you saw it), and **where in it** the fact is. Fancy formatting is optional; those four elements are not.

## Citation templates

Fill the angle brackets. Keep the order the same so the files read consistently.

**Civil birth, marriage or death record**
```
<Jurisdiction>, <record type> for <name>, <date>, <register/volume>, <entry or certificate no.>;
<repository or website>, <image or item reference>, accessed <date>.
```

**Church register entry**
```
<Parish, denomination>, <register type> <years>, p. <page>, entry for <name>, <event date>;
<archive or microfilm/website>, <film or image no.>, accessed <date>.
```

**Census household**
```
<Country> census <year>, <county/district>, <place>, <enumeration district or piece/folio/page>,
household of <head>; <website or archive>, image <no.>, accessed <date>.
```

**Index or transcription only (no image seen)**
```
<Index title>, entry for <name>, <event, date, place>; <website>, accessed <date>.
Note: index only, original not viewed.
```

**Family memory**
```
Interview with <name> (<relationship>), <date>, <place>, recording/notes in <file path>.
Informant born <year>; recalling events of <years>.
```

**Photograph or heirloom**
```
<Description>, in possession of <holder>, <place>; photographed <date>, file <path>.
Provenance: <how it came down the family>.
```

Add a one-word quality note after each citation where useful: *original image*, *index only*, *memory*, *authored tree*.

## Research log entry

One block per search, including the ones that found nothing.

```
Date: 2026-11-04
Question: Where was Janos Szabo born? (Szabo line, open question #3)
Searched: <collection/archive>, <date range>, <place>, terms "Szabo", "Szabó", "Sabo", given "Janos/John"
Result: FOUND / NOT FOUND
Found: <what, with citation>
Not found: <what you expected and didn't see>
Next: <the concrete next search>
```

The *Not found* line is the most valuable one long-term. It stops you, or another relative, from repeating a dead search years later. Note the exact terms and date range, since "searched the census" alone is useless.

## Person-file fact line

```
- Birth: 12 Mar 1871, Nowa Wieś, Poland [proved] (cite: baptism; death cert.)
- Emigration: abt 1890 [probable] (cite: 1900 census immigration year; family memory)
- "Came over as a stowaway" [legend] (cite: interview, R. Kowalski, 2026)
```

Use standard date forms (day month year, with *abt*, *bef*, *aft*, *bet … and …*) so the tree exports cleanly to GEDCOM-based software.

## Common mistakes

- Citing the website alone ("Ancestry") with no collection or image reference.
- Copying another tree's citation without seeing the record. Cite what you actually looked at.
- Forgetting the access date for online material; collections move and change.
- Logging only successes.

## Worked example

User says, "I looked in the 1910 census and he wasn't there." The log entry asks: which index, which spelling, which county, and was the image browsed or only the index searched? The rewritten entry records an index-only search under two spellings in one county. The next step is filed as "browse the district images street by street", a specific task instead of a vague dead end.
