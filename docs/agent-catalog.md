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

## Wave 6 — the profession long tail

The shipped catalog covers office knowledge work (the kwp conversions),
four professional additions, and wave 4's business verticals. But most
working people are none of those. Organized by cluster; each pack follows
the established shape (5-6 judgment skills, 0-2 loops, file conventions,
explicit boundaries). Educator (shipped) anchors the education cluster —
the rest of its cluster is untouched.

### Education & academia (around Educator)

| Agent | Emoji | Core skills | Notes / boundaries |
|---|---|---|---|
| **Professor Desk** | 🎓 | syllabus-design, lecture-to-materials, grading-with-rubrics (drafts, never autonomous grades), office-hours-triage, recommendation-letters (the genre's unwritten rules), publication-pipeline | Educator for higher ed: bigger classes, research tension, the rec-letter backlog every professor carries |
| **Academic Researcher** | 🔬 | literature-review (the deep-research skill, citation-disciplined), grant-proposal (aims-page craft), paper-drafting (IMRaD structure), peer-review-response (the point-by-point rebuttal letter), conference-pipeline, collaboration-tracker | grad students through PIs; never fabricates citations — every reference verified via web_search or flagged unverified |
| **Tutor Studio** | 📐 | student-files (progress per tutee), session-plans, parent-updates, scheduling-and-billing (Freelancer's ladder at tutoring scale), diagnostic-assessments | the business side Educator lacks; solo tutors are freelancers with pedagogy |
| **School Leader** | 🏫 | staff-comms, observation-feedback (growth-framed), parent-escalations, timetabling-constraints, policy-drafting, incident-documentation | head teachers / principals; incident docs carry the same initials-only privacy rule as Educator |

### Media & words

| Agent | Emoji | Core skills | Notes / boundaries |
|---|---|---|---|
| **Journalist Desk** | 📰 | pitch-craft, interview-prep (question ladders, on/off-record hygiene), fact-check-protocol (every claim sourced or cut), foia-requests, story-structure (nut graf discipline), source-tracker | source-tracker is confidentiality-critical: roles not names in files unless the user insists |
| **Technical Writer** | 📘 | docs-audit, api-reference-style, tutorial-design (the reader is stuck at step 3), release-notes, style-guide-keeper (Deck & Doc's house-style pattern, docs-flavored), information-architecture | complements Engineer; the profession's craft is empathy for the confused reader |
| **Translator Desk** | 🌐 | glossary-keeper (the terminology memory that makes translations consistent), translation-workflow (segment, draft, revise cold), localization-notes (what doesn't translate and why), client-brief-intake, cat-free-qa (consistency checks over the file set) | human translator's assistant, not a translation engine; rates/invoicing reuse Freelancer patterns |
| **Podcaster** | 🎙️ | episode-pipeline (kanban: idea → recorded → edited → published), guest-booking (outreach + prep packets), show-notes-and-chapters, sponsorship-tracker, repurpose-clips | overlaps Creator Studio but audio-first workflows differ enough to earn the slot |

### Care & community

| Agent | Emoji | Core skills | Notes / boundaries |
|---|---|---|---|
| **Clergy Desk** | ⛪ | sermon-prep (exegesis structure, illustration files), pastoral-care-tracker (visits, follow-ups — strictest confidentiality in the catalog), service-planning, volunteer-rotas, newsletter, occasional-services (weddings/funerals prep) | faith-neutral scaffolding, user's tradition supplies content; care notes are roles-and-initials only |
| **Social Services Desk** | 🤲 | case-notes-structure (objective-language discipline), resource-directory (local services, researched and dated), appointment-coordination, report-drafting, self-care-guard (caseload burnout radar) | admin/organization only — never case judgment, never risk assessment; those are professional decisions |
| **Librarian Desk** | 📚 | collection-development (selection criteria, weeding), program-planning (story time to author nights — Event Planner patterns), reference-interview (the question behind the question), catalog-notes, community-outreach | public + school librarians; reuses event and research patterns heavily |

### Field & facility

| Agent | Emoji | Core skills | Notes / boundaries |
|---|---|---|---|
| **Host Desk (BnB)** | 🛏️ | listing-optimizer, guest-comms (the message sequence: booking → checkin → mid-stay → review ask), turnover-checklist (the cleaner's runbook), seasonal-pricing-research, review-responses, house-manual | short-term rental hosts; turnover loop after each checkout; Landlord Ledger's sibling |
| **Farm & Smallholding** | 🌾 | season-calendar (sowing/harvest by region, loop-driven), field-or-flock-records, input-tracker (feed, seed, fuel costs), market-day-prep, compliance-paperwork-organizer | hobby farms to small commercial; compliance is organize-and-remind, never regulatory advice |
| **Fleet & Logistics** | 🚚 | vehicle-files (Car Keeper × N, service loops), driver-scheduling, route-day-sheets, delivery-exception-log, cost-per-mile-tracker | small courier/trade fleets; the renewals-radar pattern at fleet scale |
| **Interior Designer** | 🛋️ | client-brief-intake (lifestyle before aesthetics), concept-boards (markdown + image files), sourcing-tracker (item, supplier, lead time, budget line), project-schedule (trades sequencing), install-day-runsheet | the trades-sequencing knowledge is the moat; budget patterns from Event Planner |

### Client-practice professionals

| Agent | Emoji | Core skills | Notes / boundaries |
|---|---|---|---|
| **Paralegal Desk** | 📋 | document-organization (matter files, exhibit indexing), deadline-computation (court-rules aware, always attorney-verified), cite-checking, client-intake-summaries, discovery-log | supports a lawyer, never *is* one: everything ships marked "for attorney review"; complements Counsel |
| **Tax Season Desk** | 🧮 | client-document-checklist (per return type), missing-docs-chase (the ladder, tax-season register), workpaper-organization, deadline-radar (filing calendar loop), client-comms | for preparers/bookkeepers — organizes the season, never gives tax positions; Bookkeeper's busy-season sibling |
| **Insurance Agent Desk** | 🛡️ | client-policy-files, renewal-radar (the book of business as loops), coverage-review-prep (questions, not recommendations), claims-support-organizer, referral-tracker | organize and prepare only — coverage recommendations stay with the licensed agent using it |
| **Agency Recruiter** | 🎯 | role-intake (the real spec behind the job ad), candidate-pipeline (kanban per role), boolean-search-craft, screen-notes-structure, client-updates, placement-aftercare | agency-side twin of People Partner's in-house recruiting; candidate notes carry bias-hygiene rules |
| **Executive Coach** | 🧭 | engagement-files (goals, session logs, homework), session-prep (themes from the log), 360-synthesis (patterns from feedback the client shares), progress-reviews, boundary-keeper | coaching ≠ therapy, and the charter says where the line is (persistent distress → licensed professional) |

### Explicitly out of catalog (and why)

- **Clinical anything** (doctor, nurse, pharmacist, physio, therapist
  *content*): agents organize the practice (Practice Admin), never touch
  clinical judgment. No pack will generate clinical content.
- **Licensed financial advisor**: recommendations are regulated;
  Bookkeeper/Money Mate stay on the bookkeeping side of the line.
- **Law practice content**: Counsel and Paralegal Desk prepare *for*
  qualified review; no pack renders legal opinions.
- **Anything whose work product is a safety certification** (structural
  engineer sign-offs, gas certification, aviation): assistance risk
  outweighs value.

Cluster note: the pattern library now covers most of what these need —
client-memory, pipeline-on-kanban, renewals-radar, chase-ladder,
run-sheets, session-logs, roles-not-names privacy. Wave 6 packs are
mostly *recombination plus domain judgment*, which is exactly when a
catalog can scale without dropping quality.

## Business catalog (2026-11)

Status: shipped. The packs above skew personal: they serve one person
running their life or their own practice. A company of agents
(docs/company-vision.md) needs a different shape: a **function** with a
head who runs its process and a few specialists who report to it. The
business catalog is that set, organised by job function, and it is the
set the chief of staff hires from.

**Shape.** Every function has:

- a **Manager / Head** pack (`pack-biz-<fn>-manager`, role `<fn>-manager`,
  tier `strong`, reports to the chief of staff). Its playbooks are the
  function's operating system: `<fn>-okr-planning` (cascade a company
  objective into a unit goal and 2-4 key results with owners, metric
  sources and a recorded forecast), `<fn>-weekly-review` (check-ins,
  at-risk calls, replans), `<fn>-kpi-audit` (sample accepted work and the
  KPI definitions, act on the gaps), `<fn>-report` (the weekly function
  report: RAG with an explicit rule, metrics against target, risks, asks),
  `<fn>-team-management` (four-field briefs with checks, WIP from
  `org_capacity`, reviews, written coaching, hire and pause cases for the
  chief), plus 2-4 process skills for the function's own rituals (pipeline
  review and forecast call, month-end close, sprint planning and retro,
  queue review, hiring pipeline review, access review, ...). Loops carry
  the default cadence.
- 2-4 **specialist** packs (`pack-biz-<fn>-<slug>`, role `<fn>-<slug>`,
  reports to the function manager) with 3-5 practical playbooks each.

**Only real tools.** A function head is a unit lead, not the chief: its
playbooks use the lead's tool set (`org_set_goal`, `org_set_key_result`,
`org_check_in`, `org_create_task`, `org_assign`, `org_review`,
`org_escalate`, `org_unit_report`, `org_signals`, `org_capacity`,
`org_calibration`, `org_metric_read`, `org_set_cadence`,
`org_write_playbook`, `org_propose_experiment`,
`org_propose_metric_source`, `org_forecast_outcome`, `org_message`, ...).
Structure stays with the chief: a head never calls `org_hire_agent`,
`org_pause_agent`, `org_update_member` or `org_report`; it writes the case
(role id, why, cost, alternatives, recommendation, confidence) as a backlog
task for the chief, and CEO-only decisions go through `org_escalate` (offered
to a head in its own loops too, for tasks on its unit's board). Every member
keeps its tasks true outside a task run as well (`org_task_update`,
`org_task_comment`, `org_request_review`), and three built-in skills carry
what every member shares: `org-member-workflow` (status, handoffs between
functions on both sides, blocks, failures, escalation), `org-member-onboarding`
and `org-unit-retro` (docs/autonomous-skills-review.md). The
weekly report is a file in `/org/<fn>/reports/` plus an `org_message`
summary; audit findings go in `/org/<fn>/audits/` (the independent
`org_audit_finding` stays the Auditor's).

**Mechanisms adapt.** No cadence or threshold in these playbooks is fixed.
Every planning, review, audit and report skill starts by reading the
company's vision, goals and operating profile (`org_intent`,
`org_read_goal`) and derives the cadence, rigour, report length and
autonomy from it, writes the result and the profile line that justifies it
to `/org/<fn>/cadence.md`, and applies ritual changes with
`org_set_cadence` (why = the profile line). The skills give a default and
how to flex it ("weekly; twice weekly in a launch push; fortnightly for a
deliberate profile"), never a single number (§1b of the vision).

**Files.** Each function keeps a shared folder `/org/<fn>/` (`okrs/`,
`reports/`, `audits/`, `cadence.md`, `kpis.md`, `team.md` and its own
process artifacts) so heads, specialists, the chief and humans read the
same record; members keep working notes in their own home
(docs/filesystem.md).

**Build.** Packs are `packs/biz-*.md` with `"cat": "Business"` and
`"tail": "business"`; `scripts/build-authored-packs.mjs` appends the
business tail (company member, read the profile first, files under
`/org/`, work through the board, no invented numbers, outward actions are
drafts) instead of the personal one, so personal packs are unchanged. The
market shows them under **Business**, with the function in the role and at
the head of the tagline ("Sales · ...") so search finds them.

**Roles.** `server/src/org/roles/catalog.ts` carries a matching role per
pack (`role:<fn>-<slug>`), with `packId` naming the pack: a role hire keeps
the role's charter, scopes and model tier and installs the pack's
playbooks. Fits tags are function-specific (pipeline, payroll, soc 2, ...)
so the profile ranking still surfaces the generalist roles for a
newsletter or a lab.

### Sales

Folder `/org/sales/` (pipeline, forecast, accounts, proposals, okrs, reports, audits).

| Pack | Role id | Owns (KPIs) | Cadence |
|---|---|---|---|
| Head of Sales | `sales-manager` | bookings / new ARR, pipeline created, coverage, win rate, cycle length, forecast accuracy | pipeline review + weekly review (Mon), forecast call (Thu), report (Fri), deal & KPI audit (monthly), retro (quarter) |
| Account Executive | `sales-account-executive` | bookings, win rate, forecast accuracy, close-plan coverage | forecast submission before each call |
| Sales Development Rep | `sales-sdr` | qualified meetings, pipeline created, lead response time, lead-to-meeting conversion | daily lead triage |
| Sales Engineer | `sales-engineer` | technical win rate, POC success, questionnaire turnaround | per deal |

### Marketing

Folder: `/org/marketing/` (okrs, calendar, channel-review, launches, funnel, content, seo, reports, audits, cadence.md, kpis.md, team.md).

| Pack | Role id | Owns (KPIs) | Cadence |
|---|---|---|---|
| Head of Marketing (`pack-biz-marketing-manager`) | `marketing-manager` | pipeline sourced, SQLs, MQL-to-SQL conversion, CAC / cost per SQL, organic traffic, share of voice | weekly review (Mon), report (Fri), campaign calendar (monthly, 25th), channel and CAC review (monthly), launch readiness per tiered launch, KPI audit (monthly) |
| Content Marketer (`pack-biz-marketing-content`) | `marketing-content` | content-assisted conversions and pipeline, engagement, newsletter open/click rate | per piece; content performance review monthly |
| Demand Gen Marketer (`pack-biz-marketing-demand-gen`) | `marketing-demand-gen` | MQLs, SQLs, pipeline sourced, cost per lead / SQL, CAC by channel | funnel readout weekly (Mon); paid optimisation weekly; lead scoring review monthly |
| Product Marketer (`pack-biz-marketing-product-marketing`) | `marketing-product-marketing` | launch adoption, win rate vs competitors, enablement coverage | per launch; positioning on segment or win-rate change; competitor briefs quarterly |
| SEO Specialist (`pack-biz-marketing-seo`) | `marketing-seo` | organic clicks and conversions, rankings for target queries | keyword map quarterly; technical audit quarterly; rankings report monthly |

### Customer Success & Support

Folder: `/org/customer/` (okrs, queue-review, health, escalations, accounts, onboarding, kb, renewals.md, reports, audits, cadence.md, kpis.md, team.md).

| Pack | Role id | Owns (KPIs) | Cadence |
|---|---|---|---|
| Head of Customer (`pack-biz-cs-manager`) | `cs-manager` | CSAT, first response time, time to resolution, SLA attainment, backlog age, GRR / NRR, churn, health score, onboarding time to value | queue review (daily), weekly review (Mon), report (Fri), health and renewals review (monthly; 90/60/30 days out), escalations per S1/S2, KPI audit (monthly) |
| Customer Success Manager (`pack-biz-cs-csm`) | `cs-csm` | retention of the book, health score, renewal rate, expansion | health check monthly per account; QBRs quarterly; renewal readiness at 90/60/30 days |
| Support Specialist (`pack-biz-cs-support`) | `cs-support` | first response and resolution time, SLA attainment, CSAT, reopen rate | queue sweeps several times a day; KB articles when a question repeats three times |
| Onboarding Specialist (`pack-biz-cs-onboarding`) | `cs-onboarding` | time to value, onboarding completion, first-week usage | per new customer; checklist updated weekly |

### Product

Folder: `/org/product/` (okrs, roadmap.md, specs, discovery, research, launches, feedback, releases, roadmap-comms, metrics, reports, audits, cadence.md, kpis.md, team.md, decisions.md).

| Pack | Role id | Owns (KPIs) | Cadence |
|---|---|---|---|
| Head of Product (`pack-biz-product-manager`) | `product-manager` | activation, retention, feature adoption, NPS, roadmap delivery predictability, discovery throughput | weekly review (Mon), report (Fri), discovery (fortnightly), roadmap review (quarterly + on major evidence), launch review before and 14-30 days after, KPI audit (monthly) |
| Product Owner (`pack-biz-product-owner`) | `product-owner` | backlog readiness (two sprints refined), spec rework rate, accepted stories vs committed | backlog refinement weekly / before sprint planning; acceptance per story |
| User Researcher (`pack-biz-product-user-researcher`) | `product-user-researcher` | studies completed, opportunities validated or killed, customer conversations per week | per study; feeds the fortnightly discovery session |
| Product Operations Specialist (`pack-biz-product-ops`) | `product-ops` | feedback themes triaged, release notes per release, metrics pack on time | feedback triage weekly (Tue); release notes per release; roadmap comms per roadmap review; metrics pack monthly |

### Engineering

Folder: `/org/engineering/` (okrs, sprints, reviews, retros, postmortems, releases, runbooks, reliability, qa, reports, audits).

| Pack | Role id | Owns (KPIs) | Cadence |
|---|---|---|---|
| Head of Engineering (`pack-biz-engineering-manager`) | `engineering-manager` | DORA (deployment frequency, lead time for changes, change failure rate, MTTR), sprint say/do, escaped defects, review turnaround, on-call load | sprint planning at sprint start, weekly review Mon, retro at sprint end, report Fri, postmortem per major incident, release readiness per release, monthly audit |
| Software Engineer (`pack-biz-engineering-software-engineer`) | `engineering-software-engineer` | first-review acceptance, estimate accuracy, regressions introduced | per task; design note before non-trivial work |
| QA Engineer (`pack-biz-engineering-qa`) | `engineering-qa` | escaped defects, regression pass rate, flaky tests, critical-flow coverage | per sprint and per release sign-off |
| Site Reliability Engineer (`pack-biz-engineering-sre`) | `engineering-sre` | SLO attainment, error budget burn, MTTR, actionable-page ratio, out-of-hours pages | daily reliability check, handoff per on-call shift, monthly alert review |

### Design

Folder: `/org/design/` (okrs, requests, crit, system, brand, content, work, research, reviews, reports, audits).

| Pack | Role id | Owns (KPIs) | Cadence |
|---|---|---|---|
| Head of Design (`pack-biz-design-manager`) | `design-manager` | usability task success, WCAG 2.2 AA conformance, design-system adoption, design cycle time, rework rate | intake Mon, crit Wed, weekly review, report Fri, design-system review monthly, monthly audit |
| Product Designer (`pack-biz-design-product-designer`) | `design-product-designer` | task success in usability tests, time on task, handoff completeness | per design task; usability round before handoff |
| Brand Designer (`pack-biz-design-brand`) | `design-brand` | brand consistency of sampled output, asset turnaround, template reuse | per request; monthly consistency review |
| UX Writer (`pack-biz-design-ux-writer`) | `design-ux-writer` | glossary consistency, error-message coverage, content-audit issues closed | per flow; monthly content audit |

### Data & Analytics

Folder: `/org/data/` (okrs, requests, metrics.md, quality, models, sources, queries, answers, dashboards, experiments, forecasts, reports, audits).

| Pack | Role id | Owns (KPIs) | Cadence |
|---|---|---|---|
| Head of Data (`pack-biz-data-manager`) | `data-manager` | request turnaround, freshness SLA met, data test pass rate, dashboard adoption, metric definition coverage (key results with an approved source) | request intake Mon, daily quality check, weekly review, report Fri, monthly audit and metric governance |
| BI Analyst (`pack-biz-data-bi-analyst`) | `data-bi-analyst` | request turnaround, dashboard usage, answers reproducible on re-run | per request; KPI packs weekly or monthly on request |
| Analytics Engineer (`pack-biz-data-analytics-engineer`) | `data-analytics-engineer` | freshness SLA met, test pass rate, pipeline incidents | weekly test and freshness review; on every failure |
| Data Scientist (`pack-biz-data-scientist`) | `data-scientist` | experiments read out validly, forecast calibration | per experiment window; forecasts per planning cycle |

### Finance

Folder: `/org/finance/` (okrs, close, bva, cash, forecast, reports, audits, cadence.md, kpis.md, team.md).

| Pack | Role id | Owns (KPIs) | Cadence |
|---|---|---|---|
| Head of Finance (`pack-biz-finance-manager`) | `finance-manager` | days to close, forecast accuracy, DSO, DPO, net burn and runway, budget variance, reconciliation exceptions, agent cost per accepted task | weekly review (Mon), weekly cash review (Wed), weekly report (Fri), close kickoff WD1, BvA after close, monthly KPI audit, quarterly reforecast |
| Staff Accountant (`pack-biz-finance-accountant`) | `finance-accountant` | close tasks on time, reconciliations tied, exceptions aged, payables matched | close calendar (WD1-WD5), payment-run prep |
| FP&A Analyst (`pack-biz-finance-fpa`) | `finance-fpa` | forecast accuracy, variance explained, scenario turnaround | monthly reforecast and variance commentary, quarterly unit economics |
| Billing Specialist (`pack-biz-finance-billing`) | `finance-billing` | DSO, AR over 60 days, invoice right-first-time | invoice run per billing date, weekly collections (Tue), monthly accuracy check |

### People / HR

Folder: `/org/people/` (okrs, hiring, performance, engagement, lifecycle, reports, audits, cadence.md, kpis.md, team.md). Personal details stay in the HR system the company grants; workspace files carry roles, counts and ids.

| Pack | Role id | Owns (KPIs) | Cadence |
|---|---|---|---|
| Head of People (`pack-biz-people-manager`) | `people-manager` | time to hire, offer acceptance, stage conversion, quality of hire, regretted attrition, eNPS/engagement, onboarding completion | hiring pipeline review + weekly review (Mon), weekly report (Fri), monthly KPI audit, quarterly engagement review, performance cycle twice yearly |
| Recruiter (`pack-biz-people-recruiter`) | `people-recruiter` | time to hire, candidate response time, stage conversion, offer acceptance | per requisition: intake, screening as applications arrive, interview loops |
| People Ops Specialist (`pack-biz-people-ops`) | `people-ops` | onboarding completion, request time to answer, payroll inputs on time | weekly starters/leavers check (Mon), payroll cut-off |
| Learning & Development Partner (`pack-biz-people-learning`) | `people-learning` | training completion, mandatory training on time, applied-skill signals | gap analysis per cycle, monthly mandatory-training tracking |

### Legal

Folder: `/org/legal/` (okrs, matters.md, playbook.md, contracts, obligations.md, risk-register.md, privacy, regulatory-calendar.md, reports, audits, cadence.md, kpis.md, team.md). Drafts for human review; never signs or files.

| Pack | Role id | Owns (KPIs) | Cadence |
|---|---|---|---|
| General Counsel (`pack-biz-legal-manager`) | `legal-manager` | contract turnaround, matters open and aged, playbook conformance, regulatory deadlines met, risk register coverage | daily intake triage, weekly review (Mon), weekly report (Fri), monthly KPI audit, quarterly risk register and playbook review |
| Contracts Specialist (`pack-biz-legal-contracts`) | `legal-contracts` | turnaround (days with legal), deviations flagged, obligations captured | per request against service targets |
| Privacy & Compliance Officer (`pack-biz-legal-compliance`) | `legal-compliance` | DSRs within deadline, regulatory deadlines met, records of processing current | weekly regulatory calendar (Mon), quarterly records review, PIA before launches |

### Operations

Folder: `/org/operations/` (processes.md, sops/, improvements.md, vendors.md, programs/, okrs/, reports/, audits/, cadence.md).

| Pack | Role id | Owns (KPIs) | Cadence |
|---|---|---|---|
| Head of Operations (`pack-biz-ops-manager`) | `ops-manager` | process cycle time, SLA adherence, cost per unit, SOP coverage, automation rate, vendor spend vs budget | weekly review (Mon), weekly report (Fri), monthly KPI audit + process review, quarterly vendor review and QBR |
| Business Process Analyst (`pack-biz-ops-process-analyst`) | `ops-process-analyst` | cycle time, first-pass yield, automation rate, SOP coverage | on task; maps and SOPs on review interval |
| Procurement Specialist (`pack-biz-ops-procurement`) | `ops-procurement` | vendor spend vs budget, renewals decided before notice, seat utilisation | monthly renewals scan |
| Program Coordinator (`pack-biz-ops-program-coordinator`) | `ops-program-coordinator` | milestones on time, RAID items owned | weekly program status (Thu) |

### IT & Security

Folder: `/org/it-security/` (systems.md, assets.md, controls.md, evidence/, policies/, vulns/, access-reviews/, incidents/, okrs/, reports/, audits/, cadence.md).

| Pack | Role id | Owns (KPIs) | Cadence |
|---|---|---|---|
| Head of IT & Security (`pack-biz-it-security-manager`) | `it-security-manager` | patch compliance, MTTR by severity, MFA coverage, access review completion, ticket SLA, phishing failure rate, control pass rate | weekly vulnerability + unit review (Mon), weekly report (Fri), monthly control audit, quarterly access review; incidents on demand |
| IT Administrator (`pack-biz-it-security-it-admin`) | `it-security-it-admin` | ticket SLA, patch compliance, MFA coverage, leaver removal time | daily ticket triage |
| Security Analyst (`pack-biz-it-security-analyst`) | `it-security-analyst` | remediation within SLA, alert false-positive rate, phishing failure rate | weekly vulnerability triage, quarterly phishing test |
| GRC Specialist (`pack-biz-it-security-grc`) | `it-security-grc` | control test pass rate, evidence on time, vendor reviews current | monthly evidence collection, yearly policy review |

### Revenue Operations

Folder: `/org/revops/` (funnel.md, forecast-method.md, forecast/, changes/, routing.md, deal-desk/, analytics/, plans/, okrs/, reports/, audits/, cadence.md).

| Pack | Role id | Owns (KPIs) | Cadence |
|---|---|---|---|
| Head of Revenue Operations (`pack-biz-revops-manager`) | `revops-manager` | forecast accuracy, CRM completeness, funnel conversion and velocity, lead routing time, quota attainment distribution, NRR attribution coverage | funnel review (Mon), forecast governance (Wed, before the sales call), weekly report (Fri), monthly data/KPI audit, annual/quarterly territory and quota plan |
| CRM Administrator (`pack-biz-revops-crm-admin`) | `revops-crm-admin` | CRM completeness, lead routing time, changes released without rollback | weekly hygiene sweep (Mon) |
| Deal Desk Analyst (`pack-biz-revops-deal-desk`) | `revops-deal-desk` | quote turnaround, effective discount, exception rate | per quote; monthly discount analysis |
| Revenue Analyst (`pack-biz-revops-analyst`) | `revops-analyst` | forecast model error, attribution coverage, GRR/NRR by cohort | weekly pipeline analytics, monthly attribution and cohorts |

## Category taxonomy (2026-07 rework)

"Business" had swollen to 37 of 71 packs, which makes a filter useless. The
catalog now uses thirteen categories sized 4-8, professional first then
personal, in the canonical rail order (CAT_ORDER in MarketView.tsx):

- **Workplace** — the office suite: EA, Ops, People, Support, Research
  Desk, Marketer, Sales, Deck & Doc Studio.
- **Product & Engineering** — Engineer, Data Analyst, Product Manager,
  Design Partner.
- **Education** — Educator, Professor Desk, School Leader, Academic
  Researcher, Tutor Studio, Course Creator.
- **Legal & Finance** — Counsel, Paralegal, Tax Season, Bookkeeper,
  Insurance Agent.
- **Writing & Media** — Journalist, Technical Writer, Translator,
  Podcaster, Creator Studio.
- **Care & Community** — Clergy, Social Services, Librarian, Nonprofit,
  Practice Admin.
- **Property & Field** — Realtor, Landlord, Host, Interior Designer,
  Trades Contractor, Farm, Fleet.
- **Small Business** — Shopkeeper, Ecommerce, Restaurant, Freelancer,
  Agency Recruiter, Executive Coach (running your own shop or practice).
- **Family & Care** — Family Organizer, Pet Companion, New Parent, Elder
  Care.
- **Home & Money** — Home & Garden, Meal Planner, Car Keeper, Moving,
  Life Admin, Money Mate.
- **Health & Growth** — Fitness, Wellness, Study Buddy, Language Buddy,
  Job Hunt.
- **Events & Travel** — Trip, Event, Wedding, Gift Concierge.
- **Hobbies & Leisure** — Reading Club, Creative Muse, Game Master,
  Collector's Vault, Genealogy, Wardrobe Stylist.

- **Business** — the company catalog: the Auditor and the business set
  (a head and 2-4 specialists per job function, see "Business catalog"
  above). The function sits in the role and the tagline, not in a separate
  category, so the rail stays one chip.

Assignment rule when a pack straddles: the buyer's identity wins over the
task ("Technical Writer" is a writing profession, not engineering; "Course
Creator" sells education, not media). New packs pick from this list; a new
category needs at least three packs to earn a rail chip.
