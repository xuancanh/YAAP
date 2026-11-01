/**
 * OrgSeatService — the owner's seat: exceptions, not approvals
 * (docs/owners-seat.md, execution-plan item 31, capability C12).
 *
 *  1. **Decision cards.** Every approval carries a recommendation, the
 *     alternatives, reversibility, a confidence, a deadline and a default
 *     action (decision-cards.ts; written by OrgApprovalsService.create, or
 *     filled here for cards another path wrote without them). The tick
 *     applies the default at the deadline — with an audit row and an inbox
 *     note ("approved by default at your deadline") — and never approves an
 *     irreversible or money card by default.
 *  2. **Delegated approvals.** `org_delegations`: cards of a kind (or an
 *     action class), optionally up to `maxUsd`, may be decided by a human
 *     member or by an agent role (e.g. "controller"). An agent delegate
 *     decides through a tool-free judgment on another model family than the
 *     proposer (`OrgRuntimeService.judge`, like the co-signer); "ask" leaves
 *     the card to the CEO. Every delegated decision is audited and listed in
 *     the brief. The constitution, caps, the kill switch, the external floor
 *     and trust ceilings are never delegable (the boundary table's
 *     `delegable`), and creating a delegation is the owner's act.
 *  3. **Value accounting.** A key result's value per unit of measured
 *     movement (and a fixed value on achieving) turns its metric samples into
 *     `org_value_events`; the brief opens with **Outcomes** — measured
 *     movement and value realised against spend (ROI) per objective.
 *  4. **Outcome or shrink** (principle 6). A unit whose objectives showed no
 *     measured movement for `seat.noOutcomeWeeks` gets a `no_outcome` signal,
 *     and the chief's next planning run is told to shrink it through an
 *     experiment or a proposal — never an automatic cut.
 *
 * Defaults, matching, value and the no-outcome rule are model-free.
 */
import { BadRequestException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { and, asc, desc, eq, gte } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { orgDelegations, orgGoals, orgMetricSamples, orgValueEvents } from '../database/schema';
import { newId, nowIso } from '../common/ids.util';
import { currentAccountId } from '../accounts/account-context';
import { AgentsService } from '../agents/agents.service';
import { ACTION_CLASSES } from '../actions/action-classes';
import { OrgService, type Organization, type OrgGoal } from './org.service';
import { OrgApprovalsService, APPROVAL_KINDS, summarize, type OrgApproval } from './org-approvals.service';
import { OrgAuditService } from './org-audit.service';
import { OrgRuntimeService } from './org-runtime.service';
import { OrgBriefService } from './org-brief.service';
import { OrgSignalsService } from './org-signals.service';
import { OrgUnitsService } from './org-units.service';
import { OrgCapitalService } from './org-capital.service';
import { amountUsdOf, isMoneyCard, reversibilityOf } from './decision-cards';
import { ruleFor, type SelfChange } from './boundary';
import { roleKeyOf } from './org-evals.service';
import { govTunable } from './governance-tunables';

export type OrgDelegation = typeof orgDelegations.$inferSelect;
export type OrgValueEvent = typeof orgValueEvents.$inferSelect;

/** Kinds a delegation may never name: the boundary's non-delegable families. */
export const NON_DELEGABLE = ['constitution', 'caps', 'kill_switch', 'external_floor', 'trust_ceiling', 'audit_settings', 'delegation'] as const;

/** The self-change a card stands for, so the boundary's `delegable` decides. */
export function changeOfCard(a: Pick<OrgApproval, 'kind'>, payload: Record<string, unknown>): SelfChange | null {
  switch (a.kind) {
    case 'tune': return { kind: 'tunable', key: String(payload.key ?? '') };
    case 'routing': return { kind: 'routing' };
    case 'cadence': return { kind: 'cadence' };
    case 'charter_change': return { kind: 'charter' };
    case 'hire': return { kind: 'hire', withinUnit: payload.boundary !== 'experiment' };
    case 'reorg': return { kind: 'reorg', withinUnit: payload.boundary !== 'experiment' };
    case 'terminate': return { kind: 'terminate', withinUnit: payload.boundary !== 'experiment' };
    case 'scope_widen': return { kind: 'scope_widen' };
    case 'budget_raise': return { kind: 'budget', withinEnvelope: String(payload.scope ?? 'company') !== 'company' };
    case 'metric_source': return { kind: 'external_floor' };
    default: return null;
  }
}

/** Whether a card may be decided by a delegate at all. Pure. */
export function cardDelegable(a: Pick<OrgApproval, 'kind'>, payload: Record<string, unknown>): boolean {
  const ch = changeOfCard(a, payload);
  if (a.kind === 'metric_source') return false;
  return ch ? ruleFor(ch).delegable : true;
}

/** Whether a delegation covers a card (kind or class, and the amount). Pure. */
export function delegationCovers(d: Pick<OrgDelegation, 'kind' | 'maxUsd' | 'revokedAt'>, a: Pick<OrgApproval, 'kind' | 'status'>, payload: Record<string, unknown>): boolean {
  if (d.revokedAt || a.status !== 'pending') return false;
  const kindMatch = d.kind === a.kind || (a.kind === 'two_key' && String(payload.class ?? '') === d.kind) || (d.kind === 'money' && isMoneyCard(a.kind, payload));
  if (!kindMatch) return false;
  if (d.maxUsd !== null && d.maxUsd !== undefined) {
    const amount = amountUsdOf(a.kind, payload);
    if (amount === null || amount > d.maxUsd + 1e-9) return false;
  }
  return cardDelegable(a, payload);
}

export type DelegateDecider = (input: { org: Organization; approval: OrgApproval; payload: Record<string, unknown>; delegateAgentId: string; roleKey: string }) => Promise<{ verdict: 'approve' | 'reject' | 'ask'; reason: string }>;

const WEEK_MS = 7 * 86_400_000;

@Injectable()
export class OrgSeatService {
  private readonly logger = new Logger(OrgSeatService.name);
  /** Test seam: an agent delegate's decision (default: the independent reviewer on another family). */
  delegateFn?: DelegateDecider;

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly org: OrgService,
    private readonly approvals: OrgApprovalsService,
    private readonly audit: OrgAuditService,
    private readonly agents: AgentsService,
    private readonly runtime: OrgRuntimeService,
    @Optional() private readonly brief?: OrgBriefService,
    @Optional() private readonly signals?: OrgSignalsService,
    @Optional() private readonly units?: OrgUnitsService,
    @Optional() private readonly capital?: OrgCapitalService,
  ) {
    approvals.onCreated((orgId, a) => this.onCard(orgId, a));
    approvals.setDelegateResolver(async (orgId, a, who) => ((await this.isHumanDelegate(orgId, a, who)) ? `delegate:human:${who}` : null));
    brief?.addSection({ position: 'outcomes', lines: (orgId, _since, now) => this.outcomeLines(orgId, now) });
    brief?.addSection({ position: 'decisions', lines: (orgId, since) => this.delegatedLines(orgId, since) });
    runtime.addTicker({ name: 'seat', everyMinutes: 1, fn: (org, now) => this.tick(org, now) });
    runtime.addPlanningNotes(async (org, _unitId, isChief) => (isChief ? this.shrinkNotes(org.id) : []));
  }

  // ---- the tick ----

  async tick(org: Organization, now: Date): Promise<void> {
    await this.applyDefaults(org.id, now).catch((err) => this.logger.warn(`default actions for org ${org.id} failed: ${err instanceof Error ? err.message : err}`));
    if (now.getMinutes() % 5 === 0) {
      await this.syncValue(org.id).catch(() => undefined);
      await this.sweepNoOutcome(org.id, now).catch(() => undefined);
    }
  }

  // ---- decision cards: defaults at the deadline ----

  /** Pending cards past their deadline get their default action. Returns what was applied. */
  async applyDefaults(orgId: string, now = new Date()): Promise<Array<{ approvalId: string; decision: 'approve' | 'reject'; status: string }>> {
    const out: Array<{ approvalId: string; decision: 'approve' | 'reject'; status: string }> = [];
    const org = await this.org.get(orgId);
    for (let a of await this.approvals.list(orgId, { status: 'pending' })) {
      a = await this.approvals.fillCard(orgId, a);
      if (!a.deadline || a.deadline > now.toISOString() || !a.defaultAction) continue;
      if (a.expiresAt && a.expiresAt < now.toISOString()) continue;
      const payload = JSON.parse(a.payload || '{}') as Record<string, unknown>;
      // The floor, re-checked at the deadline: never approve-by-default an irreversible or money card.
      const unsafe = reversibilityOf(a.kind, payload) !== 'reversible' || isMoneyCard(a.kind, payload);
      const decision: 'approve' | 'reject' = a.defaultAction === 'approve' && !unsafe ? 'approve' : 'reject';
      const note = decision === 'approve' ? 'approved by default at your deadline' : 'denied by default at your deadline';
      let status: string;
      try {
        status = (await this.approvals.decide(orgId, a.id, decision, note, 'system', 'default', { via: 'default' })).approval.status;
      } catch (err) {
        await this.audit.append(orgId, { actor: 'system', action: 'approval_default_failed', refType: 'approval', refId: a.id, payload: { decision, reason: (err instanceof Error ? err.message : String(err)).slice(0, 300) } });
        continue;
      }
      await this.audit.append(orgId, { actor: 'system', action: 'approval_default', refType: 'approval', refId: a.id, payload: { kind: a.kind, decision, deadline: a.deadline, reversibility: a.reversibility, defaultAction: a.defaultAction } });
      if (org.chiefOfStaffAgentId) {
        await this.agents.addEvent(org.chiefOfStaffAgentId, {
          kind: 'info', title: `${decision === 'approve' ? 'Approved' : 'Denied'} by default at your deadline: ${a.kind} — ${summarize(a.kind, payload)}`.slice(0, 200),
          body: `You did not answer by ${a.deadline.slice(0, 16).replace('T', ' ')} UTC, so the card's default (${a.defaultAction}${unsafe && a.defaultAction === 'approve' ? ', overridden to deny: irreversible or money' : ''}) applied.`, payload: JSON.stringify({ orgId, approvalId: a.id, via: 'default' }), origin: 'loop', channel: true,
        }).catch(() => undefined);
      }
      out.push({ approvalId: a.id, decision, status });
    }
    return out;
  }

  // ---- delegations ----

  async delegations(orgId: string, opts: { includeRevoked?: boolean } = {}): Promise<OrgDelegation[]> {
    const rows = await this.db.select().from(orgDelegations).where(eq(orgDelegations.orgId, orgId)).orderBy(desc(orgDelegations.createdAt));
    return rows.filter((d) => opts.includeRevoked || !d.revokedAt);
  }

  /** The owner delegates a kind of card. Agents cannot (the boundary's `delegation` row). */
  async delegate(orgId: string, input: { kind: string; maxUsd?: number | null; delegateType: 'human' | 'role'; delegateRef: string }, actor = 'user'): Promise<OrgDelegation> {
    await this.org.gate(orgId, { kind: 'delegation', summary: `delegate ${input.kind} cards` }, actor);
    const kind = String(input.kind ?? '').trim();
    if ((NON_DELEGABLE as readonly string[]).includes(kind)) {
      const rule = ruleFor({ kind: kind as SelfChange['kind'] });
      throw new BadRequestException(`refused: ${rule.match} is never delegable (${rule.reason})`);
    }
    if (!(APPROVAL_KINDS as string[]).includes(kind) && !(ACTION_CLASSES as readonly string[]).includes(kind)) throw new BadRequestException(`kind must be an approval kind (${APPROVAL_KINDS.join(', ')}) or an action class (${ACTION_CLASSES.join(', ')})`);
    if (kind === 'metric_source') throw new BadRequestException('refused: a metric source defines what counts as truth; it is never delegable');
    if (!['human', 'role'].includes(input.delegateType)) throw new BadRequestException('delegateType must be human or role');
    const ref = String(input.delegateRef ?? '').trim();
    if (!ref) throw new BadRequestException('delegateRef is required (a member account id, or a role such as "controller")');
    if (input.delegateType === 'human') {
      const role = await this.org.humanRole(orgId, ref);
      if (!role || role === 'observer') throw new BadRequestException('a human delegate must be a member of the organization with standing (CEO, board or employee)');
    }
    const maxUsd = input.maxUsd === undefined || input.maxUsd === null ? null : Math.max(0, Number(input.maxUsd));
    if (maxUsd !== null && !Number.isFinite(maxUsd)) throw new BadRequestException('maxUsd must be a number');
    const row: OrgDelegation = { accountId: currentAccountId(), id: newId(), orgId, kind, maxUsd, delegateType: input.delegateType, delegateRef: input.delegateType === 'role' ? ref.toLowerCase() : ref, createdBy: actor, createdAt: nowIso(), revokedAt: null };
    await this.db.insert(orgDelegations).values(row);
    await this.audit.append(orgId, { actor, action: 'delegation_create', refType: 'delegation', refId: row.id, payload: { kind, maxUsd, delegateType: row.delegateType, delegateRef: row.delegateRef } });
    return row;
  }

  async revoke(orgId: string, id: string, actor = 'user'): Promise<OrgDelegation> {
    await this.org.gate(orgId, { kind: 'delegation', summary: 'revoke a delegation' }, actor);
    const d = (await this.delegations(orgId, { includeRevoked: true })).find((x) => x.id === id || x.id.startsWith(id));
    if (!d) throw new NotFoundException(`delegation ${id}`);
    await this.db.update(orgDelegations).set({ revokedAt: nowIso() }).where(eq(orgDelegations.id, d.id));
    await this.audit.append(orgId, { actor, action: 'delegation_revoke', refType: 'delegation', refId: d.id, payload: { kind: d.kind } });
    return (await this.delegations(orgId, { includeRevoked: true })).find((x) => x.id === d.id)!;
  }

  /** The delegations that cover a card. */
  async covering(orgId: string, a: OrgApproval): Promise<OrgDelegation[]> {
    const payload = JSON.parse(a.payload || '{}') as Record<string, unknown>;
    return (await this.delegations(orgId)).filter((d) => delegationCovers(d, a, payload));
  }

  /** Whether `memberAccountId` may decide this card as a human delegate. */
  async isHumanDelegate(orgId: string, a: OrgApproval, memberAccountId: string): Promise<OrgDelegation | null> {
    return (await this.covering(orgId, a)).find((d) => d.delegateType === 'human' && d.delegateRef === memberAccountId) ?? null;
  }

  /** A human delegate decides a card (the decide route calls this when the caller is not the CEO). */
  async decideAsDelegate(orgId: string, approvalId: string, decision: 'approve' | 'reject' | 'revise', note: string, memberAccountId: string, actor: string) {
    const a = await this.approvals.get(orgId, approvalId);
    const d = await this.isHumanDelegate(orgId, a, memberAccountId);
    if (!d) throw new ForbiddenException(`no delegation lets you decide this ${a.kind} card`);
    return this.approvals.decide(orgId, a.id, decision, note, actor, memberAccountId, { via: `delegate:human:${memberAccountId}` });
  }

  /** A new card: an agent-role delegation decides it at once (a human one waits for the person). */
  private async onCard(orgId: string, a: OrgApproval): Promise<void> {
    const roleDelegation = (await this.covering(orgId, a)).find((d) => d.delegateType === 'role');
    if (!roleDelegation) return;
    const members = (await this.org.members(orgId)).filter((m) => m.status === 'active');
    const delegate = members.find((m) => roleKeyOf(m) === roleDelegation.delegateRef || m.title.toLowerCase() === roleDelegation.delegateRef);
    if (!delegate) return;
    const org = await this.org.get(orgId);
    const payload = JSON.parse(a.payload || '{}') as Record<string, unknown>;
    // The proposer never decides its own card.
    const proposer = a.requestedBy === 'chief' ? org.chiefOfStaffAgentId : a.requestedBy.startsWith('agent:') ? a.requestedBy.slice('agent:'.length) : null;
    if (proposer && proposer === delegate.agentId) return;
    const v = await (this.delegateFn ? this.delegateFn({ org, approval: a, payload, delegateAgentId: delegate.agentId, roleKey: roleDelegation.delegateRef }) : this.judgeAsDelegate(org, a, payload, delegate.agentId, roleDelegation.delegateRef, proposer)).catch((err: unknown) => ({ verdict: 'ask' as const, reason: err instanceof Error ? err.message : String(err) }));
    await this.audit.append(orgId, { actor: `agent:${delegate.agentId}`, action: 'delegated_review', refType: 'approval', refId: a.id, payload: { kind: a.kind, verdict: v.verdict, reason: v.reason.slice(0, 300), delegationId: roleDelegation.id, role: roleDelegation.delegateRef } });
    if (v.verdict === 'ask') return;
    try {
      await this.approvals.decide(orgId, a.id, v.verdict, `${roleDelegation.delegateRef} (delegated): ${v.reason}`.slice(0, 2_000), `agent:${delegate.agentId}`, `agent:${delegate.agentId}`, { via: `delegate:role:${roleDelegation.delegateRef}` });
    } catch (err) {
      await this.audit.append(orgId, { actor: 'system', action: 'delegated_decision_failed', refType: 'approval', refId: a.id, payload: { reason: (err instanceof Error ? err.message : String(err)).slice(0, 300) } });
    }
  }

  /** The default delegate judgment: tool-free, on another family than the proposer. */
  private async judgeAsDelegate(org: Organization, a: OrgApproval, payload: Record<string, unknown>, delegateAgentId: string, role: string, proposer: string | null): Promise<{ verdict: 'approve' | 'reject' | 'ask'; reason: string }> {
    const delegate = await this.agents.get(delegateAgentId).catch(() => null);
    const r = await this.runtime.judge(org, proposer ?? delegateAgentId, {
      userRequest: `As the ${role} of "${org.name}", the owner delegated ${a.kind} decisions to you. Allow only if this ${a.kind} is sound and within the company's rules; deny if not; ask when unsure.`,
      conversationSummary: `Card: ${summarize(a.kind, payload)}. Proposer's recommendation: ${a.recommendedAction || 'approve'} — ${a.recommendation || '(none)'}. Reversibility: ${a.reversibility}. Rules: ${org.rules.slice(0, 1_000) || '(none)'}.`,
      agentCharter: delegate?.charter ?? undefined,
      call: { name: `org_decide_${a.kind}`, input: payload },
      origin: 'loop',
    }).catch(() => null);
    if (!r) return { verdict: 'ask', reason: 'no independent model to decide with' };
    return { verdict: r.verdict === 'allow' ? 'approve' : r.verdict === 'deny' ? 'reject' : 'ask', reason: `${r.reason} (${r.model})` };
  }

  private async delegatedLines(orgId: string, since: string): Promise<string[]> {
    const rows = (await this.approvals.list(orgId)).filter((a) => a.decidedAt && a.decidedAt >= since && (a.decidedVia.startsWith('delegate:') || a.decidedVia === 'default'));
    if (rows.length === 0) return [];
    return ['## Decided for you', ...rows.slice(0, 15).map((a) => `- ${a.status} ${a.decidedVia === 'default' ? 'by default at your deadline' : `by ${a.decidedVia.slice('delegate:'.length).replace(':', ' ')}`}: [${a.kind}] ${summarize(a.kind, JSON.parse(a.payload || '{}') as Record<string, unknown>)}`)];
  }

  // ---- value accounting ----

  /** The CEO states what a key result's movement is worth. */
  async setGoalValue(orgId: string, goalId: string, input: { valuePerUnit?: number | null; valueOnAchieve?: number | null; valueNote?: string }, actor = 'user'): Promise<OrgGoal> {
    if (actor === 'chief' || actor.startsWith('agent:')) throw new ForbiddenException('what an outcome is worth is the owner\'s to say');
    const g = await this.org.goal(orgId, goalId);
    if (g.kind !== 'key_result') throw new BadRequestException('value is set on a key result');
    const num = (v: unknown) => (v === undefined ? undefined : v === null ? null : Number.isFinite(Number(v)) ? Number(v) : (() => { throw new BadRequestException('values must be numbers (USD)'); })());
    const set: Record<string, unknown> = {};
    const vpu = num(input.valuePerUnit); if (vpu !== undefined) set.valuePerUnit = vpu;
    const voa = num(input.valueOnAchieve); if (voa !== undefined) set.valueOnAchieve = voa;
    if (input.valueNote !== undefined) set.valueNote = String(input.valueNote).slice(0, 500);
    if (Object.keys(set).length) {
      await this.db.update(orgGoals).set(set).where(eq(orgGoals.id, g.id));
      await this.audit.append(orgId, { actor, action: 'goal_value_set', refType: 'goal', refId: g.id, payload: set });
    }
    await this.syncValue(orgId).catch(() => undefined);
    return this.org.goal(orgId, g.id);
  }

  async valueEvents(orgId: string, opts: { since?: string } = {}): Promise<OrgValueEvent[]> {
    const conds = [eq(orgValueEvents.orgId, orgId)];
    if (opts.since) conds.push(gte(orgValueEvents.at, opts.since));
    return this.db.select().from(orgValueEvents).where(and(...conds)).orderBy(asc(orgValueEvents.at));
  }

  /** Turn measured key-result movement (metric samples) into value events. Idempotent. */
  async syncValue(orgId: string): Promise<number> {
    const goals = await this.org.goals(orgId);
    const byId = new Map(goals.map((g) => [g.id, g]));
    const events = await this.valueEvents(orgId);
    let n = 0;
    for (const g of goals.filter((x) => x.kind === 'key_result' && x.metricSourceId && (x.valuePerUnit !== null || x.valueOnAchieve !== null))) {
      const objective = g.parentGoalId ? byId.get(g.parentGoalId) ?? null : null;
      const mine = events.filter((e) => e.goalId === g.id && e.kind === 'movement');
      const last = mine.at(-1) ?? null;
      const samples = (await this.db.select().from(orgMetricSamples).where(and(eq(orgMetricSamples.sourceId, g.metricSourceId!), gte(orgMetricSamples.observedAt, g.createdAt))).orderBy(asc(orgMetricSamples.observedAt), asc(orgMetricSamples.createdAt)));
      const seen = new Set(mine.map((e) => e.sampleId));
      let prev: number | null = last?.toValue ?? g.startValue ?? null;
      const dir = (g.targetValue ?? 0) >= (g.startValue ?? 0) ? 1 : -1;
      for (const s of samples) {
        if (seen.has(s.id)) { prev = s.value; continue; }
        if (last && s.observedAt < last.at) continue;
        if (prev === null) { prev = s.value; continue; }
        const delta = (s.value - prev) * dir;
        const row: OrgValueEvent = { accountId: currentAccountId(), id: newId(), orgId, goalId: g.id, objectiveId: objective?.id ?? null, unitId: objective?.unitId ?? g.unitId, kind: 'movement', sampleId: s.id, fromValue: prev, toValue: s.value, delta, valueUsd: round2(delta * (g.valuePerUnit ?? 0)), at: s.observedAt, createdAt: nowIso() };
        await this.db.insert(orgValueEvents).values(row).onConflictDoNothing();
        prev = s.value; n++;
      }
      const reached = g.status === 'achieved' || (g.targetValue !== null && g.currentValue !== null && (dir > 0 ? g.currentValue >= g.targetValue : g.currentValue <= g.targetValue));
      if (reached && g.valueOnAchieve && !events.some((e) => e.goalId === g.id && e.kind === 'achieved')) {
        await this.db.insert(orgValueEvents).values({ accountId: currentAccountId(), id: newId(), orgId, goalId: g.id, objectiveId: objective?.id ?? null, unitId: objective?.unitId ?? g.unitId, kind: 'achieved', sampleId: 'achieved', fromValue: null, toValue: g.currentValue, delta: 0, valueUsd: round2(g.valueOnAchieve), at: g.lastMeasuredAt ?? nowIso(), createdAt: nowIso() }).onConflictDoNothing();
        n++;
      }
    }
    return n;
  }

  /** Per objective: measured movement and value realised against spend. */
  async outcomes(orgId: string, now = new Date()): Promise<Array<{ objectiveId: string; title: string; unitId: string | null; keyResults: Array<{ goalId: string; title: string; measured: boolean; movement7d: number | null; value: number | null; target: number | null }>; valueUsd: number; spentUsd: number; roi: number | null }>> {
    await this.syncValue(orgId).catch(() => undefined);
    const goals = await this.org.goals(orgId);
    const month = `${now.toISOString().slice(0, 7)}-01`;
    const weekAgo = new Date(now.getTime() - WEEK_MS).toISOString();
    const events = await this.valueEvents(orgId, { since: month });
    const costs = this.capital ? await this.capital.costByGoal(orgId, { period: 'month', now }).catch(() => null) : null;
    const objectives = goals.filter((g) => g.kind === 'objective' && g.status === 'active');
    const out = [];
    for (const o of objectives) {
      const krs = goals.filter((k) => k.kind === 'key_result' && k.parentGoalId === o.id && k.status !== 'abandoned');
      const krRows = [];
      for (const k of krs) {
        let movement: number | null = null;
        if (k.metricSourceId) {
          const s = await this.db.select().from(orgMetricSamples).where(and(eq(orgMetricSamples.sourceId, k.metricSourceId), gte(orgMetricSamples.observedAt, weekAgo))).orderBy(asc(orgMetricSamples.observedAt));
          movement = s.length >= 1 ? s.at(-1)!.value - (s.length >= 2 ? s[0].value : (k.startValue ?? s[0].value)) : 0;
        }
        krRows.push({ goalId: k.id, title: k.title, measured: Boolean(k.metricSourceId), movement7d: movement, value: k.currentValue, target: k.targetValue });
      }
      const valueUsd = round2(events.filter((e) => e.objectiveId === o.id).reduce((s, e) => s + e.valueUsd, 0));
      const spentUsd = costs?.objectives.find((c) => c.goalId === o.id)?.spentUsd ?? 0;
      out.push({ objectiveId: o.id, title: o.title, unitId: o.unitId, keyResults: krRows, valueUsd, spentUsd, roi: spentUsd > 0 ? round2(valueUsd / spentUsd) : null });
    }
    return out;
  }

  /** The brief's opening section. */
  async outcomeLines(orgId: string, now: Date): Promise<string[]> {
    const rows = await this.outcomes(orgId, now);
    if (rows.length === 0) return [];
    const lines = ['## Outcomes'];
    for (const o of rows.slice(0, 10)) {
      const measured = o.keyResults.filter((k) => k.measured);
      const moves = measured.map((k) => `${k.title} ${fmtSigned(k.movement7d)} this week${k.value !== null ? ` (now ${k.value}${k.target !== null ? ` of ${k.target}` : ''})` : ''}`);
      lines.push(`- ${o.title}: ${moves.length ? moves.join('; ') : 'no measured key result'} — value realised $${o.valueUsd.toFixed(2)} vs spend $${o.spentUsd.toFixed(2)} this month${o.roi !== null ? ` (ROI ${o.roi}×)` : ''}${measured.length < o.keyResults.length ? `; ${o.keyResults.length - measured.length} self-reported` : ''}`);
    }
    return lines;
  }

  // ---- outcome or shrink (principle 6) ----

  /** Units whose objectives showed no measured movement for N weeks get a no_outcome signal. */
  async sweepNoOutcome(orgId: string, now = new Date()): Promise<{ opened: string[]; resolved: number }> {
    if (!this.signals || !this.units) return { opened: [], resolved: 0 };
    const org = await this.org.get(orgId);
    const weeks = govTunable(org, 'seat.noOutcomeWeeks');
    const since = new Date(now.getTime() - weeks * WEEK_MS).toISOString();
    const goals = await this.org.goals(orgId);
    const units = await this.units.units(orgId);
    const opened: string[] = [];
    const live = new Set<string>();
    for (const u of units) {
      const objectives = goals.filter((g) => g.kind === 'objective' && g.status === 'active' && g.unitId === u.id && g.createdAt <= since);
      if (objectives.length === 0) continue;
      let moved = false;
      for (const k of goals.filter((g) => g.kind === 'key_result' && g.metricSourceId && objectives.some((o) => o.id === g.parentGoalId))) {
        const s = await this.db.select().from(orgMetricSamples).where(and(eq(orgMetricSamples.sourceId, k.metricSourceId!), gte(orgMetricSamples.observedAt, since))).orderBy(asc(orgMetricSamples.observedAt));
        const prior = (await this.db.select().from(orgMetricSamples).where(eq(orgMetricSamples.sourceId, k.metricSourceId!)).orderBy(asc(orgMetricSamples.observedAt))).filter((x) => x.observedAt < since).at(-1);
        const values = [...(prior ? [prior.value] : []), ...s.map((x) => x.value)];
        const dir = (k.targetValue ?? 0) >= (k.startValue ?? 0) ? 1 : -1;
        if (values.length >= 2 && (values.at(-1)! - values[0]) * dir > 0) { moved = true; break; }
      }
      if (moved) continue;
      live.add(u.id);
      const r = await this.signals.open(orgId, { kind: 'no_outcome', severity: 'warn', refType: 'unit', refId: u.id, title: `No outcome: ${u.name} moved no measured key result in ${weeks} week(s)`, detail: `Its ${objectives.length} objective(s) (${objectives.map((o) => o.title).join('; ').slice(0, 300)}) show no measured movement. Principle 6, outcome or shrink: propose shrinking its budget or headcount through an experiment or a proposal — not an automatic cut.`, addressee: 'chief', unitId: u.id }, now).catch(() => null);
      if (r?.created) opened.push(u.id);
    }
    let resolved = 0;
    for (const s of (await this.signals.list(orgId, { kind: 'no_outcome' })).filter((x) => x.status !== 'resolved' && !live.has(x.refId))) { await this.signals.resolve(orgId, s.id, 'system').catch(() => undefined); resolved++; }
    return { opened, resolved };
  }

  /** What the chief's planning run is told (outcome or shrink). */
  async shrinkNotes(orgId: string): Promise<string[]> {
    if (!this.signals) return [];
    const open = (await this.signals.list(orgId, { kind: 'no_outcome' })).filter((s) => s.status !== 'resolved');
    if (open.length === 0) return [];
    return ['## Outcome or shrink (principle 6)', ...open.map((s) => `- ${s.title}. Plan to shrink it — its envelope (org_allocate_budget lower) or its headcount (org_reorg / org_terminate_agent) — as an experiment or a proposal with the metric it should move; do not cut silently.`)];
  }
}

function round2(v: number): number { return Math.round(v * 100) / 100; }
function fmtSigned(v: number | null): string { return v === null ? 'n/a' : `${v > 0 ? '+' : ''}${Math.round(v * 100) / 100}`; }
