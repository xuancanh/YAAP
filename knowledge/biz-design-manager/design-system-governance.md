---json
{ "title": "Design system governance", "summary": "How components enter, change and leave the design system: the proposal template, acceptance criteria, statuses, deprecation and the changelog entry.", "tags": ["design-system", "governance", "components", "changelog", "design"], "updated": "2026-11-04" }
---

# Design system governance

A design system only helps if teams use it and trust it. Governance is the small set of rules that keeps it both: new components come in for a reason, changes are announced, and old ones retire with a migration path. The inventory lives at `/org/design/system/inventory.md` and the changelog at `/org/design/system/changelog.md`.

## Statuses

| Status | Meaning | Use in new work |
|---|---|---|
| Proposed | Under review | no |
| Beta | Accepted, API or design may still change | yes, with a note in the handoff |
| Stable | Documented, accessible, in code | yes, the default |
| Deprecated | Being replaced; has a named replacement and removal date | no |
| Removed | Gone from design files and code | no |

## Proposal template

A designer (or an engineer) files this as a task for you when the existing system doesn't cover a need.

```markdown
# Component proposal: <name>
Proposed by: <member> · Date: <date>
Need: <the user problem and the screens that need it — at least two places>
Why existing components don't fit: <which ones were tried and why they fall short>
Could an existing component be extended instead? <yes/no and why>
Variants and states: default, hover, focus, active, disabled, error, loading
Accessibility: contrast, keyboard behaviour, focus, target size, screen reader name and role
Content rules: <label length, tone>
Tokens used: <colour, spacing, type tokens — no hard-coded values>
Engineering: <who builds it; estimate from engineering>
```

## Acceptance criteria

Accept, adapt or reject, and write the reason in the task:

- [ ] Needed in at least two places now (one-offs stay local to their screen).
- [ ] No existing component can reasonably be extended to cover it.
- [ ] All states designed, including focus and error.
- [ ] Passes the [accessibility checklist](./accessibility-checklist.md).
- [ ] Uses tokens, not hard-coded values.
- [ ] An owner is named for its documentation and future changes.
- [ ] Engineering has agreed to build it into the code library; a design-only component drifts from the product.

## Changes and breaking changes

A change is **breaking** if screens using the component would look or behave differently in a way their owners must check: a removed variant, a changed API, a different size or spacing that affects layout. Breaking changes need:

1. a changelog entry marked breaking, with the reason,
2. an `org_message` to engineering and product,
3. a migration task for each affected area, with a due date,
4. a deprecation period for the old version (the length is a company default in `/org/design/cadence.md`).

### Changelog entry

```markdown
## <yyyy-mm-dd> — <component> <status change or version>
Type: added | changed | deprecated | removed | fixed · Breaking: yes/no
What changed: <...>
Why: <the problem it solves; link to proposal or audit finding>
Migration: <what users of the old version do; task ids>
Owner: <member>
```

## Tracking adoption

Adoption is measured in the monthly audit (see [Design metrics](./design-metrics.md)). Alongside the number, list the one-off styles found in review: each is either a gap in the system (propose a component or token) or a mistake (coach the designer). Two or more teams building the same one-off is a strong signal to add it.

## Turning rules into playbooks

When a usage rule has held for a few months without exceptions (for example, "destructive actions always use the danger button and a confirmation dialog"), write it as a company playbook with `org_write_playbook` so every member applies it, not only designers.

## Common pitfalls

- Accepting every request, so the system fills with near-duplicates.
- Rejecting everything, so teams build around the system and adoption falls.
- Components that exist in design files but not in code.
- Deprecating without a replacement or a date.
- Changes announced only in the changelog, which nobody outside design reads.
