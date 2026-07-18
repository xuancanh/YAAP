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

---

# Expansion brainstorm (waves 4-5)

Second research pass (July 2026), after shipping all 19 authored packs.
Checked: claudemarketplaces.com and tonsofskills.com (the two biggest
directories — 8,870+ and 2,810 skills respectively), the ComposioHQ /
BehiSecc awesome lists again, and the consumer-AI-agent trade press. Two
confirmations worth building on:

1. **No vertical small-business packs exist anywhere.** The largest
   marketplace's 470 plugins across 19 categories contain *no dedicated
   real-estate, legal-practice, medical-practice, restaurant, or ecommerce
   vertical* — the "business" category is generic frameworks and SaaS API
   integrations. Small business owners who live in a trade, not in a SaaS
   stack, are unserved.
2. **Consumer trust research points at our architecture.** Surveys show
   consumers rank data privacy first, "easily turn the agent off" second,
   and human approval before actions third — which is literally the
   three-gate model plus per-agent revocation we already ship. The casual
   market wants what we built.

## Wave 4 — business verticals (owners of trades, not desks)

The Shopkeeper pattern (assume no enterprise stack, work from files and
chat) applied to specific verticals. Each earns its slot by having domain
judgment generic packs lack.

| Agent | Emoji | Core skills | Platform hooks / notes |
|---|---|---|---|
| **Realtor Desk** | 🏡 | listing-description (fair-housing-aware wording), comp-research, open-house-plan, buyer/seller-pipeline, neighborhood-brief, closing-checklist | pipeline on the kanban; listing-status loop; boundary: no legal/appraisal advice |
| **Landlord Ledger** | 🔑 | tenant-comms (firm-but-fair drafts), maintenance-triage (reuses Home & Garden's repair judgment), lease-renewal-radar, rent-ledger, deposit-rules-research (jurisdiction-aware, lawyer-boundary), turnover-checklist | renewal + inspection loops are the product; rent ledger app (`storage`) |
| **Restaurant Ops** | 🍽️ | menu-engineering (stars/dogs matrix), food-cost-math, shift-rota, supplier-tracker, review-responses (the 1-star reply craft), specials-promo | weekly food-cost review loop; rota is printable like the chores rota |
| **Ecommerce Seller** | 🛍️ | listing-optimizer (title/keywords/photos brief), review-management, reorder-points, ad-copy-variants, returns-policy, season-planning | reorder-alert loop; sales-dashboard app (`files.read`); marketplace-agnostic (Etsy/Amazon/Shopify) |
| **Nonprofit Organizer** | 🤝 | grant-research, grant-application-draft, donor-stewardship (thank-yous within 48h — the retention lever), volunteer-coordination, board-report, fundraising-event (delegates to Event Planner patterns) | grant-deadline radar loop; donor memory = client-memory pattern with a mission |
| **Practice Admin** | 🩺 | intake-forms, recall-reminders, schedule-templates, no-show-policy, patient-comms-drafts (admin register only) | strictly the *admin* side of a clinic/therapy/dental practice; hard charter: never clinical content, never diagnosis-adjacent wording, records stay generic |
| **Creator Studio** | 📹 | content-calendar, hook-and-script, sponsorship-rate-card, brand-deal-pipeline, analytics-review (from exported CSVs), repurpose-matrix (one idea → five formats) | deal pipeline on kanban; posting-cadence loop; the freelancer-desk economics applied to audience businesses |
| **Course Creator** | 🎓 | curriculum-design (backwards from learner outcomes — Educator's spine, commercial framing), cohort-ops, launch-sequence, testimonial-harvest, pricing-tiers | launch-countdown loop; overlaps Educator + Marketer, distinct buyer |
| **Trades Contractor** | 🛠️ | quote-builder (materials + labor + margin honestly), job-cards, materials-list, callback-list, invoice-chase (Freelancer's ladder, blue-collar register) | jobs on the kanban; weekly WIP review loop; the invoice-chase reuse proves the pattern library |

Fold-ins considered and rejected: Agency Lead (Freelancer Desk at team
scale — wait for demand), Church/Community Group (Nonprofit covers it),
generic "Consultant" (Deck & Doc Studio + Freelancer already compose it).

## Wave 5 — casual expansion

| Agent | Emoji | Core skills | Platform hooks / notes |
|---|---|---|---|
| **Wedding Planner** | 💍 | twelve-month-timeline, vendor-contracts-tracker, guest-and-seating (the politics engine — who cannot sit with whom), wedding-budget (the categories nobody expects), registry-and-thanks, day-of-coordination | Event Planner's big sibling — wedding scale justifies its own pack; RSVP + seating apps; countdown loop |
| **Moving Concierge** | 📦 | moving-timeline (T-8-weeks protocol), address-change-checklist (the killer artifact: every institution that needs telling), utilities-switchover, packing-inventory (box-number app, `storage`), new-area-brief, moving-day-runsheet | one of life's highest-stress projects, perfectly kanban-shaped, zero ecosystem coverage |
| **New Parent Copilot** | 🍼 | registry-research, feeding-sleep-log (pattern surfacing, never interpretation), appointment-tracker, milestone-memory (the baby book that writes itself), village-coordination (visitor scheduling, meal trains), back-to-work-transition | strictest medical boundary of any pack: logs and logistics yes, "is this normal" always → pediatrician; crisis-resources for postpartum struggles |
| **Car Keeper** | 🚗 | service-schedule (manufacturer-interval loops), service-history-log, running-cost-tracker, buy-sell-research (total-cost honesty from Money Mate's big-purchase pattern), insurance-renewal-radar, trip-readiness-check | the renewals-radar pattern applied to the second-biggest asset; boundary: no repairs-beyond-triage (garage referral) |
| **Genealogy Researcher** | 🌳 | research-log (the genealogist's discipline: sources or it didn't happen), archive-strategy (which records exist where, per country/era), elder-interview-kit (the questions to ask while you still can), tree-files (GEDCOM-friendly markdown), photo-dating, brick-wall-tactics | deep-research skill's natural consumer; retirees are an underserved, loyal segment |
| **Language Buddy** | 🗣️ | conversation-partner (graded to level, corrections after not during), vocab-deck (Study Buddy's spaced repetition, language-tuned), grammar-explainer, media-immersion-plan (shows/podcasts at level), exam-prep (CEFR/JLPT aware) | daily-practice loop + Telegram = the Duolingo-that-converses; flashcards app reuse |
| **Game Master** | 🎲 | campaign-bible (world/NPC/faction files), session-prep (strong-start + situations-not-plots), npc-generator, encounter-balance, session-recap (the memory between sessions), player-handouts | huge hobby community; the brain files ARE the campaign bible; recap loop after session night |
| **Collector's Vault** | 🗃️ | collection-catalog (condition-graded inventory), valuation-research (recent-sales-based, dated, no investment framing), want-list-radar, trade-evaluator, insurance-documentation | cards/vinyl/stamps/watches; catalog app (`storage`); boundary: valuations are research snapshots, not appraisals or investment advice |
| **Wardrobe Stylist** | 👗 | closet-inventory, capsule-builder, outfit-planner (weather + calendar aware), gap-analysis (buy less, better), occasion-dressing | pairs with Trip Planner's packing and Money Mate's purchase research |
| **Elder Care Coordinator** | 🧓 | care-team-directory, appointment-coordination (multi-provider calendars), medication-schedule-tracker (schedule fidelity only — never dosage advice), sibling-sync (the family update that prevents feuds), care-documents-organizer, transition-research (home care vs facilities, cost structures) | emotionally heaviest pack — warm register, hard medical/legal boundaries, respite-care and caregiver-burnout resources built in |

Considered and parked: Fantasy Sports Manager (analysis-only is doable but
gambling-adjacent framing risk outweighs pull for now), Digital Declutter
(thin — folds into Life Admin), Sustainability Coach (no differentiated
playbook yet), Dating Profile Coach (reputational risk profile unclear).

## Sequencing update

Wave 4 and 5 are demand-gated: ship 2-3 packs per release, ordered by
observed Market pull once real usage data exists. Standing exceptions worth
jumping the queue: **Moving Concierge** and **Wedding Planner** (life
events with deadlines convert), and **Landlord Ledger** (loops + ledger
demonstrate the platform hardest). The pattern-library effect is now real:
new packs increasingly compose existing playbook shapes (invoice-chase,
renewals-radar, client-memory, spaced repetition, run sheets) — each new
pack costs less than the last.
