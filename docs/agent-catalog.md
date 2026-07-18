# Agent catalog: professional and casual packs

Status: design. Follow-up to the 13 profession packs shipped from
anthropics/knowledge-work-plugins. Sources studied:

- **anthropics/skills** — Anthropic's own skill showcase. Not professions:
  *craft* skills — document creation (docx/pdf/pptx/xlsx, the ones powering
  claude.ai file creation), design (canvas-design, frontend-design,
  theme-factory, algorithmic-art), builders (skill-creator, mcp-builder,
  webapp-testing), comms (internal-comms, brand-guidelines). Two lessons:
  craft skills are **horizontal** (every agent wants "make me a deck", so
  they belong in the shared/global skill pool, not inside one agent), and
  the heavyweight ones lean on bundled Python scripts we cannot run — so
  they are *inspiration for our own file-free variants*, not direct
  conversions. (Licensing also splits: much is Apache-2.0, but the
  docx/pdf/pptx/xlsx set is source-available, not open source — do not
  bundle those bodies verbatim.)
- **knowledge-work-plugins** — already converted; the professional backbone.
- **Community collections** (ComposioHQ / BehiSecc / travisvn
  awesome-claude-skills, claudemarketplaces.com, OpenPaw): overwhelmingly
  developer- and business-skewed. One major list contains *zero* personal
  lifestyle skills. What little exists and is popular: travel planners
  (several, consistently popular), daily briefing, wellness tracking,
  invoice/tax organizing, file organization.

**The strategic read:** the ecosystem serves developers writing code, then
knowledge workers, and has left casual users almost entirely unserved —
precisely the audience our product is built for. And the casual use cases
are the ones our platform differentiates on: they are *ongoing* (loops beat
one-shot chats), *stateful* (kanban, brain files, storage-backed mini apps),
and *ambient* (Telegram check-ins). A trip is a project; a wedding is a
kanban board; a budget is a dashboard app. Nobody else ships that shape.

## 1. Professional packs (shipped + additions)

Shipped: Marketer, Sales Partner, Support Desk, Bookkeeper, Counsel, People
Partner, Ops Manager, Shopkeeper, Product Manager, Design Partner, Data
Analyst, Engineer, Research Desk.

Additions worth building:

| Agent | Emoji | What it does | Why it earns a slot |
|---|---|---|---|
| **Deck & Doc Studio** | 🎬 | Slide decks, polished docs, one-pagers, reports: outline → draft → themed HTML/markdown deliverables in the working folder; consistent voice and theming per user | The anthropics/skills doc+design cluster, reimagined without script dependencies; every other agent can delegate to it |
| **Executive Assistant** | 🗓️ | Daily briefing loop, meeting prep and debriefs, follow-up tracking, travel logistics, inbox-triage playbooks | The OpenPaw pattern (their most popular bundle) done properly with loops + Telegram |
| **Freelancer Desk** | 🧾 | Proposals, scope docs, invoice tracking and chasing, client CRM-in-files, rate math, portfolio copy | Solo professionals; complements Shopkeeper (which assumes a business with staff) |
| **Educator** | 🧑‍🏫 | Lesson plans, rubrics, quiz generation, differentiated materials, parent comms | Teachers are a huge underserved knowledge-work segment |

## 2. Casual packs (the gap in the market)

Ordered by expected pull; the first five are the launch wave. Every pack
lists the platform features that make it more than a chat prompt.

### Launch wave

| Agent | Emoji | Skills (write ourselves) | Loops | Mini apps (bridge caps) |
|---|---|---|---|---|
| **Trip Planner** | 🧳 | destination-research, itinerary-builder, budget-breakdown, packing-list, booking-tracker, local-culture-brief | pre-trip countdown check (docs, weather, reservations) | itinerary viewer (`files.read`), packing checklist (`storage`) |
| **Event Planner** | 🎉 | event-concept, guest-list, venue-vendor-tracker, budget-tracker, timeline-runsheet, invitation-drafts, day-of-checklist | weekly status sweep until event date | RSVP tracker (`storage`, `tasks.write`), countdown + run-sheet (`files.read`) |
| **Life Admin** | 🗂️ | daily-briefing, renewals-tracker (passport, insurance, subscriptions), paperwork-filing, errand-batching, appointment-prep | morning briefing; monthly renewals scan | renewals dashboard (`storage`, `agent.ask`) |
| **Money Mate** | 💸 | budget-setup, spending-review, subscription-audit, bill-calendar, savings-goals, big-purchase-research. *Hard rule in charter: never investment advice* | monthly budget review; bill-due reminders | budget dashboard (`storage`, `files.read`) |
| **Meal Planner** | 🍳 | weekly-menu, recipe-scaling, pantry-inventory, grocery-list, leftovers-remix, dietary-adaptation | Sunday menu + grocery list | grocery checklist (`storage`, `chat.compose`) |

### Second wave

| Agent | Emoji | Core skills | Platform hooks |
|---|---|---|---|
| **Study Buddy** | 📚 | study-plan, explain-concept, practice-quiz, spaced-repetition, exam-countdown | flashcards app is the killer `storage` demo; revision loops |
| **Job Hunt Coach** | 🧑‍🎓 | resume-tailoring, application-tracker, interview-prep, offer-comparison, follow-up-drafts | the kanban *is* the application pipeline; bridges casual→professional |
| **Family Organizer** | 🏠 | family-calendar, chores-rota, school-admin, gift-tracker, occasion-reminders | shared workspace folder = the family surface; birthday loops |
| **Fitness Coach** | 💪 | training-plan, progression-tracking, form-cues, deload-planning. *Charter: not medical advice; suggest professionals for pain/injury* | workout logger app (`storage`); weekly plan loop |
| **Wellness Companion** | 🌱 | daily-checkin, journaling-prompts, sleep-hygiene, habit-design. *Same medical disclaimer, plus crisis-resources guidance* | evening check-in loop via Telegram is the product moment |

### Third wave

| Agent | Emoji | Notes |
|---|---|---|
| **Home & Garden** | 🔧 | renovation projects on the kanban; seasonal maintenance loops; plant-care watering schedule |
| **Pet Companion** | 🐾 | vet/vaccine schedule loops, training plans, weight tracking app |
| **Reading Club** | 📖 | reading list tracker app, per-book discussion questions, spoiler-safe summaries |
| **Creative Muse** | 🎨 | writing-project coach (drafts live in the working folder), practice-plan for instruments/art, prompt generators — the consumer end of anthropics/skills' creative cluster |
| **Gift Concierge** | 🎁 | remembers people + occasions in brain files, loop-reminds ahead, researches ideas within budget (could fold into Family Organizer if the catalog needs pruning) |

## 3. Cross-cutting decisions

- **Craft skills go global, not per-agent.** "Write a doc", "build a deck",
  "make a comparison spreadsheet (as markdown/CSV)", "style it nicely" —
  ship these as shared workspace skills every agent can invoke, modeled on
  anthropics/skills but rewritten file-free. Profession/casual packs then
  stay about *domain judgment*, not formatting.
- **Casual packs are written by us**, not converted: the community has
  nothing worth converting (that is the opportunity), and the popular
  loners (travel planner) are single skills, not agent-shaped bundles.
  Skill bodies follow the knowledge-work format: trigger, inputs,
  step-by-step playbook, graceful degradation when data is missing.
- **Same three-gate posture.** Casual packs ship 0–2 review-visible loops;
  mini apps request minimal caps (`storage` mostly — note it needs no
  review). Health- and money-adjacent charters carry explicit "not
  medical/financial advice" lines, mirroring how Counsel disclaims legal
  advice today.
- **Market presentation.** Add `Life` and `Home` categories beside the
  professional four; casual cards lead with outcomes ("your trips, planned
  and remembered"), not skill counts.
- **Sequencing.** 1) global craft skills, 2) launch-wave casual packs
  (Trip, Event, Life Admin, Money, Meal) since they exercise loops + apps +
  Telegram hardest, 3) additions to professional row (Studio, EA), 4)
  waves 2–3 by observed pull.
