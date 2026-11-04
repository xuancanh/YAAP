---json
{ "title": "Citing sources", "summary": "How to cite a company file, a metric, a person, a web page with its date, and a knowledge-base doc using the (KB: <path>) form.", "tags": ["citation", "sources", "knowledge-base", "accuracy"], "updated": "2026-11-04" }
---

# Citing sources

A citation lets the reader check a claim in one step. Put it right next to the claim, keep it short, and make it specific enough that someone else can find exactly what you used.

## Where to put citations

- **Inline, next to the claim**, in parentheses: "Activation was 44% in October (analytics: activation_w1, 2026-11-04)."
- For longer documents, you can also add a **Sources** list at the end. Keep the inline citations anyway, because readers skim.
- Cite every number, every quote, and every claim a decision depends on. Common knowledge in your field doesn't need a citation.

## Forms to use

| Source | Form | Example |
|---|---|---|
| Company file | the full path, plus the section if the file is long | (/org/sales/lost-deals.md, "October") |
| Metric | the metric source and its name, the period, and the date you read it | (billing report: MRR, October 2026, read 2026-11-04) |
| Board task | the task code and title | (task GRO-14 "Onboarding checklist") |
| Decision | the log and the entry date | (/org/decisions.md, 2026-11-04 "Add a per-seat team plan") |
| Person | their name or role, the channel and the date | (Sales lead, #sales, 2026-11-03) |
| Web page | the title, the site or publisher, the URL, and the date you accessed it; also the published date if shown | ("Pricing", Example Inc., https://example.com/pricing, accessed 2026-11-04) |
| Report or paper | the author or organisation, the title, the year, and a URL if there is one | (Klein, "Performing a Project Premortem", HBR, 2007) |
| Knowledge-base doc | `(KB: <path>)` | (KB: _shared/okrs/writing-key-results.md) |

Always write out the full path or URL. "The pricing doc" or "the dashboard" can't be checked.

## Citing the knowledge base

When a knowledge-base doc shaped your work, meaning you used its method, template or checklist, cite it with **`(KB: <path>)`**, where the path is what kb_search and kb_read show:

- Shared topics: `(KB: _shared/okrs/writing-key-results.md)`, `(KB: _shared/risk/pre-mortems.md)`
- Role packs: `(KB: biz-finance-manager/budget-memo.md)`

Put it where the method shows up, usually once near the top or next to the relevant section:

```markdown
## Key results
Drafted to the outcome/baseline/target/source format
(KB: _shared/okrs/writing-key-results.md).
```

Two things to keep straight:

- **A KB doc is a source for methods, not for company facts.** It can tell you how to score a risk, but not what your churn rate is. Numbers about the company come from metric sources, files or people.
- **If a KB doc itself cites an outside source for a fact** (for example, Intercom's RICE scales), and the fact matters to your output, cite that original source too, or both.

## Web sources: always add the date

Web pages change. Record:

- **accessed**: the date you read it. Always include this.
- **published or updated**: the date the page shows, if it has one.

If the content is likely to change (prices, feature lists), save the key figures in your file along with the access date, so the claim still makes sense after the page moves on.

## Template: a Sources section

```markdown
## Sources
1. /org/sales/lost-deals.md — lost-deal notes, October 2026
2. Billing report: MRR by plan, October 2026 (read 2026-11-04)
3. "Pricing", Competitor A, https://competitor-a.example/pricing (accessed 2026-11-04)
4. Sales lead, #sales, 2026-11-03 — which plan we usually lose to
5. Method: (KB: _shared/prioritisation/impact-effort-and-rice.md)

Estimates in this doc are marked **Estimate** and show their inputs.
```

## Worked example

Before: "Most of our lost deals are about pricing, and competitors all have per-seat plans, so we should add one."

After: "Two of the five deals lost in October cited no per-seat option (/org/sales/lost-deals.md). All three close competitors list a per-seat team plan on their public pricing pages (links in /org/research/pricing-scan-2026-11.md, accessed 2026-11-04). Recommendation, using RICE (KB: _shared/prioritisation/impact-effort-and-rice.md): add a per-seat plan."

The "after" version is longer by a few words, but every claim in it can be checked. The sweeping "most of our lost deals" has been replaced by the actual count from the file.

## Checklist

- [ ] Every number and quote has an inline citation
- [ ] Full paths and URLs, not nicknames
- [ ] Web sources have an accessed date
- [ ] KB docs cited as `(KB: <path>)` where their method was used
- [ ] No company fact cited only to a KB doc
- [ ] Estimates labelled, with their inputs cited

## Common pitfalls

- **Vague pointers.** "Per the data" or "see the drive" can't be followed.
- **Citing the KB for facts.** The KB explains methods. Your company's numbers live elsewhere.
- **Missing dates on web citations.** Without one, the reader can't tell whether the claim is still true.
- **Citations at the end only.** Readers can't match claims to sources.
- **Citing a source you didn't read.** If you only saw a summary of it, cite the summary.

For judging which sources to trust, see [working with sources](./working-with-sources.md).
