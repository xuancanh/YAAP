/**
 * OrgProcessesService — the process engine (docs/processes.md).
 *
 * Definitions: a process is a header row and immutable versions
 * (`org_process_versions`), each with its author and reason. Processes
 * start from templates (process-templates.ts) at onboarding, at a kit
 * install (its rhythm lines) or on request, and are the company's after
 * that: the chief of staff changes any process, a head its unit's, a
 * person anything. Whether an agent's edit applies at once or waits for an
 * approval card is the boundary's (`process` rows) and the company's
 * `process.editApproval` tunable — never a fixed rule. A rollback is a new
 * version with an older definition.
 *
 * Runs: model-free. A trigger (manual, a cadence, an event — an incident
 * opened, a project moved to Now, a task of a class created — or a service
 * request, a hook for now) starts a run pinned to the active version. The
 * engine walks the stages: a strict stage's ready steps materialise at once
 * (process-model.ts `strictWalk`); a dynamic stage materialises one
 * coordinator task for the performer, who chooses each available step
 * (`choose`), may add a logged ad-hoc step, and finishes the stage only when
 * its checkpoints are done — and the run moves to the newest version at a
 * choice when that is safe. Every step an agent performs is an ordinary org
 * task (`processRunId` / `processNodeId`) created through OrgTasksService,
 * so review, checks, WIP, breakers, budgets, next work and any creation gate
 * apply unchanged; approvals are org_approvals cards routed by decision
 * routing; waits are timers; a subprocess is a child run.
 *
 * Safety: (run, node, attempt) is unique, so materialising twice is a no-op;
 * every loop edge carries loopMax and exhausting it escalates; a step past
 * its SLA nudges or escalates (`process.slaAction`); `sweep` reconciles
 * every running run from persisted state on the minute tick, so a restart
 * resumes where the record says. Work triggered by a task transition or a
 * decision runs per run in order (`withRun`), off the caller's path.
 *
 * Gates: handing a step to review with a MUST item open is refused with
 * what is missing and how to satisfy it (`process.mustEnforcement`); a step's
 * denied tools are refused when called; `deviate` logs a SHOULD deviation or
 * sends a MUST waiver to the performer's manager. Every move is an event in
 * `org_process_events` — the log the metrics are computed from.
 */
import { BadRequestException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { orgIncidents, orgProcesses, orgProcessEvents, orgProcessRuns, orgProcessSteps, orgProcessVersions, orgTasks } from '../database/schema';
import { newId, nowIso } from '../common/ids.util';
import { currentAccountId } from '../accounts/account-context';
import { TriggerBus } from '../chats/trigger-bus';
import { prevCronMatch } from '../chats/cron.util';
import { AgentsService } from '../agents/agents.service';
import { OrgService, type Organization } from './org.service';
import { OrgTasksService, type OrgTask } from './org-tasks.service';
import { OrgApprovalsService, type OrgApproval } from './org-approvals.service';
import { OrgAuditService } from './org-audit.service';
import { OrgUnitsService } from './org-units.service';
import { OrgRuntimeService } from './org-runtime.service';
import { OrgBootstrapService } from './org-bootstrap.service';
import { KitsService } from '../foundry/kits.service';
import { isValidCron } from './org-meetings.service';
import { parseSteps, type TaskStep } from './work-model';
import { claimTag } from './claims-model';
import { taskRef } from '../common/task-keys';
import { processTunable } from './process-tunables';
import { PROCESS_TEMPLATES, templateById, templatesForRhythm } from './process-templates';
import {
  SLUG_RE, backEdges, canAdopt, computeMetrics, describeProblems, diffProcess, downstream, dynamicAvailable, fill, holds, missingCheckpoints, modeOf,
  nodesOf, normalizeProcess, processHash, stepCard, strictStageDone, strictWalk, touchesControls, validateProcess,
  type CardItem, type ProcessDef, type ProcessMetrics, type ProcessNode, type ProcessStage, type StepState,
} from './process-model';

export type OrgProcess = typeof orgProcesses.$inferSelect;
export type OrgProcessVersion = typeof orgProcessVersions.$inferSelect;
export type OrgProcessRun = typeof orgProcessRuns.$inferSelect;
export type OrgProcessStep = typeof orgProcessSteps.$inferSelect;
export type OrgProcessEvent = typeof orgProcessEvents.$inferSelect;

/** The prefix a dynamic stage's coordinator step id carries. */
const STAGE_NODE = '@';
const isCoordinator = (nodeId: string) => nodeId.startsWith(STAGE_NODE);
const ADHOC = 'adhoc-';
const OPEN_RUN = ['running', 'blocked'];

export interface Deviation { level: 'should' | 'must' | 'ad_hoc'; item: string; reason: string; alternative: string; status: 'logged' | 'pending' | 'approved' | 'rejected'; approvalId?: string; by: string; at: string }

export interface StartInput {
  title?: string; vars?: Record<string, unknown>; projectId?: string | null;
  initiator: string; trigger?: { kind: string; event?: string; ref?: string };
  triggerRef?: string; parentRunId?: string; parentStepId?: string;
}

export interface AuthorResult { process: OrgProcess; version: OrgProcessVersion; applied: boolean; approvalId: string | null; note: string }

const parse = <T>(raw: string | null | undefined, fallback: T): T => { try { const v = JSON.parse(raw || '') as T; return v ?? fallback; } catch { return fallback; } };
const strVars = (v: Record<string, unknown> | undefined): Record<string, string> => Object.fromEntries(Object.entries(v ?? {}).filter(([k]) => /^[a-z][a-z0-9_]{0,39}$/i.test(k)).slice(0, 40).map(([k, x]) => [k, String(x ?? '').slice(0, 2_000)]));
const hoursFrom = (now: Date, h: number) => new Date(now.getTime() + h * 3_600_000).toISOString();

@Injectable()
export class OrgProcessesService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly org: OrgService,
    private readonly tasks: OrgTasksService,
    private readonly approvals: OrgApprovalsService,
    private readonly audit: OrgAuditService,
    private readonly agents: AgentsService,
    @Optional() private readonly units?: OrgUnitsService,
    @Optional() private readonly runtime?: OrgRuntimeService,
    @Optional() private readonly bus?: TriggerBus,
    @Optional() bootstrap?: OrgBootstrapService,
    @Optional() private readonly kits?: KitsService,
  ) {
    tasks.addSubmitGate((orgId, task) => this.submitGate(orgId, task));
    tasks.onTransition((ev) => {
      if (ev.to === 'done' || ev.to === 'cancelled') this.defer(() => this.onTaskSettled(ev.orgId, ev.taskId, ev.to as 'done' | 'cancelled'));
    });
    approvals.onApply('process_gate', (orgId, payload, a, note) => this.gateDecided(orgId, a, payload, 'approve', note ?? ''));
    approvals.onApply('process_deviation', (orgId, payload, a, note) => this.deviationDecided(orgId, a, payload, 'approve', note ?? ''));
    approvals.onApply('process_change', (orgId, payload, a) => this.changeDecided(orgId, a, payload, 'approve'));
    approvals.onDecided(({ orgId, approval, decision, note }) => {
      if (decision === 'approve') return;
      const payload = parse<Record<string, unknown>>(approval.payload, {});
      if (approval.kind === 'process_gate') this.defer(() => this.gateDecided(orgId, approval, payload, decision, note).then(() => undefined));
      if (approval.kind === 'process_deviation') this.defer(() => this.deviationDecided(orgId, approval, payload, decision, note).then(() => undefined));
      if (approval.kind === 'process_change') this.defer(() => this.changeDecided(orgId, approval, payload, decision).then(() => undefined));
    });
    bus?.onOrgIncident((ev) => { this.defer(() => this.onIncident(ev.orgId, ev.incidentId, ev.severity)); });
    runtime?.addTicker({ name: 'processes', everyMinutes: 1, fn: (org, now) => this.tick(org, now) });
    runtime?.addTicker({ name: 'processes-sweep', everyMinutes: 5, fn: (org) => this.sweep(org.id).then(() => undefined) });
    bootstrap?.onBootstrapped((orgId) => this.seed(orgId, { source: 'bootstrap', cadences: true }).then((r) => r.map((p) => `process ${p.name}`)));
    kits?.onChange((workspaceId) => { this.defer(() => this.onKitsChanged(workspaceId)); });
  }

  // ---- background work, in order per run ----

  private readonly pending = new Set<Promise<unknown>>();
  private readonly locks = new Map<string, Promise<unknown>>();

  /** Run `fn` off the caller's path (a transition, a decision); never throws. */
  private defer(fn: () => Promise<unknown>): void {
    const p: Promise<unknown> = Promise.resolve().then(fn).catch(() => undefined).finally(() => { this.pending.delete(p); });
    this.pending.add(p);
  }

  /** Wait for every deferred piece of work (tests; shutdown). */
  async settle(): Promise<void> {
    for (let i = 0; i < 50 && this.pending.size; i++) await Promise.allSettled([...this.pending]);
  }

  /** Serialise work on one run: materialisation and completion never interleave. */
  private withRun<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(runId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    this.locks.set(runId, next);
    void next.finally(() => { if (this.locks.get(runId) === next) this.locks.delete(runId); }).catch(() => undefined);
    return next;
  }

  private async log(orgId: string, processId: string, runId: string, nodeId: string, activity: string, actor: string, detail: Record<string, unknown> = {}): Promise<void> {
    await this.db.insert(orgProcessEvents).values({ accountId: currentAccountId(), id: newId(), orgId, processId, runId, nodeId, activity, actor: actor.slice(0, 80), detail: JSON.stringify(detail).slice(0, 4_000), at: nowIso() }).catch(() => undefined);
  }

  // ---- definitions: reads ----

  async list(orgId: string, opts: { includeRetired?: boolean } = {}): Promise<OrgProcess[]> {
    const rows = await this.db.select().from(orgProcesses).where(eq(orgProcesses.orgId, orgId));
    return rows.filter((p) => opts.includeRetired || p.status !== 'retired').sort((a, b) => a.title.localeCompare(b.title));
  }

  /** A process by id, name, id prefix or exact title. */
  async get(orgId: string, ref: string): Promise<OrgProcess> {
    const q = (ref ?? '').trim();
    if (!q) throw new BadRequestException('process is required (its name, e.g. release-checklist)');
    const all = await this.db.select().from(orgProcesses).where(eq(orgProcesses.orgId, orgId));
    const hit = all.find((p) => p.id === q || p.name === q.toLowerCase()) ?? (q.length >= 6 ? all.find((p) => p.id.startsWith(q)) : undefined) ?? all.find((p) => p.title.toLowerCase() === q.toLowerCase());
    if (!hit) throw new NotFoundException(`no process "${ref}" — org_processes lists them`);
    return hit;
  }

  async versions(orgId: string, processId: string): Promise<OrgProcessVersion[]> {
    return this.db.select().from(orgProcessVersions).where(and(eq(orgProcessVersions.orgId, orgId), eq(orgProcessVersions.processId, processId))).orderBy(desc(orgProcessVersions.version));
  }

  async version(orgId: string, versionId: string): Promise<OrgProcessVersion> {
    const v = (await this.db.select().from(orgProcessVersions).where(and(eq(orgProcessVersions.orgId, orgId), eq(orgProcessVersions.id, versionId))).limit(1)).at(0);
    if (!v) throw new NotFoundException(`process version ${versionId}`);
    return v;
  }

  defOf(v: Pick<OrgProcessVersion, 'def'>): ProcessDef { return normalizeProcess(parse(v.def, {})); }

  async activeDef(orgId: string, p: OrgProcess): Promise<ProcessDef | null> {
    return p.versionId ? this.defOf(await this.version(orgId, p.versionId)) : null;
  }

  // ---- definitions: who may change what ----

  /** Whether `actor` owns the process (or the unit a new one would go to):
   *  the chief any, a head its unit's subtree, a person everything. */
  async owns(orgId: string, actor: string, unitId: string | null): Promise<boolean> {
    const org = await this.org.get(orgId);
    const agentId = actor === 'chief' ? org.chiefOfStaffAgentId : actor.startsWith('agent:') ? actor.slice(6) : null;
    if (!agentId) return true;
    if (agentId === org.chiefOfStaffAgentId) return true;
    if (!this.units || !unitId) return false;
    const led = await this.units.ledBy(orgId, agentId).catch(() => null);
    if (!led) return false;
    const subtree = await this.units.subtree(orgId, led.id).catch(() => [led.id]);
    return subtree.includes(unitId);
  }

  /** The unit an agent's new process belongs to by default (a head's own; the chief's: the company). */
  private async defaultUnit(orgId: string, actor: string): Promise<string | null> {
    const org = await this.org.get(orgId);
    const agentId = actor.startsWith('agent:') ? actor.slice(6) : null;
    if (!agentId || agentId === org.chiefOfStaffAgentId || !this.units) return null;
    return (await this.units.ledBy(orgId, agentId).catch(() => null))?.id ?? null;
  }

  private async validate(orgId: string, def: ProcessDef, name: string): Promise<void> {
    const org = await this.org.get(orgId);
    const names = new Set((await this.list(orgId, { includeRetired: true })).map((p) => p.name));
    const problems = validateProcess(def, { loopMaxCeiling: processTunable(org, 'process.loopMaxCeiling'), processNames: names, selfName: name, isValidCron });
    if (problems.length) throw new BadRequestException(`refused: the process definition has ${problems.length} problem(s):\n${describeProblems(problems)}`);
  }

  // ---- definitions: writes ----

  /**
   * Create or change a process: a new immutable version with its author and
   * reason. Applies at once for a person; for an agent the boundary decides
   * (its own process: alone; another's: a proposal), and within its own the
   * company's `process.editApproval` decides whether this edit waits for a
   * `process_change` card routed to the editor's manager.
   */
  async author(orgId: string, input: { process?: string; name?: string; template?: string; def?: unknown; unitId?: string | null; reason: string; action?: 'create' | 'edit' | 'rollback' | 'restore' }, actor: string): Promise<AuthorResult> {
    const reason = (input.reason ?? '').trim().slice(0, 600);
    if (!reason) throw new BadRequestException('reason is required: say what the runs showed (deviations, failures, cycle time) or why the change is needed');
    const existing = input.process ? await this.get(orgId, input.process) : null;
    const tpl = input.template ? templateById(input.template) : undefined;
    if (input.template && !tpl) throw new BadRequestException(`no template "${input.template}" — the library: ${PROCESS_TEMPLATES.map((t) => t.id).join(', ')}`);
    const raw = input.def ?? tpl?.def;
    if (!raw) throw new BadRequestException('give the definition (def) or a template');
    const def = normalizeProcess(raw);
    const name = existing?.name ?? (input.name ?? tpl?.id ?? def.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
    if (!existing && !SLUG_RE.test(name)) throw new BadRequestException('name must be a short lowercase slug, e.g. "release-checklist"');
    if (!existing && (await this.list(orgId, { includeRetired: true })).some((p) => p.name === name)) throw new BadRequestException(`a process "${name}" exists — pass process: "${name}" to change it`);
    await this.validate(orgId, def, name);
    const unitId = existing ? existing.unitId : input.unitId !== undefined ? input.unitId : await this.defaultUnit(orgId, actor);
    if (unitId && this.units) await this.units.get(orgId, unitId);
    const prevDef = existing ? await this.activeDef(orgId, existing) : null;
    const action = input.action ?? (existing ? 'edit' : 'create');
    const decision = await this.decideEdit(orgId, actor, unitId, prevDef, def, `${action} process "${def.title}"`);
    const now = nowIso();
    let proc = existing;
    if (!proc) {
      proc = {
        accountId: currentAccountId(), id: newId(), orgId, name, title: def.title, description: def.description ?? '', category: def.category, unitId,
        status: 'draft', version: 0, versionId: null, templateId: tpl?.id ?? '', source: tpl ? 'template' : 'authored', lastCadenceAt: null, reviewedAt: null,
        createdBy: actor.slice(0, 80), createdAt: now, updatedAt: now,
      };
      await this.db.insert(orgProcesses).values(proc);
    }
    const last = (await this.versions(orgId, proc.id))[0];
    const version: OrgProcessVersion = {
      accountId: currentAccountId(), id: newId(), orgId, processId: proc.id, version: (last?.version ?? 0) + 1, def: JSON.stringify(def), hash: processHash(def),
      status: 'pending', author: actor.slice(0, 80), reason, diff: JSON.stringify(diffProcess(prevDef, def)), basedOn: existing?.version || null, approvalId: null, createdAt: now, activatedAt: null,
    };
    await this.db.insert(orgProcessVersions).values(version);
    await this.log(orgId, proc.id, '', '', 'version_written', actor, { version: version.version, action, reason });
    if (decision.apply) {
      await this.activate(orgId, version.id, actor);
      return { process: await this.get(orgId, proc.id), version: await this.version(orgId, version.id), applied: true, approvalId: null, note: `${def.title} v${version.version} is active (${action}): ${reason}` };
    }
    const card = await this.approvals.create(orgId, {
      kind: 'process_change', requestedBy: actor,
      payload: { processId: proc.id, versionId: version.id, version: version.version, processTitle: def.title, name, action, reason, diff: diffProcess(prevDef, def).slice(0, 30), agentId: actor.startsWith('agent:') ? actor.slice(6) : undefined, ...(decision.boundary ? { boundary: decision.boundary } : {}) },
      recommendation: reason, card: { recommendedAction: 'approve' },
    });
    await this.db.update(orgProcessVersions).set({ approvalId: card.id }).where(eq(orgProcessVersions.id, version.id));
    return { process: await this.get(orgId, proc.id), version: await this.version(orgId, version.id), applied: false, approvalId: card.id, note: `${def.title} v${version.version} waits for approval (card ${card.id.slice(0, 8)}): ${decision.why}` };
  }

  /** Apply now, or a card? The boundary first, then process.editApproval. */
  private async decideEdit(orgId: string, actor: string, unitId: string | null, prev: ProcessDef | null, next: ProcessDef | null, summary: string): Promise<{ apply: boolean; why: string; boundary?: string }> {
    const own = await this.owns(orgId, actor, unitId);
    const b = await this.org.boundaryDecide(orgId, { kind: 'process', withinUnit: own, summary }, actor);
    if (b.outcome === 'refuse' || b.outcome === 'experiment') throw new BadRequestException(b.reason);
    if (!b.agent) return { apply: true, why: 'a person\'s change' };
    if (b.outcome === 'card') return { apply: false, why: `${b.reason} — the owner decides`, boundary: 'propose' };
    const level = processTunable(await this.org.get(orgId), 'process.editApproval');
    if (level >= 2) return { apply: false, why: 'every process change is approved in this company (process.editApproval 2)' };
    if (level === 1 && (!next || touchesControls(prev, next))) return { apply: false, why: 'the change alters what a run must do (MUST items, checkpoints, approvals, strict edges or denied tools), which this company approves (process.editApproval 1)' };
    return { apply: true, why: 'within the editor\'s own processes' };
  }

  /** Make a version the active one (the previous one becomes superseded). */
  async activate(orgId: string, versionId: string, actor: string): Promise<OrgProcess> {
    const v = await this.version(orgId, versionId);
    const def = this.defOf(v);
    const now = nowIso();
    await this.db.update(orgProcessVersions).set({ status: 'superseded' }).where(and(eq(orgProcessVersions.processId, v.processId), eq(orgProcessVersions.status, 'active')));
    await this.db.update(orgProcessVersions).set({ status: 'active', activatedAt: now }).where(eq(orgProcessVersions.id, v.id));
    await this.db.update(orgProcesses).set({ title: def.title, description: def.description ?? '', category: def.category, version: v.version, versionId: v.id, status: 'active', updatedAt: now }).where(eq(orgProcesses.id, v.processId));
    await this.log(orgId, v.processId, '', '', 'version_activated', actor, { version: v.version });
    await this.audit.append(orgId, { actor, action: 'process_version', refType: 'process', refId: v.processId, payload: { version: v.version, reason: v.reason.slice(0, 200) } });
    return this.get(orgId, v.processId);
  }

  /** Retire a process: no new runs; running ones finish on their version. */
  async retire(orgId: string, ref: string, reason: string, actor: string): Promise<{ process: OrgProcess; applied: boolean; approvalId: string | null; note: string }> {
    const p = await this.get(orgId, ref);
    if (!reason.trim()) throw new BadRequestException('reason is required');
    if (p.status === 'retired') return { process: p, applied: true, approvalId: null, note: `${p.title} is already retired` };
    const decision = await this.decideEdit(orgId, actor, p.unitId, null, null, `retire process "${p.title}"`);
    if (decision.apply) {
      await this.db.update(orgProcesses).set({ status: 'retired', updatedAt: nowIso() }).where(eq(orgProcesses.id, p.id));
      await this.log(orgId, p.id, '', '', 'retired', actor, { reason });
      await this.audit.append(orgId, { actor, action: 'process_retire', refType: 'process', refId: p.id, payload: { reason: reason.slice(0, 200) } });
      return { process: await this.get(orgId, p.id), applied: true, approvalId: null, note: `${p.title} is retired: no new runs start; open runs finish` };
    }
    const card = await this.approvals.create(orgId, { kind: 'process_change', requestedBy: actor, payload: { processId: p.id, processTitle: p.title, name: p.name, action: 'retire', reason, agentId: actor.startsWith('agent:') ? actor.slice(6) : undefined, ...(decision.boundary ? { boundary: decision.boundary } : {}) }, recommendation: reason });
    return { process: p, applied: false, approvalId: card.id, note: `retiring ${p.title} waits for approval (card ${card.id.slice(0, 8)}): ${decision.why}` };
  }

  /** Roll back: a new version carrying an older version's definition. */
  async rollback(orgId: string, ref: string, toVersion: number, reason: string, actor: string): Promise<AuthorResult> {
    const p = await this.get(orgId, ref);
    const target = (await this.versions(orgId, p.id)).find((v) => v.version === toVersion);
    if (!target) throw new BadRequestException(`${p.title} has no version ${toVersion}`);
    return this.author(orgId, { process: p.id, def: parse(target.def, {}), reason: `rollback to v${toVersion}: ${reason}`, action: 'rollback' }, actor);
  }

  /** Bring a retired process back (its active version unchanged). */
  async restore(orgId: string, ref: string, reason: string, actor: string): Promise<OrgProcess> {
    const p = await this.get(orgId, ref);
    if (p.status !== 'retired') return p;
    const decision = await this.decideEdit(orgId, actor, p.unitId, null, null, `restore process "${p.title}"`);
    if (!decision.apply) throw new BadRequestException(`refused: ${decision.why} — propose it`);
    await this.db.update(orgProcesses).set({ status: p.versionId ? 'active' : 'draft', updatedAt: nowIso() }).where(eq(orgProcesses.id, p.id));
    await this.log(orgId, p.id, '', '', 'restored', actor, { reason });
    return this.get(orgId, p.id);
  }

  private async changeDecided(orgId: string, a: OrgApproval, payload: Record<string, unknown>, decision: 'approve' | 'reject' | 'revise'): Promise<Record<string, unknown>> {
    const processId = String(payload.processId ?? '');
    const versionId = typeof payload.versionId === 'string' ? payload.versionId : '';
    const by = `approval:${a.id}`;
    if (decision === 'approve') {
      if (payload.action === 'retire') {
        await this.db.update(orgProcesses).set({ status: 'retired', updatedAt: nowIso() }).where(eq(orgProcesses.id, processId));
        await this.log(orgId, processId, '', '', 'retired', by, { reason: payload.reason });
        return { processId, retired: true };
      }
      const p = await this.activate(orgId, versionId, by);
      return { processId, version: p.version };
    }
    if (versionId) await this.db.update(orgProcessVersions).set({ status: 'rejected' }).where(and(eq(orgProcessVersions.id, versionId), eq(orgProcessVersions.status, 'pending')));
    const p = (await this.db.select().from(orgProcesses).where(eq(orgProcesses.id, processId)).limit(1)).at(0);
    if (p && p.status === 'draft' && !p.versionId) await this.db.update(orgProcesses).set({ status: 'retired', updatedAt: nowIso() }).where(eq(orgProcesses.id, processId));
    await this.log(orgId, processId, '', '', 'version_rejected', by, { versionId, decision });
    return { processId, rejected: true };
  }

  // ---- templates: onboarding, kits, the library ----

  /** Instantiate a template for the company (idempotent by name). */
  async instantiate(orgId: string, templateId: string, opts: { unitId?: string | null; source?: string; actor?: string; cadences?: boolean } = {}): Promise<OrgProcess> {
    const tpl = templateById(templateId);
    if (!tpl) throw new BadRequestException(`no template "${templateId}"`);
    const existing = (await this.list(orgId, { includeRetired: true })).find((p) => p.name === tpl.id);
    if (existing) return existing;
    const def: ProcessDef = { ...tpl.def, triggers: tpl.def.triggers.map((t) => (t.kind === 'cadence' && opts.cadences === false ? { ...t, enabled: false } : t)) };
    // Templates are trusted, so they are written as a person would: applied at once, the author recorded.
    const r = await this.author(orgId, { name: tpl.id, template: tpl.id, def, unitId: opts.unitId ?? null, reason: `instantiated from the "${tpl.id}" template${opts.source ? ` (${opts.source})` : ''}` }, 'system');
    await this.db.update(orgProcesses).set({ source: opts.source ?? 'template', createdBy: (opts.actor ?? 'system').slice(0, 80) }).where(eq(orgProcesses.id, r.process.id));
    return this.get(orgId, r.process.id);
  }

  /** The unit a template's function maps to (a head whose title matches), or null for the company. */
  private async unitForHint(orgId: string, hint: string[]): Promise<string | null | undefined> {
    if (!hint.length) return null;
    if (!this.units) return undefined;
    const members = await this.org.members(orgId);
    for (const u of await this.units.units(orgId)) {
      if (u.parentUnitId === null) continue;
      const lead = members.find((m) => m.agentId === u.leadAgentId);
      const words = `${lead?.title ?? ''} ${u.name}`.toLowerCase();
      if (hint.some((h) => words.includes(h))) return u.id;
    }
    return undefined;
  }

  /** Seed the library: the templates every company runs, and the function
   *  templates whose function the company has. Idempotent. */
  async seed(orgId: string, opts: { source: string; cadences: boolean; only?: string[] }): Promise<OrgProcess[]> {
    const out: OrgProcess[] = [];
    for (const t of PROCESS_TEMPLATES) {
      if (opts.only ? !opts.only.includes(t.id) : t.seed === 'never') continue;
      const unitId = await this.unitForHint(orgId, t.unitHint);
      if (unitId === undefined && !opts.only) continue;
      out.push(await this.instantiate(orgId, t.id, { unitId: unitId ?? null, source: opts.source, cadences: opts.cadences }).catch(() => null as never));
    }
    return out.filter(Boolean);
  }

  /** A kit was installed or changed: its rhythm lines become processes. */
  private async onKitsChanged(workspaceId: string): Promise<void> {
    if (!this.kits) return;
    const org = await this.org.byWorkspace(workspaceId).catch(() => null);
    if (!org) return;
    for (const row of await this.kits.installRows(workspaceId)) {
      if (row.status === 'removed' || row.status === 'failed') continue;
      const m = parse<{ rhythm?: string[] }>(row.manifest, {});
      const ids = templatesForRhythm(m.rhythm ?? []);
      if (ids.length) await this.seed(org.id, { source: `kit:${row.kitId}`, cadences: true, only: ids });
    }
  }

  // ---- runs ----

  async runs(orgId: string, opts: { processId?: string; status?: string; limit?: number } = {}): Promise<OrgProcessRun[]> {
    const conds = [eq(orgProcessRuns.orgId, orgId)];
    if (opts.processId) conds.push(eq(orgProcessRuns.processId, opts.processId));
    if (opts.status) conds.push(eq(orgProcessRuns.status, opts.status));
    return this.db.select().from(orgProcessRuns).where(and(...conds)).orderBy(desc(orgProcessRuns.startedAt)).limit(opts.limit ?? 200);
  }

  async run(orgId: string, ref: string): Promise<OrgProcessRun> {
    const q = (ref ?? '').trim();
    const rows = await this.db.select().from(orgProcessRuns).where(eq(orgProcessRuns.orgId, orgId));
    const hit = rows.find((r) => r.id === q || r.key.toLowerCase() === q.toLowerCase()) ?? (q.length >= 6 ? rows.find((r) => r.id.startsWith(q)) : undefined);
    if (!hit) throw new NotFoundException(`no process run "${ref}"`);
    return hit;
  }

  async steps(orgId: string, runId: string): Promise<OrgProcessStep[]> {
    return this.db.select().from(orgProcessSteps).where(and(eq(orgProcessSteps.orgId, orgId), eq(orgProcessSteps.runId, runId))).orderBy(orgProcessSteps.startedAt);
  }

  async events(orgId: string, opts: { processId?: string; runId?: string; limit?: number } = {}): Promise<OrgProcessEvent[]> {
    const conds = [eq(orgProcessEvents.orgId, orgId)];
    if (opts.processId) conds.push(eq(orgProcessEvents.processId, opts.processId));
    if (opts.runId) conds.push(eq(orgProcessEvents.runId, opts.runId));
    return this.db.select().from(orgProcessEvents).where(and(...conds)).orderBy(desc(orgProcessEvents.at)).limit(opts.limit ?? 200);
  }

  /** The step a task performs (its current attempt), or null. */
  async stepOfTask(orgId: string, taskId: string): Promise<OrgProcessStep | null> {
    const rows = await this.db.select().from(orgProcessSteps).where(and(eq(orgProcessSteps.orgId, orgId), eq(orgProcessSteps.taskId, taskId)));
    return rows.sort((a, b) => b.current - a.current || b.attempt - a.attempt)[0] ?? null;
  }

  private async runDef(orgId: string, run: OrgProcessRun): Promise<ProcessDef> {
    return this.defOf(await this.version(orgId, run.versionId));
  }

  /** The process owner for a run: the owning unit's head, else the chief. */
  private async ownerFor(org: Organization, p: OrgProcess, def: ProcessDef): Promise<string | null> {
    if (def.owner !== 'chief' && p.unitId && this.units) {
      const u = await this.units.get(org.id, p.unitId).catch(() => null);
      const m = u ? await this.org.member(org.id, u.leadAgentId) : null;
      if (m && m.status === 'active') return m.agentId;
    }
    return org.chiefOfStaffAgentId;
  }

  /** Who performs a lane: a role, never an agent id (docs/processes.md "Lanes"). */
  private async laneAgent(org: Organization, p: OrgProcess, run: OrgProcessRun, lane: string | undefined): Promise<string | null> {
    const l = (lane ?? 'owner').trim().toLowerCase();
    const members = (await this.org.members(org.id)).filter((m) => m.status === 'active');
    const active = (id: string | null | undefined) => (id && members.some((m) => m.agentId === id) ? id : null);
    if (l === 'owner') return active(run.ownerAgentId) ?? org.chiefOfStaffAgentId;
    if (l === 'chief') return org.chiefOfStaffAgentId;
    // A service request names its providing department and answering role in the run's variables (docs/services.md).
    if (l === 'provider' || (l === 'head' && this.providerUnitVar(run))) { const a = await this.providerAgent(org, run, members); if (a) return a; }
    if (l === 'head') {
      if (p.unitId && this.units) { const u = await this.units.get(org.id, p.unitId).catch(() => null); if (active(u?.leadAgentId)) return u!.leadAgentId; }
      return active(run.ownerAgentId) ?? org.chiefOfStaffAgentId;
    }
    if (l === 'initiator') return active(run.initiator.startsWith('agent:') ? run.initiator.slice(6) : null) ?? active(run.ownerAgentId) ?? org.chiefOfStaffAgentId;
    const byTitle = members.filter((m) => (m.title ?? '').toLowerCase().includes(l));
    if (byTitle.length && p.unitId && this.units) {
      const subtree = new Set(await this.units.subtree(org.id, p.unitId).catch(() => [p.unitId!]));
      for (const m of byTitle) { const u = await this.units.unitForAssignee(org.id, m.agentId).catch(() => null); if (u && subtree.has(u.id)) return m.agentId; }
    }
    return byTitle[0]?.agentId ?? active(run.ownerAgentId) ?? org.chiefOfStaffAgentId;
  }

  /** The provider department a service request's run names (`provider_unit`, or the triage output `provider`). */
  private providerUnitVar(run: OrgProcessRun): string {
    const v = parse<Record<string, string>>(run.vars, {});
    return (v.provider_unit || v.provider || '').trim();
  }

  /** The member answering for the provider department: its `provider_role`
   *  title within the unit, else the unit's head. Model-free. */
  private async providerAgent(org: Organization, run: OrgProcessRun, members: Array<{ agentId: string; title: string | null }>): Promise<string | null> {
    const ref = this.providerUnitVar(run).replace(/^#/, '').toLowerCase();
    if (!ref || !this.units) return null;
    const unit = (await this.units.units(org.id)).find((u) => u.id === ref || u.slug === ref || u.name.toLowerCase() === ref);
    if (!unit) return null;
    const role = (parse<Record<string, string>>(run.vars, {}).provider_role ?? '').trim().toLowerCase();
    if (role && role !== 'head') {
      const subtree = new Set(await this.units.subtree(org.id, unit.id).catch(() => [unit.id]));
      for (const m of members.filter((x) => (x.title ?? '').toLowerCase().includes(role))) {
        const u = await this.units.unitForAssignee(org.id, m.agentId).catch(() => null);
        if (u && subtree.has(u.id)) return m.agentId;
      }
    }
    return members.some((m) => m.agentId === unit.leadAgentId) ? unit.leadAgentId : null;
  }

  /**
   * Start a run, pinned to the active version. Refused for a retired or
   * draft process and beyond `process.maxActiveRuns`; a trigger ref already
   * used (the same cadence minute, the same incident) returns that run.
   */
  async start(orgId: string, ref: string, input: StartInput): Promise<OrgProcessRun> {
    const org = await this.org.get(orgId);
    const p = await this.get(orgId, ref);
    if (p.status !== 'active' || !p.versionId) throw new BadRequestException(`${p.title} is ${p.status}: it cannot start a run${p.status === 'draft' ? ' until its first version is approved' : ''}`);
    const triggerRef = input.triggerRef ?? `manual:${newId()}`;
    const dup = (await this.db.select().from(orgProcessRuns).where(and(eq(orgProcessRuns.processId, p.id), eq(orgProcessRuns.triggerRef, triggerRef))).limit(1)).at(0);
    if (dup) return dup;
    const open = (await this.runs(orgId, { processId: p.id })).filter((r) => OPEN_RUN.includes(r.status)).length;
    const cap = processTunable(org, 'process.maxActiveRuns');
    // A service request is admitted by its service (docs/services.md): the requests are the queue, not the run cap.
    if (open >= cap && input.trigger?.kind !== 'service_request') {
      await this.log(orgId, p.id, '', '', 'start_skipped', input.initiator, { reason: `max active runs (${cap})`, triggerRef });
      throw new BadRequestException(`refused: ${p.title} already has ${open} open run(s), the company's limit (process.maxActiveRuns ${cap}) — finish or cancel one first`);
    }
    const v = await this.version(orgId, p.versionId);
    const def = this.defOf(v);
    const now = nowIso();
    const vars = strVars(input.vars);
    let run: OrgProcessRun | null = null;
    for (let i = 0; i < 6 && !run; i++) {
      const n = (await this.db.select({ key: orgProcessRuns.key }).from(orgProcessRuns).where(eq(orgProcessRuns.orgId, orgId))).reduce((m, r) => Math.max(m, Number(/^PR-(\d+)$/.exec(r.key)?.[1] ?? 0)), 0) + 1 + i;
      const row: OrgProcessRun = {
        accountId: currentAccountId(), id: newId(), orgId, processId: p.id, versionId: v.id, version: v.version, key: `PR-${n}`,
        title: (input.title ?? '').trim().slice(0, 160) || fill(def.title, vars), status: 'running', stage: def.stages[0]?.id ?? '',
        ownerAgentId: null, initiator: input.initiator.slice(0, 80), trigger: JSON.stringify(input.trigger ?? { kind: 'manual' }), triggerRef,
        projectId: input.projectId ?? null, unitId: p.unitId, vars: JSON.stringify(vars), loops: '{}',
        parentRunId: input.parentRunId ?? null, parentStepId: input.parentStepId ?? null, note: '', startedAt: now, endedAt: null, updatedAt: now,
      };
      row.ownerAgentId = await this.ownerFor(org, p, def);
      if (!row.projectId && def.category === 'operating') row.projectId = await this.operatingProject(orgId, p.unitId);
      const inserted = await this.db.insert(orgProcessRuns).values(row).onConflictDoNothing().returning();
      if (inserted.length) run = inserted[0];
      else {
        const again = (await this.db.select().from(orgProcessRuns).where(and(eq(orgProcessRuns.processId, p.id), eq(orgProcessRuns.triggerRef, triggerRef))).limit(1)).at(0);
        if (again) return again;
      }
    }
    if (!run) throw new BadRequestException('could not allocate a run key — try again');
    await this.log(orgId, p.id, run.id, '', 'started', input.initiator, { trigger: input.trigger ?? { kind: 'manual' }, version: v.version });
    await this.audit.append(orgId, { actor: input.initiator, action: 'process_run_start', refType: 'process_run', refId: run.id, payload: { process: p.name, key: run.key, version: v.version } });
    await this.withRun(run.id, () => this.advance(orgId, run!.id));
    return this.run(orgId, run.id);
  }

  /** An operating process's tasks live in its unit's Operating project. */
  private async operatingProject(orgId: string, unitId: string | null): Promise<string | null> {
    const unit = unitId ?? (this.units ? (await this.units.rootUnit(orgId).catch(() => null))?.id ?? null : null);
    const p = (await this.org.projects(orgId)).find((x) => x.kind === 'operating' && x.unitId === unit && x.status !== 'cancelled');
    return p?.id ?? null;
  }

  /** Cancel a run and its open step tasks. */
  async cancel(orgId: string, ref: string, reason: string, actor: string): Promise<OrgProcessRun> {
    const run = await this.run(orgId, ref);
    if (!OPEN_RUN.includes(run.status)) return run;
    await this.withRun(run.id, async () => {
      await this.db.update(orgProcessRuns).set({ status: 'cancelled', note: reason.slice(0, 600), endedAt: nowIso(), updatedAt: nowIso() }).where(eq(orgProcessRuns.id, run.id));
      for (const s of (await this.steps(orgId, run.id)).filter((x) => x.current && x.status === 'active')) {
        await this.db.update(orgProcessSteps).set({ status: 'cancelled', endedAt: nowIso() }).where(eq(orgProcessSteps.id, s.id));
        if (s.taskId) { const t = await this.tasks.get(orgId, s.taskId).catch(() => null); if (t && !['done', 'cancelled'].includes(t.status)) await this.tasks.update(orgId, t.id, { status: 'cancelled' }, actor).catch(() => undefined); }
        if (s.childRunId) this.defer(() => this.cancel(orgId, s.childRunId!, `parent run cancelled: ${reason}`, actor));
      }
      await this.log(orgId, run.processId, run.id, '', 'cancelled', actor, { reason });
    });
    return this.run(orgId, run.id);
  }

  /** The current attempt of each node, by node id. */
  private currentMap(steps: OrgProcessStep[]): Map<string, OrgProcessStep> {
    const m = new Map<string, OrgProcessStep>();
    for (const s of steps) if (s.current) { const prev = m.get(s.nodeId); if (!prev || s.attempt > prev.attempt) m.set(s.nodeId, s); }
    return m;
  }
  private states(cur: Map<string, OrgProcessStep>): Map<string, StepState> {
    return new Map([...cur.entries()].map(([k, s]) => [k, s.status as StepState]));
  }

  /**
   * Move a run as far as its state allows: skip dead branches, materialise
   * ready steps of a strict stage (or the coordinator of a dynamic one),
   * move to the next stage, finish the run. Call inside `withRun`.
   */
  private async advance(orgId: string, runId: string): Promise<void> {
    for (let guard = 0; guard < 20; guard++) {
      const run = await this.run(orgId, runId);
      if (run.status !== 'running') return;
      const def = await this.runDef(orgId, run);
      const stage = def.stages.find((s) => s.id === run.stage) ?? def.stages[0];
      if (!stage) return this.finishRun(orgId, run, 'done', 'no stages');
      const steps = await this.steps(orgId, run.id);
      const cur = this.currentMap(steps);
      const vars = parse<Record<string, string>>(run.vars, {});
      let stageDone: boolean;
      if (stage.mode === 'strict') {
        const { ready, skip } = strictWalk(def, stage.id, this.states(new Map([...cur].filter(([k]) => nodesOf(def, stage.id).some((n) => n.id === k)))), vars);
        for (const id of skip) await this.insertStep(orgId, run, { nodeId: id, kind: def.nodes.find((n) => n.id === id)!.kind, stage: stage.id, status: 'skipped', attempt: this.nextAttempt(steps, id) });
        for (const id of ready) await this.materialize(orgId, run, def, def.nodes.find((n) => n.id === id)!, this.nextAttempt(steps, id), 'engine');
        if (skip.length) { await this.log(orgId, run.processId, run.id, '', 'skipped', 'engine', { nodes: skip }); continue; }
        stageDone = strictStageDone(def, stage.id, this.states(this.currentMap(await this.steps(orgId, run.id))));
      } else {
        const coord = cur.get(`${STAGE_NODE}${stage.id}`);
        if (!coord) { await this.materializeCoordinator(orgId, run, def, stage, this.nextAttempt(steps, `${STAGE_NODE}${stage.id}`)); return; }
        stageDone = coord.status === 'done';
      }
      if (!stageDone) return;
      const idx = def.stages.findIndex((s) => s.id === stage.id);
      const next = def.stages[idx + 1];
      await this.log(orgId, run.processId, run.id, '', 'stage_done', 'engine', { stage: stage.id });
      if (!next) return this.finishRun(orgId, run, 'done', '');
      await this.db.update(orgProcessRuns).set({ stage: next.id, updatedAt: nowIso() }).where(eq(orgProcessRuns.id, run.id));
    }
  }

  private nextAttempt(steps: OrgProcessStep[], nodeId: string): number {
    return steps.filter((s) => s.nodeId === nodeId).reduce((m, s) => Math.max(m, s.attempt), 0) + 1;
  }

  private async insertStep(orgId: string, run: OrgProcessRun, s: { nodeId: string; kind: string; stage: string; status: string; attempt: number; spec?: string; chosenBy?: string }): Promise<OrgProcessStep | null> {
    const now = nowIso();
    const row: OrgProcessStep = {
      accountId: currentAccountId(), id: newId(), orgId, runId: run.id, nodeId: s.nodeId, attempt: s.attempt, kind: s.kind, stage: s.stage, status: s.status, current: 1,
      taskId: null, approvalId: null, childRunId: null, dueAt: null, slaAt: null, slaBreachedAt: null, outputs: '{}', deviations: '[]', spec: s.spec ?? '', chosenBy: s.chosenBy ?? '', outcome: s.status === 'skipped' ? 'skipped' : '',
      startedAt: now, endedAt: s.status === 'active' ? null : now,
    };
    const inserted = await this.db.insert(orgProcessSteps).values(row).onConflictDoNothing().returning();
    return inserted[0] ?? null;
  }

  /** Materialise one step: a task, a card, a timer or a child run. Idempotent. */
  private async materialize(orgId: string, run: OrgProcessRun, def: ProcessDef, node: ProcessNode, attempt: number, chosenBy: string, opts: { spec?: string; assignee?: string | null } = {}): Promise<OrgProcessStep | null> {
    const step = await this.insertStep(orgId, run, { nodeId: node.id, kind: node.kind, stage: node.stage ?? def.stages[0].id, status: 'active', attempt, spec: opts.spec, chosenBy });
    if (!step) return null;
    try {
      await this.fillStep(orgId, run, def, node, step, opts.assignee);
    } catch (err) {
      // A refusal on the normal creation path (a gate, a limit) fails the step
      // with its reason instead of leaving a row the sweep retries forever.
      await this.log(orgId, run.processId, run.id, node.id, 'materialize_failed', chosenBy, { error: err instanceof Error ? err.message.slice(0, 400) : String(err) });
      await this.failStep(orgId, run, step, `it could not be created: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500));
      return step;
    }
    await this.log(orgId, run.processId, run.id, node.id, 'materialized', chosenBy, { kind: node.kind, attempt });
    return step;
  }

  /** Create what a step row stands for (also the sweep's repair of a row left empty by a restart). */
  private async fillStep(orgId: string, run: OrgProcessRun, def: ProcessDef, node: ProcessNode, step: OrgProcessStep, assignee?: string | null): Promise<void> {
    const org = await this.org.get(orgId);
    const p = await this.get(orgId, run.processId);
    const vars = parse<Record<string, string>>(run.vars, {});
    const now = new Date();
    if (node.kind === 'task') {
      const orphan = (await this.db.select().from(orgTasks).where(and(eq(orgTasks.orgId, orgId), eq(orgTasks.processRunId, run.id), eq(orgTasks.processNodeId, node.id)))).find((t) => t.createdAt >= step.startedAt);
      const agentId = orphan?.assigneeAgentId ?? assignee ?? await this.laneAgent(org, p, run, node.lane);
      const task = orphan ?? await this.createStepTask(orgId, run, def, p, node, agentId, vars, step.attempt);
      const sla = node.slaHours ?? processTunable(org, 'process.defaultSlaHours');
      await this.db.update(orgProcessSteps).set({ taskId: task.id, slaAt: sla > 0 ? hoursFrom(now, sla) : null }).where(eq(orgProcessSteps.id, step.id));
    } else if (node.kind === 'approval') {
      const requester = node.approver === 'ceo' ? 'system' : `agent:${run.ownerAgentId ?? org.chiefOfStaffAgentId}`;
      const card = await this.approvals.create(orgId, {
        kind: 'process_gate', requestedBy: requester,
        payload: { runId: run.id, stepId: step.id, nodeId: node.id, runKey: run.key, processTitle: p.title, question: fill(node.question, vars), why: node.why ?? '', agentId: run.ownerAgentId ?? undefined, ...(node.approver === 'ceo' ? { boundary: 'propose', boundaryRule: 'an approval step addressed to the CEO' } : {}) },
        recommendation: fill(node.question, vars).slice(0, 600),
      });
      await this.db.update(orgProcessSteps).set({ approvalId: card.id }).where(eq(orgProcessSteps.id, step.id));
    } else if (node.kind === 'wait') {
      await this.db.update(orgProcessSteps).set({ dueAt: hoursFrom(now, Number(node.waitHours) || 1) }).where(eq(orgProcessSteps.id, step.id));
    } else if (node.kind === 'subprocess') {
      const child = await this.start(orgId, node.process ?? '', { initiator: `process:${run.id}`, trigger: { kind: 'subprocess', ref: run.id }, triggerRef: `parent:${step.id}`, parentRunId: run.id, parentStepId: step.id, vars, projectId: run.projectId })
        .catch(async (err: unknown) => { await this.failStep(orgId, run, step, `the subprocess could not start: ${err instanceof Error ? err.message : String(err)}`); return null; });
      if (child) await this.db.update(orgProcessSteps).set({ childRunId: child.id }).where(eq(orgProcessSteps.id, step.id));
    }
  }

  private async createStepTask(orgId: string, run: OrgProcessRun, def: ProcessDef, p: OrgProcess, node: ProcessNode, agentId: string | null, vars: Record<string, string>, attempt: number): Promise<OrgTask> {
    const coord = node.stage ? (await this.steps(orgId, run.id)).find((s) => s.current && s.nodeId === `${STAGE_NODE}${node.stage}`) : undefined;
    const task = await this.tasks.create(orgId, {
      title: `${fill(node.title, vars)} · ${run.key}${attempt > 1 ? ` (round ${attempt})` : ''}`.slice(0, 200),
      brief: {
        outcome: fill(node.outcome, vars) || fill(node.title, vars),
        context: [`Step "${node.title}" of the process "${p.title}" v${run.version}, run ${run.key}${run.title && run.title !== p.title ? ` "${run.title}"` : ''}.`, node.why ? `Why: ${node.why}.` : '', fill(node.context, vars)].filter(Boolean).join(' ').slice(0, 2_000),
        constraints: [node.deny?.length ? `Not in this step: ${node.deny.join(', ')}.` : '', node.class ? `class: ${node.class}` : ''].filter(Boolean).join(' '),
        done_when: fill(node.doneWhen, vars) || 'the step card\'s MUST items are met',
      },
      projectId: run.projectId, parentTaskId: coord?.taskId ?? null, unitId: p.unitId ?? undefined,
      assigneeAgentId: agentId, status: agentId ? 'todo' : 'backlog', createdBy: `process:${run.id}`.slice(0, 80), source: 'process',
      class: node.class ?? null, checks: node.checks ?? undefined,
      process: { runId: run.id, nodeId: node.id, category: def.category },
    });
    const items: TaskStep[] = [
      ...(node.must ?? []).map((text) => ({ text, from: 'process:must' })),
      ...(node.should ?? []).map((text) => ({ text, from: 'process:should' })),
      ...(node.may ?? []).map((text) => ({ text, from: 'process:may' })),
    ].map((x, i) => ({ id: `s${i + 1}`, text: fill(x.text, vars).slice(0, 300), done: false, from: x.from }));
    if (items.length) await this.db.update(orgTasks).set({ steps: JSON.stringify(items) }).where(eq(orgTasks.id, task.id));
    return this.tasks.get(orgId, task.id);
  }

  private async materializeCoordinator(orgId: string, run: OrgProcessRun, def: ProcessDef, stage: ProcessStage, attempt: number): Promise<void> {
    const nodeId = `${STAGE_NODE}${stage.id}`;
    const step = await this.insertStep(orgId, run, { nodeId, kind: 'stage', stage: stage.id, status: 'active', attempt, chosenBy: 'engine' });
    if (!step) return;
    await this.fillCoordinator(orgId, run, def, stage, step);
    await this.log(orgId, run.processId, run.id, nodeId, 'materialized', 'engine', { kind: 'stage' });
  }

  private async fillCoordinator(orgId: string, run: OrgProcessRun, def: ProcessDef, stage: ProcessStage, step: OrgProcessStep): Promise<void> {
    const p = await this.get(orgId, run.processId);
    const orphan = (await this.db.select().from(orgTasks).where(and(eq(orgTasks.orgId, orgId), eq(orgTasks.processRunId, run.id), eq(orgTasks.processNodeId, step.nodeId)))).find((t) => t.createdAt >= step.startedAt);
    const required = nodesOf(def, stage.id).filter((n) => n.required).map((n) => n.title);
    const task = orphan ?? await this.tasks.create(orgId, {
      title: `${stage.title}: choose the steps · ${run.key} ${p.title}`.slice(0, 200),
      brief: {
        outcome: `Stage "${stage.title}" of the process "${p.title}" (run ${run.key}) is done: the steps it needs are chosen and finished.`,
        context: `A dynamic stage: you choose which available step to do next (org_process_next lists them; org_step_choose starts one), skip optional ones, and may add an ad-hoc step when the defined ones do not fit.`,
        constraints: required.length ? `Checkpoints that must be done: ${required.join('; ')}.` : '',
        done_when: 'Every checkpoint of the stage is done; then org_process_next with finish: true closes the stage.',
      },
      projectId: run.projectId, unitId: p.unitId ?? undefined, assigneeAgentId: run.ownerAgentId, status: run.ownerAgentId ? 'todo' : 'backlog',
      createdBy: `process:${run.id}`.slice(0, 80), source: 'process', class: 'triage', process: { runId: run.id, nodeId: step.nodeId, category: def.category },
    });
    await this.db.update(orgProcessSteps).set({ taskId: task.id }).where(eq(orgProcessSteps.id, step.id));
  }

  private async finishRun(orgId: string, run: OrgProcessRun, status: 'done' | 'failed', note: string): Promise<void> {
    await this.db.update(orgProcessRuns).set({ status, note: note.slice(0, 600), endedAt: nowIso(), updatedAt: nowIso() }).where(eq(orgProcessRuns.id, run.id));
    await this.log(orgId, run.processId, run.id, '', status === 'done' ? 'completed' : 'failed', 'engine', note ? { note } : {});
    await this.audit.append(orgId, { actor: 'process', action: `process_run_${status}`, refType: 'process_run', refId: run.id, payload: { key: run.key, note: note.slice(0, 200) } });
    if (status === 'failed' && run.ownerAgentId) {
      const p = await this.get(orgId, run.processId).catch(() => null);
      await this.agents.addEvent(run.ownerAgentId, { kind: 'info', title: `Process run ${run.key} (${p?.title ?? 'process'}) failed`.slice(0, 200), body: note, payload: JSON.stringify({ orgId, runId: run.id }), origin: 'loop' }).catch(() => undefined);
    }
    // A child run settles its parent's subprocess step.
    if (run.parentRunId && run.parentStepId) {
      const parentId = run.parentRunId;
      const stepId = run.parentStepId;
      this.defer(() => this.withRun(parentId, async () => {
        const parent = await this.run(orgId, parentId).catch(() => null);
        const s = parent ? (await this.steps(orgId, parentId)).find((x) => x.id === stepId) : undefined;
        if (!parent || !s || s.status !== 'active') return;
        if (status === 'done') await this.completeStep(orgId, parent, s, 'done', parse<Record<string, string>>(run.vars, {}));
        else await this.failStep(orgId, parent, s, `subprocess ${run.key} failed: ${note}`);
        await this.advance(orgId, parentId);
      }));
    }
  }

  /** A step finished: outputs into the run's variables, loop edges, then advance (caller holds the run). */
  private async completeStep(orgId: string, run0: OrgProcessRun, step0: OrgProcessStep, outcome: string, extraVars: Record<string, string> = {}): Promise<void> {
    // Re-read both: a sweep settles several steps of one run in a row.
    const run = await this.run(orgId, run0.id);
    const step = (await this.steps(orgId, run.id)).find((s) => s.id === step0.id) ?? step0;
    await this.db.update(orgProcessSteps).set({ status: 'done', outcome: outcome.slice(0, 40), endedAt: nowIso() }).where(eq(orgProcessSteps.id, step.id));
    const vars = { ...parse<Record<string, string>>(run.vars, {}), ...extraVars, ...parse<Record<string, string>>(step.outputs, {}) };
    // The step's outcome under its id (approved, rejected, done), unless an output of the same name carries the value.
    const outKey = step.nodeId.replace(/-/g, '_');
    if (!isCoordinator(step.nodeId) && !step.nodeId.startsWith(ADHOC) && !(outKey in parse<Record<string, string>>(step.outputs, {}))) vars[outKey] = outcome;
    await this.db.update(orgProcessRuns).set({ vars: JSON.stringify(vars), updatedAt: nowIso() }).where(eq(orgProcessRuns.id, run.id));
    await this.log(orgId, run.processId, run.id, step.nodeId, 'step_done', 'engine', { outcome, attempt: step.attempt });
    const def = await this.runDef(orgId, run);
    const stage = def.stages.find((s) => s.id === step.stage);
    if (stage?.mode === 'strict') await this.fireLoops(orgId, { ...run, vars: JSON.stringify(vars) }, def, stage.id, step.nodeId, vars);
    if (stage?.mode === 'dynamic' && !isCoordinator(step.nodeId)) await this.nudgeCoordinator(orgId, run, def, stage, `Step "${this.nodeOf(def, step)?.title ?? step.nodeId}" is done (${outcome}).`);
  }

  /** A back edge out of `from` whose condition holds sends the run round again (bounded). */
  private async fireLoops(orgId: string, run: OrgProcessRun, def: ProcessDef, stageId: string, from: string, vars: Record<string, string>): Promise<void> {
    const back = backEdges(def, stageId).filter((e) => e.from === from && holds(e.when, vars));
    const e = back[0];
    if (!e) return;
    const loops = parse<Record<string, number>>(run.loops, {});
    const key = `${e.from}>${e.to}`;
    const n = loops[key] ?? 0;
    if (n >= (e.loopMax ?? 1)) {
      await this.escalateLoop(orgId, run, e.from, e.to, e.loopMax ?? 1);
      return;
    }
    loops[key] = n + 1;
    const reset = downstream(def, stageId, e.to);
    const cur = this.currentMap(await this.steps(orgId, run.id));
    for (const id of reset) { const s = cur.get(id); if (s) await this.db.update(orgProcessSteps).set({ current: 0 }).where(eq(orgProcessSteps.id, s.id)); }
    await this.db.update(orgProcessRuns).set({ loops: JSON.stringify(loops), updatedAt: nowIso() }).where(eq(orgProcessRuns.id, run.id));
    await this.log(orgId, run.processId, run.id, e.to, 'looped', 'engine', { edge: key, round: n + 1, of: e.loopMax });
  }

  /** A loop went round loopMax times: the run waits on a decision up the line. */
  private async escalateLoop(orgId: string, run: OrgProcessRun, from: string, to: string, loopMax: number): Promise<void> {
    const p = await this.get(orgId, run.processId);
    await this.db.update(orgProcessRuns).set({ status: 'blocked', note: `the loop ${from} → ${to} went round ${loopMax} time(s)`, updatedAt: nowIso() }).where(eq(orgProcessRuns.id, run.id));
    const org = await this.org.get(orgId);
    await this.approvals.create(orgId, {
      kind: 'process_gate', requestedBy: `agent:${run.ownerAgentId ?? org.chiefOfStaffAgentId}`,
      payload: { runId: run.id, escalation: 'loop', edge: `${from}>${to}`, runKey: run.key, processTitle: p.title, reason: `"${to}" was sent back ${loopMax} time(s) (its loopMax): allow one more round, or stop the run?`, agentId: run.ownerAgentId ?? undefined },
      recommendation: 'Approve for one more round; reject to stop the run. If this keeps happening, split the step or revise the process.',
    });
    await this.log(orgId, run.processId, run.id, to, 'loop_exhausted', 'engine', { edge: `${from}>${to}`, loopMax });
  }

  private async failStep(orgId: string, run: OrgProcessRun, step: OrgProcessStep, reason: string): Promise<void> {
    await this.db.update(orgProcessSteps).set({ status: 'failed', outcome: 'failed', endedAt: nowIso() }).where(eq(orgProcessSteps.id, step.id));
    await this.log(orgId, run.processId, run.id, step.nodeId, 'step_failed', 'engine', { reason });
    const def = await this.runDef(orgId, run);
    const node = this.nodeOf(def, step);
    const stage = def.stages.find((s) => s.id === step.stage);
    if (node && step.attempt < (node.maxAttempts ?? 1) && !step.nodeId.startsWith(ADHOC)) {
      await this.materialize(orgId, run, def, node, step.attempt + 1, 'engine');
      return;
    }
    // In a dynamic stage an optional step may fail: the performer chooses another.
    if (stage?.mode === 'dynamic' && !isCoordinator(step.nodeId) && !node?.required) {
      await this.nudgeCoordinator(orgId, run, def, stage, `Step "${node?.title ?? step.nodeId}" failed: ${reason}`);
      return;
    }
    await this.finishRun(orgId, run, 'failed', `step "${node?.title ?? step.nodeId}" failed: ${reason}`);
  }

  private nodeOf(def: ProcessDef, step: Pick<OrgProcessStep, 'nodeId' | 'spec'>): ProcessNode | null {
    if (step.nodeId.startsWith(ADHOC)) return parse<ProcessNode | null>(step.spec, null);
    return def.nodes.find((n) => n.id === step.nodeId) ?? null;
  }

  // ---- events that move runs ----

  /** A step's task reached done or cancelled. */
  private async onTaskSettled(orgId: string, taskId: string, to: 'done' | 'cancelled'): Promise<void> {
    const step = await this.stepOfTask(orgId, taskId);
    if (!step || step.status !== 'active' || !step.current) return;
    await this.withRun(step.runId, async () => {
      const run = await this.run(orgId, step.runId);
      const fresh = (await this.steps(orgId, run.id)).find((s) => s.id === step.id);
      if (!fresh || fresh.status !== 'active' || !OPEN_RUN.includes(run.status)) return;
      if (to === 'done') await this.completeStep(orgId, run, fresh, 'done');
      else await this.failStep(orgId, run, fresh, 'its task was cancelled');
      await this.advance(orgId, run.id);
    });
  }

  private async gateDecided(orgId: string, a: OrgApproval, payload: Record<string, unknown>, decision: 'approve' | 'reject' | 'revise', note: string): Promise<Record<string, unknown>> {
    const runId = String(payload.runId ?? '');
    return this.withRun(runId, async () => {
      const run = await this.run(orgId, runId);
      if (payload.escalation === 'loop') {
        if (run.status !== 'blocked') return { runId };
        if (decision === 'approve') {
          const loops = parse<Record<string, number>>(run.loops, {});
          const key = String(payload.edge ?? '');
          loops[key] = Math.max(0, (loops[key] ?? 1) - 1);
          await this.db.update(orgProcessRuns).set({ status: 'running', loops: JSON.stringify(loops), note: '', updatedAt: nowIso() }).where(eq(orgProcessRuns.id, run.id));
          const fresh = await this.run(orgId, runId);
          const def = await this.runDef(orgId, fresh);
          const [from] = key.split('>');
          const s = this.currentMap(await this.steps(orgId, runId)).get(from);
          await this.log(orgId, run.processId, run.id, from, 'loop_extended', `approval:${a.id}`, { note });
          if (s) await this.fireLoops(orgId, fresh, def, s.stage, from, parse<Record<string, string>>(fresh.vars, {}));
          await this.advance(orgId, runId);
        } else await this.finishRun(orgId, run, 'failed', `stopped at the loop ${String(payload.edge)}${note ? `: ${note}` : ''}`);
        return { runId };
      }
      const step = (await this.steps(orgId, runId)).find((s) => s.id === payload.stepId);
      if (!step || step.status !== 'active' || !OPEN_RUN.includes(run.status)) return { runId };
      const outcome = decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : 'revise';
      await this.completeStep(orgId, run, step, outcome, note ? { [`${step.nodeId.replace(/-/g, '_')}_note`]: note } : {});
      await this.advance(orgId, runId);
      return { runId, outcome };
    });
  }

  private async onIncident(orgId: string, incidentId: string, severity: string): Promise<void> {
    const rank = (x: string) => ['minor', 'major', 'critical'].indexOf(x);
    const inc = (await this.db.select().from(orgIncidents).where(eq(orgIncidents.id, incidentId)).limit(1)).at(0);
    for (const p of await this.list(orgId)) {
      if (p.status !== 'active') continue;
      const def = await this.activeDef(orgId, p).catch(() => null);
      const t = def?.triggers.find((x) => x.kind === 'event' && x.event === 'incident_opened' && x.enabled !== false);
      if (!t || t.kind !== 'event' || rank(severity) < rank(t.severity ?? 'minor')) continue;
      await this.start(orgId, p.id, { initiator: 'trigger', trigger: { kind: 'event', event: 'incident_opened', ref: incidentId }, triggerRef: `incident:${incidentId}`, title: inc ? `${p.title}: ${inc.title}` : undefined, vars: { incident: inc?.title ?? `${severity} incident`, incident_id: incidentId, severity } }).catch(() => undefined);
    }
  }

  /** A service request (docs/processes.md "Services"): the hook a service catalog will call. */
  async startServiceRequest(orgId: string, service: string, input: { title?: string; vars?: Record<string, unknown>; requestedBy: string; ref?: string; process?: string; projectId?: string | null }): Promise<OrgProcessRun> {
    // The service catalog names the process it links (docs/services.md); it must take requests.
    const named = input.process ? [await this.get(orgId, input.process)] : null;
    for (const p of named ?? await this.list(orgId)) {
      const def = await this.activeDef(orgId, p).catch(() => null);
      const t = def?.triggers.find((x) => x.kind === 'service_request' && x.enabled !== false && (!x.service || x.service === service || p.name === service));
      if (t) return this.start(orgId, p.id, { initiator: input.requestedBy, trigger: { kind: 'service_request', ref: input.ref ?? service }, triggerRef: input.ref ? `service:${input.ref}` : undefined, title: input.title, vars: input.vars, projectId: input.projectId ?? null });
    }
    throw new BadRequestException(`no process takes requests for "${service}"`);
  }

  // ---- the tick: cadences, scanned events, timers, SLAs ----

  async tick(org: Organization, now: Date): Promise<void> {
    const orgId = org.id;
    const procs = await this.db.select().from(orgProcesses).where(eq(orgProcesses.orgId, orgId));
    // A company from before processes gets the library once, its cadences off.
    if (procs.length === 0) { await this.seed(orgId, { source: 'template', cadences: false }).catch(() => undefined); return; }
    for (const p of procs.filter((x) => x.status === 'active' && x.versionId)) {
      const v = await this.version(orgId, p.versionId!).catch(() => null);
      if (!v) continue;
      const def = this.defOf(v);
      for (const t of def.triggers) {
        if ('enabled' in t && t.enabled === false) continue;
        if (t.kind === 'cadence') {
          const after = new Date(Math.max(Date.parse(p.lastCadenceAt ?? v.activatedAt ?? p.createdAt), now.getTime() - 6 * 3_600_000));
          const hit = prevCronMatch(t.cron, now, after);
          if (!hit) continue;
          await this.db.update(orgProcesses).set({ lastCadenceAt: hit.toISOString() }).where(eq(orgProcesses.id, p.id));
          await this.start(orgId, p.id, { initiator: 'trigger', trigger: { kind: 'cadence', ref: t.cron }, triggerRef: `cadence:${hit.toISOString()}` }).catch(() => undefined);
        } else if (t.kind === 'event' && t.event === 'project_now') {
          const since = v.activatedAt ?? v.createdAt;
          for (const pr of (await this.org.projects(orgId)).filter((x) => x.kind === 'project' && x.lane === 'now' && x.status === 'active' && (x.updatedAt ?? '') >= since)) {
            await this.start(orgId, p.id, { initiator: 'trigger', trigger: { kind: 'event', event: 'project_now', ref: pr.id }, triggerRef: `project:${pr.id}`, projectId: pr.id, title: `${p.title}: ${pr.title}`, vars: { project: pr.title, project_key: pr.key ?? '' } }).catch(() => undefined);
          }
        } else if (t.kind === 'event' && t.event === 'task_created' && t.class) {
          const since = v.activatedAt ?? v.createdAt;
          for (const tk of (await this.tasks.list(orgId)).filter((x) => x.class === t.class && x.source !== 'process' && x.createdAt >= since && !['done', 'cancelled'].includes(x.status))) {
            await this.start(orgId, p.id, { initiator: tk.createdBy, trigger: { kind: 'event', event: 'task_created', ref: tk.id }, triggerRef: `task:${tk.id}`, projectId: tk.projectId, title: `${p.title}: ${tk.title}`, vars: { task: `${taskRef(tk)} ${tk.title}`, task_key: tk.key ?? '' } }).catch(() => undefined);
          }
        }
      }
    }
    // Timers and SLAs of open runs.
    const open = (await this.runs(orgId)).filter((r) => OPEN_RUN.includes(r.status));
    if (!open.length) return;
    const steps = await this.db.select().from(orgProcessSteps).where(and(eq(orgProcessSteps.orgId, orgId), inArray(orgProcessSteps.runId, open.map((r) => r.id)), eq(orgProcessSteps.status, 'active'), eq(orgProcessSteps.current, 1)));
    for (const s of steps) {
      const run = open.find((r) => r.id === s.runId)!;
      if (s.kind === 'wait' && s.dueAt && s.dueAt <= now.toISOString()) {
        await this.withRun(run.id, async () => { const r = await this.run(orgId, run.id); const f = (await this.steps(orgId, run.id)).find((x) => x.id === s.id); if (f?.status === 'active') { await this.completeStep(orgId, r, f, 'done'); await this.advance(orgId, run.id); } });
      }
      if (s.slaAt && !s.slaBreachedAt && s.slaAt <= now.toISOString() && s.taskId) await this.slaBreached(org, run, s);
    }
  }

  private async slaBreached(org: Organization, run: OrgProcessRun, s: OrgProcessStep): Promise<void> {
    const t = await this.tasks.get(org.id, s.taskId!).catch(() => null);
    await this.db.update(orgProcessSteps).set({ slaBreachedAt: nowIso() }).where(eq(orgProcessSteps.id, s.id));
    if (!t || ['done', 'cancelled', 'in_review'].includes(t.status)) return;
    const p = await this.get(org.id, run.processId);
    const reason = `SLA breached: step "${t.title}" of ${p.title} (${run.key}) is past its SLA`;
    await this.log(org.id, run.processId, run.id, s.nodeId, 'sla_breached', 'engine', { taskId: t.id });
    if (processTunable(org, 'process.slaAction') >= 1 && t.assigneeAgentId && t.status !== 'blocked') {
      await this.tasks.escalate(org.id, t.id, reason, `agent:${t.assigneeAgentId}`).catch(() => undefined);
    } else {
      await this.tasks.comment(org.id, t.id, { text: `${reason}. Finish it, set it blocked with what it waits on, or hand it back.`, fromAgentId: null, wake: true, system: true }).catch(() => undefined);
      if (run.ownerAgentId && run.ownerAgentId !== t.assigneeAgentId) await this.agents.addEvent(run.ownerAgentId, { kind: 'info', title: reason.slice(0, 200), body: '', payload: JSON.stringify({ orgId: org.id, taskId: t.id, runId: run.id }), origin: 'loop' }).catch(() => undefined);
    }
  }

  /**
   * Reconcile every open run with the record (the boot sweep, and every few
   * minutes): repair step rows a restart left without their task or card,
   * settle steps whose task, card or child run already finished, then
   * advance. Safe to repeat: everything it creates is keyed (run, node, attempt).
   */
  async sweep(orgId: string): Promise<{ repaired: number; settled: number }> {
    let repaired = 0;
    let settled = 0;
    for (const run of (await this.runs(orgId)).filter((r) => OPEN_RUN.includes(r.status))) {
      await this.withRun(run.id, async () => {
        const fresh = await this.run(orgId, run.id);
        const def = await this.runDef(orgId, fresh);
        for (const s of (await this.steps(orgId, run.id)).filter((x) => x.current && x.status === 'active')) {
          if (isCoordinator(s.nodeId)) {
            const stage = def.stages.find((x) => `${STAGE_NODE}${x.id}` === s.nodeId);
            if (!s.taskId && stage) { await this.fillCoordinator(orgId, fresh, def, stage, s); repaired++; continue; }
          }
          const node = this.nodeOf(def, s);
          if ((s.kind === 'task' || s.kind === 'stage') && !s.taskId && node) { await this.fillStep(orgId, fresh, def, node, s); repaired++; continue; }
          if (s.kind === 'approval' && !s.approvalId && node) { await this.fillStep(orgId, fresh, def, node, s); repaired++; continue; }
          if (s.kind === 'subprocess' && !s.childRunId && node) { await this.fillStep(orgId, fresh, def, node, s); repaired++; continue; }
          if (s.taskId) {
            const t = await this.tasks.get(orgId, s.taskId).catch(() => null);
            if (t?.status === 'done') { await this.completeStep(orgId, fresh, s, 'done'); settled++; }
            else if (!t || t.status === 'cancelled') { await this.failStep(orgId, fresh, s, 'its task was cancelled'); settled++; }
          } else if (s.approvalId) {
            const a = await this.approvals.get(orgId, s.approvalId).catch(() => null);
            if (a && a.status !== 'pending') { await this.completeStep(orgId, fresh, s, a.status === 'approved' ? 'approved' : a.status === 'rejected' ? 'rejected' : a.status === 'expired' ? 'expired' : 'revise'); settled++; }
          } else if (s.childRunId) {
            const c = await this.run(orgId, s.childRunId).catch(() => null);
            if (c?.status === 'done') { await this.completeStep(orgId, fresh, s, 'done', parse<Record<string, string>>(c.vars, {})); settled++; }
            else if (c && (c.status === 'failed' || c.status === 'cancelled')) { await this.failStep(orgId, fresh, s, `subprocess ${c.key} ${c.status}`); settled++; }
          }
        }
        await this.advance(orgId, run.id);
      }).catch(() => undefined);
    }
    return { repaired, settled };
  }

  // ---- dynamic stages: the performer chooses ----

  /** Where a run stands in its dynamic stage: available steps, active ones, checkpoints left. */
  async nextFor(orgId: string, ref: string): Promise<{ run: OrgProcessRun; stage: ProcessStage; available: ProcessNode[]; active: Array<{ nodeId: string; title: string; taskKey: string | null }>; missing: ProcessNode[]; done: string[] }> {
    const run = await this.run(orgId, ref);
    const def = await this.runDef(orgId, run);
    const stage = def.stages.find((s) => s.id === run.stage) ?? def.stages[0];
    const steps = await this.steps(orgId, run.id);
    const cur = this.currentMap(steps);
    const states = this.states(cur);
    const vars = parse<Record<string, string>>(run.vars, {});
    const active: Array<{ nodeId: string; title: string; taskKey: string | null }> = [];
    for (const s of [...cur.values()].filter((x) => x.stage === stage.id && x.status === 'active' && !isCoordinator(x.nodeId))) {
      const t = s.taskId ? await this.tasks.get(orgId, s.taskId).catch(() => null) : null;
      active.push({ nodeId: s.nodeId, title: this.nodeOf(def, s)?.title ?? s.nodeId, taskKey: t ? taskRef(t) : null });
    }
    return {
      run, stage, available: stage.mode === 'dynamic' ? dynamicAvailable(def, stage.id, states, vars) : [], active,
      missing: stage.mode === 'dynamic' ? missingCheckpoints(def, stage.id, states, this.waivedNodes(steps)) : [],
      done: [...cur.values()].filter((x) => x.stage === stage.id && x.status === 'done' && !isCoordinator(x.nodeId)).map((x) => x.nodeId),
    };
  }

  private waivedNodes(steps: OrgProcessStep[]): Set<string> {
    const out = new Set<string>();
    for (const s of steps) for (const d of parse<Deviation[]>(s.deviations, [])) if (d.level === 'must' && d.status === 'approved' && d.item.startsWith('step:')) out.add(d.item.slice(5));
    return out;
  }

  /** Whether `agentId` performs the run's current dynamic stage (its coordinator's owner, the chief, the owning head). */
  private async mayChoose(orgId: string, run: OrgProcessRun, agentId: string | null): Promise<boolean> {
    if (!agentId) return true;
    const org = await this.org.get(orgId);
    if (agentId === org.chiefOfStaffAgentId || agentId === run.ownerAgentId) return true;
    const coord = (await this.steps(orgId, run.id)).find((s) => s.current && s.nodeId === `${STAGE_NODE}${run.stage}`);
    const t = coord?.taskId ? await this.tasks.get(orgId, coord.taskId).catch(() => null) : null;
    return t?.assigneeAgentId === agentId;
  }

  /**
   * Choose the next step of a dynamic stage — a defined step that is
   * available, or an ad-hoc one (logged as a deviation; off when
   * `process.adHocSteps` is 0). The run first moves to the process's newest
   * version when that is safe (`canAdopt`).
   */
  async choose(orgId: string, ref: string, input: { node?: string; adHoc?: { title: string; outcome?: string; doneWhen?: string; lane?: string; why?: string }; assignee?: string | null; reason?: string }, actor: string): Promise<{ step: OrgProcessStep; task: OrgTask | null; adopted: number | null }> {
    const run0 = await this.run(orgId, ref);
    const agentId = actor.startsWith('agent:') ? actor.slice(6) : null;
    if (!(await this.mayChoose(orgId, run0, agentId))) throw new BadRequestException(`refused: only the performer of ${run0.key}'s stage (its coordinator task's owner), the process owner or the chief chooses its steps`);
    return this.withRun(run0.id, async () => {
      let run = await this.run(orgId, run0.id);
      if (run.status !== 'running') throw new BadRequestException(`${run.key} is ${run.status}`);
      let def = await this.runDef(orgId, run);
      let stage = def.stages.find((s) => s.id === run.stage);
      if (!stage || stage.mode !== 'dynamic') throw new BadRequestException(`refused: ${run.key} is in a strict stage — the engine decides its next step`);
      // A dynamic run adopts the newest version at its next choice.
      let adopted: number | null = null;
      const p = await this.get(orgId, run.processId);
      if (p.versionId && p.versionId !== run.versionId) {
        const next = this.defOf(await this.version(orgId, p.versionId));
        const ids = (await this.steps(orgId, run.id)).filter((s) => s.current).map((s) => s.nodeId);
        if (canAdopt(next, run.stage, ids)) {
          await this.db.update(orgProcessRuns).set({ versionId: p.versionId, version: p.version, updatedAt: nowIso() }).where(eq(orgProcessRuns.id, run.id));
          await this.log(orgId, run.processId, run.id, '', 'version_adopted', actor, { from: run.version, to: p.version });
          adopted = p.version;
          run = await this.run(orgId, run.id);
          def = next;
          stage = def.stages.find((s) => s.id === run.stage)!;
        } else await this.log(orgId, run.processId, run.id, '', 'version_kept', actor, { newest: p.version, reason: 'the new version does not keep this stage and its steps' });
      }
      const steps = await this.steps(orgId, run.id);
      const states = this.states(this.currentMap(steps));
      const vars = parse<Record<string, string>>(run.vars, {});
      let node: ProcessNode;
      let spec: string | undefined;
      if (input.adHoc) {
        const org = await this.org.get(orgId);
        if (processTunable(org, 'process.adHocSteps') < 1) throw new BadRequestException('refused: this company runs only the defined steps (process.adHocSteps 0) — propose a change to the process if a step is missing');
        const title = (input.adHoc.title ?? '').trim().slice(0, 120);
        if (!title) throw new BadRequestException('an ad-hoc step needs a title');
        const n = steps.filter((s) => s.nodeId.startsWith(ADHOC)).length + 1;
        node = { id: `${ADHOC}${n}`, title, kind: 'task', stage: stage.id, lane: input.adHoc.lane, outcome: input.adHoc.outcome, doneWhen: input.adHoc.doneWhen, why: input.adHoc.why ?? input.reason ?? 'added by the performer' };
        spec = JSON.stringify(node);
      } else {
        const id = (input.node ?? '').trim();
        const found = nodesOf(def, stage.id).find((n) => n.id === id || n.title.toLowerCase() === id.toLowerCase());
        if (!found) throw new BadRequestException(`no step "${id}" in stage "${stage.title}" — available: ${dynamicAvailable(def, stage.id, states, vars).map((n) => n.id).join(', ') || 'none'}`);
        if (!dynamicAvailable(def, stage.id, states, vars).some((n) => n.id === found.id)) {
          const a = found.availableWhen ?? {};
          const why = [states.get(found.id) === 'done' ? 'it is done' : states.get(found.id) === 'active' ? 'it is already under way' : '', ...(a.after ?? []).filter((x) => states.get(x) !== 'done').map((x) => `it needs "${x}" done first`), ...(a.vars ?? []).filter((v) => !vars[v]).map((v) => `it needs ${v} set`)].filter(Boolean);
          throw new BadRequestException(`refused: "${found.title}" is not available — ${why.join('; ') || 'its condition does not hold'}`);
        }
        node = found;
      }
      const step = await this.materialize(orgId, run, def, node, this.nextAttempt(steps, node.id), actor, { spec, assignee: input.assignee ?? undefined });
      if (!step) throw new BadRequestException(`"${node.title}" is already under way`);
      if (input.adHoc) await this.recordDeviation(orgId, run, step, { level: 'ad_hoc', item: node.title, reason: input.reason ?? 'a step the process does not define', alternative: '', status: 'logged', by: actor, at: nowIso() });
      const fresh = (await this.steps(orgId, run.id)).find((s) => s.id === step.id)!;
      return { step: fresh, task: fresh.taskId ? await this.tasks.get(orgId, fresh.taskId) : null, adopted };
    });
  }

  /** Close a dynamic stage: refused while a checkpoint is undone or a step runs. */
  async finishStage(orgId: string, ref: string, actor: string): Promise<OrgProcessRun> {
    const info = await this.nextFor(orgId, ref);
    const agentId = actor.startsWith('agent:') ? actor.slice(6) : null;
    if (!(await this.mayChoose(orgId, info.run, agentId))) throw new BadRequestException('refused: only the stage\'s performer, the process owner or the chief finishes it');
    if (info.stage.mode !== 'dynamic') throw new BadRequestException('refused: a strict stage finishes on its own when its steps are done');
    if (info.missing.length) throw new BadRequestException(`refused: stage "${info.stage.title}" has checkpoint(s) not done: ${info.missing.map((n) => `${n.id} "${n.title}"`).join('; ')} — choose them with org_step_choose, or ask the process owner to waive one with org_process_deviate level=must item=step:<id>`);
    if (info.active.length) throw new BadRequestException(`refused: step(s) still under way: ${info.active.map((a) => `${a.title}${a.taskKey ? ` (${a.taskKey})` : ''}`).join('; ')} — finish or cancel them first`);
    const coord = (await this.steps(orgId, info.run.id)).find((s) => s.current && s.nodeId === `${STAGE_NODE}${info.stage.id}`);
    if (!coord?.taskId) throw new BadRequestException('the stage has no coordinator task yet');
    await this.tasks.update(orgId, coord.taskId, { status: 'done' }, actor);
    await this.log(orgId, info.run.processId, info.run.id, coord.nodeId, 'stage_finished', actor);
    await this.settle();
    return this.run(orgId, info.run.id);
  }

  private async nudgeCoordinator(orgId: string, run: OrgProcessRun, def: ProcessDef, stage: ProcessStage, what: string): Promise<void> {
    const coord = (await this.steps(orgId, run.id)).find((s) => s.current && s.nodeId === `${STAGE_NODE}${stage.id}`);
    if (!coord?.taskId) return;
    const states = this.states(this.currentMap(await this.steps(orgId, run.id)));
    const vars = parse<Record<string, string>>(run.vars, {});
    const avail = dynamicAvailable(def, stage.id, states, vars);
    const missing = missingCheckpoints(def, stage.id, states);
    const text = `${what} ${avail.length ? `Available next: ${avail.map((n) => `${n.id}${n.required ? ' (checkpoint)' : ''}`).join(', ')} — org_step_choose.` : 'No defined step is available.'} ${missing.length ? `Checkpoints left: ${missing.map((n) => n.id).join(', ')}.` : 'Every checkpoint is done: finish the stage with org_process_next finish=true.'}`;
    await this.tasks.comment(orgId, coord.taskId, { text, fromAgentId: null, wake: true, system: true }).catch(() => undefined);
  }

  // ---- outputs, deviations and the MUST gate ----

  /** Record a step output on the step a task performs. */
  async setOutput(orgId: string, taskId: string, name: string, value: string, actor: string): Promise<{ step: OrgProcessStep; declared: boolean }> {
    const step = await this.stepOfTask(orgId, taskId);
    if (!step || step.status !== 'active') throw new BadRequestException('this task is not an open process step');
    const key = name.trim();
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(key)) throw new BadRequestException('the output name is a snake_case variable, e.g. "release_notes"');
    const run = await this.run(orgId, step.runId);
    const node = this.nodeOf(await this.runDef(orgId, run), step);
    const outputs = { ...parse<Record<string, string>>(step.outputs, {}), [key]: String(value ?? '').slice(0, 2_000) };
    await this.db.update(orgProcessSteps).set({ outputs: JSON.stringify(outputs) }).where(eq(orgProcessSteps.id, step.id));
    await this.log(orgId, run.processId, run.id, step.nodeId, 'output', actor, { name: key });
    return { step: { ...step, outputs: JSON.stringify(outputs) }, declared: Boolean(node?.outputs?.some((o) => o.name === key)) };
  }

  private async recordDeviation(orgId: string, run: OrgProcessRun, step: OrgProcessStep, d: Deviation): Promise<void> {
    const fresh = (await this.steps(orgId, run.id)).find((s) => s.id === step.id) ?? step;
    const list = [...parse<Deviation[]>(fresh.deviations, []), d].slice(-20);
    await this.db.update(orgProcessSteps).set({ deviations: JSON.stringify(list) }).where(eq(orgProcessSteps.id, step.id));
    await this.log(orgId, run.processId, run.id, step.nodeId, 'deviated', d.by, { level: d.level, item: d.item, reason: d.reason.slice(0, 300), alternative: d.alternative.slice(0, 300), status: d.status });
  }

  /**
   * Deviate from the step card: SHOULD (or MAY) is logged and the run goes
   * on; MUST becomes a `process_deviation` card for the performer's manager
   * (the owner of the standard in its line) — approved, the item is waived.
   * `item` is a checklist id (s2), its text, or `step:<id>` for a dynamic
   * stage's checkpoint.
   */
  async deviate(orgId: string, taskId: string, input: { level: 'should' | 'must' | 'may'; item: string; reason: string; alternative?: string }, actor: string): Promise<{ status: Deviation['status']; approvalId: string | null; note: string }> {
    const task = await this.tasks.get(orgId, taskId);
    const step = await this.stepOfTask(orgId, taskId);
    if (!step) throw new BadRequestException(`${taskRef(task)} is not a process step`);
    const reason = (input.reason ?? '').trim();
    if (!reason) throw new BadRequestException('reason is required: why the item does not fit this run');
    const run = await this.run(orgId, step.runId);
    const p = await this.get(orgId, run.processId);
    const itemRef = (input.item ?? '').trim();
    const checklist = parseSteps(task.steps);
    const hit = itemRef.startsWith('step:') ? null : checklist.find((x) => x.id === itemRef.toLowerCase() || x.text.toLowerCase() === itemRef.toLowerCase());
    if (!itemRef.startsWith('step:') && !hit) throw new BadRequestException(`no item "${itemRef}" on ${taskRef(task)} — items: ${checklist.map((x) => `${x.id} ${x.text.slice(0, 40)}`).join('; ')}`);
    const level = input.level === 'must' || hit?.from === 'process:must' || itemRef.startsWith('step:') ? 'must' : 'should';
    const d: Deviation = { level, item: hit ? hit.id : itemRef, reason: reason.slice(0, 600), alternative: (input.alternative ?? '').slice(0, 600), status: 'logged', by: actor, at: nowIso() };
    if (level === 'should') {
      await this.recordDeviation(orgId, run, step, d);
      if (hit && !hit.done) await this.tasks.step(orgId, taskId, { drop: hit.id }, actor).catch(() => undefined);
      return { status: 'logged', approvalId: null, note: `logged: SHOULD item ${d.item} skipped — ${reason}. The run goes on; the owner sees the deviation in the process's metrics.` };
    }
    const already = parse<Deviation[]>(step.deviations, []).find((x) => x.level === 'must' && x.item === d.item && (x.status === 'pending' || x.status === 'approved'));
    if (already) return { status: already.status, approvalId: already.approvalId ?? null, note: already.status === 'approved' ? `item ${d.item} is already waived` : `a waiver for ${d.item} is already waiting (card ${already.approvalId?.slice(0, 8)})` };
    const performer = task.assigneeAgentId ?? (actor.startsWith('agent:') ? actor.slice(6) : null);
    const card = await this.approvals.create(orgId, {
      kind: 'process_deviation', requestedBy: performer ? `agent:${performer}` : actor,
      payload: { runId: run.id, stepId: step.id, taskId, runKey: run.key, processTitle: p.title, item: hit?.text ?? itemRef, itemId: d.item, reason: d.reason, alternative: d.alternative, agentId: performer ?? undefined },
      recommendation: `${d.reason}${d.alternative ? ` — instead: ${d.alternative}` : ''}`.slice(0, 600),
    });
    await this.recordDeviation(orgId, run, step, { ...d, status: 'pending', approvalId: card.id });
    return { status: 'pending', approvalId: card.id, note: `a MUST item is waived only by the owner of the standard: card ${card.id.slice(0, 8)} is with your manager. Work on what you can meanwhile; you are woken when it is decided.` };
  }

  private async deviationDecided(orgId: string, a: OrgApproval, payload: Record<string, unknown>, decision: 'approve' | 'reject' | 'revise', note: string): Promise<Record<string, unknown>> {
    const runId = String(payload.runId ?? '');
    const stepId = String(payload.stepId ?? '');
    const itemId = String(payload.itemId ?? '');
    const status: Deviation['status'] = decision === 'approve' ? 'approved' : 'rejected';
    const step = (await this.steps(orgId, runId)).find((s) => s.id === stepId);
    if (!step) return { runId };
    const list = parse<Deviation[]>(step.deviations, []).map((d) => (d.approvalId === a.id ? { ...d, status } : d));
    await this.db.update(orgProcessSteps).set({ deviations: JSON.stringify(list) }).where(eq(orgProcessSteps.id, step.id));
    const run = await this.run(orgId, runId);
    await this.log(orgId, run.processId, run.id, step.nodeId, status === 'approved' ? 'deviation_approved' : 'deviation_rejected', `approval:${a.id}`, { item: itemId, note });
    const taskId = typeof payload.taskId === 'string' ? payload.taskId : '';
    if (status === 'approved' && taskId && !itemId.startsWith('step:')) await this.tasks.step(orgId, taskId, { drop: itemId }, `approval:${a.id}`).catch(() => undefined);
    if (status === 'rejected' && taskId) await this.tasks.comment(orgId, taskId, { text: `The waiver of MUST item ${itemId} was not granted${note ? `: ${note}` : ''}. Meet it, or escalate if it cannot be met.`, fromAgentId: null, wake: false, system: true }).catch(() => undefined);
    return { runId, item: itemId, status };
  }

  /** The submit gate (OrgTasksService.requestReview): open MUST items and missing required outputs. */
  private async submitGate(orgId: string, task: OrgTask): Promise<string | null> {
    if (!task.processRunId) return null;
    const step = await this.stepOfTask(orgId, task.id);
    if (!step || step.status !== 'active') return null;
    const run = await this.run(orgId, step.runId).catch(() => null);
    if (!run) return null;
    const p = await this.get(orgId, run.processId);
    if (isCoordinator(step.nodeId)) return `refused: ${taskRef(task)} coordinates the stage "${step.stage}" of ${p.title} (${run.key}); it is not reviewed. Choose the next step with org_step_choose, and close the stage with org_process_next finish=true once its checkpoints are done.`;
    const def = await this.runDef(orgId, run);
    const node = this.nodeOf(def, step);
    const waived = new Set(parse<Deviation[]>(step.deviations, []).filter((d) => d.level === 'must' && d.status === 'approved').map((d) => d.item));
    const open = parseSteps(task.steps).filter((x) => x.from === 'process:must' && !waived.has(x.id) && (!x.done || x.dropped));
    const outputs = parse<Record<string, string>>(step.outputs, {});
    const missing = (node?.outputs ?? []).filter((o) => o.required && !outputs[o.name]);
    if (!open.length && !missing.length) return null;
    const org = await this.org.get(orgId);
    const lines = [
      ...open.map((x) => `- ${x.id}. ${x.text} — ${x.dropped ? 'it was dropped, but a MUST item is waived only by the process owner' : `tick it with org_task_steps done=${x.id} once it is true`}`),
      ...missing.map((o) => `- output "${o.name}" (required${o.description ? `: ${o.description}` : ''}) is not recorded — org_step_output {name: "${o.name}", value: …}`),
    ];
    if (processTunable(org, 'process.mustEnforcement') < 1) {
      await this.recordDeviation(orgId, run, step, { level: 'must', item: open.map((x) => x.id).concat(missing.map((o) => `output:${o.name}`)).join(','), reason: 'handed to review with MUST items open', alternative: '', status: 'logged', by: task.assigneeAgentId ? `agent:${task.assigneeAgentId}` : 'user', at: nowIso() });
      return null;
    }
    return [`refused: step "${node?.title ?? step.nodeId}" of ${p.title} v${run.version} (${run.key}) has MUST item(s) not met:`, ...lines, 'If one cannot be met in this run, ask for a waiver: org_process_deviate {level: "must", item: "<id>", reason, alternative}.'].join('\n');
  }

  /** Tools a process step denies, for the task a session runs (60 s cache). */
  private readonly denyCache = new Map<string, { at: number; deny: string[]; label: string }>();
  async deniedTools(orgId: string, taskId: string): Promise<{ deny: string[]; label: string }> {
    const hit = this.denyCache.get(taskId);
    if (hit && Date.now() - hit.at < 60_000) return hit;
    let out = { deny: [] as string[], label: '' };
    const step = await this.stepOfTask(orgId, taskId).catch(() => null);
    if (step && step.status === 'active') {
      const run = await this.run(orgId, step.runId).catch(() => null);
      const node = run ? this.nodeOf(await this.runDef(orgId, run), step) : null;
      if (node?.deny?.length && run) out = { deny: node.deny, label: `step "${node.title}" of run ${run.key}` };
    }
    this.denyCache.set(taskId, { at: Date.now(), ...out });
    return out;
  }

  // ---- the step card ----

  /** The step card for a task that performs a process step, or null. */
  async stepCardFor(orgId: string, taskId: string): Promise<string | null> {
    const task = await this.tasks.get(orgId, taskId).catch(() => null);
    if (!task?.processRunId) return null;
    const step = await this.stepOfTask(orgId, taskId);
    if (!step) return null;
    const run = await this.run(orgId, step.runId);
    const p = await this.get(orgId, run.processId);
    const def = await this.runDef(orgId, run);
    const stageIdx = Math.max(0, def.stages.findIndex((s) => s.id === step.stage));
    const stage = def.stages[stageIdx];
    if (isCoordinator(step.nodeId)) {
      const info = await this.nextFor(orgId, run.id);
      return [
        `## Process stage — ${p.title} v${run.version} · run ${run.key}`,
        `Stage ${stageIdx + 1}/${def.stages.length} "${stage.title}" is dynamic: you choose the next step. org_step_choose {run: "${run.key}", step: "<id>"} starts one as its own task (assign it with assignee when its lane is someone else's); skip optional ones; an ad-hoc step (adHoc: {title, outcome, doneWhen}) is allowed but logged.`,
        info.available.length ? `Available now:\n${info.available.map((n) => `- ${n.id}: ${n.title}${n.required ? ' (checkpoint — required)' : ''}${n.why ? ` — ${n.why}` : ''}`).join('\n')}` : 'No defined step is available now.',
        info.active.length ? `Under way: ${info.active.map((a) => `${a.title}${a.taskKey ? ` (${a.taskKey})` : ''}`).join('; ')}` : '',
        info.done.length ? `Done: ${info.done.join(', ')}` : '',
        info.missing.length ? `Checkpoints left: ${info.missing.map((n) => n.id).join(', ')} — the stage cannot finish without them.` : 'Every checkpoint is done: finish the stage with org_process_next {run, finish: true}.',
        'This task is not handed to review; it closes when you finish the stage.',
      ].filter(Boolean).join('\n');
    }
    const node = this.nodeOf(def, step);
    if (!node) return null;
    const steps = await this.steps(orgId, run.id);
    const vars = parse<Record<string, string>>(run.vars, {});
    const inputs: Array<{ name: string; value: string; from: string }> = [];
    const done = steps.filter((x) => x.current && x.status === 'done' && x.id !== step.id);
    // Evidence-gated claims (docs/evidence.md): an output nothing verified reaches later steps flagged.
    const flags = await this.tasks.evidence?.flags(orgId, 'step_output', done.flatMap((s) => Object.keys(parse<Record<string, string>>(s.outputs, {})).map((k) => `${s.id}:${k}`))).catch(() => null);
    for (const s of done) {
      const n = this.nodeOf(def, s);
      for (const [k, v] of Object.entries(parse<Record<string, string>>(s.outputs, {}))) inputs.push({ name: k, value: flags?.has(`${s.id}:${k}`) ? `${v} ${claimTag(flags.get(`${s.id}:${k}`))}` : v, from: n?.title ?? s.nodeId });
    }
    for (const [k, v] of Object.entries(vars)) if (!inputs.some((x) => x.name === k) && !def.nodes.some((n) => n.id.replace(/-/g, '_') === k)) inputs.push({ name: k, value: v, from: 'the run\'s start' });
    const waived = new Set(parse<Deviation[]>(step.deviations, []).filter((d) => d.status === 'approved').map((d) => d.item));
    const items: CardItem[] = parseSteps(task.steps).filter((x) => x.from?.startsWith('process:')).map((x) => ({ id: x.id, text: x.text, level: x.from!.slice(8) as CardItem['level'], done: x.done && !x.dropped, waived: waived.has(x.id) || (x.dropped && x.from !== 'process:must') }));
    const outputs = parse<Record<string, string>>(step.outputs, {});
    const inStage = nodesOf(def, stage.id);
    const org = await this.org.get(orgId);
    return stepCard({
      processTitle: p.title, version: run.version, runKey: run.key, runTitle: run.title, stage, stageIndex: stageIdx, stageCount: def.stages.length,
      node: { ...node, doneWhen: fill(node.doneWhen, vars) }, stepNumber: Math.max(1, inStage.findIndex((n) => n.id === node.id) + 1), stepCount: Math.max(1, inStage.length),
      inputs, items, outputs: (node.outputs ?? []).map((o) => ({ name: o.name, required: Boolean(o.required), value: outputs[o.name], description: o.description })),
      mustBlocks: processTunable(org, 'process.mustEnforcement') >= 1,
    });
  }

  // ---- metrics ----

  async metrics(orgId: string, processId: string, opts: { markReviewed?: string } = {}): Promise<ProcessMetrics> {
    const org = await this.org.get(orgId);
    const window = processTunable(org, 'process.metricsWindowRuns');
    const runs = (await this.runs(orgId, { processId, limit: window }));
    const steps = runs.length ? await this.db.select().from(orgProcessSteps).where(and(eq(orgProcessSteps.orgId, orgId), inArray(orgProcessSteps.runId, runs.map((r) => r.id)))) : [];
    const taskIds = steps.map((s) => s.taskId).filter((x): x is string => Boolean(x));
    const rounds = new Map<string, number>();
    if (taskIds.length) for (const t of await this.db.select({ id: orgTasks.id, reviewRounds: orgTasks.reviewRounds }).from(orgTasks).where(inArray(orgTasks.id, taskIds))) rounds.set(t.id, t.reviewRounds);
    const m = computeMetrics(runs, steps.filter((s) => !isCoordinator(s.nodeId)).map((s) => ({
      nodeId: s.nodeId.startsWith(ADHOC) ? 'ad-hoc' : s.nodeId, status: s.status, attempt: s.attempt, deviations: parse<Deviation[]>(s.deviations, []).length,
      reviewRounds: s.taskId ? rounds.get(s.taskId) ?? 0 : 0, slaBreached: Boolean(s.slaBreachedAt), startedAt: s.startedAt, endedAt: s.endedAt,
    })), { reviseDeviationRate: processTunable(org, 'process.reviseDeviationRate') });
    if (opts.markReviewed) {
      await this.db.update(orgProcesses).set({ reviewedAt: nowIso() }).where(eq(orgProcesses.id, processId));
      await this.log(orgId, processId, '', '', 'reviewed', opts.markReviewed, { health: m.health });
    }
    return m;
  }

  /** Every process with its owner, mode, version and metrics (the list and the tools). */
  async overview(orgId: string, opts: { includeRetired?: boolean } = {}): Promise<Array<OrgProcess & { mode: string; ownerAgentId: string | null; ownerName: string; unitName: string; triggers: ProcessDef['triggers']; metrics: ProcessMetrics; reviewDue: boolean; pendingVersion: number | null }>> {
    const org = await this.org.get(orgId);
    const names = new Map((await this.agents.list()).map((a) => [a.id, a.name]));
    const days = processTunable(org, 'process.reviewCadenceDays');
    const out = [];
    for (const p of await this.list(orgId, opts)) {
      const def = await this.activeDef(orgId, p).catch(() => null);
      const pendingRow = (await this.versions(orgId, p.id)).find((v) => v.status === 'pending');
      const owner = def ? await this.ownerFor(org, p, def) : org.chiefOfStaffAgentId;
      const unit = p.unitId && this.units ? await this.units.get(orgId, p.unitId).catch(() => null) : null;
      const metrics = await this.metrics(orgId, p.id);
      const reviewDue = p.status === 'active' && metrics.runs > 0 && (!p.reviewedAt || Date.now() - Date.parse(p.reviewedAt) > days * 86_400_000);
      out.push({ ...p, mode: def ? modeOf(def) : 'strict', ownerAgentId: owner, ownerName: owner ? names.get(owner) ?? 'member' : 'the CEO', unitName: unit?.name ?? 'Company', triggers: def?.triggers ?? [], metrics, reviewDue, pendingVersion: pendingRow?.version ?? null });
    }
    return out;
  }

  /** One process for the detail page: definition, versions with diffs, runs with their steps. */
  async detail(orgId: string, ref: string): Promise<Record<string, unknown>> {
    const p = await this.get(orgId, ref);
    const all = await this.overview(orgId, { includeRetired: true });
    const head = all.find((x) => x.id === p.id)!;
    const def = await this.activeDef(orgId, p);
    const versions = await this.versions(orgId, p.id);
    const runs = await this.runs(orgId, { processId: p.id, limit: 30 });
    const runRows = [];
    for (const r of runs) {
      const steps = await this.steps(orgId, r.id);
      const rdef = await this.runDef(orgId, r).catch(() => def);
      const stepRows = [];
      for (const s of steps) {
        const t = s.taskId ? await this.tasks.get(orgId, s.taskId).catch(() => null) : null;
        stepRows.push({ ...s, title: isCoordinator(s.nodeId) ? `Stage ${s.stage}: choose the steps` : (rdef ? this.nodeOf(rdef, s)?.title : null) ?? s.nodeId, taskKey: t ? taskRef(t) : null, taskStatus: t?.status ?? null, assigneeAgentId: t?.assigneeAgentId ?? null, outputs: parse(s.outputs, {}), deviations: parse(s.deviations, []) });
      }
      runRows.push({ ...r, vars: parse(r.vars, {}), trigger: parse(r.trigger, {}), steps: stepRows });
    }
    return {
      process: head, def, versions: versions.map((v) => ({ ...v, def: parse(v.def, {}), diff: parse<string[]>(v.diff, []) })), runs: runRows,
      events: (await this.events(orgId, { processId: p.id, limit: 80 })).map((e) => ({ ...e, detail: parse(e.detail, {}) })),
    };
  }

  /** Lines for the chief's and the heads' context: processes to revise or review. */
  async attentionFor(orgId: string, agentId: string): Promise<string[]> {
    const org = await this.org.get(orgId);
    const mine = (await this.overview(orgId)).filter((p) => p.ownerAgentId === agentId || agentId === org.chiefOfStaffAgentId);
    const out: string[] = [];
    for (const p of mine) {
      if (p.metrics.health === 'revise') out.push(`${p.name} (${p.title}) needs revising: ${p.metrics.why}`);
      else if (p.reviewDue) out.push(`${p.name} (${p.title}): review due — ${p.metrics.runs} run(s), ${p.metrics.completionRate === null ? 'none finished' : `${Math.round(p.metrics.completionRate * 100)}% completed`} (org_process_metrics)`);
      if (p.pendingVersion) out.push(`${p.name}: v${p.pendingVersion} waits for approval`);
    }
    return out.slice(0, 6);
  }
}
