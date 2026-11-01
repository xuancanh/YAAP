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

export type OrgApproval = typeof orgApprovals.$inferSelect;
export type ApprovalKind = 'hire' | 'scope_widen' | 'reorg' | 'budget_raise' | 'strategy' | 'external' | 'terminate' | 'escalation' | 'tune' | 'cadence' | 'routing' | 'charter_change' | 'blueprint' | 'human_review' | 'metric_source';
export const APPROVAL_KINDS: ApprovalKind[] = ['hire', 'scope_widen', 'reorg', 'budget_raise', 'strategy', 'external', 'terminate', 'escalation', 'tune', 'cadence', 'routing', 'charter_change', 'blueprint', 'human_review', 'metric_source'];

/** Another domain's applier for an approval kind it owns (`cadence` is
 *  OrgMeetingsService's, item 19; `blueprint` is OrgBlueprintsService's,
 *  item 24): registered with `onApply`, called from `decide` on approve. */
export type ApprovalApplier = (orgId: string, payload: Record<string, unknown>, approval: OrgApproval, note?: string) => Promise<Record<string, unknown>>;
export type ApprovalDecision = 'approve' | 'reject' | 'revise';
/** Told after every decision is written (docs/company-vision.md §6: the
 *  decision log; item 22's OrgMemoryService writes the row). */
export type DecisionListener = (ev: { orgId: string; approval: OrgApproval; decision: ApprovalDecision; note: string; result?: Record<string, unknown>; decidedBy: string }) => Promise<void> | void;

export const APPROVAL_TTL_MS = 72 * 60 * 60_000;

const CATALOG: MarketItem[] = [...AUTHORED_PACKS, ...PROFESSION_PACKS] as MarketItem[];

export interface HireInput {
  templateOrPack: string; name?: string; title?: string; charter?: string; reportsToAgentId?: string; scopes?: string[];
  provider?: string; model?: string; monthlyBudgetUsd?: number; recommendation?: string; requestedBy: string;
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
}

export type ReorgChange =
  | { op: 'move'; agentId: string; reportsToAgentId: string }
  | { op: 'retitle'; agentId: string; title: string }
  | { op: 'pause'; agentId: string }
  | { op: 'resume'; agentId: string }
  | { op: 'terminate'; agentId: string };

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

  async pending(orgId: string): Promise<OrgApproval[]> {
    await this.expireStale(orgId);
    return (await this.list(orgId, { status: 'pending' })).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
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
  async create(orgId: string, input: { kind: ApprovalKind; payload: Record<string, unknown>; requestedBy: string; recommendation?: string }): Promise<OrgApproval> {
    const org = await this.org.get(orgId);
    if (!APPROVAL_KINDS.includes(input.kind)) throw new BadRequestException(`approval kind must be one of ${APPROVAL_KINDS.join(', ')}`);
    const row: OrgApproval = {
      id: newId(), accountId: currentAccountId(), orgId, kind: input.kind,
      payload: JSON.stringify(input.payload).slice(0, 60_000),
      requestedBy: input.requestedBy.slice(0, 80), recommendation: (input.recommendation ?? '').slice(0, 600),
      status: 'pending', decidedAt: null, decidedBy: '', decisionNote: '',
      expiresAt: new Date(Date.now() + APPROVAL_TTL_MS).toISOString(), createdAt: nowIso(),
    };
    await this.db.insert(orgApprovals).values(row);
    await this.audit.append(orgId, { actor: input.requestedBy, action: 'approval_request', refType: 'approval', refId: row.id, payload: { kind: input.kind, summary: summarize(input.kind, input.payload) } });
    if (org.chiefOfStaffAgentId) {
      await this.agents.addEvent(org.chiefOfStaffAgentId, {
        kind: 'info', title: `Approval needed (${input.kind}): ${summarize(input.kind, input.payload)}`.slice(0, 200),
        body: input.recommendation ?? '', payload: JSON.stringify({ orgId, approvalId: row.id, kind: input.kind }), origin: 'loop', channel: true,
      }).catch(() => {});
    }
    return row;
  }

  /** Build a hire proposal: the requested scopes are intersected with the
   *  chief's holdings before the card exists; depth/fan-out are checked now
   *  so the card is never un-approvable. */
  async proposeHire(orgId: string, input: HireInput): Promise<OrgApproval> {
    const payload = await this.prepareHire(orgId, input);
    return this.create(orgId, { kind: 'hire', payload: payload as unknown as Record<string, unknown>, requestedBy: input.requestedBy, recommendation: input.recommendation });
  }

  /** Validate a hire and build its payload (shared by the supervised card
   *  and the autonomous path, docs/group-chat.md §5). */
  async prepareHire(orgId: string, input: HireInput): Promise<HirePayload> {
    const org = await this.org.get(orgId);
    const chief = org.chiefOfStaffAgentId ? await this.org.member(orgId, org.chiefOfStaffAgentId) : null;
    const holdings = this.org.scopesOf(chief);
    const pack = OrgApprovalsService.catalogItem(input.templateOrPack);
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
    const requested = parseScopes(role?.scopes ?? input.scopes ?? []);
    const scopes = meetScopes(holdings, requested);
    const name = (input.name ?? role?.name ?? pack?.name ?? input.templateOrPack).trim().slice(0, 60);
    if (!name) throw new BadRequestException('a hire needs a name');
    const charter = (input.charter ?? role?.charter ?? pack?.charter ?? '').slice(0, 20_000);
    if (!pack && !charter) throw new BadRequestException(`"${input.templateOrPack}" is not a catalog pack; a template hire needs a charter`);
    const payload: HirePayload = {
      packId: pack?.id ?? null, packName: pack?.name, name, title: (input.title ?? role?.title ?? pack?.role ?? 'Specialist').slice(0, 80), charter,
      reportsToAgentId: reportsTo, requestedScopes: requested, scopes, outsideChiefHoldings: requested.filter((s) => !scopes.includes(s)),
      provider: input.provider, model: input.model ?? (role?.model || undefined), monthlyBudgetUsd: input.monthlyBudgetUsd,
      skills: pack?.skills?.map((s) => s.name),
      ...(role ? { roleId: role.roleId, modelTier: role.modelTier } : {}),
    };
    return payload;
  }

  /** The CEO's (or a board member's) decision. Only the controller calls
   *  this; `decidedBy` is the deciding human's account id (phase D). */
  async decide(orgId: string, id: string, decision: ApprovalDecision, note = '', actor = 'user', decidedBy = ''): Promise<{ approval: OrgApproval; result?: Record<string, unknown> }> {
    const a = await this.get(orgId, id);
    if (a.status !== 'pending') throw new BadRequestException(`approval is ${a.status}`);
    if (a.expiresAt && a.expiresAt < nowIso()) {
      await this.db.update(orgApprovals).set({ status: 'expired' }).where(eq(orgApprovals.id, id));
      throw new BadRequestException('approval has expired — ask the chief of staff to propose again');
    }
    const payload = JSON.parse(a.payload || '{}') as Record<string, unknown>;
    let result: Record<string, unknown> | undefined;
    let status: OrgApproval['status'];
    if (decision === 'approve') {
      result = await this.apply(orgId, a.kind as ApprovalKind, payload, a, note);
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
    await this.db.update(orgApprovals).set({ status, decidedAt: nowIso(), decidedBy: decidedBy || currentAccountId(), decisionNote: note.slice(0, 2_000) }).where(eq(orgApprovals.id, id));
    await this.audit.append(orgId, { actor, action: `approval_${status}`, refType: 'approval', refId: id, payload: { kind: a.kind, note: note.slice(0, 300), result, decidedBy: decidedBy || currentAccountId() } });
    for (const fn of this.decisionListeners) await Promise.resolve(fn({ orgId, approval: { ...a, status }, decision, note, result, decidedBy: decidedBy || currentAccountId() })).catch(() => undefined);
    const org = await this.org.get(orgId);
    if (org.chiefOfStaffAgentId) {
      await this.agents.addEvent(org.chiefOfStaffAgentId, {
        kind: 'info', title: `CEO ${status.replace('_', ' ')}: ${a.kind} — ${summarize(a.kind, payload)}`.slice(0, 200),
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
  private async apply(orgId: string, kind: ApprovalKind, payload: Record<string, unknown>, approval: OrgApproval, note: string): Promise<Record<string, unknown>> {
    const by = `approval:${approval.id}`;
    switch (kind) {
      case 'hire':
        return this.applyHire(orgId, payload as unknown as HirePayload, 'user', by);
      case 'scope_widen': {
        const agentId = String(payload.agentId ?? '');
        const scopes = parseScopes(payload.scopes);
        await this.org.applyScopes(orgId, agentId, scopes, 'user', by);
        return { agentId, scopes };
      }
      case 'reorg':
        return this.applyReorg(orgId, Array.isArray(payload.changes) ? (payload.changes as ReorgChange[]) : [], 'user');
      case 'budget_raise': {
        const scope = String(payload.scope ?? 'company') as 'company' | 'agent' | 'project';
        const refId = String(payload.refId ?? orgId);
        const b = await this.org.setBudget(orgId, { scope, refId, monthlyUsd: Number(payload.monthlyUsd ?? 0), actor: 'user' });
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
              await this.tasks.create(orgId, { title: t.title, brief: t.brief, projectId: project.id, assigneeAgentId: t.assigneeAgentId ?? null, status: t.assigneeAgentId ? 'todo' : 'backlog', createdBy: by });
              created.tasks++;
            }
          }
        }
        return created;
      }
      case 'terminate': {
        const agentId = String(payload.agentId ?? '');
        await this.org.terminateMember(orgId, agentId, 'user');
        return { agentId };
      }
      case 'tune':
        // A tunable (docs/company-vision.md §1b) the chief proposed in supervised mode; bounds are re-checked on apply.
        return this.org.setTunable(orgId, String(payload.key ?? ''), payload.value, { actor: 'user', why: String(payload.why ?? ''), decidedBy: by });
      // A metric source (docs/sensing.md §4) defines what counts as truth: OrgSensingService activates it.
      case 'cadence':
      case 'charter_change':
      case 'metric_source': {
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
            await this.tasks.update(orgId, taskId, { status: 'todo', reviewRounds: 0, blockers: [] }, 'user');
            await this.tasks.comment(orgId, taskId, { text: `CEO decision: ${note || 'continue'}`, fromAgentId: null, wake: false });
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
    // Re-meet at apply time: the chief's holdings may have narrowed since.
    const chief = org.chiefOfStaffAgentId ? await this.org.member(orgId, org.chiefOfStaffAgentId) : null;
    const scopes = meetScopes(this.org.scopesOf(chief), parseScopes(p.requestedScopes ?? p.scopes ?? []));
    const pack = p.packId ? OrgApprovalsService.catalogItem(p.packId) : undefined;
    const taken = new Set((await this.agents.list()).map((a) => a.name));
    let name = p.name; for (let n = 2; taken.has(name); n++) name = `${p.name} ${n}`;
    // No memory or connection inheritance: a fresh agent with the pack's
    // charter, its skills, and nothing else (§4.6).
    const agent = await this.agents.create({
      name, workspaceId: org.workspaceId, charter: p.charter || pack?.charter || '', role: p.title, provider: p.provider, model: p.model,
      emoji: pack?.emoji, colors: pack?.colors, loops: [],
    });
    for (const s of pack?.skills ?? []) {
      await this.skills?.create({ name: s.name, description: s.description, instructions: s.instructions, agentId: agent.id }).catch(() => {});
    }
    const member = await this.org.addMember(orgId, { agentId: agent.id, title: p.title, reportsToAgentId: p.reportsToAgentId, scopes, actor, grantedBy });
    // Assurance (docs/company-vision.md §5.3): a hire from the Auditor pack (or the Auditor role) becomes the org's auditor when the seat is empty.
    if ((p.packId === 'pack-auditor' || p.roleId === 'auditor') && !(await this.org.get(orgId)).auditorAgentId) await this.org.update(orgId, { auditorAgentId: agent.id }).catch(() => undefined);
    if (p.monthlyBudgetUsd && p.monthlyBudgetUsd > 0) await this.org.setBudget(orgId, { scope: 'agent', refId: agent.id, monthlyUsd: p.monthlyBudgetUsd, actor });
    return { agentId: agent.id, name, scopes, depth: member.depth };
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
      } catch (err) {
        return { applied, failed: `${c.op}:${c.agentId} — ${err instanceof Error ? err.message : String(err)}` };
      }
      applied.push(`${c.op}:${c.agentId}`);
    }
    return { applied };
  }

  async expireStale(orgId: string, now: Date = new Date()): Promise<number> {
    const stale = (await this.list(orgId, { status: 'pending' })).filter((a) => a.expiresAt && a.expiresAt < now.toISOString());
    for (const a of stale) {
      await this.db.update(orgApprovals).set({ status: 'expired', decidedAt: now.toISOString() }).where(eq(orgApprovals.id, a.id));
      await this.audit.append(orgId, { actor: 'system', action: 'approval_expired', refType: 'approval', refId: a.id, payload: { kind: a.kind } });
    }
    return stale.length;
  }
}

export function summarize(kind: string, payload: Record<string, unknown>): string {
  switch (kind) {
    case 'hire': return `${String(payload.name ?? 'agent')} as ${String(payload.title ?? 'specialist')}${payload.packName ? ` (${String(payload.packName)} pack)` : ''}`;
    case 'scope_widen': return `widen ${String(payload.agentName ?? payload.agentId ?? '')}: +${(Array.isArray(payload.widened) ? payload.widened : []).join(', ')}`;
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
    case 'human_review': return `review of task "${String(payload.title ?? '')}" by ${String(payload.reviewerHumanId ?? 'a human')}`.slice(0, 160);
    default: return kind;
  }
}

export { parseBrief };
