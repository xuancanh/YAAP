# Evidence-gated claims

*Status: shipped, 8 November 2026. Implements "Evidence-gated claims" of
`reports/Process abstractions for agent companies.md` on the write path of
shared company state. It complements [quality control](quality.md), which
gates review submissions, and the after-the-fact
[reconciliation](experiments.md) sweep.*

Agents state progress and facts that nothing checks, and other agents build
on them. In AI Village an invented 93-person contact list was accepted by
other agents and cost more than eight hours; in Project Vend an agent
invented a payment account. A person's fabrication spreads slowly and gets
checked socially. An agent's becomes shared belief within hours. So a claim
written into shared state now carries its evidence, the platform checks
that evidence without a model, and readers are told what nobody verified.

Code: `server/src/org/claims-model.ts` (pure: the classes, the claim
detector, the count grammar, the verdict, the remediation),
`server/src/org/org-claims.service.ts` (the gate, provenance, the
fabrication response, readers), `server/src/org/claims-tunables.ts`,
`server/src/org/claims.controller.ts` (HTTP). The references are verified
by the quality verifier, `OrgQualityService.verifyEvidence`; there is one
verifier, not two. Migration `0098-claims`.

## 1. Claim classes

A class is data (`CLAIM_CLASSES`). It says which writes carry a claim, what
evidence counts, which tunable sets its strictness and what "does not count"
means for it.

| Class | Written by | Carries a claim when | Evidence that counts | Until verified |
|---|---|---|---|---|
| `kr_checkin` | `org_check_in` | the value changes | file, url, tool, action, check | the key result keeps its last verified value; pace and progress ignore the claimed one |
| `project_update` | `org_project_update` | its reason or narrative states a fact | any | the update is flagged where it is shown and read |
| `task_update` | `org_task_update` note, `org_task_comment` | "done / sent / published / shipped / contacted N", a factual number | any | the note is flagged on the timeline and in `org_task` |
| `decision` | `meeting_propose_decision` | the decision or rationale states an external fact | file, url, tool, action, task | the decision is logged flagged |
| `step_output` | `org_step_output` | always (later steps build on it) | any | later steps see it flagged on their step card |
| `lesson` | `meeting_propose_lesson` with audience unit or company | it states a fact | file, url, task, action | the lesson keeps an "(unverified)" prefix wherever it travels |

A member lesson is the author's own scratch and is not gated. Metric values
are not an agent write at all: a key result bound to a metric source takes
its value only from the source, and `manual_attested` sources take a
person's attestation ([sensing](sensing.md)).

**Detection** is a conservative string match (`factualSentences`). It looks
for a completion or contact verb, or a number that states a fact (money, a
percent, or a count of customers, emails, tasks and the like). A sentence
phrased as a plan ("will", "next week", "plan to") is not a claim. A write
that cites evidence is checked even when the detector finds nothing.

## 2. On write

The tool passes `evidence: ["file:/org/…", "action:<id>", "tool:web_fetch",
"url:https://…", "check:2", "task:ENG-12"]`. The grammar and the checks are
those of [quality.md §2](quality.md). Tool calls, fetches and actions count
from the task's creation, or within `claims.evidenceWindowDays` when the
claim is not tied to a task.

**Counts the record can answer** are cross-checked even when nothing is
cited (`countClaims`):

| Phrase | Measured as |
|---|---|
| "sent / emailed / contacted / messaged / published / posted N", "N emails sent" | the author's succeeded outward actions (external classes) in the window, one per named recipient |
| "completed / closed / shipped N tasks", "N tasks done" | tasks the author finished in the window |
| "ran / made / took N actions / tool calls" | the author's succeeded actions |

A claimed count more than `claims.countTolerancePct` above the record is a
**mismatch**. A count the record confirms is evidence in its own right.

**The verdict** (`claimStatus`) is one of four:

- `fabricated` — a cited reference does not exist;
- `mismatch` — the record contradicts a count;
- `verified` — a reference of a counting kind checks out and nothing cited
  fails, or every claimed count matches the record;
- `unverified` — anything else.

**Strictness** (`claims.<class>`): 2 **block** refuses the write. The
refusal names what was missing and how to cite it, gives each failing
reference with its reason ("no file /org/blog/launch.md"), says what the
record shows for a count, and gives the call to make again. A bare refusal
would make the agent retry blindly. 1 **mark** lets the write land with the
claim flagged. It does not count until it is verified: a person confirms it,
or the author writes it again with evidence. 0 **log** records the claim only.
People are never gated.

## 3. Provenance

Each claim is an `org_claims` row against the record that was written:

| `refType` | `refId` |
|---|---|
| `checkin` | the check-in row |
| `project_update` | the update row |
| `task_comment` | the timeline message |
| `minutes_decision` → `decision` | `<meetingId>#<n>` until the meeting closes, then the decision row |
| `step_output` | `<stepId>:<output name>` |
| `minutes_lesson` | `<meetingId>#<n>` |
| `refused` | a blocked write (counted, nothing else was written) |

The row keeps the class, the author, the statement, the claimed value, each
reference as verified (`raw, kind, ok, detail, missing`), the counts with
what the record showed, the verdict, the strictness it was written under,
and who verified it later.

**Readers** call `flags(refType, ids)`, which returns the latest status of
each record, minus verified and logged-only claims, and say so where the
record is read. `org_task` timelines, `org_project` health, `org_decisions`
search and the step card's inputs carry `[unverified]`, `[contradicted by the
record]` or `[fabricated evidence]`. The **company briefing** adds one line
when claims from the last two weeks are still unverified: whose they are and
what they say, with "check the record before building on them", plus the
reader's own count. The member workflow and `verify-and-cite` skills say the
rest: cite when you write, write what is unconfirmed as "not yet verified:
…", and never build on a colleague's flagged claim without checking.

## 4. Fabrication

A reference whose referent does not exist is a fabrication signal, as
opposed to a reference that is merely unproven. That covers no such action,
file, task or task check, and a tool the author never ran. A URL that was not
fetched is unproven, not fabricated, because the page may be real. A
fabrication:

1. is recorded (`status: fabricated`, including on a refused write);
2. opens a `claim_fabricated` signal for the chief;
3. is a `rejected` outcome on the author's trust ledger, as a QC escape is;
4. at `claims.fabricationIncident` fabrications by one member within
   `claims.fabricationWindowHours`, opens a minor `fabrication` incident
   ([incidents](incidents.md)).

A mismatch opens a `claim_mismatch` signal.

## 5. Tunables

All of these are per company. They are changed with `org_tune` or `PUT …/org/tunables`, and
they are `propose` for agents (`boundary.ts`, prefix `claims.`). Every
starter derives them from its values and culture (`deriveClaimTunables`,
called by `deriveOperatingSystem`; `npm run blueprints:build`). A rigour or
control culture blocks unevidenced key-result values, updates, step outputs
and facts in decisions, matches counts exactly and treats one fabrication as
an incident. A results culture blocks unevidenced key-result values. Speed and
experimentation let writes land flagged and only log decisions and lessons.

| Key | Meaning |
|---|---|
| `claims.krCheckin` · `claims.projectUpdate` · `claims.taskUpdate` · `claims.decision` · `claims.stepOutput` · `claims.lesson` | 0 log, 1 mark unverified, 2 block |
| `claims.evidenceWindowDays` | how far back the author's tool calls and actions count for a claim not tied to a task |
| `claims.countTolerancePct` | how far a claimed count may exceed the record |
| `claims.fabricationIncident` / `claims.fabricationWindowHours` | fabrications that open an incident, and the window |

## 6. Surfaces

- **Badges**: a verified, unverified, contradicted or fabricated pill on
  key-result check-ins (Goals), project health updates (the project page),
  task updates (the task drawer's timeline) and decisions (the decision
  record). A click opens the evidence popover, which lists each reference
  with whether it checked out. A workspace file opens in the side panel
  (`src/lib/file-links.ts`), a URL in a new tab, and a count shows what the
  record showed (`src/components/OrgClaimsView.tsx`, `src/lib/claims.ts`).
- **Oversight › Quality › Claims**: verified, unverified, contradicted and
  fabricated counts for the last 30 days, per member worst first, and the
  latest flagged claims with a **Confirm** for the CEO or the board. A
  confirmed key-result value is applied if it is still the latest check-in.

## 7. HTTP

```
GET  /api/workspaces/:id/org/claims?refType=&refIds=a,b&agentId=&status=&days=
GET  /api/workspaces/:id/org/claims/summary?days=30
POST /api/workspaces/:id/org/claims/:claimId/confirm   { note? }
```

Reads need standing in the organisation. Confirming is for the CEO or a board
member.

## 8. Not yet

- An agent cannot attach evidence to an existing claim. It writes the
  record again with evidence, and the newer claim supersedes the old one.
- Meeting summaries and spoken turns (`meeting_speak`, `meeting_close`) are
  not gated. Only proposed decisions and shared lessons are.
- The detector is a string match in English. A claim phrased unusually is
  missed and stays as it was before, ungated.
- Run variables are not held back: an unverified step output still enters
  the run's variables, and later steps see it flagged on their card.
