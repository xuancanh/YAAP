/**
 * The built-in process library (docs/processes.md "Templates"): the
 * procedures most companies run, as definitions a company instantiates at
 * onboarding, when a kit is installed, or on request — and then owns. After
 * that a process is the company's: the chief of staff (any process) and a
 * head (its unit's) change it from what its runs show; nothing here is
 * read again for an existing process.
 *
 * Each template names the function that owns it (`unitHint`, matched
 * against the heads' titles; none = the company, owned by the chief) and
 * whether a company should get it at onboarding (`seed`). Kit rhythm lines
 * ("release checklist before each release") map onto templates by words
 * (`templatesForRhythm`), model-free.
 */
import type { ProcessDef } from './process-model';

export interface ProcessTemplate {
  id: string;
  /** One line for the library list. */
  summary: string;
  /** Words matched against head titles to pick the owning unit ('' = the company). */
  unitHint: string[];
  /** Seeded at onboarding: always, when the company has the function, or never. */
  seed: 'always' | 'function' | 'never';
  def: ProcessDef;
}

export const PROCESS_TEMPLATES: ProcessTemplate[] = [
  {
    id: 'chief-daily-sweep', summary: 'The chief of staff\'s weekday operating-system sweep: intake, portfolio and blockers, handoffs, the CEO brief.', unitHint: [], seed: 'always',
    def: {
      title: 'Chief\'s daily sweep', category: 'operating', owner: 'chief',
      description: 'The weekday sweep that keeps the ledger true and leaves the CEO a five-line brief. Started by the chief\'s 07:30 loop.',
      triggers: [{ kind: 'manual' }],
      stages: [{ id: 'sweep', title: 'Sweep', mode: 'strict' }],
      nodes: [
        { id: 'intake', title: 'Take in the heads\' reports and requests', kind: 'task', lane: 'chief', class: 'triage', playbook: 'function-reports-intake', why: 'the ledger is only as true as the latest report from each function',
          outcome: 'New function reports and backlog requests are read and filed into the ledger.', doneWhen: '/org/scorecard.md and /org/risks.md cite every new report; incomplete cases are sent back.',
          must: ['Every report newer than the last intake is read', 'Metrics without a source are marked "estimate"'], should: ['Incomplete cases go back to the head naming the missing fields'] },
        { id: 'portfolio', title: 'Portfolio, blockers and escalations', kind: 'task', lane: 'chief', class: 'triage', playbook: 'escalation-and-blocker-sweep', why: 'blocked work and stale projects are the cheapest wins of the day',
          outcome: 'Every blocked task and escalation has an owner and a next move; Now projects with a missing update are chased.', doneWhen: 'No blocked task older than the chase window is without a named owner or a decision card.',
          must: ['Every escalation addressed to you is decided, sent back or raised'], should: ['Leads with a missing project update are chased', 'Patterns go to /org/issues.md'] },
        { id: 'handoffs', title: 'Handoff SLAs', kind: 'task', lane: 'chief', class: 'ops', playbook: 'handoff-sla-monitor', why: 'silence on a cross-function request is a breach',
          outcome: '/org/handoffs.md is current and every breached handoff is chased or escalated.', doneWhen: 'No open handoff is past its SLA without a chase or an escalation.',
          must: ['Every handoff past chief.handoffSlaHours is chased or escalated'] },
        { id: 'brief', title: 'The CEO\'s daily brief', kind: 'task', lane: 'chief', class: 'synthesis', playbook: 'ceo-daily-brief', why: 'the CEO\'s time is the scarcest input of the company',
          outcome: 'A five-line brief for the CEO with what changed, what is at risk and what waits on them.', doneWhen: 'The brief is delivered (org_report) and names its sources.',
          must: ['Every number names its source', 'A variance nobody can explain is written "unknown — investigating"'], should: ['Decisions waiting on the CEO are listed with their deadline'] },
      ],
      edges: [{ from: 'intake', to: 'portfolio' }, { from: 'intake', to: 'handoffs' }, { from: 'portfolio', to: 'brief' }, { from: 'handoffs', to: 'brief' }],
    },
  },
  {
    id: 'incident-response', summary: 'Major incident: contain, communicate, resolve, then a blameless postmortem with owned actions.', unitHint: [], seed: 'always',
    def: {
      title: 'Incident response', category: 'operating', owner: 'chief',
      description: 'From an opened major incident to a resolved one and a postmortem whose actions have owners. Runs on every major or critical incident.',
      triggers: [{ kind: 'event', event: 'incident_opened', severity: 'major' }, { kind: 'manual' }],
      stages: [{ id: 'respond', title: 'Respond', mode: 'strict' }, { id: 'learn', title: 'Learn', mode: 'strict' }],
      nodes: [
        { id: 'contain', title: 'Contain and assess', kind: 'task', stage: 'respond', lane: 'head', class: 'ops', slaHours: 2, why: 'stop the harm first; understanding comes after',
          outcome: 'The incident ${incident} is contained and its impact is known.', doneWhen: 'Impact, affected members and the containment taken are written on the incident.',
          must: ['Containment is in place (paused member, frozen class, or a reason none is needed)', 'Impact is stated: who and what is affected'], should: ['Status is posted to #company'],
          outputs: [{ name: 'impact', required: true, description: 'who and what is affected' }] },
        { id: 'resolve', title: 'Resolve', kind: 'task', stage: 'respond', lane: 'head', class: 'ops', why: 'a contained incident still costs until it is fixed',
          outcome: 'The cause of ${incident} is removed and normal work resumes.', doneWhen: 'The fix is verified (a check, a metric back to normal or a person\'s confirmation).',
          must: ['The fix is verified, not assumed'], outputs: [{ name: 'cause', required: true }] },
        { id: 'postmortem', title: 'Blameless postmortem', kind: 'task', stage: 'learn', lane: 'chief', class: 'synthesis', playbook: 'postmortem', why: 'an incident nobody learns from comes back',
          outcome: 'A postmortem of ${incident}: timeline, cause, what went well, at most three actions.', doneWhen: 'The postmortem is written and every action has one owner and a date.',
          must: ['No blame: systems and decisions, not people', 'Every action has one owner and a date'], should: ['At most three actions; the rest are noted, not tasked'] },
      ],
      edges: [{ from: 'contain', to: 'resolve' }],
    },
  },
  {
    id: 'cross-function-request', summary: 'A request from one function to another: triage, accept with a date or decline, deliver, confirm.', unitHint: [], seed: 'always',
    def: {
      title: 'Cross-function request', category: 'operating', owner: 'chief',
      description: 'The handoff protocol as a process: the provider accepts with a date, declines with a reason or negotiates — silence is a breach.',
      triggers: [{ kind: 'manual' }, { kind: 'service_request' }],
      stages: [{ id: 'intake', title: 'Intake', mode: 'strict' }, { id: 'deliver', title: 'Deliver', mode: 'strict' }],
      nodes: [
        { id: 'triage', title: 'Route the request to its function', kind: 'task', stage: 'intake', lane: 'chief', class: 'triage', slaHours: 8, why: 'a request with no owner is the commonest leak between functions',
          outcome: 'The request "${request}" has a providing function and a named owner.', doneWhen: 'The provider\'s head has the request with the requester\'s brief.',
          must: ['The request names what is needed, by when and why'], outputs: [{ name: 'provider', required: true, description: 'the function that provides it' }] },
        { id: 'accept', title: 'Accept, decline or negotiate', kind: 'task', stage: 'intake', lane: 'head', class: 'triage', why: 'the requester plans on the answer, not on the hope',
          outcome: 'The provider answers: accepted with a date, declined with a reason, or a counter-offer.', doneWhen: 'The answer is recorded as the output `answer` (accepted | declined | negotiate).',
          must: ['The answer is one of accepted, declined, negotiate'], outputs: [{ name: 'answer', required: true }, { name: 'due', description: 'the committed date when accepted' }] },
        { id: 'do', title: 'Deliver the request', kind: 'task', stage: 'deliver', lane: 'head', class: 'general', why: 'the commitment made at acceptance',
          outcome: 'What was requested is delivered to the requester by ${due}.', doneWhen: 'The requester has the result where they asked for it.' },
        { id: 'confirm', title: 'Requester confirms', kind: 'task', stage: 'deliver', lane: 'initiator', class: 'review', why: 'done is when the requester says it is usable',
          outcome: 'The requester confirms the delivery meets the request.', doneWhen: 'A confirmation, or the gap sent back.' },
      ],
      edges: [{ from: 'triage', to: 'accept' }, { from: 'do', to: 'confirm' }],
    },
  },
  {
    id: 'weekly-business-review-prep', summary: 'Assemble the weekly business review pack: owners\' commentary, exceptions only, last week\'s open items first.', unitHint: [], seed: 'always',
    def: {
      title: 'Weekly business review prep', category: 'operating', owner: 'chief',
      description: 'The pack for the weekly review: the scorecard, each owner\'s commentary on its exceptions, and last week\'s open items.',
      triggers: [{ kind: 'cadence', cron: '0 14 * * 4' }, { kind: 'manual' }],
      stages: [{ id: 'collect', title: 'Collect', mode: 'dynamic' }, { id: 'compile', title: 'Compile', mode: 'strict' }],
      nodes: [
        { id: 'scorecard', title: 'Refresh the scorecard', kind: 'task', stage: 'collect', lane: 'chief', class: 'synthesis', required: true, why: 'the review starts from numbers, not stories',
          outcome: '/org/scorecard.md shows this week\'s values with sources.', doneWhen: 'Every metric has this week\'s value or is marked stale.', must: ['Every value names its source'] },
        { id: 'open-items', title: 'Last week\'s open items', kind: 'task', stage: 'collect', lane: 'chief', class: 'triage', required: true, why: 'open items first, or they quietly die',
          outcome: 'Every open item from the last review has a status.', doneWhen: 'The list heads the pack.' },
        { id: 'commentary', title: 'Chase the owners\' commentary', kind: 'task', stage: 'collect', lane: 'chief', class: 'ops', availableWhen: { after: ['scorecard'] }, why: 'owners explain their own exceptions',
          outcome: 'Each metric off target has its owner\'s two lines.', doneWhen: 'Commentary is in, or the owner is named as missing.', may: ['Skip owners whose metrics are on target'] },
        { id: 'pack', title: 'Compile the pack', kind: 'task', stage: 'compile', lane: 'chief', class: 'synthesis', playbook: 'weekly-business-review', why: 'a pre-read the room actually reads',
          outcome: 'The weekly review pack, exceptions only.', doneWhen: 'The pack is written and linked from the review meeting.', must: ['Exceptions only: on-target metrics are one line'], should: ['Sent before chief.preReadHours'] },
      ],
      edges: [],
    },
  },
  {
    id: 'release-checklist', summary: 'Ship a release safely: what is in it, CI green, incidents, flags, rollback, then the note.', unitHint: ['engineering', 'engineer', 'product', 'technology', 'cto', 'software'], seed: 'function',
    def: {
      title: 'Release checklist', category: 'delivery', owner: 'head',
      description: 'Before every release: what merged, CI green, no open critical incident, flags decided, rollback ready, the release note written.',
      triggers: [{ kind: 'manual' }],
      stages: [{ id: 'check', title: 'Check', mode: 'strict' }, { id: 'ship', title: 'Ship', mode: 'strict' }],
      nodes: [
        { id: 'scope', title: 'List what is in the release', kind: 'task', stage: 'check', lane: 'owner', class: 'review', why: 'nobody can approve what nobody listed',
          outcome: 'The list of changes in ${release}, each closing a task.', doneWhen: 'Every merged change is listed with its task.', must: ['Every listed change closes a task'], outputs: [{ name: 'changes', required: true }] },
        { id: 'ci', title: 'CI green on the release commit', kind: 'task', stage: 'check', lane: 'owner', class: 'review', why: 'a red or flaky run blocks the release until it is understood',
          outcome: 'CI is green on the release commit.', doneWhen: 'The CI run is green and linked.', must: ['The run is on the release commit, not a neighbour', 'A flaky run is understood, not re-run until green'] },
        { id: 'incidents', title: 'No open critical incident', kind: 'task', stage: 'check', lane: 'owner', class: 'review', why: 'no release while a critical incident is open on the same service',
          outcome: 'Open incidents are checked against the release.', doneWhen: 'None is critical on an affected service, or the release waits.', must: ['No critical incident is open on an affected service'] },
        { id: 'go', title: 'Go / no-go', kind: 'approval', stage: 'check', approver: 'manager', question: 'Release ${release}: CI green, no critical incident, changes listed — go?', why: 'a second person approves every release (Knight Capital had none)' },
        { id: 'rollback', title: 'Flags and rollback', kind: 'task', stage: 'ship', lane: 'owner', class: 'ops', why: 'a release without a rollback is a one-way door',
          outcome: 'New features start off or at a small rollout; the rollback step and who runs it are written.', doneWhen: 'Flags set and the rollback step written.', must: ['The rollback step names who runs it'], should: ['New features start off or at a small rollout'], outputs: [{ name: 'rollback', required: true }] },
        { id: 'note', title: 'Release note', kind: 'task', stage: 'ship', lane: 'owner', class: 'synthesis', why: 'support and the CEO hear it from us first',
          outcome: 'The release note for the CEO and support.', doneWhen: 'The note is posted.', should: ['Plain words: what changed for whom'] },
      ],
      edges: [{ from: 'scope', to: 'ci' }, { from: 'scope', to: 'incidents' }, { from: 'ci', to: 'go' }, { from: 'incidents', to: 'go' }, { from: 'rollback', to: 'note' }],
    },
  },
  {
    id: 'content-publishing', summary: 'Brief, draft, review loop (bounded), approve, publish, measure.', unitHint: ['marketing', 'content', 'growth', 'brand', 'communications', 'editor'], seed: 'function',
    def: {
      title: 'Content publishing', category: 'delivery', owner: 'head',
      description: 'From a brief to a published piece: draft, an editor\'s review that may send it back (at most twice), approval and publication.',
      triggers: [{ kind: 'manual' }],
      stages: [{ id: 'make', title: 'Make', mode: 'strict' }, { id: 'publish', title: 'Publish', mode: 'strict' }],
      nodes: [
        { id: 'draft', title: 'Draft', kind: 'task', stage: 'make', lane: 'owner', class: 'synthesis', why: 'the piece the brief asks for',
          outcome: 'A draft of "${piece}" that answers the brief.', doneWhen: 'The draft is in the workspace and linked.', must: ['Every factual claim has a source'], should: ['Keep to the audience the brief names'], outputs: [{ name: 'draft', required: true }] },
        { id: 'edit', title: 'Editor\'s review', kind: 'task', stage: 'make', lane: 'editor', class: 'review', why: 'a second pair of eyes on every published word',
          outcome: 'The draft is ready to publish or goes back with what to change.', doneWhen: 'The output `verdict` is ready or revise.', must: ['The verdict is ready or revise'], outputs: [{ name: 'verdict', required: true }] },
        { id: 'publish', title: 'Publish', kind: 'task', stage: 'publish', lane: 'owner', class: 'ops', why: 'it only counts once it is out',
          outcome: '"${piece}" is published where the brief says.', doneWhen: 'The published link is recorded.', must: ['The published version is the reviewed one'], outputs: [{ name: 'link', required: true }] },
        { id: 'measure', title: 'Measure after a week', kind: 'wait', stage: 'publish', waitHours: 168, why: 'reach is known a week later' },
        { id: 'report', title: 'Report the result', kind: 'task', stage: 'publish', lane: 'owner', class: 'synthesis', why: 'what worked feeds the next brief',
          outcome: 'Reach and response of "${piece}" against the brief\'s goal.', doneWhen: 'Two lines with the numbers and their source.' },
      ],
      edges: [{ from: 'draft', to: 'edit' }, { from: 'edit', to: 'draft', when: 'verdict == revise', loopMax: 2 }, { from: 'publish', to: 'measure' }, { from: 'measure', to: 'report' }],
    },
  },
  {
    id: 'hiring-loop', summary: 'Define the seat, approve it, source, interview, debrief within a day, offer.', unitHint: ['people', 'hr', 'talent', 'recruit', 'hiring'], seed: 'function',
    def: {
      title: 'Hiring loop', category: 'delivery', owner: 'head',
      description: 'A seat from its case to an offer: the case approved, candidates sourced and screened, interviews, a debrief within a day, the offer.',
      triggers: [{ kind: 'manual' }],
      stages: [{ id: 'define', title: 'Define', mode: 'strict' }, { id: 'search', title: 'Search', mode: 'dynamic' }, { id: 'close', title: 'Close', mode: 'strict' }],
      nodes: [
        { id: 'case', title: 'The seat\'s case', kind: 'task', stage: 'define', lane: 'owner', class: 'synthesis', why: 'every seat traces to a key result',
          outcome: 'The case for ${seat}: the key result it serves, the cost, the alternatives.', doneWhen: 'The case is written.', must: ['The key result the seat serves is named', 'The monthly cost is stated'] },
        { id: 'approve', title: 'Approve the seat', kind: 'approval', stage: 'define', approver: 'manager', question: 'Open the seat ${seat} on the case written?', why: 'headcount is a commitment' },
        { id: 'source', title: 'Source candidates', kind: 'task', stage: 'search', lane: 'recruit', class: 'research', required: true, why: 'a slate before interviews', outcome: 'A slate of candidates for ${seat}.', doneWhen: 'At least three screened candidates.' },
        { id: 'interview', title: 'Interviews', kind: 'task', stage: 'search', lane: 'owner', class: 'review', required: true, availableWhen: { after: ['source'] }, why: 'structured interviews against the case', outcome: 'Each candidate is interviewed against the same rubric.', doneWhen: 'Scorecards for every interview.', must: ['The same rubric for every candidate'] },
        { id: 'reference', title: 'References', kind: 'task', stage: 'search', lane: 'owner', class: 'research', availableWhen: { after: ['interview'] }, why: 'optional for junior seats', outcome: 'References for the finalist.', doneWhen: 'Two references noted.' },
        { id: 'debrief', title: 'Debrief within a day', kind: 'task', stage: 'close', lane: 'owner', class: 'synthesis', slaHours: 24, why: 'memory fades; decide while it is fresh', outcome: 'A hire / no-hire decision for ${seat}.', doneWhen: 'The output `decision` is hire or no_hire.', outputs: [{ name: 'decision', required: true }] },
        { id: 'offer', title: 'Make the offer', kind: 'task', stage: 'close', lane: 'owner', class: 'ops', why: 'the close', outcome: 'An offer to the chosen candidate.', doneWhen: 'The offer is sent and recorded.' },
      ],
      edges: [{ from: 'case', to: 'approve' }, { from: 'debrief', to: 'offer', when: 'decision == hire' }],
    },
  },
  {
    id: 'customer-onboarding', summary: 'A new customer to first value: kickoff, setup, first value confirmed, handover.', unitHint: ['customer', 'success', 'support', 'account', 'sales'], seed: 'function',
    def: {
      title: 'Customer onboarding', category: 'delivery', owner: 'head',
      description: 'From a signed customer to the first value they confirm, then the handover to the account owner.',
      triggers: [{ kind: 'manual' }],
      stages: [{ id: 'start', title: 'Start', mode: 'strict' }, { id: 'adopt', title: 'Adopt', mode: 'dynamic' }],
      nodes: [
        { id: 'kickoff', title: 'Kickoff', kind: 'task', stage: 'start', lane: 'owner', class: 'ops', slaHours: 48, why: 'the first two days set the relationship',
          outcome: 'A kickoff with ${customer}: goals, contacts and the first-value milestone.', doneWhen: 'The plan is written and shared.', must: ['The customer\'s own success measure is written down'], outputs: [{ name: 'first_value', required: true, description: 'the milestone the customer counts as value' }] },
        { id: 'setup', title: 'Set up', kind: 'task', stage: 'adopt', lane: 'owner', class: 'ops', required: true, why: 'nothing happens until they can use it', outcome: '${customer} is set up.', doneWhen: 'They have used it once.' },
        { id: 'training', title: 'Training', kind: 'task', stage: 'adopt', lane: 'owner', class: 'synthesis', availableWhen: { after: ['setup'] }, why: 'when the users are new to the work', outcome: 'The users can do ${first_value} alone.', doneWhen: 'A session held or material sent.' },
        { id: 'value', title: 'First value confirmed', kind: 'task', stage: 'adopt', lane: 'owner', class: 'review', required: true, availableWhen: { after: ['setup'] }, why: 'onboarding ends at value, not at setup', outcome: '${customer} confirms ${first_value}.', doneWhen: 'The customer\'s confirmation is recorded.', must: ['The confirmation comes from the customer'] },
      ],
      edges: [],
    },
  },
];

export function templateById(id: string): ProcessTemplate | undefined {
  return PROCESS_TEMPLATES.find((t) => t.id === id);
}

/** Kit rhythm lines → template ids, by words. Pure. */
export function templatesForRhythm(lines: string[]): string[] {
  const out = new Set<string>();
  for (const raw of lines) {
    const l = raw.toLowerCase();
    if (/\brelease\b/.test(l)) out.add('release-checklist');
    if (/\b(postmortem|incident)s?\b/.test(l)) out.add('incident-response');
    if (/\b(hiring|interview|debrief|recruit)/.test(l)) out.add('hiring-loop');
    if (/\bonboard/.test(l)) out.add('customer-onboarding');
    if (/\b(content|campaign|publish)/.test(l)) out.add('content-publishing');
    if (/\b(request|triage)\b/.test(l) && !/\bqueue\b/.test(l)) out.add('cross-function-request');
    if (/\bweekly\b.*\breview\b/.test(l)) out.add('weekly-business-review-prep');
  }
  return [...out];
}
