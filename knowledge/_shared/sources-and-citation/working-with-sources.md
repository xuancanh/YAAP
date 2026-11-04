---json
{ "title": "Working with sources", "summary": "How to judge and use evidence: primary vs secondary sources, recency, triangulation, and labelling facts, estimates and opinions so nobody repeats a guess as fact.", "tags": ["sources", "research", "evidence", "accuracy"], "updated": "2026-11-04" }
---

# Working with sources

Everything you write gets reused. A number in your memo ends up in someone's plan, then in a board update. So every claim needs to be traceable to where it came from, and anything that isn't a checked fact needs a label saying so.

**The rule: never invent a number.** A figure comes from a metric source, a file, or a named person, or it's labelled as an estimate with its basis. If you can't get it, say "unknown" and say how to find out.

## Primary vs secondary

- **Primary**: the original. The metric source or dashboard, the raw export, the contract, the company's own pricing page, the published study, a person's direct statement.
- **Secondary**: someone reporting on the original. A blog post about a study, a news article, a colleague's summary, a market report quoting other reports.

Go to the primary source whenever you can. Secondary sources drop caveats, round numbers, and sometimes get them wrong. If you can only find a secondary source, cite it and say so: "reported by <X>; original not found".

Inside the company, the order of trust is usually: the system of record (billing, analytics, the board), then files under `/org/` that cite it, then a named person's statement, then your own estimate.

## Recency

Check the date of everything. Prices, team sizes, market figures, laws and product features all change.

- Note the date the source was published, *and* the date you checked it.
- Prefer the most recent reliable source. If you use an older one, say why.
- For fast-moving facts (prices, rankings, availability), treat anything you haven't checked recently as needing re-checking.

## Triangulation

One source can be wrong. For any claim that a decision rests on, look for a second *independent* source, meaning one that didn't copy the first.

- Two sources agree: state it with more confidence.
- Two sources disagree: report both, give the range, and say which you trust more and why. Don't silently pick one.
- Only one source: say so. "Single source: <X>."

Five articles all quoting the same press release count as one source.

## Label what kind of claim it is

Make it obvious which statements are facts, which are estimates, and which are opinions.

| Kind | How to write it |
|---|---|
| **Fact** (sourced) | "Activation was 44% in October (analytics: activation_w1, checked 2026-11-04)." |
| **Estimate** | "**Estimate:** 300–500 accounts would switch, based on the share of accounts with 5+ members (billing report) × the trial conversion rate. Not measured." |
| **Assumption** | "Assuming the price stays the same in 2027…" |
| **Opinion / recommendation** | "I'd launch in January, because…" |
| **Unknown** | "Unknown: churn for per-seat plans. Could test with a pilot." |

An estimate should show its working: the inputs (with sources), the method and the range. Then someone can check it or improve it.

## Quick checklist for any claim

- [ ] Where did this come from? Can I link or name it?
- [ ] Is it the primary source?
- [ ] How old is it, and does that matter here?
- [ ] Does a second, independent source agree?
- [ ] Is it labelled fact, estimate, assumption or opinion?
- [ ] If it's an estimate, is the basis and range shown?

## Worked example

Task: *how big is the market for our team plan?* A secondary article says "a $5B market". Tracing it back, the figure comes from an analyst report you can't access, about a broader category. Write it as: "A 2025 article (link) cites an analyst estimate of $5B for <broader category>. Original not accessible; the category is wider than ours, so treat it as an upper bound. Bottom-up **estimate**: <count of target companies, source> × <price, source> = <range>." That gives the reader both numbers, where each one came from, and which one to trust.

## Common pitfalls

- **Laundered guesses.** An estimate in one file gets quoted as fact in the next. Keep the label attached every time you reuse it.
- **Citing the summary, not the source.** Find the original, or say you couldn't.
- **Undated facts.** "Competitor X charges $10" is useless without a date.
- **Echo-chamber triangulation.** Several sources repeating one origin are one source.
- **Filling gaps to look complete.** "Unknown, here's how to find out" is a better answer than a made-up number.

For how to write the citations themselves, see [citing sources](./citing-sources.md).
