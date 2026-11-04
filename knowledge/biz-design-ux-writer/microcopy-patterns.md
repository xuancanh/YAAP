---json
{ "title": "Microcopy patterns", "summary": "Patterns with good and bad examples for buttons, labels, helper text, empty states, confirmations, notifications and onboarding.", "tags": ["microcopy", "buttons", "labels", "empty states", "patterns"], "updated": "2026-11-04",
  "sources": [
    { "title": "W3C: Web Content Accessibility Guidelines (WCAG) 2.2 (accessed 2026-11-04)", "url": "https://www.w3.org/TR/WCAG22/" }
  ] }
---

# Microcopy patterns

Microcopy is the small text that helps someone finish a task. Each pattern below has a job; write to the job. Save strings per flow in `/org/design/work/<slug>/copy.md`, with an ID, the screen and state, the string and any character limit.

## Buttons and actions

**Job:** say what will happen when clicked.

- Start with a verb and name the object: **Save changes**, **Send invoice**, **Delete project**.
- Match the button to the heading or question: dialog "Delete this project?" → **Delete project** / **Cancel**, not **Yes** / **No**.
- Primary action is the one most people want; destructive actions are explicit and never the default.
- Avoid **Submit**, **OK** and **Click here**. They don't say what happens.
- Keep the same verb through the flow: if the button says **Publish**, the confirmation says "Published", not "Posted".

## Form labels and helper text

**Job:** tell people what to enter and why, before they make a mistake.

- Every input has a visible label. WCAG 2.2 requires labels or instructions when content needs user input (3.3.2, level A). Placeholder text disappears when typing starts, so it isn't a label.
- Labels are nouns: **Work email**, **Company name**.
- Helper text gives format or reason: "We'll send the receipt here." / "Use at least 12 characters." (Check real rules with engineering.)
- Mark optional fields or required ones consistently, whichever is the minority.
- Ask only for what's needed; if a field looks intrusive, explain why we need it.

## Empty states

**Job:** explain what will appear here and how to get started.

```
[Heading]   No invoices yet
[Body]      Invoices you create or import show up here.
[Action]    Create invoice
```

- Different empty states need different copy: first use (teach), no results (suggest a change to the search), cleared (confirm it's done), no permission (say who can grant it).
- Don't blame or joke when the user is stuck.

## Loading and progress

**Job:** reassure and set expectations.

- For short waits, a spinner may need no text. For longer ones, say what's happening: "Importing 240 contacts…".
- If it can take a while, say so and say whether they can leave the page.
- Status updates that appear without moving focus should be announced to screen reader users (WCAG 2.2, 4.1.3 Status Messages, level AA). Flag these strings to engineering in the copy file.

## Confirmations and success

**Job:** confirm what happened and what's next.

- Past tense, specific: "Invoice sent to ana@example.com".
- Add the next step if there is one: "Invoice sent. **View invoice**".
- For destructive actions, offer undo where the product supports it rather than a "Are you sure?" dialog for everything.

## Destructive confirmation dialogs

```
Heading:  Delete "Q4 plan"?
Body:     This deletes the project and its 12 tasks for everyone. You can't undo this.
Buttons:  Delete project   Cancel
```

Name the thing, say the consequence, say whether it's reversible.

## Notifications and emails from the product

**Job:** tell people something they need to know or act on, and nothing else.

- Lead with what happened or what they need to do: "Your payment failed. Update your card to keep your plan."
- One action per notification.
- Say why they're receiving it if it isn't obvious, and how to change notification settings.
- Don't use urgency that isn't real.

## Onboarding and tooltips

- Teach by doing: one tip at the moment it's useful, not a tour of everything.
- Tooltips explain; they don't hold information people need to finish the task (tooltips are easy to miss).
- Let people skip and find tips again later.

## Links

- Link text says where it goes: "See billing settings", not "here". Screen reader users often navigate by a list of links.

## Writing checklist (per string)

- [ ] Says the one thing this element needs to say.
- [ ] Uses glossary terms; same verb as related actions.
- [ ] Front-loads the important words.
- [ ] Reads correctly aloud and out of visual context.
- [ ] Fits the space in the longest supported language (ask about localisation; translated text is often longer).
- [ ] Makes no promise the product can't keep.
- [ ] Sentence case (or the voice guide's rule) applied consistently.

## Copy file entry format

```markdown
| ID | Screen / state | Element | String | Limit | Notes |
|---|---|---|---|---|---|
| inv.empty.title | Invoices / empty (first use) | Heading | No invoices yet | 40 | |
| inv.empty.cta | Invoices / empty | Button | Create invoice | 20 | Same verb as nav |
```
