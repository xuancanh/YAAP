---json
{ "title": "Choosing a method", "summary": "Match the research question to a method, pick a defensible sample, and know when qualitative findings need a quantitative follow-up.", "tags": ["research-methods", "sample-size", "study-design", "discovery"], "updated": "2026-11-04",
  "sources": [{ "title": "Jakob Nielsen, Why You Only Need to Test with 5 Users (Alertbox, 19 March 2000; archived copy), accessed 2026-11-04", "url": "https://webarchive.library.unt.edu/web/20121006195132/http://www.useit.com/alertbox/20000319.html" }] }
---

# Choosing a method

Pick the method from the question, not from habit. The question type decides whether you need depth (a few people, observed closely) or breadth (many people, measured lightly).

## Question → method

| The team needs to know… | Question type | Method | Typical output |
|---|---|---|---|
| Why people do something; what problem they have | Why / how | Problem interviews | Needs, workflows, pain points |
| Whether people can use a design | Can they | Usability test (moderated or unmoderated) | Task success, issues by severity |
| How many people have a behaviour or need | How many | Survey; product analytics | Proportions by segment |
| What actually happened | What happened | Product data review; support ticket analysis | Funnels, drop-off points, counts |
| Which of two designs works better at scale | Which | A/B test (with the analytics team) | Difference in a metric |
| How people use it in their real setting | Context | Observation; diary study | Workarounds, environment, frequency |
| How people group or name things | Structure | Card sorting; tree testing | Labels, navigation |

Two rules of thumb:
- **Qualitative first when you don't know the options.** You can't write good survey answers before you know what people actually say.
- **Quantitative after when you need to size it.** Five interviews showing a problem tell you it exists; a survey or data tells you how common it is.

## Sample size

**Interviews.** Recruit until new sessions stop adding new themes for the question. For a single, well-defined segment, a small number of interviews often gets there; your playbook's default is 5–8. If you have several distinct segments, plan that number per segment.

**Usability tests.** Nielsen's 2000 Alertbox argued that testing with about five users finds most usability problems for a group of similar users, and that several small rounds with fixes in between beat one large test. He limited it to comparable users using the design in similar ways. Apply it that way: five per distinct user group per round, then fix and test again.

**Surveys and quantitative tests.** Sample size depends on the precision you need and the size of difference you want to detect. Work it out with the data team before launching; don't report percentages from a handful of responses.

## Recruiting criteria

Write criteria as behaviours, not demographics: "set up a monthly report in the last 30 days", not "finance professional". Include:

- **Must have:** the behaviour or situation the question is about.
- **Mix:** variety you want across the sample (plan, company size, experience level).
- **Exclude:** employees, people in a study recently, people who know the product team.

## The plan in one table

```
Decision: <what the team will decide, and by when>
What would change it: <the finding that would flip the decision>
Questions: <3–5>
Method: <chosen> because <reason>; not <alternative> because <reason>
Participants: <criteria>, n = <number per segment>, source <recruiting channel>
Consent and incentive: <how>, see participant privacy
Timeline: <recruit / run / synthesise dates>
Deliverable: <synthesis, usability report> to <audience> by <date>
```

## Pitfalls

- Using interviews to answer a "how many" question, then quoting percentages from eight people.
- Running a survey to understand "why"; you get the answers you thought to offer.
- Recruiting whoever is easy (friendly customers, power users) and generalising to everyone.
- A study with no decision attached. It produces a report nobody reads.
