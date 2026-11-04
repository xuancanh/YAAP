/**
 * OrgSloService — company SLOs and the pulse (docs/company-vision.md §5.2,
 * execution-plan item 20). No model is involved.
 *
 * `compute()` reads org_tasks / org_runs / org_approvals / org_goals over a
 * trailing 7-day window and produces the metrics below; `sample()` stores
 * one `org_slo_samples` row per org per day (upserted on every sweep so the
 * day's row always reflects the latest view) and opens an `slo_breach`
 * signal, addressed to the chief, for every target missed; `pulse()` returns
 * today's metrics, the 30-day series and a 0–100 score.
 *
 *   cycleTimeHours             median hours from a task's creation to its
 *                              acceptance (done), overall and per task class
 *                              when the brief names one (see `classOf`)
 *   firstReviewAcceptancePct   share of accepted tasks that passed review
 *                              on the first round (reviewRounds = 0)
 *   costPerAcceptedTaskUsd     run spend in the window / tasks accepted
 *   decisionLatencyHours       median hours an approval waited for the CEO
 *   goalsOwnedPct              share of active goals with an owner and a unit
 *   goalsAtRiskPct             share of active goals flagged at risk by the
 *                              intent sweep (org_goals.atRisk, item 18); null
 *                              without active goals
 *   spendVsEnvelopePct         month-to-date spend / company envelope
 *   spendByClassUsd            run spend in the window per task class (item 23)
 *
 * Targets are per-org tunables (docs/company-vision.md §1b;
 * `organizations.tunables` keys `slo.*`, org-assurance-tunables.ts) over the
 * defaults cycle ≤ 48 h, first-review acceptance ≥ 70 %, decision latency
 * ≤ 24 h, each inside a bound that stays in code.
 *
 * The pulse score (0–100), the formula the docs quote, with the four
 * weights (`pulse.weight*`, default 25 each, normalised to 100) and the
 * critical penalty (`pulse.criticalPenalty`, default 5) tunable per org:
 *
 *   score = w₁·cycle + w₂·acceptance + w₃·latency + w₄·health − p·criticals
 *   cycle      = clamp(2 − cycleTimeHours / target, 0, 1)         (1 when no data)
 *   acceptance = clamp(firstReviewAcceptancePct / target, 0, 1)   (1 when no data)
 *   latency    = clamp(2 − decisionLatencyHours / target, 0, 1)   (1 when no data)
 *   health     = ½·clamp(1 − max(0, spend% − 100) / 20, 0, 1) + ½·goalsOwned
 *   criticals  = open critical signals, capped so the score floors at 0
 *
 * so a company at target on every SLO, inside its envelope, with owned goals
 * and no critical signal scores 100; each SLO is worth a quarter, falls
 * linearly and is worth nothing at twice its target (or, for acceptance, at
 * zero).
 */
import { BadRequestException, Inject, Injectable, Optional } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { organizations, orgAudits, orgSloSamples } from '../database/schema';
import { newId, nowIso } from '../common/ids.util';
import { currentAccountId } from '../accounts/account-context';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { OrgService } from './org.service';
import { OrgTasksService, deriveTaskClass } from './org-tasks.service';
import { OrgApprovalsService } from './org-approvals.service';
import { OrgAuditService } from './org-audit.service';
import { OrgSignalsService } from './org-signals.service';
import { assuranceTunable, mergeTunables, parseTunables } from './org-assurance-tunables';
import { monthWindow, spendLedger, sumUsd } from './spend-ledger';

export type OrgSloSample = typeof orgSloSamples.$inferSelect;

export interface SloTargets {
  cycleTimeHours: number;
  firstReviewAcceptancePct: number;
  decisionLatencyHours: number;
}
export const DEFAULT_SLO_TARGETS: SloTargets = { cycleTimeHours: 48, firstReviewAcceptancePct: 70, decisionLatencyHours: 24 };

export interface SloMetrics {
  dayKey: string;
  windowDays: number;
  cycleTimeHours: number | null;
  cycleTimeByClass: Record<string, number>;
  firstReviewAcceptancePct: number | null;
  costPerAcceptedTaskUsd: number | null;
  decisionLatencyHours: number | null;
  goalsOwnedPct: number | null;
  goalsAtRiskPct: number | null;
  spendVsEnvelopePct: number | null;
  /** USD in the window per task class (docs/company-vision.md §7: the pulse shows routing's effect). */
  spendByClassUsd: Record<string, number>;
  acceptedTasks: number;
  runs: number;
  decisions: number;
  openCriticalSignals: number;
}

/** The pulse weights and penalty (tunable per org). */
export interface PulseWeights { cycle: number; acceptance: number; latency: number; health: number; criticalPenalty: number }
export const DEFAULT_PULSE_WEIGHTS: PulseWeights = { cycle: 25, acceptance: 25, latency: 25, health: 25, criticalPenalty: 5 };

export interface SloBreach { metric: keyof SloTargets; value: number; target: number; detail: string }

export interface Pulse {
  score: number;
  today: SloMetrics;
  targets: SloTargets;
  weights: PulseWeights;
  breaches: SloBreach[];
  /** The two SLOs furthest from target, worst first (for the brief). */
  worst: Array<{ metric: keyof SloTargets; value: number | null; target: number; ratio: number }>;
  series: Array<{ day: string; score: number | null; metrics: SloMetrics | null }>;
  /** Audit of the auditor (docs/incidents.md §5.1): precision / recall from
   *  the CEO's spot checks, as of the latest answered card; null until one. */
  auditor?: { precision: number | null; recall: number | null; auditId: string } | null;
}

const DAY_MS = 24 * 60 * 60_000;
const WINDOW_DAYS = 7;

/** A task's class: the stored column (item 23) when the row carries one,
 *  the shared brief heuristic (`deriveTaskClass`) otherwise, so pre-item-23
 *  rows and bare `{ title, brief }` objects still classify. */
export function classOf(task: { title: string; brief: string; class?: string | null }): string {
  return task.class && task.class !== 'general' ? task.class : deriveTaskClass(task);
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The documented formula, pure so the tests can pin it. */
export function pulseScore(m: Pick<SloMetrics, 'cycleTimeHours' | 'firstReviewAcceptancePct' | 'decisionLatencyHours' | 'spendVsEnvelopePct' | 'goalsOwnedPct' | 'openCriticalSignals'>, t: SloTargets, w: PulseWeights = DEFAULT_PULSE_WEIGHTS): number {
  const cycle = m.cycleTimeHours === null ? 1 : clamp(2 - m.cycleTimeHours / t.cycleTimeHours, 0, 1);
  const acceptance = m.firstReviewAcceptancePct === null ? 1 : clamp(m.firstReviewAcceptancePct / t.firstReviewAcceptancePct, 0, 1);
  const latency = m.decisionLatencyHours === null ? 1 : clamp(2 - m.decisionLatencyHours / t.decisionLatencyHours, 0, 1);
  const spend = m.spendVsEnvelopePct === null ? 1 : clamp(1 - Math.max(0, m.spendVsEnvelopePct - 100) / 20, 0, 1);
  const goals = m.goalsOwnedPct === null ? 1 : clamp(m.goalsOwnedPct / 100, 0, 1);
  const health = 0.5 * spend + 0.5 * goals;
  const total = w.cycle + w.acceptance + w.latency + w.health;
  const k = total > 0 ? 100 / total : 0;
  const raw = k * (w.cycle * cycle + w.acceptance * acceptance + w.latency * latency + w.health * health) - w.criticalPenalty * Math.max(0, m.openCriticalSignals);
  return Math.round(clamp(raw, 0, 100));
}

export function breachesOf(m: SloMetrics, t: SloTargets): SloBreach[] {
  const out: SloBreach[] = [];
  if (m.cycleTimeHours !== null && m.cycleTimeHours > t.cycleTimeHours) out.push({ metric: 'cycleTimeHours', value: m.cycleTimeHours, target: t.cycleTimeHours, detail: `median cycle time ${m.cycleTimeHours.toFixed(1)}h, target ≤ ${t.cycleTimeHours}h` });
  if (m.firstReviewAcceptancePct !== null && m.firstReviewAcceptancePct < t.firstReviewAcceptancePct) out.push({ metric: 'firstReviewAcceptancePct', value: m.firstReviewAcceptancePct, target: t.firstReviewAcceptancePct, detail: `first-review acceptance ${Math.round(m.firstReviewAcceptancePct)}%, target ≥ ${t.firstReviewAcceptancePct}%` });
  if (m.decisionLatencyHours !== null && m.decisionLatencyHours > t.decisionLatencyHours) out.push({ metric: 'decisionLatencyHours', value: m.decisionLatencyHours, target: t.decisionLatencyHours, detail: `median decision latency ${m.decisionLatencyHours.toFixed(1)}h, target ≤ ${t.decisionLatencyHours}h` });
  return out;
}

@Injectable()
export class OrgSloService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly org: OrgService,
    private readonly tasks: OrgTasksService,
    private readonly approvals: OrgApprovalsService,
    private readonly audit: OrgAuditService,
    private readonly workspaces: WorkspacesService,
    @Optional() private readonly signals?: OrgSignalsService,
  ) {}

  // ---- targets ----

  async targets(orgId: string): Promise<SloTargets> {
    return targetsOf(await this.org.get(orgId));
  }

  async weights(orgId: string): Promise<PulseWeights> {
    return weightsOf(await this.org.get(orgId));
  }

  /** Set SLO targets (and any other assurance tunable: `pulse.*`,
   *  `signals.*`, `audit.*`) inside their bounds. Keys may be the short SLO
   *  names or full tunable keys; null removes an override. */
  async setTargets(orgId: string, patch: Record<string, unknown>, actor = 'user'): Promise<SloTargets & { tunables: Record<string, number> }> {
    const org = await this.org.get(orgId);
    const full: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) full[k in DEFAULT_SLO_TARGETS ? `slo.${k}` : k] = v;
    let next: Record<string, number>;
    try { next = mergeTunables(parseTunables(org.tunables), full); } catch (err) { throw new BadRequestException(err instanceof Error ? err.message : String(err)); }
    await this.db.update(organizations).set({ tunables: JSON.stringify(next) }).where(eq(organizations.id, orgId));
    await this.audit.append(orgId, { actor, action: 'slo_targets', refType: 'org', refId: orgId, payload: { changed: Object.keys(full), tunables: next } });
    return { ...targetsOf({ tunables: JSON.stringify(next) }), tunables: next };
  }

  // ---- metrics ----

  async compute(orgId: string, now = new Date()): Promise<SloMetrics> {
    const org = await this.org.get(orgId);
    const nowMs = now.getTime();
    const since = new Date(nowMs - WINDOW_DAYS * DAY_MS).toISOString();
    const hours = (a: string, b: string) => (new Date(b).getTime() - new Date(a).getTime()) / 3_600_000;
    const tasks = await this.tasks.list(orgId);
    const accepted = tasks.filter((t) => t.status === 'done' && t.updatedAt >= since);
    const cycles = accepted.map((t) => ({ cls: classOf(t), h: Math.max(0, hours(t.createdAt, t.updatedAt)) }));
    const byClass: Record<string, number> = {};
    for (const cls of new Set(cycles.map((c) => c.cls))) { const m = median(cycles.filter((c) => c.cls === cls).map((c) => c.h)); if (m !== null) byClass[cls] = round(m); }
    const runs = (await this.tasks.runs(orgId, { limit: 500 })).filter((r) => r.startedAt >= since && r.status !== 'running');
    const spend = runs.reduce((a, r) => a + r.usd, 0);
    const classByTask = new Map(tasks.map((t) => [t.id, classOf(t)]));
    const spendByClassUsd: Record<string, number> = {};
    for (const r of runs) { const c = classByTask.get(r.taskId) ?? 'general'; spendByClassUsd[c] = round((spendByClassUsd[c] ?? 0) + r.usd, 4); }
    const decided = (await this.approvals.list(orgId)).filter((a) => a.decidedAt && a.decidedAt >= since && ['approved', 'rejected', 'revision_requested'].includes(a.status));
    const goals = (await this.org.goals(orgId)).filter((g) => g.status === 'active');
    const owned = goals.filter((g) => g.ownerAgentId && g.unitId).length;
    const atRisk = goals.length === 0 ? null : round((goals.filter((g) => g.atRisk === 1).length / goals.length) * 100);
    const ws = await this.workspaces.get(org.workspaceId).catch(() => null);
    const envelope = ws?.orgMonthlyUsd ?? org.monthlyBudgetUsd;
    // Month to date from the spend ledger, the figure the Spend page shows (spend-ledger.ts).
    const monthSpend = sumUsd(await spendLedger(this.db, orgId, monthWindow(now).from, now.toISOString()));
    const criticals = this.signals ? (await this.signals.list(orgId, { severity: 'critical' })).filter((s) => s.status !== 'resolved').length : 0;
    const cycle = median(cycles.map((c) => c.h));
    const latency = median(decided.map((a) => hours(a.createdAt, a.decidedAt!)));
    return {
      dayKey: now.toISOString().slice(0, 10), windowDays: WINDOW_DAYS,
      cycleTimeHours: cycle === null ? null : round(cycle), cycleTimeByClass: byClass,
      firstReviewAcceptancePct: accepted.length ? round((accepted.filter((t) => t.reviewRounds === 0).length / accepted.length) * 100) : null,
      costPerAcceptedTaskUsd: accepted.length ? round(spend / accepted.length, 4) : null,
      decisionLatencyHours: latency === null ? null : round(latency),
      goalsOwnedPct: goals.length ? round((owned / goals.length) * 100) : null,
      goalsAtRiskPct: atRisk,
      spendVsEnvelopePct: envelope > 0 ? round((monthSpend / envelope) * 100) : null,
      spendByClassUsd,
      acceptedTasks: accepted.length, runs: runs.length, decisions: decided.length, openCriticalSignals: criticals,
    };
  }

  // ---- samples and the pulse ----

  /** Store (upsert) today's sample; open an slo_breach signal per target missed. */
  async sample(orgId: string, now = new Date()): Promise<{ metrics: SloMetrics; breaches: SloBreach[] }> {
    const metrics = await this.compute(orgId, now);
    const existing = (await this.db.select().from(orgSloSamples).where(and(eq(orgSloSamples.orgId, orgId), eq(orgSloSamples.dayKey, metrics.dayKey))).limit(1)).at(0);
    if (existing) await this.db.update(orgSloSamples).set({ metrics: JSON.stringify(metrics) }).where(eq(orgSloSamples.id, existing.id));
    else await this.db.insert(orgSloSamples).values({ id: newId(), accountId: currentAccountId(), orgId, dayKey: metrics.dayKey, metrics: JSON.stringify(metrics), createdAt: nowIso() });
    const breaches = breachesOf(metrics, await this.targets(orgId));
    if (this.signals) {
      for (const b of breaches) {
        await this.signals.open(orgId, { kind: 'slo_breach', severity: 'warn', refType: 'slo', refId: b.metric, title: `SLO breach: ${b.detail}`, detail: `Window: trailing ${metrics.windowDays} days. Adjust the target (PATCH …/org/slo) only with a reason the brief can carry.`, addressee: 'chief' }, now);
      }
      // A breach that healed resolves its signal.
      const missed = new Set(breaches.map((b) => b.metric as string));
      for (const s of (await this.signals.list(orgId, { kind: 'slo_breach' })).filter((x) => x.status !== 'resolved' && !missed.has(x.refId))) await this.signals.resolve(orgId, s.id, 'system');
    }
    return { metrics, breaches };
  }

  async samples(orgId: string, days = 30): Promise<OrgSloSample[]> {
    return this.db.select().from(orgSloSamples).where(eq(orgSloSamples.orgId, orgId)).orderBy(desc(orgSloSamples.dayKey)).limit(Math.min(366, days));
  }

  async pulse(orgId: string, now = new Date()): Promise<Pulse> {
    const targets = await this.targets(orgId);
    const today = await this.compute(orgId, now);
    const stored = new Map((await this.samples(orgId, 30)).map((s) => [s.dayKey, s]));
    const series: Pulse['series'] = [];
    for (let i = 29; i >= 0; i--) {
      const day = new Date(now.getTime() - i * DAY_MS).toISOString().slice(0, 10);
      const row = day === today.dayKey ? today : stored.has(day) ? safeMetrics(stored.get(day)!.metrics) : null;
      series.push({ day, score: row ? pulseScore(row, targets, await this.weights(orgId)) : null, metrics: row });
    }
    const ratioOf = (metric: keyof SloTargets, value: number | null) => value === null ? 0 : metric === 'firstReviewAcceptancePct' ? Math.max(0, 1 - value / targets[metric]) : Math.max(0, value / targets[metric] - 1);
    const worst = ([['cycleTimeHours', today.cycleTimeHours], ['firstReviewAcceptancePct', today.firstReviewAcceptancePct], ['decisionLatencyHours', today.decisionLatencyHours]] as Array<[keyof SloTargets, number | null]>)
      .map(([metric, value]) => ({ metric, value, target: targets[metric], ratio: ratioOf(metric, value) }))
      .sort((a, b) => b.ratio - a.ratio).slice(0, 2);
    const weights = await this.weights(orgId);
    const scored = (await this.db.select().from(orgAudits).where(eq(orgAudits.orgId, orgId)).orderBy(desc(orgAudits.startedAt)).limit(20)).find((a) => a.precision !== null || a.recall !== null);
    const auditor = scored ? { precision: scored.precision, recall: scored.recall, auditId: scored.id } : null;
    return { score: pulseScore(today, targets, weights), today, targets, weights, breaches: breachesOf(today, targets), worst, series, auditor };
  }
}

export function targetsOf(org: { tunables?: string | null }): SloTargets {
  return { cycleTimeHours: assuranceTunable(org, 'slo.cycleTimeHours'), firstReviewAcceptancePct: assuranceTunable(org, 'slo.firstReviewAcceptancePct'), decisionLatencyHours: assuranceTunable(org, 'slo.decisionLatencyHours') };
}
export function weightsOf(org: { tunables?: string | null }): PulseWeights {
  return { cycle: assuranceTunable(org, 'pulse.weightCycle'), acceptance: assuranceTunable(org, 'pulse.weightAcceptance'), latency: assuranceTunable(org, 'pulse.weightLatency'), health: assuranceTunable(org, 'pulse.weightHealth'), criticalPenalty: assuranceTunable(org, 'pulse.criticalPenalty') };
}

function round(n: number, digits = 2): number { const f = 10 ** digits; return Math.round(n * f) / f; }
function safeMetrics(raw: string): SloMetrics | null { try { return JSON.parse(raw) as SloMetrics; } catch { return null; } }
