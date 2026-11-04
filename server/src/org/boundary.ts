/**
 * The self-modification boundary as data (docs/boundary.md, execution-plan
 * item 31, capability C8 of docs/autonomous-org-first-principles.md).
 *
 * One table maps every change the organization can make to itself to one of
 * four verdicts, with the reason:
 *
 *  - `alone`      — the org may make it on its own (within the bounds and caps
 *                   its mode already enforces: in supervised mode an
 *                   approval card is still the path);
 *  - `experiment` — only through an experiment (C5) with a metric, a window
 *                   and a revert rule; until an experiments service is bound,
 *                   an approval card for the CEO;
 *  - `propose`    — only as a proposal: an approval card for the CEO in every
 *                   mode;
 *  - `never`      — no agent may make it; an attempt is a critical audit
 *                   finding and a minor `boundary_violation` incident. A few
 *                   rows (the audit chain) bind humans too.
 *
 * `checkBoundary` is pure and model-free; OrgBoundaryService wraps it with
 * the side effects and every self-change path calls the service (or
 * `OrgService.gate`, which calls it). Humans — the CEO, a board member, an
 * approved card — are not bound except by the rows marked `everyone`.
 */

export type BoundaryVerdict = 'alone' | 'experiment' | 'propose' | 'never';
export const BOUNDARY_VERDICTS: readonly BoundaryVerdict[] = ['alone', 'experiment', 'propose', 'never'];

/** The families of self-change. Each existing path maps to one. */
export type ChangeKind =
  | 'tunable' | 'cadence' | 'routing' | 'playbook' | 'charter' | 'role'
  | 'hire' | 'reorg' | 'terminate' | 'scope_widen' | 'scope_narrow'
  | 'budget' | 'constitution' | 'caps' | 'external_floor' | 'trust_ceiling'
  | 'audit_settings' | 'audit_chain' | 'kill_switch' | 'frozen_classes'
  | 'delegation' | 'eval_cases'
  | 'member_identity' | 'member_model' | 'member_heartbeat' | 'member_folder'
  // A department's name (docs/group-chat.md §7 "Department names").
  | 'unit_name'
  // Work tracking (docs/work-tracking.md): the CEO's bets.
  | 'project_bet' | 'project_appetite' | 'project_kill';

/** A proposed self-change, described enough for the table to place it. */
export interface SelfChange {
  kind: ChangeKind;
  /** The tunable key (tunable), the routing class, the playbook / agent id, … */
  key?: string;
  /** Structure: whether every member it touches sits in one unit (hire, reorg, terminate). */
  withinUnit?: boolean;
  /** Budget: whether it stays inside the company envelope. */
  withinEnvelope?: boolean;
  /** One line for the card, the audit row and the refusal. */
  summary?: string;
}

export interface BoundaryRule {
  id: string;
  kind: ChangeKind;
  /** Human-readable scope of the row (the key prefix, "within one unit", …). */
  match: string;
  verdict: BoundaryVerdict;
  reason: string;
  /** Binds humans as well (audit chain integrity). */
  everyone?: boolean;
  /** May a card of this change be decided by a delegate (docs/owners-seat.md §2)? */
  delegable: boolean;
}

/** Tunable prefixes and their rows, most specific first. */
const TUNABLE_ROWS: Array<{ prefix: string; verdict: BoundaryVerdict; reason: string; delegable: boolean }> = [
  { prefix: 'audit.', verdict: 'never', reason: 'the auditor\'s spot checks and rotation are its independence; the organization it audits may not set them', delegable: false },
  { prefix: 'redteam.', verdict: 'never', reason: 'the red-team cadence tests the organization; it may not turn its own test off', delegable: false },
  { prefix: 'boundary.', verdict: 'never', reason: 'the boundary\'s own settings are the owner\'s', delegable: false },
  { prefix: 'actions.', verdict: 'propose', reason: 'outbound rate limits are the external-action floor', delegable: false },
  { prefix: 'trust.', verdict: 'propose', reason: 'promotion and demotion rules decide how much autonomy is earned — the external-action floor', delegable: false },
  { prefix: 'incidents.', verdict: 'propose', reason: 'containment levels are the safety floor after an incident', delegable: true },
  { prefix: 'acceptance.', verdict: 'propose', reason: 'acceptance settings decide what counts as verified work', delegable: true },
  { prefix: 'signals.', verdict: 'propose', reason: 'signal thresholds decide what the owner and the auditor get to see', delegable: true },
  { prefix: 'pulse.', verdict: 'propose', reason: 'pulse weights decide how health is reported to the owner', delegable: true },
  { prefix: 'slo.', verdict: 'propose', reason: 'SLO targets are the owner\'s promise, not the doer\'s', delegable: true },
  { prefix: 'capital.vetoWindowMinutes', verdict: 'propose', reason: 'the veto window is the owner\'s oversight of autonomous plans', delegable: true },
  { prefix: 'evals.', verdict: 'propose', reason: 'eval settings decide whether a change that regresses can roll out', delegable: true },
  { prefix: 'seat.', verdict: 'propose', reason: 'deadlines and default actions decide what silence from the owner means', delegable: false },
  { prefix: 'chief.proxyLevel', verdict: 'propose', reason: 'the archetype dial widens what the chief does on the CEO\'s behalf; proxy scope is earned one class at a time, never self-granted (docs/chief-of-staff.md)', delegable: false },
  { prefix: '', verdict: 'alone', reason: 'a tunable within its bound: the bound is the safety floor and lives in code', delegable: true },
];

/** The table. Every row is one family (and, for tunables, a key prefix). */
export const BOUNDARY: BoundaryRule[] = [
  ...TUNABLE_ROWS.map((r): BoundaryRule => ({ id: `tunable:${r.prefix || '*'}`, kind: 'tunable', match: r.prefix ? `tunable keys ${r.prefix.endsWith('.') ? `${r.prefix}*` : r.prefix}` : 'any other tunable', verdict: r.verdict, reason: r.reason, delegable: r.delegable })),
  { id: 'cadence', kind: 'cadence', match: 'meeting cadences', verdict: 'alone', reason: 'cadences are bounded by the ritual tunables', delegable: true },
  { id: 'routing', kind: 'routing', match: 'model routing by task class', verdict: 'alone', reason: 'routing trades cost for quality inside the envelope; the eval gate replays the golden set first', delegable: true },
  { id: 'playbook', kind: 'playbook', match: 'playbook activation (new version)', verdict: 'alone', reason: 'a playbook is reviewed by a peer and its new version replays the golden set first', delegable: true },
  { id: 'charter', kind: 'charter', match: 'a member\'s charter', verdict: 'experiment', reason: 'a charter changes how a member works: it must be measured, not just made', delegable: true },
  { id: 'role', kind: 'role', match: 'a role definition', verdict: 'experiment', reason: 'a role changes what a seat is for: it must be measured, not just made', delegable: true },
  { id: 'hire:unit', kind: 'hire', match: 'hire within one unit', verdict: 'alone', reason: 'internal structure within caps (depth, fan-out, agent cap, envelope)', delegable: true },
  { id: 'hire:beyond', kind: 'hire', match: 'hire touching more than one unit', verdict: 'experiment', reason: 'structure beyond one unit changes how units relate: measure it', delegable: true },
  { id: 'reorg:unit', kind: 'reorg', match: 'reorg within one unit', verdict: 'alone', reason: 'internal structure within caps', delegable: true },
  { id: 'reorg:beyond', kind: 'reorg', match: 'reorg across units', verdict: 'experiment', reason: 'structure beyond one unit changes how units relate: measure it', delegable: true },
  { id: 'terminate:unit', kind: 'terminate', match: 'terminate a member who leads nobody', verdict: 'alone', reason: 'internal structure within caps; the agent itself survives', delegable: true },
  { id: 'terminate:beyond', kind: 'terminate', match: 'terminate a unit lead (its reports move up)', verdict: 'experiment', reason: 'removing a lead reshapes two units: measure it', delegable: true },
  { id: 'member_identity', kind: 'member_identity', match: 'a member\'s name, role, emoji and colours', verdict: 'alone', reason: 'presentation only: it changes no authority, money or behaviour', delegable: true },
  { id: 'member_model', kind: 'member_model', match: 'a member\'s agent type and model', verdict: 'alone', reason: 'like routing, it trades cost for quality inside the envelope; the eval gate replays the member\'s golden set first', delegable: true },
  { id: 'member_heartbeat', kind: 'member_heartbeat', match: 'a member\'s heartbeat on/off and cadence', verdict: 'alone', reason: 'bounded by the heartbeat fence in code (cadence floor, daily run cap)', delegable: true },
  { id: 'unit_name', kind: 'unit_name', match: 'a department\'s name (its channel follows; the task key prefix stays)', verdict: 'alone', reason: 'presentation only: the unit id, its board, goals and task keys are unchanged, and the old channel slug keeps resolving', delegable: true },
  { id: 'member_folder', kind: 'member_folder', match: 'a member\'s assigned workspace folder', verdict: 'propose', reason: 'it widens which shared files the member can read and write', delegable: true },
  { id: 'scope_widen', kind: 'scope_widen', match: 'widen a member\'s scopes', verdict: 'alone', reason: 'only within the chief\'s own holdings — the cap refuses anything beyond', delegable: true },
  { id: 'scope_narrow', kind: 'scope_narrow', match: 'narrow a member\'s scopes', verdict: 'alone', reason: 'narrowing removes authority', delegable: true },
  { id: 'project_bet', kind: 'project_bet', match: 'moving a project to Now (the betting table)', verdict: 'propose', reason: 'what the company works on now is the CEO\'s bet; agents shape and propose, the CEO decides', delegable: true },
  { id: 'project_appetite:within', kind: 'project_appetite', match: 'extend a tripped project\'s appetite within the manager\'s share (work.extendShare)', verdict: 'alone', reason: 'the lead\'s manager decides within a bounded extension; the circuit breaker already stopped new work', delegable: true },
  { id: 'project_appetite:beyond', kind: 'project_appetite', match: 'raise a project\'s appetite beyond the manager\'s share, or a project the chief leads', verdict: 'propose', reason: 'more time or money on a bet than the manager may grant is the CEO\'s', delegable: true },
  { id: 'project_kill', kind: 'project_kill', match: 'cancel (kill) a project in Now', verdict: 'propose', reason: 'stopping a bet the CEO made is the CEO\'s call', delegable: true },
  { id: 'budget:within', kind: 'budget', match: 'agent or project envelope within the company envelope', verdict: 'alone', reason: 'allocation inside the envelope the owner set', delegable: true },
  { id: 'budget:above', kind: 'budget', match: 'the company envelope, or above it', verdict: 'propose', reason: 'money beyond the envelope is the owner\'s', delegable: true },
  { id: 'constitution', kind: 'constitution', match: 'the constitution (the CEO\'s standing rules)', verdict: 'propose', reason: 'the legislature is the owner; the chief may only propose amendments', delegable: false },
  { id: 'caps', kind: 'caps', match: 'caps: agent cap, depth, fan-out, the company envelope ceiling', verdict: 'propose', reason: 'caps are the fence the org acts within', delegable: false },
  { id: 'external_floor', kind: 'external_floor', match: 'the external-action floor (classes, staging, two-key)', verdict: 'propose', reason: 'what may leave the organization unattended is the owner\'s', delegable: false },
  { id: 'trust_ceiling', kind: 'trust_ceiling', match: 'trust ceilings per action class', verdict: 'propose', reason: 'how far autonomy may grow is the owner\'s', delegable: false },
  { id: 'audit_settings', kind: 'audit_settings', match: 'the auditor seat, its cadence and cap, rotation, spot checks', verdict: 'never', reason: 'the auditor\'s independence and data access', delegable: false },
  { id: 'audit_chain', kind: 'audit_chain', match: 'the hash-chained audit log', verdict: 'never', reason: 'the record everything else is checked against; nobody rewrites it', everyone: true, delegable: false },
  { id: 'kill_switch', kind: 'kill_switch', match: 'the organization\'s kill switch', verdict: 'never', reason: 'the owner\'s stop button', delegable: false },
  { id: 'frozen_classes', kind: 'frozen_classes', match: 'action classes frozen by an incident', verdict: 'never', reason: 'a freeze is lifted by the owner resolving the incident', delegable: false },
  { id: 'delegation', kind: 'delegation', match: 'who may decide cards for the owner', verdict: 'never', reason: 'delegating the owner\'s authority is the owner\'s act', delegable: false },
  { id: 'eval_cases', kind: 'eval_cases', match: 'golden-set cases (manual add, retire)', verdict: 'never', reason: 'the yardstick the org is measured by; harvesting adds cases from verified work, nobody edits them by hand but the owner', delegable: false },
];

/** Who is asking. Agents are bound; humans are not (except `everyone` rows). */
export function isAgentActor(actor: string): boolean {
  return actor === 'chief' || actor.startsWith('agent:');
}

/** The row that governs a change. Pure. */
export function ruleFor(change: SelfChange): BoundaryRule {
  if (change.kind === 'tunable') {
    const key = change.key ?? '';
    const row = TUNABLE_ROWS.find((r) => r.prefix !== '' && key.startsWith(r.prefix)) ?? TUNABLE_ROWS.at(-1)!;
    return BOUNDARY.find((b) => b.id === `tunable:${row.prefix || '*'}`)!;
  }
  if (change.kind === 'hire') return BOUNDARY.find((b) => b.id === (change.withinUnit === false ? 'hire:beyond' : 'hire:unit'))!;
  if (change.kind === 'reorg') return BOUNDARY.find((b) => b.id === (change.withinUnit === false ? 'reorg:beyond' : 'reorg:unit'))!;
  if (change.kind === 'terminate') return BOUNDARY.find((b) => b.id === (change.withinUnit === false ? 'terminate:beyond' : 'terminate:unit'))!;
  if (change.kind === 'budget') return BOUNDARY.find((b) => b.id === (change.withinEnvelope === false ? 'budget:above' : 'budget:within'))!;
  if (change.kind === 'project_appetite') return BOUNDARY.find((b) => b.id === (change.withinEnvelope === false ? 'project_appetite:beyond' : 'project_appetite:within'))!;
  const row = BOUNDARY.find((b) => b.kind === change.kind);
  if (!row) throw new Error(`no boundary row for "${change.kind}"`);
  return row;
}

/** What the caller must do. `proceed` = the path continues as its mode says
 *  (supervised still means a card); `card` = an approval card for the CEO
 *  whatever the mode; `experiment` = an experiment proposal (refused with
 *  that instruction when an experiments service exists); `refuse` = no. */
export type BoundaryOutcome = 'proceed' | 'card' | 'experiment' | 'refuse';

export interface BoundaryDecision { rule: BoundaryRule; verdict: BoundaryVerdict; outcome: BoundaryOutcome; agent: boolean; reason: string }

/** The one decision. Pure and model-free. */
export function checkBoundary(change: SelfChange, actor: string, opts: { experiments?: boolean; fallbackCard?: boolean } = {}): BoundaryDecision {
  const rule = ruleFor(change);
  const agent = isAgentActor(actor);
  const what = change.summary ? `${change.summary} — ` : '';
  const base = { rule, verdict: rule.verdict, agent };
  // An experiment applies a change the CEO or the plan approved, but never a never-change.
  if (rule.verdict === 'never' && (agent || rule.everyone || actor === 'experiment')) return { ...base, outcome: 'refuse', reason: `refused: ${change.summary ? `${change.summary} — ` : ''}${rule.match} is never ${rule.everyone ? 'anyone\'s' : 'an agent\'s'} to change (${rule.reason})` };
  if (!agent) return { ...base, outcome: 'proceed', reason: 'a human decision: the boundary binds agents' };
  if (rule.verdict === 'alone') return { ...base, outcome: 'proceed', reason: rule.reason };
  if (rule.verdict === 'propose') return { ...base, outcome: 'card', reason: `${what}${rule.match} may only be proposed (${rule.reason})` };
  // experiment
  if (opts.experiments) return { ...base, outcome: 'experiment', reason: `refused: ${what}${rule.match} changes only through an experiment — propose one with org_propose_experiment (a hypothesis, the metric source it should move, a window and a revert rule) (${rule.reason})` };
  if (opts.fallbackCard === false) return { ...base, outcome: 'refuse', reason: `refused: ${rule.match} changes only through an experiment, and experiments are not available on this server (${rule.reason})` };
  return { ...base, outcome: 'card', reason: `${what}${rule.match} changes only through an experiment; until experiments exist it goes to the CEO as a card (${rule.reason})` };
}

/** The table for `GET …/org/boundary`. */
export function describeBoundary(): Array<BoundaryRule> {
  return BOUNDARY.map((r) => ({ ...r }));
}
