---json
{ "title": "Synthesis method", "summary": "Code notes, cluster observations into patterns, write insights with evidence and implications, and state what the study does not show.", "tags": ["synthesis", "affinity-mapping", "insights", "coding"], "updated": "2026-11-04" }
---

# Synthesis method

Synthesis is where a pile of notes becomes something a team can decide on. The risk is seeing what you expected. The method below keeps the path from observation to insight visible, so anyone can check it.

## 1. Prepare the observations

- Pull every observation from the notes into one table, one row each: participant code, what was said or done, context.
- Keep observations and your interpretations in separate columns (the [interview template](interview-technique.md) already does this).
- Include surprises and contradictions; they are often the most valuable rows.

## 2. Code

Tag each observation with one or more short codes describing what it's about: "workaround: retyping", "trigger: month-end", "trust: numbers don't match".

- Start with codes that come from the data, not from your hypothesis.
- Keep a codebook: code name, a one-line meaning, an example. Reuse codes across studies where they fit, so the repository can be searched.
- If a second person can code a sample of rows, compare; disagreements show where a code is vague.

## 3. Cluster (affinity mapping)

Group coded observations into clusters that share a pattern. Name each cluster as a statement, not a label: "Finance leads don't trust totals they didn't compute themselves", not "Trust".

For each cluster count **how many participants** show it (not how many times it was said). One talkative participant can fill a cluster on their own.

## 4. Write insights

Use the playbook's format with care:

```
Insight: <what we learned, as a statement about users>
Evidence: <n of N participants>; <one or two short quotes or observations, with codes P3, P7>
So what: <implication for the decision this study served>
Confidence: <high / medium / low> because <consistency, sample, method fit>
```

Good insight:
> **Finance leads re-check every total by hand before sharing it.** Evidence: 6 of 8; P2 "I don't send anything I haven't added up myself." So what: a faster report alone won't remove the spreadsheet step; showing how totals are computed might. Confidence: medium — consistent, but all participants were at small companies.

Weak insight:
> Users want better reporting.

The weak version has no behaviour, no count, and no implication.

## 5. Map to the decision

Go back to the plan's decision and "what would change it". For each, state plainly:

- **Supported:** evidence points this way.
- **Contradicted:** evidence points the other way.
- **Unclear:** not enough evidence; say what would settle it.

Link each insight to its place in the opportunity tree. If the study shows an opportunity is not worth pursuing, record it as **killed**, with the reason.

## 6. State the limits

Every synthesis ends with what it doesn't show:

- Who was not in the sample (segments, company sizes, regions).
- Whether findings are about frequency (they usually aren't, in qualitative work).
- Any method weakness (a leading question that slipped in, a prototype bug).

## Writing it up

- Lead with the answer to the decision in two or three sentences.
- Then three to five insights, strongest first.
- Then limits and recommended next steps.
- Quotes anonymised with participant codes; no names or company details.
- Add a short entry to /org/product/research/index.md: study, date, decision, top insights, codes used, link.

## Pitfalls

- Counting mentions instead of participants.
- Writing "users" when you mean "the eight people we spoke to".
- Cherry-picking a vivid quote that only one person said.
- Letting the synthesis recommend a solution the data doesn't support. Implications, yes; designs, only as hypotheses to test.
- Stopping at themes. A theme without a "so what" doesn't change a decision.
