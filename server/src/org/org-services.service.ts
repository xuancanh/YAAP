/**
 * OrgServicesService — the service catalog (docs/services.md).
 *
 * Catalog: each department publishes what other functions may ask of it
 * (`org_services`): the fields a requester must give, the role that answers,
 * the process a request runs (default: the `service-request` process —
 * accept → do → confirm) and the accept and resolve SLAs, which start from
 * the company's `service.*` tunables. The chief changes any service, a head
 * its unit's (the boundary's `service` rows), a person anything; whether an
 * agent's change applies at once or waits for a `service_change` card is the
 * company's `service.editApproval`. Every change bumps the version with its
 * author, reason and diff. Templates (service-templates.ts) seed a new
 * company's catalog at bootstrap; an older company sees them as a library.
 *
 * Requests: model-free routing. A request naming a service is checked
 * against its schema (each problem with its fix), goes to the service's
 * department and starts its process through the engine's service-request
 * hook, whose `accept` step is the provider's task; the request's accept
 * clock starts. The provider accepts with a date, declines with a reason or
 * negotiates (a counter-proposal the requester agrees to, counters or
 * withdraws) — every exchange is kept on the request. An ask naming a
 * department but no service runs the default intake with the old handoff
 * SLA (`chief.handoffSlaHours`); one naming neither is the chief's to route
 * (the `cross-function-request` process). Unlisted asks of the same kind
 * are counted, and past `service.suggestAfterRepeats` the provider's head
 * is asked to define a service.
 *
 * SLAs: the minute tick breaches a request nobody answered in time — a
 * `service_breach` card raised from the provider's performer, so decision
 * routing puts it with the provider's head, and each later breach is raised
 * one level higher (the chief, then the CEO's inbox); `service.breachAction`
 * 0 nudges instead. A request past its resolve date tells the provider and
 * the requester. The tick also settles requests whose run finished.
 */
import { BadRequestException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { orgApprovals, orgServiceRequests, orgServices } from '../database/schema';
import { newId, nowIso } from '../common/ids.util';
import { currentAccountId } from '../accounts/account-context';
import { AgentsService } from '../agents/agents.service';
import { OrgService, type Organization } from './org.service';
import { OrgTasksService } from './org-tasks.service';
import { OrgApprovalsService, type OrgApproval } from './org-approvals.service';
import { OrgAuditService } from './org-audit.service';
import { OrgUnitsService, type OrgUnit } from './org-units.service';
import { OrgRuntimeService } from './org-runtime.service';
import { OrgBootstrapService } from './org-bootstrap.service';
import { OrgProcessesService, type OrgProcessRun } from './org-processes.service';
import { chainAbove, holderAgent } from './decision-routing';
import { chiefTunable } from './chief-tunables';
import { serviceTunable } from './service-tunables';
import { SERVICE_TEMPLATES, serviceTemplateById, type ServiceTemplate } from './service-templates';
import { parseSteps } from './work-model';
import { taskRef } from '../common/task-keys';
import {
  OPEN_REQUEST, SLUG_RE, checkRequest, computeServiceMetrics, diffService, fieldsLine, loosens, metricsLine, needWords, normalizeDate, normalizeFields, sameNeed, validateFields,
  type RequestStatus, type ServiceField, type ServiceMetrics, type ServiceShape,
} from './service-model';

export type OrgServiceRow = typeof orgServices.$inferSelect;
export type OrgServiceRequest = typeof orgServiceRequests.$inferSelect;

/** The default intake and the chief's triage (process-templates.ts). */
export const DEFAULT_INTAKE = 'service-request';
export const TRIAGE_PROCESS = 'cross-function-request';

export interface ThreadEntry { at: string; by: string; action: string; due?: string; reason?: string; scope?: string; note?: string }
export interface AuthorInput {
  service?: string; template?: string; name?: string; title?: string; description?: string; fields?: unknown; ownerRole?: string;
  process?: string | null; acceptSlaHours?: number; resolveSlaHours?: number; unitId?: string | null; reason: string;
}
export interface RequestInput { service?: string; unit?: string; title: string; fields?: Record<string, unknown>; why: string; neededBy?: string | null; serves?: string | null }
export interface RespondInput { answer: string; due?: string; reason?: string; alternative?: string; scope?: string; note?: string; unit?: string; service?: string }

const parse = <T>(raw: string | null | undefined, fallback: T): T => { try { const v = JSON.parse(raw || '') as T; return v ?? fallback; } catch { return fallback; } };
const hoursFrom = (now: Date, h: number) => new Date(now.getTime() + h * 3_600_000).toISOString();
const round1 = (n: number) => Math.round(n * 10) / 10;
const agentOf = (actor: string) => (actor.startsWith('agent:') ? actor.slice(6) : null);
const TERMINAL: RequestStatus[] = ['declined', 'delivered', 'cancelled', 'failed'];

@Injectable()
export class OrgServicesService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly org: OrgService,
    private readonly tasks: OrgTasksService,
    private readonly approvals: OrgApprovalsService,
    private readonly audit: OrgAuditService,
    private readonly agents: AgentsService,
    private readonly processes: OrgProcessesService,
    @Optional() private readonly units?: OrgUnitsService,
    @Optional() runtime?: OrgRuntimeService,
    @Optional() bootstrap?: OrgBootstrapService,
  ) {
    approvals.onApply('service_breach', (orgId, payload, a, note) => this.breachDecided(orgId, a, payload, 'approve', note ?? ''));
    approvals.onApply('service_change', (orgId, payload, a) => this.changeDecided(orgId, a, payload, 'approve'));
    approvals.onDecided(({ orgId, approval, decision, note }) => {
      if (decision === 'approve') return;
      const payload = parse<Record<string, unknown>>(approval.payload, {});
      if (approval.kind === 'service_breach') this.defer(() => this.breachDecided(orgId, approval, payload, decision, note));
      if (approval.kind === 'service_change') this.defer(() => this.changeDecided(orgId, approval, payload, decision));
    });
    runtime?.addTicker({ name: 'services', everyMinutes: 1, fn: (org, now) => this.tick(org, now) });
    bootstrap?.onBootstrapped((orgId) => this.seed(orgId, { source: 'bootstrap' }).then((r) => r.map((s) => `service ${s.name}`)));
  }

  private readonly pending = new Set<Promise<unknown>>();
  private defer(fn: () => Promise<unknown>): void {
    const p: Promise<unknown> = Promise.resolve().then(fn).catch(() => undefined).finally(() => { this.pending.delete(p); });
    this.pending.add(p);
  }
  /** Wait for deferred work and the engine's (tests; the tools before they report). */
  async settle(): Promise<void> {
    for (let i = 0; i < 20 && this.pending.size; i++) await Promise.allSettled([...this.pending]);
    await this.processes.settle();
  }

  // ---- the catalog: reads ----

  async list(orgId: string, opts: { includeRetired?: boolean; unitId?: string | null } = {}): Promise<OrgServiceRow[]> {
    const rows = await this.db.select().from(orgServices).where(eq(orgServices.orgId, orgId));
    return rows.filter((s) => (opts.includeRetired || s.status !== 'retired') && (opts.unitId === undefined || s.unitId === opts.unitId)).sort((a, b) => a.title.localeCompare(b.title));
  }

  /** A service by id, name, id prefix or exact title. */
  async get(orgId: string, ref: string): Promise<OrgServiceRow> {
    const q = (ref ?? '').trim();
    if (!q) throw new BadRequestException('service is required (its name, e.g. bug-fix — org_services lists them)');
    const all = await this.db.select().from(orgServices).where(eq(orgServices.orgId, orgId));
    const hit = all.find((s) => s.id === q || s.name === q.toLowerCase()) ?? (q.length >= 6 ? all.find((s) => s.id.startsWith(q)) : undefined) ?? all.find((s) => s.title.toLowerCase() === q.toLowerCase());
    if (!hit) throw new NotFoundException(`no service "${ref}" — org_services lists the catalog; for a need no service covers, request it with unit (the department) and no service`);
    return hit;
  }

  fieldsOf(s: Pick<OrgServiceRow, 'fields'>): ServiceField[] { return normalizeFields(parse(s.fields, [])); }

  private shape(s: OrgServiceRow): ServiceShape {
    return { title: s.title, description: s.description, fields: this.fieldsOf(s), ownerRole: s.ownerRole, processId: s.processId, acceptSlaHours: s.acceptSlaHours, resolveSlaHours: s.resolveSlaHours, unitId: s.unitId };
  }

  private async unit(orgId: string, ref: string): Promise<OrgUnit> {
    const q = ref.trim().replace(/^#/, '').toLowerCase();
    const u = this.units ? (await this.units.units(orgId)).find((x) => x.id === ref.trim() || x.slug === q || x.name.toLowerCase() === q) : undefined;
    if (!u) throw new BadRequestException(`no department "${ref}" — org_people lists them`);
    return u;
  }

  // ---- the catalog: who may change what ----

  /** The chief any service, a head its unit's subtree, a person everything. */
  async owns(orgId: string, actor: string, unitId: string | null): Promise<boolean> {
    const org = await this.org.get(orgId);
    const agentId = actor === 'chief' ? org.chiefOfStaffAgentId : agentOf(actor);
    if (!agentId || agentId === org.chiefOfStaffAgentId) return true;
    if (!this.units || !unitId) return false;
    const led = await this.units.ledBy(orgId, agentId).catch(() => null);
    if (!led) return false;
    return (await this.units.subtree(orgId, led.id).catch(() => [led.id])).includes(unitId);
  }

  private async decideEdit(orgId: string, actor: string, unitId: string | null, prev: ServiceShape | null, next: ServiceShape | null, summary: string): Promise<{ apply: boolean; why: string; boundary?: string }> {
    const own = await this.owns(orgId, actor, unitId);
    const b = await this.org.boundaryDecide(orgId, { kind: 'service', withinUnit: own, summary }, actor);
    if (b.outcome === 'refuse' || b.outcome === 'experiment') throw new BadRequestException(b.reason);
    if (!b.agent) return { apply: true, why: 'a person\'s change' };
    if (b.outcome === 'card') return { apply: false, why: `${b.reason} — its owner decides`, boundary: 'propose' };
    const level = serviceTunable(await this.org.get(orgId), 'service.editApproval');
    if (level >= 2) return { apply: false, why: 'every change to a service is approved in this company (service.editApproval 2)' };
    if (level === 1 && (!next || (prev && loosens(prev, next)))) return { apply: false, why: 'the change loosens what the department promises (a longer SLA, another role, process or department, fewer required fields), which this company approves (service.editApproval 1)' };
    return { apply: true, why: 'within the editor\'s own catalog' };
  }

  /** The linked process: it must exist, take service requests and start with an `accept` task. */
  private async checkProcess(orgId: string, ref: string | null | undefined): Promise<string | null> {
    if (!ref) return null;
    const p = await this.processes.get(orgId, ref);
    const def = await this.processes.activeDef(orgId, p);
    const fix = `link a process whose first stage starts with a task step "accept" and that has a service_request trigger (org_process_author), or leave process empty for the default intake (${DEFAULT_INTAKE})`;
    if (!def || p.status !== 'active') throw new BadRequestException(`refused: the process ${p.name} is ${p.status} — ${fix}`);
    if (!def.triggers.some((t) => t.kind === 'service_request' && t.enabled !== false)) throw new BadRequestException(`refused: the process ${p.name} takes no service requests — ${fix}`);
    const accept = def.nodes.find((n) => n.id === 'accept');
    if (!accept || accept.kind !== 'task' || (accept.stage ?? def.stages[0]?.id) !== def.stages[0]?.id || def.edges.some((e) => e.to === 'accept')) throw new BadRequestException(`refused: the process ${p.name} has no starting "accept" step for the provider's answer — ${fix}`);
    return p.id;
  }

  // ---- the catalog: writes ----

  /**
   * Create, adopt (from a template) or change a service. A person's change
   * applies at once; an agent's by the boundary (its own catalog: alone;
   * another's: a proposal) and `service.editApproval`.
   */
  async author(orgId: string, input: AuthorInput, actor: string): Promise<{ service: OrgServiceRow; applied: boolean; approvalId: string | null; note: string }> {
    const reason = (input.reason ?? '').trim().slice(0, 600);
    if (!reason) throw new BadRequestException('reason is required: say what the requests showed (repeats, breaches, declines) or why the department offers it');
    const org = await this.org.get(orgId);
    const existing = input.service ? await this.get(orgId, input.service) : null;
    const tpl = input.template ? serviceTemplateById(input.template) : undefined;
    if (input.template && !tpl) throw new BadRequestException(`no service template "${input.template}" — the library: ${SERVICE_TEMPLATES.map((t) => t.id).join(', ')}`);
    let unitId: string | null = existing ? existing.unitId : input.unitId !== undefined ? input.unitId : await this.defaultUnit(orgId, actor);
    if (input.unitId !== undefined && existing) unitId = input.unitId;
    if (unitId && this.units) unitId = (await this.units.get(orgId, unitId)).id;
    const base: ServiceShape = existing ? this.shape(existing) : {
      title: tpl?.title ?? '', description: tpl?.summary ?? '', fields: tpl?.fields ?? [], ownerRole: 'head', processId: null, unitId,
      acceptSlaHours: serviceTunable(org, 'service.acceptSlaHours'), resolveSlaHours: round1(serviceTunable(org, 'service.resolveSlaHours') * (tpl?.effort ?? 1)),
    };
    const next: ServiceShape = {
      title: (input.title ?? '').trim().slice(0, 120) || base.title,
      description: input.description !== undefined ? String(input.description).trim().slice(0, 1_000) : base.description,
      fields: input.fields !== undefined ? normalizeFields(input.fields) : base.fields,
      ownerRole: (input.ownerRole ?? '').trim().toLowerCase().slice(0, 60) || base.ownerRole,
      processId: input.process !== undefined ? await this.checkProcess(orgId, input.process) : base.processId,
      acceptSlaHours: input.acceptSlaHours !== undefined ? Number(input.acceptSlaHours) : base.acceptSlaHours,
      resolveSlaHours: input.resolveSlaHours !== undefined ? Number(input.resolveSlaHours) : base.resolveSlaHours,
      unitId,
    };
    if (!next.title) throw new BadRequestException('title is required: what the department offers, e.g. "Bug fix"');
    const problems = validateFields(next.fields).map((p) => `${p.problem}: ${p.fix}`);
    if (!(next.acceptSlaHours > 0 && next.acceptSlaHours <= 720)) problems.push('acceptSlaHours must be between 0 and 720');
    if (!(next.resolveSlaHours > 0 && next.resolveSlaHours <= 4_320)) problems.push('resolveSlaHours must be between 0 and 4320');
    if (next.resolveSlaHours < next.acceptSlaHours) problems.push('resolveSlaHours must be at least acceptSlaHours: delivery cannot come before the answer');
    if (problems.length) throw new BadRequestException(`refused: the service has ${problems.length} problem(s):\n${problems.map((p) => `- ${p}`).join('\n')}`);
    const name = existing?.name ?? (input.name ?? tpl?.id ?? next.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
    if (!existing && !SLUG_RE.test(name)) throw new BadRequestException('name must be a short lowercase slug, e.g. "bug-fix"');
    if (!existing && (await this.list(orgId, { includeRetired: true })).some((s) => s.name === name)) throw new BadRequestException(`a service "${name}" exists — pass service: "${name}" to change it`);
    const action = existing ? 'edit' : tpl ? 'adopt' : 'create';
    const diff = diffService(existing ? base : null, next);
    if (existing && !diff.length) return { service: existing, applied: true, approvalId: null, note: `${existing.title}: nothing changed` };
    const decision = await this.decideEdit(orgId, actor, unitId, existing ? base : null, next, `${action} service "${next.title}"`);
    const now = nowIso();
    let row = existing;
    if (!row) {
      row = {
        accountId: currentAccountId(), id: newId(), orgId, unitId, name, title: next.title, description: next.description, fields: JSON.stringify(next.fields), ownerRole: next.ownerRole,
        processId: next.processId, acceptSlaHours: next.acceptSlaHours, resolveSlaHours: next.resolveSlaHours, status: decision.apply ? 'active' : 'draft', version: decision.apply ? 1 : 0,
        history: JSON.stringify(decision.apply ? [{ version: 1, by: actor.slice(0, 80), reason, diff, at: now }] : []), pending: '', templateId: tpl?.id ?? '', source: tpl ? 'template' : 'authored',
        createdBy: actor.slice(0, 80), createdAt: now, updatedAt: now,
      };
      await this.db.insert(orgServices).values(row);
      if (decision.apply) {
        await this.audit.append(orgId, { actor, action: 'service_create', refType: 'service', refId: row.id, payload: { name, reason: reason.slice(0, 200) } });
        return { service: row, applied: true, approvalId: null, note: `${row.title} (${name}) is in the catalog, v1: accept ${row.acceptSlaHours}h, resolve ${row.resolveSlaHours}h` };
      }
    } else if (decision.apply) {
      const applied = await this.apply(orgId, row, next, actor, reason, diff);
      return { service: applied, applied: true, approvalId: null, note: `${applied.title} v${applied.version}: ${diff.join('; ')}` };
    }
    const card = await this.approvals.create(orgId, {
      kind: 'service_change', requestedBy: actor,
      payload: { serviceId: row.id, serviceTitle: next.title, name, action, reason, diff: diff.slice(0, 20), next, version: (row.version ?? 0) + 1, agentId: agentOf(actor) ?? undefined, ...(decision.boundary ? { boundary: decision.boundary } : {}) },
      recommendation: reason, card: { recommendedAction: 'approve' },
    });
    await this.db.update(orgServices).set({ pending: JSON.stringify({ next, reason, by: actor, approvalId: card.id }), updatedAt: now }).where(eq(orgServices.id, row.id));
    return { service: await this.get(orgId, row.id), applied: false, approvalId: card.id, note: `${next.title}: the ${action} waits for approval (card ${card.id.slice(0, 8)}): ${decision.why}` };
  }

  private async apply(orgId: string, row: OrgServiceRow, next: ServiceShape, actor: string, reason: string, diff: string[]): Promise<OrgServiceRow> {
    const version = (row.version ?? 0) + 1;
    const history = [...parse<unknown[]>(row.history, []), { version, by: actor.slice(0, 80), reason, diff, at: nowIso() }].slice(-30);
    await this.db.update(orgServices).set({
      title: next.title, description: next.description, fields: JSON.stringify(next.fields), ownerRole: next.ownerRole, processId: next.processId, unitId: next.unitId,
      acceptSlaHours: next.acceptSlaHours, resolveSlaHours: next.resolveSlaHours, version, history: JSON.stringify(history), pending: '', status: row.status === 'draft' ? 'active' : row.status, updatedAt: nowIso(),
    }).where(eq(orgServices.id, row.id));
    await this.audit.append(orgId, { actor, action: 'service_version', refType: 'service', refId: row.id, payload: { version, reason: reason.slice(0, 200), diff: diff.slice(0, 8) } });
    return this.get(orgId, row.id);
  }

  private async defaultUnit(orgId: string, actor: string): Promise<string | null> {
    const org = await this.org.get(orgId);
    const agentId = agentOf(actor);
    if (!agentId || agentId === org.chiefOfStaffAgentId || !this.units) return null;
    return (await this.units.ledBy(orgId, agentId).catch(() => null))?.id ?? null;
  }

  /** Retire (no new requests; open ones finish) or restore a service. */
  async retire(orgId: string, ref: string, reason: string, actor: string, opts: { restore?: boolean } = {}): Promise<{ service: OrgServiceRow; applied: boolean; approvalId: string | null; note: string }> {
    const s = await this.get(orgId, ref);
    if (!reason.trim()) throw new BadRequestException('reason is required');
    const to = opts.restore ? 'active' : 'retired';
    if (s.status === to) return { service: s, applied: true, approvalId: null, note: `${s.title} is already ${to}` };
    const decision = await this.decideEdit(orgId, actor, s.unitId, null, null, `${opts.restore ? 'restore' : 'retire'} service "${s.title}"`);
    if (decision.apply) {
      await this.db.update(orgServices).set({ status: to, updatedAt: nowIso() }).where(eq(orgServices.id, s.id));
      await this.audit.append(orgId, { actor, action: opts.restore ? 'service_restore' : 'service_retire', refType: 'service', refId: s.id, payload: { reason: reason.slice(0, 200) } });
      return { service: await this.get(orgId, s.id), applied: true, approvalId: null, note: opts.restore ? `${s.title} takes requests again` : `${s.title} is retired: no new requests; open ones finish` };
    }
    const card = await this.approvals.create(orgId, { kind: 'service_change', requestedBy: actor, payload: { serviceId: s.id, serviceTitle: s.title, name: s.name, action: opts.restore ? 'restore' : 'retire', reason, agentId: agentOf(actor) ?? undefined, ...(decision.boundary ? { boundary: decision.boundary } : {}) }, recommendation: reason });
    return { service: s, applied: false, approvalId: card.id, note: `${opts.restore ? 'restoring' : 'retiring'} ${s.title} waits for approval (card ${card.id.slice(0, 8)}): ${decision.why}` };
  }

  private async changeDecided(orgId: string, a: OrgApproval, payload: Record<string, unknown>, decision: 'approve' | 'reject' | 'revise'): Promise<Record<string, unknown>> {
    const s = await this.get(orgId, String(payload.serviceId ?? '')).catch(() => null);
    if (!s) return { stale: true };
    const by = `approval:${a.id}`;
    if (decision === 'approve') {
      if (payload.action === 'retire' || payload.action === 'restore') {
        await this.db.update(orgServices).set({ status: payload.action === 'retire' ? 'retired' : 'active', updatedAt: nowIso() }).where(eq(orgServices.id, s.id));
        return { serviceId: s.id, status: payload.action === 'retire' ? 'retired' : 'active' };
      }
      const p = parse<{ next?: ServiceShape; reason?: string; by?: string }>(s.pending, {});
      const next = p.next ?? (payload.next as ServiceShape | undefined);
      if (!next) return { stale: true };
      const applied = await this.apply(orgId, s, next, p.by ?? by, p.reason ?? String(payload.reason ?? ''), diffService(s.version ? this.shape(s) : null, next));
      return { serviceId: s.id, version: applied.version };
    }
    await this.db.update(orgServices).set({ pending: '', ...(s.status === 'draft' ? { status: 'retired' } : {}), updatedAt: nowIso() }).where(eq(orgServices.id, s.id));
    return { serviceId: s.id, rejected: true };
  }

  // ---- templates ----

  /** The department a template belongs to (a head whose title or unit name matches), or undefined. */
  private async unitForHint(orgId: string, hint: string[]): Promise<OrgUnit | undefined> {
    if (!this.units || !hint.length) return undefined;
    const members = await this.org.members(orgId);
    for (const u of await this.units.units(orgId)) {
      if (u.parentUnitId === null) continue;
      const lead = members.find((m) => m.agentId === u.leadAgentId);
      const words = `${lead?.title ?? ''} ${u.name}`.toLowerCase();
      if (hint.some((h) => words.includes(h))) return u;
    }
    return undefined;
  }

  /** The library with the department each template would land in, and whether it is adopted. */
  async library(orgId: string): Promise<Array<ServiceTemplate & { unitId: string | null; unitName: string | null; adopted: boolean }>> {
    const have = new Set((await this.list(orgId, { includeRetired: true })).map((s) => s.templateId || s.name));
    const out = [];
    for (const t of SERVICE_TEMPLATES) { const u = await this.unitForHint(orgId, t.unitHint); out.push({ ...t, unitId: u?.id ?? null, unitName: u?.name ?? null, adopted: have.has(t.id) }); }
    return out;
  }

  /** A new company's starter catalog: each template whose department it has, active. Idempotent. */
  async seed(orgId: string, opts: { source: string }): Promise<OrgServiceRow[]> {
    const out: OrgServiceRow[] = [];
    for (const t of SERVICE_TEMPLATES) {
      const u = await this.unitForHint(orgId, t.unitHint);
      if (!u || (await this.list(orgId, { includeRetired: true })).some((s) => s.name === t.id)) continue;
      // Trusted: written as a person would, the author recorded.
      const r = await this.author(orgId, { template: t.id, unitId: u.id, reason: `starter service of ${u.name} (${opts.source})` }, 'system').catch(() => null);
      if (!r) continue;
      await this.db.update(orgServices).set({ source: opts.source }).where(eq(orgServices.id, r.service.id));
      out.push(r.service);
    }
    return out;
  }

  // ---- requests ----

  async requests(orgId: string, opts: { serviceId?: string; status?: string; open?: boolean; limit?: number } = {}): Promise<OrgServiceRequest[]> {
    const conds = [eq(orgServiceRequests.orgId, orgId)];
    if (opts.serviceId) conds.push(eq(orgServiceRequests.serviceId, opts.serviceId));
    if (opts.status) conds.push(eq(orgServiceRequests.status, opts.status));
    const rows = await this.db.select().from(orgServiceRequests).where(and(...conds)).orderBy(desc(orgServiceRequests.createdAt)).limit(opts.limit ?? 500);
    return opts.open ? rows.filter((r) => OPEN_REQUEST.includes(r.status as RequestStatus)) : rows;
  }

  async request(orgId: string, ref: string): Promise<OrgServiceRequest> {
    const q = (ref ?? '').trim();
    if (!q) throw new BadRequestException('request is required (its key, e.g. SR-3)');
    const rows = await this.db.select().from(orgServiceRequests).where(eq(orgServiceRequests.orgId, orgId));
    const hit = rows.find((r) => r.id === q || r.key.toLowerCase() === q.toLowerCase()) ?? (q.length >= 6 ? rows.find((r) => r.id.startsWith(q)) : undefined);
    if (!hit) throw new NotFoundException(`no service request "${ref}"`);
    return hit;
  }

  private async patch(id: string, set: Partial<OrgServiceRequest>): Promise<void> {
    await this.db.update(orgServiceRequests).set({ ...set, updatedAt: nowIso() }).where(eq(orgServiceRequests.id, id));
  }

  private async note(orgId: string, r: OrgServiceRequest, e: Omit<ThreadEntry, 'at'>): Promise<ThreadEntry[]> {
    const fresh = await this.request(orgId, r.id);
    const thread = [...parse<ThreadEntry[]>(fresh.thread, []), { at: nowIso(), ...e }].slice(-40);
    await this.patch(r.id, { thread: JSON.stringify(thread) });
    return thread;
  }

  private async nameOf(actor: string): Promise<string> {
    const id = agentOf(actor);
    if (!id) return actor === 'user' || actor === 'system' ? 'the CEO' : 'a person';
    return (await this.agents.get(id).catch(() => null))?.name ?? 'a member';
  }

  /** What a request serves: a project (key, id or title) or a goal (id or title). */
  private async serves(orgId: string, ref: string | null | undefined): Promise<{ kind: string; id: string | null; label: string }> {
    const q = (ref ?? '').trim();
    if (!q) return { kind: '', id: null, label: '' };
    const ql = q.toLowerCase().replace(/^(project|goal):/, '');
    const p = (await this.org.projects(orgId)).find((x) => x.id === ql || (x.key ?? '').toLowerCase() === ql || x.title.toLowerCase() === ql);
    if (p) return { kind: 'project', id: p.id, label: `${p.key ? `${p.key} ` : ''}${p.title}` };
    const g = (await this.org.goals(orgId)).find((x) => x.id === ql || (ql.length >= 6 && x.id.startsWith(ql)) || x.title.toLowerCase() === ql);
    if (g) return { kind: 'goal', id: g.id, label: g.title };
    throw new BadRequestException(`serves "${ref}" is not a project (its key, e.g. P-3) or a goal (its id or title) — org_projects and org_intent list them; omit serves when it serves none`);
  }

  private async allocKey(orgId: string): Promise<string> {
    const n = (await this.db.select({ key: orgServiceRequests.key }).from(orgServiceRequests).where(eq(orgServiceRequests.orgId, orgId))).reduce((m, r) => Math.max(m, Number(/^SR-(\d+)$/.exec(r.key)?.[1] ?? 0)), 0);
    return `SR-${n + 1}`;
  }

  /**
   * Request a service (or an unlisted need). Routing is model-free: a named
   * service goes to its department and starts its process; a named
   * department with no service runs the default intake; neither is the
   * chief's to triage. A request that does not satisfy the schema is
   * refused with each missing or malformed field and what to give.
   */
  async requestService(orgId: string, input: RequestInput, actor: string): Promise<{ request: OrgServiceRequest; note: string }> {
    const org = await this.org.get(orgId);
    const title = (input.title ?? '').trim().slice(0, 200);
    const why = (input.why ?? '').trim().slice(0, 1_000);
    const problems: string[] = [];
    if (!title) problems.push('title: say in one line what you need (e.g. "Fix the signup crash on Safari")');
    if (!why) problems.push('why: say what it unblocks or which key result it moves — the provider weighs it against its own work');
    const neededBy = input.neededBy ? normalizeDate(input.neededBy) : null;
    if (input.neededBy && !neededBy) problems.push(`neededBy "${input.neededBy}" is not a date: give yyyy-mm-dd`);
    let svc: OrgServiceRow | null = null;
    let providerUnit: OrgUnit | null = null;
    let fit: OrgServiceRow | undefined;
    if (input.service) {
      svc = await this.get(orgId, input.service);
      if (svc.status !== 'active') throw new BadRequestException(`refused: the service ${svc.name} is ${svc.status}${svc.status === 'retired' ? ' — org_services lists what the department offers now' : ' until its first version is approved'}`);
      problems.push(...checkRequest(this.fieldsOf(svc), input.fields ?? {}).problems);
      if (svc.unitId && this.units) providerUnit = await this.units.get(orgId, svc.unitId);
    } else if (input.unit) {
      providerUnit = await this.unit(orgId, input.unit);
      const offered = (await this.list(orgId, { unitId: providerUnit.parentUnitId === null ? null : providerUnit.id })).filter((s) => s.status === 'active');
      // A department with a catalog: an ask that looks like a listed service is pointed at it.
      fit = offered.find((x) => sameNeed(needWords(`${x.title} ${x.name}`), needWords(title)));
    }
    if (problems.length) throw new BadRequestException(`refused: the request is incomplete:\n${problems.map((p) => `- ${p}`).join('\n')}`);
    const fields = svc ? checkRequest(this.fieldsOf(svc), input.fields ?? {}).values : checkRequest([], input.fields ?? {}).values;
    const serves = await this.serves(orgId, input.serves);
    const requesterAgentId = agentOf(actor);
    const requesterUnitId = requesterAgentId && this.units ? (await this.units.unitForAssignee(orgId, requesterAgentId).catch(() => null))?.id ?? null : null;
    if (providerUnit && requesterAgentId && providerUnit.leadAgentId === requesterAgentId && svc) throw new BadRequestException(`refused: ${svc.title} is your own department's service — do it as your own work (org_create_task) instead of requesting it`);
    const triage = !svc && !providerUnit;
    const acceptSla = svc ? svc.acceptSlaHours : chiefTunable(org, 'chief.handoffSlaHours');
    const resolveSla = svc ? svc.resolveSlaHours : Math.max(acceptSla, serviceTunable(org, 'service.resolveSlaHours'));
    const now = new Date();
    let row: OrgServiceRequest | null = null;
    for (let i = 0; i < 6 && !row; i++) {
      const candidate: OrgServiceRequest = {
        accountId: currentAccountId(), id: newId(), orgId, key: await this.allocKey(orgId), serviceId: svc?.id ?? null, serviceVersion: svc?.version ?? null, title,
        fields: JSON.stringify(fields), why, neededBy, servesKind: serves.kind, servesId: serves.id, servesLabel: serves.label,
        requester: actor.slice(0, 80), requesterAgentId, requesterUnitId, providerUnitId: providerUnit?.id ?? null,
        status: triage ? 'triage' : 'open', runId: null, acceptTaskId: null, acceptSlaHours: acceptSla, resolveSlaHours: resolveSla,
        acceptDueAt: triage ? null : hoursFrom(now, acceptSla), resolveDueAt: hoursFrom(now, resolveSla), committedDue: null, counter: '', declineReason: '',
        thread: JSON.stringify([{ at: now.toISOString(), by: actor.slice(0, 80), action: 'requested', note: why.slice(0, 300) }]),
        answeredAt: null, acceptedAt: null, resolvedAt: null, acceptBreachedAt: null, resolveBreachedAt: null, breaches: 0, breachApprovalId: null,
        needKey: svc ? '' : needWords(title).join(' '), suggestedAt: null, createdAt: now.toISOString(), updatedAt: now.toISOString(),
      };
      const inserted = await this.db.insert(orgServiceRequests).values(candidate).onConflictDoNothing().returning();
      if (inserted.length) row = inserted[0];
    }
    if (!row) throw new BadRequestException('could not allocate a request key — try again');
    try {
      await this.startRun(orgId, row, svc, providerUnit, triage ? TRIAGE_PROCESS : null);
    } catch (err) {
      await this.db.delete(orgServiceRequests).where(eq(orgServiceRequests.id, row.id));
      throw new BadRequestException(`refused: the request could not start: ${err instanceof Error ? err.message : String(err)}`);
    }
    await this.audit.append(orgId, { actor, action: 'service_request', refType: 'service_request', refId: row.id, payload: { key: row.key, service: svc?.name ?? null, unit: providerUnit?.name ?? null } });
    const fresh = await this.request(orgId, row.id);
    if (!svc && providerUnit) await this.countRepeat(orgId, fresh).catch(() => undefined);
    const accept = fresh.acceptTaskId ? await this.tasks.get(orgId, fresh.acceptTaskId).catch(() => null) : null;
    const note = triage
      ? `${fresh.key} is with the chief of staff to route (no service named). Next time, org_services may list one that fits.`
      : `${fit ? `(${providerUnit?.name} offers "${fit.title}" — next time request service "${fit.name}" with its fields.) ` : ''}${fresh.key} → ${providerUnit?.name ?? 'the company'}${svc ? ` (${svc.title} v${svc.version})` : ' (unlisted ask)'}: the provider answers within ${acceptSla}h${accept ? ` on ${taskRef(accept)}` : ''}; delivery is due by ${fresh.resolveDueAt!.slice(0, 16)} unless they commit another date. You are told when they answer; block your own task on it (waitsOn task ${accept ? taskRef(accept) : 'the request'}) if it waits.`;
    return { request: fresh, note };
  }

  /** Start the request's process run and remember its accept task. */
  private async startRun(orgId: string, r: OrgServiceRequest, svc: OrgServiceRow | null, providerUnit: OrgUnit | null, processName: string | null): Promise<OrgProcessRun> {
    const procName = processName ?? (svc?.processId ? (await this.processes.get(orgId, svc.processId)).name : DEFAULT_INTAKE);
    if (procName === DEFAULT_INTAKE || procName === TRIAGE_PROCESS) await this.processes.instantiate(orgId, procName);
    const fields = parse<Record<string, string>>(r.fields, {});
    const requesterName = await this.nameOf(r.requester);
    const vars: Record<string, string> = {
      request: r.title, request_key: r.key, service: svc?.title ?? 'unlisted', why: r.why, needed_by: r.neededBy ? r.neededBy.slice(0, 10) : 'no date given',
      accept_sla_hours: String(r.acceptSlaHours), requester: requesterName, requester_agent: r.requesterAgentId ?? '', request_fields: fieldsLine(svc ? this.fieldsOf(svc) : [], fields),
      provider_unit: providerUnit?.id ?? '', provider_role: svc?.ownerRole ?? 'head', due: r.resolveDueAt ? r.resolveDueAt.slice(0, 10) : '',
    };
    for (const [k, v] of Object.entries(fields)) if (!(k in vars)) vars[k] = v;
    const run = await this.processes.startServiceRequest(orgId, svc?.name ?? 'unlisted', {
      process: procName, title: `${r.key} ${r.title}`.slice(0, 160), vars, requestedBy: r.requester, ref: `${r.id}:${procName}`,
      projectId: r.servesKind === 'project' ? r.servesId : null,
    });
    await this.processes.settle();
    const accept = (await this.processes.steps(orgId, run.id)).find((s) => s.nodeId === 'accept' && s.current && s.taskId);
    await this.patch(r.id, { runId: run.id, acceptTaskId: accept?.taskId ?? null });
    return run;
  }

  /** Who may answer for the provider: the accept task's performer, the provider unit's head (or one above), the chief, a person. */
  private async isProvider(orgId: string, r: OrgServiceRequest, actor: string): Promise<boolean> {
    const org = await this.org.get(orgId);
    const a = agentOf(actor);
    if (!a || a === org.chiefOfStaffAgentId) return true;
    if (r.acceptTaskId) { const t = await this.tasks.get(orgId, r.acceptTaskId).catch(() => null); if (t?.assigneeAgentId === a) return true; }
    if (!r.providerUnitId || !this.units) return false;
    const led = await this.units.ledBy(orgId, a).catch(() => null);
    return Boolean(led && (await this.units.subtree(orgId, led.id).catch(() => [led.id])).includes(r.providerUnitId));
  }

  private isRequester(r: OrgServiceRequest, actor: string, org: Organization): boolean {
    const a = agentOf(actor);
    if (!a) return !r.requesterAgentId;
    return a === r.requesterAgentId || a === org.chiefOfStaffAgentId;
  }

  /**
   * An answer on a request. The provider: accept (with a date), decline
   * (with the reason), negotiate (a counter-proposal: a date and/or scope).
   * The requester, on a counter: agree, negotiate back, or withdraw (also
   * any time before delivery). The chief, on an unrouted ask: route to a
   * department or a service. Every answer is kept on the request.
   */
  async respond(orgId: string, ref: string, input: RespondInput, actor: string): Promise<{ request: OrgServiceRequest; note: string }> {
    const org = await this.org.get(orgId);
    const r = await this.request(orgId, ref);
    const answer = (input.answer ?? '').trim().toLowerCase();
    if (TERMINAL.includes(r.status as RequestStatus)) throw new BadRequestException(`refused: ${r.key} is ${r.status} — nothing to answer`);
    const provider = await this.isProvider(orgId, r, actor);
    const requester = this.isRequester(r, actor, org);
    const by = actor.slice(0, 80);
    if (answer === 'route') {
      if (r.status !== 'triage') throw new BadRequestException(`refused: ${r.key} is already routed (${r.status})`);
      if (agentOf(actor) && agentOf(actor) !== org.chiefOfStaffAgentId) throw new BadRequestException('refused: the chief of staff routes a request that names no service');
      return this.route(orgId, r, input, actor);
    }
    if (answer === 'withdraw') {
      if (!requester) throw new BadRequestException('refused: only the requester withdraws a request');
      await this.closeRun(orgId, r, `withdrawn by the requester${input.reason ? `: ${input.reason}` : ''}`, actor);
      await this.patch(r.id, { status: 'cancelled', resolvedAt: nowIso(), counter: '' });
      await this.note(orgId, r, { by, action: 'withdrawn', reason: (input.reason ?? '').slice(0, 300) });
      await this.closeBreachCard(orgId, r, 'the request was withdrawn');
      await this.tell(orgId, r, 'provider', `${r.key} "${r.title}" was withdrawn by the requester${input.reason ? `: ${input.reason}` : ''}.`);
      return { request: await this.request(orgId, r.id), note: `${r.key} is withdrawn.` };
    }
    if (r.status === 'triage') throw new BadRequestException(`refused: ${r.key} waits for the chief to route it (answer route with unit or service)`);
    if (r.status === 'negotiating' && requester && !(provider && agentOf(actor) !== org.chiefOfStaffAgentId && agentOf(actor) !== r.requesterAgentId)) {
      // The requester answers the provider's counter-proposal.
      const counter = parse<{ due?: string; scope?: string; note?: string }>(r.counter, {});
      if (answer === 'agree' || answer === 'accept') {
        const due = normalizeDate(input.due) ?? counter.due ?? null;
        if (!due) throw new BadRequestException('refused: the counter-proposal names no date — give due (yyyy-mm-dd) to agree on one');
        await this.note(orgId, r, { by, action: 'agreed', due, scope: counter.scope, note: (input.note ?? '').slice(0, 300) });
        return this.accept(orgId, await this.request(orgId, r.id), due, actor, counter.scope);
      }
      if (answer === 'negotiate') {
        const due = input.due ? normalizeDate(input.due) : null;
        if (input.due && !due) throw new BadRequestException(`due "${input.due}" is not a date: give yyyy-mm-dd`);
        if (!due && !input.scope && !input.note) throw new BadRequestException('refused: a counter names a date (due), a scope or a note');
        const now = new Date();
        await this.patch(r.id, { status: 'open', counter: '', acceptDueAt: hoursFrom(now, r.acceptSlaHours), acceptBreachedAt: null });
        await this.note(orgId, r, { by, action: 'countered', due: due ?? undefined, scope: input.scope?.slice(0, 600), note: (input.note ?? '').slice(0, 600) });
        await this.tell(orgId, r, 'provider', `${await this.nameOf(actor)} answered your counter on ${r.key} with another: ${[due ? `by ${due.slice(0, 10)}` : '', input.scope ?? '', input.note ?? ''].filter(Boolean).join('; ')}. Answer with org_service_respond request=${r.key} within ${r.acceptSlaHours}h.`, true);
        return { request: await this.request(orgId, r.id), note: `${r.key}: your counter went back to the provider.` };
      }
      throw new BadRequestException('refused: on a counter-proposal the requester answers agree, negotiate or withdraw');
    }
    if (!provider) throw new BadRequestException(`refused: ${r.key} is answered by the providing department (its head or the member its task names)${requester ? '; as the requester you may withdraw it' : ''}`);
    if (r.status === 'accepted' && answer !== 'decline') throw new BadRequestException(`refused: ${r.key} is accepted (due ${r.committedDue?.slice(0, 10) ?? '—'}); deliver it on its task, or decline with the reason if it can no longer be done`);
    if (answer === 'accept') {
      const due = normalizeDate(input.due);
      if (!due) throw new BadRequestException('refused: accept needs the date you commit to (due: yyyy-mm-dd)');
      await this.note(orgId, r, { by, action: 'accepted', due, note: (input.note ?? '').slice(0, 300) });
      return this.accept(orgId, r, due, actor);
    }
    if (answer === 'decline') {
      const reason = (input.reason ?? '').trim();
      if (!reason) throw new BadRequestException('refused: decline needs the reason (and, ideally, an alternative: another department, a later date, a smaller scope)');
      await this.note(orgId, r, { by, action: 'declined', reason: reason.slice(0, 600), note: (input.alternative ?? input.note ?? '').slice(0, 300) });
      return this.decline(orgId, r, reason, input.alternative ?? '', actor);
    }
    if (answer === 'negotiate') {
      const due = input.due ? normalizeDate(input.due) : null;
      if (input.due && !due) throw new BadRequestException(`due "${input.due}" is not a date: give yyyy-mm-dd`);
      if (!due && !input.scope) throw new BadRequestException('refused: a counter-proposal names what you can do instead: a date (due) and/or a scope');
      const counter = { due: due ?? undefined, scope: (input.scope ?? '').slice(0, 600) || undefined, note: (input.note ?? '').slice(0, 600), by, at: nowIso() };
      await this.patch(r.id, { status: 'negotiating', counter: JSON.stringify(counter), answeredAt: r.answeredAt ?? nowIso() });
      await this.note(orgId, r, { by, action: 'negotiate', due: counter.due, scope: counter.scope, note: counter.note });
      await this.closeBreachCard(orgId, r, 'the provider answered with a counter-proposal');
      await this.tell(orgId, r, 'requester', `${await this.nameOf(actor)} proposes for ${r.key} "${r.title}": ${[due ? `by ${due.slice(0, 10)}` : '', counter.scope ?? '', counter.note].filter(Boolean).join('; ')}. Answer with org_service_respond request=${r.key} answer=agree | negotiate | withdraw.`);
      return { request: await this.request(orgId, r.id), note: `${r.key}: your counter-proposal is with the requester.` };
    }
    throw new BadRequestException('answer must be accept (with due), decline (with reason), negotiate (with due and/or scope); the requester: agree, negotiate, withdraw; the chief: route');
  }

  private async accept(orgId: string, r: OrgServiceRequest, due: string, actor: string, scope?: string): Promise<{ request: OrgServiceRequest; note: string }> {
    const now = nowIso();
    await this.patch(r.id, { status: 'accepted', committedDue: due, resolveDueAt: due, acceptedAt: now, answeredAt: r.answeredAt ?? now, counter: '', resolveBreachedAt: null });
    await this.settleStep(orgId, r, 'accept', { answer: 'accepted', due: due.slice(0, 10), ...(scope ? { scope } : {}) }, actor);
    await this.closeBreachCard(orgId, r, 'the provider accepted');
    await this.tell(orgId, r, 'requester', `${r.key} "${r.title}" is accepted by ${await this.nameOf(actor)}: due ${due.slice(0, 10)}${scope ? ` (scope: ${scope})` : ''}.`);
    const fresh = await this.request(orgId, r.id);
    const steps = fresh.runId ? await this.processes.steps(orgId, fresh.runId) : [];
    const doStep = steps.find((s) => s.nodeId === 'do' && s.current && s.taskId);
    const t = doStep ? await this.tasks.get(orgId, doStep.taskId!).catch(() => null) : null;
    return { request: fresh, note: `${r.key} accepted, due ${due.slice(0, 10)}.${t ? ` The delivery is ${taskRef(t)}.` : ''}` };
  }

  private async decline(orgId: string, r: OrgServiceRequest, reason: string, alternative: string, actor: string): Promise<{ request: OrgServiceRequest; note: string }> {
    const now = nowIso();
    await this.patch(r.id, { status: 'declined', declineReason: `${reason}${alternative ? ` — alternative: ${alternative}` : ''}`.slice(0, 800), answeredAt: r.answeredAt ?? now, resolvedAt: now, counter: '' });
    await this.settleStep(orgId, r, 'accept', { answer: 'declined' }, actor);
    await this.closeBreachCard(orgId, r, 'the provider declined');
    await this.tell(orgId, r, 'requester', `${r.key} "${r.title}" was declined by ${await this.nameOf(actor)}: ${reason}${alternative ? ` Alternative: ${alternative}` : ''}. Plan for it (another department, a later date, or your manager decides the trade-off).`);
    return { request: await this.request(orgId, r.id), note: `${r.key} declined.` };
  }

  /** The chief routes an ask that named no service: to a service (its schema checked) or a department. */
  private async route(orgId: string, r: OrgServiceRequest, input: RespondInput, actor: string): Promise<{ request: OrgServiceRequest; note: string }> {
    const by = actor.slice(0, 80);
    const now = new Date();
    if (input.service) {
      const svc = await this.get(orgId, input.service);
      if (svc.status !== 'active') throw new BadRequestException(`refused: ${svc.name} is ${svc.status}`);
      const { problems } = checkRequest(this.fieldsOf(svc), parse<Record<string, string>>(r.fields, {}));
      if (problems.length) throw new BadRequestException(`refused: ${r.key} lacks what ${svc.title} needs:\n${problems.map((p) => `- ${p}`).join('\n')}\nAsk the requester for it on the triage task, or route it to the department (unit) as an unlisted ask.`);
      await this.closeRun(orgId, r, `routed to the service ${svc.name}`, actor);
      const unit = svc.unitId && this.units ? await this.units.get(orgId, svc.unitId) : null;
      await this.patch(r.id, { serviceId: svc.id, serviceVersion: svc.version, providerUnitId: unit?.id ?? null, status: 'open', acceptSlaHours: svc.acceptSlaHours, resolveSlaHours: svc.resolveSlaHours, acceptDueAt: hoursFrom(now, svc.acceptSlaHours), resolveDueAt: hoursFrom(now, svc.resolveSlaHours), needKey: '' });
      await this.note(orgId, r, { by, action: 'routed', note: `to the service ${svc.name}` });
      await this.startRun(orgId, await this.request(orgId, r.id), svc, unit, null);
      return { request: await this.request(orgId, r.id), note: `${r.key} → ${svc.title} (${unit?.name ?? 'the company'}).` };
    }
    if (!input.unit) throw new BadRequestException('refused: route names the department (unit) or the service that fits');
    const unit = await this.unit(orgId, input.unit);
    await this.patch(r.id, { providerUnitId: unit.id, status: 'open', acceptDueAt: hoursFrom(now, r.acceptSlaHours) });
    await this.note(orgId, r, { by, action: 'routed', note: `to ${unit.name}` });
    await this.settleStep(orgId, r, 'triage', { provider: unit.id }, actor);
    const fresh = await this.request(orgId, r.id);
    const accept = fresh.runId ? (await this.processes.steps(orgId, fresh.runId)).find((s) => s.nodeId === 'accept' && s.current && s.taskId) : undefined;
    if (accept) await this.patch(r.id, { acceptTaskId: accept.taskId });
    await this.countRepeat(orgId, await this.request(orgId, r.id)).catch(() => undefined);
    return { request: await this.request(orgId, r.id), note: `${r.key} → ${unit.name}: its head answers within ${r.acceptSlaHours}h.` };
  }

  /** Record a step's outputs, tick its MUST items and finish its task (the engine moves the run on). */
  private async settleStep(orgId: string, r: OrgServiceRequest, nodeId: string, outputs: Record<string, string>, actor: string): Promise<void> {
    const fresh = await this.request(orgId, r.id);
    if (!fresh.runId) return;
    const step = (await this.processes.steps(orgId, fresh.runId)).find((s) => s.nodeId === nodeId && s.current && s.status === 'active' && s.taskId);
    if (!step) return;
    for (const [k, v] of Object.entries(outputs)) await this.processes.setOutput(orgId, step.taskId!, k, v, actor).catch(() => undefined);
    const t = await this.tasks.get(orgId, step.taskId!).catch(() => null);
    if (!t || ['done', 'cancelled'].includes(t.status)) return;
    for (const x of parseSteps(t.steps).filter((y) => y.from === 'process:must' && !y.done)) await this.tasks.step(orgId, t.id, { done: x.id }, actor).catch(() => undefined);
    await this.tasks.update(orgId, t.id, { status: 'done' }, actor);
    await this.processes.settle();
  }

  private async closeRun(orgId: string, r: OrgServiceRequest, reason: string, actor: string): Promise<void> {
    if (r.runId) await this.processes.cancel(orgId, r.runId, reason, actor).catch(() => undefined);
  }

  /** A pending breach card is moot once the provider answers. */
  private async closeBreachCard(orgId: string, r: OrgServiceRequest, why: string): Promise<void> {
    const fresh = await this.request(orgId, r.id);
    if (!fresh.breachApprovalId) return;
    await this.db.update(orgApprovals).set({ status: 'expired', decidedAt: nowIso(), decisionNote: why }).where(and(eq(orgApprovals.id, fresh.breachApprovalId), eq(orgApprovals.status, 'pending')));
    await this.patch(r.id, { breachApprovalId: null });
  }

  /** Tell the requester or the provider (the agent's inbox; a comment that wakes the provider's performer). */
  private async tell(orgId: string, r: OrgServiceRequest, who: 'requester' | 'provider', text: string, wake = false): Promise<void> {
    const payload = JSON.stringify({ orgId, requestId: r.id, key: r.key });
    if (who === 'requester') {
      if (r.requesterAgentId) await this.agents.addEvent(r.requesterAgentId, { kind: 'info', title: text.slice(0, 200), body: text, payload, origin: 'loop' }).catch(() => undefined);
      return;
    }
    const fresh = await this.request(orgId, r.id);
    if (fresh.acceptTaskId) await this.tasks.comment(orgId, fresh.acceptTaskId, { text, fromAgentId: null, wake, system: true }).catch(() => undefined);
    const head = await this.providerHead(orgId, fresh);
    if (head) await this.agents.addEvent(head, { kind: 'info', title: text.slice(0, 200), body: text, payload, origin: 'loop' }).catch(() => undefined);
  }

  private async providerHead(orgId: string, r: OrgServiceRequest): Promise<string | null> {
    if (r.providerUnitId && this.units) {
      const u = await this.units.get(orgId, r.providerUnitId).catch(() => null);
      if (u) return u.leadAgentId;
    }
    return (await this.org.get(orgId)).chiefOfStaffAgentId;
  }

  /** An unlisted ask of the same kind, again: past the company's threshold the provider's head is asked to define a service. */
  private async countRepeat(orgId: string, r: OrgServiceRequest): Promise<number> {
    if (r.serviceId || !r.providerUnitId || !r.needKey) return 0;
    const org = await this.org.get(orgId);
    const since = new Date(Date.now() - serviceTunable(org, 'service.repeatWindowDays') * 86_400_000).toISOString();
    const words = r.needKey.split(' ');
    const same = (await this.requests(orgId)).filter((x) => !x.serviceId && x.providerUnitId === r.providerUnitId && x.createdAt >= since && x.needKey && sameNeed(words, x.needKey.split(' ')));
    const threshold = serviceTunable(org, 'service.suggestAfterRepeats');
    if (same.length < threshold || same.some((x) => x.suggestedAt)) return same.length;
    await this.patch(r.id, { suggestedAt: nowIso() });
    const head = await this.providerHead(orgId, r);
    const unit = this.units ? await this.units.get(orgId, r.providerUnitId).catch(() => null) : null;
    if (head) {
      const text = `The ask "${r.title}" reached ${unit?.name ?? 'your department'} ${same.length} times in ${serviceTunable(org, 'service.repeatWindowDays')} days without a service. Define one (org_service_author: the fields you need to start, the SLA you can keep) so the next request is typed and routed without the chief.`;
      await this.agents.addEvent(head, { kind: 'info', title: text.slice(0, 200), body: [text, ...same.slice(0, 6).map((x) => `- ${x.key} "${x.title}"`)].join('\n'), payload: JSON.stringify({ orgId, requestId: r.id }), origin: 'loop' }).catch(() => undefined);
    }
    await this.audit.append(orgId, { actor: 'system', action: 'service_suggested', refType: 'service_request', refId: r.id, payload: { repeats: same.length, unit: unit?.name ?? null } });
    return same.length;
  }

  // ---- the tick: settle finished runs, breach the clocks ----

  async tick(org: Organization, now: Date): Promise<void> {
    const open = await this.requests(org.id, { open: true });
    for (const r of open) {
      const settled = await this.reconcile(org, r).catch(() => false);
      if (settled) continue;
      const fresh = await this.request(org.id, r.id);
      if (fresh.status === 'open' && fresh.acceptDueAt && fresh.acceptDueAt <= now.toISOString() && !fresh.acceptBreachedAt) await this.acceptBreached(org, fresh, now).catch(() => undefined);
      if (fresh.status === 'accepted' && fresh.resolveDueAt && fresh.resolveDueAt <= now.toISOString() && !fresh.resolveBreachedAt) await this.resolveBreached(org, fresh).catch(() => undefined);
    }
  }

  /** A request whose run finished (or moved on without the tool) catches up. True when it settled. */
  private async reconcile(org: Organization, r: OrgServiceRequest): Promise<boolean> {
    if (!r.runId) return false;
    const run = await this.processes.run(org.id, r.runId).catch(() => null);
    if (!run) return false;
    const vars = parse<Record<string, string>>(run.vars, {});
    if (!r.acceptTaskId) {
      const accept = (await this.processes.steps(org.id, run.id)).find((s) => s.nodeId === 'accept' && s.current && s.taskId);
      if (accept) {
        const unitRef = (vars.provider_unit || vars.provider || '').trim();
        const unit = unitRef ? await this.unit(org.id, unitRef).catch(() => null) : null;
        await this.patch(r.id, { acceptTaskId: accept.taskId, ...(r.status === 'triage' && unit ? { status: 'open', providerUnitId: unit.id, acceptDueAt: hoursFrom(new Date(), r.acceptSlaHours) } : {}) });
      }
    }
    if (run.status === 'running' || run.status === 'blocked') return false;
    const now = nowIso();
    if (run.status === 'done') {
      if (r.status === 'accepted' || vars.answer === 'accepted') await this.patch(r.id, { status: 'delivered', resolvedAt: now, acceptedAt: r.acceptedAt ?? now, answeredAt: r.answeredAt ?? now });
      else if (vars.answer === 'declined') await this.patch(r.id, { status: 'declined', resolvedAt: now, answeredAt: r.answeredAt ?? now });
      else await this.patch(r.id, { status: 'delivered', resolvedAt: now });
      const done = await this.request(org.id, r.id);
      if (done.status === 'delivered') await this.audit.append(org.id, { actor: 'system', action: 'service_delivered', refType: 'service_request', refId: r.id, payload: { key: r.key } });
    } else {
      await this.patch(r.id, { status: run.status === 'failed' ? 'failed' : 'cancelled', resolvedAt: now });
      await this.tell(org.id, r, 'requester', `${r.key} "${r.title}" ${run.status === 'failed' ? 'failed' : 'was cancelled'}${run.note ? `: ${run.note}` : ''}.`);
    }
    await this.closeBreachCard(org.id, r, `the request is ${run.status}`);
    return true;
  }

  /** The agents above `agentId`, nearest first (decision routing's chain, agents only). */
  private async chainOf(org: Organization, agentId: string): Promise<string[]> {
    const members = (await this.org.members(org.id)).map((m) => ({ agentId: m.agentId, reportsToAgentId: m.reportsToAgentId, status: m.status }));
    return chainAbove(agentId, members, [], { chiefOfStaffAgentId: org.chiefOfStaffAgentId }).map(holderAgent).filter((x): x is string => Boolean(x));
  }

  /**
   * Nobody answered in time. The first breach raises a `service_breach`
   * card from the provider's performer (decision routing: its head); each
   * later breach raises it one level higher — the chief, then the CEO.
   */
  private async acceptBreached(org: Organization, r: OrgServiceRequest, now: Date): Promise<void> {
    await this.patch(r.id, { acceptBreachedAt: now.toISOString(), breaches: r.breaches + 1 });
    const svc = r.serviceId ? await this.get(org.id, r.serviceId).catch(() => null) : null;
    const t = r.acceptTaskId ? await this.tasks.get(org.id, r.acceptTaskId).catch(() => null) : null;
    const performer = t?.assigneeAgentId ?? await this.providerHead(org.id, r);
    const unit = r.providerUnitId && this.units ? await this.units.get(org.id, r.providerUnitId).catch(() => null) : null;
    const hoursLate = round1((now.getTime() - Date.parse(r.acceptDueAt ?? r.createdAt)) / 3_600_000 + 0);
    await this.note(org.id, r, { by: 'system', action: 'accept_breached', note: `no answer within ${r.acceptSlaHours}h (breach ${r.breaches + 1})` });
    await this.audit.append(org.id, { actor: 'system', action: 'service_breach', refType: 'service_request', refId: r.id, payload: { key: r.key, breaches: r.breaches + 1 } });
    const text = `${r.key} "${r.title}"${svc ? ` (${svc.title})` : ''} has had no answer within its accept SLA (${r.acceptSlaHours}h). Accept with a date, decline with the reason, or negotiate: org_service_respond request=${r.key}.`;
    if (serviceTunable(org, 'service.breachAction') < 1 || !performer) {
      if (t) await this.tasks.comment(org.id, t.id, { text, fromAgentId: null, wake: true, system: true }).catch(() => undefined);
      const head = await this.providerHead(org.id, r);
      if (head && head !== performer) await this.agents.addEvent(head, { kind: 'info', title: text.slice(0, 200), body: text, payload: JSON.stringify({ orgId: org.id, requestId: r.id }), origin: 'loop' }).catch(() => undefined);
      return;
    }
    const raisers = [performer, ...(await this.chainOf(org, performer))];
    const raiser = raisers[Math.min(r.breaches, raisers.length)] ?? null;
    const performerName = (await this.agents.get(performer).catch(() => null))?.name ?? 'the provider';
    const card = await this.approvals.create(org.id, {
      kind: 'service_breach', requestedBy: raiser ? `agent:${raiser}` : 'system',
      payload: { requestId: r.id, key: r.key, title: r.title, serviceTitle: svc?.title ?? 'Unlisted request', providerName: `${performerName}${unit ? ` (${unit.name})` : ''}`, hoursLate: Math.max(0, hoursLate), breaches: r.breaches + 1, agentId: performer, ...(t ? { taskKey: taskRef(t) } : {}) },
      recommendation: `Approve: hold ${performerName} to an answer within ${r.acceptSlaHours}h (they are woken with your note). Reject: decline ${r.key} on their behalf — the requester is told and plans around it.`,
      card: { recommendedAction: 'approve' },
    });
    await this.patch(r.id, { breachApprovalId: card.id });
    if (t) await this.tasks.comment(org.id, t.id, { text: `${text} The breach went up the line (card ${card.id.slice(0, 8)}).`, fromAgentId: null, wake: true, system: true }).catch(() => undefined);
  }

  private async breachDecided(orgId: string, a: OrgApproval, payload: Record<string, unknown>, decision: 'approve' | 'reject' | 'revise', note: string): Promise<Record<string, unknown>> {
    const r = await this.request(orgId, String(payload.requestId ?? '')).catch(() => null);
    if (!r || r.status !== 'open') return { stale: true };
    const by = `approval:${a.id}`;
    await this.patch(r.id, { breachApprovalId: null });
    if (decision === 'reject') {
      const reason = note.trim() || 'declined by the provider\'s manager after the accept SLA was breached';
      await this.note(orgId, r, { by, action: 'declined', reason });
      await this.decline(orgId, await this.request(orgId, r.id), reason, '', by);
      return { requestId: r.id, declined: true };
    }
    await this.patch(r.id, { acceptDueAt: hoursFrom(new Date(), r.acceptSlaHours), acceptBreachedAt: null });
    await this.note(orgId, r, { by, action: 'held_to_answer', note: note.slice(0, 300) });
    if (r.acceptTaskId) await this.tasks.comment(orgId, r.acceptTaskId, { text: `Your manager holds you to an answer on ${r.key} within ${r.acceptSlaHours}h${note ? `: ${note}` : ''}. org_service_respond request=${r.key} answer=accept | decline | negotiate.`, fromAgentId: null, wake: true, system: true }).catch(() => undefined);
    return { requestId: r.id, heldToAnswer: true };
  }

  private async resolveBreached(org: Organization, r: OrgServiceRequest): Promise<void> {
    await this.patch(r.id, { resolveBreachedAt: nowIso() });
    await this.note(org.id, r, { by: 'system', action: 'resolve_breached', note: `not delivered by ${r.resolveDueAt?.slice(0, 10)}` });
    await this.audit.append(org.id, { actor: 'system', action: 'service_resolve_breach', refType: 'service_request', refId: r.id, payload: { key: r.key } });
    const steps = r.runId ? await this.processes.steps(org.id, r.runId) : [];
    const doStep = steps.find((s) => s.nodeId === 'do' && s.current && s.taskId && s.status === 'active');
    const text = `${r.key} "${r.title}" is past its delivery date (${r.resolveDueAt?.slice(0, 10)}). Deliver it, or say on the task when it will land and why.`;
    if (doStep) await this.tasks.comment(org.id, doStep.taskId!, { text, fromAgentId: null, wake: true, system: true }).catch(() => undefined);
    await this.tell(org.id, r, 'requester', `${r.key} "${r.title}" is past its delivery date (${r.resolveDueAt?.slice(0, 10)}); the provider was reminded.`);
  }

  // ---- metrics, the overview, attention ----

  async metrics(orgId: string, serviceId: string): Promise<ServiceMetrics> {
    const org = await this.org.get(orgId);
    const since = new Date(Date.now() - serviceTunable(org, 'service.metricsWindowDays') * 86_400_000).toISOString();
    return computeServiceMetrics((await this.requests(orgId, { serviceId })).filter((r) => r.createdAt >= since));
  }

  /** Every service with its department, answering member, process and metrics (the page and the tools). */
  async overview(orgId: string, opts: { includeRetired?: boolean } = {}): Promise<Array<OrgServiceRow & { unitName: string; ownerAgentId: string | null; processName: string; metrics: ServiceMetrics; fieldList: ServiceField[]; pendingChange: boolean }>> {
    const org = await this.org.get(orgId);
    const since = new Date(Date.now() - serviceTunable(org, 'service.metricsWindowDays') * 86_400_000).toISOString();
    const all = (await this.requests(orgId)).filter((r) => r.createdAt >= since);
    const units = this.units ? await this.units.units(orgId) : [];
    const members = (await this.org.members(orgId)).filter((m) => m.status === 'active');
    const out = [];
    for (const s of await this.list(orgId, opts)) {
      const u = units.find((x) => x.id === s.unitId);
      let owner: string | null = u?.leadAgentId ?? org.chiefOfStaffAgentId;
      if (u && s.ownerRole !== 'head' && this.units) {
        const subtree = new Set(await this.units.subtree(orgId, u.id).catch(() => [u.id]));
        for (const m of members.filter((x) => (x.title ?? '').toLowerCase().includes(s.ownerRole))) { const mu = await this.units.unitForAssignee(orgId, m.agentId).catch(() => null); if (mu && subtree.has(mu.id)) { owner = m.agentId; break; } }
      }
      const proc = s.processId ? await this.processes.get(orgId, s.processId).catch(() => null) : null;
      out.push({ ...s, unitName: u?.name ?? 'Company', ownerAgentId: owner, processName: proc?.name ?? DEFAULT_INTAKE, metrics: computeServiceMetrics(all.filter((r) => r.serviceId === s.id)), fieldList: this.fieldsOf(s), pendingChange: Boolean(s.pending) });
    }
    return out;
  }

  /** Lines for an agent's context: requests to answer or route, breaches, counters to answer, asks to turn into services. */
  async attentionFor(orgId: string, agentId: string): Promise<string[]> {
    const org = await this.org.get(orgId);
    const open = await this.requests(orgId, { open: true });
    if (!open.length && !(await this.requests(orgId, { limit: 50 })).some((r) => r.suggestedAt)) return [];
    const isChief = org.chiefOfStaffAgentId === agentId;
    const led = this.units ? await this.units.ledBy(orgId, agentId).catch(() => null) : null;
    const mine = new Set(led && this.units ? await this.units.subtree(orgId, led.id).catch(() => [led.id]) : []);
    const now = Date.now();
    const left = (iso: string | null) => (iso ? Math.round((Date.parse(iso) - now) / 3_600_000) : null);
    const out: string[] = [];
    for (const r of open) {
      const providing = r.providerUnitId ? mine.has(r.providerUnitId) : false;
      if (r.status === 'triage' && isChief) out.push(`${r.key} "${r.title}" names no service: route it (org_service_respond answer=route unit=<department> or service=<name>)`);
      else if (r.status === 'open' && providing) { const h = left(r.acceptDueAt); out.push(`${r.key} "${r.title}" waits for your department's answer${h === null ? '' : h < 0 ? ` — ${-h}h past its accept SLA` : ` (${h}h left)`}`); }
      else if (r.status === 'negotiating' && r.requesterAgentId === agentId) out.push(`${r.key} "${r.title}": the provider made a counter-proposal — answer agree, negotiate or withdraw`);
      else if (r.status === 'accepted' && providing && r.resolveBreachedAt) out.push(`${r.key} "${r.title}" is past its delivery date (${r.committedDue?.slice(0, 10) ?? r.resolveDueAt?.slice(0, 10)})`);
      else if (isChief && r.acceptBreachedAt && r.status === 'open') out.push(`${r.key} "${r.title}" breached its accept SLA (${r.breaches}×)`);
    }
    if (led || isChief) {
      const since = new Date(now - serviceTunable(org, 'service.repeatWindowDays') * 86_400_000).toISOString();
      const services = await this.list(orgId);
      for (const r of (await this.requests(orgId, { limit: 200 })).filter((x) => x.suggestedAt && x.suggestedAt >= since && x.providerUnitId && (isChief || mine.has(x.providerUnitId)))) {
        if (services.some((s) => s.unitId === r.providerUnitId && s.createdAt >= r.suggestedAt!)) continue;
        out.push(`the ask "${r.title}" keeps coming without a service — define one (org_service_author)`);
      }
      for (const s of await this.overview(orgId)) {
        if (!(isChief || (s.unitId && mine.has(s.unitId)))) continue;
        if (s.metrics.requests >= 3 && (s.metrics.breachRate ?? 0) >= 0.3) out.push(`${s.name}: ${metricsLine(s.metrics)} — fix the staffing or the SLA (org_service_author with the reason)`);
      }
    }
    return [...new Set(out)].slice(0, 8);
  }
}
