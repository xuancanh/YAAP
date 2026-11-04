---json
{ "title": "Doc types decision guide", "summary": "Decide whether a page should be a tutorial, how-to, reference or explanation, and how to split pages that try to be two.", "tags": ["diataxis", "information-architecture", "audit"], "updated": "2026-11-04",
  "sources": [{ "title": "Diátaxis: a systematic approach to technical documentation", "url": "https://diataxis.fr/" }] }
---

# Doc types decision guide

Most documentation pain comes from pages doing two jobs at once. The four-type model (popularised as Diátaxis) gives each page a single job. Use it to name the problem in an audit and to plan the rewrite.

## The four types

| Type | Reader's situation | The page's job | Sounds like |
|---|---|---|---|
| Tutorial | Learning, new to it | Get them to a working result on one safe path | "In this tutorial you'll build…" |
| How-to guide | Working, knows the basics, has a goal | Steps to reach that goal in the real world | "How to rotate API keys" |
| Reference | Working, needs a fact | Describe the thing precisely and completely | "`timeout` (integer, optional, default 30)" |
| Explanation | Studying, wants to understand | Background, reasons, trade-offs | "Why we use eventual consistency" |

## Quick decision questions

Ask these in order about the page (or the page you're about to write):

1. **Is the reader trying to learn, or trying to get something done?** Learning points to a tutorial or explanation. Doing points to a how-to or reference.
2. **Do they need steps or facts?** Steps mean a tutorial or how-to. Facts mean reference.
3. **Who picks the path?** If you choose everything for them (sample data, defaults), it's a tutorial. If they bring their own situation, it's a how-to.
4. **Would they read it end to end, or jump to one entry?** Jumping means reference.

## Signs a page is mixing types

- A tutorial stops to list every option ("you can also use Postgres, MySQL…"). Move the options to reference and keep one path.
- A how-to opens with three paragraphs of history. Move them to an explanation page and link to it.
- A reference entry includes a long walkthrough. Keep a short example and link to a how-to.
- An explanation page has numbered steps. Those steps belong in a how-to.

## How to split a mixed page

1. Highlight each paragraph with its type.
2. Keep the page as the type most readers arrive for (check search terms or support questions if you have them).
3. Move the rest into the right pages, and leave one-line links where the reader might need them.
4. Check the navigation. Readers should be able to tell a page's type from its title.

## Titles that signal type

- Tutorial: "Get started with…", "Build your first…"
- How-to: "How to…" or a task verb, such as "Migrate from v2"
- Reference: the thing's name, such as "`POST /orders`" or "Configuration options"
- Explanation: "About…", "How X works", "Why…"

## Worked example

An audit finds a 2,000-word "Webhooks" page. It has setup steps, a payload table, a retry policy rationale and a debugging section. Split it like this:

- "Set up your first webhook" (tutorial, using a test endpoint);
- "How to verify webhook signatures" and "How to debug failed deliveries" (how-tos);
- "Webhook events and payloads" (reference);
- "About webhook retries" (explanation).

The audit finding reads: "Webhooks page mixes four types. Split it into five pages, about 2 days of work. The tutorial comes first, because it sits on the first-run journey."

## Common mistakes

- Treating the model as a folder structure that has to be perfect before writing. Use it to improve one page at a time.
- Making every page a tutorial because beginners matter. Experienced readers need fast how-tos and complete reference.
- Leaving out explanation entirely, so the "why" ends up crammed into reference tables.
