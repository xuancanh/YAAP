---json
{ "title": "Risk-based test planning", "summary": "How to score feature risk, map it to test depth, and write the scope and out-of-scope sections of a test plan.", "tags": ["test plan", "risk", "qa", "scope"], "updated": "2026-11-04" }
---

# Risk-based test planning

You never have time to test everything. Risk-based planning makes the choice explicit: you spend effort where a failure is both likely and costly, and you write down what you chose not to cover.

## Step 1: List the risk items

Break the feature or release into things that can fail independently. Use the change itself as a guide:

- Each user-visible behaviour or rule.
- Each integration point (payment provider, email, another service, a file import).
- Each data change (migration, new field, new state).
- Each changed permission or role.
- Each non-functional property the change could affect: speed, accessibility, security, behaviour on mobile.

## Step 2: Score likelihood and impact

Use a simple 1–3 scale for each and keep the reasons short.

**Likelihood of failure** goes up with: new or heavily changed code, complex logic, many states or branches, a new dependency, a team or area with past defects, little existing test coverage, rushed timelines.

**Impact if it fails** goes up with: money or billing, data loss or corruption, security or privacy exposure, a critical journey (sign-in, the core action, checkout), many users affected, no easy workaround, legal or contractual exposure.

```
risk score = likelihood × impact   (1 to 9)
```

## Step 3: Map score to test depth

| Score | Depth |
|---|---|
| 6–9 | Automated regression test at the right level, plus an exploratory charter, plus negative and boundary cases. Re-test after every related fix. |
| 3–4 | Automated happy path and key negative case; quick exploratory pass. |
| 1–2 | Smoke check, or rely on existing coverage. Record that choice. |

These bands are a starting point; adjust them with your manager to the company's appetite for risk, and write the bands you used into the plan.

## Step 4: Choose techniques per item

- **Boundaries:** test at, just below and just above each limit (amount limits, field lengths, dates at month and year end).
- **Equivalence classes:** one representative value per group that should behave the same (valid, invalid, empty).
- **State transitions:** list states and allowed moves; test each allowed move and at least one forbidden one.
- **Decision tables:** when several conditions combine (role × plan × region), list combinations and test the ones that change the outcome.
- **Pairwise:** when there are too many combinations, cover every pair of values at least once rather than every full combination.

## Step 5: Write the plan

```markdown
# Test plan: <feature or release>
Task: <link>   Author: QA Engineer   Date: <date>

## Scope
| Risk item | L | I | Score | Depth | Techniques | Owner |

## Out of scope
<What will not be tested, and why: low risk, covered elsewhere,
no environment. Each line is a known gap the sign-off will repeat.>

## Environments and data
<Where tests run, which test accounts and data, anything still missing.>

## Entry and exit criteria
Entry: <build deployed to test env, migrations run, test data ready>
Exit: <all score 6+ items tested, no open critical or major defects,
       regression suite passing>

## Risks to the plan itself
<Late build, missing environment, shared test data, dependencies on another team.>
```

## Pitfalls

- **Scoring everything high.** If more than about a third of items are top-band, you have not prioritised. Revisit impact honestly.
- **Forgetting what did not change.** A change to a shared component (auth, pricing, formatting) carries risk into features nobody touched. List the callers.
- **No out-of-scope section.** If it is not written down, stakeholders will assume it was tested.
- **Plan written after testing.** Write it before; update it when scope changes, and note the change.
