---json
{ "title": "Audit report template", "summary": "A copyable shape for the Auditor's closing summary (org_audit_close): scope, sample, what holds, findings by severity, patterns, limits and the one recommended change.", "tags": ["reporting", "template", "audit"], "updated": "2026-11-04" }
---

# Audit report template

The closing summary is what most people read; the individual findings are what owners act on. The summary should let a reader who wasn't there answer four questions in a minute: what did you look at, what holds, what doesn't, and what's the one change that would help most.

## Template

```markdown
# Audit — <org> — <yyyy-mm-dd>

Period: <from> – <to> · Run: [run:…] · Auditor model family: <family>
Independence: <"different family from the workers' majority" | "single-model audit: no other family available">
Triggered by: <cadence | assurance request [task:…]>

## Headline
<One or two sentences: the overall picture and the most important finding.>

## Scope and sample
| Area | Population | Tested | How chosen |
|---|---|---|---|
| Accepted work | <N> tasks | <n> | random, seed <s>; + <k> targeted |
| Scope and autonomous actions | <N> rows | <n> | all |
| Spend | <N> members | <n> | risk-weighted: top spend per accepted task |
| Reported numbers | <N> numbers in <k> reports | <n> | per function |
| Decision log / risk register | <N> rows | <n> | random |
| Values mechanisms | <N> values | <n> | all |

Not tested: <what, and why: budget cap reached, source missing>

## What holds
- <Area>: <what you tested and found sound, with the count: "12 of 12 sampled numbers reconciled to their sources">

## Findings
| Severity | Kind | About | Title |
|---|---|---|---|
| critical | <kind> | [task:…] | <title> |
| warn | | | |
| info | | | |

## Patterns
- <pattern finding title> — built from <ids>

## Assurance requests
- [task:…] "<request title>": <answered by findings … | holds: <why>>

## Limits
<What this audit can't tell you: targeted items aren't representative; data missing for <period>; single-model.>

## The one change
<The single change that would most improve acceptance quality or the record's reliability, and who owns it.>

## Since last audit
<Prior findings: fixed / still open / recurred, with ids.>
```

## Rules for filling it in

- **Counts, not impressions.** "2 of 15", never "most" or "some".
- **What holds is mandatory.** A report of only failures misleads as much as one of only passes.
- **One change.** If you list five recommendations, none gets done. Pick the one with the largest effect; the findings carry the rest.
- **Limits are honest.** If the budget ran out, the sample was cut; say so. If independence wasn't available, say "single-model audit" at the top, not in a footnote.
- **Prior findings.** Checking whether last audit's findings were fixed is cheap and tells the company whether audits change anything. A finding that recurs is worth raising in severity.
- **No fixes.** The report never says you corrected anything. You can't, and you shouldn't.

## Checklist before org_audit_close

- [ ] Every finding has an id, a severity and a quoted evidence line.
- [ ] Every open assurance request is answered or said to hold, citing its task id.
- [ ] The sample is recorded well enough to repeat.
- [ ] "What holds" has at least one line per area tested.
- [ ] Limits and independence are stated.
- [ ] The one change has an owner.
