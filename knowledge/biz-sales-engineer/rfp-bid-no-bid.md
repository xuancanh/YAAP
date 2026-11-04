---json
{ "title": "RFP bid/no-bid and response", "summary": "A bid/no-bid scorecard, a requirement matrix format and a response workflow for RFPs and RFIs.", "tags": ["rfp", "rfi", "bid-no-bid", "requirements", "template"], "updated": "2026-11-04" }
---

# RFP bid/no-bid and response

Responding to an RFP costs days of work across several people. Decide deliberately whether to bid, then answer every requirement with an honest compliance status.

## Bid/no-bid scorecard

Score each question 0 (no), 1 (partly) or 2 (yes). Agree the threshold with the Head of Sales; the score informs the decision, it doesn't make it.

| Question | Score |
|---|---|
| Did we know about this opportunity before the RFP arrived (do we have a relationship)? | |
| Do we meet the mandatory requirements? | |
| Does the buyer fit our ideal customer profile? | |
| Is the deal size worth the effort? | |
| Can we compete on the evaluation criteria (price weight, references, certifications)? | |
| Do we have the people to respond well by the deadline? | |
| Are the contract terms in the RFP acceptable or negotiable? | |
| Is there a realistic chance the RFP was not written for a competitor? | |

Strong reasons to decline even with a good score: a mandatory requirement we can't meet, a certification we don't hold that is required, or terms legal won't accept.

Write the recommendation with the score, the top reasons and the effort estimate, and let the Head of Sales decide.

## Requirement matrix

Break the RFP into individual requirements and track them in one table:

```
| ID | Section | Requirement (verbatim) | Mandatory? | Status | Answer / reference | Owner | Reviewed |
```

Use these compliance statuses:

- **Fully compliant**: supported today, standard product, buyer's plan
- **Partially compliant**: supported with limits; describe them
- **Configuration**: supported through standard configuration, no custom work
- **Custom / services**: requires paid services or custom work; quote separately
- **Roadmap**: not available; include only with product's written confirmation and caveats
- **Non-compliant**: not supported; say so plainly

The matrix is also the gap list for the go/no-go and for pricing.

## Response workflow

1. **Kickoff** (day one): read the whole RFP; note deadline, submission format, Q&A deadline, evaluation criteria and mandatory forms.
2. **Questions to the buyer**: send clarifying questions before the Q&A deadline; ambiguous requirements are a risk.
3. **Assign owners** by section: technical (SE), security (security owner), commercial (AE, deal desk), legal (legal).
4. **Draft** from the answer library and the security library; mark new answers for review.
5. **Executive summary**: written last, by the AE with the SE; it ties our answer to the buyer's stated goals and evaluation criteria.
6. **Review**: compliance status checked against product facts; consistency across sections; format and page limits met.
7. **Submit** before the deadline with time to spare; keep a copy of exactly what was sent.
8. **Library update**: add new approved answers.

## Writing answers

- Mirror the RFP's numbering and wording so evaluators can score you easily.
- Lead with the compliance status and a direct answer, then the detail.
- Use the buyer's terms and outcomes, not our marketing language.
- Answer every question, even with "Non-compliant". Blank answers often score zero.

## After submission

- Log the decision outcome and any feedback the buyer gives.
- If lost, ask for a debrief; record the reasons for the next bid/no-bid.

## Pitfalls

- **Bidding on everything.** Low-fit RFPs consume the time that would win high-fit deals.
- **Optimistic statuses.** "Partially compliant" stretched to "fully" will surface in implementation or the contract.
- **Late reviews.** Leave time for security and legal; they are usually the bottleneck.
