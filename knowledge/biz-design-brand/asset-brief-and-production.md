---json
{ "title": "Asset brief and production checklist", "summary": "An intake brief for asset requests, a production and export checklist per channel, and file naming so campaign assets ship right the first time.", "tags": ["campaign assets", "brief", "production", "checklist"], "updated": "2026-11-04" }
---

# Asset brief and production checklist

Most rework on campaign assets comes from a vague request: wrong sizes, missing copy, unclear goal. Don't start designing until the brief answers the questions below. Store work in `/org/design/brand/campaigns/<campaign>/`.

## Intake brief

Ask the requester to fill this in, or fill it from their task and confirm:

```markdown
# Asset brief: <campaign> — <asset set>

**Requester:** <name>   **Due:** <date>   **Approver:** <name>
**Goal:** <what the viewer should think or do>
**Audience:** <who, where they'll see it, on what device>
**Message:** <the one thing to say; link to the campaign plan or launch plan>
**Copy:** <final headline, body, CTA — or who writes it and when>
**Channels and formats:** <list each placement>
**Mandatory elements:** <logo, legal line, disclosure, product screenshot>
**Inputs:** <photos, screenshots, data, quotes, with rights confirmed>
**Constraints:** <file size limits, deadlines from partners, accessibility needs>
**Success measure:** <the campaign metric this supports>
```

If copy isn't final, design with real draft copy, never lorem ipsum. Copy length changes layouts.

## Channel specifications

Platform sizes, safe zones, file types and limits change often. Before each campaign, check the current specs from each platform's own help pages and note the date checked in the campaign folder. Don't copy specs from an old campaign without checking.

For each placement, record:

| Placement | Dimensions / ratio | Safe zone | Max file size | Format | Text limits | Checked on |
|---|---|---|---|---|---|---|

## Design process

1. **Start from the template** for that format if one exists. If it doesn't and the format will recur, note it for the [template kit](template-kit-guide.md).
2. **Design the hero (master) asset first,** get approval on direction, then adapt to other sizes. Adapting before approval multiplies rework.
3. **Design for the smallest view.** Check every asset at the size it will actually be seen, such as a phone feed or an email preview pane.
4. **One focal point and one message** per asset.

## Production checklist (every asset)

**Brand**

- [ ] Logo version, size and clear space per guidelines.
- [ ] Colours from the palette; text and background pair is on the approved accessible list.
- [ ] Brand fonts, or the approved fallback, at readable sizes.
- [ ] Imagery matches the guidelines; rights and releases recorded.

**Content**

- [ ] Copy matches the approved text exactly; spelling and product names checked against the glossary.
- [ ] Claims and numbers are the ones approved in the source document.
- [ ] Legal and disclosure lines present where required.
- [ ] CTA is clear and matches the landing page.

**Accessibility**

- [ ] Text is readable at actual display size.
- [ ] Meaning isn't carried by colour alone.
- [ ] Alt text written for each digital asset and handed over with it.
- [ ] For video: captions, and no rapid flashing.

**Technical**

- [ ] Correct dimensions, ratio and safe zones for each placement.
- [ ] Within file size limits; exported in the right format and colour space (RGB for screens, the printer's spec for print).
- [ ] Critical content inside safe zones (platform UI overlays cover edges).

## File naming and handover

Use one pattern so anyone can find the right file:

```
<campaign>_<asset>_<placement>_<size>_<version>.<ext>
2026-q4-close_hero_linkedin-feed_1x1_v2.png
```

Hand over with:

- A short note: what's in the set, which file goes where, alt text for each.
- Source files in the campaign folder, so others can make small edits.
- The approval record.

## Turnaround tracking

Log the request date, the date the brief was complete, first draft and approval for each asset set. Turnaround starts when the brief is complete, so slow briefs show up as slow briefs, not slow design. See the [metrics](consistency-review-rubric.md).
