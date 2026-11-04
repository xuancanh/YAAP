---json
{ "title": "Discovery methods", "summary": "Opportunity solution trees, Jobs to be Done, story-based interviews and assumption tests: how to keep discovery continuous and decide test, spec or kill.", "tags": ["discovery", "research", "opportunity-solution-tree", "jtbd", "experiments", "product"], "updated": "2026-11-04",
  "sources": [
    { "title": "Opportunity Solution Trees: Visualize Your Discovery to Stay Aligned and Drive Outcomes", "url": "https://www.producttalk.org/opportunity-solution-trees/", "author": "Teresa Torres", "publisher": "Product Talk", "accessed": "2026-11-04" },
    { "title": "Know Your Customers' \"Jobs to Be Done\"", "url": "https://hbr.org/2016/09/know-your-customers-jobs-to-be-done", "author": "Clayton M. Christensen, Taddy Hall, Karen Dillon, David S. Duncan", "publisher": "Harvard Business Review", "date": "2016-09" }
  ] }
---

# Discovery methods

Discovery decides what's worth building before engineering spends weeks on it. Keep it small and continuous: a few conversations every week and cheap tests, rather than a big study once a quarter. The User Researcher runs interviews and studies; you own the opportunity tree and the decisions.

## Opportunity solution tree (Teresa Torres)

Kept in `/org/product/discovery/opportunities.md`, one tree per outcome:

1. **Outcome** (the root): a product outcome your team can move, usually a key result, such as account activation.
2. **Opportunities**: customer needs, pain points and desires that, if addressed, would move the outcome. They come from interviews, not brainstorming. Phrase them from the customer's side ("I don't know if my colleagues have seen the report") not as solutions ("add read receipts"). A quick test: if only one solution fits, it's a solution in disguise.
3. **Solutions**: ideas for one target opportunity at a time. Compare at least three, so you aren't just validating your first idea.
4. **Assumption tests**: the riskiest assumptions behind each solution, and the cheapest test of each.

Torres advises sizing and choosing opportunities before thinking about effort, because easy solutions often hide inside opportunities that look hard.

## Jobs to be Done

From Christensen and colleagues: customers "hire" a product to make progress in a particular circumstance. The job, not the customer's demographics, explains why they choose. Useful questions: what were they trying to get done, what did they use before (often a workaround or nothing), what pushed them to look, what nearly stopped them switching. A common way to write one down is the "job story" format:

> When <situation>, I want to <motivation>, so I can <expected outcome>.

Jobs feed the opportunity level of the tree and the competitive alternatives in marketing's positioning, so share the synthesis with the Head of Marketing.

## Story-based interviews

Ask about a specific past instance ("Tell me about the last time you shared a report"), not opinions about the future ("Would you use…?"). People are poor at predicting their own behaviour and polite about your ideas. Probe for what happened next and what they did instead. Synthesise each interview within a day into the tree, with the interview as evidence.

## Assumption tests

Sort assumptions by type: desirability (do they want it), viability (does it work for the business), feasibility (can we build it), usability (can they use it). Test the one that's most important and least backed by evidence first.

Cheap methods, roughly from cheapest: check existing data, a one-question in-product survey, a fake door (a button that measures clicks before the feature exists, disclosed honestly to anyone who clicks), a prototype test with five or so users, a concierge or manual version for a few accounts. Anything that touches real customers in a new way needs the owner's approval first.

### Test brief template

```markdown
# Assumption test: <assumption>
Opportunity: <link to the tree node> · Solution: <name>
Hypothesis: We believe <assumption>. We'll know we're right if <measurable signal>.
Method: <data check | survey | fake door | prototype test | concierge>
Sample: <who and how many>
Success threshold (set before the test): <e.g. 6 of 10 participants complete the task unaided>
Owner / due: <member> / <date>
Result: <counts and quotes> → decision: continue | spec | kill (why)
```

## Decision rules

- **Kill** when the test missed its threshold and no cheaper variant is worth trying. Write why; killed opportunities count toward discovery throughput.
- **Continue** when the result is ambiguous: name the next, sharper test.
- **Spec** when the riskiest assumptions have passed. The spec links the evidence.

## Common pitfalls

- Opportunities that are features in disguise.
- A tree built from internal opinions with no interview behind any node.
- Setting the success threshold after seeing the result.
- Testing the easiest assumption instead of the riskiest.
- Interviews with only happy, active users; include churned and stalled accounts.
