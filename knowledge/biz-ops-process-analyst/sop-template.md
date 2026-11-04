---json
{ "title": "SOP template and checklist", "summary": "A fill-in SOP template plus the writing rules and review checklist that make an SOP usable by someone doing the process for the first time.", "tags": ["sop", "template", "documentation", "checklist"], "updated": "2026-11-04" }
---

# SOP template and checklist

An SOP is good if someone doing the process for the first time can finish it correctly without asking anyone. Test it that way: hand it to a person (or agent) who has not done the process and watch where they stop.

## Template

```markdown
# <Process name> SOP

Owner: <role>   Version: <n>   Last reviewed: <date>   Next review: <date>

## Purpose
One sentence: what this produces and why it matters.

## When to use
The trigger. Also: when NOT to use it, and what to use instead.

## Roles
| Role | Does |
|---|---|

## Before you start
- Access needed: <tool, permission>
- Inputs needed: <file, form, field> — where to find each

## Steps
1. <Verb> <object> in <tool / field / file>. <Expected result.>
2. ...
   - **Check:** <what to verify before going on>
3. ...

## If something goes wrong
| Symptom | Do this | Ask |
|---|---|---|

## SLA
<How long from trigger to output; who is told if it is missed.>

## Example
<One worked example of the judgement call in step n.>

## Change log
| Date | Version | Change | By |
```

## Writing rules

- **One action per step.** "Open the vendor form and fill in the cost centre and attach the quote" is three steps.
- **Start each step with a verb.** Open, enter, attach, send, check.
- **Name the exact place.** Not "update the record" but "set Status to Approved in the Vendors table".
- **Say what success looks like.** "You should see a PO number in the confirmation." This lets the reader self-check.
- **Put checks where errors happen.** Use your process map's rework data: the step with the most send-backs gets a check just before hand-off.
- **Write judgement calls as rules plus an example.** "Escalate if the amount is unusual" is not followable; "Escalate if the amount is above the budget line in the request; for example, …" is.
- **Keep the why short.** One line of purpose per section is enough. Long rationale goes in the process map.
- **Use the words the team uses.** If everyone calls it "the intake sheet", call it that.

## Review checklist

Before asking the owner to sign off:

- [ ] Trigger and end state match the process map.
- [ ] Every step is one action with a named tool or file.
- [ ] Every prerequisite (access, input) is listed before step 1.
- [ ] The top rework points have a check.
- [ ] The failure table covers at least the common errors from the map.
- [ ] Each judgement call has an example.
- [ ] Owner, version and review dates are filled in.
- [ ] No personal data or secrets are pasted in; link to where they live instead.
- [ ] A first-time reader walked through it without help, or you noted where they stalled and fixed it.

## Keeping SOPs current

- Set the next review date from /org/operations/cadence.md when you publish.
- Any process change, however small, triggers a version bump and a change-log line.
- When a step is automated, rewrite it as "Check that <automation> has done <result>; if not, do <manual fallback>". Do not delete the manual path; it is the fallback when the automation breaks.
- An SOP past its review date counts as uncovered in SOP coverage, so review on time or retire the SOP if the process ended.

## Pitfalls

- Writing the SOP from the ideal process rather than the mapped one.
- Screenshots that age with every UI change; prefer field and button names.
- Long SOPs that combine several processes. Split by trigger.
