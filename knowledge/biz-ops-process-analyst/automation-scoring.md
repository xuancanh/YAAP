---json
{ "title": "Automation scoring", "summary": "Classify manual steps for automation, estimate payback, apply guardrails for money, customers and access, and write a ranked candidate list.", "tags": ["automation", "payback", "prioritisation", "guardrails"], "updated": "2026-11-04" }
---

# Automation scoring

Automate a step only after you have tried removing it and simplifying it. Automating a bad step makes it fail faster and more quietly.

## Step 1: classify each manual step

| Class | Signs | What to do |
|---|---|---|
| **Rule-based, stable** | Same inputs, same decision every time; rules can be written down; inputs are structured | Good candidate |
| **Judgement** | Decision depends on context, exceptions are frequent, people disagree on the answer | Keep manual, or assist (draft, pre-fill, suggest) |
| **Sensitive** | Moves money, contacts customers, changes access or permissions, deletes data | Can be automated only with a human approval step |
| **Unstable** | The process or its tools are about to change | Wait; re-scan after the change |

A step can be split: often the gathering and formatting are rule-based while the decision is judgement. Automate the first part and leave the decision.

## Step 2: estimate payback

For each good candidate:

- **Hours saved per month** = monthly volume × touch time per item × share of items the automation will handle without a person.
- **Error cost avoided** (optional) = monthly volume × current error rate × the expected reduction × the time to fix one error.
- **Build effort** in hours, from the team that would build it (Engineering, IT, or a configured agent loop).
- **Run cost:** tool licences, maintenance hours per month, monitoring.

**Payback period (months)** = build effort ÷ (hours saved per month − maintenance hours per month).

If maintenance eats most of the saving, the candidate drops down the list however clever it is. Mark every input as measured or estimated; touch times and handled share are usually estimates.

## Step 3: score risk

Rate each candidate low, medium or high on:

- **Blast radius:** if it misfires, how many items or people are affected before someone notices?
- **Detectability:** will a failure be visible (an error, an alert) or silent (wrong data passed on)?
- **Reversibility:** can a wrong action be undone cheaply?

High blast radius plus low detectability needs a check or approval step and an alert, or it stays manual.

## Step 4: the guardrails

Every automation proposal must state:

- **Owner:** the person who answers when it breaks.
- **Approval point:** for sensitive steps, who approves each action or batch.
- **Monitoring:** how a failure shows up, and where.
- **Fallback:** the manual SOP steps to follow when it is down. Keep them in the SOP.
- **Access:** the least access the automation needs. Ask IT & Security to review any new credential.

## Step 5: rank and write up

Rank by payback, then break ties by risk (lower first). Write the top five to /org/operations/automation-candidates.md:

```
| Rank | Process / step | Volume/mo | Hours saved/mo (est.) | Build (h) | Payback (mo) | Risk | Builder | Notes |
```

Work that belongs to Engineering or IT becomes a backlog task for them; you do not build it yourself.

## After it ships

- Count it in the automation rate only once it handles items in production.
- Measure it like any improvement: baseline, after window, guardrail.
- Re-check maintenance hours after a quarter; update the payback with real numbers.

## Pitfalls

- Counting hours saved for a step that was already being skipped.
- Automating a step whose input is unreliable, so errors arrive faster.
- No owner, so the automation silently stops and nobody notices.
- Calling a draft-plus-approval flow "automated". It is assisted; count it separately.
