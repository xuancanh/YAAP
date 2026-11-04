---json
{ "title": "Accessibility baseline", "summary": "The WCAG 2.2 AA requirements a product designer must check in every design, with what each means for layouts, components and specs.", "tags": ["accessibility", "wcag", "checklist", "inclusive design"], "updated": "2026-11-04",
  "sources": [
    { "title": "W3C: Web Content Accessibility Guidelines (WCAG) 2.2 (accessed 2026-11-04)", "url": "https://www.w3.org/TR/WCAG22/" },
    { "title": "W3C WAI: How to Meet WCAG (Quick Reference) (accessed 2026-11-04)", "url": "https://www.w3.org/WAI/WCAG22/quickref/" }
  ] }
---

# Accessibility baseline

Your charter says designs meet accessibility rules by default. The usual target is WCAG 2.2 level AA. It's referenced by many accessibility laws and procurement rules, which vary by country and change over time, so check with Legal which standard applies to the company. This doc lists the criteria designers most often decide, in plain words. It isn't the full standard; use the W3C quick reference for the rest.

## Colour and contrast

- **Text contrast (1.4.3, AA):** at least 4.5:1 for normal text and 3:1 for large text against its background. Check every text style on every background, including text over images, placeholders you keep, and disabled-looking text that's still meaningful.
- **Non-text contrast (1.4.11, AA):** at least 3:1 against adjacent colours for the visual parts needed to identify controls and their states (input borders, checkbox outlines, focus indicators, selected states) and for meaningful parts of graphics like chart lines.
- **Use of colour (1.4.1, A):** colour isn't the only way to convey information. Errors need text or an icon; chart series need labels or patterns; links in body text need more than a colour change.

## Text and layout

- **Resize text (1.4.4, AA):** text can be zoomed to 200% without losing content or function.
- **Reflow (1.4.10, AA):** content works at narrow widths without scrolling in two directions (except things like data tables and maps). Design the mobile layout and you've mostly covered it.
- **Text spacing (1.4.12, AA):** layouts survive users increasing line, paragraph, letter and word spacing. Avoid fixed-height text containers.

## Interaction

- **Keyboard (2.1.1, A):** everything can be done with a keyboard. Specify keyboard behaviour for custom components (menus, tabs, drag-and-drop alternatives).
- **Focus visible (2.4.7, AA):** the keyboard focus is always visible. Design a focus style for every interactive component, meeting non-text contrast.
- **Focus order (2.4.3, A):** focus moves in a logical order. Note the order in the handoff for complex layouts and dialogs.
- **Focus not obscured (2.4.11, AA):** a focused element isn't completely hidden by sticky headers, footers or banners.
- **Target size (2.5.8, AA):** pointer targets are at least 24 by 24 CSS pixels, with some exceptions (such as enough spacing around a smaller target, or inline links in text). Many teams choose larger targets for touch.
- **Dragging movements (2.5.7, AA):** anything done by dragging also has a single-pointer alternative (for example, buttons to reorder).

## Forms and errors

- **Labels or instructions (3.3.2, A):** inputs have labels or instructions. Visible labels, not placeholder-only.
- **Error identification (3.3.1, A):** errors are identified and described in text.
- **Error suggestion (3.3.3, AA):** when we know how to fix it, say so.
- **Redundant entry (3.3.7, A):** don't make people re-enter information they already gave in the same process; pre-fill or let them select it.
- **Accessible authentication (3.3.8, AA):** don't require a cognitive test (like remembering or transcribing a code) to log in without an alternative; allow paste and password managers.
- **Status messages (4.1.3, AA):** messages like "Saved" or "3 results" that appear without focus moving are announced by assistive technology. Mark them in the spec.

## Content and structure

- **Non-text content (1.1.1, A):** meaningful images and icons have a text alternative; decorative ones are marked as such. Icon-only buttons need an accessible name in the spec.
- **Headings and labels (2.4.6, AA):** headings and labels describe their topic or purpose.
- **Info and relationships (1.3.1, A):** structure shown visually (headings, lists, tables, groups) is in the markup. Annotate heading levels and landmarks in the handoff.
- **Consistent help (3.2.6, A):** if help (contact, chat, FAQ link) appears on several pages, it's in the same relative place.

## Motion

- **Three flashes (2.3.1, A):** nothing flashes more than three times a second.
- **Pause, stop, hide (2.2.2, A):** auto-moving content (carousels, animations longer than a few seconds) can be paused.
- Respect the user's reduced-motion setting for non-essential animation (good practice).

## Design review checklist

- [ ] Every text/background pair checked for contrast; component borders and focus rings at 3:1.
- [ ] No meaning by colour alone.
- [ ] Focus style designed; focus order annotated for complex screens.
- [ ] Targets meet the minimum size or spacing.
- [ ] Every input has a visible label; errors in text with a fix.
- [ ] Icon-only controls have names; images have alt text or are marked decorative.
- [ ] Drag actions have an alternative.
- [ ] Layout checked at 200% zoom and narrow width.
- [ ] Status messages marked for announcement.

Automated checkers catch only part of these. Keyboard and screen reader checks of the prototype or build find the rest.
