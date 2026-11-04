---json
{ "title": "Boolean search reference", "summary": "Boolean operators, search-string patterns, a title-synonym map and a yield log for sourcing candidates who aren't applying.", "tags": ["sourcing", "boolean", "search", "x-ray"], "updated": "2026-11-04" }
---

# Boolean search reference

A good search is built from parts you can reuse: a title block, a skills block, an exclusion block and a location block. Log every string with its yield so the next search for that role family starts ahead.

## Operators

| Operator | Meaning | Example |
|---|---|---|
| `AND` | both terms | `python AND django` |
| `OR` | either term | `(developer OR engineer)` |
| `NOT` or `-` | exclude | `NOT recruiter` / `-recruiter` |
| `" "` | exact phrase | `"product manager"` |
| `( )` | group | `("data engineer" OR "analytics engineer")` |
| `*` | wildcard (where supported) | `engineer*` |
| `site:` | limit to a domain (web search) | `site:github.io` |
| `intitle:` | word in page title (web search) | `intitle:resume` |

Support varies. Each platform has its own grammar, field limits and maximum string length, and they change. Test a small string first and check the platform's help pages.

## The block pattern

```
(TITLE BLOCK) AND (SKILLS BLOCK) AND (LOCATION BLOCK) NOT (EXCLUSIONS)
```

Example for a mid-level payments backend engineer:

```
("backend engineer" OR "software engineer" OR "platform engineer" OR "API developer")
AND (payments OR fintech OR "card processing" OR PCI)
AND (java OR kotlin OR go)
NOT (recruiter OR intern OR "talent acquisition")
```

Then add location with the platform's filter rather than in the string, where possible.

## Title-synonym map

The same job goes by different names across company sizes, sectors and regions. Build one map per role family and keep it in sourcing notes.

| Role family | Titles to include |
|---|---|
| Customer success | customer success manager, account manager, client success, customer experience manager, relationship manager |
| Finance controller | financial controller, finance manager, head of accounting, accounting manager |
| Product design | product designer, UX designer, UI/UX designer, interaction designer |

Add the giveaway signals too: tools, certifications, community names and phrases only practitioners use.

## X-ray searching

Searching public profiles or portfolios through a general search engine:

```
site:github.com "location: lisbon" (rust OR go)
intitle:portfolio "motion designer" (after effects) -jobs
```

Respect each site's terms of use and the candidate's privacy. Use public information to make a relevant approach, not to build a dossier. Data protection law (for example GDPR in the EU and UK) applies to candidate data you collect, even from public sources; follow your agency's policy on what you may store and for how long.

## Yield log

```
Date | Role | Platform | String id | Results | Relevant (first 50) | Replies | Notes
2026-11-04 | payments-be | web x-ray | PB-03 | 412 | 9 | — | add "acquiring"; drop PCI (noise)
```

"Relevant in the first 50" is a quick quality score you can compare across strings.

## Common mistakes

- **Too narrow too early.** Ten ANDs return the same twelve people everyone else is messaging. Start broad, narrow with filters.
- **Forgetting regional titles.** The same job is named differently across regions.
- **Unbalanced brackets** silently break the logic. Count them.
- **Excluding by keyword you need.** `NOT manager` drops "engineering manager" and also "manager of payment integrations".
- **Searching only one channel.** Your own database and silver-medalists come first, then referrals, communities and events.
- **Not logging.** A string that worked once is lost if it lives only in a browser tab.
