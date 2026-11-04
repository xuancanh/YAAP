---json
{ "title": "Mapping method", "summary": "How to scope a process with SIPOC, interview the people doing it, draw a swimlane table, and spot the waste worth fixing.", "tags": ["process-mapping", "sipoc", "swimlane", "lean", "waste"], "updated": "2026-11-04" }
---

# Mapping method

A useful map shows where an item waits, where it gets sent back, and who touches it. A map that only lists steps is a flowchart of the official process, and it will not tell you anything new.

## 1. Scope with SIPOC

Before you walk the process, fill one line each for:

- **Suppliers:** who provides the inputs.
- **Inputs:** what arrives (a request, a form, a file).
- **Process:** five to seven high-level steps, no more.
- **Outputs:** what leaves, and in what state.
- **Customers:** who receives the output.

Add the trigger, the end state, the monthly volume and the owner. If you cannot agree on the end state with the owner, stop: you are mapping two processes.

## 2. Gather evidence before interviews

Read the last few weeks of tasks for the process on the board. Note timestamps, reopenings, comments asking for missing information, and who reassigns to whom. This gives you facts to test in interviews and stops the interview becoming a description of the ideal.

## 3. Interview the people doing it

Ask about the last real item, not the general case. Useful questions:

- "Walk me through the last one you did. What arrived, and what did you do first?"
- "Where did it sit before you picked it up? How did you know it was ready?"
- "What did you have to chase or ask for?"
- "When does one come back to you? What was wrong the last time?"
- "What do you do that is not written down anywhere?"
- "If you were off for a week, what would go wrong?"

Talk to at least one person per lane. The owner's view and the doer's view often differ, and the gap is a finding.

## 4. Draw the swimlane table

A table is easier to keep in Markdown than a diagram, and easier to compute from.

| # | Step | Lane (who) | Tool | Wait before | Touch | Rework % | Notes |
|---|---|---|---|---|---|---|---|
| 1 | Receive request | Requester → Ops | form | — | 5 min (est.) | — | 1 in 4 missing cost centre |
| 2 | Approve | Head of unit | email | 2 days (measured) | 2 min | — | no reminder sent |
| 3 | Create PO | Ops | finance tool | 0.5 day | 15 min | 10% | wrong vendor ID |

Mark each figure **measured** or **estimated**. Count hand-offs: every change of lane is one, and each is a place to wait and to lose information.

## 5. Spot waste

Lean practice groups non-value-adding work into common types. In office processes, look for:

- **Waiting:** queues, approvals, "waiting for info".
- **Defects:** rework, corrections, re-entering data.
- **Overprocessing:** approvals or checks that never reject anything; reports nobody reads.
- **Motion and transport:** copying between tools, forwarding emails, searching for files.
- **Inventory:** batches waiting for a weekly run.
- **Unused skills:** experts doing data entry.

For each candidate, ask: does the customer of this process care if this step disappeared? If not, it is a removal candidate.

## 6. Find the top three

Rank delays and errors by their contribution to cycle time or rework, multiplied by volume. Write each as:

> **Delay:** approvals wait a median 2 days in email (measured, 30 items). **Evidence:** board timestamps. **Likely cause:** no reminder and no delegate when the head is busy.

Name the cause you believe, mark it as a hypothesis, and say how you would test it.

## Pitfalls

- Mapping from the SOP instead of the work.
- One interview, treated as the process.
- Precise-looking numbers that are guesses. Ranges and labels are more honest.
- Mapping every exception. Map the main path and the two or three most common exceptions; note the rest.
- Proposing fixes in the map. Keep the map descriptive; fixes go in the improvement case.
