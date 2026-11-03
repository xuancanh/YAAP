/**
 * OrgDecisionsService — decisions go to the direct manager first
 * (docs/owners-seat.md §7).
 *
 * The owner: "by default a decision should go to the direct manager, not to
 * the CEO. The manager then decides whether it needs to go further." Every
 * card an org member raises (an approval, an escalation, a held outward
 * action's two-key card) is placed with the member's direct manager — a
 * specialist's head, a head's chief of staff, the chief's CEO, or the person
 * the member reports to (`org_members.reportsToHumanId`). The holder:
 *
 *  - **decides** it when the card is within its authority (`authorityFor`
 *    in decision-routing.ts: boundary row, mode, reporting line, unit
 *    budget, trust, delegations); a manager on the requester's model family
 *    approving money passes an independent review on another family first;
 *  - **sends it back** to the requester with guidance;
 *  - **escalates** it one level with its recommendation and reasoning,
 *    which travel with the card.
 *
 * CEO-reserved cards (`reservedOf`) climb through every manager for their
 * recommendations, but no manager decides them. A hop that waits longer
 * than `seat.hopTimeoutHours` (urgent: `seat.urgentHopTimeoutHours`) climbs
 * on its own with "no recommendation (timed out)", so nothing stalls; at
 * the CEO the card gets a fresh deadline and its default (owners-seat §1).
 * Nobody approves their own request. Every hop is on the card (`chain`) and
 * in the audit chain (`decision_hop`). Two-key actions still need the
 * owner's key: routing only changes who reviews first.
 *
 * Manager agents see their cards in the heartbeat (a reason and a
 * "Decisions for you" context block), on their agent page's Work card, and
 * through `org_decisions` / `org_decide`; people see theirs in the Inbox.
 */
import { BadRequestException, ForbiddenException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { and, eq, ne } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { orgApprovals, orgDelegations } from '../database/schema';
import { nowIso } from '../common/ids.util';
import { currentAccountId } from '../accounts/account-context';
import { AgentsService } from '../agents/agents.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { TrustService } from '../actions/trust.service';
import { HeartbeatService } from '../chats/heartbeat.service';
import { TriggerBus } from '../chats/trigger-bus';
import { OrgService, type Organization, type OrgMember } from './org.service';
import { OrgApprovalsService, summarize, type OrgApproval } from './org-approvals.service';
import { OrgTasksService, familyOf } from './org-tasks.service';
import { OrgAuditService } from './org-audit.service';
import { OrgRuntimeService } from './org-runtime.service';
import { OrgUnitsService } from './org-units.service';
import { meetScopes, parseScopes } from './scopes';
import { amountUsdOf, isMoneyCard } from './decision-cards';
import { govTunable } from './governance-tunables';
import {
  AUTHORITY_TABLE, CEO, agentOfActor, authorityFor, boundaryDelegable, chainLine, holderAgent, holderHuman, hopWindowHours, nextHolder, parseChain,
  reservedOf, routeDecision as routePure, type DecisionHop, type Holder, type RouteHuman,
} from './decision-routing';

export type ManagerAction = 'approve' | 'reject' | 'send_back' | 'escalate';

/** A card as its holder sees it. */
export interface HeldDecision {
  approval: OrgApproval;
  summary: string;
  requester: string;
  chain: DecisionHop[];
  chainLine: string;
  mayDecide: boolean;
  why: string;
}

/** An independent review of a manager's same-family money approval (test seam). */
export type IndependentReview = (input: { org: Organization; approval: OrgApproval; managerAgentId: string; requesterAgentId: string }) => Promise<{ verdict: 'allow' | 'ask' | 'deny'; reason: string } | null>;

const H = 3_600_000;

@Injectable()
export class OrgDecisionsService {
  private readonly logger = new Logger(OrgDecisionsService.name);
  /** Test seam: the independent reviewer (default: OrgRuntimeService.judge on another family). */
  independentFn?: IndependentReview;

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly org: OrgService,
    private readonly approvals: OrgApprovalsService,
    private readonly tasks: OrgTasksService,
    private readonly audit: OrgAuditService,
    private readonly agents: AgentsService,
    private readonly workspaces: WorkspacesService,
    @Optional() private readonly runtime?: OrgRuntimeService,
    @Optional() private readonly units?: OrgUnitsService,
    @Optional() private readonly trust?: TrustService,
    @Optional() private readonly heartbeat?: HeartbeatService,
    @Optional() private readonly bus?: TriggerBus,
  ) {
    approvals.setRouter((orgId, a) => this.place(orgId, a));
    tasks.setEscalationRouter(async (orgId, approvalId) => {
      const a = await this.place(orgId, await this.approvals.get(orgId, approvalId));
      if (a.holder === CEO) await this.approvals.arrived(orgId, a);
      return { holderName: a.holder === CEO ? null : await this.nameOf(orgId, a.holder) };
    });
    approvals.onDecided((ev) => this.onDecided(ev.orgId, ev.approval, ev.decision, ev.decidedBy));
    runtime?.addTicker({ name: 'decision-hops', everyMinutes: 1, fn: (org, now) => this.timeouts(org.id, now).then(() => undefined) });
    runtime?.bindDecisions({ list: (orgId, agentId) => this.describeFor(orgId, `agent:${agentId}`), act: (orgId, agentId, input) => this.act(orgId, input.approvalId, `agent:${agentId}`, input.action, input) });
    runtime?.onBreaker(async (ev) => { if (ev.kind === 'budget_stop') await this.breakerToManager(ev.orgId, ev.agentId, ev.detail).catch(() => undefined); });
    heartbeat?.addReasonProvider({ name: 'decisions', reasons: (agentId) => this.heartbeatReasons(agentId) });
    heartbeat?.addContextProvider({ name: 'decisions', context: (agentId) => this.heartbeatContext(agentId) });
  }

  // ---- routing ----

  private async chart(orgId: string) {
    const org = await this.org.get(orgId);
    const members = (await this.org.members(orgId)).filter((m) => m.status !== 'terminated');
    const humansRows = await this.org.humans(orgId);
    // The owner is the CEO whether or not a row names them.
    const humans: RouteHuman[] = [...humansRows.map((h) => ({ memberAccountId: h.memberAccountId, role: h.role })), ...(humansRows.some((h) => h.memberAccountId === currentAccountId()) ? [] : [{ memberAccountId: currentAccountId(), role: 'ceo' }])];
    const employees = humansRows.filter((h) => h.role === 'employee').map((h) => ({ memberAccountId: h.memberAccountId, reportsToAgentId: h.reportsToAgentId }));
    return { org, members, humans, employees };
  }

  /**
   * Where a decision raised by `fromAgentId` goes first, and the chain above
   * it — for the work-tracking's blocked-on-manager and the inbox. Pure in
   * effect (reads the chart, writes nothing).
   */
  async routeDecision(orgId: string, fromAgentId: string | null, kind: string, payload: Record<string, unknown> = {}): Promise<{ holder: Holder; holderName: string; chain: Array<{ holder: Holder; name: string }>; reserved: string }> {
    const c = await this.chart(orgId);
    const r = routePure({ org: c.org, members: c.members, humans: c.humans, employees: c.employees, fromAgentId, kind, payload });
    const names = await this.namer(orgId);
    return { holder: r.holder, holderName: names(r.holder), chain: r.chain.map((h) => ({ holder: h, name: names(h) })), reserved: r.reserved };
  }

  /** Place a new card with the requester's manager (the approvals router). */
  private async place(orgId: string, a: OrgApproval): Promise<OrgApproval> {
    if (a.status !== 'pending') return a;
    const c = await this.chart(orgId);
    const payload = JSON.parse(a.payload || '{}') as Record<string, unknown>;
    const from = agentOfActor(a.requestedBy, c.org);
    // A card addressed to a named person (human review) and the owner's own cards stay where they are.
    const routable = a.kind !== 'human_review' && from !== null && c.members.some((m) => m.agentId === from);
    const r = routePure({ org: c.org, members: c.members, humans: c.humans, employees: c.employees, fromAgentId: routable ? from : null, kind: a.kind, payload });
    const urgency = a.urgency === 'urgent' || a.kind === 'two_key' || payload.urgency === 'urgent' ? 'urgent' : 'normal';
    const now = new Date();
    const hop: DecisionHop = { at: now.toISOString(), action: 'raised', by: routable ? `agent:${from}` : a.requestedBy || 'system', from: '', to: r.holder, ...(a.recommendation ? { reasoning: a.recommendation.slice(0, 600), recommendation: (a.recommendedAction || '') as DecisionHop['recommendation'] } : {}) };
    const patch: Partial<OrgApproval> = { holder: r.holder, holderSince: now.toISOString(), chain: JSON.stringify([hop]), reserved: r.reserved, urgency };
    if (r.holder !== CEO) {
      patch.hopDeadline = new Date(now.getTime() + this.hopHours(c.org, urgency) * H).toISOString();
    }
    await this.db.update(orgApprovals).set(patch).where(eq(orgApprovals.id, a.id));
    await this.audit.append(orgId, { actor: hop.by, action: 'decision_hop', refType: 'approval', refId: a.id, payload: { hop: 'raised', kind: a.kind, to: r.holder, reserved: r.reserved || undefined, urgency } });
    const placed = await this.approvals.get(orgId, a.id);
    if (r.holder !== CEO) await this.notifyHolder(orgId, placed, r.holder);
    return placed;
  }

  private hopHours(org: Organization, urgency: string): number {
    return hopWindowHours({ hop: govTunable(org, 'seat.hopTimeoutHours'), urgentHop: govTunable(org, 'seat.urgentHopTimeoutHours') }, urgency);
  }

  /** Tell the new holder: a manager agent's inbox (origin `org`, which its
   *  heartbeat surfaces), or a person's Inbox (routed through the chief's
   *  inbox, addressed to them alone). */
  private async notifyHolder(orgId: string, a: OrgApproval, holder: Holder): Promise<void> {
    const org = await this.org.get(orgId);
    const payload = JSON.parse(a.payload || '{}') as Record<string, unknown>;
    const names = await this.namer(orgId);
    const title = `Decision for you (${a.kind.replace(/_/g, ' ')}): ${summarize(a.kind, payload)}`.slice(0, 200);
    const body = `From ${names(agentOfActor(a.requestedBy, org) ? `agent:${agentOfActor(a.requestedBy, org)}` : a.requestedBy)}.${a.reserved ? ` CEO-reserved (${a.reserved}): recommend and escalate.` : ''} Decide within your authority, send it back with guidance, or escalate it with your recommendation (org_decide). It climbs on its own at ${(a.hopDeadline ?? '').slice(0, 16).replace('T', ' ')} UTC.`;
    const agentId = holderAgent(holder);
    if (agentId) {
      await this.agents.addEvent(agentId, { kind: 'decision', title, body, payload: JSON.stringify({ orgId, approvalId: a.id, kind: a.kind }), origin: 'org' }).catch(() => undefined);
      return;
    }
    const human = holderHuman(holder);
    if (human && org.chiefOfStaffAgentId) {
      await this.agents.addEvent(org.chiefOfStaffAgentId, {
        kind: 'decision', title, body: body.replace(' (org_decide)', ''), payload: JSON.stringify({ orgId, approvalId: a.id, kind: a.kind, action: 'decide' }), origin: 'user', channel: true,
        forMemberAccountId: human === currentAccountId() ? '' : human,
      }).catch(() => undefined);
    }
  }

  // ---- what a holder sees ----

  async heldBy(orgId: string, holder: Holder): Promise<OrgApproval[]> {
    return (await this.db.select().from(orgApprovals).where(and(eq(orgApprovals.orgId, orgId), eq(orgApprovals.status, 'pending'), eq(orgApprovals.holder, holder))))
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }

  /** The cards a holder holds, each with its chain and the holder's authority over it. */
  async describeFor(orgId: string, holder: Holder): Promise<HeldDecision[]> {
    const names = await this.namer(orgId);
    const out: HeldDecision[] = [];
    for (const a of await this.heldBy(orgId, holder)) {
      const auth = await this.authority(orgId, a, holder).catch((err: unknown) => ({ decide: false, reason: err instanceof Error ? err.message : String(err) }));
      const chain = parseChain(a.chain);
      const org = await this.org.get(orgId);
      const req = agentOfActor(a.requestedBy, org);
      out.push({ approval: a, summary: summarize(a.kind, JSON.parse(a.payload || '{}') as Record<string, unknown>), requester: req ? names(`agent:${req}`) : names(a.requestedBy), chain, chainLine: chainLine(chain, names, { you: holder }), mayDecide: auth.decide, why: auth.reason });
    }
    return out;
  }

  /** Every pending card held below the CEO (the owner's "in review by your team"). */
  async inReview(orgId: string): Promise<OrgApproval[]> {
    return this.db.select().from(orgApprovals).where(and(eq(orgApprovals.orgId, orgId), eq(orgApprovals.status, 'pending'), ne(orgApprovals.holder, CEO)));
  }

  // ---- authority ----

  /** May `holder` approve or reject this card? (decision-routing.ts authorityFor with the facts filled in.) */
  async authority(orgId: string, a: OrgApproval, holder: Holder): Promise<{ decide: boolean; reason: string }> {
    const c = await this.chart(orgId);
    const payload = JSON.parse(a.payload || '{}') as Record<string, unknown>;
    const requester = agentOfActor(a.requestedBy, c.org);
    const mgrAgent = holderAgent(holder);
    const mgrHuman = holderHuman(holder);
    const selfRequest = (mgrAgent !== null && requester === mgrAgent) || (mgrHuman !== null && a.requestedBy === `human:${mgrHuman}`);
    const ws = await this.workspaces.get(c.org.workspaceId).catch(() => null);
    const autonomous = ws?.orgMode === 'autonomous';
    // The reporting line under the holder.
    const roots = mgrAgent ? [mgrAgent] : c.members.filter((m) => m.reportsToHumanId === mgrHuman).map((m) => m.agentId);
    const line = lineOf(c.members, roots);
    const subjects = await this.subjectsOf(orgId, a, payload, requester);
    const inLine = subjects.length > 0 && subjects.every((s) => (s === mgrAgent && a.kind === 'hire') || (s !== mgrAgent && line.has(s)));
    let trust = 2;
    if (mgrAgent && this.trust) trust = (await this.trust.effective(c.org.workspaceId, mgrAgent, 'internal_write').catch(() => null))?.effective ?? 2;
    let withinHoldings: boolean | undefined;
    if (a.kind === 'scope_widen') {
      const holdings = mgrAgent ? this.org.scopesOf(c.members.find((m) => m.agentId === mgrAgent)) : [];
      const wanted = parseScopes(payload.scopes);
      withinHoldings = mgrAgent ? meetScopes(holdings, wanted).length === wanted.length : true;
    }
    const target = typeof payload.agentId === 'string' ? payload.agentId : null;
    const leadsNobody = target ? !c.members.some((m) => m.reportsToAgentId === target) : undefined;
    const headroom = mgrAgent ? await this.unitHeadroom(c.org, mgrAgent, line).catch(() => null) : null;
    const delegated = mgrAgent ? await this.delegatedTo(orgId, a, payload, mgrAgent).catch(() => false) : false;
    return authorityFor({
      kind: a.kind, payload, reserved: a.reserved || reservedOf(a.kind, payload), selfRequest, autonomous, trust, inLine, withinHoldings, leadsNobody,
      unitHeadroomUsd: mgrHuman ? null : headroom, delegated, human: Boolean(mgrHuman),
    });
  }

  /** The members a card touches. */
  private async subjectsOf(orgId: string, a: OrgApproval, payload: Record<string, unknown>, requester: string | null): Promise<string[]> {
    const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
    switch (a.kind) {
      case 'hire': return [str(payload.reportsToAgentId)].filter((x): x is string => Boolean(x));
      case 'reorg': return (Array.isArray(payload.changes) ? payload.changes as Array<{ agentId?: string; reportsToAgentId?: string }> : []).flatMap((c) => [c.agentId, c.reportsToAgentId]).filter((x): x is string => Boolean(x));
      case 'escalation': {
        const taskId = str(payload.taskId);
        const t = taskId ? await this.tasks.get(orgId, taskId).catch(() => null) : null;
        return [t?.assigneeAgentId ?? str(payload.assigneeAgentId) ?? requester].filter((x): x is string => Boolean(x));
      }
      case 'cadence': {
        const unitId = str(payload.unitId);
        const unit = unitId && this.units ? await this.units.get(orgId, unitId).catch(() => null) : null;
        return unit?.leadAgentId ? [unit.leadAgentId] : [];
      }
      case 'budget_raise': return String(payload.scope) === 'agent' ? [str(payload.refId)].filter((x): x is string => Boolean(x)) : [];
      default: return [str(payload.agentId) ?? requester].filter((x): x is string => Boolean(x));
    }
  }

  /** USD/month the manager may still commit: the chief the company
   *  envelope less the agent and project envelopes; a unit lead its unit's
   *  allocations less the agent envelopes its line holds; else null. */
  private async unitHeadroom(org: Organization, managerAgentId: string, line: Set<string>): Promise<number | null> {
    const budgets = await this.org.budgets(org.id);
    if (org.chiefOfStaffAgentId === managerAgentId) {
      const ws = await this.workspaces.get(org.workspaceId).catch(() => null);
      const envelope = ws?.orgMonthlyUsd ?? org.monthlyBudgetUsd;
      if (!envelope || envelope <= 0) return null;
      return envelope - budgets.filter((b) => b.scope === 'agent' || b.scope === 'project').reduce((s, b) => s + b.monthlyUsd, 0);
    }
    const unit = this.units ? await this.units.isLead(org.id, managerAgentId) : null;
    if (!unit || !this.units) return null;
    const unitIds = new Set(await this.units.subtree(org.id, unit.id));
    const envelope = (await this.org.allocations(org.id)).filter((x) => x.unitId && unitIds.has(x.unitId)).reduce((s, x) => s + x.monthlyUsd, 0);
    if (envelope <= 0) return null;
    return envelope - budgets.filter((b) => b.scope === 'agent' && line.has(b.refId)).reduce((s, b) => s + b.monthlyUsd, 0);
  }

  /** A role delegation (docs/owners-seat.md §2) of this card's kind to the manager's role. */
  private async delegatedTo(orgId: string, a: OrgApproval, payload: Record<string, unknown>, agentId: string): Promise<boolean> {
    if (!boundaryDelegable(a.kind, payload)) return false;
    const rows = (await this.db.select().from(orgDelegations).where(eq(orgDelegations.orgId, orgId))).filter((d) => !d.revokedAt && d.delegateType === 'role');
    const m = await this.org.member(orgId, agentId);
    if (!m) return false;
    const title = m.title.toLowerCase();
    return rows.some((d) => (d.delegateRef === title) && (d.kind === a.kind || (d.kind === 'money' && isMoneyCard(a.kind, payload))) && (d.maxUsd === null || (amountUsdOf(a.kind, payload) ?? Infinity) <= d.maxUsd + 1e-9));
  }

  // ---- acting on a card ----

  /**
   * The holder acts: approve or reject (within its authority), send back to
   * the requester with guidance, or escalate one level with a
   * recommendation. `holder` must hold the card now.
   */
  async act(orgId: string, approvalId: string, holder: Holder, action: ManagerAction, input: { recommendation?: string; reasoning?: string; note?: string } = {}): Promise<string> {
    const a = await this.approvals.byPrefix(orgId, approvalId);
    if (a.status !== 'pending') throw new BadRequestException(`that card is ${a.status}`);
    if (a.holder !== holder) throw new ForbiddenException(`that card is not yours to act on — ${a.holder === CEO ? 'it is with the CEO' : `it is with ${await this.nameOf(orgId, a.holder)}`}`);
    const reasoning = (input.reasoning ?? input.note ?? '').trim().slice(0, 1_000);
    const rec = normalizeRec(input.recommendation);
    const org = await this.org.get(orgId);
    const mgrAgent = holderAgent(holder);
    const requester = agentOfActor(a.requestedBy, org);
    if (action === 'escalate') {
      await this.climb(orgId, a, holder, 'escalated', rec, reasoning || 'escalated without a note');
      const after = await this.approvals.get(orgId, a.id);
      return `Escalated to ${after.holder === CEO ? 'the CEO' : await this.nameOf(orgId, after.holder)} with your recommendation (${rec || 'none'}).`;
    }
    if (action === 'send_back') {
      if (a.kind === 'two_key') throw new BadRequestException('a held outward action is the owner\'s key to give or refuse: escalate it with your recommendation');
      if (!reasoning) throw new BadRequestException('send_back needs guidance for the requester (reasoning)');
      await this.hop(orgId, a, { action: 'sent_back', by: holder, from: holder, to: holder, reasoning, decision: 'revise' });
      await this.approvals.decide(orgId, a.id, 'revise', reasoning, holder, holder, { via: `manager:${holder}` });
      await this.tellRequester(orgId, a, `Sent back by ${await this.nameOf(orgId, holder)}: ${reasoning}`);
      return `Sent back to ${requester ? await this.nameOf(orgId, `agent:${requester}`) : 'the requester'} with your guidance.`;
    }
    // approve / reject
    const auth = await this.authority(orgId, a, holder);
    if (!auth.decide) throw new ForbiddenException(`not within your authority: ${auth.reason}`);
    let sameModel = false;
    if (mgrAgent && requester) {
      const [m, r] = await Promise.all([this.agents.get(mgrAgent).catch(() => null), this.agents.get(requester).catch(() => null)]);
      sameModel = Boolean(m && r && familyOf(m) === familyOf(r));
    }
    const payload = JSON.parse(a.payload || '{}') as Record<string, unknown>;
    // The co-signer rule: money approved by a manager on the requester's own family needs an independent yes.
    if (action === 'approve' && sameModel && isMoneyCard(a.kind, payload) && mgrAgent && requester) {
      const v = await (this.independentFn ? this.independentFn({ org, approval: a, managerAgentId: mgrAgent, requesterAgentId: requester }) : this.judgeIndependent(org, a, payload, mgrAgent)).catch(() => null);
      await this.audit.append(orgId, { actor: 'system', action: 'decision_independent_review', refType: 'approval', refId: a.id, payload: { verdict: v?.verdict ?? 'none', reason: (v?.reason ?? 'no independent reviewer').slice(0, 300), manager: mgrAgent } });
      if (!v || v.verdict !== 'allow') {
        await this.climb(orgId, a, holder, 'escalated', 'approve', `${reasoning ? `${reasoning} — ` : ''}independent review (the manager runs on the requester's model family) did not confirm: ${v?.reason ?? 'no reviewer on another family'}`);
        return 'Your approval needs an independent review because you run on the requester\'s model family; it did not confirm, so the card went up with your recommendation.';
      }
    }
    const decision = action === 'approve' ? 'approve' : 'reject';
    await this.hop(orgId, a, { action: 'decided', by: holder, from: holder, to: holder, decision, reasoning, ...(sameModel ? { sameModel: true } : {}) });
    const res = await this.approvals.decide(orgId, a.id, decision, reasoning || `${decision}d by the manager`, holder, holder, { via: `manager:${holder}` });
    if (res.approval.status === 'pending') return 'The card is still pending.';
    await this.tellRequester(orgId, a, `${decision === 'approve' ? 'Approved' : 'Rejected'} by ${await this.nameOf(orgId, holder)}${reasoning ? `: ${reasoning}` : ''}`);
    return `${decision === 'approve' ? 'Approved' : 'Rejected'}${sameModel ? ' (flagged: you run on the requester\'s model family)' : ''}. ${auth.reason}.`;
  }

  /** Move a card one level up (or to the CEO), with the hop on the card and in the audit. */
  private async climb(orgId: string, a: OrgApproval, from: Holder, action: 'escalated' | 'timed_out', rec: DecisionHop['recommendation'], reasoning: string): Promise<void> {
    const c = await this.chart(orgId);
    let to = nextHolder(from, c.members, c.humans, c.org, c.employees) ?? CEO;
    if (to === from) to = CEO;
    // Never hand a card to the member who raised it.
    const requester = agentOfActor(a.requestedBy, c.org);
    while (to !== CEO && holderAgent(to) === requester) to = nextHolder(to, c.members, c.humans, c.org, c.employees) ?? CEO;
    const now = new Date();
    await this.hop(orgId, a, { action, by: action === 'timed_out' ? 'system' : from, from, to, recommendation: rec, reasoning });
    const patch: Partial<OrgApproval> = { holder: to, holderSince: now.toISOString(), hopDeadline: null };
    if (to === CEO) {
      // A fresh window at the CEO: the card's deadline and default start now.
      const deadline = new Date(now.getTime() + govTunable(c.org, 'seat.deadlineHours') * H);
      patch.deadline = deadline.toISOString();
      const expires = new Date(deadline.getTime() + 24 * H).toISOString();
      if (!a.expiresAt || a.expiresAt < expires) patch.expiresAt = expires;
    } else {
      patch.hopDeadline = new Date(now.getTime() + this.hopHours(c.org, a.urgency) * H).toISOString();
    }
    await this.db.update(orgApprovals).set(patch).where(and(eq(orgApprovals.id, a.id), eq(orgApprovals.status, 'pending')));
    const moved = await this.approvals.get(orgId, a.id);
    const payload = JSON.parse(a.payload || '{}') as Record<string, unknown>;
    if (a.kind === 'escalation' && typeof payload.taskId === 'string') await this.tasks.addBlocker(orgId, payload.taskId, to === CEO ? `escalated: ${String(payload.reason ?? '')}` : `escalated to ${await this.nameOf(orgId, to)}: ${String(payload.reason ?? '')}`).catch(() => undefined);
    if (to === CEO) await this.approvals.arrived(orgId, moved);
    else await this.notifyHolder(orgId, moved, to);
  }

  private async hop(orgId: string, a: OrgApproval, h: Omit<DecisionHop, 'at'>): Promise<void> {
    const fresh = await this.approvals.get(orgId, a.id);
    const hop: DecisionHop = { at: nowIso(), ...h, ...(h.reasoning ? { reasoning: h.reasoning.slice(0, 1_000) } : {}) };
    const chain = [...parseChain(fresh.chain), hop].slice(-30);
    await this.db.update(orgApprovals).set({ chain: JSON.stringify(chain) }).where(eq(orgApprovals.id, a.id));
    await this.audit.append(orgId, { actor: h.by, action: 'decision_hop', refType: 'approval', refId: a.id, payload: { hop: h.action, kind: a.kind, from: h.from, to: h.to, recommendation: h.recommendation || undefined, decision: h.decision, reasoning: h.reasoning?.slice(0, 300), sameModel: h.sameModel || undefined } });
  }

  private async tellRequester(orgId: string, a: OrgApproval, text: string): Promise<void> {
    const org = await this.org.get(orgId);
    const requester = agentOfActor(a.requestedBy, org);
    const payload = JSON.parse(a.payload || '{}') as Record<string, unknown>;
    if (requester) await this.agents.addEvent(requester, { kind: 'info', title: `${a.kind.replace(/_/g, ' ')}: ${text}`.slice(0, 200), body: summarize(a.kind, payload), payload: JSON.stringify({ orgId, approvalId: a.id }), origin: 'org' }).catch(() => undefined);
    if (typeof payload.taskId === 'string') {
      await this.tasks.comment(orgId, payload.taskId, { text: text.slice(0, 1_000), fromAgentId: null, wake: true, system: true }).catch(() => undefined);
    }
  }

  /** The independent reviewer on another family (the co-signer's rule). */
  private async judgeIndependent(org: Organization, a: OrgApproval, payload: Record<string, unknown>, managerAgentId: string): Promise<{ verdict: 'allow' | 'ask' | 'deny'; reason: string } | null> {
    if (!this.runtime) return null;
    const r = await this.runtime.judge(org, managerAgentId, {
      userRequest: `A manager approves a ${a.kind} card: ${summarize(a.kind, payload)}. Should it be approved?`,
      conversationSummary: `Requester's recommendation: ${a.recommendation || '(none)'}`,
      call: { name: 'org_decide', input: { kind: a.kind, payload } },
      origin: 'loop',
    });
    if (!r || r.single) return null;
    return { verdict: r.verdict, reason: r.reason };
  }

  /** After any decision (CEO, delegate, default, manager): the final hop. */
  private async onDecided(orgId: string, a: OrgApproval, decision: string, decidedBy: string): Promise<void> {
    const chain = parseChain((await this.approvals.get(orgId, a.id).catch(() => a)).chain);
    if (chain.at(-1)?.action === 'decided' || chain.at(-1)?.action === 'sent_back') return;
    if (chain.length === 0) return;
    const by = a.decidedVia === 'default' || decidedBy === 'default' ? 'system' : decidedBy === currentAccountId() ? CEO : decidedBy.startsWith('agent:') || decidedBy.startsWith('human:') ? decidedBy : `human:${decidedBy}`;
    await this.hop(orgId, a, { action: 'decided', by, from: a.holder || CEO, to: a.holder || CEO, decision });
  }

  // ---- the tick: hops that waited too long climb ----

  async timeouts(orgId: string, now = new Date()): Promise<number> {
    const due = (await this.inReview(orgId)).filter((a) => a.hopDeadline && a.hopDeadline <= now.toISOString());
    for (const a of due) {
      await this.climb(orgId, a, a.holder, 'timed_out', '', 'no recommendation (timed out)').catch((err) => this.logger.warn(`decision hop timeout for ${a.id} failed: ${err instanceof Error ? err.message : err}`));
    }
    return due.length;
  }

  // ---- budget breakers go to the manager too ----

  private async breakerToManager(orgId: string, agentId: string, detail: string): Promise<void> {
    const r = await this.routeDecision(orgId, agentId, 'budget_raise', { scope: 'agent', refId: agentId });
    const mgr = holderAgent(r.holder);
    if (!mgr) return;
    await this.agents.addEvent(mgr, { kind: 'decision', title: `${await this.nameOf(orgId, `agent:${agentId}`)} hit its budget stop`.slice(0, 200), body: `${detail.slice(0, 600)} Raise its envelope within your unit (org_allocate_budget, where you may), pause it, or escalate.`, payload: JSON.stringify({ orgId, agentId, breaker: 'budget_stop' }), origin: 'org' }).catch(() => undefined);
  }

  // ---- the manager's heartbeat ----

  async heartbeatReasons(agentId: string): Promise<string[]> {
    const out: string[] = [];
    for (const m of (await this.org.membershipsOf(agentId)).filter((x) => x.status === 'active')) {
      for (const d of await this.describeFor(m.orgId, `agent:${agentId}`)) {
        out.push(`decision for you [${d.approval.id.slice(0, 8)}]: ${d.approval.kind.replace(/_/g, ' ')} — ${d.summary.slice(0, 120)} from ${d.requester}${d.mayDecide ? '' : ' (recommend and escalate)'}; climbs at ${(d.approval.hopDeadline ?? '').slice(11, 16)} UTC (org_decide)`);
      }
    }
    return out.slice(0, 5);
  }

  async heartbeatContext(agentId: string): Promise<string | null> {
    const lines: string[] = [];
    for (const m of (await this.org.membershipsOf(agentId)).filter((x) => x.status === 'active')) {
      const held = await this.describeFor(m.orgId, `agent:${agentId}`);
      if (held.length === 0) continue;
      lines.push('Decisions for you (your reports raised them; you are their first reviewer):');
      for (const d of held.slice(0, 8)) {
        const recs = d.chain.filter((h) => h.recommendation || h.reasoning).map((h) => `${h.action === 'raised' ? 'requester' : h.by}: ${h.recommendation || '—'}${h.reasoning ? ` (${h.reasoning.slice(0, 120)})` : ''}`);
        lines.push(`- [${d.approval.id.slice(0, 8)}] ${d.approval.kind}: ${d.summary.slice(0, 160)} — chain ${d.chainLine}. ${d.mayDecide ? `You may decide it: ${d.why}.` : `Not yours to decide: ${d.why}.`}${recs.length ? ` Recommendations so far: ${recs.join('; ')}.` : ''}`);
      }
      lines.push('Use org_decide: approve or reject within your authority; send_back with guidance; or escalate with your recommendation and reasoning. Never sit on a card: it climbs on its own with "no recommendation" when its window ends.');
    }
    return lines.length ? lines.join('\n') : null;
  }

  // ---- names ----

  private async namer(orgId: string): Promise<(holder: string) => string> {
    const org = await this.org.get(orgId);
    const names = new Map((await this.agents.list()).map((a) => [a.id, a.name]));
    const humans = await this.org.humans(orgId);
    return (h: string) => {
      if (h === CEO || h === 'user') return 'CEO';
      if (h === 'chief') return names.get(org.chiefOfStaffAgentId ?? '') ?? 'Chief of staff';
      const a = holderAgent(h);
      if (a) return names.get(a) ?? a.slice(0, 8);
      const p = holderHuman(h);
      if (p) { const row = humans.find((x) => x.memberAccountId === p); return row?.title ? `${row.title}` : p === currentAccountId() ? 'CEO' : `a person (${p.slice(0, 8)})`; }
      if (h === 'system') return 'System';
      return h;
    };
  }

  async nameOf(orgId: string, holder: string): Promise<string> {
    return (await this.namer(orgId))(holder);
  }

  /** The chain for display: each hop with names (Home, the Inbox). */
  async chainView(orgId: string, a: OrgApproval, you: Holder = CEO): Promise<{ line: string; hops: Array<DecisionHop & { byName: string; toName: string }> }> {
    const names = await this.namer(orgId);
    const hops = parseChain(a.chain);
    return { line: chainLine(hops, names, { you }), hops: hops.map((h) => ({ ...h, byName: names(h.by), toName: names(h.to) })) };
  }

  /** Cards with their chain for display (`GET …/approvals`): the line
   *  ("Writer → Head of Content → Chief → you") and every hop with names. */
  async withChains<T extends OrgApproval>(orgId: string, rows: T[], you: Holder = CEO): Promise<Array<T & { chainLine: string; chainHops: Array<DecisionHop & { byName: string; toName: string }>; holderName: string; forYou: boolean }>> {
    const names = await this.namer(orgId);
    return rows.map((a) => {
      const hops = parseChain(a.chain);
      const holder = a.holder || CEO;
      // forYou: it waits on the viewer — held by them, or with the CEO (whose cards board members and delegates may also decide).
      return { ...a, chainLine: chainLine(hops, names, { you }), chainHops: hops.map((h) => ({ ...h, byName: names(h.by), toName: names(h.to) })), holderName: names(holder), forYou: holder === you || holder === CEO };
    });
  }

  /** The table for `GET …/org/decisions/authority`. */
  authorityTable() { return AUTHORITY_TABLE.map((r) => ({ ...r })); }
}

function normalizeRec(v: unknown): DecisionHop['recommendation'] {
  const s = String(v ?? '').trim().toLowerCase();
  return s === 'approve' || s === 'deny' || s === 'modify' ? s : s === 'reject' ? 'deny' : '';
}

/** The reporting line under `roots` (the roots included). */
function lineOf(members: OrgMember[], roots: string[]): Set<string> {
  const out = new Set(roots);
  for (let grew = true; grew;) { grew = false; for (const x of members) if (x.reportsToAgentId && out.has(x.reportsToAgentId) && !out.has(x.agentId)) { out.add(x.agentId); grew = true; } }
  return out;
}
