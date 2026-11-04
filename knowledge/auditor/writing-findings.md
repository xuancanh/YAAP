---json
{ "title": "Writing findings", "summary": "How to write an audit finding someone can act on — condition, criteria, cause, effect, recommendation — and how to rate its severity as info, warn or critical.", "tags": ["findings", "severity", "reporting", "template"], "updated": "2026-11-04",
  "sources": [
    { "title": "Domain V: Performing internal audit services (Global Internal Audit Standards)", "url": "https://www.bakertilly.com/insights/domain-v-performing-internal-audit-services", "publisher": "Baker Tilly", "note": "Standards 14.2–14.3 (2024 edition, effective 9 January 2025): condition compared with criteria, root cause when possible, significance and prioritisation of findings." },
    { "title": "Writing findings (Louisiana Governmental Audit Guide)", "url": "https://lla.la.gov/resources/local-government-reporting/louisiana-governmental-audit-guide/400-1210-writing-findings", "publisher": "Louisiana Legislative Auditor", "note": "Elements of a finding under Government Auditing Standards: criteria, condition, cause, effect." }
  ] }
---

# Writing findings

A finding is read in #company by people who weren't there, and acted on by an owner with one tool call. It has to stand on its own. The structure used across internal and government audit is the same: compare what **is** (condition) with what **should be** (criteria), explain **why** (cause) and **so what** (effect), then say what would fix it (recommendation). The IIA's Global Internal Audit Standards (2024) also ask for the root cause where it can be found, and for each finding's significance and priority.

## The five parts

| Part | Question | In this company |
|---|---|---|
| Condition | What did you find? | The fact, with the id and a quoted line: "[task:…] was accepted; final comment: '…'" |
| Criteria | What should it be? | The done_when rubric, a stated value or constraint, a tunable, a playbook step, the KPI definition in kpis.md |
| Cause | Why did the gap happen? | Vague rubric, self-review, missing metric source, a playbook step skipped. "Unknown" is allowed; a guess isn't |
| Effect | What does it matter? | What it changed or risks: a RAG status, a key result score, spend past the envelope, a constraint breached, trust in the scorecard |
| Recommendation | What would close it? | One change, owned: "Head of Ops adds the checkout test to the rubric's checks". You recommend; the owner fixes |

## Template

```markdown
**<kind> · <severity>** — <one-line title>
About: [task:…] / [agent:…] / [run:…] / #decision:…
Condition: <what is, with the quoted evidence line>
Criteria: <what should be, and where it's written>
Cause: <why, or "unknown — not determinable from the record">
Effect: <what it changed or risks>
Recommendation: <one change, and who owns it>
```

Kinds come from your playbooks: `unjustified_scope`, `unjustified_spend`, `charter_drift`, `unreconciled_metric`, `ledger_gap`, `values_gap`, `pattern`, plus acceptance gaps.

## Severity

The scale is the one your playbooks use. Rate by effect, not by how much effort the finding took.

| Severity | Meaning | Examples |
|---|---|---|
| info | Worth knowing; no evidence of harm | rubric vague but the work plausibly fine; a number reconciles but its source is stale |
| warn | Evidence doesn't support what was accepted or reported | done_when claimed, not shown; a scope widening with a generic reason or never used; spend far above the role median per accepted task; a mismatch beyond rounding |
| critical | The result contradicts its criteria, or something material changed because of the gap | self-reviewed work; a stated constraint breached; a mismatch that changed a RAG status, a decision or a key result score; burn projected past the envelope |

When unsure between two levels, pick the lower one and say what would raise it. Critical findings reach the CEO as signals, so they must be airtight.

## Patterns are findings too

One thin acceptance is a task-level finding. The same member accepted on thin evidence again and again, or one reviewer who accepts everything, is a `pattern` finding: list every id it's built from. Your values playbook sets a bar for patterns (several instances in one direction); fewer go in the summary, not a filing.

## Good and bad (made up)

Bad:

> Review quality is poor in sales. Several tasks were accepted without proper checks.

No id, no criteria, no evidence, a verdict.

Good:

> **pattern · warn** — Sales outreach tasks accepted without the reply-rate evidence the rubric asks for
> About: [task:s-101], [task:s-107], [task:s-112]; reviewer [agent:sales-lead]
> Condition: all three accepted in one round; each final comment states "reply rate improved" with no figure or source.
> Criteria: each done_when reads "reply rate measured from the CRM source for the campaign window".
> Cause: unknown from the record; the reviewer accepted without comment each time.
> Effect: the pipeline key result's last two check-ins rely on these claims.
> Recommendation: Head of Sales asks the reviewer to require the CRM read before accepting; owner re-checks the three results.

## Phrasing

- Observations, not verdicts: "the record shows", not "the team failed".
- Values are the CEO's: report the gap between stated value and behaviour; never say the value is wrong.
- Say what holds. A run that found nothing still says what it tested and that it held.
- No adjectives doing the work of evidence ("clearly", "seriously").
