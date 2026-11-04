---json
{ "title": "Exploratory testing charters and heuristics", "summary": "How to write a charter, run a time-boxed session, and use heuristics that find the bugs scripts miss.", "tags": ["exploratory testing", "charter", "heuristics", "qa"], "updated": "2026-11-04" }
---

# Exploratory testing

Exploratory testing is learning, designing and running tests at the same time. It finds what scripts miss because scripts only check what someone already thought of. It still needs structure: a charter, a time box and notes.

## Charter format

One sentence, three parts:

> **Explore** <target> **with** <resources, data, technique> **to discover** <the kind of information you want>.

Examples:

- Explore the refund flow with partial refunds and multiple currencies to discover rounding and total errors.
- Explore the invite form with long, unusual and duplicate email addresses to discover validation and error-message gaps.
- Explore the dashboard with a slow network and a session that expires mid-use to discover state and recovery problems.

A good charter is narrow enough to finish in one session and wide enough to allow surprises.

## Running a session

1. **Time box it**, typically 45 to 90 minutes. Short sessions keep focus.
2. **Set up first:** test account, data, any tools (network throttling, a second browser for a second user).
3. **Take notes as you go**, timestamped: what you tried, what you saw, questions, ideas for more tests.
4. **Follow surprises, within reason.** If you find something off-charter, note it as a new charter rather than abandoning the current one.
5. **Stop on time** and write up.

## Write-up template

```markdown
# Session: <charter>
Date / length: <date>, <minutes>   Build: <version>

## Covered
<Areas and variations actually tried.>

## Bugs
<Links to bug reports filed.>

## Issues and questions
<Things that are not clearly bugs: confusing copy, unclear rules, missing requirements.>

## Not covered
<What the charter included that you did not reach.>

## Follow-up charters
<New sessions worth running.>
```

## Heuristics that find bugs

Use these as prompts when you run out of ideas.

**Input**
- Empty, whitespace only, very long, maximum length plus one.
- Unicode: accents, right-to-left text, emoji, characters that look alike.
- Numbers: zero, negative, decimals, very large, different decimal separators.
- Pasted text with hidden formatting; leading and trailing spaces.

**Time**
- Month end, year end, leap day, daylight-saving changes.
- Different time zones for two users looking at the same item.
- Actions just before and after an expiry (trial end, token expiry).

**State and sequence**
- Do things out of order. Skip a step. Repeat a step.
- Back button, refresh, double-click submit, two tabs on the same item.
- Interrupt: lose the network, let the session expire, close the browser mid-action. Is anything half-saved?

**Users and permissions**
- Lowest-privilege role; a user removed from a team mid-session.
- Two users editing the same thing.
- A user from another workspace guessing an ID in the URL.

**CRUD**
- For every thing the feature creates, can it be read, updated and deleted? What happens to things that depend on it after deletion?

**Environment**
- Narrow screen, zoomed text, keyboard only, screen reader basics.
- Slow network, offline then online.

**Consistency**
- Does it match how similar features behave elsewhere in the product?
- Do the numbers on this screen match the numbers in exports, emails and reports?

## Pitfalls

- Sessions without notes produce opinions, not findings.
- Exploring only the happy path is a demo, not a test.
- Turning every session into a script. Automate what you will need again; keep exploring what is new.
