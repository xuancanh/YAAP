---json
{ "title": "Error message guide", "summary": "A formula and examples for validation, system and permission errors, the accessibility rules they must meet, and a catalogue template.", "tags": ["error messages", "accessibility", "validation", "catalogue"], "updated": "2026-11-04",
  "sources": [
    { "title": "W3C: Web Content Accessibility Guidelines (WCAG) 2.2 (accessed 2026-11-04)", "url": "https://www.w3.org/TR/WCAG22/" }
  ] }
---

# Error message guide

An error message has one job: get the person moving again. It should say what happened, why if it helps, and what to do next, in words the person understands, without blaming them.

## The formula

```
[What happened] + [Why, if useful] + [How to fix or what to do next]
```

| Bad | Good |
|---|---|
| Invalid input. | Enter a date in the format DD/MM/YYYY. |
| Error 403. | You don't have access to this project. Ask an admin to invite you. |
| Something went wrong. | We couldn't save your changes because the connection dropped. Check your connection and try again. Your draft is kept. |
| Password does not meet requirements. | Use at least 12 characters, including a number. (Use the real rule.) |
| Payment failed. | Your card was declined. Try another card or contact your bank. |

## Accessibility requirements

These come from WCAG 2.2 (check the current version the company targets):

- **3.3.1 Error Identification (level A):** when an input error is detected automatically, the item in error is identified and the error is described to the user in text. Colour or an icon alone isn't enough.
- **3.3.3 Error Suggestion (level AA):** when an error is detected and suggestions for correction are known, provide them (unless it would compromise security or purpose).
- **4.1.3 Status Messages (level AA):** messages that appear without moving focus must be available to assistive technologies. Mark such errors in the copy file so engineering wires them up.

In practice: put the message next to the field, start with the field name if the message is shown in a summary ("Email: enter an address like name@example.com"), and keep the user's input so they can fix it rather than retype.

## Types of errors

### Validation (the user can fix it)

- Say what's needed, not what's wrong: "Enter a phone number with the country code", not "Invalid phone".
- Validate at a sensible moment: after the person leaves the field or on submit, not while they're still typing.
- For long forms, show a summary at the top that links to each field in error, plus inline messages.

### System (we caused it, or it's outside their control)

- Take responsibility: "We couldn't…", not "You failed to…".
- Say what's safe: is their data saved? Was the payment taken?
- Give a next step: retry, try later, contact support with a reference code.
- Don't show raw codes or stack traces as the message. A reference code for support is fine, after the human sentence.

### Permission

- Say what they can't do and who can help: "Only workspace admins can change billing. Ask <admin name> or an admin."
- Don't reveal information they shouldn't see (such as whether a private item exists) when the security owner says not to.

### Not found and empty results

- Suggest a way forward: check the spelling, clear filters, go back to a known place.

## Tone

- Plain, calm and specific. No jokes, no "Oops!" when someone may have lost work or money.
- No blame words: "illegal", "invalid", "forbidden", "you failed".
- Match seriousness to impact. A failed payment needs more care than a mistyped date.

## The error catalogue

Keep every error in `/org/design/content/errors.md` so the same failure always gets the same message, and so you can measure coverage.

```markdown
| ID | Trigger (from engineering) | Type | Message | Action / link | A11y notes | Status |
|---|---|---|---|---|---|---|
| auth.email.invalid | Email fails format check | Validation | Enter an email address like name@example.com. | — | Inline, announced | Live |
| billing.card.declined | Processor returns decline | System | Your card was declined. Try another card or contact your bank. | Update card | Status message | Live |
| api.timeout | Request > timeout | System | We couldn't load this. Try again in a moment. | Retry | | Draft |
```

How to build it:

1. Ask engineering for the list of error conditions the flow can return (validation rules, API errors, permission checks).
2. Write a message for each, using the formula.
3. Group duplicates: many technical errors can share one human message.
4. Add a generic fallback for unknown errors that still gives a next step.
5. Mark status (draft, approved, live) and review with engineering that each trigger maps to the right message.

## Review checklist

- [ ] Says what happened in the user's terms.
- [ ] Says how to fix it or what to do next.
- [ ] Keeps the user's work and says so.
- [ ] Identified in text, next to the problem, and announced if it appears dynamically.
- [ ] No blame, no jargon, no raw code as the message.
- [ ] Uses glossary terms.
- [ ] Is in the catalogue with its trigger.
