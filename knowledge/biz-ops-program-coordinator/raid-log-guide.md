---json
{ "title": "Writing a useful RAID log", "summary": "How to tell risks, assumptions, issues and dependencies apart, write each row so it can be acted on, and run the weekly review.", "tags": ["raid", "risk", "issues", "assumptions", "dependencies"], "updated": "2026-11-04" }
---

# Writing a useful RAID log

A RAID log is useful when each row leads to an action by a named person by a date. Logs fail when they become a list of worries with no owners.

## Which table does it go in?

| Type | Test | Example |
|---|---|---|
| **Risk** | Might happen; would hurt if it did | The vendor may not deliver test accounts before integration starts |
| **Assumption** | We are planning as if it is true, and haven't confirmed it | Existing SSO covers the new tool |
| **Issue** | Is happening now and hurting | Two support agents can't log in to the training environment |
| **Dependency** | We need something from outside the program by a date | Finance must approve the budget line by 12 Dec |

Two moves happen every week:
- An **assumption** that turns out false becomes an **issue** (if it is already hurting) or a **risk** (if it might).
- A **risk** that happens becomes an **issue**. Close the risk row with a pointer to the new issue.

## Writing a risk

Use cause → event → effect, so the mitigation has something to aim at:

> Because the vendor has not confirmed a sandbox date (**cause**), integration testing may start late (**event**), which would push M3 past 20 Jan (**effect**).

Then fill:
- **Likelihood:** low, medium, high — with one line of why.
- **Impact:** low, medium, high — in terms of a milestone or the goal.
- **Owner:** the person who will act, not the person who raised it.
- **Mitigation:** what reduces likelihood or impact, with a date. "Monitor" alone is not a mitigation; "Ask vendor for a date by Fri; if none, start with mock API" is.
- **Trigger date:** when you will know whether it is happening.

Use the company's risk scoring if the shared risk topic defines one; otherwise low/medium/high is enough.

## Writing an assumption

State it as a sentence that can be true or false, with an owner and a date to validate it. "SSO works" is vague; "The new tool supports our identity provider on the plan we are buying — IT admin to confirm by 5 Dec" is checkable.

## Writing an issue

Description, impact (what it blocks), owner, due date for the fix or the next step. An issue without an owner is the top item in your status until it has one.

## Writing a dependency

What is needed, from which unit, needed-by date, status (requested, accepted, delivered, late). A dependency on another unit is a backlog task on that unit's board, created with org_create_task; the RAID row links to it.

## Example rows

```
Risks
| ID | Risk | L | I | Owner | Mitigation (by) | Trigger |
| R4 | Because two agents are on the year-end close, data validation may slip, delaying M2 | M | H | Head of Finance | Agree validation slot in week 2 (Fri 6 Dec) | 6 Dec |

Issues
| ID | Issue | Impact | Owner | Due |
| I2 | Training environment rejects support logins | Blocks M4 training | IT admin | 3 Dec |
```

## The weekly review

Before writing the status:

1. **Issues first.** Is each one moving? Any without an owner or past due?
2. **Dependencies:** any past needed-by, or still unaccepted?
3. **Risks:** any trigger date passed? Has evidence changed likelihood or impact? Any risk now happening?
4. **Assumptions:** any past their validation date unchecked?
5. **Close** what is resolved, with a date and one line.
6. **Pick the top three** for the status: usually unowned issues, high-impact risks near their trigger, and late dependencies on the critical path.

## Pitfalls

- Generic risks ("resourcing", "scope creep") that apply to any program. Name the specific cause.
- Owners who were never asked. Confirm before you write their name.
- Rows that never close, so the log grows until nobody reads it.
- Logging the same item in two tables. Pick one and cross-reference.
