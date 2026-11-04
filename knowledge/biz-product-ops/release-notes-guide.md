---json
{ "title": "Release notes guide", "summary": "Templates and rules for customer-facing and internal release notes: confirm what is live, write benefit first, and separate what support and sales need to know.", "tags": ["release-notes", "changelog", "templates", "enablement"], "updated": "2026-11-04" }
---

# Release notes guide

Release notes have two audiences with different needs. Customers want to know what they can now do and how. Support and sales want to know what changed, what might break, and what to say. Write two documents, from the same confirmed list.

## Step 1: confirm what is actually live

Before writing a word, build the list from the board and accepted stories, then confirm each item with engineering:

| Item | Live for | Flag / rollout | Docs link | Known issues |
|---|---|---|---|---|
| Filter report by cost centre | all plans | none | | |
| Bulk invite | 10% of new workspaces | `bulk_invite` | | CSV over a size limit fails silently |

Anything behind a flag or a partial rollout goes in internal notes only, or in external notes with "rolling out" if marketing agrees. Never announce what customers cannot yet use.

## Customer-facing notes

**Template:**

```markdown
## <Release name or date>

### <Benefit headline, in the user's words>
<One or two sentences: what you can do now, and why it helps.>
**How:** <where to find it, the first step> — [Learn more](<docs link>)

### Improvements
- <Short benefit-first line>

### Fixes
- <What now works that didn't, in user terms>
```

**Rules:**
- **Benefit first.** "See one team's spend in seconds: filter the monthly report by cost centre." Not "Added cost-centre filter component."
- **Use the product's words** for buttons and pages, exactly as they appear.
- **One feature, one heading.** Group small items under Improvements and Fixes.
- **Show how** with the first step and a docs link.
- **Fixes in user terms:** "Exports with special characters in names now download correctly."
- **No dates for future work,** no "coming soon" unless the roadmap commits it.
- **No internal names,** ticket numbers or flags.
- **Breaking changes go first,** clearly marked, with what the user must do and by when.

## Internal notes (support and sales)

**Template:**

```markdown
## <Release> — internal
### What changed
| Item | Who has it | Flag | Docs |
### Known issues and workarounds
- <issue> — workaround — fix expected? (only if committed)
### Likely questions
- Q: <question customers will ask> — A: <answer>
### What not to say
- <promises we can't make; features still rolling out>
### Who to ask
- <owner per item>
```

Support needs the known issues and workarounds most; sales needs the talk track and the "what not to say". Keep both short.

## Review checklist

- [ ] Every item confirmed live (or clearly marked rolling out) by engineering.
- [ ] Each customer-facing item leads with a benefit and has a how and a docs link.
- [ ] No future dates, internal names or flags in the customer version.
- [ ] Breaking changes at the top with the action needed.
- [ ] Internal notes list known issues, workarounds and owners.
- [ ] No customer names or data.
- [ ] Publication tier and approval follow marketing's rules.

## After release

- Note which items get docs traffic or support questions; feed recurring questions into the next feedback triage.
- If a released item is rolled back, update both notes the same day.

## Pitfalls

- Copying story titles as notes. Story titles are written for engineers.
- Burying a breaking change in Fixes.
- Writing notes before confirming rollout status, then announcing something half the customers cannot see.
- Long notes nobody reads. If a feature needs explanation, link to docs or a short guide.
