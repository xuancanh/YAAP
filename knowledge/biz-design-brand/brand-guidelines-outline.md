---json
{ "title": "Brand guidelines outline", "summary": "A section-by-section outline for brand guidelines with what each part must specify, accessible colour rules and do/don't examples.", "tags": ["brand guidelines", "logo", "colour", "typography", "accessibility"], "updated": "2026-11-04",
  "sources": [
    { "title": "W3C: Web Content Accessibility Guidelines (WCAG) 2.2 (accessed 2026-11-04)", "url": "https://www.w3.org/TR/WCAG22/" }
  ] }
---

# Brand guidelines outline

Good guidelines let someone who has never met the designer produce on-brand work. They specify, show examples, and explain the reason behind each rule, so people can handle cases the guide didn't foresee. Keep them in `/org/design/brand/guidelines.md`, with assets linked rather than embedded where possible.

## Outline

### 1. Brand foundation (short)

- One paragraph on what the brand stands for and the personality in three to five adjectives, each with "this, not that" ("confident, not loud").
- Link to the positioning doc and the voice guide; don't restate them.

### 2. Logo

- Versions: primary, secondary (horizontal or stacked), icon or mark, monochrome. File formats and where to download them.
- **Clear space:** the minimum empty space around the logo, defined by a part of the logo (for example the height of a letter) so it scales.
- **Minimum size** for print and screen, below which the icon version is used.
- **Backgrounds:** which version on light, dark and photo backgrounds.
- **Misuse examples:** stretched, recoloured, rotated, outlined, effects, on busy backgrounds, rearranged. Show each as an image marked "don't".

### 3. Colour

- Palette with roles: primary, secondary, neutrals, and functional colours (success, warning, error) if the brand covers product.
- Values for each colour: HEX and RGB for screens; CMYK or a spot colour reference for print if the company prints.
- **Proportion guidance:** which colours dominate and which are accents.
- **Accessible pairs:** a table of approved text and background combinations with their contrast ratio. WCAG 2.2 level AA asks for a contrast ratio of at least 4.5:1 for normal text and 3:1 for large text, and 3:1 for user interface components and meaningful graphics against adjacent colours. Mark which pairs are allowed for body text, large text only, or decoration only.
- Don't rely on colour alone to carry meaning (for example in charts); add labels or patterns.

### 4. Typography

- Typefaces, weights and where each is used; licence notes (web, desktop, app) and the fallback fonts when the brand font isn't available, such as in email or office documents.
- A type scale: sizes for headings, body, captions on screen and in print.
- Line length and spacing guidance for readability.
- Rules for emphasis, capitalisation and numbers.

### 5. Imagery

- Photography: subjects, mood, lighting, framing, diversity and representation, what to avoid.
- Illustration and iconography: style, stroke, colour use, grid.
- Image rights: where licensed images come from and how licences and releases are recorded.
- AI-generated imagery: whether it's allowed, for what, and the disclosure rules. Decide this with Legal and marketing; laws and platform rules are changing.
- Alt text: every meaningful image in digital output has a text alternative.

### 6. Layout and graphic elements

- Grid and margins per main format.
- Signature elements (shapes, patterns, frames) and how to use them.
- Data visualisation basics if the company publishes charts.

### 7. Voice link and copy on assets

- Link to the voice guide. Note asset-specific rules: headline length on social graphics, CTA wording, legal lines.

### 8. Applications (examples)

Real examples of correct use: a social post, a slide, an email header, a document cover, a product screenshot frame. Each one annotated.

### 9. Templates and assets

Links to `/org/design/brand/templates/` and the logo and font downloads.

### 10. Ownership and change log

Who approves exceptions, how to request a new asset or rule, and a dated log of changes.

## Writing rules that hold up

- **Specify with values, not adjectives.** "Clear space equals the height of the x" beats "give it room".
- **Show do and don't side by side.** People copy examples more than they read rules.
- **Explain why** in one line ("the dark logo on our blue fails contrast").
- **Keep it short enough to use.** A long guide no one opens drifts faster than a short one people use.

## Update checklist

- [ ] The change is recorded in the change log with date and reason.
- [ ] Templates that embed the old rule are updated in the same change.
- [ ] Owners of recurring outputs (marketing, sales, support) are told what changed.
- [ ] Old assets are archived, not deleted, so past work can be traced.
