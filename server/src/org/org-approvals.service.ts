/**
 * OrgApprovalsService — the proposals only the CEO can answer
 * (docs/autonomous-company.md §4.3–§4.4, §4.6).
 *
 * A chief-of-staff tool never changes the structure of the company; it
 * writes an `org_approvals` row holding the full artifact (the hire
 * template and the scopes it would get, the reorg diff, the budget delta)
 * and the chief's one-line recommendation. `decide()` is reachable only
 * from the controller — an agent message or tool call cannot approve
 * anything — and applying an approved proposal is where the agent is
 * created, the scope widened, the reporting line moved or the cap raised.
 * Expiry (72 h) means "not done", never "allowed".
 */
import { BadRequestException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { orgApprovals } from '../database/schema';
import { newId, nowIso } from '../common/ids.util';
import { currentAccountId } from '../accounts/account-context';
import { AgentsService } from '../agents/agents.service';
import { SkillsService } from '../skills/skills.service';
import { TriggerBus } from '../chats/trigger-bus';
import { PROFESSION_PACKS } from '../market/profession-packs.generated';
import { AUTHORED_PACKS } from '../market/authored-packs.generated';
import type { MarketItem } from '../market/market.catalog';
import { OrgAuditService } from './org-audit.service';
import { OrgService, MAX_DEPTH_CEILING } from './org.service';
import { OrgTasksService, parseBrief, type TaskBrief } from './org-tasks.service';
import { meetScopes, parseScopes } from './scopes';
import { resolveRoleHire } from './org-roles.service';
import { roleById } from './roles/catalog';
import { HEAD_PLAYBOOKS, isHeadRole } from './heads';
import { clamp01, computedAlternatives, defaultActionFor, normalizeAlternatives, RECOMMENDED_ACTIONS, reversibilityOf, type DefaultAction, type RecommendedAction } from './decision-cards';
import { govTunable } from './governance-tunables';

export type OrgApproval = typeof orgApprovals.$inferSelect;
export type ApprovalKind = 'hire' | 'scope_widen' | 'reorg' | 'budget_raise' | 'strategy' | 'external' | 'terminate' | 'escalation' | 'tune' | 'cadence' | 'routing' | 'charter_change' | 'blueprint' | 'human_review' | 'metric_source' | 'two_key' | 'experiment' | 'member_settings' | 'project_now' | 'project_appetite' | 'project_kill' | 'project_allocation';
export const APPROVAL_KINDS: ApprovalKind[] = ['hire', 'scope_widen', 'reorg', 'budget_raise', 'strategy', 'external', 'terminate', 'escalation', 'tune', 'cadence', 'routing', 'charter_change', 'blueprint', 'human_review', 'metric_source', 'two_key', 'experiment', 'member_settings', 'project_now', 'project_appetite', 'project_kill', 'project_allocation'];

/** Another domain's applier for an approval kind it owns (`cadence` is
 *  OrgMeetingsService's, item 19; `blueprint` is OrgBlueprintsService's,
 *  item 24): registered with `onApply`, called from `decide` on approve. */
export type ApprovalApplier = (orgId: string, payload: Record<string, unknown>, approval: OrgApproval, note?: string) => Promise<Record<string, unknown>>;
export type ApprovalDecision = 'approve' | 'reject' | 'revise';
/** Told after every decision is written (docs/company-vision.md §6: the
 *  decision log; item 22's OrgMemoryService writes the row). */
export type DecisionListener = (ev: { orgId: string; approval: OrgApproval; decision: ApprovalDecision; note: string; result?: Record<string, unknown>; decidedBy: string }) => Promise<void> | void;

export const APPROVAL_TTL_MS = 72 * 60 * 60_000;

/** The decision-card fields a proposer fills (docs/owners-seat.md §1). */
export interface CardInput { recommendedAction?: RecommendedAction | string; alternatives?: unknown; confidence?: unknown; defaultAction?: DefaultAction }
/** Told after a card is written (delegated decisions, docs/owners-seat.md §2). */
export type CreatedListener = (orgId: string, approval: OrgApproval) => Promise<void> | void;
/** Runs before an approved card applies; throwing blocks the approval (the eval gate, docs/evals.md §3). */
export type BeforeApply = (orgId: string, approval: OrgApproval, payload: Record<string, unknown>) => Promise<void>;

const CATALOG: MarketItem[] = [...AUTHORED_PACKS, ...PROFESSION_PACKS] as MarketItem[];

export interface HireInput {
  templateOrPack: string; name?: string; title?: string; charter?: string; reportsToAgentId?: string; scopes?: string[];
  provider?: string; model?: string; monthlyBudgetUsd?: number; recommendation?: string; requestedBy: string;
  /** The decision-card fields (docs/owners-seat.md §1). */
  card?: CardInput;
  /** Whose holdings the requested scopes meet: the chief by default, a
   *  function head for its own hire (it never grants what it does not hold). */
  grantorAgentId?: string;
}

export interface HirePayload {
  /** Catalog pack id (profession packs are the hire templates) or null for a template hire. */
  packId: string | null;
  /** Role catalog id (docs/company-vision.md §4, `role:<id>`) when the hire came from a role. */
  roleId?: string;
  modelTier?: string;
  packName?: string;
  name: string;
  title: string;
  charter: string;
  reportsToAgentId: string;
  /** What the chief asked for. */
  requestedScopes: string[];
  /** meet(chief's holdings, requested) at proposal time — what the card shows. */
  scopes: string[];
  /** Requested scopes the chief does not hold itself (shown struck through). */
  outsideChiefHoldings: string[];
  provider?: string;
  model?: string;
  monthlyBudgetUsd?: number;
  /** Skill names the pack would install, for the card. */
  skills?: string[];
  /** A function head hiring into its own unit: whose holdings bound the scopes (absent: the chief). */
  grantorAgentId?: string;
}

export type ReorgChange =
  | { op: 'move'; agentId: string; reportsToAgentId: string }
  | { op: 'retitle'; agentId: string; title: string }
  | { op: 'pause'; agentId: string }
  | { op: 'resume'; agentId: string }
  | { op: 'terminate'; agentId: string }
  /** Make a member a function head (it staffs its own unit) or take it back. */
  | { op: 'make_head'; agentId: string }
  | { op: 'unmake_head'; agentId: string };

export interface StrategyPayload {
  goals: Array<{ title: string; description?: string; projects?: Array<{ title: string; tasks?: Array<{ title: string; brief?: Partial<TaskBrief>; assigneeAgentId?: string | null }> }> }>;
}

@Injectable()
export class OrgApprovalsService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly org: OrgService,
    private readonly tasks: OrgTasksService,
    private readonly agents: AgentsService,
    private readonly audit: OrgAuditService,
    @Optional() private readonly skills?: SkillsService,
    @Optional() private readonly bus?: TriggerBus,
  ) {}

  static catalogItem(idOrName: string): MarketItem | undefined {
    const q = (idOrName ?? '').trim().toLowerCase();
    return CATALOG.find((m) => m.id.toLowerCase() === q || m.name.toLowerCase() === q);
  }

  list(orgId: string, opts: { status?: string } = {}): Promise<OrgApproval[]> {
    const conds = [eq(orgApprovals.orgId, orgId)];
    if (opts.status) conds.push(eq(orgApprovals.status, opts.status));
    return this.db.select().from(orgApprovals).where(and(...conds));
  }

  async get(orgId: string, id: string): Promise<OrgApproval> {
    const a = (await this.db.select().from(orgApprovals).where(and(eq(orgApprovals.orgId, orgId), eq(orgApprovals.id, id))).limit(1)).at(0);
    if (!a) throw new NotFoundException(`approval ${id}`);
    return a;
  }

  /** A card by id or an 8+ character prefix (what an agent sees). */
  async byPrefix(orgId: string, ref: string): Promise<OrgApproval> {
    const q = (ref ?? '').trim();
    if (!q) throw new NotFoundException('approvalId is required');
    const exact = (await this.db.select().from(orgApprovals).where(and(eq(orgApprovals.orgId, orgId), eq(orgApprovals.id, q))).limit(1)).at(0);
    if (exact) return exact;
    const hits = (await this.list(orgId)).filter((a) => a.id.startsWith(q));
    if (hits.length !== 1) throw new NotFoundException(hits.length ? `"${q}" matches ${hits.length} cards — use more characters` : `no card "${q}"`);
    return hits[0];
  }

  async pending(orgId: string): Promise<OrgApproval[]> {
    await this.expireStale(orgId);
    return (await this.list(orgId, { status: 'pending' })).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }

  /** Pending cards that wait on the CEO now (docs/owners-seat.md §7): the
   *  ones a manager still holds are on their way up, not the owner's yet. */
  async pendingForOwner(orgId: string): Promise<OrgApproval[]> {
    return (await this.pending(orgId)).filter((a) => !a.holder || a.holder === 'ceo');
  }

  /** Decision routing (OrgDecisionsService): place a new card with the
   *  requester's direct manager. Returns the card as routed. */
  private router?: (orgId: string, a: OrgApproval) => Promise<OrgApproval>;
  setRouter(fn: ((orgId: string, a: OrgApproval) => Promise<OrgApproval>) | undefined): void { this.router = fn; }

  /** Route a card written by another path (an escalation, a human review). */
  async route(orgId: string, a: OrgApproval): Promise<OrgApproval> {
    return this.router ? this.router(orgId, a).catch(() => a) : a;
  }

  /** A card reached the CEO (at creation, or after climbing the chain): the
   *  chief's inbox line (pushed to the owner's channels) and the delegations. */
  async arrived(orgId: string, a: OrgApproval): Promise<void> {
    const org = await this.org.get(orgId);
    const payload = JSON.parse(a.payload || '{}') as Record<string, unknown>;
    if (org.chiefOfStaffAgentId) {
      await this.agents.addEvent(org.chiefOfStaffAgentId, {
        kind: 'info', title: `Approval needed (${a.kind}): ${summarize(a.kind, payload)}`.slice(0, 200),
        body: a.recommendation ?? '', payload: JSON.stringify({ orgId, approvalId: a.id, kind: a.kind }), origin: 'loop', channel: true,
      }).catch(() => {});
    }
    for (const fn of this.createdListeners) await Promise.resolve(fn(orgId, a)).catch(() => undefined);
  }

  private readonly appliers = new Map<ApprovalKind, ApprovalApplier>();

  /** Register the applier of a kind another module owns (see ApprovalApplier). */
  onApply(kind: ApprovalKind, fn: ApprovalApplier): void { this.appliers.set(kind, fn); }

  private readonly decisionListeners: DecisionListener[] = [];

  /** Be told after a decision is written (the decision log, item 22). */
  onDecided(fn: DecisionListener): () => void {
    this.decisionListeners.push(fn);
    return () => { const i = this.decisionListeners.indexOf(fn); if (i >= 0) this.decisionListeners.splice(i, 1); };
  }

  /** Create a proposal. The chief's inbox gets no event (it wrote it); the
   *  user sees it in the approvals queue and in the brief. */
  async create(orgId: string, input: { kind: ApprovalKind; payload: Record<string, unknown>; requestedBy: string; recommendation?: string; card?: CardInput; urgency?: 'normal' | 'urgent' }): Promise<OrgApproval> {
    const org = await this.org.get(orgId);
    if (!APPROVAL_KINDS.includes(input.kind)) throw new BadRequestException(`approval kind must be one of ${APPROVAL_KINDS.join(', ')}`);
    const card = cardFields(org, input.kind, input.payload, input.card ?? {}, Date.now());
    const row: OrgApproval = {
      id: newId(), accountId: currentAccountId(), orgId, kind: input.kind,
      payload: JSON.stringify(input.payload).slice(0, 60_000),
      requestedBy: input.requestedBy.slice(0, 80), recommendation: (input.recommendation ?? '').slice(0, 600),
      status: 'pending', decidedAt: null, decidedBy: '', decisionNote: '',
      expiresAt: new Date(Date.now() + APPROVAL_TTL_MS).toISOString(), createdAt: nowIso(),
      ...card, decidedVia: '',
      holder: 'ceo', holderSince: null, hopDeadline: null, chain: '[]', reserved: '', urgency: input.urgency === 'urgent' ? 'urgent' : 'normal',
    };
    await this.db.insert(orgApprovals).values(row);
    await this.audit.append(orgId, { actor: input.requestedBy, action: 'approval_request', refType: 'approval', refId: row.id, payload: { kind: input.kind, summary: summarize(input.kind, input.payload) } });
    // Decision routing (docs/owners-seat.md §7): the requester's manager first.
    const routed = await this.route(orgId, row);
    if (routed.status === 'pending' && (!routed.holder || routed.holder === 'ceo')) await this.arrived(orgId, routed);
    return (await this.list(orgId)).find((a) => a.id === row.id) ?? row;
  }

  private readonly createdListeners: CreatedListener[] = [];
  private readonly beforeApply = new Map<string, BeforeApply[]>();

  /** Be told after a card is written (OrgSeatService: an agent delegate decides it). */
  onCreated(fn: CreatedListener): () => void {
    this.createdListeners.push(fn);
    return () => { const i = this.createdListeners.indexOf(fn); if (i >= 0) this.createdListeners.splice(i, 1); };
  }

  /** Run before a card of `kind` applies on approval; a throw blocks it and the card stays pending. */
  onBeforeApply(kind: ApprovalKind, fn: BeforeApply): void {
    this.beforeApply.set(kind, [...(this.beforeApply.get(kind) ?? []), fn]);
  }

  private delegateResolver?: (orgId: string, a: OrgApproval, memberAccountId: string) => Promise<string | null>;

  /** OrgSeatService binds who may decide a card as a delegate (returns the `via`). */
  setDelegateResolver(fn: ((orgId: string, a: OrgApproval, memberAccountId: string) => Promise<string | null>) | undefined): void { this.delegateResolver = fn; }

  /** `delegate:human:<id>` when this person may decide the card by delegation, else null. */
  async delegateVia(orgId: string, a: OrgApproval, memberAccountId: string): Promise<string | null> {
    return this.delegateResolver ? this.delegateResolver(orgId, a, memberAccountId).catch(() => null) : null;
  }

  /** Merge into a pending card's payload (an eval result attached to it). */
  async attach(orgId: string, id: string, patch: Record<string, unknown>): Promise<OrgApproval> {
    const a = await this.get(orgId, id);
    const payload = { ...(JSON.parse(a.payload || '{}') as Record<string, unknown>), ...patch };
    await this.db.update(orgApprovals).set({ payload: JSON.stringify(payload).slice(0, 60_000) }).where(eq(orgApprovals.id, id));
    return this.get(orgId, id);
  }

  /** Fill the decision-card fields of a card written without them (a
   *  system-generated escalation or human review): computed defaults. */
  async fillCard(orgId: string, a: OrgApproval): Promise<OrgApproval> {
    if (a.reversibility) return a;
    const org = await this.org.get(orgId);
    const card = cardFields(org, a.kind, JSON.parse(a.payload || '{}') as Record<string, unknown>, {}, Date.parse(a.createdAt) || Date.now());
    await this.db.update(orgApprovals).set(card).where(eq(orgApprovals.id, a.id));
    return this.get(orgId, a.id);
  }

  /** Build a hire proposal: the requested scopes are intersected with the
   *  chief's holdings before the card exists; depth/fan-out are checked now
   *  so the card is never un-approvable. */
  async proposeHire(orgId: string, input: HireInput): Promise<OrgApproval> {
    const payload = await this.prepareHire(orgId, input);
    return this.create(orgId, { kind: 'hire', payload: payload as unknown as Record<string, unknown>, requestedBy: input.requestedBy, recommendation: input.recommendation, card: input.card });
  }

  /** Validate a hire and build its payload (shared by the supervised card
   *  and the autonomous path, docs/group-chat.md §5). */
  async prepareHire(orgId: string, input: HireInput): Promise<HirePayload> {
    const org = await this.org.get(orgId);
    const grantor = input.grantorAgentId ?? org.chiefOfStaffAgentId;
    const holder = grantor ? await this.org.member(orgId, grantor) : null;
    const holdings = this.org.scopesOf(holder);
    let pack = OrgApprovalsService.catalogItem(input.templateOrPack);
    const reportsTo = input.reportsToAgentId ?? org.chiefOfStaffAgentId;
    if (!reportsTo) throw new BadRequestException('reportsToAgentId is required');
    const manager = await this.org.member(orgId, reportsTo);
    if (!manager || manager.status !== 'active') throw new BadRequestException('reportsTo must be an active member');
    if (manager.depth + 1 > Math.min(org.maxDepth, MAX_DEPTH_CEILING)) throw new BadRequestException(`depth limit (${Math.min(org.maxDepth, MAX_DEPTH_CEILING)}) reached under that manager`);
    const reports = (await this.org.members(orgId)).filter((m) => m.reportsToAgentId === reportsTo && m.status !== 'terminated');
    const pendingHires = (await this.pending(orgId)).filter((a) => a.kind === 'hire' && (JSON.parse(a.payload) as HirePayload).reportsToAgentId === reportsTo);
    if (reports.length + pendingHires.length >= org.maxDirectReports) throw new BadRequestException(`fan-out limit (${org.maxDirectReports} direct reports, counting pending hires) reached`);
    // A role hire (`role:<id>`, docs/company-vision.md §4) resolves into the
    // template path: the role's charter, title, scopes and model tier.
    const role = resolveRoleHire(input.templateOrPack, { orgName: org.name, name: input.name, title: input.title, scopes: input.scopes, provider: input.provider, model: input.model });
    if (!role && input.templateOrPack.trim().toLowerCase().startsWith('role:')) throw new BadRequestException(`"${input.templateOrPack}" is not a catalog role (GET …/org/roles lists them)`);
    // A business role names its authored pack (Role.packId): the hire keeps the
    // role's charter, title, scopes and tier and brings the pack's playbooks.
    if (!pack && role?.packId) pack = OrgApprovalsService.catalogItem(role.packId);
    const requested = parseScopes(role?.scopes ?? input.scopes ?? []);
    const scopes = meetScopes(holdings, requested);
    const name = (input.name ?? role?.name ?? pack?.name ?? input.templateOrPack).trim().slice(0, 60);
    if (!name) throw new BadRequestException('a hire needs a name');
    const charter = (input.charter ?? role?.charter ?? pack?.charter ?? '').slice(0, 20_000);
    if (!pack && !charter) throw new BadRequestException(`"${input.templateOrPack}" is not a catalog pack; a template hire needs a charter`);
    // An explicit model must be one the hire's agent type serves (docs/agent-types.md
    // "Validation"); refused here with the list so the chief can pick again.
    // A role hire's card shows the tier's model on that type.
    const resolved = input.model?.trim() || role ? await this.agents.resolveModelFor({ provider: input.provider, model: input.model, modelTier: role?.modelTier }) : null;
    const payload: HirePayload = {
      packId: pack?.id ?? null, packName: pack?.name, name, title: (input.title ?? role?.title ?? pack?.role ?? 'Specialist').slice(0, 80), charter,
      reportsToAgentId: reportsTo, requestedScopes: requested, scopes, outsideChiefHoldings: requested.filter((s) => !scopes.includes(s)),
      provider: input.provider, model: input.model ?? (role ? resolved?.model || undefined : undefined), monthlyBudgetUsd: input.monthlyBudgetUsd,
      skills: pack?.skills?.map((s) => s.name),
      ...(role ? { roleId: role.roleId, modelTier: role.modelTier } : {}),
      ...(input.grantorAgentId && input.grantorAgentId !== org.chiefOfStaffAgentId ? { grantorAgentId: input.grantorAgentId } : {}),
    };
    return payload;
  }

  /** The CEO's (or a board member's) decision. Only the controller calls
   *  this; `decidedBy` is the deciding human's account id (phase D). */
  async decide(orgId: string, id: string, decision: ApprovalDecision, note = '', actor = 'user', decidedBy = '', opts: { via?: string } = {}): Promise<{ approval: OrgApproval; result?: Record<string, unknown> }> {
    const a = await this.get(orgId, id);
    if (a.status !== 'pending') throw new BadRequestException(`approval is ${a.status}`);
    if (a.expiresAt && a.expiresAt < nowIso()) {
      await this.db.update(orgApprovals).set({ status: 'expired' }).where(eq(orgApprovals.id, id));
      throw new BadRequestException('approval has expired — ask the chief of staff to propose again');
    }
    const payload = JSON.parse(a.payload || '{}') as Record<string, unknown>;
    let result: Record<string, unknown> | undefined;
    let status: OrgApproval['status'];
    // A manager agent's decision (docs/owners-seat.md §7) applies as that agent, so the boundary's fence still binds it.
    const managerAgent = opts.via?.startsWith('manager:agent:') ? opts.via.slice('manager:'.length) : null;
    const decider = opts.via?.startsWith('manager:') ? 'Manager' : opts.via?.startsWith('delegate:') ? 'Delegate' : 'CEO';
    if (decision === 'approve') {
      for (const fn of this.beforeApply.get(a.kind) ?? []) await fn(orgId, a, payload);
      result = await this.apply(orgId, a.kind as ApprovalKind, payload, a, note, managerAgent ?? 'user', decider);
      status = 'approved';
    } else if (decision === 'reject') {
      status = 'rejected';
      if (a.kind === 'escalation' && typeof payload.taskId === 'string') {
        await this.tasks.update(orgId, payload.taskId, { status: 'cancelled' }, actor).catch(() => {});
      }
      // A human reviewer's "no" is a request for changes with the note (item 24).
      if (a.kind === 'human_review' && typeof payload.taskId === 'string') {
        await this.tasks.review(orgId, payload.taskId, { verdict: 'request_changes', note: note || 'changes requested by the human reviewer', byAgentId: null }).catch(() => {});
      }
    } else {
      status = 'revision_requested';
    }
    await this.db.update(orgApprovals).set({ status, decidedAt: nowIso(), decidedBy: decidedBy || currentAccountId(), decisionNote: note.slice(0, 2_000), decidedVia: (opts.via ?? '').slice(0, 120) }).where(eq(orgApprovals.id, id));
    await this.audit.append(orgId, { actor, action: `approval_${status}`, refType: 'approval', refId: id, payload: { kind: a.kind, note: note.slice(0, 300), result, decidedBy: decidedBy || currentAccountId(), ...(opts.via ? { via: opts.via } : {}) } });
    // Delegated decisions (docs/owners-seat.md §2) carry their own audit row too.
    if (opts.via?.startsWith('delegate:')) await this.audit.append(orgId, { actor, action: 'delegated_decision', refType: 'approval', refId: id, payload: { kind: a.kind, decision: status, delegate: opts.via.slice('delegate:'.length) } });
    for (const fn of this.decisionListeners) await Promise.resolve(fn({ orgId, approval: { ...a, status }, decision, note, result, decidedBy: decidedBy || currentAccountId() })).catch(() => undefined);
    const org = await this.org.get(orgId);
    if (org.chiefOfStaffAgentId) {
      await this.agents.addEvent(org.chiefOfStaffAgentId, {
        kind: 'info', title: `${decider} ${status.replace('_', ' ')}: ${a.kind} — ${summarize(a.kind, payload)}`.slice(0, 200),
        body: note.slice(0, 1_000), payload: JSON.stringify({ orgId, approvalId: id, status }), origin: 'user',
      }).catch(() => {});
    }
    // The waiting agent wakes on the decision when the proposal names a task.
    if (typeof payload.taskId === 'string' && org.status === 'active') {
      const t = await this.tasks.get(orgId, payload.taskId).catch(() => null);
      if (t?.assigneeAgentId && !['done', 'cancelled'].includes(t.status)) this.bus?.emitOrgWake({ orgId, taskId: t.id, agentId: t.assigneeAgentId, reason: 'approval' });
    }
    return { approval: await this.get(orgId, id), result };
  }

  /** Apply an approved proposal. This is the only place an org tool's
   *  intent becomes a structural change. */
  private async apply(orgId: string, kind: ApprovalKind, payload: Record<string, unknown>, approval: OrgApproval, note: string, actor = 'user', decider = 'CEO'): Promise<Record<string, unknown>> {
    const by = `approval:${approval.id}`;
    switch (kind) {
      case 'hire':
        return this.applyHire(orgId, payload as unknown as HirePayload, actor, by);
      case 'scope_widen': {
        const agentId = String(payload.agentId ?? '');
        const scopes = parseScopes(payload.scopes);
        await this.org.applyScopes(orgId, agentId, scopes, actor, by);
        return { agentId, scopes };
      }
      case 'reorg':
        return this.applyReorg(orgId, Array.isArray(payload.changes) ? (payload.changes as ReorgChange[]) : [], actor);
      case 'budget_raise': {
        const scope = String(payload.scope ?? 'company') as 'company' | 'agent' | 'project';
        const refId = String(payload.refId ?? orgId);
        const b = await this.org.setBudget(orgId, { scope, refId, monthlyUsd: Number(payload.monthlyUsd ?? 0), actor });
        // Capital (docs/company-vision.md §7): the card said what the envelope buys; record it.
        if (typeof payload.objectiveId === 'string' && payload.objectiveId) await this.org.setAllocation(orgId, { goalId: payload.objectiveId, monthlyUsd: Number(payload.monthlyUsd ?? 0), rationale: typeof payload.buys === 'string' ? payload.buys : undefined, scope, refId, actor: 'user' }).catch(() => undefined);
        return { scope, refId, monthlyUsd: b.monthlyUsd };
      }
      case 'strategy': {
        const p = payload as unknown as StrategyPayload;
        const created = { goals: 0, projects: 0, tasks: 0 };
        for (const g of (p.goals ?? []).slice(0, 10)) {
          const goal = await this.org.addGoal(orgId, { title: g.title, description: g.description }, 'user');
          created.goals++;
          for (const pr of (g.projects ?? []).slice(0, 10)) {
            const project = await this.org.addProject(orgId, { title: pr.title, goalId: goal.id }, 'user');
            created.projects++;
            for (const t of (pr.tasks ?? []).slice(0, 25)) {
              await this.tasks.create(orgId, { title: t.title, brief: t.brief, projectId: project.id, assigneeAgentId: t.assigneeAgentId ?? null, status: t.assigneeAgentId ? 'todo' : 'backlog', createdBy: by, source: 'plan' });
              created.tasks++;
            }
          }
        }
        return created;
      }
      case 'terminate': {
        const agentId = String(payload.agentId ?? '');
        await this.org.terminateMember(orgId, agentId, actor);
        return { agentId };
      }
      case 'tune':
        // A tunable (docs/company-vision.md §1b) the chief proposed in supervised mode; bounds are re-checked on apply.
        return this.org.setTunable(orgId, String(payload.key ?? ''), payload.value, { actor: 'user', why: String(payload.why ?? ''), decidedBy: by });
      // Kinds another module owns and applies through `onApply`: a metric source
      // (docs/sensing.md §4, OrgSensingService activates it), an experiment
      // (docs/experiments.md §1.3, OrgExperimentsService starts it), the
      // meetings module's cadence, the memory module's charter change, and the
      // action contract's two-key hold; work tracking's project bets,
      // appetite decisions and kills (OrgProjectsService, docs/work-tracking.md).
      case 'cadence':
      case 'charter_change':
      case 'metric_source':
      case 'two_key':
      case 'member_settings':
      case 'project_now':
      case 'project_appetite':
      case 'project_kill':
      case 'project_allocation':
      case 'experiment': {
        // Kinds another module owns (the meetings module's cadence, the memory module's charter change).
        const fn = this.appliers.get(kind);
        if (!fn) throw new BadRequestException(`${kind} approvals need the module that owns them`);
        return fn(orgId, payload, approval);
      }
      case 'routing':
        // Model routing by task class (docs/company-vision.md §7, item 23) the chief proposed in supervised mode.
        return this.org.setRouting(orgId, { classes: { [String(payload.class ?? '')]: payload.tier } }, { actor: 'user', why: String(payload.why ?? ''), decidedBy: by }) as unknown as Promise<Record<string, unknown>>;
      case 'external':
        // Nothing to apply: the outward action itself still runs through the
        // agent inbox's action_pending gate; this records the CEO's go-ahead.
        return { acknowledged: true };
      case 'human_review': {
        // Hybrid staff (docs/company-vision.md §4, item 24): a review request
        // addressed to a human employee is an approval-like card; approving
        // it accepts the task (the human is the floor, no second check).
        const taskId = String(payload.taskId ?? '');
        const t = await this.tasks.review(orgId, taskId, { verdict: 'accept', note: note || undefined, byAgentId: null });
        return { taskId, status: t.status };
      }
      case 'blueprint': {
        const applier = this.appliers.get('blueprint');
        if (!applier) throw new BadRequestException('blueprint imports are not available on this server');
        return applier(orgId, payload, approval, note);
      }
      case 'escalation': {
        const taskId = String(payload.taskId ?? '');
        if (taskId) {
          const t = await this.tasks.get(orgId, taskId).catch(() => null);
          if (t && t.status === 'blocked') {
            await this.tasks.update(orgId, taskId, { status: 'todo', reviewRounds: 0, blockers: [] }, actor);
            await this.tasks.comment(orgId, taskId, { text: `${decider} decision: ${note || 'continue'}`, fromAgentId: actor.startsWith('agent:') ? actor.slice('agent:'.length) : null, wake: false });
          }
        }
        return { taskId };
      }
    }
    return {};
  }

  /** Create the hired agent and seat it. The one place a hire becomes an
   *  agent: from an approved card (supervised) or directly (autonomous,
   *  within caps — OrgRuntimeService checks them first). */
  async applyHire(orgId: string, p: HirePayload, actor: string, grantedBy: string): Promise<{ agentId: string; name: string; scopes: string[]; depth: number }> {
    const org = await this.org.get(orgId);
    // Re-meet at apply time: the grantor's (the chief's, or the hiring
    // head's) holdings may have narrowed since.
    const grantorId = p.grantorAgentId ?? org.chiefOfStaffAgentId;
    const grantor = grantorId ? await this.org.member(orgId, grantorId) : null;
    const scopes = meetScopes(this.org.scopesOf(grantor), parseScopes(p.requestedScopes ?? p.scopes ?? []));
    await this.org.gate(orgId, { kind: 'hire', withinUnit: true, key: p.reportsToAgentId, summary: `hire ${p.name}` }, actor);
    // A role hire brings its role's pack (a blueprint or a role hire may carry
    // only the role id): the playbooks travel with the role, whatever the door.
    const role = p.roleId ? roleById(p.roleId) : undefined;
    const pack = p.packId ? OrgApprovalsService.catalogItem(p.packId) : role?.packId ? OrgApprovalsService.catalogItem(role.packId) : undefined;
    const taken = new Set((await this.agents.list()).map((a) => a.name));
    let name = p.name; for (let n = 2; taken.has(name); n++) name = `${p.name} ${n}`;
    // No memory or connection inheritance: a fresh agent with the pack's
    // charter, its skills, and nothing else (§4.6).
    const agent = await this.agents.create({
      // The model resolves on the type the hire runs on (docs/agent-types.md):
      // the asked-for model if served, else the tier's, else the default — a
      // card approved after the type changed falls through instead of failing.
      name, workspaceId: org.workspaceId, charter: p.charter || pack?.charter || '', role: p.title, provider: p.provider, model: p.model,
      modelTier: p.modelTier, modelFallback: true,
      emoji: pack?.emoji, colors: pack?.colors, loops: [],
    });
    for (const s of pack?.skills ?? []) {
      await this.skills?.create({ name: s.name, description: s.description, instructions: s.instructions, agentId: agent.id }).catch(() => {});
    }
    const member = await this.org.addMember(orgId, { agentId: agent.id, title: p.title, reportsToAgentId: p.reportsToAgentId, scopes, actor, grantedBy });
    // A hire into a head's seat is a head from day one (docs/autonomous-skills-review.md
    // "Why heads don't hire"): its member row says so, and it carries the head playbooks.
    if (isHeadRole(role) || pack?.level === 'head') {
      await this.org.setHead(orgId, agent.id, true, actor).catch(() => undefined);
      await this.ensureHeadPlaybooks(orgId, agent.id).catch(() => undefined);
    }
    // Assurance (docs/company-vision.md §5.3): a hire from the Auditor pack (or the Auditor role) becomes the org's auditor when the seat is empty.
    if ((p.packId === 'pack-auditor' || p.roleId === 'auditor') && !(await this.org.get(orgId)).auditorAgentId) await this.org.update(orgId, { auditorAgentId: agent.id }).catch(() => undefined);
    if (p.monthlyBudgetUsd && p.monthlyBudgetUsd > 0) await this.org.setBudget(orgId, { scope: 'agent', refId: agent.id, monthlyUsd: p.monthlyBudgetUsd, actor });
    return { agentId: agent.id, name, scopes, depth: member.depth };
  }

  /**
   * A head carries the staffing playbooks whatever door it came through
   * (a catalog pack, a role, a blueprint, an enrolled agent, a member the
   * chief made a head): when it holds no `*-team-management` skill, the
   * generic head playbooks (`unit-team-design`, `unit-team-management`) are
   * installed on it. Idempotent; returns the skills it added.
   */
  async ensureHeadPlaybooks(orgId: string, agentId: string): Promise<string[]> {
    if (!this.skills) return [];
    const have = (await this.skills.list(undefined, agentId).catch(() => [] as Array<{ name: string; agentId: string | null }>)).filter((s) => s.agentId === agentId).map((s) => s.name);
    if (have.some((n) => /-team-management$/.test(n) || /-team-design$/.test(n))) return [];
    const added: string[] = [];
    for (const sk of HEAD_PLAYBOOKS) {
      if (have.includes(sk.name)) continue;
      await this.skills.create({ name: sk.name, description: sk.description, instructions: sk.instructions, agentId }).then(() => added.push(sk.name)).catch(() => undefined);
    }
    if (added.length) await this.audit.append(orgId, { actor: 'system', action: 'head_playbooks', refType: 'agent', refId: agentId, payload: { skills: added } }).catch(() => undefined);
    return added;
  }

  /** Apply reorg changes in order; stops at the first refusal (depth,
   *  fan-out, cycle, chief) and reports what was applied before it. */
  async applyReorg(orgId: string, changes: ReorgChange[], actor: string): Promise<{ applied: string[]; failed?: string }> {
    const applied: string[] = [];
    for (const c of changes) {
      try {
        if (c.op === 'move') await this.org.updateMember(orgId, c.agentId, { reportsToAgentId: c.reportsToAgentId }, actor);
        else if (c.op === 'retitle') await this.org.updateMember(orgId, c.agentId, { title: c.title }, actor);
        else if (c.op === 'pause') await this.org.setMemberStatus(orgId, c.agentId, 'paused', actor);
        else if (c.op === 'resume') await this.org.setMemberStatus(orgId, c.agentId, 'active', actor);
        else if (c.op === 'terminate') await this.org.terminateMember(orgId, c.agentId, actor);
        else if (c.op === 'make_head' || c.op === 'unmake_head') {
          await this.org.setHead(orgId, c.agentId, c.op === 'make_head', actor);
          if (c.op === 'make_head') await this.ensureHeadPlaybooks(orgId, c.agentId).catch(() => undefined);
        }
      } catch (err) {
        return { applied, failed: `${c.op}:${c.agentId} — ${err instanceof Error ? err.message : String(err)}` };
      }
      applied.push(`${c.op}:${c.agentId}`);
    }
    return { applied };
  }

  async expireStale(orgId: string, now: Date = new Date()): Promise<number> {
    // A card still climbing the chain does not expire: its hops time out and it reaches the CEO with a fresh window.
    const stale = (await this.list(orgId, { status: 'pending' })).filter((a) => a.expiresAt && a.expiresAt < now.toISOString() && (!a.holder || a.holder === 'ceo'));
    for (const a of stale) {
      await this.db.update(orgApprovals).set({ status: 'expired', decidedAt: now.toISOString() }).where(eq(orgApprovals.id, a.id));
      await this.audit.append(orgId, { actor: 'system', action: 'approval_expired', refType: 'approval', refId: a.id, payload: { kind: a.kind } });
    }
    return stale.length;
  }
}

/** The decision-card fields of a new card: the proposer's where given and
 *  valid, computed defaults otherwise (docs/owners-seat.md §1). */
export function cardFields(org: { tunables?: string | null } | null, kind: string, payload: Record<string, unknown>, input: CardInput, nowMs: number): Pick<OrgApproval, 'recommendedAction' | 'alternatives' | 'reversibility' | 'confidence' | 'deadline' | 'defaultAction'> {
  const rec = String(input.recommendedAction ?? '').toLowerCase();
  const alternatives = normalizeAlternatives(input.alternatives);
  const computed = defaultActionFor(org, kind, payload);
  // A proposer may make the default stricter (deny), never looser.
  const defaultAction: DefaultAction = input.defaultAction === 'deny' ? 'deny' : computed;
  const hours = govTunable(org, 'seat.deadlineHours');
  return {
    recommendedAction: (RECOMMENDED_ACTIONS as readonly string[]).includes(rec) ? rec : 'approve',
    alternatives: JSON.stringify(alternatives.length ? alternatives : computedAlternatives(kind)),
    reversibility: reversibilityOf(kind, payload),
    confidence: clamp01(input.confidence) ?? govTunable(org, 'seat.defaultConfidence'),
    deadline: new Date(nowMs + hours * 3_600_000).toISOString(),
    defaultAction,
  };
}

export function summarize(kind: string, payload: Record<string, unknown>): string {
  switch (kind) {
    case 'hire': return `${String(payload.name ?? 'agent')} as ${String(payload.title ?? 'specialist')}${payload.packName ? ` (${String(payload.packName)} pack)` : ''}`;
    case 'scope_widen': return `widen ${String(payload.agentName ?? payload.agentId ?? '')}: +${(Array.isArray(payload.widened) ? payload.widened : []).join(', ')}`;
    case 'member_settings': return `${String(payload.agentName ?? payload.agentId ?? 'member')}: ${String(payload.summary ?? 'settings change')}`;
    case 'reorg': return `${Array.isArray(payload.changes) ? payload.changes.length : 0} change(s)`;
    case 'budget_raise': {
      const affected = Array.isArray(payload.affectedObjectives) ? (payload.affectedObjectives as unknown[]).map(String).filter(Boolean) : [];
      const buys = typeof payload.buys === 'string' && payload.buys ? ` — buys: ${payload.buys.slice(0, 80)}` : '';
      return `${String(payload.scope ?? 'company')} cap → $${Number(payload.monthlyUsd ?? 0).toFixed(2)}/month${affected.length ? ` — affects: ${affected.slice(0, 4).join(', ')}` : ''}${buys}`;
    }
    case 'routing': return `route ${String(payload.class ?? '')} → ${String(payload.tier ?? '')}${payload.from ? ` (was ${String(payload.from)})` : ''}`;
    case 'strategy': return `${Array.isArray(payload.goals) ? payload.goals.length : 0} goal(s)`;
    case 'terminate': return `terminate ${String(payload.agentName ?? payload.agentId ?? '')}`;
    case 'external': return String(payload.description ?? 'external action').slice(0, 120);
    case 'escalation': return `task "${String(payload.title ?? '')}": ${String(payload.reason ?? '')}`.slice(0, 160);
    case 'tune': return `tune ${String(payload.key ?? '')} ${payload.from !== undefined ? `${String(payload.from)} → ` : ''}${String(payload.value ?? '')}`;
    case 'cadence': return `${String(payload.kind ?? 'meeting')} of ${String(payload.unitName ?? 'the company')} → ${payload.cron ? String(payload.cron) : 'off'}`;
    case 'charter_change': return `charter of ${String(payload.agentName ?? payload.agentId ?? 'a member')}: ${String(payload.lesson ?? payload.summary ?? 'change proposed by a retro').slice(0, 100)}`;
    case 'blueprint': return `staff "${String(payload.name ?? 'company')}" from its blueprint: ${Array.isArray(payload.hires) ? payload.hires.length : 0} hire(s)`;
    case 'metric_source': return `metric source "${String(payload.name ?? '')}" (${String(payload.kind ?? '')}${payload.target ? `: ${String(payload.target).slice(0, 80)}` : ''})`;
    case 'experiment': return `experiment "${String(payload.title ?? '')}": ${String(payload.changeKind ?? '')} change, ${String(payload.metric ?? 'metric')} ${String(payload.direction ?? 'up') === 'down' ? '↓' : '↑'} ${String(payload.expected ?? '')} in ${String(payload.windowDays ?? '')}d`.slice(0, 200);
    case 'human_review': return `review of task "${String(payload.title ?? '')}" by ${String(payload.reviewerHumanId ?? 'a human')}`.slice(0, 160);
    case 'project_now': return `bet: move ${String(payload.projectKey ?? '')} "${String(payload.title ?? '')}" to Now${payload.appetiteDays || payload.appetiteUsd ? ` (appetite ${payload.appetiteDays ? `${String(payload.appetiteDays)}d` : ''}${payload.appetiteDays && payload.appetiteUsd ? ' / ' : ''}${payload.appetiteUsd ? `$${Number(payload.appetiteUsd).toFixed(0)}` : ''})` : ''}`.slice(0, 200);
    case 'project_appetite': return `${String(payload.projectKey ?? '')} "${String(payload.title ?? '')}" hit its appetite: extend, cut scope or kill${payload.extendUsd || payload.extendDays ? ` (asked: +${payload.extendDays ? `${String(payload.extendDays)}d` : ''}${payload.extendDays && payload.extendUsd ? ' / ' : ''}${payload.extendUsd ? `$${Number(payload.extendUsd).toFixed(2)}` : ''})` : ''}`.slice(0, 200);
    case 'project_allocation': return `allocate ${String(payload.agentName ?? 'a member')} to ${String(payload.projectKey ?? '')} "${String(payload.title ?? '')}" at ${Number(payload.allocation ?? 0)}%${payload.role ? ` as ${String(payload.role)}` : ''}`.slice(0, 200);
    case 'project_kill': return `kill ${String(payload.projectKey ?? '')} "${String(payload.title ?? '')}"`.slice(0, 200);
    case 'two_key': return `${payload.staged ? 'send staged' : 'run held'} ${String(payload.tool ?? 'action')} (${String(payload.class ?? '').replace(/_/g, ' ')}): ${String(payload.summary ?? '')}`.slice(0, 160);
    default: return kind;
  }
}

export { parseBrief };
