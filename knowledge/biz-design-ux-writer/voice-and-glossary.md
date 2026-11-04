---json
{ "title": "Voice and glossary templates", "summary": "Templates and rules for the product voice guide, tone by situation, and a glossary that keeps terms consistent.", "tags": ["voice", "tone", "glossary", "terminology", "template"], "updated": "2026-11-04" }
---

# Voice and glossary templates

Voice is who the product is; tone is how that voice adapts to the moment. The glossary keeps one name for one thing. Together they let many writers, human and agent, sound like one product.

## Voice guide template

Save as `/org/design/content/voice.md`. Keep it short enough to use while writing.

```markdown
# Product voice

## Our voice in three traits
| Trait | This | Not that | Example |
|---|---|---|---|
| Clear | Plain words, one idea per sentence | Jargon, clever wordplay | "Your invoice is sent." |
| Helpful | Says what to do next | Lectures, over-explains | "Add a card to keep your plan." |
| Calm | Steady, even when things go wrong | Alarmist, jokey | "We couldn't save. Your draft is kept." |

## Tone by situation
| Situation | User's state | Tone | Example |
|---|---|---|---|
| Onboarding | Curious, unsure | Encouraging, brief | |
| Doing the core task | Focused | Minimal, out of the way | |
| Success | Pleased | Warm, short | |
| Error | Frustrated or worried | Calm, specific, no jokes | |
| Billing and money | Cautious | Precise, plain | |
| Destructive action | Hesitant | Direct about consequences | |

## Mechanics
- Capitalisation: sentence case for headings and buttons (or your rule)
- Person: "you" for the user; "we" for the company (and when not to use "we")
- Contractions: yes / no
- Numbers, dates, times, currency: formats per locale
- Punctuation: no full stop on single-sentence buttons and labels; exclamation marks rarely
- Inclusive language: gender-neutral, no ableist idioms, no assumptions about the user

## Words to avoid
- <word> → use <alternative> (reason)

## Links
- Brand voice (marketing): <link>  — product voice follows it, adapted for UI
- Glossary: /org/design/content/glossary.md
```

### Writing traits that work

- **Each trait has a "not that".** Without the opposite, "friendly" means anything.
- **Examples beat rules.** Show a real string for every trait and situation.
- **Product voice is quieter than marketing voice.** People are mid-task; personality shows in clarity and care, not wit.

## Glossary template

Save as `/org/design/content/glossary.md`.

```markdown
| Term | Definition (user-facing) | Use | Don't use | Notes / context | Owner | Added |
|---|---|---|---|---|---|---|
| Workspace | The shared space where your team's projects live | workspace (lowercase in text) | team, org, account | "Account" is the person's login | Product | 2026-03 |
| Archive | Hide a project without deleting it | archive, archived | trash, hide | Different from Delete; reversible | Product | 2026-05 |
```

### Rules for the glossary

1. **One concept, one term.** If two terms exist in the product for the same thing, pick one and log the other under "Don't use".
2. **Users' words beat internal words.** Check support tickets, sales calls and research notes for how customers say it. If engineering calls it a "tenant" but users say "workspace", the UI says workspace.
3. **Define user-facing terms in a sentence a user would understand.** If you can't, the concept may be unclear in the product too. Raise it with the designer.
4. **Coordinate with marketing.** Product names and feature names should match the marketing style guide. Disagreements go to the owners, not into the UI.
5. **Localisation:** note terms that must not be translated (product names) and terms with agreed translations.

## Adding a new term

When a new feature introduces a concept:

1. Check whether an existing term already covers it.
2. Gather the candidate words from the brief, the designer, engineering and users.
3. Test the main candidates if the term is central: ask a few users what they expect each word to mean.
4. Add it with definition, owner and date, and tell the designer, product owner and marketing.
5. Search the current UI and help content for conflicting uses and log fixes for the next [content audit](content-audit-and-metrics.md).

## Glossary health

Run a quick check each month as part of the audit:

- Terms in the UI that aren't in the glossary.
- "Don't use" terms that still appear in the UI.
- Glossary entries with no owner or that no longer exist in the product.
