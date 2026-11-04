/**
 * OrgSignalsService — the model-free observer (docs/company-vision.md §5.1,
 * execution-plan item 20).
 *
 * Every few minutes `sweep()` reads the board, the runs, the envelopes, the
 * audit log and the chart and computes the conditions a well-run company
 * would notice without anyone being asked: stale tasks, blocked tasks with
 * no owner, a review queue that is ageing, a burn rate that projects past
 * the envelope, breaker trips, charter drift, and org debt (§4: idle and
 * overloaded members, a lead with one report, a unit with no goal, a goal
 * with no owner or unit, duplicate titles). Each condition is a *signal*
 * addressed to the party that can act on it:
 *
 *   owner → an inbox event on the task's owner
 *   lead  → an inbox event on the unit lead
 *   chief → an OrgBoard event (the autonomous chief's review runs with the
 *           signal as its reason) plus an inbox event on the chief
 *   ceo   → an inbox event on the chief pushed to the CEO's channels, and a
 *           line in the brief (OrgBriefService reads open signals)
 *
 * Signals are deduplicated per (kind, refId, day) by a unique index: a
 * condition fires once a day and stays open while it holds; when the sweep
 * no longer sees it the signal is resolved automatically. `ack()` and
 * `resolve()` are the manual paths (API and the `org_ack_signal` tool).
 * Other services open signals through `open()` — the SLO breach and the
 * auditor's findings — and get the same dedup and routing. No model is ever
 * called here; everything is audited.
 */
import { Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { orgSignals } from '../database/schema';
import { newId, nowIso } from '../common/ids.util';
import { currentAccountId } from '../accounts/account-context';
import { AgentsService } from '../agents/agents.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { deliveryFor } from '../workspaces/quiet-hours';
import { TriggerBus } from '../chats/trigger-bus';
import { OrgService, Organization } from './org.service';
import { OrgTasksService } from './org-tasks.service';
import { OrgAuditService } from './org-audit.service';
import { OrgUnitsService } from './org-units.service';
import { assuranceTunable } from './org-assurance-tunables';

export type OrgSignal = typeof orgSignals.$inferSelect;
export type SignalSeverity = 'info' | 'warn' | 'critical';
export type SignalAddressee = 'owner' | 'lead' | 'chief' | 'ceo';

export const SIGNAL_SEVERITIES: readonly SignalSeverity[] = ['info', 'warn', 'critical'];

/** The kinds the sweep computes; `slo_breach`, `audit_finding` and
 *  `burn_forecast` are opened by OrgSloService, OrgAuditorService and
 *  OrgCapitalService through `open()`. */
export const SIGNAL_KINDS = [
  'stale_task', 'blocked_unowned', 'review_age', 'burn_rate', 'breaker_trip', 'charter_drift',
  'idle_member', 'overloaded_member', 'thin_unit', 'unit_no_goal', 'goal_unowned', 'duplicate_title',
  'slo_breach', 'audit_finding', 'burn_forecast',
  // Sensing (docs/sensing.md §1.5): opened and resolved by OrgSensingService.
  'metric_stale',
  // Reconciliation (docs/experiments.md §3): opened by OrgReconciliationService.
  'overclaim', 'claim_mismatch', 'report_drift',
] as const;
export type SignalKind = typeof SIGNAL_KINDS[number];

export interface SignalInput {
  kind: SignalKind | string;
  severity: SignalSeverity;
  refType: string;
  refId: string;
  title: string;
  detail?: string;
  addressee: SignalAddressee;
  /** The agent the addressee resolves to (owner/lead); chief and ceo are resolved from the org. */
  addresseeId?: string;
  unitId?: string | null;
}

/** Thresholds (hours / counts) the sweep uses — per-org tunables
 *  (`signals.*`, docs/company-vision.md §1b) read through `thresholdsOf`. */
export interface SignalThresholds {
  staleTaskHours: number;
  reviewAgeHours: number;
  idleMemberDays: number;
  overloadedOpenTasks: number;
  burnWarnPct: number;
  burnCriticalPct: number;
}

/** A module's own conditions (OrgProgramService: the matrix), computed with
 *  the sweep and resolved by it like the built-in kinds. */
export interface SignalSource { kinds: readonly string[]; compute(org: Organization, now: Date): Promise<SignalInput[]> }

const DAY_MS = 24 * 60 * 60_000;
const OPEN_STATES = ['todo', 'claimed', 'in_progress', 'in_review'];

@Injectable()
export class OrgSignalsService {
  private readonly logger = new Logger(OrgSignalsService.name);
  private readonly sources: SignalSource[] = [];

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly org: OrgService,
    private readonly tasks: OrgTasksService,
    private readonly audit: OrgAuditService,
    private readonly agents: AgentsService,
    private readonly workspaces: WorkspacesService,
    @Optional() private readonly bus?: TriggerBus,
    @Optional() private readonly units?: OrgUnitsService,
  ) {}

  /** Register a module's conditions (its kinds are swept and auto-resolved). */
  addSource(src: SignalSource): void { this.sources.push(src); }

  // ---- reads ----

  async list(orgId: string, opts: { status?: string; severity?: string; unitId?: string; addresseeId?: string; kind?: string; limit?: number } = {}): Promise<OrgSignal[]> {
    const rows = await this.db.select().from(orgSignals).where(eq(orgSignals.orgId, orgId)).orderBy(desc(orgSignals.createdAt)).limit(2_000);
    const rank: Record<string, number> = { critical: 0, warn: 1, info: 2 };
    return rows
      .filter((s) => (!opts.status || s.status === opts.status) && (!opts.severity || s.severity === opts.severity) && (!opts.unitId || s.unitId === opts.unitId) && (!opts.addresseeId || s.addresseeId === opts.addresseeId) && (!opts.kind || s.kind === opts.kind))
      .sort((a, b) => (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3) || (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, Math.min(2_000, Math.max(1, opts.limit ?? 500)));
  }

  async get(orgId: string, id: string): Promise<OrgSignal> {
    const s = (await this.db.select().from(orgSignals).where(and(eq(orgSignals.orgId, orgId), eq(orgSignals.id, id))).limit(1)).at(0);
    if (!s) throw new NotFoundException(`signal ${id}`);
    return s;
  }

  /** Open signals as a member may see them: the chief sees all; a unit lead
   *  its unit's and its own; anyone else only those addressed to it. */
  async visibleTo(orgId: string, agentId: string, opts: { severity?: string; unitId?: string } = {}): Promise<OrgSignal[]> {
    const org = await this.org.get(orgId);
    const open = (await this.list(orgId, { severity: opts.severity, unitId: opts.unitId })).filter((s) => s.status !== 'resolved');
    if (org.chiefOfStaffAgentId === agentId) return open;
    const lead = this.units ? await this.units.isLead(orgId, agentId) : null;
    if (lead) {
      const scope = new Set(await this.units!.subtree(orgId, lead.id));
      return open.filter((s) => s.addresseeId === agentId || (s.unitId && scope.has(s.unitId)));
    }
    return open.filter((s) => s.addresseeId === agentId);
  }

  // ---- writes ----

  /** Open a signal unless one for (kind, refId) is already open or already
   *  fired today. Returns the row and whether it was created now. */
  async open(orgId: string, input: SignalInput, now = new Date()): Promise<{ signal: OrgSignal; created: boolean }> {
    const org = await this.org.get(orgId);
    const dayKey = now.toISOString().slice(0, 10);
    const existing = (await this.db.select().from(orgSignals).where(and(eq(orgSignals.orgId, orgId), eq(orgSignals.kind, input.kind), eq(orgSignals.refId, input.refId))))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    const live = existing.find((s) => s.status !== 'resolved');
    if (live) return { signal: live, created: false };
    const today = existing.find((s) => s.dayKey === dayKey);
    if (today) return { signal: today, created: false };
    const addresseeId = input.addressee === 'chief' || input.addressee === 'ceo' ? org.chiefOfStaffAgentId ?? '' : input.addresseeId ?? org.chiefOfStaffAgentId ?? '';
    const row: OrgSignal = {
      id: newId(), accountId: currentAccountId(), orgId, unitId: input.unitId ?? null,
      kind: input.kind, severity: input.severity, refType: input.refType, refId: input.refId,
      title: input.title.slice(0, 200), detail: (input.detail ?? '').slice(0, 2_000),
      addresseeKind: input.addressee, addresseeId, dayKey, status: 'open', ackNote: '', ackedAt: null, resolvedAt: null, createdAt: nowIso(),
    };
    try {
      await this.db.insert(orgSignals).values(row);
    } catch {
      // The unique index won the race: another sweep fired it this day.
      const again = (await this.db.select().from(orgSignals).where(and(eq(orgSignals.orgId, orgId), eq(orgSignals.kind, input.kind), eq(orgSignals.refId, input.refId), eq(orgSignals.dayKey, dayKey))).limit(1)).at(0);
      if (again) return { signal: again, created: false };
      throw new Error('signal insert failed');
    }
    await this.audit.append(orgId, { actor: 'system', action: 'signal_open', refType: 'signal', refId: row.id, payload: { kind: row.kind, severity: row.severity, refType: row.refType, refId: row.refId, addressee: row.addresseeKind, addresseeId } });
    await this.route(org, row).catch((err) => this.logger.warn(`signal routing failed: ${err instanceof Error ? err.message : err}`));
    return { signal: row, created: true };
  }

  async ack(orgId: string, id: string, note = '', actor = 'user'): Promise<OrgSignal> {
    const s = await this.get(orgId, id);
    if (s.status === 'resolved') return s;
    await this.db.update(orgSignals).set({ status: 'acked', ackNote: note.slice(0, 500), ackedAt: nowIso() }).where(eq(orgSignals.id, id));
    await this.audit.append(orgId, { actor, action: 'signal_ack', refType: 'signal', refId: id, payload: { kind: s.kind, note: note.slice(0, 200) } });
    return this.get(orgId, id);
  }

  async resolve(orgId: string, id: string, actor = 'user'): Promise<OrgSignal> {
    const s = await this.get(orgId, id);
    if (s.status === 'resolved') return s;
    await this.db.update(orgSignals).set({ status: 'resolved', resolvedAt: nowIso() }).where(eq(orgSignals.id, id));
    await this.audit.append(orgId, { actor, action: 'signal_resolve', refType: 'signal', refId: id, payload: { kind: s.kind, by: actor } });
    return this.get(orgId, id);
  }

  // ---- the sweep ----

  /** Compute every condition, open what is new, resolve what cleared.
   *  Returns the counts. Never throws for one bad org. */
  async sweep(orgId: string, now = new Date()): Promise<{ opened: number; resolved: number; live: number }> {
    const org = await this.org.get(orgId);
    const wanted = await this.compute(org, now);
    let opened = 0;
    const keys = new Set<string>();
    for (const w of wanted) {
      keys.add(`${w.kind}:${w.refId}`);
      const r = await this.open(orgId, w, now);
      if (r.created) opened++;
    }
    // Auto-resolve: an open (or acked) sweep-owned signal whose condition is gone.
    let resolved = 0;
    const sweepKinds = new Set<string>([...SIGNAL_KINDS.filter((k) => !['slo_breach', 'audit_finding', 'burn_forecast'].includes(k)), ...this.sources.flatMap((x) => x.kinds)]);
    for (const s of (await this.list(orgId)).filter((x) => x.status !== 'resolved' && sweepKinds.has(x.kind))) {
      if (keys.has(`${s.kind}:${s.refId}`)) continue;
      await this.db.update(orgSignals).set({ status: 'resolved', resolvedAt: nowIso() }).where(eq(orgSignals.id, s.id));
      await this.audit.append(orgId, { actor: 'system', action: 'signal_resolve', refType: 'signal', refId: s.id, payload: { kind: s.kind, by: 'sweep' } });
      resolved++;
    }
    return { opened, resolved, live: keys.size };
  }

  /** The conditions, as the signals they would be. Pure reads. */
  async compute(org: Organization, now = new Date()): Promise<SignalInput[]> {
    const out: SignalInput[] = [];
    const t = thresholdsOf(org);
    const nowMs = now.getTime();
    const hoursAgo = (iso: string | null | undefined) => (iso ? (nowMs - new Date(iso).getTime()) / 3_600_000 : Infinity);
    const members = (await this.org.members(org.id)).filter((m) => m.status !== 'terminated');
    const active = members.filter((m) => m.status === 'active');
    const names = new Map((await this.agents.list()).map((a) => [a.id, a.name]));
    const nm = (id: string | null | undefined) => (id ? names.get(id) ?? id.slice(0, 8) : 'nobody');
    const tasks = await this.tasks.list(org.id);
    const chiefId = org.chiefOfStaffAgentId;
    const unitOf = async (agentId: string | null | undefined) => (this.units ? await this.units.unitForAssignee(org.id, agentId).catch(() => null) : null);

    // 1. stale tasks: claimed / in progress with no run in staleTaskHours → owner
    for (const task of tasks.filter((x) => ['claimed', 'in_progress'].includes(x.status) && x.assigneeAgentId)) {
      const last = task.lastRunAt ?? task.updatedAt;
      if (hoursAgo(last) < t.staleTaskHours) continue;
      out.push({ kind: 'stale_task', severity: 'warn', refType: 'task', refId: task.id, title: `Stale: "${task.title}" has had no run in ${Math.floor(hoursAgo(last))}h`, detail: `Owner ${nm(task.assigneeAgentId)}; status ${task.status}. Continue it, set it blocked with the blocker named, or hand it back.`, addressee: 'owner', addresseeId: task.assigneeAgentId!, unitId: task.unitId });
    }
    // 2. blocked without an owner → chief
    for (const task of tasks.filter((x) => x.status === 'blocked' && !x.assigneeAgentId)) {
      out.push({ kind: 'blocked_unowned', severity: 'warn', refType: 'task', refId: task.id, title: `Blocked and unowned: "${task.title}"`, detail: lastOf(task.blockers), addressee: 'chief', unitId: task.unitId });
    }
    // 3. review queue age → the reviewer when set, else the chief
    for (const task of tasks.filter((x) => x.status === 'in_review' && hoursAgo(x.updatedAt) >= t.reviewAgeHours)) {
      out.push({ kind: 'review_age', severity: 'warn', refType: 'task', refId: task.id, title: `Review waiting ${Math.floor(hoursAgo(task.updatedAt))}h: "${task.title}"`, detail: `Reviewer ${nm(task.reviewerAgentId)}.`, addressee: task.reviewerAgentId ? 'owner' : 'chief', addresseeId: task.reviewerAgentId ?? undefined, unitId: task.unitId });
    }
    // 4. burn rate vs envelope: projected month-end > envelope → chief (warn), CEO (critical)
    const ws = await this.workspaces.get(org.workspaceId).catch(() => null);
    const envelope = ws?.orgMonthlyUsd ?? org.monthlyBudgetUsd;
    if (envelope > 0) {
      const month = now.toISOString().slice(0, 7);
      const spent = (await this.tasks.runs(org.id, { limit: 500 })).filter((r) => r.startedAt.slice(0, 7) === month).reduce((a, r) => a + r.usd, 0);
      const day = now.getUTCDate();
      const days = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
      const projected = (spent / Math.max(1, day)) * days;
      const pct = (projected / envelope) * 100;
      if (pct >= t.burnWarnPct) {
        const critical = pct >= t.burnCriticalPct;
        out.push({ kind: 'burn_rate', severity: critical ? 'critical' : 'warn', refType: 'org', refId: `${org.id}:${month}`, title: `Burn rate projects $${projected.toFixed(2)} by month-end against a $${envelope.toFixed(2)} envelope (${Math.round(pct)}%)`, detail: `$${spent.toFixed(2)} spent in ${day} day(s). Lower envelopes, pause work, or raise the company envelope.`, addressee: critical ? 'ceo' : 'chief' });
      }
    }
    // 5. breaker trips in the last 24h: run_end with outcome loop / no_progress → chief, one per task per day
    const since = new Date(nowMs - DAY_MS).toISOString();
    const trips = new Map<string, { loop: number; noProgress: number }>();
    for (const r of (await this.audit.list(org.id, { action: 'run_end', limit: 300 })).filter((x) => x.createdAt >= since)) {
      const p = parse<{ taskId?: string; outcome?: string }>(r.payload);
      if (!p.taskId || !['loop', 'no_progress'].includes(p.outcome ?? '')) continue;
      const cur = trips.get(p.taskId) ?? { loop: 0, noProgress: 0 };
      if (p.outcome === 'loop') cur.loop++; else cur.noProgress++;
      trips.set(p.taskId, cur);
    }
    for (const [taskId, c] of trips) {
      const task = tasks.find((x) => x.id === taskId);
      if (!task || ['done', 'cancelled'].includes(task.status)) continue;
      if (c.loop === 0 && c.noProgress < 2) continue;
      out.push({ kind: 'breaker_trip', severity: c.loop > 0 ? 'critical' : 'warn', refType: 'task', refId: taskId, title: `Breaker: "${task.title}" — ${c.loop ? `${c.loop} loop stop(s)` : ''}${c.loop && c.noProgress ? ', ' : ''}${c.noProgress ? `${c.noProgress} no-progress run(s)` : ''} in 24h`, detail: `Owner ${nm(task.assigneeAgentId)}. Rebrief, reassign or cancel.`, addressee: 'chief', unitId: task.unitId });
    }
    // 6. charter drift → CEO (only the CEO accepts a charter)
    for (const d of await this.org.checkCharters(org.id)) {
      out.push({ kind: 'charter_drift', severity: 'warn', refType: 'agent', refId: d.agentId, title: `Charter of ${d.name} changed outside the org path`, detail: 'Accept it in the org chart or restore it; until then the recorded charter is not what runs.', addressee: 'ceo' });
    }
    // 7. org debt (§4)
    const weekAgo = new Date(nowMs - t.idleMemberDays * DAY_MS).toISOString();
    const runs = (await this.tasks.runs(org.id, { limit: 500 })).filter((r) => r.startedAt >= weekAgo);
    const openOf = (agentId: string) => tasks.filter((x) => x.assigneeAgentId === agentId && OPEN_STATES.includes(x.status));
    for (const m of active) {
      if (m.agentId === chiefId || m.agentId === org.auditorAgentId) continue;
      const open = openOf(m.agentId);
      if (open.length === 0 && !runs.some((r) => r.agentId === m.agentId) && hoursAgo(m.joinedAt) >= t.idleMemberDays * 24) {
        out.push({ kind: 'idle_member', severity: 'info', refType: 'agent', refId: m.agentId, title: `${nm(m.agentId)} is idle: no open task and no run in ${t.idleMemberDays} days`, detail: `Title: ${m.title || 'member'}. Assign work, pause, or retire the seat.`, addressee: 'chief', unitId: (await unitOf(m.agentId))?.id ?? null });
      }
      if (open.length > t.overloadedOpenTasks) {
        const unit = await unitOf(m.agentId);
        out.push({ kind: 'overloaded_member', severity: 'warn', refType: 'agent', refId: m.agentId, title: `${nm(m.agentId)} has ${open.length} open tasks`, detail: `More than ${t.overloadedOpenTasks}; reassign or sequence them.`, addressee: 'lead', addresseeId: unit?.leadAgentId ?? m.reportsToAgentId ?? chiefId ?? undefined, unitId: unit?.id ?? null });
      }
    }
    for (const lead of members) {
      const reports = members.filter((x) => x.reportsToAgentId === lead.agentId);
      if (lead.agentId !== chiefId && reports.length === 1) {
        out.push({ kind: 'thin_unit', severity: 'info', refType: 'agent', refId: lead.agentId, title: `${nm(lead.agentId)} leads a unit of one (${nm(reports[0].agentId)})`, detail: 'A reporting layer for a single report costs a hop and a channel; flatten it or grow it.', addressee: 'chief', unitId: this.units ? (await this.units.isLead(org.id, lead.agentId))?.id ?? null : null });
      }
    }
    const goals = await this.org.goals(org.id);
    const activeGoals = goals.filter((g) => g.status === 'active');
    if (this.units) {
      for (const u of await this.units.units(org.id)) {
        if (activeGoals.some((g) => g.unitId === u.id) || (u.parentUnitId === null && activeGoals.some((g) => !g.unitId))) continue;
        out.push({ kind: 'unit_no_goal', severity: 'info', refType: 'unit', refId: u.id, title: `Unit ${u.name} (#${u.slug}) has no active goal`, detail: 'Set one with org_set_goal so its board answers "why".', addressee: 'lead', addresseeId: u.leadAgentId, unitId: u.id });
      }
    }
    for (const g of activeGoals) {
      const missing = [!g.ownerAgentId ? 'owner' : '', !g.unitId && this.units ? 'unit' : ''].filter(Boolean);
      if (missing.length === 0) continue;
      out.push({ kind: 'goal_unowned', severity: 'warn', refType: 'goal', refId: g.id, title: `Goal "${g.title}" has no ${missing.join(' or ')}`, detail: 'Every objective needs an owner and a unit to carry it.', addressee: 'chief', unitId: g.unitId });
    }
    const byTitle = new Map<string, string[]>();
    for (const m of active) { const k = m.title.trim().toLowerCase(); if (k) byTitle.set(k, [...(byTitle.get(k) ?? []), m.agentId]); }
    for (const [title, ids] of byTitle) {
      if (ids.length < 2) continue;
      out.push({ kind: 'duplicate_title', severity: 'info', refType: 'org', refId: `title:${title}`, title: `${ids.length} members share the title "${title}": ${ids.map(nm).join(', ')}`, detail: 'Duplicate roles are a reorg candidate: merge, or differentiate the charters.', addressee: 'chief' });
    }
    for (const src of this.sources) out.push(...await src.compute(org, now).catch((err: unknown) => { this.logger.warn(`signal source failed: ${err instanceof Error ? err.message : err}`); return [] as SignalInput[]; }));
    return out;
  }

  // ---- routing ----

  private async route(org: Organization, s: OrgSignal): Promise<void> {
    const ws = await this.workspaces.get(org.workspaceId).catch(() => null);
    const payload = JSON.stringify({ orgId: org.id, signalId: s.id, kind: s.kind, severity: s.severity, refType: s.refType, refId: s.refId });
    const body = `${s.detail}${s.detail ? ' ' : ''}Acknowledge with org_ack_signal ${s.id.slice(0, 8)} once handled.`.slice(0, 1_000);
    const event = (agentId: string, channel: boolean) => this.agents.addEvent(agentId, {
      kind: 'org_signal', title: `[${s.severity}] ${s.title}`.slice(0, 200), body, payload, origin: 'loop', channel, ...deliveryFor(ws, 'org_signal'),
    }).catch(() => {});
    switch (s.addresseeKind) {
      case 'owner':
      case 'lead':
        if (s.addresseeId) await event(s.addresseeId, false);
        break;
      case 'chief':
        this.bus?.emitOrgBoard({ orgId: org.id, kind: 'signal', refId: s.refId, detail: `${s.kind} (${s.severity}): ${s.title}`.slice(0, 200) });
        if (org.chiefOfStaffAgentId) await event(org.chiefOfStaffAgentId, s.severity === 'critical');
        break;
      case 'ceo':
        // The CEO's inbox is the chief's events pushed to the paired channels; the brief carries the line too.
        if (org.chiefOfStaffAgentId) await event(org.chiefOfStaffAgentId, true);
        break;
    }
  }
}

/** The sweep's thresholds for one org: its tunables, clamped to the bounds. */
export function thresholdsOf(org: { tunables?: string | null }): SignalThresholds {
  return {
    staleTaskHours: assuranceTunable(org, 'signals.staleTaskHours'), reviewAgeHours: assuranceTunable(org, 'signals.reviewAgeHours'),
    idleMemberDays: assuranceTunable(org, 'signals.idleMemberDays'), overloadedOpenTasks: assuranceTunable(org, 'signals.overloadedOpenTasks'),
    burnWarnPct: assuranceTunable(org, 'signals.burnWarnPct'), burnCriticalPct: Math.max(assuranceTunable(org, 'signals.burnWarnPct'), assuranceTunable(org, 'signals.burnCriticalPct')),
  };
}

function lastOf(rawList: string): string {
  try { const v = JSON.parse(rawList || '[]') as unknown[]; return String(v.at(-1) ?? ''); } catch { return ''; }
}

function parse<T>(raw: string): T {
  try { return JSON.parse(raw || '{}') as T; } catch { return {} as T; }
}
