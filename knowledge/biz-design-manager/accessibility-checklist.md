---json
{ "title": "Accessibility checklist (WCAG 2.2 AA)", "summary": "The WCAG 2.2 Level AA essentials a design must pass in crit and audit, the criteria new in 2.2, and how to compute the conformance KR.", "tags": ["accessibility", "wcag", "a11y", "audit", "checklist", "design"], "updated": "2026-11-04",
  "sources": [
    { "title": "Web Content Accessibility Guidelines (WCAG) 2.2", "url": "https://www.w3.org/TR/WCAG22/", "publisher": "W3C", "date": "2023-10-05", "note": "W3C Recommendation." },
    { "title": "What's New in WCAG 2.2", "url": "https://www.w3.org/WAI/standards-guidelines/wcag/new-in-22/", "publisher": "W3C WAI", "accessed": "2026-11-04" },
    { "title": "How to Meet WCAG (Quick Reference)", "url": "https://www.w3.org/WAI/WCAG22/quickref/", "publisher": "W3C WAI", "accessed": "2026-11-04" },
    { "title": "Understanding Success Criterion 2.5.8: Target Size (Minimum)", "url": "https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html", "publisher": "W3C WAI", "accessed": "2026-11-04" }
  ] }
---

# Accessibility checklist (WCAG 2.2 AA)

WCAG 2.2 became a W3C Recommendation on 5 October 2023. Level AA means meeting every Level A and Level AA success criterion. This checklist covers the criteria a design review can catch; some (code semantics, screen reader behaviour) need engineering to verify in the build. It's a working summary, not the standard: when a case is unclear, read the criterion's "Understanding" page on w3.org and cite it.

## Design-stage checklist

**Colour and contrast**
- [ ] Body text contrast at least 4.5:1 against its background; large text (at least 18pt, or 14pt bold) at least 3:1. (1.4.3)
- [ ] Icons, input borders, focus indicators and other UI parts needed to understand or operate the interface at least 3:1 against adjacent colours. (1.4.11)
- [ ] Colour is never the only way information is shown: errors, status and chart series also use text, icons or patterns. (1.4.1)

**Layout and text**
- [ ] Works at 320 CSS px wide without horizontal scrolling (except content like data tables and maps). (1.4.10)
- [ ] Text can be resized to 200% without losing content or function. (1.4.4)
- [ ] Layout survives user text spacing: line height 1.5×, paragraph spacing 2×, letter spacing 0.12×, word spacing 0.16× the font size. (1.4.12)
- [ ] Content shown on hover or focus can be dismissed, hovered over and stays until dismissed. (1.4.13)
- [ ] Headings, lists and tables are marked as such in the design annotations, not just styled to look like them. (1.3.1)

**Keyboard and focus**
- [ ] Everything works by keyboard alone. (2.1.1)
- [ ] Focus order follows the reading and task order. (2.4.3)
- [ ] Focus is always visible (2.4.7) and the focused item is not entirely hidden by sticky headers, banners or chat widgets. (2.4.11, new in 2.2)

**Pointer and touch**
- [ ] Targets at least 24 × 24 CSS px, or spaced so a 24 px circle centred on each doesn't overlap another target. Exceptions include inline links in text and an equivalent control elsewhere on the page. (2.5.8, new in 2.2)
- [ ] Anything done by dragging (reordering, sliders, maps) also works with a single tap or click. (2.5.7, new in 2.2)
- [ ] A control's visible label is included in its accessible name. (2.5.3)

**Forms and errors**
- [ ] Every input has a visible label or instruction. (3.3.2)
- [ ] Errors are identified in text (3.3.1) with a suggestion for fixing them where known. (3.3.3)
- [ ] Information already entered in the same process isn't asked for again; it's filled in or selectable. (3.3.7, new in 2.2)
- [ ] Sign-in doesn't depend on a cognitive test like remembering or transcribing a code, unless there's an alternative (paste allowed, password managers work, or another method). (3.3.8, new in 2.2)
- [ ] Help (contact, chat, FAQ link) appears in the same place on every page that offers it. (3.2.6, new in 2.2)

**Media and content**
- [ ] Every meaningful image has alt text written in the design; decorative images are marked decorative. (1.1.1)
- [ ] Video has captions (1.2.2); nothing flashes more than three times a second. (2.3.1)
- [ ] Link text makes sense in context ("Download the March invoice", not "click here"). (2.4.4)
- [ ] Status messages (saved, 3 results) are announced without moving focus; annotate them for engineering. (4.1.3)

## What changed from 2.1

Nine criteria were added in 2.2; the six at A and AA are marked "new in 2.2" above. Criterion 4.1.1 Parsing was removed as obsolete.

## Computing the conformance KR

**Accessibility conformance** = audited screens with zero AA failures ÷ audited screens.

Write the screen sample, the method (manual checklist, automated tool, assistive technology test) and who audited in `/org/design/kpis.md`. Automated tools catch only part of the failures (contrast, missing labels); manual checks are needed for focus order, keyboard use and meaning. Count a screen as failing if any single criterion fails; don't score partial credit, or the number hides real barriers.

## Common pitfalls

- Checking contrast on the default state only; hover, disabled-looking-but-active and placeholder text fail too.
- Designing focus styles last, or removing them for looks.
- "Accessible" claimed from an automated scan alone.
- Tiny icon buttons in dense toolbars with no spacing.
- Error messages shown only in red.
