/**
 * Decision routing, the pure half (docs/owners-seat.md §7).
 *
 * Every decision an org member raises — an approval card, an escalation, a
 * held outward action — goes first to the member's **direct manager**: a
 * specialist's head, a head's chief of staff, the chief's CEO. A member with
 * `reportsToHumanId` goes to that person. The manager decides when the card
 * is within its authority (`authorityFor`, the table below), sends it back
 * with guidance, or escalates it one level with a recommendation; the CEO
 * gets what climbs the chain and what is CEO-reserved (`reservedOf`).
 * Reserved cards still pass through the managers first, to collect their
 * recommendations, but no manager may decide them.
 *
 * Holders are strings: 'ceo', 'agent:<agentId>', 'human:<memberAccountId>'.
 * Model-free; OrgDecisionsService adds the side effects.
 */
import { isMoneyCard, reversibilityOf, amountUsdOf } from './decision-cards';
import { ruleFor, type ChangeKind } from './boundary';

export type Holder = string;
export const CEO: Holder = 'ceo';

export type HopAction = 'raised' | 'escalated' | 'timed_out' | 'sent_back' | 'decided';

/** One hop of a card's journey, kept on the card (`org_approvals.chain`). */
export interface DecisionHop {
  at: string;
  action: HopAction;
  /** Who acted ('agent:<id>', 'human:<id>', 'system', the requester). */
  by: string;
  /** Who held it before and who holds it after. */
  from: Holder;
  to: Holder;
  /** The manager's recommendation when it escalated (or decided). */
  recommendation?: 'approve' | 'deny' | 'modify' | '';
  reasoning?: string;
  /** Approve / reject / revise when the hop decided it. */
  decision?: string;
  /** The manager runs on the requester's model family (independent review). */
  sameModel?: boolean;
}

export interface RouteMember { agentId: string; reportsToAgentId: string | null; status: string; reportsToHumanId?: string | null; title?: string }
export interface RouteHuman { memberAccountId: string; role: string }
export interface RouteOrg { chiefOfStaffAgentId: string | null }

/** 'agent:<id>' from a requestedBy / actor ('chief' is the chief's agent). */
export function agentOfActor(actor: string, org: RouteOrg): string | null {
  if (actor === 'chief') return org.chiefOfStaffAgentId;
  if (actor.startsWith('agent:')) return actor.slice('agent:'.length) || null;
  return null;
}

export function holderAgent(holder: Holder): string | null {
  return holder.startsWith('agent:') ? holder.slice('agent:'.length) : null;
}

export function holderHuman(holder: Holder): string | null {
  return holder.startsWith('human:') ? holder.slice('human:'.length) : null;
}

/**
 * The direct manager of a member for decisions. A person named on the member
 * (`reportsToHumanId`, with standing: not an observer) wins; else the
 * reportsTo agent when it is active; the chief (and anyone whose line is
 * broken) goes to the CEO. Never the member itself.
 */
export function managerOf(agentId: string, members: RouteMember[], humans: RouteHuman[], org: RouteOrg): Holder {
  const m = members.find((x) => x.agentId === agentId);
  if (!m || agentId === org.chiefOfStaffAgentId) return CEO;
  if (m.reportsToHumanId) {
    const h = humans.find((x) => x.memberAccountId === m.reportsToHumanId);
    if (h && h.role !== 'observer') return h.role === 'ceo' ? CEO : `human:${h.memberAccountId}`;
  }
  let next = m.reportsToAgentId;
  const seen = new Set<string>([agentId]);
  // A paused or terminated manager is skipped: the card goes to the next live one up.
  while (next && !seen.has(next)) {
    seen.add(next);
    const up = members.find((x) => x.agentId === next);
    if (!up) break;
    if (up.status === 'active') return `agent:${up.agentId}`;
    next = up.reportsToAgentId;
  }
  return org.chiefOfStaffAgentId && org.chiefOfStaffAgentId !== agentId && members.some((x) => x.agentId === org.chiefOfStaffAgentId && x.status === 'active') ? `agent:${org.chiefOfStaffAgentId}` : CEO;
}

/** The manager of a holder: an agent's manager, a person's (the agent they
 *  report to, else the CEO), the CEO's nobody (null). */
export function nextHolder(holder: Holder, members: RouteMember[], humans: RouteHuman[], org: RouteOrg, employees: Array<{ memberAccountId: string; reportsToAgentId: string | null }> = []): Holder | null {
  if (holder === CEO) return null;
  const a = holderAgent(holder);
  if (a) return managerOf(a, members, humans, org);
  const h = holderHuman(holder);
  const e = h ? employees.find((x) => x.memberAccountId === h) : undefined;
  if (e?.reportsToAgentId) {
    const m = members.find((x) => x.agentId === e.reportsToAgentId && x.status === 'active');
    if (m) return `agent:${m.agentId}`;
  }
  return CEO;
}

/** The whole chain above a member, nearest first, ending with 'ceo'. */
export function chainAbove(agentId: string, members: RouteMember[], humans: RouteHuman[], org: RouteOrg, employees: Array<{ memberAccountId: string; reportsToAgentId: string | null }> = []): Holder[] {
  const out: Holder[] = [];
  let h: Holder | null = managerOf(agentId, members, humans, org);
  while (h && !out.includes(h) && out.length < 12) { out.push(h); h = nextHolder(h, members, humans, org, employees); }
  if (out.at(-1) !== CEO) out.push(CEO);
  return out;
}

/** Where a decision raised by `fromAgentId` goes first, and the rest of the
 *  chain above it (for the work-tracking `blockedOn` and the inbox). Pure. */
export function routeDecision(input: { org: RouteOrg; members: RouteMember[]; humans: RouteHuman[]; employees?: Array<{ memberAccountId: string; reportsToAgentId: string | null }>; fromAgentId: string | null; kind: string; payload?: Record<string, unknown> }): { holder: Holder; chain: Holder[]; reserved: string } {
  const reserved = reservedOf(input.kind, input.payload ?? {});
  if (!input.fromAgentId) return { holder: CEO, chain: [CEO], reserved };
  const chain = chainAbove(input.fromAgentId, input.members, input.humans, input.org, input.employees ?? []);
  return { holder: chain[0], chain, reserved };
}

/**
 * Why a card is the CEO's alone ('' = a manager within its authority may
 * decide it). The owner reserved these: the boundary's `propose` rows, money
 * beyond the company envelope, irreversible and two-key actions (the
 * owner's key), policy, strategy and values, external commitments, the
 * truth metrics, and anything raised `to: "ceo"`.
 */
export function reservedOf(kind: string, payload: Record<string, unknown>): string {
  if (kind === 'two_key') return 'a held outward action: it needs the owner\'s key (or the co-signer rules)';
  if (kind === 'external') return 'an external commitment';
  if (kind === 'strategy') return 'strategy and values are the CEO\'s';
  if (kind === 'blueprint') return 'staffing a company from a blueprint is the CEO\'s';
  if (kind === 'metric_source') return 'a metric source defines what counts as truth';
  if (kind === 'experiment' || kind === 'charter_change') return 'policy: a change to how the company works';
  if (kind === 'tune' || kind === 'routing') return 'a company-wide setting';
  if (kind === 'budget_raise' && String(payload.scope ?? 'company') === 'company') return 'money beyond the company envelope';
  if (payload.boundary === 'propose' || payload.boundary === 'experiment') return `the boundary reserves it for the owner${payload.boundaryRule ? ` (${String(payload.boundaryRule)})` : ''}`;
  if (kind === 'escalation' && (payload.to === 'ceo' || payload.reserved === true)) return 'raised for a decision only the CEO can make';
  if (reversibilityOf(kind, payload) === 'irreversible' && kind !== 'escalation' && kind !== 'human_review' && kind !== 'member_settings') return 'irreversible';
  return '';
}

/** One row of the authority table (docs/owners-seat.md §7). */
export interface AuthorityRow { kind: string; manager: 'decide' | 'decide_if' | 'recommend'; when: string }

/**
 * What a manager may decide on its own, per kind. Every row also needs:
 * not its own request, not CEO-reserved, the manager's trust on internal
 * writes at 2 or more, and (for structural kinds) an autonomous company —
 * in supervised mode the owner chose to approve structure, so a manager
 * recommends. A delegation of the kind to the manager's role (an owner's
 * act, docs/owners-seat.md §2) lets it decide a delegable card too.
 */
export const AUTHORITY_TABLE: AuthorityRow[] = [
  { kind: 'escalation', manager: 'decide', when: 'a task in its reporting line: continue (unblock with guidance) or cancel; any mode' },
  { kind: 'member_settings', manager: 'decide_if', when: 'autonomous; the member is in its reporting line; identity, model (after the eval gate) or heartbeat — never a folder' },
  { kind: 'hire', manager: 'decide_if', when: 'autonomous; the hire lands in its reporting line; its budget fits the manager\'s unit headroom' },
  { kind: 'scope_widen', manager: 'decide_if', when: 'autonomous; the member is in its reporting line; every scope is within the manager\'s own holdings' },
  { kind: 'reorg', manager: 'decide_if', when: 'autonomous; every member it touches is in its reporting line' },
  { kind: 'terminate', manager: 'decide_if', when: 'autonomous; the member is in its reporting line and leads nobody' },
  { kind: 'budget_raise', manager: 'decide_if', when: 'autonomous; an agent or project envelope in its line, within its unit headroom (the company envelope is the CEO\'s)' },
  { kind: 'cadence', manager: 'decide_if', when: 'autonomous; a ritual of a unit it leads' },
  { kind: 'project_allocation', manager: 'decide', when: 'its own report lent to a project team (the allocation within 100% across projects); any mode — the head stays accountable for its people' },
  { kind: 'resource_conflict', manager: 'decide', when: 'a Program Manager and a head in its line disagree on a project\'s resources (or the head did not answer): grant the request or uphold the head; any mode' },
  { kind: 'human_review', manager: 'recommend', when: 'addressed to a named person' },
  { kind: 'tune', manager: 'recommend', when: 'company-wide setting: CEO' },
  { kind: 'routing', manager: 'recommend', when: 'company-wide setting: CEO' },
  { kind: 'strategy', manager: 'recommend', when: 'CEO-reserved' },
  { kind: 'external', manager: 'recommend', when: 'CEO-reserved: external commitment' },
  { kind: 'two_key', manager: 'recommend', when: 'CEO-reserved: the owner\'s key' },
  { kind: 'metric_source', manager: 'recommend', when: 'CEO-reserved: defines truth' },
  { kind: 'experiment', manager: 'recommend', when: 'CEO-reserved: policy' },
  { kind: 'charter_change', manager: 'recommend', when: 'CEO-reserved: policy' },
  { kind: 'blueprint', manager: 'recommend', when: 'CEO-reserved' },
];

export interface AuthorityInput {
  kind: string;
  payload: Record<string, unknown>;
  /** reservedOf(…) for the card. */
  reserved: string;
  /** The manager raised this card itself. */
  selfRequest: boolean;
  autonomous: boolean;
  /** The manager's effective trust level on internal writes (0–3). */
  trust: number;
  /** Every member the card touches is the manager or in its reporting line. */
  inLine: boolean;
  /** Scope widening: the scopes are all within the manager's holdings. */
  withinHoldings?: boolean;
  /** Terminate: the member leads nobody. */
  leadsNobody?: boolean;
  /** USD the manager may still commit in its unit (null = unknown → no money). */
  unitHeadroomUsd: number | null;
  /** A role delegation of this kind covers the manager (and the card is delegable). */
  delegated: boolean;
  /** A person (not an agent) holds the card: trust and mode do not apply. */
  human?: boolean;
}

export const MANAGER_TRUST_FLOOR = 2;

/** The decision: may this manager approve or reject the card? Pure. */
export function authorityFor(i: AuthorityInput): { decide: boolean; reason: string } {
  const no = (reason: string) => ({ decide: false, reason });
  if (i.selfRequest) return no('you raised it: nobody approves their own request — escalate it');
  if (i.reserved) return no(`CEO-reserved (${i.reserved}): recommend and escalate, or send it back`);
  if (i.delegated) return { decide: true, reason: 'the owner delegated this kind to your role' };
  if (!i.human && i.trust < MANAGER_TRUST_FLOOR) return no(`your trust on internal writes is ${i.trust} (below ${MANAGER_TRUST_FLOOR}): recommend and escalate`);
  const row = AUTHORITY_TABLE.find((r) => r.kind === i.kind);
  if (!row || row.manager === 'recommend') return no(`a ${i.kind.replace(/_/g, ' ')} card is beyond a manager's authority: recommend and escalate`);
  if (!i.inLine) return no('it touches members outside your reporting line: escalate it');
  if (row.manager === 'decide') return { decide: true, reason: row.when };
  if (!i.autonomous && !i.human) return no('the company is supervised: structural changes are the CEO\'s — recommend and escalate');
  const amount = amountUsdOf(i.kind, i.payload);
  const money = isMoneyCard(i.kind, i.payload) || (amount !== null && amount > 0);
  if (money) {
    if (amount === null || i.unitHeadroomUsd === null) return no('money of an unknown amount, or no unit budget to hold it: escalate');
    if (amount > i.unitHeadroomUsd + 1e-9) return no(`$${amount.toFixed(2)}/month is beyond your unit's headroom ($${Math.max(0, i.unitHeadroomUsd).toFixed(2)}): escalate`);
  }
  if (i.kind === 'scope_widen' && !i.withinHoldings) return no('it grants scopes you do not hold yourself: escalate');
  if (i.kind === 'terminate' && !i.leadsNobody) return no('the member leads others: a unit lead\'s termination is the chief\'s or the CEO\'s');
  if (i.kind === 'member_settings' && i.payload.boundary) return no('a folder change is reserved: escalate');
  return { decide: true, reason: row.when };
}

/** The boundary row a card stands for, for the `delegable` check (mirrors
 *  org-seat.service's changeOfCard without importing it). */
export function changeKindOf(kind: string, payload: Record<string, unknown>): { kind: ChangeKind; withinUnit?: boolean; withinEnvelope?: boolean; key?: string } | null {
  switch (kind) {
    case 'tune': return { kind: 'tunable', key: String(payload.key ?? '') };
    case 'hire': return { kind: 'hire', withinUnit: payload.boundary !== 'experiment' };
    case 'reorg': return { kind: 'reorg', withinUnit: payload.boundary !== 'experiment' };
    case 'terminate': return { kind: 'terminate', withinUnit: payload.boundary !== 'experiment' };
    case 'scope_widen': return { kind: 'scope_widen' };
    case 'budget_raise': return { kind: 'budget', withinEnvelope: String(payload.scope ?? 'company') !== 'company' };
    default: return null;
  }
}

export function boundaryDelegable(kind: string, payload: Record<string, unknown>): boolean {
  const ch = changeKindOf(kind, payload);
  return ch ? ruleFor(ch).delegable : kind !== 'two_key' && kind !== 'metric_source';
}

/** Hours a hop may wait before the card climbs on its own. */
export function hopWindowHours(tunables: { hop: number; urgentHop: number }, urgency: string): number {
  return urgency === 'urgent' ? Math.min(tunables.urgentHop, tunables.hop) : tunables.hop;
}

export function parseChain(raw: string | null | undefined): DecisionHop[] {
  try { const v = JSON.parse(raw || '[]') as unknown; return Array.isArray(v) ? v as DecisionHop[] : []; } catch { return []; }
}

/** "Writer → Head of Content → Chief → you": the requester and every holder in order. */
export function chainLine(hops: DecisionHop[], nameOf: (holder: string) => string, opts: { you?: Holder } = {}): string {
  const seq: string[] = [];
  for (const h of hops) {
    if (seq.length === 0) seq.push(h.by);
    if (h.to && seq.at(-1) !== h.to) seq.push(h.to);
  }
  return seq.map((x) => (x === (opts.you ?? CEO) ? 'you' : nameOf(x))).join(' → ');
}
