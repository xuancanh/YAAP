---json
{ "title": "Segmentation that changes a decision", "summary": "How to choose between rule-based and clustering segmentation, pick features, validate segments and describe them so a team can act.", "tags": ["segmentation", "clustering", "customers", "rfm"], "updated": "2026-11-04" }
---

# Segmentation that changes a decision

A segmentation is worth doing only if different segments will be treated differently: different pricing, messaging, onboarding, sales attention or product priorities. Start from that treatment, not from the algorithm.

## 1. Pin the decision

Write: "Team X will <do something differently> for each segment." Examples:

- Customer Success decides which accounts get proactive check-ins.
- Marketing decides which onboarding email track each new workspace gets.
- Product decides which user group a feature is for.

The decision tells you how many segments are usable (a team can rarely act on more than a handful) and which features are relevant.

## 2. Choose the approach

| Approach | When | Pros | Cons |
|---|---|---|---|
| **Rule-based** (thresholds on a few variables) | The business already has a hypothesis; must be explainable and stable | Easy to explain, implement and monitor | Can miss structure |
| **RFM** (recency, frequency, monetary value) | Transactional behaviour, retention and value targeting | Well-known, simple, actionable | Ignores needs and context |
| **Clustering** (k-means, hierarchical, mixture models) | Exploring unknown structure in many behaviours | Finds patterns you didn't expect | Harder to explain; unstable if features change |
| **Predictive** (score then band, such as churn risk) | One outcome matters most | Directly tied to the outcome | Only one dimension |

Prefer the simplest approach that supports the decision. A rule-based segmentation that a team uses beats a clever clustering nobody trusts.

## 3. Choose features

- Use behaviours and attributes that relate to the decision: usage frequency, features used, team size, plan, tenure, support contacts, spend.
- Avoid features you cannot act on or that would be unfair or unlawful to target by. Rules on using personal and sensitive data differ by jurisdiction; check the company's privacy policy and ask Legal when in doubt.
- For clustering: scale features so no single one dominates (standardise); reduce heavily skewed features (log transform); remove near-duplicate features.
- Measure features over a fixed, recent window and the same window for everyone.

## 4. Choose the number of segments

For clustering, combine a statistical view with usefulness:

- **Statistical:** elbow in within-cluster variance, silhouette score, or information criteria for mixture models. Treat these as hints.
- **Practical:** can each segment be described in a sentence, and does it need different treatment? Merge segments that would be treated the same.
- **Size:** very small segments are rarely worth separate treatment unless they are high value.

## 5. Validate

- **Stability:** re-run on a different time window or a random half of the data. Do similar segments appear? Do the same customers mostly land in the same segment?
- **Distinctness:** segments differ meaningfully on the features and, ideally, on an outcome they were not built from (retention, expansion).
- **Actionability check:** show the descriptions to the team that will use them. Can they say what they would do differently?

## 6. Describe each segment

```markdown
## Segment: <memorable, neutral name>
Size: <count and share>   Value: <share of revenue or other outcome>
Who they are: <one or two sentences in plain words>
Defining traits: <the 3–4 features that most distinguish them, with values>
Outcome: <retention, expansion, support load vs average>
Suggested treatment: <what the team could do differently>
Rule to assign: <exact rule or model, so it can be re-run>
```

Avoid names that judge or stereotype people. Name by behaviour ("weekly power teams", "single-seat explorers").

## 7. Hand off and maintain

- Provide the assignment rule or model as a saved query or table, refreshed on a schedule, with the Analytics Engineer if it needs to be modelled.
- Agree when to review: segments drift as the product and customer base change.
- If a segment-specific treatment is launched, test it (see [experiment design checklist](experiment-design-checklist.md)) rather than assuming it works.

## Pitfalls

- Starting with clustering because it is available. Start with the decision.
- Too many segments. More than the team can treat differently is noise.
- Describing segments only by averages. Show spread; averages can describe nobody.
