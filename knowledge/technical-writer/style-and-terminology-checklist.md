---json
{ "title": "Style and terminology checklist", "summary": "An editing checklist for plain, consistent technical docs, plus how to keep a terminology list.", "tags": ["style", "editing", "terminology", "plain-language"], "updated": "2026-11-04",
  "sources": [{ "title": "Google developer documentation style guide", "url": "https://developers.google.com/style" },
              { "title": "Microsoft Writing Style Guide", "url": "https://learn.microsoft.com/en-us/style-guide/welcome/" }] }
---

# Style and terminology checklist

Run this over every draft before review. If the project has docs-style.md, its rules come first. This checklist covers the gaps and sets a starting point for a new project. For anything not covered here, the big public style guides (Google's and Microsoft's, linked in the sources) are good tie-breakers.

## Editing checklist

**Lead and structure**
- [ ] The first sentence says what the page helps the reader do.
- [ ] Prerequisites are near the top, specific and honest (versions, accounts, access).
- [ ] Headings are short and describe the task or topic. Use sentence case unless the house style says otherwise.
- [ ] Lists are used for steps and parallel items, not for an argument that needs prose.

**Sentences**
- [ ] Use active voice and second person: "Run the installer", not "The installer should be run".
- [ ] Use present tense: "The command returns…", not "will return".
- [ ] Each step has one instruction. Conditions go first: "If you use Windows, run…".
- [ ] No "simply", "just", "easy" or "obviously". These words make a stuck reader feel worse.
- [ ] No vague references. Replace "this" or "it" with the noun when there's any doubt.
- [ ] Spell out abbreviations the first time you use them.

**Instructions and UI**
- [ ] UI labels match the product exactly, including capitals, and appear in bold (or whatever the house style uses).
- [ ] Commands, file names, parameters and values are in code formatting.
- [ ] Commands can be copied and pasted. Placeholders are obvious (`<API_KEY>`) and explained.
- [ ] Expected output appears after any step that can fail.

**Accessibility and inclusion**
- [ ] Link text says where it goes ("see the configuration reference"), never "click here".
- [ ] Images have alt text. Nothing important is only in an image. Screenshots support the text rather than replace it.
- [ ] Instructions don't rely on colour or position alone ("the green button on the right").
- [ ] Examples use inclusive, neutral names and avoid idioms that don't translate.

**Accuracy**
- [ ] Every version number, default and limit is checked against the source of truth, or marked unverified.
- [ ] Examples have been run. See [Doc testing and review](doc-testing-and-review.md).

## Keeping a terminology list

Inconsistent names are a top cause of reader confusion. If the docs say "workspace", "project" and "space" for one thing, readers assume there are three things.

Keep a table in docs-style.md:

| Use | Don't use | Notes |
|---|---|---|
| sign in | log in, login (as a verb) | "Sign-in" as a noun or adjective |
| `user_id` | userId, uid | The API uses snake_case throughout |
| workspace | project, space | "Project" means something else in v3 |

How to keep it useful:

1. **Seed it during the audit.** List every term that appears in more than one spelling or form.
2. **Decide with the maintainer**, especially when the code and the UI disagree. Record the decision and its date.
3. **Sweep on every release.** Search the docs for each "don't use" entry.
4. **Add new terms when features ship**, not afterwards.

## Plain-language swaps

| Instead of | Write |
|---|---|
| utilize | use |
| in order to | to |
| prior to | before |
| leverage | use |
| it is recommended that you | we recommend / you should |
| functionality | feature, or name what it does |

## Common mistakes

- Editing for style before checking the facts. A polished wrong step is worse than a rough correct one.
- Making terminology decisions alone. A naming mismatch between the code and the UI is a product decision.
- Applying the checklist to code samples. Code follows the language's own conventions.
