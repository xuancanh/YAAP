---json
{ "title": "Template kit guide", "summary": "How to decide which templates to build, structure them so non-designers stay on-brand, and version and maintain them.", "tags": ["templates", "brand", "self-service", "maintenance"], "updated": "2026-11-04" }
---

# Template kit guide

A template is a guideline people can't misread. Build them for the outputs others produce most often, so your time goes into new work, not resizing last month's post. Templates live in `/org/design/brand/templates/`.

## Deciding what to template

Look at the asset request log and the consistency reviews. Template a format when:

- The same asset type is requested repeatedly (social quote cards, webinar slides, case study layouts).
- Non-designers already make it and drift appears in reviews.
- Mistakes are costly (sales decks, customer-facing documents).

Don't template one-off campaign hero work. It should look special.

## Anatomy of a good template

1. **Locked brand structure:** logo position, grid, background, footer and legal line. Lock or place them on a master layer so they aren't moved by accident.
2. **Clear editable zones:** headline, body, image, CTA, with placeholder text that explains the job ("Headline: under 8 words, the customer outcome"). Placeholder text that says what to write is better than fake copy.
3. **Built-in limits:** text boxes sized for the maximum sensible length; styles defined so users pick "Heading" rather than a font size.
4. **Variants, not freedom:** offer two or three approved layouts per format rather than one layout people improvise on.
5. **Accessible defaults:** approved colour pairs only, readable sizes, and in documents and slides, real heading styles and reading order so screen readers work.
6. **Instructions inside:** a first page or hidden layer that says when to use it, how to export, and who to ask.

## Kit structure

```
/org/design/brand/templates/
  README.md               ← index: each template, when to use, owner, version
  social/
    quote-card_v3.<ext>
    announcement_v2.<ext>
  slides/
    sales-deck_v5.<ext>
    webinar_v2.<ext>
  documents/
    one-pager_v2.<ext>
    case-study_v1.<ext>
  archive/                ← old versions, read-only
```

The README index:

```markdown
| Template | Use for | Don't use for | Version | Updated | Owner |
|---|---|---|---|---|---|
| quote-card | Customer quotes on social | Product announcements | v3 | 2026-10 | Brand Designer |
```

## Build process

1. Collect five or more real examples of the format, good and bad, from the reviews.
2. List what varies (text, image, data) and what never should (logo, layout).
3. Build the template in the tool people actually use. A template in a tool nobody has is unused.
4. **Test it with a non-designer:** ask a member who makes this asset to produce one from the template without help. Watch where they get stuck or break it; fix that.
5. Publish with the README entry and announce it to the teams who need it, with one example.

## Versioning and maintenance

- Version in the file name and the README. Move superseded versions to `archive/`.
- When the guidelines change, update every affected template in the same change and note it in the guidelines change log.
- Review templates quarterly: are they being used? Is output from them consistent? Are people asking for a variant that doesn't exist?

## Measuring reuse

```
Template reuse rate = outward assets made from a current template / outward assets sampled of a templated format
Template adoption   = templates used at least once in the period / templates published
```

Count from the monthly review sample or the asset log. A template with no use is a signal to ask why: wrong tool, hard to find, too rigid, or no real need. See [consistency metrics](consistency-review-rubric.md).

## Common mistakes

- Templates so rigid that people abandon them for a blank file.
- Templates so loose that they don't prevent drift.
- Building in a design tool when the users work in slides or documents.
- No owner, so templates go stale after a brand change.
