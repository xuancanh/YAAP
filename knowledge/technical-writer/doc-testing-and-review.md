---json
{ "title": "Doc testing and review", "summary": "How to test tutorials and how-tos before shipping, run a review, and keep docs from rotting.", "tags": ["testing", "review", "docs-as-code", "maintenance"], "updated": "2026-11-04" }
---

# Doc testing and review

Docs fail in two ways: the step was wrong when you wrote it, or it went wrong later. Testing catches the first and rot checks catch the second. Neither needs fancy tooling.

## The literal walkthrough (before shipping)

1. **Start clean.** Use a fresh container, VM, new account or test org: anything without your existing setup. Most "works on my machine" bugs come from a leftover environment variable, a cached login or a tool installed months ago.
2. **Follow the page exactly as written.** Copy every command from the page itself. Don't fix things in your head.
3. **Log every bump.** Note the step number, what you expected and what happened. Count even a five-second pause where you wondered what to do.
4. **Time it.** Use the real time for the estimate at the top. Add some margin for a beginner who reads more slowly than you.
5. **Fix and repeat** until a walkthrough has no bumps.

If you can't run it (no access, or a paid service), say so in the handoff: "Steps 4–7 not tested end-to-end; needs a run with a production account." Never ship untested steps silently.

## Testing with a real beginner

The best test is someone from the target audience who hasn't seen the page:

- Give them the page and the goal. Nothing else.
- Watch, and stay quiet. Write down where they hesitate, re-read or leave the page.
- Ask afterwards: "What did you expect to happen at step 5?"

Even one or two sessions usually find the worst problems.

## Review checklist (for your own or someone else's draft)

**Technical review** (by an engineer or the maintainer):
- [ ] Defaults, limits, versions and error messages match the current code.
- [ ] Nothing is described that's internal-only or not yet released.
- [ ] Warnings exist where a step can lose data or break production.

**Editorial review** (by a writer):
- [ ] The page has one type (see [Doc types decision guide](doc-types-decision-guide.md)).
- [ ] It passes the [Style and terminology checklist](style-and-terminology-checklist.md).
- [ ] It's findable: the title matches what readers would search for, and it's linked from where they'd look.

Give feedback as specific, fixable comments: "Step 3: the button is labelled 'Create key' in the UI, not 'New key'". Avoid "this section is confusing".

## Rot checks (ongoing)

Run these on a schedule, such as quarterly or with the docs audit:

| Check | How |
|---|---|
| Dead links | A link checker in CI, or a crawl of the docs site |
| Stale versions | Search for old version strings ("v2", old package versions) |
| Screenshot age | List images by date, and review any older than the last UI redesign |
| Broken examples | Run code samples in CI where possible; otherwise test them by hand on each major release |
| Renamed UI | Compare the terminology list against the current UI labels |

Record each finding with its date and a count ("14 pages reference the v2 API, checked 2026-11-04"). A count is a work list. "Some docs are old" isn't.

## Keeping docs close to the code

- Ask for docs changes in the same pull request as the code change, where the team accepts that.
- Add a "docs needed?" line to the PR template.
- Generate the skeleton of reference pages from the schema where possible. Then write the descriptions and error guidance by hand, because generators don't produce those.

## Worked example

A tutorial says "about 15 minutes". The clean-room run takes 34 minutes. Two bumps cause most of it: a missing `npm install` before step 3, and a login step that now asks for two-factor auth. Fix both, rerun in 18 minutes, and update the estimate to "about 20 minutes".

## Common mistakes

- Testing in your own development environment.
- Testing only the happy path. Also try the most common error, and check that the "if you see X" recovery works.
- Treating review as approval rather than as testing.
