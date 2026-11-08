/**
 * OrgQualityService — quality control of results and policies (docs/quality.md).
 *
 * Results: every deliverable passes a gate before it counts as done.
 *
 *  - **Quality standards** are data (`org_quality_standards`): criteria
 *    graded 1–5 with weights, floors and the evidence each needs, a pass
 *    bar, and one scope — the company, a unit, a role, a deliverable kind, a
 *    project, a task, or a process step (by id, `attach`). The most specific
 *    active standard applies to a task (`resolveStandard`).
 *  - **Evidence-gated submission** (`submit`, bound into
 *    OrgTasksService.requestReview): the maker cites references per
 *    criterion; each is verified model-free (an action_log row, a tool call
 *    of the maker, a workspace file and its hash, a URL a tool of the maker
 *    actually fetched, a passing task check, a done task). A submission with
 *    unreal references or gaps is refused with remediation that names what
 *    is missing. Deterministic result policies run here too.
 *  - **Independent verification** (`pickReviewer`, `verdict`): the
 *    verifier differs from the maker (and, by tunable or standard, is on
 *    another model family); an accept needs a score for every criterion;
 *    work below the bar goes back for rework. One QC result per round
 *    (`org_qc_results`) keeps the rubric version, scores, evidence and
 *    verifier.
 *  - **Metrics**: first-pass yield, rework rate and defect escapes (accepted
 *    work later reopened, tied to an incident, or failing a spot check) per
 *    maker, unit and standard; an escape is a rejection on the trust ledger.
 *  - **Spot checks**: a daily, deterministic sample of accepted work is
 *    re-verified model-free and, within a daily cap, re-graded by an
 *    independent member through a spot-check task (`org_qc_grade`).
 *
 * Policies: enforceable data (`org_policies`) — a deterministic predicate
 * over a call's arguments or a result's text, or a judged rule an
 * independent checker reads. Enforced before outward and mutating tool
 * calls through the action contract (`ActionsService.hooks.guard`, every
 * session kind) and at result review. Violations are recorded; a blocked
 * call may get a one-time exception (`policy_exception` card); severe or
 * repeated violations open signals and incidents.
 *
 * Authoring: the chief proposes company standards and policies, heads their
 * unit's. Whether it applies or becomes a `quality_change` card depends on
 * the boundary row (tighten alone, loosen propose), the mode and
 * `policy.authoringApproval`. Every threshold is a per-company tunable
 * (quality-tunables.ts).
 */
import { BadRequestException, Inject, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, desc, eq, gte, inArray, like } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import {
  actionLog, agents as agentsTable, chatMessages, chatSessions, chatTurns, orgIncidents, orgPolicies, orgPolicyViolations, orgQcResults,
  orgQualityLinks, orgQualityStandards, orgTaskChecks, taskTransitions,
} from '../database/schema';
import { newId, nowIso } from '../common/ids.util';
import { currentAccountId } from '../accounts/account-context';
import { AccountsService } from '../accounts/accounts.service';
import { AgentsService } from '../agents/agents.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { ActionsService } from '../actions/actions.service';
import { TrustService } from '../actions/trust.service';
import { canonicalJson, sha256, type ActionClass } from '../actions/action-classes';
import { WorkspaceFs, resolvePath } from '../files/workspace-fs.service';
import { homeOfRow } from '../files/agent-home';
import { taskRef } from '../common/task-keys';
import { OrgService, type Organization } from './org.service';
import { OrgTasksService, REVIEW_ROUND_CAP, familyOf, type OrgTask } from './org-tasks.service';
import { OrgAuditService } from './org-audit.service';
import { OrgApprovalsService, type OrgApproval } from './org-approvals.service';
import { OrgUnitsService } from './org-units.service';
import { OrgSignalsService } from './org-signals.service';
import { OrgIncidentsService } from './org-incidents.service';
import { isAgentActor } from './boundary';
import { qualityTunable } from './quality-tunables';
import {
  QUALITY_TEMPLATES, SCOPE_RANK, SEVERITY_RANK, deliverableOf, evaluateRule, evidenceGaps, grade, normalizeEvidence, normalizePolicy, normalizeScores,
  normalizeStandard, parseCriteria, parseRule, policyLoosens, policyMessage, qualityBreakdown, ruleCoversAction, sampled, standardLoosens, standardSlugOf,
  type Criterion, type EvidenceRef, type PolicySeverity, type QcRow, type VerifiedRef,
} from './quality-model';

export type QualityStandard = typeof orgQualityStandards.$inferSelect;
export type OrgPolicy = typeof orgPolicies.$inferSelect;
export type PolicyViolation = typeof orgPolicyViolations.$inferSelect;
export type QcResult = typeof orgQcResults.$inferSelect;

/** Another module names a task's standard (the process engine: a step's standard by id). */
export type StandardResolver = (orgId: string, task: OrgTask) => Promise<string | null | undefined>;

const DAY = 24 * 60 * 60_000;
const FETCH_TOOL = /(web_fetch|http_request|fetch_url|browser_open|browser_navigate|browser_goto|url_fetch)/;
const URL_RE = /https?:\/\/[^\s"'<>]+/g;
const MAX_FILE_BYTES = 60_000;
const parse = <T>(raw: string | null | undefined, fallback: T): T => { try { return raw ? JSON.parse(raw) as T : fallback; } catch { return fallback; } };
const normUrl = (u: string) => u.trim().replace(/[),.;]+$/, '').replace(/\/+$/, '').toLowerCase();

@Injectable()
export class OrgQualityService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OrgQualityService.name);
  private timer?: ReturnType<typeof setInterval>;
  private readonly resolvers: StandardResolver[] = [];
  /** agentId → recent tool calls (in-process; the persisted record is the transcript). */
  private readonly ledger = new Map<string, Array<{ tool: string; urls: string[]; at: number }>>();
  private readonly lastSweep = new Map<string, number>();
  /** orgId → its active policies, briefly: the guard runs on every mutating call. */
  private readonly activeCache = new Map<string, { at: number; rows: OrgPolicy[] }>();
  now: () => Date = () => new Date();

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly org: OrgService,
    private readonly tasks: OrgTasksService,
    private readonly audit: OrgAuditService,
    private readonly approvals: OrgApprovalsService,
    private readonly agents: AgentsService,
    @Optional() private readonly config?: ConfigService,
    @Optional() private readonly units?: OrgUnitsService,
    @Optional() private readonly signals?: OrgSignalsService,
    @Optional() private readonly incidents?: OrgIncidentsService,
    @Optional() private readonly actions?: ActionsService,
    @Optional() private readonly trust?: TrustService,
    @Optional() private readonly fs?: WorkspaceFs,
    @Optional() private readonly accounts?: AccountsService,
    @Optional() private readonly workspaces?: WorkspacesService,
  ) {
    if (!this.enabled()) return;
    tasks.setQualityGate({
      submit: (orgId, task, input) => this.submit(orgId, task, input),
      pickReviewer: (orgId, task, picked) => this.pickReviewer(orgId, task, picked),
      verdict: (orgId, task, input) => this.verdict(orgId, task, input),
    });
    tasks.onAccepted(async (ev) => { if (ev.by === 'check') await this.acceptedByCheck(ev.orgId, ev.task).catch(() => undefined); });
    approvals.onApply('quality_change', (orgId, payload, approval) => this.applyChange(orgId, payload, approval));
    approvals.onApply('policy_exception', (orgId, payload) => this.applyException(orgId, payload));
    approvals.onDecided(async (ev) => {
      if (ev.decision === 'approve') return;
      if (ev.approval.kind === 'quality_change') await this.declineChange(ev.orgId, JSON.parse(ev.approval.payload || '{}') as Record<string, unknown>, ev.decision).catch(() => undefined);
      if (ev.approval.kind === 'policy_exception' && ev.decision === 'reject') {
        const id = String((JSON.parse(ev.approval.payload || '{}') as { violationId?: string }).violationId ?? '');
        if (id) await this.db.update(orgPolicyViolations).set({ status: 'upheld', decidedAt: nowIso() }).where(eq(orgPolicyViolations.id, id));
      }
    });
    if (actions) actions.hooks.guard = (workspaceId, call) => this.guard(workspaceId, call);
  }

  enabled(): boolean { return this.config?.get<boolean>('companiesEnabled') !== false; }

  onModuleInit(): void {
    if (!this.enabled()) return;
    this.timer = setInterval(() => { void this.tick(); }, 60 * 60_000);
  }

  onModuleDestroy(): void { clearInterval(this.timer); }

  /** Another module names a task's standard (the process engine's step). */
  addStandardResolver(fn: StandardResolver): void { this.resolvers.push(fn); }

  /** Told of every executed tool call of an agent (the tools provider's
   *  onToolResult): what it fetched counts as `url:` evidence this turn. */
  noteToolCall(agentId: string, tool: string, input: Record<string, unknown>, isError: boolean): void {
    if (isError) return;
    const urls = FETCH_TOOL.test(tool) ? [...JSON.stringify(input ?? {}).matchAll(URL_RE)].map((m) => normUrl(m[0])) : [];
    const list = this.ledger.get(agentId) ?? [];
    list.push({ tool, urls, at: Date.now() });
    if (list.length > 500) list.splice(0, list.length - 500);
    this.ledger.set(agentId, list);
  }

  // ---- standards ----

  async listStandards(orgId: string, opts: { status?: string } = {}): Promise<QualityStandard[]> {
    const rows = await this.db.select().from(orgQualityStandards).where(eq(orgQualityStandards.orgId, orgId)).orderBy(desc(orgQualityStandards.updatedAt));
    return opts.status ? rows.filter((r) => r.status === opts.status) : rows;
  }

  async standard(orgId: string, ref: string): Promise<QualityStandard> {
    const q = (ref ?? '').trim().toLowerCase();
    const rows = await this.listStandards(orgId);
    const hit = rows.find((r) => r.id === q || r.slug === q) ?? (q.length >= 6 ? rows.find((r) => r.id.startsWith(q)) : undefined);
    if (!hit) throw new NotFoundException(`no quality standard "${ref}" — org_quality_standards lists them`);
    return hit;
  }

  /** Attach a standard to one task, project or process step explicitly (by id). */
  async attach(orgId: string, standardRef: string, target: { kind: 'task' | 'project' | 'process_step'; id: string }, actor = 'user'): Promise<{ standardId: string }> {
    const s = await this.standard(orgId, standardRef);
    await this.db.delete(orgQualityLinks).where(and(eq(orgQualityLinks.orgId, orgId), eq(orgQualityLinks.targetKind, target.kind), eq(orgQualityLinks.targetId, target.id)));
    await this.db.insert(orgQualityLinks).values({ id: newId(), accountId: currentAccountId(), orgId, standardId: s.id, targetKind: target.kind, targetId: target.id, createdBy: actor, createdAt: nowIso() });
    await this.audit.append(orgId, { actor, action: 'quality_attach', refType: target.kind, refId: target.id, payload: { standardId: s.id, slug: s.slug } });
    return { standardId: s.id };
  }

  /** The standard a task is held to: an explicit link, another module's
   *  answer (a process step), a `standard:` line in the brief, else the most
   *  specific active scope (project, deliverable, role, unit, company). */
  async resolveStandard(orgId: string, task: OrgTask): Promise<QualityStandard | null> {
    const active = (await this.listStandards(orgId)).filter((s) => s.status === 'active');
    if (!active.length) return null;
    const byId = (id: string | null | undefined) => (id ? active.find((s) => s.id === id) ?? null : null);
    const links = await this.db.select().from(orgQualityLinks).where(eq(orgQualityLinks.orgId, orgId));
    const taskLink = byId(links.find((l) => l.targetKind === 'task' && l.targetId === task.id)?.standardId);
    if (taskLink) return taskLink;
    for (const fn of this.resolvers) { const hit = byId(await fn(orgId, task).catch(() => null)); if (hit) return hit; }
    const slug = standardSlugOf(task);
    if (slug) { const hit = active.find((s) => s.slug === slug); if (hit) return hit; }
    const projectLink = task.projectId ? byId(links.find((l) => l.targetKind === 'project' && l.targetId === task.projectId)?.standardId) : null;
    if (projectLink) return projectLink;
    const deliverable = deliverableOf(task);
    const member = task.assigneeAgentId ? await this.org.member(orgId, task.assigneeAgentId) : null;
    const title = (member?.title ?? '').toLowerCase();
    const unitPath = task.unitId && this.units ? await this.units.ancestry(orgId, task.unitId).catch(() => [task.unitId!]) : task.unitId ? [task.unitId] : [];
    const fits = (s: QualityStandard): number | null => {
      if (s.unitId && !unitPath.includes(s.unitId)) return null;
      const bonus = s.unitId ? 5 : 0;
      switch (s.scopeKind) {
        case 'task': return s.scopeRef === task.id || s.scopeRef.toUpperCase() === (task.key ?? '').toUpperCase() ? SCOPE_RANK.task : null;
        case 'project': return task.projectId && s.scopeRef === task.projectId ? SCOPE_RANK.project : null;
        case 'deliverable': return s.scopeRef === deliverable ? SCOPE_RANK.deliverable + bonus : null;
        case 'role': return title && (title === s.scopeRef.toLowerCase() || title.includes(s.scopeRef.toLowerCase())) ? SCOPE_RANK.role + bonus : null;
        case 'unit': return unitPath.includes(s.scopeRef) ? SCOPE_RANK.unit + unitPath.indexOf(s.scopeRef) : null;
        case 'company': return SCOPE_RANK.company;
        default: return null;
      }
    };
    const ranked = active.map((s) => ({ s, r: fits(s) })).filter((x): x is { s: QualityStandard; r: number } => x.r !== null).sort((a, b) => b.r - a.r || (a.s.updatedAt < b.s.updatedAt ? 1 : -1));
    return ranked[0]?.s ?? null;
  }

  /** May this actor author a standard or policy of this scope? The chief
   *  (or a person) anywhere; a head only inside its own unit. */
  private async mayAuthor(orgId: string, actor: string, scope: { scopeKind: string; scopeRef: string; unitId?: string | null }): Promise<void> {
    if (!isAgentActor(actor)) return;
    const org = await this.org.get(orgId);
    const agentId = actor === 'chief' ? org.chiefOfStaffAgentId : actor.slice('agent:'.length);
    if (!agentId) throw new BadRequestException('refused: no author');
    if (agentId === org.chiefOfStaffAgentId) return;
    const unit = this.units ? await this.units.ledBy(orgId, agentId).catch(() => null) : null;
    if (!unit || unit.parentUnitId === null) throw new BadRequestException('refused: the chief of staff authors company standards and policies; a head authors its own unit\'s. Propose it to your head or the chief (org_task_comment, or a backlog task)');
    const inUnit = (scope.scopeKind === 'unit' && scope.scopeRef === unit.id) || (scope.unitId === unit.id && ['deliverable', 'role'].includes(scope.scopeKind));
    if (!inUnit) throw new BadRequestException(`refused: as a head you author standards and policies for your own unit only — scopeKind "unit" with scopeRef "${unit.id}", or a deliverable or role scope with unitId "${unit.id}"`);
  }

  /** Apply now, or a `quality_change` card: the boundary row (tighten alone,
   *  loosen propose), `policy.authoringApproval` and the mode decide. */
  private async route(orgId: string, actor: string, change: { kind: 'policy' | 'quality_standard'; loosens: boolean; blocking: boolean; summary: string }): Promise<'apply' | 'card'> {
    const d = await this.org.boundaryDecide(orgId, { kind: change.kind, loosens: change.loosens, summary: change.summary }, actor);
    if (d.outcome === 'refuse' || d.outcome === 'experiment') throw new BadRequestException(d.reason);
    if (d.outcome === 'card') return 'card';
    if (!isAgentActor(actor)) return 'apply';
    const org = await this.org.get(orgId);
    const approval = qualityTunable(org, 'policy.authoringApproval');
    if (approval >= 2 || (approval >= 1 && change.blocking)) return 'card';
    const ws = this.workspaces ? await this.workspaces.get(org.workspaceId).catch(() => null) : null;
    return ws?.orgMode === 'autonomous' ? 'apply' : 'card';
  }

  private async card(orgId: string, actor: string, payload: Record<string, unknown>, why: string): Promise<OrgApproval> {
    return this.approvals.create(orgId, { kind: 'quality_change', payload, requestedBy: actor, recommendation: (why || String(payload.summary ?? '')).slice(0, 600) });
  }

  /** Create a standard (from fields or a template). */
  async createStandard(orgId: string, raw: Record<string, unknown>, actor: string, why = ''): Promise<{ standard: QualityStandard; applied: boolean; approvalId?: string }> {
    const org = await this.org.get(orgId);
    const tpl = raw.template ? QUALITY_TEMPLATES.find((t) => t.id === String(raw.template)) : undefined;
    if (raw.template && !tpl) throw new BadRequestException(`no template "${String(raw.template)}" — templates: ${QUALITY_TEMPLATES.map((t) => t.id).join(', ')}`);
    const merged = tpl ? { name: tpl.name, scopeKind: tpl.deliverable ? 'deliverable' : 'company', scopeRef: tpl.deliverable, summary: tpl.summary, criteria: tpl.criteria, ...Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined && v !== null && v !== '')) } : raw;
    let input;
    try { input = normalizeStandard(merged, { passScore: qualityTunable(org, 'quality.defaultPassScore') }); } catch (err) { throw new BadRequestException(`refused: ${(err as Error).message}`); }
    await this.mayAuthor(orgId, actor, input);
    const existing = (await this.listStandards(orgId)).find((s) => s.slug === input.slug && s.status !== 'retired' && s.status !== 'rejected');
    if (existing) throw new BadRequestException(`refused: a standard "${input.slug}" exists (${existing.status}) — revise it with action "revise"`);
    const how = await this.route(orgId, actor, { kind: 'quality_standard', loosens: false, blocking: false, summary: `quality standard "${input.name}"` });
    const now = nowIso();
    const row: QualityStandard = {
      accountId: currentAccountId(), id: newId(), orgId, slug: input.slug!, name: input.name, scopeKind: input.scopeKind, scopeRef: input.scopeRef, unitId: input.unitId ?? null,
      summary: input.summary, criteria: JSON.stringify(input.criteria), passScore: input.passScore, requireEvidence: input.requireEvidence ? 1 : 0, verifier: input.verifier,
      version: 1, status: how === 'apply' ? 'active' : 'proposed', source: tpl ? `template:${tpl.id}` : isAgentActor(actor) ? actor : 'user',
      ownerAgentId: actor.startsWith('agent:') ? actor.slice(6) : actor === 'chief' ? org.chiefOfStaffAgentId : null, createdBy: actor, approvalId: null, pending: '', createdAt: now, updatedAt: now,
    };
    await this.db.insert(orgQualityStandards).values(row);
    let approvalId: string | undefined;
    if (how === 'card') {
      const a = await this.card(orgId, actor, { target: 'standard', id: row.id, action: 'create', name: row.name, summary: `${row.scopeKind}${row.scopeRef ? ` ${row.scopeRef}` : ''}, ${input.criteria.length} criteria, pass at ${row.passScore}` }, why);
      approvalId = a.id;
      await this.db.update(orgQualityStandards).set({ approvalId: a.id }).where(eq(orgQualityStandards.id, row.id));
    }
    await this.audit.append(orgId, { actor, action: how === 'apply' ? 'quality_standard_set' : 'quality_standard_proposed', refType: 'quality_standard', refId: row.id, payload: { slug: row.slug, version: 1, scope: `${row.scopeKind}:${row.scopeRef}`, why: why.slice(0, 300), approvalId: approvalId ?? null } });
    return { standard: { ...row, approvalId: approvalId ?? null }, applied: how === 'apply', approvalId };
  }

  /** Revise (a new version in place) or retire a standard. */
  async reviseStandard(orgId: string, ref: string, raw: Record<string, unknown>, actor: string, why = ''): Promise<{ standard: QualityStandard; applied: boolean; approvalId?: string }> {
    const org = await this.org.get(orgId);
    const s = await this.standard(orgId, ref);
    if (s.status !== 'active' && s.status !== 'proposed') throw new BadRequestException(`refused: standard "${s.slug}" is ${s.status}`);
    if (s.pending) throw new BadRequestException(`refused: a revision of "${s.slug}" already waits on its card (${(s.approvalId ?? '').slice(0, 8)})`);
    const retire = raw.status === 'retired' || raw.action === 'retire';
    let fields: Partial<QualityStandard>;
    let loosens: boolean;
    if (retire) { fields = { status: 'retired' }; loosens = s.status === 'active'; }
    else {
      const merged = { name: s.name, slug: s.slug, scopeKind: s.scopeKind, scopeRef: s.scopeRef, unitId: s.unitId, summary: s.summary, criteria: parseCriteria(s.criteria), passScore: s.passScore, requireEvidence: s.requireEvidence === 1, verifier: s.verifier, ...Object.fromEntries(Object.entries(raw).filter(([k, v]) => v !== undefined && v !== null && v !== '' && k !== 'action' && k !== 'template')) };
      let input;
      try { input = normalizeStandard(merged, { passScore: qualityTunable(org, 'quality.defaultPassScore') }); } catch (err) { throw new BadRequestException(`refused: ${(err as Error).message}`); }
      fields = { name: input.name, scopeKind: input.scopeKind, scopeRef: input.scopeRef, unitId: input.unitId ?? null, summary: input.summary, criteria: JSON.stringify(input.criteria), passScore: input.passScore, requireEvidence: input.requireEvidence ? 1 : 0, verifier: input.verifier };
      loosens = standardLoosens({ passScore: s.passScore, criteria: parseCriteria(s.criteria), requireEvidence: s.requireEvidence === 1 }, { passScore: input.passScore, criteria: input.criteria, requireEvidence: input.requireEvidence });
    }
    await this.mayAuthor(orgId, actor, { scopeKind: fields.scopeKind ?? s.scopeKind, scopeRef: fields.scopeRef ?? s.scopeRef, unitId: fields.unitId === undefined ? s.unitId : fields.unitId });
    const how = s.status === 'proposed' ? 'apply' : await this.route(orgId, actor, { kind: 'quality_standard', loosens, blocking: false, summary: `${retire ? 'retire' : 'revise'} quality standard "${s.name}"` });
    if (how === 'apply') {
      const next = { ...fields, version: retire ? s.version : s.version + 1, updatedAt: nowIso() };
      await this.db.update(orgQualityStandards).set(next).where(eq(orgQualityStandards.id, s.id));
      await this.audit.append(orgId, { actor, action: retire ? 'quality_standard_retired' : 'quality_standard_set', refType: 'quality_standard', refId: s.id, payload: { slug: s.slug, version: next.version, loosens, why: why.slice(0, 300) } });
      return { standard: { ...s, ...next }, applied: true };
    }
    const a = await this.card(orgId, actor, { target: 'standard', id: s.id, action: retire ? 'retire' : 'revise', name: s.name, summary: retire ? 'retire it' : `version ${s.version + 1}${loosens ? ' (lowers the bar)' : ''}` }, why);
    await this.db.update(orgQualityStandards).set({ pending: JSON.stringify(fields), approvalId: a.id }).where(eq(orgQualityStandards.id, s.id));
    await this.audit.append(orgId, { actor, action: 'quality_standard_proposed', refType: 'quality_standard', refId: s.id, payload: { slug: s.slug, action: retire ? 'retire' : 'revise', loosens, approvalId: a.id } });
    return { standard: { ...s, pending: JSON.stringify(fields), approvalId: a.id }, applied: false, approvalId: a.id };
  }

  // ---- policies ----

  async listPolicies(orgId: string, opts: { status?: string } = {}): Promise<OrgPolicy[]> {
    const rows = await this.db.select().from(orgPolicies).where(eq(orgPolicies.orgId, orgId)).orderBy(desc(orgPolicies.updatedAt));
    return opts.status ? rows.filter((r) => r.status === opts.status) : rows;
  }

  /** The active policies, cached for a few seconds (every write here clears it). */
  private async activePolicies(orgId: string): Promise<OrgPolicy[]> {
    const hit = this.activeCache.get(orgId);
    if (hit && Date.now() - hit.at < 5_000) return hit.rows;
    const rows = await this.listPolicies(orgId, { status: 'active' });
    this.activeCache.set(orgId, { at: Date.now(), rows });
    return rows;
  }

  async policy(orgId: string, ref: string): Promise<OrgPolicy> {
    const q = (ref ?? '').trim().toLowerCase();
    const rows = await this.listPolicies(orgId);
    const hit = rows.find((r) => r.id === q || r.key === q) ?? (q.length >= 6 ? rows.find((r) => r.id.startsWith(q)) : undefined);
    if (!hit) throw new NotFoundException(`no policy "${ref}" — org_policies lists them`);
    return hit;
  }

  async createPolicy(orgId: string, raw: Record<string, unknown>, actor: string, why = ''): Promise<{ policy: OrgPolicy; applied: boolean; approvalId?: string }> {
    const org = await this.org.get(orgId);
    let input;
    try { input = normalizePolicy(raw); } catch (err) { throw new BadRequestException(`refused: ${(err as Error).message}`); }
    await this.mayAuthor(orgId, actor, { scopeKind: input.scopeKind, scopeRef: input.scopeRef, unitId: input.scopeKind === 'unit' ? input.scopeRef : null });
    const existing = (await this.listPolicies(orgId)).find((p) => p.key === input.key && (p.status === 'active' || p.status === 'proposed'));
    if (existing) throw new BadRequestException(`refused: a policy "${input.key}" exists (${existing.status}) — revise it with action "revise"`);
    const how = await this.route(orgId, actor, { kind: 'policy', loosens: false, blocking: input.enforcement === 'block', summary: `policy "${input.key}"` });
    const now = nowIso();
    const row: OrgPolicy = {
      accountId: currentAccountId(), id: newId(), orgId, key: input.key, statement: input.statement, rationale: input.rationale, scopeKind: input.scopeKind, scopeRef: input.scopeRef,
      kind: input.kind, rule: JSON.stringify(input.rule), appliesAt: input.appliesAt, severity: input.severity, enforcement: input.enforcement, remediation: input.remediation,
      ownerAgentId: actor.startsWith('agent:') ? actor.slice(6) : actor === 'chief' ? org.chiefOfStaffAgentId : null, version: 1, status: how === 'apply' ? 'active' : 'proposed',
      source: isAgentActor(actor) ? actor : 'user', createdBy: actor, approvalId: null, pending: '', createdAt: now, updatedAt: now,
    };
    await this.db.insert(orgPolicies).values(row);
    this.activeCache.delete(orgId);
    let approvalId: string | undefined;
    if (how === 'card') {
      const a = await this.card(orgId, actor, { target: 'policy', id: row.id, action: 'create', key: row.key, name: row.key, summary: `${row.enforcement} (${row.severity}): ${row.statement}`.slice(0, 300) }, why || row.rationale);
      approvalId = a.id;
      await this.db.update(orgPolicies).set({ approvalId: a.id }).where(eq(orgPolicies.id, row.id));
    }
    await this.audit.append(orgId, { actor, action: how === 'apply' ? 'policy_set' : 'policy_proposed', refType: 'policy', refId: row.id, payload: { key: row.key, version: 1, enforcement: row.enforcement, severity: row.severity, why: why.slice(0, 300), approvalId: approvalId ?? null } });
    return { policy: { ...row, approvalId: approvalId ?? null }, applied: how === 'apply', approvalId };
  }

  async revisePolicy(orgId: string, ref: string, raw: Record<string, unknown>, actor: string, why = ''): Promise<{ policy: OrgPolicy; applied: boolean; approvalId?: string }> {
    const p = await this.policy(orgId, ref);
    if (p.status !== 'active' && p.status !== 'proposed') throw new BadRequestException(`refused: policy "${p.key}" is ${p.status}`);
    if (p.pending) throw new BadRequestException(`refused: a revision of "${p.key}" already waits on its card (${(p.approvalId ?? '').slice(0, 8)})`);
    const retire = raw.status === 'retired' || raw.action === 'retire';
    let fields: Partial<OrgPolicy>;
    if (retire) fields = { status: 'retired' };
    else {
      const merged = { key: p.key, statement: p.statement, rationale: p.rationale, scopeKind: p.scopeKind, scopeRef: p.scopeRef, kind: p.kind, rule: parseRule(p.rule), appliesAt: p.appliesAt, severity: p.severity, enforcement: p.enforcement, remediation: p.remediation, ...Object.fromEntries(Object.entries(raw).filter(([k, v]) => v !== undefined && v !== null && v !== '' && k !== 'action')) };
      let input;
      try { input = normalizePolicy(merged); } catch (err) { throw new BadRequestException(`refused: ${(err as Error).message}`); }
      fields = { statement: input.statement, rationale: input.rationale, scopeKind: input.scopeKind, scopeRef: input.scopeRef, kind: input.kind, rule: JSON.stringify(input.rule), appliesAt: input.appliesAt, severity: input.severity, enforcement: input.enforcement, remediation: input.remediation };
    }
    const scopeKind = fields.scopeKind ?? p.scopeKind; const scopeRef = fields.scopeRef ?? p.scopeRef;
    await this.mayAuthor(orgId, actor, { scopeKind, scopeRef, unitId: scopeKind === 'unit' ? scopeRef : null });
    const loosens = policyLoosens({ enforcement: p.enforcement, severity: p.severity, status: p.status }, { enforcement: fields.enforcement ?? p.enforcement, severity: fields.severity ?? p.severity, status: fields.status ?? p.status });
    const how = p.status === 'proposed' ? 'apply' : await this.route(orgId, actor, { kind: 'policy', loosens, blocking: (fields.enforcement ?? p.enforcement) === 'block', summary: `${retire ? 'retire' : 'revise'} policy "${p.key}"` });
    if (how === 'apply') {
      const next = { ...fields, version: retire ? p.version : p.version + 1, updatedAt: nowIso() };
      await this.db.update(orgPolicies).set(next).where(eq(orgPolicies.id, p.id));
      this.activeCache.delete(orgId);
      await this.audit.append(orgId, { actor, action: retire ? 'policy_retired' : 'policy_set', refType: 'policy', refId: p.id, payload: { key: p.key, version: next.version, loosens, why: why.slice(0, 300) } });
      return { policy: { ...p, ...next }, applied: true };
    }
    const a = await this.card(orgId, actor, { target: 'policy', id: p.id, action: retire ? 'retire' : 'revise', key: p.key, name: p.key, summary: retire ? 'retire it' : `version ${p.version + 1}${loosens ? ' (loosens it)' : ''}: ${fields.statement ?? p.statement}`.slice(0, 300) }, why);
    await this.db.update(orgPolicies).set({ pending: JSON.stringify(fields), approvalId: a.id }).where(eq(orgPolicies.id, p.id));
    await this.audit.append(orgId, { actor, action: 'policy_proposed', refType: 'policy', refId: p.id, payload: { key: p.key, action: retire ? 'retire' : 'revise', loosens, approvalId: a.id } });
    return { policy: { ...p, pending: JSON.stringify(fields), approvalId: a.id }, applied: false, approvalId: a.id };
  }

  /** An approved `quality_change` card applies the creation, revision or retirement. */
  private async applyChange(orgId: string, payload: Record<string, unknown>, approval: OrgApproval): Promise<Record<string, unknown>> {
    const id = String(payload.id ?? '');
    const action = String(payload.action ?? 'create');
    const table = payload.target === 'policy' ? orgPolicies : orgQualityStandards;
    const row = (await this.db.select().from(table).where(and(eq(table.orgId, orgId), eq(table.id, id)))).at(0) as (QualityStandard | OrgPolicy) | undefined;
    if (!row) throw new BadRequestException('the standard or policy of this card no longer exists');
    const now = nowIso();
    this.activeCache.delete(orgId);
    if (action === 'create') await this.db.update(table).set({ status: 'active', approvalId: null, updatedAt: now }).where(eq(table.id, id));
    else {
      const fields = parse<Record<string, unknown>>(row.pending, {});
      const retire = fields.status === 'retired';
      await this.db.update(table).set({ ...fields, version: retire ? row.version : row.version + 1, pending: '', approvalId: null, updatedAt: now }).where(eq(table.id, id));
    }
    await this.audit.append(orgId, { actor: `approval:${approval.id}`, action: payload.target === 'policy' ? 'policy_set' : 'quality_standard_set', refType: payload.target === 'policy' ? 'policy' : 'quality_standard', refId: id, payload: { action, approvalId: approval.id } });
    return { id, action, target: payload.target ?? 'standard' };
  }

  private async declineChange(orgId: string, payload: Record<string, unknown>, decision: string): Promise<void> {
    const id = String(payload.id ?? '');
    const table = payload.target === 'policy' ? orgPolicies : orgQualityStandards;
    if (payload.action === 'create') { if (decision === 'reject') await this.db.update(table).set({ status: 'rejected', approvalId: null, updatedAt: nowIso() }).where(and(eq(table.orgId, orgId), eq(table.id, id))); }
    else await this.db.update(table).set({ pending: '', approvalId: null }).where(and(eq(table.orgId, orgId), eq(table.id, id)));
  }

  /** Policies that apply to a member (company, its unit and above, its role, an action class). */
  private async policiesFor(orgId: string, agentId: string | null, opts: { stage: 'action' | 'result'; deliverable?: string; unitId?: string | null }): Promise<OrgPolicy[]> {
    const active = (await this.activePolicies(orgId)).filter((p) => p.appliesAt === 'both' || p.appliesAt === opts.stage);
    if (!active.length) return [];
    const member = agentId ? await this.org.member(orgId, agentId) : null;
    const title = (member?.title ?? '').toLowerCase();
    let unitPath: string[] = [];
    const unitId = opts.unitId ?? (agentId && this.units ? (await this.units.unitForAssignee(orgId, agentId).catch(() => null))?.id ?? null : null);
    if (unitId) unitPath = this.units ? await this.units.ancestry(orgId, unitId).catch(() => [unitId]) : [unitId];
    return active.filter((p) => {
      switch (p.scopeKind) {
        case 'company': case 'action_class': return true;
        case 'unit': return unitPath.includes(p.scopeRef);
        case 'role': return Boolean(title) && title.includes(p.scopeRef.toLowerCase());
        case 'deliverable': return opts.stage === 'result' && opts.deliverable === p.scopeRef;
        default: return false;
      }
    });
  }

  /** The pre-execution guard (ActionsService.hooks.guard), model-free. */
  async guard(workspaceId: string, call: { agentId: string | null; sessionId: string; tool: string; input: Record<string, unknown>; cls: ActionClass }): Promise<{ outcome: 'block' | 'warn' | 'cosign'; text: string; rules?: string } | null> {
    if (!call.agentId || call.cls === 'read') return null;
    const org = await this.org.byWorkspace(workspaceId).catch(() => null);
    if (!org || !(await this.activePolicies(org.id)).some((p) => p.appliesAt !== 'result')) return null;
    const m = await this.org.member(org.id, call.agentId);
    if (!m || m.status === 'terminated') return null;
    const policies = (await this.policiesFor(org.id, call.agentId, { stage: 'action' })).filter((p) => ruleCoversAction(parseRule(p.rule), call.tool, call.cls));
    if (!policies.length) return null;
    const inputHash = sha256(canonicalJson(call.input ?? {}));
    const blocks: string[] = []; const warns: string[] = []; const judged: OrgPolicy[] = [];
    for (const p of policies) {
      const rule = parseRule(p.rule);
      if (p.kind === 'judged') { if (evaluateRule({ when: rule.when }, call.input ?? {}).applies) judged.push(p); continue; }
      const r = evaluateRule(rule, call.input ?? {});
      if (!r.violated) continue;
      if (p.enforcement === 'block' && await this.useWaiver(org.id, p, call.agentId, inputHash)) continue;
      const v = await this.recordViolation(org, p, { agentId: call.agentId, stage: 'action', tool: call.tool, inputHash, detail: r.failed.join('; '), outcome: p.enforcement === 'block' ? 'blocked' : p.enforcement === 'warn' ? 'warned' : 'logged' });
      if (p.enforcement === 'block') blocks.push(`${policyMessage(p, r.failed, call.tool)} (violation ${v.id.slice(0, 8)})`);
      else if (p.enforcement === 'warn') warns.push(policyMessage(p, r.failed, call.tool));
    }
    if (blocks.length) return { outcome: 'block', text: blocks.join('\n') };
    if (judged.length) return { outcome: 'cosign', text: warns.join('\n'), rules: judged.map((p) => `"${p.key}": ${p.statement}`).join(' | ') };
    if (warns.length) return { outcome: 'warn', text: warns.join('\n') };
    return null;
  }

  /** A waived violation lets the identical call through once. */
  private async useWaiver(orgId: string, p: OrgPolicy, agentId: string, inputHash: string): Promise<boolean> {
    const w = (await this.db.select().from(orgPolicyViolations).where(and(eq(orgPolicyViolations.orgId, orgId), eq(orgPolicyViolations.policyId, p.id), eq(orgPolicyViolations.agentId, agentId), eq(orgPolicyViolations.inputHash, inputHash), eq(orgPolicyViolations.status, 'waived'))).limit(1)).at(0);
    if (!w) return false;
    await this.db.update(orgPolicyViolations).set({ status: 'used' }).where(eq(orgPolicyViolations.id, w.id));
    await this.audit.append(orgId, { actor: `agent:${agentId}`, action: 'policy_waiver_used', refType: 'policy', refId: p.id, payload: { violationId: w.id } });
    return true;
  }

  private async recordViolation(org: Organization, p: OrgPolicy, v: { agentId: string; stage: 'action' | 'result'; tool?: string; taskId?: string | null; inputHash?: string; detail: string; outcome: 'blocked' | 'warned' | 'logged' }): Promise<PolicyViolation> {
    const row: PolicyViolation = {
      accountId: currentAccountId(), id: newId(), orgId: org.id, policyId: p.id, policyVersion: p.version, agentId: v.agentId, stage: v.stage, tool: v.tool ?? '', actionId: null,
      taskId: v.taskId ?? null, inputHash: v.inputHash ?? '', detail: v.detail.slice(0, 1_000), outcome: v.outcome, status: 'open', approvalId: null, createdAt: nowIso(), decidedAt: null,
    };
    await this.db.insert(orgPolicyViolations).values(row);
    await this.audit.append(org.id, { actor: `agent:${v.agentId}`, action: 'policy_violation', refType: 'policy', refId: p.id, payload: { key: p.key, stage: v.stage, tool: v.tool ?? null, taskId: v.taskId ?? null, outcome: v.outcome, detail: v.detail.slice(0, 300) } });
    // Severe or repeated: a signal for the chief (critical → the CEO), then an incident.
    const name = (await this.agents.get(v.agentId).catch(() => null))?.name ?? 'A member';
    if ((SEVERITY_RANK[p.severity as PolicySeverity] ?? 2) >= qualityTunable(org, 'policy.signalSeverity')) {
      await this.signals?.open(org.id, { kind: 'policy_violation', severity: p.severity === 'critical' ? 'critical' : 'warn', refType: 'policy', refId: `${p.id}:${v.agentId}`, title: `${name} ${v.outcome === 'blocked' ? 'was stopped by' : 'broke'} policy "${p.key}"`.slice(0, 200), detail: `${p.statement} — ${v.detail}`.slice(0, 1_000), addressee: p.severity === 'critical' ? 'ceo' : 'chief' }).catch(() => undefined);
    }
    const since = new Date(Date.now() - qualityTunable(org, 'policy.repeatWindowHours') * 60 * 60_000).toISOString();
    const recent = await this.db.select({ id: orgPolicyViolations.id }).from(orgPolicyViolations).where(and(eq(orgPolicyViolations.orgId, org.id), eq(orgPolicyViolations.policyId, p.id), eq(orgPolicyViolations.agentId, v.agentId), gte(orgPolicyViolations.createdAt, since)));
    if (recent.length >= qualityTunable(org, 'policy.repeatForIncident')) {
      await this.incidents?.open(org.id, { kind: 'policy_violation', severity: p.severity === 'critical' ? 'major' : 'minor', title: `${name} keeps breaking policy "${p.key}" (${recent.length} times)`.slice(0, 200), detail: `${p.statement}\nLatest: ${v.detail}`.slice(0, 2_000), cause: `repeated violations of policy "${p.key}"`, agentId: v.agentId, refType: 'policy', refId: `${p.id}:${v.agentId}`, detectedBy: 'system' }).catch(() => undefined);
    }
    return row;
  }

  async violations(orgId: string, opts: { policyId?: string; agentId?: string; status?: string; limit?: number } = {}): Promise<PolicyViolation[]> {
    const conds = [eq(orgPolicyViolations.orgId, orgId)];
    if (opts.policyId) conds.push(eq(orgPolicyViolations.policyId, opts.policyId));
    if (opts.agentId) conds.push(eq(orgPolicyViolations.agentId, opts.agentId));
    if (opts.status) conds.push(eq(orgPolicyViolations.status, opts.status));
    return this.db.select().from(orgPolicyViolations).where(and(...conds)).orderBy(desc(orgPolicyViolations.createdAt)).limit(Math.min(500, opts.limit ?? 200));
  }

  /** A member asks for a one-time exception to a blocked call: a card the CEO decides. */
  async requestException(orgId: string, violationRef: string, agentId: string, why: string): Promise<{ approvalId: string }> {
    if (!why.trim()) throw new BadRequestException('refused: why is required — what the call is for and why the rule should not apply this once');
    const q = violationRef.trim().toLowerCase();
    const v = (await this.violations(orgId, { agentId })).find((x) => x.id === q || (q.length >= 6 && x.id.startsWith(q)));
    if (!v) throw new BadRequestException(`refused: no violation "${violationRef}" of yours — the refusal names its id`);
    if (v.outcome !== 'blocked' || v.stage !== 'action') throw new BadRequestException('refused: only a blocked call can get an exception');
    if (v.status !== 'open') throw new BadRequestException(`refused: that violation is ${v.status.replace('_', ' ')}`);
    const p = (await this.listPolicies(orgId)).find((x) => x.id === v.policyId);
    const name = (await this.agents.get(agentId).catch(() => null))?.name ?? 'a member';
    const a = await this.approvals.create(orgId, {
      kind: 'policy_exception', requestedBy: `agent:${agentId}`, recommendation: why.slice(0, 600),
      payload: { violationId: v.id, policyId: v.policyId, policyKey: p?.key ?? '', statement: p?.statement ?? '', tool: v.tool, agentId, agentName: name, detail: v.detail, why: why.slice(0, 600) },
    });
    await this.db.update(orgPolicyViolations).set({ status: 'exception_requested', approvalId: a.id }).where(eq(orgPolicyViolations.id, v.id));
    await this.audit.append(orgId, { actor: `agent:${agentId}`, action: 'policy_exception_requested', refType: 'policy', refId: v.policyId, payload: { violationId: v.id, approvalId: a.id } });
    return { approvalId: a.id };
  }

  private async applyException(orgId: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = String(payload.violationId ?? '');
    await this.db.update(orgPolicyViolations).set({ status: 'waived', decidedAt: nowIso() }).where(and(eq(orgPolicyViolations.orgId, orgId), eq(orgPolicyViolations.id, id)));
    const agentId = String(payload.agentId ?? '');
    if (agentId) await this.agents.addEvent(agentId, { kind: 'info', title: `Exception granted: policy "${String(payload.policyKey ?? '')}" for ${String(payload.tool ?? 'the call')}`, body: 'The identical call may run once now.', payload: JSON.stringify({ orgId, violationId: id }), origin: 'loop' }).catch(() => undefined);
    return { violationId: id, waived: true };
  }

  // ---- evidence ----

  /** Verify references model-free. `agentId` is whose work they must be (the maker; null = anyone in the workspace). */
  async verifyRefs(org: Organization, task: OrgTask, refs: EvidenceRef[], agentId: string | null): Promise<Map<string, VerifiedRef & { body?: string }>> {
    return this.verifyEvidence(org, { since: task.createdAt, taskId: task.id }, refs, agentId);
  }

  /** The one evidence verifier (docs/quality.md §2, docs/evidence.md): a
   *  review submission's references and a claim's (OrgClaimsService) are
   *  checked by this code. `since` bounds tool calls, fetches and actions;
   *  `taskId` resolves `check:` refs. `missing` marks a reference whose
   *  referent does not exist at all (no such action, file, task, check, or
   *  a tool the author never ran) — a fabrication signal, not merely an
   *  unproven one. */
  async verifyEvidence(org: Organization, scope: { since: string; taskId?: string | null }, refs: EvidenceRef[], agentId: string | null): Promise<Map<string, VerifiedRef & { body?: string }>> {
    const out = new Map<string, VerifiedRef & { body?: string }>();
    const since = scope.since;
    const agent = agentId ? (await this.db.select({ id: agentsTable.id, workspaceId: agentsTable.workspaceId, homeDir: agentsTable.homeDir }).from(agentsTable).where(eq(agentsTable.id, agentId))).at(0) : undefined;
    const sessionIds = agentId ? (await this.db.select({ id: chatSessions.id }).from(chatSessions).where(eq(chatSessions.agentId, agentId))).map((r) => r.id) : [];
    const mine = this.ledger.get(agentId ?? '') ?? [];
    for (const r of refs) {
      if (out.has(r.raw)) continue;
      const set = (ok: boolean, detail: string, body?: string, missing?: boolean) => out.set(r.raw, { raw: r.raw, kind: r.kind, ok, detail, ...(body !== undefined ? { body } : {}), ...(missing ? { missing: true } : {}) });
      try {
        switch (r.kind) {
          case 'action': {
            const q = r.ref.toLowerCase();
            if (q.length < 8) { set(false, 'an action id needs at least 8 characters'); break; }
            const rows = await this.db.select({ id: actionLog.id, tool: actionLog.tool, status: actionLog.status, agentId: actionLog.agentId }).from(actionLog).where(and(eq(actionLog.workspaceId, org.workspaceId), like(actionLog.id, `${q}%`))).limit(2);
            const a = rows[0];
            if (!a) set(false, 'no such action in the action log', undefined, true);
            else if (agentId && a.agentId !== agentId) set(false, 'that action was not yours');
            else if (!['succeeded', 'staged', 'held'].includes(a.status)) set(false, `that action ${a.status}`);
            else set(true, `${a.tool} ${a.status}`);
            break;
          }
          case 'tool': {
            const byMsg = r.ref.length >= 8 && sessionIds.length ? (await this.db.select({ id: chatMessages.id, toolName: chatMessages.toolName }).from(chatMessages).where(and(like(chatMessages.id, `${r.ref}%`), eq(chatMessages.role, 'tool'), inArray(chatMessages.sessionId, sessionIds))).limit(1)).at(0) : undefined;
            if (byMsg) { set(true, `${byMsg.toolName ?? 'tool'} result`); break; }
            const name = r.ref.toLowerCase();
            const live = mine.some((c) => c.tool.toLowerCase() === name && c.at >= Date.parse(since));
            const stored = !live && sessionIds.length ? (await this.db.select({ id: chatMessages.id }).from(chatMessages).where(and(eq(chatMessages.role, 'tool'), eq(chatMessages.toolName, r.ref), inArray(chatMessages.sessionId, sessionIds), gte(chatMessages.createdAt, since))).limit(1)).length > 0 : false;
            // Never run at all (not merely before the window) is a reference to nothing.
            const ever = live || stored || !agentId || mine.some((c) => c.tool.toLowerCase() === name) || (sessionIds.length ? (await this.db.select({ id: chatMessages.id }).from(chatMessages).where(and(eq(chatMessages.role, 'tool'), eq(chatMessages.toolName, r.ref), inArray(chatMessages.sessionId, sessionIds))).limit(1)).length > 0 : false);
            set(live || stored, live || stored ? `${r.ref} ran during this task` : ever ? `no ${r.ref} call of yours since the task was created` : `you never ran ${r.ref}`, undefined, !ever);
            break;
          }
          case 'file': {
            if (!this.fs) { set(false, 'the file store is not available'); break; }
            let path: string;
            try { path = resolvePath({ home: agent ? homeOfRow(agent).home || `agents/${agent.id}` : '' }, r.ref); } catch { set(false, 'not a workspace path'); break; }
            const file = await this.fs.read(org.workspaceId, path);
            if (!file) { set(false, `no file /${path}`, undefined, true); break; }
            if (r.hash) {
              const h = sha256(file.body.toString('utf8'));
              if (!h.startsWith(r.hash)) { set(false, `/${path} changed since (its sha256 is ${h.slice(0, 12)}…)`); break; }
            }
            set(true, `/${path}${file.meta ? ` v${file.meta.version}` : ''}`, file.body.length <= MAX_FILE_BYTES ? file.body.toString('utf8') : file.body.subarray(0, MAX_FILE_BYTES).toString('utf8'));
            break;
          }
          case 'url': {
            const u = normUrl(r.ref);
            const live = mine.some((c) => c.urls.some((x) => x === u || x.startsWith(u)));
            let found = live;
            if (!found && sessionIds.length) found = (await this.db.select({ id: chatTurns.id }).from(chatTurns).where(and(inArray(chatTurns.sessionId, sessionIds), like(chatTurns.toolCalls, `%${r.ref.replace(/[%_]/g, '')}%`), gte(chatTurns.createdAt, since))).limit(1)).length > 0;
            if (!found && agentId) found = (await this.db.select({ id: actionLog.id }).from(actionLog).where(and(eq(actionLog.workspaceId, org.workspaceId), eq(actionLog.agentId, agentId), like(actionLog.input, `%${r.ref.replace(/[%_]/g, '')}%`), gte(actionLog.createdAt, since))).limit(1)).length > 0;
            set(found, found ? 'fetched by a tool call during this task' : 'no tool call of yours fetched it during this task (web_fetch it, or cite the file you saved it to)');
            break;
          }
          case 'check': {
            const n = Number(r.ref);
            const rows = scope.taskId ? await this.db.select().from(orgTaskChecks).where(and(eq(orgTaskChecks.orgId, org.id), eq(orgTaskChecks.taskId, scope.taskId))) : [];
            const c = Number.isFinite(n) ? rows.filter((x) => x.checkIndex === n - 1 || x.checkIndex === n).sort((a, b) => (a.ranAt < b.ranAt ? 1 : -1))[0] : rows.find((x) => x.id.startsWith(r.ref));
            if (!c) set(false, scope.taskId ? 'no such check result on this task (org_run_checks first)' : 'a check: ref needs the task it ran on', undefined, Boolean(scope.taskId));
            else set(c.status === 'pass', c.status === 'pass' ? `check ${c.checkIndex + 1} passed` : `check ${c.checkIndex + 1} is ${c.status}`);
            break;
          }
          case 'task': {
            const t = await this.tasks.byPrefix(org.id, r.ref).catch(() => null);
            set(Boolean(t && t.status === 'done'), t ? (t.status === 'done' ? `${taskRef(t)} done` : `${taskRef(t)} is ${t.status}`) : 'no such task', undefined, !t);
            break;
          }
        }
      } catch (err) {
        set(false, `could not verify (${err instanceof Error ? err.message : String(err)})`);
      }
    }
    return out;
  }

  /** The judged result policies become criteria the verifier must score. */
  private judgedCriteria(policies: OrgPolicy[]): Criterion[] {
    return policies.filter((p) => p.kind === 'judged').map((p) => ({ id: `policy-${p.key}`.slice(0, 32), text: `Policy "${p.key}": ${p.statement}`, weight: 1, min: p.enforcement === 'block' ? 3 : undefined, evidence: ['none' as const] }));
  }

  private async criteriaFor(orgId: string, task: OrgTask, std: QualityStandard | null): Promise<{ criteria: Criterion[]; policies: OrgPolicy[] }> {
    const policies = await this.policiesFor(orgId, task.assigneeAgentId, { stage: 'result', deliverable: deliverableOf(task), unitId: task.unitId });
    return { criteria: [...(std ? parseCriteria(std.criteria) : []), ...this.judgedCriteria(policies)], policies };
  }

  // ---- the gate ----

  /** Before review (OrgTasksService.requestReview): evidence and result policies. */
  async submit(orgId: string, task: OrgTask, input: { evidence?: unknown; note?: string; fromAgentId: string | null }): Promise<{ note?: string } | void> {
    if (!input.fromAgentId) return;
    const org = await this.org.get(orgId);
    const std = await this.resolveStandard(orgId, task);
    const level = qualityTunable(org, 'quality.evidenceRequired');
    const maker = task.assigneeAgentId ?? input.fromAgentId;
    const { cited, bad } = normalizeEvidence(input.evidence);
    const refs = cited.flatMap((c) => c.refs);
    const verified = await this.verifyRefs(org, task, refs, maker);
    const ok = (raw: string) => verified.get(raw)?.ok === true;
    const problems: string[] = [];
    if (bad.length) problems.push(`Unreadable references: ${bad.slice(0, 6).join(', ')} — write each as file:/path, url:https://…, tool:<tool name>, action:<action id>, check:<n> or task:<key>.`);
    const unreal = [...verified.values()].filter((v) => !v.ok);
    if (unreal.length) problems.push(`Not verifiable: ${unreal.slice(0, 8).map((v) => `${v.raw} (${v.detail})`).join('; ')}. Cite only what exists.`);
    const { criteria, policies } = await this.criteriaFor(orgId, task, std);
    const stdCriteria = std ? parseCriteria(std.criteria) : [];
    if (level >= 1 && std && std.requireEvidence === 1) {
      const gaps = evidenceGaps(stdCriteria, cited, ok);
      if (gaps.length) problems.push(`Missing evidence for: ${gaps.map((g) => `${g.criterion.id} ("${g.criterion.text}") — cite ${g.want}`).join('; ')}.`);
    }
    if (level >= 2 && !std && !refs.some((r) => ok(r.raw))) problems.push('This company asks every submission to cite at least one real reference (quality.evidenceRequired = 2): the file you wrote, the URL you fetched, the tool or action that did it, or a passing check.');
    // Deterministic result policies over the note and the cited files.
    const text = [input.note ?? '', ...[...verified.values()].filter((v) => v.ok && v.body).map((v) => v.body!)].join('\n\n').slice(0, 250_000);
    const subject = { text, note: input.note ?? '', title: task.title, deliverable: deliverableOf(task) };
    const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
    const warnings: string[] = [];
    for (const p of policies.filter((x) => x.kind === 'predicate')) {
      const r = evaluateRule({ when: parseRule(p.rule).when, require: parseRule(p.rule).require, forbid: parseRule(p.rule).forbid }, subject);
      if (!r.applies) continue;
      checks.push({ name: `policy:${p.key}`, ok: !r.violated, detail: r.violated ? r.failed.join('; ') : 'met' });
      if (!r.violated) continue;
      await this.recordViolation(org, p, { agentId: maker, stage: 'result', taskId: task.id, detail: r.failed.join('; '), outcome: p.enforcement === 'block' ? 'blocked' : p.enforcement === 'warn' ? 'warned' : 'logged' });
      if (p.enforcement === 'block') problems.push(policyMessage(p, r.failed).replace(/ If the rule should not apply here.*$/, ' Fix the deliverable and submit again.'));
      else if (p.enforcement === 'warn') warnings.push(policyMessage(p, r.failed));
    }
    checks.unshift({ name: 'evidence', ok: problems.length === 0, detail: `${[...verified.values()].filter((v) => v.ok).length} of ${verified.size} reference(s) verified` });
    if (problems.length) {
      await this.audit.append(orgId, { actor: `agent:${input.fromAgentId}`, action: 'qc_refused', refType: 'task', refId: task.id, payload: { standardId: std?.id ?? null, problems: problems.map((x) => x.slice(0, 200)) } });
      const crit = stdCriteria.length ? ` Its criteria: ${stdCriteria.map((c) => `${c.id}${c.evidence?.length && !c.evidence.includes('none') ? ` (${c.evidence.join('/')})` : c.evidence?.includes('none') ? ' (judged, no evidence)' : ''}`).join(', ')}.` : '';
      throw new BadRequestException(`Refused: ${taskRef(task)} cannot go to review yet${std ? ` — quality standard "${std.name}" v${std.version}` : ''}. ${problems.join(' ')}${crit} Call org_request_review again with evidence: [{ criterion: "<id>", refs: ["file:/org/…", "url:https://…", "tool:web_search"] }].`);
    }
    // The round's QC result opens with the evidence and the checks.
    await this.db.delete(orgQcResults).where(and(eq(orgQcResults.orgId, orgId), eq(orgQcResults.taskId, task.id), eq(orgQcResults.kind, 'review'), eq(orgQcResults.outcome, 'pending')));
    await this.db.insert(orgQcResults).values({
      accountId: currentAccountId(), id: newId(), orgId, taskId: task.id, kind: 'review', standardId: std?.id ?? null, standardVersion: std?.version ?? 0,
      rubric: JSON.stringify(criteria), passScore: std?.passScore ?? qualityTunable(org, 'quality.defaultPassScore'), makerAgentId: maker, unitId: task.unitId, verifier: '', independence: 'unknown',
      round: task.reviewRounds, outcome: 'pending', score: null, scores: '[]',
      evidence: JSON.stringify(cited.map((c) => ({ criterion: c.criterion, refs: c.refs.map((r) => { const v = verified.get(r.raw); return { raw: r.raw, kind: r.kind, ok: v?.ok ?? false, detail: v?.detail ?? '' }; }) }))),
      checks: JSON.stringify(checks), note: (input.note ?? '').slice(0, 2_000), spotTaskId: null, escapedAt: null, escapeReason: '', createdAt: nowIso(), decidedAt: null,
    });
    const lines = [
      refs.length ? `Evidence verified: ${refs.length} reference(s)${std ? ` against quality standard "${std.name}" v${std.version}` : ''}.` : '',
      criteria.length ? `The verifier grades ${criteria.map((c) => c.id).join(', ')} (1–5; pass at ${std?.passScore ?? qualityTunable(org, 'quality.defaultPassScore')}).` : '',
      ...warnings,
    ].filter(Boolean);
    return lines.length ? { note: lines.join(' ') } : undefined;
  }

  private async familiesOf(ids: string[]): Promise<Map<string, string>> {
    const rows = ids.length ? await this.db.select({ id: agentsTable.id, provider: agentsTable.provider, model: agentsTable.model }).from(agentsTable).where(inArray(agentsTable.id, ids)) : [];
    return new Map(rows.map((r) => [r.id, familyOf({ provider: r.provider ?? '', model: r.model ?? '' })]));
  }

  /** Does this task need a verifier on another model family? */
  private async needsOtherFamily(orgId: string, task: OrgTask, std?: QualityStandard | null): Promise<boolean> {
    const org = await this.org.get(orgId);
    const s = std === undefined ? await this.resolveStandard(orgId, task) : std;
    return qualityTunable(org, 'quality.verifierIndependence') >= 2 || s?.verifier === 'family';
  }

  /** Verifier independence: when another model family is required and the
   *  board's pick shares the maker's, the first active member on another
   *  family verifies instead (undefined keeps the pick). */
  async pickReviewer(orgId: string, task: OrgTask, picked: string | null): Promise<string | null | undefined> {
    if (!task.assigneeAgentId || !(await this.needsOtherFamily(orgId, task))) return undefined;
    const members = (await this.org.members(orgId)).filter((m) => m.status === 'active' && m.agentId !== task.assigneeAgentId);
    const fam = await this.familiesOf([task.assigneeAgentId, ...members.map((m) => m.agentId)]);
    const mine = fam.get(task.assigneeAgentId);
    if (picked && fam.get(picked) !== mine) return undefined;
    const other = members.find((m) => fam.get(m.agentId) && fam.get(m.agentId) !== mine);
    return other ? other.agentId : undefined;
  }

  /** Before a verdict lands (OrgTasksService.review): grade, gate, record. */
  async verdict(orgId: string, task: OrgTask, input: { verdict: 'accept' | 'request_changes' | 'escalate'; note?: string; byAgentId?: string | null; byCheck?: boolean; scores?: unknown }): Promise<{ verdict: 'accept' | 'request_changes' | 'escalate'; note?: string } | void> {
    const org = await this.org.get(orgId);
    const std = await this.resolveStandard(orgId, task);
    let row = (await this.db.select().from(orgQcResults).where(and(eq(orgQcResults.orgId, orgId), eq(orgQcResults.taskId, task.id), eq(orgQcResults.kind, 'review'), eq(orgQcResults.outcome, 'pending'))).orderBy(desc(orgQcResults.createdAt)).limit(1)).at(0);
    const { criteria } = row ? { criteria: parse<Criterion[]>(row.rubric, []) } : await this.criteriaFor(orgId, task, std);
    const passScore = row?.passScore || std?.passScore || qualityTunable(org, 'quality.defaultPassScore');
    let verdict = input.verdict;
    let note = input.note;
    const scores = normalizeScores(input.scores);
    const verifier = input.byCheck ? 'check' : input.byAgentId ? `agent:${input.byAgentId}` : 'user';
    let independence = input.byCheck ? 'check' : input.byAgentId ? 'unknown' : 'human';
    if (input.byAgentId && task.assigneeAgentId) {
      const fam = await this.familiesOf([input.byAgentId, task.assigneeAgentId]);
      independence = fam.get(input.byAgentId) && fam.get(input.byAgentId) === fam.get(task.assigneeAgentId) ? 'same_family' : 'different_family';
      if (verdict === 'accept' && independence === 'same_family' && await this.needsOtherFamily(orgId, task, std)) {
        const alt = await this.pickReviewer(orgId, task, input.byAgentId);
        if (alt) {
          const name = (await this.agents.get(alt).catch(() => null))?.name ?? alt.slice(0, 8);
          throw new BadRequestException(`Refused: ${taskRef(task)} must be accepted by a verifier on another model family than its maker's (${std?.verifier === 'family' ? `standard "${std.name}"` : 'quality.verifierIndependence = 2'}); ${name} is one. Request changes with your notes, or leave the accept to ${name} (org_task_comment @${name}).`);
        }
      }
    }
    let g: ReturnType<typeof grade> | null = null;
    if (criteria.length && (verdict === 'accept' || scores.length)) {
      g = grade(criteria, scores, passScore);
      if (verdict === 'accept' && input.byAgentId) {
        if (g.missing.length) throw new BadRequestException(`Refused: accepting ${taskRef(task)} needs a score (1–5) for every criterion${std ? ` of quality standard "${std.name}" v${std.version}` : ''}. Missing: ${g.missing.map((c) => `${c.id} ("${c.text}")`).join('; ')}. Call org_review again with scores: [{ criterion: "${g.missing[0].id}", score: 4, note: "what you checked", evidence: ["file:/org/…"] }, …]. Grade against the evidence on the task timeline; do not accept what you did not check.`);
        const cited = scores.flatMap((s) => s.refs).map((r) => normalizeEvidence([r]).cited[0]?.refs[0]).filter((x): x is EvidenceRef => Boolean(x));
        if (cited.length) {
          const v = await this.verifyRefs(org, task, cited, null);
          const unreal = [...v.values()].filter((x) => !x.ok);
          if (unreal.length) throw new BadRequestException(`Refused: your scores cite references that do not check out: ${unreal.map((x) => `${x.raw} (${x.detail})`).join('; ')}. Cite only what you opened.`);
        }
      }
      if (verdict === 'accept' && !g.pass) {
        verdict = 'request_changes';
        const why = [
          g.score !== null && g.score < passScore ? `weighted score ${g.score} is under the bar of ${passScore}` : '',
          ...g.below.map((b) => `${b.criterion.id} scored ${b.score} (needs ${b.criterion.min})`),
          ...g.missing.map((c) => `${c.id} not graded`),
        ].filter(Boolean).join('; ');
        const fix = g.perCriterion.filter((s) => { const c = criteria.find((x) => x.id === s.criterion); return c && (s.score < (c.min ?? passScore)); }).map((s) => `${s.criterion}: ${s.note || 'raise it'}`).join('; ');
        note = `Below the bar${std ? ` of "${std.name}"` : ''}: ${why}.${fix ? ` Fix: ${fix}.` : ''}${input.note ? ` Reviewer: ${input.note}` : ''}`;
      }
    }
    const rounds = task.reviewRounds + 1;
    const outcome = verdict === 'accept' ? 'pass' : verdict === 'escalate' || rounds > REVIEW_ROUND_CAP ? 'fail' : 'rework';
    const fields = { verifier, independence, outcome, score: g?.score ?? null, scores: JSON.stringify(g?.perCriterion ?? scores), note: (note ?? '').slice(0, 2_000), decidedAt: nowIso() };
    if (row) await this.db.update(orgQcResults).set(fields).where(eq(orgQcResults.id, row.id));
    else {
      row = {
        accountId: currentAccountId(), id: newId(), orgId, taskId: task.id, kind: 'review', standardId: std?.id ?? null, standardVersion: std?.version ?? 0, rubric: JSON.stringify(criteria), passScore,
        makerAgentId: task.assigneeAgentId, unitId: task.unitId, round: task.reviewRounds, evidence: '[]', checks: '[]', spotTaskId: null, escapedAt: null, escapeReason: '', createdAt: nowIso(), ...fields,
      };
      await this.db.insert(orgQcResults).values(row);
    }
    await this.audit.append(orgId, { actor: verifier, action: 'qc_result', refType: 'task', refId: task.id, payload: { outcome, score: g?.score ?? null, standardId: std?.id ?? null, version: std?.version ?? 0, independence } });
    return verdict !== input.verdict || note !== input.note ? { verdict, note } : undefined;
  }

  private async acceptedByCheck(orgId: string, task: OrgTask): Promise<void> {
    const row = (await this.db.select().from(orgQcResults).where(and(eq(orgQcResults.orgId, orgId), eq(orgQcResults.taskId, task.id), eq(orgQcResults.kind, 'review'), eq(orgQcResults.outcome, 'pending'))).limit(1)).at(0);
    const fields = { verifier: 'check', independence: 'check', outcome: 'pass', note: 'accepted by its executable checks', decidedAt: nowIso() };
    if (row) await this.db.update(orgQcResults).set(fields).where(eq(orgQcResults.id, row.id));
    else await this.db.insert(orgQcResults).values({ accountId: currentAccountId(), id: newId(), orgId, taskId: task.id, kind: 'review', standardId: null, standardVersion: 0, rubric: '[]', passScore: 0, makerAgentId: task.assigneeAgentId, unitId: task.unitId, round: task.reviewRounds, score: null, scores: '[]', evidence: '[]', checks: '[]', spotTaskId: null, escapedAt: null, escapeReason: '', createdAt: nowIso(), ...fields });
  }

  // ---- results, metrics, escapes ----

  async results(orgId: string, opts: { taskId?: string; limit?: number } = {}): Promise<QcResult[]> {
    const conds = [eq(orgQcResults.orgId, orgId)];
    if (opts.taskId) conds.push(eq(orgQcResults.taskId, opts.taskId));
    return this.db.select().from(orgQcResults).where(and(...conds)).orderBy(desc(orgQcResults.createdAt)).limit(Math.min(1_000, opts.limit ?? 300));
  }

  /** First-pass yield, rework, escapes per maker, unit and standard, plus policy conformance. */
  async metrics(orgId: string, opts: { days?: number } = {}) {
    await this.refreshEscapes(orgId).catch(() => undefined);
    const since = new Date(this.now().getTime() - (opts.days ?? 30) * DAY).toISOString();
    const rows = (await this.results(orgId, { limit: 1_000 })).filter((r) => r.createdAt >= since);
    const qc = qualityBreakdown(rows as unknown as QcRow[]);
    const viol = (await this.violations(orgId, { limit: 500 })).filter((v) => v.createdAt >= since);
    const policies = await this.listPolicies(orgId);
    const byPolicy = Object.fromEntries(policies.map((p) => {
      const mine = viol.filter((v) => v.policyId === p.id);
      return [p.id, { key: p.key, violations: mine.length, blocked: mine.filter((v) => v.outcome === 'blocked').length, warned: mine.filter((v) => v.outcome === 'warned').length, waived: mine.filter((v) => v.status === 'waived' || v.status === 'used').length }];
    }));
    const resultChecks = rows.flatMap((r) => parse<Array<{ name: string; ok: boolean }>>(r.checks, [])).filter((c) => c.name.startsWith('policy:'));
    return { days: opts.days ?? 30, ...qc, policies: { violations: viol.length, byPolicy, resultConformance: resultChecks.length ? Math.round((resultChecks.filter((c) => c.ok).length / resultChecks.length) * 1000) / 1000 : null } };
  }

  /** A member's quality record (reputation): FPY, rework, escapes. */
  async memberQuality(orgId: string, agentId: string) {
    const m = await this.metrics(orgId, { days: 90 });
    return m.byAgent[agentId] ?? null;
  }

  /** Mark accepted work found defective since: reopened after acceptance, or an incident opened on the task. */
  async refreshEscapes(orgId: string): Promise<number> {
    const org = await this.org.get(orgId);
    const passes = (await this.db.select().from(orgQcResults).where(and(eq(orgQcResults.orgId, orgId), eq(orgQcResults.outcome, 'pass'), eq(orgQcResults.kind, 'review')))).filter((r) => !r.escapedAt && r.decidedAt);
    if (!passes.length) return 0;
    const ids = [...new Set(passes.map((p) => p.taskId))];
    const reopened = await this.db.select().from(taskTransitions).where(and(eq(taskTransitions.orgId, orgId), eq(taskTransitions.fromStatus, 'done'), inArray(taskTransitions.taskId, ids)));
    const incidents = await this.db.select({ refId: orgIncidents.refId, openedAt: orgIncidents.openedAt, title: orgIncidents.title, kind: orgIncidents.kind }).from(orgIncidents).where(and(eq(orgIncidents.orgId, orgId), eq(orgIncidents.refType, 'task'), inArray(orgIncidents.refId, ids)));
    let n = 0;
    for (const p of passes) {
      const re = reopened.find((t) => t.taskId === p.taskId && t.at > p.decidedAt! && !['cancelled', 'done'].includes(t.toStatus));
      const inc = incidents.find((i) => i.refId === p.taskId && i.openedAt > p.decidedAt! && i.kind !== 'quality_escape');
      if (!re && !inc) continue;
      await this.escape(org, p, re ? `reopened after acceptance (${re.toStatus}${re.reason ? `: ${re.reason}` : ''})` : `incident after acceptance: ${inc!.title}`);
      n++;
    }
    return n;
  }

  private async escape(org: Organization, p: QcResult, reason: string): Promise<void> {
    await this.db.update(orgQcResults).set({ escapedAt: nowIso(), escapeReason: reason.slice(0, 300) }).where(eq(orgQcResults.id, p.id));
    await this.audit.append(org.id, { actor: 'system', action: 'qc_escape', refType: 'task', refId: p.taskId, payload: { qcId: p.id, reason: reason.slice(0, 300), makerAgentId: p.makerAgentId } });
    if (!p.makerAgentId) return;
    // An escape is a rejection on the maker's trust ledger (its reputation).
    await this.trust?.record(org.workspaceId, p.makerAgentId, 'internal_write', 'rejected', { refType: 'qc', refId: p.id }).catch(() => null);
    const week = new Date(Date.now() - 7 * DAY).toISOString();
    const escapes = (await this.db.select({ id: orgQcResults.id }).from(orgQcResults).where(and(eq(orgQcResults.orgId, org.id), eq(orgQcResults.makerAgentId, p.makerAgentId), gte(orgQcResults.escapedAt, week)))).length;
    const task = await this.tasks.get(org.id, p.taskId).catch(() => null);
    const name = (await this.agents.get(p.makerAgentId).catch(() => null))?.name ?? 'A member';
    await this.signals?.open(org.id, { kind: 'quality_escape', severity: 'warn', refType: 'task', refId: p.taskId, title: `${task ? taskRef(task) : 'Accepted work'} was accepted but found defective`.slice(0, 200), detail: `${name}'s work: ${reason}`.slice(0, 1_000), addressee: 'chief' }).catch(() => undefined);
    if (escapes >= qualityTunable(org, 'quality.escapeIncident')) {
      await this.incidents?.open(org.id, { kind: 'quality_escape', severity: 'minor', title: `${name}'s accepted work keeps coming back (${escapes} escape(s) this week)`.slice(0, 200), detail: reason, cause: 'defects escaped review', agentId: p.makerAgentId, refType: 'agent', refId: `quality:${p.makerAgentId}`, detectedBy: 'system' }).catch(() => undefined);
    }
  }

  // ---- spot checks ----

  async tick(): Promise<void> {
    if (!this.enabled()) return;
    const one = async () => {
      for (const org of await this.org.list()) {
        if (org.status !== 'active') continue;
        const last = this.lastSweep.get(org.id) ?? 0;
        if (Date.now() - last < DAY) continue;
        this.lastSweep.set(org.id, Date.now());
        await this.spotCheck(org.id).catch((err) => this.logger.warn(`quality sweep for org ${org.id} failed: ${err instanceof Error ? err.message : err}`));
      }
    };
    if (!this.accounts) return one();
    await this.accounts.forEachAccount(one);
  }

  /** The daily post-acceptance sample: re-verify the evidence model-free and,
   *  within the daily cap, hand a re-grade to an independent member. */
  async spotCheck(orgId: string): Promise<{ sampled: number; reverified: number; tasks: number; escapes: number }> {
    const org = await this.org.get(orgId);
    let escapes = await this.refreshEscapes(orgId);
    const since = new Date(this.now().getTime() - 7 * DAY).toISOString();
    const all = await this.results(orgId, { limit: 1_000 });
    const checkedTasks = new Set(all.filter((r) => r.kind === 'spot_check').map((r) => r.taskId));
    const today = all.filter((r) => r.kind === 'spot_check' && r.spotTaskId && r.createdAt >= new Date(this.now().getTime() - DAY).toISOString()).length;
    const pool = all.filter((r) => r.kind === 'review' && r.outcome === 'pass' && !r.escapedAt && (r.decidedAt ?? '') >= since && !checkedTasks.has(r.taskId));
    const lowRisk = (r: QcResult) => r.verifier === 'check' || !r.standardId || parse<unknown[]>(r.scores, []).length === 0;
    const picked = pool.filter((r) => sampled(r.taskId, lowRisk(r) ? qualityTunable(org, 'quality.spotCheckPct') : qualityTunable(org, 'quality.spotCheckReviewedPct')));
    let reverified = 0; let made = 0;
    const cap = qualityTunable(org, 'quality.spotChecksPerDay');
    for (const r of picked.slice(0, 50)) {
      const task = await this.tasks.get(orgId, r.taskId).catch(() => null);
      if (!task) continue;
      // Model-free: the cited files still exist and are unchanged.
      const refs = parse<Array<{ refs: Array<{ raw: string; ok: boolean }> }>>(r.evidence, []).flatMap((c) => c.refs).filter((x) => x.ok).map((x) => normalizeEvidence([x.raw]).cited[0]?.refs[0]).filter((x): x is EvidenceRef => Boolean(x) && x!.kind === 'file');
      const v = refs.length ? await this.verifyRefs(org, task, refs, r.makerAgentId) : new Map();
      const gone = [...v.values()].filter((x) => !x.ok);
      reverified++;
      const spot: QcResult = {
        accountId: currentAccountId(), id: newId(), orgId, taskId: r.taskId, kind: 'spot_check', standardId: r.standardId, standardVersion: r.standardVersion, rubric: r.rubric, passScore: r.passScore,
        makerAgentId: r.makerAgentId, unitId: r.unitId, verifier: 'check', independence: 'check', round: 0, outcome: gone.length ? 'fail' : 'pending', score: null, scores: '[]',
        evidence: JSON.stringify([{ criterion: '*', refs: [...v.values()].map((x) => ({ raw: x.raw, kind: x.kind, ok: x.ok, detail: x.detail })) }]), checks: JSON.stringify([{ name: 'evidence still there', ok: gone.length === 0, detail: gone.map((x) => `${x.raw}: ${x.detail}`).join('; ') || 'unchanged' }]),
        note: gone.length ? 'evidence gone or changed since acceptance' : '', spotTaskId: null, escapedAt: null, escapeReason: '', createdAt: nowIso(), decidedAt: gone.length ? nowIso() : null,
      };
      if (gone.length) {
        await this.db.insert(orgQcResults).values(spot);
        await this.escape(org, r, `spot check: evidence gone or changed (${gone.map((x) => x.raw).join(', ')})`);
        escapes++;
        continue;
      }
      // An independent re-grade, within the cap: a spot-check task for another member.
      const verifierId = today + made < cap ? await this.spotVerifier(orgId, r) : null;
      if (!verifierId) { spot.outcome = 'pass'; spot.decidedAt = nowIso(); spot.note = 'evidence re-verified (model-free)'; await this.db.insert(orgQcResults).values(spot); continue; }
      const crit = parse<Criterion[]>(r.rubric, []);
      const t = await this.tasks.create(orgId, {
        title: `QA spot check: ${taskRef(task)} ${task.title}`.slice(0, 200), assigneeAgentId: verifierId, source: 'agent', createdBy: 'trigger', class: 'review',
        brief: {
          outcome: `An independent re-grade of ${taskRef(task)}, already accepted, so the company knows whether its review holds.`,
          context: `Sampled for post-acceptance QA (quality.spotCheck*). Open the task, its timeline and the evidence it cites; do not redo the work.`,
          constraints: 'Grade only; do not change the work. You are not its maker or its reviewer.',
          done_when: `org_qc_grade for ${taskRef(task)} with a 1–5 score for every criterion (${crit.length ? crit.map((c) => c.id).join(', ') : 'done-when, located, handoff'}) and pass or fail.`,
        },
      });
      spot.spotTaskId = t.id; spot.verifier = `agent:${verifierId}`;
      await this.db.insert(orgQcResults).values(spot);
      made++;
    }
    await this.audit.append(orgId, { actor: 'system', action: 'qc_spot_check', refType: 'org', refId: orgId, payload: { pool: pool.length, sampled: picked.length, reverified, tasks: made, escapes } });
    return { sampled: picked.length, reverified, tasks: made, escapes };
  }

  private async spotVerifier(orgId: string, r: QcResult): Promise<string | null> {
    const org = await this.org.get(orgId);
    const exclude = new Set([r.makerAgentId, r.verifier.startsWith('agent:') ? r.verifier.slice(6) : null].filter(Boolean) as string[]);
    const members = (await this.org.members(orgId)).filter((m) => m.status === 'active' && !exclude.has(m.agentId));
    if (!members.length) return null;
    const fam = await this.familiesOf([...(r.makerAgentId ? [r.makerAgentId] : []), ...members.map((m) => m.agentId)]);
    const mine = r.makerAgentId ? fam.get(r.makerAgentId) : undefined;
    const pick = members.find((m) => m.agentId === org.auditorAgentId) ?? members.find((m) => fam.get(m.agentId) !== mine) ?? members.find((m) => m.agentId !== org.chiefOfStaffAgentId) ?? members[0];
    return pick.agentId;
  }

  /** The spot checker's grade (org_qc_grade): pass or fail with scores; a fail is an escape. */
  async gradeSpotCheck(orgId: string, targetRef: string, agentId: string, input: { pass: boolean; scores?: unknown; note?: string }): Promise<{ outcome: string; score: number | null }> {
    const target = await this.tasks.byPrefix(orgId, targetRef);
    const spot = (await this.results(orgId, { taskId: target.id })).find((r) => r.kind === 'spot_check' && r.outcome === 'pending' && r.verifier === `agent:${agentId}`);
    if (!spot) throw new BadRequestException(`refused: no spot check of ${taskRef(target)} is waiting on you`);
    const crit = parse<Criterion[]>(spot.rubric, []);
    const scores = normalizeScores(input.scores);
    const g = crit.length ? grade(crit, scores, spot.passScore || 3) : null;
    if (g && g.missing.length) throw new BadRequestException(`Refused: score every criterion (1–5): missing ${g.missing.map((c) => c.id).join(', ')}.`);
    const pass = input.pass && (g ? g.pass : true);
    const fam = target.assigneeAgentId ? await this.familiesOf([agentId, target.assigneeAgentId]) : new Map<string, string>();
    await this.db.update(orgQcResults).set({ outcome: pass ? 'pass' : 'fail', score: g?.score ?? null, scores: JSON.stringify(g?.perCriterion ?? scores), note: (input.note ?? '').slice(0, 2_000), decidedAt: nowIso(), independence: fam.get(agentId) && fam.get(agentId) === fam.get(target.assigneeAgentId ?? '') ? 'same_family' : 'different_family' }).where(eq(orgQcResults.id, spot.id));
    if (spot.spotTaskId) await this.tasks.update(orgId, spot.spotTaskId, { status: 'done' }, `agent:${agentId}`).catch(() => undefined);
    await this.audit.append(orgId, { actor: `agent:${agentId}`, action: 'qc_spot_grade', refType: 'task', refId: target.id, payload: { pass, score: g?.score ?? null } });
    if (!pass) {
      const accepted = (await this.results(orgId, { taskId: target.id })).find((r) => r.kind === 'review' && r.outcome === 'pass' && !r.escapedAt);
      if (accepted) await this.escape(await this.org.get(orgId), accepted, `failed a spot check${input.note ? `: ${input.note}` : ''}${g?.score !== null && g?.score !== undefined ? ` (score ${g.score})` : ''}`);
    }
    return { outcome: pass ? 'pass' : 'fail', score: g?.score ?? null };
  }

  // ---- what agents read ----

  /** The standard and the result policies a task is held to, for the maker's and the verifier's context. */
  async taskBrief(orgId: string, task: OrgTask, role: 'maker' | 'verifier'): Promise<string | null> {
    const std = await this.resolveStandard(orgId, task);
    const { criteria, policies } = await this.criteriaFor(orgId, task, std);
    if (!criteria.length && !policies.length) return null;
    const lines = [`## Quality standard for ${taskRef(task)}${std ? `: "${std.name}" v${std.version}` : ''}`];
    if (std?.summary) lines.push(std.summary);
    for (const c of criteria) lines.push(`- ${c.id} (weight ${c.weight}${c.min ? `, min ${c.min}` : ''}${c.evidence?.length ? `, evidence ${c.evidence.join('/')}` : ''}): ${c.text}`);
    if (std) lines.push(`Pass: weighted ${std.passScore} of 5, no criterion under its min.`);
    for (const p of policies.filter((x) => x.kind === 'predicate')) lines.push(`- Policy "${p.key}" (${p.enforcement}): ${p.statement}`);
    lines.push(role === 'maker'
      ? 'Submit with org_request_review evidence: [{ criterion, refs }] — real refs only (file:/path you wrote, url: you fetched, tool:<name>, action:<id>, check:<n>); missing or unreal refs are refused.'
      : 'Open the cited evidence, then org_review with scores: [{ criterion, score 1–5, note, evidence }] for every criterion. Accept only what you checked; below the bar goes back for rework.');
    return lines.join('\n');
  }

  /** Every standard, policy and the open violations, for the CoS and heads. */
  async describe(orgId: string): Promise<string> {
    const stds = (await this.listStandards(orgId)).filter((s) => s.status === 'active' || s.status === 'proposed');
    const pols = (await this.listPolicies(orgId)).filter((p) => p.status === 'active' || p.status === 'proposed');
    const m = await this.metrics(orgId, { days: 30 });
    const pct = (x: number | null) => (x === null ? '—' : `${Math.round(x * 100)}%`);
    return [
      `Quality (30 days): first-pass yield ${pct(m.overall.firstPassYield)}, rework ${pct(m.overall.reworkRate)}, ${m.overall.escapes} escape(s), ${m.policies.violations} policy violation(s).`,
      stds.length ? 'Standards:' : 'No quality standards yet (templates: ' + QUALITY_TEMPLATES.map((t) => t.id).join(', ') + ').',
      ...stds.map((s) => `- ${s.slug} v${s.version} [${s.status}] ${s.name} — ${s.scopeKind}${s.scopeRef ? ` ${s.scopeRef}` : ''}${s.unitId ? ` (unit ${s.unitId.slice(0, 8)})` : ''}, ${parseCriteria(s.criteria).length} criteria, pass ${s.passScore}${s.pending ? ' — a revision waits on its card' : ''}`),
      pols.length ? 'Policies:' : 'No policies yet.',
      ...pols.map((p) => `- ${p.key} v${p.version} [${p.status}] ${p.enforcement}/${p.severity} ${p.kind} at ${p.appliesAt}: ${p.statement}${(m.policies.byPolicy[p.id]?.violations ?? 0) ? ` — ${m.policies.byPolicy[p.id].violations} violation(s)` : ''}`),
    ].join('\n');
  }
}
