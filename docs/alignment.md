# CEO alignment

Some decisions are the CEO's to agree before the company builds on them. In
YAAP the company's agents draft those items, the owning agent decides whether
an item needs the CEO, and the CEO aligns it from a written brief before tasks
are created under it. A fully autonomous company can run every class without
review: alignment is auto-granted or granted by the chief of staff, logged, and
the CEO can review and override it afterwards.

Code: `server/src/org/alignment.ts` (the classes, criteria, tunables and
predicates, all pure), `server/src/org/org-alignment.service.ts` (state, gate,
cards, spot-checks), `server/src/org/org-alignment.tools.ts` (agent tools),
`server/src/org/alignment.controller.ts` (routes),
`src/components/AlignmentView.tsx` (Direction › Alignment). Migration 0095
adds `org_alignments`.

## 1. What needs the CEO

### The research

Founders, boards and operating systems keep a short, consistent list for the
top. Each source below is also cited in the class table in code
(`ALIGNMENT_SOURCES`).

- **Reserved matters in shareholders' agreements.** The usual list:
  - adopting or varying the business plan and budget;
  - a change of business;
  - borrowing, guarantees and contingent liabilities above a threshold;
  - major capital expenditure;
  - acquisitions and disposals;
  - senior hires.

  Practitioners warn against vague, low-threshold lists. They suggest
  consenting only to material deviations from an approved budget, with one
  proposal putting that at 20% of approved spend. ([Treelife](https://treelife.in/legal/reserved-matters-in-sha/))
- **Delegation-of-authority policies.** These keep "organisational strategy
  and policies" and the annual budget at the top. The CEO recommends and the
  board approves, and the approved budget is the source of spending authority.
  ([CNA policy](https://cna.ca/wp-content/uploads/documents/Delegation%20of%20Authority%20Policy.pdf))
- **What only the CEO does.**
  - Fred Wilson: set the vision and strategy, recruit the senior team, keep
    cash in the bank. ([AVC](https://avc.com/2010/09/what-a-ceo-does/))
  - McKinsey: set the direction, align the organisation.
    ([McKinsey](https://www.mckinsey.com/capabilities/strategy-and-corporate-finance/our-insights/everyday-habits-how-ceos-navigate-their-six-core-responsibilities))
  - Ben Horowitz: culture is how a company decides when the leader is absent,
    so the CEO cannot delegate it.
    ([notes](https://www.goodreads.com/notes/44797779-what-you-do-is-who-you-are/82147598-joshua-kroo))
- **One-way and two-way doors.** Amazon's 2015 letter: consequential,
  irreversible (Type 1) decisions deserve slow, senior judgment. Most decisions
  are Type 2 and should be made fast by small groups. Treating Type 2 as Type 1
  causes slowness and risk aversion.
  ([2015](https://www.aboutamazon.com/news/company-news/2015-letter-to-shareholders),
  [2016](https://www.aboutamazon.com/news/company-news/2016-letter-to-shareholders))
- **Exactly one decider.** Bain's RAPID and Atlassian's DACI both name a single
  decider. ([Bain](https://www.bain.com/insights/decisions-who-does-what/))
- **EOS.** The leadership team sets the 1-year plan and the quarter's rocks
  together at the quarterly session.
  ([Ninety](https://www.ninety.io/eos/blog/eos-strategic-planning-7-steps-to-turn-vision-into-traction))
- **Shape Up and SAFe.** Shape Up's betting table belongs to the people who own
  the time. SAFe approves an epic only with a lean business case.
  ([Shape Up](https://basecamp.com/shapeup/2.2-chapter-08), [SAFe](https://framework.scaledagile.com/epic))
- **Our own reports.**
  - `reports/Chief of staff operating model.md`: the CEO keeps the direction
    and "choosing the few company priorities", and the chief owns the system
    around them.
  - `reports/Work tracking for agent companies.md`: autonomy without explicit
    alignment and single ownership degrades, more so for agents.
  - Project Vend: a same-model agent "CEO" approved too much, so the floor must
    hold regardless of the agent's own judgement.

### The classes

The classes are data (`ALIGNMENT_CLASS_DEFS`). Each class carries:
- what it covers, with examples;
- the criteria that usually put an item in it;
- the rationale and its sources;
- the item types it is the default class for;
- a `derive` rule that sets its starting tunables from the profile.

To add a class, add one entry to that list.

| Class | Covers | Default for | Why the CEO keeps it |
|---|---|---|---|
| `direction` | vision, mission, core focus, a new market or segment | vision | setting direction is the CEO's first job; a change of business is a reserved matter |
| `strategy` | where to play and how to win, the strategy memo | strategy memo | DoA policies keep objectives and strategy at the top |
| `okr` | company objectives and key results, the annual plan, the quarter's rocks | objective, key result | the business plan is the most common reserved matter; EOS sets the plan together |
| `projectBet` | a shaped project the company would spend appetite on | project | the betting table; a lean business case. Moving to Now stays the CEO's either way |
| `budget` | spend that is a material share of the envelope, or off the approved plan | — | the approved budget is the source of authority; consent for material deviations |
| `externalCommitment` | contracts, pricing, partnerships, announcements, customer promises | — | contingent liabilities are reserved; what leaves the company is hard to undo |
| `orgDesign` | senior seats, new functions, cross-unit reorganisations | — | recruiting the senior team is not delegated; senior hires are reserved |
| `policy` | values, the constitution, risk posture, brand voice | — | culture is how decisions are made when the CEO is absent |
| `oneWayDoor` | deleting data, a migration with no rollback, shutting a product | — | Type 1 decisions deserve senior judgement |

An item is a goal (vision, objective, key result), a project, or the strategy
memo. Its owner may classify it into any class: a project that changes pricing
is an `externalCommitment`. Large work is a project, never loose tasks (see
`docs/work-tracking.md`), so it is classified as a project.

## 2. Who decides that an item needs the CEO

The owning agent decides, against six criteria (`ALIGNMENT_CRITERIA`). The tool
and the UI show them as questions.

| Criterion | Question | Needs the CEO when |
|---|---|---|
| `reversibility` | can it be undone cheaply? | one-way door |
| `blastRadius` | team, unit, several units, the whole company, outside? | company or external (cross-unit adds to the score) |
| `costShare` | share of the monthly envelope it commits | at or above `alignment.costShare` |
| `externalCommitment` | does it promise anything outside the company? | yes |
| `novelty` | within, an extension of, or new against the aligned strategy? | new (an extension adds to the score) |
| `conflicts` | does it conflict with a charter, the constitution, the values or the strategy? | yes |

`org_classify_alignment` records the call: needs alignment yes or no, the
class, the reasoning, and the answers to the criteria. `assessCriteria` checks
the answers without a model. It refuses "no" in two cases:

- **The floor.** In a supervised company the class has
  `alignment.floor.<class>` = 1. Items in that class always go to the CEO, so
  the agent cannot classify them out.
- **The agent's own criteria say yes.** For example, it said it is an external
  commitment and also that the item does not need the CEO.

When the answer is "no", the item becomes `not_required` and work may start
under it. The CEO sees the item under **Not escalated**, with the reasoning,
and can **pull it in**.

### Spot-checks: under- and over-escalation

`OrgAlignmentService.spotCheck` is model-free. The chief and the auditor read
it with `org_alignment_audit`; the CEO sees the flags on the page.

**Under-escalation** is an item marked `not_required` that shows any of these
signals:
- its class is on the floor here;
- its appetite is at or above `alignment.costShare` of the envelope;
- it serves goals of two or more units;
- its text names an external commitment or a one-way door (pricing, contract,
  launch, delete, migrate, …).

**Over-escalation** is an item the CEO aligned without comment whose own
criteria said nothing needed the CEO.

How a finding is fed back:
- The hourly sweep feeds each new under-escalation back once.
- The CEO's **pull in** feeds back an under-escalation; **didn't need me**
  feeds back an over-escalation.
- Feeding back means a lesson for the owner (`agent_lessons`, source
  `feedback`, cause `decision`; `docs/agent-memory.md` §12), a line to the
  chief, and an audit row. A repeated lesson becomes a guidance proposal
  through the usual learning loop.
- In its monthly `ceo-alignment` playbook step, the chief turns company-wide
  patterns into a floor or a cost-share proposal.

## 3. The states

```
draft ──request──▶ in_alignment ──approve──▶ aligned ──material change──▶ realign ──request──▶ …
  │                     │  └─send back──▶ draft (or realign)          │
  │                     └─reject──▶ rejected                          └─CEO re-open / reject (override)
  └─classified "no"──▶ not_required ──CEO pull in / material change──▶ draft
```

- **Rows.** An item a person writes is aligned by being written (`via` human).
- **An agent's item.** It is a draft unless its class is auto-aligned here.
  When it is, the grant is logged with `via` auto and listed for the CEO's
  review. On the floor it needs no classification; otherwise it waits for
  one.
- **Before the gate.** Items written before the gate have no row and are not
  gated. A row appears with the first *material* agent edit, with the old
  version as the aligned baseline.
- **Material and cosmetic change.** `materialChanges` is pure. A change is
  material when any of these moves beyond its tolerance:
  - the scope (title, description, project brief) changes by more than
    `alignment.tolerance.textShare` of its words;
  - the metric changes;
  - the target or appetite moves by more than
    `alignment.tolerance.targetShare`;
  - a due or target date moves by more than `alignment.tolerance.days`;
  - the item changes parent, kind or the key results it serves.

  Anything else is cosmetic. An agent's material edit to an aligned item
  re-opens it (`realign`) when its class needs review; when its class is auto,
  it is re-granted and logged. A material edit to a `not_required` item asks
  the question again. The CEO's own edit re-baselines.
- **Bundles.** An objective is requested with its key results that are not
  aligned yet (`include_children`, default true). They are aligned together.
- **Cadence.** An aligned item is due again after
  `alignment.cadenceDays.<class>`: quarterly OKR alignment, the strategy twice
  a year, the direction yearly. The hourly sweep tells the owner and the chief
  once. A due item still clears the gate.
- **An expired card** returns the item to draft.

## 4. The flow

1. **The brief.** The owner writes what, why, the options considered
   (including doing nothing), the trade-offs, the success measures, the cost
   and what work it unlocks. `briefGaps` refuses a brief without what, why,
   options and measures.
2. **The request.** `org_request_alignment` goes to whoever aligns this class
   here (`alignerFor`):
   - **The CEO.** An `alignment` decision card. Boundary row `alignment:ceo`
     is `propose`, so the card is reserved for the owner: managers on the
     route recommend but cannot decide. The card reaches the Inbox and Home,
     and its reading pane shows the brief and the owner's reasoning.
   - **The chief.** A task "Align: …" for the chief, decided with
     `org_align` (approve with conditions, send back, reject). Boundary row
     `alignment:delegated` is `alone`. A chief's own request is granted at
     once and logged.
   - **Auto.** Granted at once, logged, listed for the CEO's review.
3. **The discussion.** Each item has a thread. A CEO comment reaches the owner
   (and the chief) as an inbox event. The owner answers with
   `org_alignment_comment`, and the reply also shows on the card. Calling
   `org_request_alignment` again while the card is pending revises the brief
   on it.
4. **The CEO's decision.** The CEO decides in the Inbox or on Direction ›
   Alignment:
   - **approve**;
   - **approve with changes**: the note becomes the item's conditions;
   - **send back** with comments: back to draft, and the owner revises;
   - **reject**;
   - **didn't need me**: cleared, and counted as an over-escalation.

   On items aligned without them, the CEO can also choose **looks right**,
   **add conditions**, **re-open** or **reject**. On items not escalated,
   **pull in**.
5. **Decompose.** On a grant, a send-back or a pull-in, the owner is told and
   the unit's planning run is queued with the reason. Only an aligned item is
   broken down into projects and tasks.

## 5. The gate

`OrgTasksService.setCreateGate` binds `OrgAlignmentService.gate`. It runs on
every task creation and on every task move to another project (`org_link_task`).
It is model-free.

- **Who it binds.** Agents (`chief`, `agent:*`). People are not bound.
- **What a task serves.** The project it lands in, the project's key results
  and objectives, and their ancestors up to the vision. If any of them has a
  row that is not `aligned` or `not_required`, the task is refused. The
  refusal says why and what to do: classify it, request alignment, wait for
  the decision, or tag the task as discovery.
- **Discovery.** A task with `class: discovery`, a "Discovery:" title, or
  "discovery" in its constraints is allowed under an item that is not aligned,
  up to `alignment.discoveryCap` open tasks per item. This is the shaping work
  needed to write the brief.
- **Operating work.** `isAlignmentExempt(task)` is pure and tolerant of fields
  that do not exist yet. It exempts:
  - incidents, escalations and retro actions;
  - tasks in a unit's Operating improvements project;
  - a process step (`source: 'process'` or a `processRunId`) whose process
    category is `operating`. It reads `processCategory`, `process.category`, or
    a `process:operating` tag in the constraints, so the Process engine
    coordinates through this predicate.
- **No bypass through Unsorted.** While any class needs someone's alignment,
  a unit's Unsorted project holds at most `alignment.unsortedCap` open
  agent-created tasks that are not operating work (ops, triage and review are
  not counted). Past the cap, a new one waits as an unassigned backlog
  proposal. Moving it under an unaligned project is refused like creating it
  there.

## 6. Autonomy

| Mode | Who aligns |
|---|---|
| supervised | the CEO, for every class; floor classes always, other classes when the owner classifies them as needing it |
| autonomous | `alignment.required.<class>`: 0 auto (logged), 1 the chief (`org_align`), 2 the CEO |
| off | nobody; the gate is open |

The CEO reviews what was aligned without them on the Alignment page. They see
the badge "Auto-aligned" or "Aligned by the chief" and can choose looks right,
add conditions, re-open or reject. Switching to autonomous with a class on
auto grants pending items of that class the next time work is created under
them, and logs it.

## 7. Tunables

All tunables are per workspace and derived from the profile at onboarding
(`deriveAlignmentTunables`, called by `chief-os.ts`; the starter blueprints are
re-derived by `scripts/derive-starter-tunables.ts`). None is a fixed default.
The boundary makes `alignment.*` a `propose`, non-delegable row: agents never
loosen their own oversight.

- **Per class:**
  - `alignment.floor.<class>` (0/1, supervised);
  - `alignment.required.<class>` (0 auto, 1 the chief, 2 the CEO;
    autonomous).

  A control or rigour culture keeps the CEO on direction and strategy. An
  early, speed-first company auto-aligns more.
- **Shared:**
  - `alignment.costShare` (0.2);
  - `alignment.discoveryCap` (2);
  - `alignment.unsortedCap` (5);
  - `alignment.tolerance.targetShare` (0.1), `.days` (14), `.textShare` (0.5);
  - `alignment.cadenceDays.direction` (365), `.strategy` (180), `.okr` (90),
    `.projectBet` (0, off).

## 8. Planning: alignment first

The planning prompt carries an "Alignment first" section (`planningNotes`):
- who aligns each class;
- the order — direction, then strategy, then OKRs, then align, then decompose;
- the discovery cap;
- the items not aligned yet and those due for re-alignment.

The packs carry the procedure:
- The chief's `ceo-alignment` playbook, with `annual-planning` and
  `quarterly-planning` aligning before building. The quarterly loop runs it
  first.
- Every head's `<function>-okr-planning` playbook has a final "Align before
  you build" step.
- The Program Manager's `program-goals` playbook aligns the bets it owns.

## 9. Tools and routes

| Tool | Who | What |
|---|---|---|
| `org_alignment` | every member | the items and their state, or one item's brief, classification and thread |
| `org_classify_alignment` | owner | needs alignment yes/no, class, reasoning, criteria |
| `org_request_alignment` | owner | the brief to the aligner (card, chief, auto) |
| `org_alignment_comment` | every member | reply on the thread |
| `org_align` | chief | decide a delegated class |
| `org_alignment_audit` | chief, auditor | the escalation spot-check |

Routes, all under `/api/workspaces/:id/org/alignments`:

- `GET /` lists the items.
- `GET /classes` returns the classes, criteria and sources, with who aligns each
  class here.
- `GET /spot-check` returns the escalation findings.
- `GET /:id` returns one item.
- `POST /:id/comment` adds a comment to the thread.
- `POST /:id/decide` takes `approve`, `approve_with_changes`, `send_back`,
  `reject`, `pull_in` or `not_needed`. A pending card is decided through the
  approvals path.

## 10. On screen

**Direction › Alignment** is laid out as follows:

- At the top, **Needs your alignment**: what owners asked of you, and what was
  aligned without you.
- Under it, the **brief** of the selected item:
  - summary, why, options considered, trade-offs, success measures, cost and
    what it unlocks;
  - the key results aligned with it;
  - the owner's classification, with the criteria;
  - any conditions;
  - the **discussion** thread with a comment box;
  - the decision buttons. A note is required for "with changes", "send back"
    and "re-open".
- To the side:
  - **Not escalated**, with the reasoning and the spot-check flag, and a
    **pull in** button;
  - **With the owners**: drafts, send-backs and re-alignments;
  - **Aligned**: the history, with version, who aligned it, when and whether
    conditions applied;
  - **What needs you here**: the classes with who aligns each and whether it
    is on the floor, and the rationale and sources behind "Show why".

Above the cards, four counts (need you, not escalated, with the owners,
aligned) jump to their card. The decision bar stays at the bottom of the
screen while the brief is read; "with changes", "send back" and "re-open"
open a note with their own confirm, and Reject asks once more. "What needs
you here" groups the classes by who aligns them (always yours, yours when the
owner says so, the chief, automatic). With no items at all, one empty state
explains the flow beside the classes.

The Direction overview opens with an **Awaiting your alignment** card, and
objectives and Now projects that are not aligned carry their badge. The Inbox
and Home show the `alignment` card ("Align on the objective: …") with the
brief in the reading pane: what to align on first, then the class, why, the
numbered options and the rest; "Open the brief" goes to the item on this
page for the thread and the other decisions.

## 11. Open edges

- A task cannot itself be an alignment item. Large work is a project, so this
  holds by the work-tracking rule, not by the gate.
- The roadmap's lane order is not an aligned artefact. Each bet is aligned
  one by one, and moving to Now stays the CEO's bet card (`project_bet`).
- Spot-check signals are deliberately simple: keywords, cost share, unit
  count. The auditor's sampled review is the place for judgement.
