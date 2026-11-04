---json
{ "title": "Page templates", "summary": "Copy-ready skeletons for how-to guides, troubleshooting entries, reference entries and release notes.", "tags": ["templates", "how-to", "release-notes", "reference"], "updated": "2026-11-04" }
---

# Page templates

Copy a skeleton, fill it in, and delete any section that doesn't apply. Don't leave empty headings. Keep the same order on every page of a type, because readers scan by habit.

## How-to guide

```markdown
# How to <do the task>

<One sentence: what this achieves and when you'd want it.>

**Before you start:** <versions, permissions, things already set up>

1. <One action.> <What the reader should see now.>
2. <One action.>
   If you see `<error text>` instead, <recovery step>.
3. ...

**Check it worked:** <command or screen, plus expected result>

**Related:** <one or two links: reference, explanation>
```

Rules: one action per step. Put the expected result right after any step that can fail. Use exact UI labels and copy-pasteable commands.

## Troubleshooting entry

```markdown
## <The symptom, in the user's words or the exact error message>

**Cause:** <one or two sentences>
**Fix:**
1. ...
**If that didn't work:** <next most likely cause, or where to get help>
```

Title each entry with what the reader sees, not what's broken inside. "Error: EADDRINUSE on start" works. "Port conflicts" doesn't.

## Reference entry (function or endpoint)

```markdown
## <name or METHOD /path>

<What it does, in one sentence.>

**Signature / request:** `<code>`

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| | | | | <what it means, its limits, and units> |

**Returns:** <shape> — example:
<real example>

| Error | When it happens | What the caller should do |
|---|---|---|

**Example:** <minimal runnable call>, then <realistic call with common options>

**Changed in:** <version — what changed>
```

Mark any field you couldn't verify as **unverified** and ask about it, rather than filling it in with something plausible.

## Release note

```markdown
# <Product> <version> — <YYYY-MM-DD>

<Upgrade urgency in one line, such as "Security fix: upgrade promptly">

## Breaking changes
- **<What changed>.** <Who is affected.> <What to do>. (see the migration guide)

## New
- <Capability, from the reader's side>: <what they can now do>.

## Fixed
- <Symptom users saw> no longer happens when <condition>.

## Deprecated
- <Thing> is deprecated and will be removed in <version/date>. Use <replacement>.
```

## Migration block (for breaking changes)

```markdown
### Are you affected?
<A test the reader can run, such as "search your config for retry_limit">

### Before
<old code/config>

### After
<new code/config>

### Steps
1. ...

**Supported until:** <version or date the old behaviour stops working>
```

## Worked example: rewriting a raw entry

- Raw (from the PR title): "Refactor retry logic; cap attempts."
- Release note: "**Webhook retries now stop after 5 attempts.** If you relied on unlimited retries, set `max_retries` on the endpoint. See *How to configure retries*."

The rewrite names the change and who it affects, then says what to do. Leave out internal-only changes (refactors, dependency bumps) unless they change something the reader sees.

## Common mistakes

- Burying breaking changes under "Improvements".
- Writing "Fixed a bug where…" in the code's terms instead of the symptom the user saw.
- Changing the template between releases, so readers can't find things.
- Reference descriptions that just restate the name ("`user_id`: the user ID"). Say what it's for and what values it takes.
