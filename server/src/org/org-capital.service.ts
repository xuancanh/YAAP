/**
 * OrgCapitalService — capital and the CEO's seat (docs/company-vision.md §7,
 * §8, execution-plan item 23). Nothing here calls a model.
 *
 * - **Cost per outcome.** Every org run carries `usd` and a task; a task
 *   carries a `class` and (through its project) a goal. `costByGoal` rolls
 *   spend up task → key result → objective → vision for a period and sets
 *   each objective's spend share against its measured progress, flagging an
 *   objective whose spend share exceeds its progress share by more than
 *   `capital.overspendMargin` ("A has consumed 40 % of its envelope for 20 %
 *   of its key results"). Allocations (`org_allocations`, OrgService) say
 *   what each envelope buys.
 * - **Forecasts.** `forecast` projects month-end spend per envelope —
 *   company, each agent, each project, each objective's allocation — from the
 *   burn rate over the trailing `capital.forecastWindowDays` days, and states
 *   `onTrack | warn | stop` against the assurance thresholds
 *   (`signals.burnWarnPct`, `signals.burnCriticalPct`). `sweepForecast` on
 *   the runtime tick opens a `burn_forecast` signal for the chief (critical
 *   → the CEO) from the projection, not the balance, and resolves it when
 *   the projection falls back inside the envelope.
 * - **Plan preview with a veto window.** In autonomous mode the structural
 *   actions the chief takes in a planning run or a structure review are not
 *   executed; OrgRuntimeService collects them and `createPlan` stores an
 *   `org_plans` row with `applyAt = now + capital.vetoWindowMinutes`, tells
 *   the CEO ("Plan ready: N actions, est. $X, applies at HH:MM unless you
 *   veto") and, on the tick, `applyDue` applies the actions in order through
 *   the very code paths the tools use (the runtime binds `applier`),
 *   stopping at the first refusal and auditing each. `veto` and `applyNow`
 *   are the CEO's; a window of 0 applies at once. `dry_run` rows record what
 *   the chief would do and apply nothing.
 * - **Replay.** `replay(day)` composes, from the audit chain, runs, signals,
 *   approvals and plans, an ordered timeline of what woke, what was decided
 *   and what it cost, with the chain verification of that day's segment.
 */
import { BadRequestException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { orgAudit, orgPlans } from '../database/schema';
import { newId, nowIso } from '../common/ids.util';
import { currentAccountId } from '../accounts/account-context';
import { AgentsService } from '../agents/agents.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { deliveryFor, parseQuietHours } from '../workspaces/quiet-hours';
import { OrgService, Organization, OrgGoal } from './org.service';
import { OrgTasksService } from './org-tasks.service';
import { OrgAuditService, auditHash } from './org-audit.service';
import { OrgSignalsService, thresholdsOf } from './org-signals.service';
import { OrgIntentService, measuredProgress } from './org-intent.service';
import { OrgUnitsService } from './org-units.service';
import { classOf } from './org-slo.service';
import { tunable } from './org-tunables';
import { monthWindow, spendLedger, type SpendEntry } from './spend-ledger';

export type OrgPlan = typeof orgPlans.$inferSelect;
export type PlanStatus = 'pending' | 'applied' | 'vetoed' | 'expired' | 'dry_run';
export type ForecastState = 'onTrack' | 'warn' | 'stop';

/** One structural action the chief asked for, held for the veto window. */
export interface PlanAction { tool: string; input: Record<string, unknown>; estimateUsd: number; summary: string }
/** What the runtime collects during a run (RunCtx.plan). */
export interface PlanCapture { trigger: string; actions: PlanAction[]; dryRun: boolean }
export interface PlanActionResult { tool: string; summary: string; ok: boolean; output: string }

/** The runtime's seam: apply one action through the tool's own code path, as the chief. */
export type PlanApplier = (orgId: string, action: PlanAction) => Promise<string>;

export interface ObjectiveCost {
  goalId: string; title: string; status: string; unitId: string | null;
  spentUsd: number; runs: number;
  /** Share of all attributed spend in the period (0–1). */
  shareOfSpend: number;
  /** The envelope this objective is measured against: its allocation, else the company envelope. */
  envelopeUsd: number; envelopeSource: 'allocation' | 'company' | 'none';
  /** spent / envelope (0–1+), null without an envelope. */
  envelopePct: number | null;
  /** Measured progress (0–1): the mean of its key results' measured progress, else the tree's blended progress. */
  progress: number;
  keyResults: { total: number; achieved: number; measuredPct: number | null };
  allocation: { monthlyUsd: number; buys: string } | null;
  overspend: boolean;
  byClass: Record<string, number>;
}

export interface CostReport {
  period: 'month' | 'all'; from: string | null;
  totalUsd: number; attributedUsd: number; unlinkedUsd: number;
  companyEnvelopeUsd: number; margin: number;
  vision: { goalId: string; title: string; spentUsd: number } | null;
  objectives: ObjectiveCost[];
  byClass: Record<string, number>;
  byAgent: Array<{ agentId: string; name: string; usd: number; runs: number }>;
  costPerAcceptedTaskUsd: number | null;
}

export interface EnvelopeForecast {
  scope: 'company' | 'agent' | 'project' | 'objective'; refId: string; name: string;
  capUsd: number; spentUsd: number; dailyBurnUsd: number; projectedUsd: number;
  /** projected / cap × 100, null without a cap. */
  projectedPct: number | null; state: ForecastState;
}
export interface Forecast {
  month: string; day: number; daysInMonth: number; windowDays: number; warnPct: number; criticalPct: number;
  company: EnvelopeForecast; agents: EnvelopeForecast[]; projects: EnvelopeForecast[]; objectives: EnvelopeForecast[];
}

export interface ReplayEntry { at: string; kind: 'woke' | 'ran' | 'decided' | 'signal' | 'plan' | 'spend' | 'change'; seq: number | null; title: string; usd: number | null; refType: string; refId: string }
export interface Replay {
  day: string; entries: ReplayEntry[];
  totals: { runs: number; usd: number; decisions: number; signals: number; plans: number; auditRows: number };
  chain: { ok: boolean; rows: number; fromSeq: number | null; toSeq: number | null; brokenAt: number | null; reason?: string };
}

const DAY_MS = 24 * 60 * 60_000;
const STRUCTURAL_VERBS: Record<string, string> = { org_hire_agent: 'hire', org_reorg: 'reorg', org_terminate_agent: 'terminate', org_set_scope: 'scope widen', org_allocate_budget: 'budget', org_set_routing: 'routing', org_tune: 'tune', org_start_experiment: 'experiment' };

@Injectable()
export class OrgCapitalService {
  private readonly logger = new Logger(OrgCapitalService.name);
  private applier: PlanApplier | null = null;

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly org: OrgService,
    private readonly tasks: OrgTasksService,
    private readonly audit: OrgAuditService,
    private readonly agents: AgentsService,
    private readonly workspaces: WorkspacesService,
    @Optional() private readonly intent?: OrgIntentService,
    @Optional() private readonly units?: OrgUnitsService,
    @Optional() private readonly signals?: OrgSignalsService,
  ) {}

  /** OrgRuntimeService binds the one way a plan's action becomes a change. */
  bindApplier(fn: PlanApplier): void { this.applier = fn; }

  private readonly toolAppliers = new Map<string, PlanApplier>();

  /** A module whose own tool can be held in a plan (an experiment's start,
   *  docs/experiments.md §1.3) applies its actions itself. */
  addToolApplier(tool: string, fn: PlanApplier): void { this.toolAppliers.set(tool, fn); }

  // ---- cost per outcome ----

  /** Spend rolled up task → key result → objective → vision for the period;
   *  each objective against its envelope and its measured progress. */
  async costByGoal(orgId: string, opts: { period?: 'month' | 'all'; unitId?: string | null; now?: Date } = {}): Promise<CostReport> {
    const now = opts.now ?? new Date();
    const period = opts.period ?? 'month';
    const org = await this.org.get(orgId);
    const month = now.toISOString().slice(0, 7);
    const from = period === 'month' ? `${month}-01` : null;
    // The spend ledger (spend-ledger.ts), as on the Spend page: spend outside a task (meetings, reviews, audits) is in the total, unattributed.
    const runs = await spendLedger(this.db, orgId, period === 'month' ? monthWindow(now).from : '', now.toISOString());
    const tasks = await this.tasks.list(orgId);
    const taskById = new Map(tasks.map((t) => [t.id, t]));
    const projects = await this.org.projects(orgId);
    const projectGoal = new Map(projects.map((p) => [p.id, p.goalId]));
    const goals = await this.org.goals(orgId);
    const goalById = new Map(goals.map((g) => [g.id, g]));
    const names = new Map((await this.agents.list()).map((a) => [a.id, a.name]));
    const allocations = await this.org.allocations(orgId);
    const ws = await this.workspaces.get(org.workspaceId).catch(() => null);
    const companyEnvelopeUsd = ws?.orgMonthlyUsd ?? org.monthlyBudgetUsd;
    const margin = tunable(org, 'capital.overspendMargin');

    // The objective a goal belongs to: itself, or the nearest objective above a key result.
    const objectiveOf = (goalId: string | null): OrgGoal | null => {
      let g = goalId ? goalById.get(goalId) ?? null : null;
      for (let i = 0; g && g.kind === 'key_result' && i < 12; i++) g = g.parentGoalId ? goalById.get(g.parentGoalId) ?? null : null;
      return g;
    };
    const vision = goals.find((g) => g.kind === 'vision' && g.status === 'active') ?? null;
    const spentByObjective = new Map<string, { usd: number; runs: number; byClass: Record<string, number> }>();
    const byClass: Record<string, number> = {};
    const byAgent = new Map<string, { usd: number; runs: number }>();
    let totalUsd = 0; let attributedUsd = 0;
    for (const r of runs) {
      totalUsd += r.usd;
      const a = byAgent.get(r.agentId) ?? { usd: 0, runs: 0 }; a.usd += r.usd; if (r.source === 'task') a.runs++; byAgent.set(r.agentId, a);
      if (r.taskId === null) continue; // not a task: no class, no goal
      const task = taskById.get(r.taskId);
      const cls = task ? classOf(task) : 'general';
      byClass[cls] = (byClass[cls] ?? 0) + r.usd;
      const obj = objectiveOf(task?.projectId ? projectGoal.get(task.projectId) ?? null : null);
      if (!obj) continue;
      attributedUsd += r.usd;
      if (obj.kind === 'vision') continue; // linked straight to the vision: counted in its total, no objective
      const cur = spentByObjective.get(obj.id) ?? { usd: 0, runs: 0, byClass: {} };
      cur.usd += r.usd; cur.runs++; cur.byClass[cls] = (cur.byClass[cls] ?? 0) + r.usd;
      spentByObjective.set(obj.id, cur);
    }
    // Progress: the intent tree's blended progress per objective, and its key results' measured mean.
    const progressById = new Map<string, number>();
    if (this.intent) {
      const walk = (nodes: Array<{ id: string; progress: number; children: unknown[] }>) => { for (const n of nodes) { progressById.set(n.id, n.progress); walk(n.children as typeof nodes); } };
      walk(await this.intent.intentTree(orgId, { now }).catch(() => []));
    }
    const objectives: ObjectiveCost[] = goals
      .filter((g) => g.kind === 'objective' && g.status !== 'abandoned' && (!opts.unitId || g.unitId === opts.unitId))
      .map((g) => {
        const spent = spentByObjective.get(g.id) ?? { usd: 0, runs: 0, byClass: {} };
        const krs = goals.filter((k) => k.kind === 'key_result' && k.parentGoalId === g.id && k.status !== 'abandoned');
        const measured = krs.map((k) => (k.status === 'achieved' ? 1 : measuredProgress(k) ?? 0));
        const measuredPct = krs.length ? round(mean(measured) * 100, 1) : null;
        const progress = krs.length ? mean(measured) : progressById.get(g.id) ?? 0;
        const alloc = allocations.find((a) => a.goalId === g.id) ?? null;
        const envelopeUsd = alloc && alloc.monthlyUsd > 0 ? alloc.monthlyUsd : companyEnvelopeUsd;
        const envelopeSource: ObjectiveCost['envelopeSource'] = alloc && alloc.monthlyUsd > 0 ? 'allocation' : companyEnvelopeUsd > 0 ? 'company' : 'none';
        const envelopePct = envelopeUsd > 0 ? spent.usd / envelopeUsd : null;
        return {
          goalId: g.id, title: g.title, status: g.status, unitId: g.unitId,
          spentUsd: round(spent.usd, 4), runs: spent.runs, shareOfSpend: attributedUsd > 0 ? round(spent.usd / attributedUsd, 4) : 0,
          envelopeUsd, envelopeSource, envelopePct: envelopePct === null ? null : round(envelopePct, 4),
          progress: round(progress, 4), keyResults: { total: krs.length, achieved: krs.filter((k) => k.status === 'achieved').length, measuredPct },
          allocation: alloc ? { monthlyUsd: alloc.monthlyUsd, buys: alloc.rationale } : null,
          overspend: envelopePct !== null && envelopePct - progress > margin,
          byClass: Object.fromEntries(Object.entries(spent.byClass).map(([k, v]) => [k, round(v, 4)])),
        };
      })
      .sort((a, b) => b.spentUsd - a.spentUsd);
    const accepted = tasks.filter((t) => t.status === 'done' && (!from || t.updatedAt.slice(0, 7) === month)).length;
    return {
      period, from, totalUsd: round(totalUsd, 4), attributedUsd: round(attributedUsd, 4), unlinkedUsd: round(totalUsd - attributedUsd, 4),
      companyEnvelopeUsd, margin,
      vision: vision ? { goalId: vision.id, title: vision.title, spentUsd: round(attributedUsd, 4) } : null,
      objectives, byClass: Object.fromEntries(Object.entries(byClass).map(([k, v]) => [k, round(v, 4)])),
      byAgent: [...byAgent.entries()].map(([agentId, v]) => ({ agentId, name: names.get(agentId) ?? agentId.slice(0, 8), usd: round(v.usd, 4), runs: v.runs })).sort((a, b) => b.usd - a.usd),
      costPerAcceptedTaskUsd: accepted > 0 ? round(totalUsd / accepted, 4) : null,
    };
  }

  /** The cost report as the model reads it (org_costs) and the brief's section lines. */
  describeCosts(c: CostReport): string {
    const lines: string[] = [`Spend ${c.period === 'month' ? 'this month' : 'all time'}: $${c.totalUsd.toFixed(2)} ($${c.attributedUsd.toFixed(2)} attributed to objectives, $${c.unlinkedUsd.toFixed(2)} unlinked)${c.companyEnvelopeUsd > 0 ? ` of a $${c.companyEnvelopeUsd.toFixed(2)} company envelope` : ''}.`];
    if (c.objectives.length === 0) lines.push('- no objectives yet');
    for (const o of c.objectives) lines.push(`- ${this.objectiveLine(o)}`);
    if (Object.keys(c.byClass).length) lines.push(`By class: ${Object.entries(c.byClass).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} $${v.toFixed(2)}`).join(', ')}.`);
    if (c.costPerAcceptedTaskUsd !== null) lines.push(`Cost per accepted task: $${c.costPerAcceptedTaskUsd.toFixed(2)}.`);
    return lines.join('\n');
  }

  /** One line per objective: spent, share of envelope, measured progress, the overspend flag. */
  objectiveLine(o: ObjectiveCost): string {
    const env = o.envelopePct === null ? 'no envelope' : `${Math.round(o.envelopePct * 100)}% of ${o.envelopeSource === 'allocation' ? 'its' : 'the company'} $${o.envelopeUsd.toFixed(2)} envelope`;
    const prog = o.keyResults.total ? `${o.keyResults.measuredPct ?? 0}% of ${o.keyResults.total} key result(s) measured` : `${Math.round(o.progress * 100)}% progress`;
    return `${o.title}: $${o.spentUsd.toFixed(2)} (${env}) for ${prog}${o.allocation?.buys ? ` — buys: ${o.allocation.buys.slice(0, 80)}` : ''}${o.overspend ? ' ⚠ spend ahead of progress' : ''}`;
  }

  /** Objectives an envelope funds, for the approval card summary of a budget
   *  change: a project's goal chain; for an agent, the objectives whose
   *  tasks it owns plus the allocations of its unit. */
  async affectedObjectives(orgId: string, scope: string, refId: string): Promise<string[]> {
    const goals = await this.org.goals(orgId);
    const goalById = new Map(goals.map((g) => [g.id, g]));
    const objectiveOf = (goalId: string | null): OrgGoal | null => {
      let g = goalId ? goalById.get(goalId) ?? null : null;
      for (let i = 0; g && g.kind === 'key_result' && i < 12; i++) g = g.parentGoalId ? goalById.get(g.parentGoalId) ?? null : null;
      return g && g.kind === 'objective' ? g : null;
    };
    const out = new Map<string, string>();
    if (scope === 'project') {
      const p = (await this.org.projects(orgId)).find((x) => x.id === refId);
      const o = objectiveOf(p?.goalId ?? null);
      if (o) out.set(o.id, o.title);
    } else if (scope === 'agent') {
      const projects = new Map((await this.org.projects(orgId)).map((p) => [p.id, p.goalId]));
      for (const t of (await this.tasks.list(orgId)).filter((x) => x.assigneeAgentId === refId && !['done', 'cancelled'].includes(x.status))) {
        const o = objectiveOf(t.projectId ? projects.get(t.projectId) ?? null : null);
        if (o) out.set(o.id, o.title);
      }
      // The allocations riding on this envelope, and those of the agent's own sub-unit (the root unit is everyone's).
      const unit = this.units ? await this.units.unitForAssignee(orgId, refId).catch(() => null) : null;
      for (const a of await this.org.allocations(orgId)) if ((a.refId === refId && a.scope === 'agent') || (unit && unit.parentUnitId !== null && a.unitId === unit.id)) { const g = goalById.get(a.goalId); if (g) out.set(g.id, g.title); }
    } else {
      for (const g of goals.filter((x) => x.kind === 'objective' && x.status === 'active')) out.set(g.id, g.title);
    }
    return [...out.values()].slice(0, 8);
  }

  // ---- forecasts ----

  async forecast(orgId: string, now = new Date()): Promise<Forecast> {
    const org = await this.org.get(orgId);
    const ws = await this.workspaces.get(org.workspaceId).catch(() => null);
    const t = thresholdsOf(org);
    const windowDays = tunable(org, 'capital.forecastWindowDays');
    const month = now.toISOString().slice(0, 7);
    const day = now.getUTCDate();
    const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
    const daysLeft = Math.max(0, daysInMonth - day);
    const since = new Date(now.getTime() - windowDays * DAY_MS).toISOString();
    // The spend ledger (spend-ledger.ts): task runs and the meetings, reviews and audits charged to the envelopes — the Spend page's figures.
    const { from } = monthWindow(now);
    const ledger = await spendLedger(this.db, orgId, since < from ? since : from, now.toISOString());
    const monthRuns = ledger.filter((e) => e.at >= from);
    const windowRuns = ledger.filter((e) => e.at >= since);
    const tasks = new Map((await this.tasks.list(orgId)).map((x) => [x.id, x]));
    const projects = await this.org.projects(orgId);
    const projectGoal = new Map(projects.map((p) => [p.id, p.goalId]));
    const goals = new Map((await this.org.goals(orgId)).map((g) => [g.id, g]));
    const objectiveOf = (goalId: string | null): string | null => {
      let g = goalId ? goals.get(goalId) ?? null : null;
      for (let i = 0; g && g.kind === 'key_result' && i < 12; i++) g = g.parentGoalId ? goals.get(g.parentGoalId) ?? null : null;
      return g?.kind === 'objective' ? g.id : null;
    };
    const budgets = await this.org.budgets(orgId);
    const names = new Map((await this.agents.list()).map((a) => [a.id, a.name]));
    const build = (scope: EnvelopeForecast['scope'], refId: string, name: string, capUsd: number, pick: (r: SpendEntry) => boolean): EnvelopeForecast => {
      const spentUsd = monthRuns.filter(pick).reduce((a, r) => a + r.usd, 0);
      const dailyBurnUsd = windowRuns.filter(pick).reduce((a, r) => a + r.usd, 0) / windowDays;
      const projectedUsd = spentUsd + dailyBurnUsd * daysLeft;
      const projectedPct = capUsd > 0 ? (projectedUsd / capUsd) * 100 : null;
      const state: ForecastState = projectedPct === null ? 'onTrack' : projectedPct >= t.burnCriticalPct ? 'stop' : projectedPct >= t.burnWarnPct ? 'warn' : 'onTrack';
      return { scope, refId, name, capUsd, spentUsd: round(spentUsd, 4), dailyBurnUsd: round(dailyBurnUsd, 4), projectedUsd: round(projectedUsd, 4), projectedPct: projectedPct === null ? null : round(projectedPct, 1), state };
    };
    const capOf = (scope: string, refId: string) => budgets.find((b) => b.scope === scope && b.refId === refId)?.monthlyUsd ?? 0;
    const company = build('company', orgId, org.name, ws?.orgMonthlyUsd ?? org.monthlyBudgetUsd, () => true);
    const agents = (await this.org.members(orgId)).filter((m) => m.status !== 'terminated').map((m) => build('agent', m.agentId, names.get(m.agentId) ?? m.agentId.slice(0, 8), capOf('agent', m.agentId), (r) => r.agentId === m.agentId));
    const projectRows = projects.filter((p) => p.status === 'active').map((p) => build('project', p.id, p.title, capOf('project', p.id), (r) => r.taskId !== null && tasks.get(r.taskId)?.projectId === p.id));
    const allocations = await this.org.allocations(orgId);
    const objectives = [...goals.values()].filter((g) => g.kind === 'objective' && g.status === 'active').map((g) => build('objective', g.id, g.title, allocations.find((a) => a.goalId === g.id)?.monthlyUsd ?? 0, (r) => { const task = r.taskId === null ? undefined : tasks.get(r.taskId); return objectiveOf(task?.projectId ? projectGoal.get(task.projectId) ?? null : null) === g.id; }));
    return { month, day, daysInMonth, windowDays, warnPct: t.burnWarnPct, criticalPct: t.burnCriticalPct, company, agents, projects: projectRows, objectives };
  }

  describeForecast(f: Forecast): string {
    const line = (e: EnvelopeForecast) => `${e.name}: $${e.spentUsd.toFixed(2)} spent, burning $${e.dailyBurnUsd.toFixed(2)}/day → $${e.projectedUsd.toFixed(2)} by month-end${e.capUsd > 0 ? ` of $${e.capUsd.toFixed(2)} (${e.projectedPct}%)` : ' (no cap)'} — ${e.state}`;
    const lines = [`Forecast for ${f.month} (day ${f.day} of ${f.daysInMonth}; trailing ${f.windowDays}-day burn; warn ≥ ${f.warnPct}%, stop ≥ ${f.criticalPct}%).`, `Company — ${line(f.company)}`];
    for (const e of f.agents) lines.push(`- agent ${line(e)}`);
    for (const e of f.projects) lines.push(`- project ${line(e)}`);
    for (const e of f.objectives) lines.push(`- objective ${line(e)}`);
    return lines.join('\n');
  }

  /** The tick: a `burn_forecast` signal from the company projection — warn to
   *  the chief, critical (projected ≥ the critical pct) to the CEO — resolved
   *  when the projection is back inside the envelope. Model-free. */
  async sweepForecast(orgId: string, now = new Date()): Promise<Forecast> {
    const f = await this.forecast(orgId, now);
    if (!this.signals) return f;
    const c = f.company;
    const refId = `${orgId}:${f.month}`;
    if (c.state !== 'onTrack') {
      const critical = c.state === 'stop';
      await this.signals.open(orgId, {
        kind: 'burn_forecast', severity: critical ? 'critical' : 'warn', refType: 'org', refId,
        title: `Forecast: $${c.projectedUsd.toFixed(2)} by month-end against a $${c.capUsd.toFixed(2)} envelope (${c.projectedPct}%)`,
        detail: `Trailing ${f.windowDays}-day burn $${c.dailyBurnUsd.toFixed(2)}/day, $${c.spentUsd.toFixed(2)} spent by day ${f.day}. ${critical ? 'Runs will stop when the envelope is reached: cut scope, route classes to cheaper tiers (org_set_routing), or raise the envelope.' : 'Watch the projection; route classes cheaper or trim allocations before it becomes a stop.'}`,
        addressee: critical ? 'ceo' : 'chief',
      }, now);
    } else {
      for (const s of (await this.signals.list(orgId, { kind: 'burn_forecast' })).filter((x) => x.status !== 'resolved' && x.refId === refId)) await this.signals.resolve(orgId, s.id, 'system');
    }
    return f;
  }

  // ---- plans: preview with a veto window ----

  async plans(orgId: string, opts: { status?: string; limit?: number } = {}): Promise<OrgPlan[]> {
    const conds = [eq(orgPlans.orgId, orgId)];
    if (opts.status) conds.push(eq(orgPlans.status, opts.status));
    return this.db.select().from(orgPlans).where(and(...conds)).orderBy(desc(orgPlans.createdAt)).limit(Math.min(500, opts.limit ?? 100));
  }

  async plan(orgId: string, id: string): Promise<OrgPlan> {
    const p = (await this.db.select().from(orgPlans).where(and(eq(orgPlans.orgId, orgId), eq(orgPlans.id, id))).limit(1)).at(0);
    if (!p) throw new NotFoundException(`plan ${id}`);
    return p;
  }

  /** Store what the chief collected. A pending plan gets its window from
   *  `capital.vetoWindowMinutes`, one inbox event pushed to the CEO, and
   *  applies at once when the window is 0. A dry run is stored as `dry_run`. */
  async createPlan(orgId: string, capture: PlanCapture, opts: { runUsd?: number; by?: string } = {}): Promise<OrgPlan> {
    const org = await this.org.get(orgId);
    const ws = await this.workspaces.get(org.workspaceId).catch(() => null);
    const windowMinutes = capture.dryRun ? 0 : tunable(org, 'capital.vetoWindowMinutes');
    const now = new Date();
    const applyAt = capture.dryRun ? null : new Date(now.getTime() + windowMinutes * 60_000).toISOString();
    const estimateUsd = round(capture.actions.reduce((a, x) => a + (x.estimateUsd || 0), 0), 4);
    const summary = capture.actions.map((a) => `${STRUCTURAL_VERBS[a.tool] ?? a.tool.replace(/^org_/, '')}: ${a.summary}`).join('; ').slice(0, 2_000);
    const row: OrgPlan = {
      accountId: currentAccountId(), id: newId(), orgId, trigger: capture.trigger.slice(0, 40), summary, actions: JSON.stringify(capture.actions).slice(0, 60_000), estimateUsd,
      status: capture.dryRun ? 'dry_run' : 'pending', vetoWindowMinutes: windowMinutes, result: '[]', createdAt: now.toISOString(), applyAt, appliedAt: null, decidedBy: '',
    };
    await this.db.insert(orgPlans).values(row);
    await this.audit.append(orgId, { actor: opts.by ?? 'chief', action: capture.dryRun ? 'plan_dry_run' : 'plan_created', refType: 'plan', refId: row.id, payload: { trigger: row.trigger, actions: capture.actions.length, estimateUsd, applyAt, vetoWindowMinutes: windowMinutes, summary: summary.slice(0, 600), runUsd: opts.runUsd } });
    if (org.chiefOfStaffAgentId) {
      const tz = parseQuietHours(ws?.quietHours)?.timezone;
      const title = capture.dryRun
        ? `Dry run: ${capture.actions.length} action(s) the chief would take, est. $${estimateUsd.toFixed(2)} — nothing applied`
        : windowMinutes === 0
          ? `Plan applied: ${capture.actions.length} action(s), est. $${estimateUsd.toFixed(2)} (veto window is 0)`
          : `Plan ready: ${capture.actions.length} action(s), est. $${estimateUsd.toFixed(2)}, applies at ${hhmm(applyAt!, tz)} unless you veto`;
      await this.agents.addEvent(org.chiefOfStaffAgentId, {
        kind: 'org_plan', title: title.slice(0, 200), body: `${summary}${capture.dryRun ? '' : `\n\nVeto: POST …/org/plans/${row.id}/veto · apply now: POST …/org/plans/${row.id}/apply-now`}`.slice(0, 2_000),
        payload: JSON.stringify({ orgId, planId: row.id, status: row.status, applyAt, actions: capture.actions.length, estimateUsd }), origin: 'loop', channel: true, ...deliveryFor(ws, 'org_plan', now),
      }).catch(() => {});
    }
    if (!capture.dryRun && windowMinutes === 0) return this.apply(orgId, row.id, 'system');
    return row;
  }

  /** The CEO stops a pending plan; nothing in it ever applies. */
  async veto(orgId: string, id: string, actor = 'user', note = ''): Promise<OrgPlan> {
    const p = await this.plan(orgId, id);
    if (p.status !== 'pending') throw new BadRequestException(`plan is ${p.status}`);
    await this.db.update(orgPlans).set({ status: 'vetoed', decidedBy: actor, appliedAt: null }).where(eq(orgPlans.id, id));
    await this.audit.append(orgId, { actor, action: 'plan_vetoed', refType: 'plan', refId: id, payload: { actions: parseActions(p.actions).length, note: note.slice(0, 300) } });
    const org = await this.org.get(orgId);
    if (org.chiefOfStaffAgentId) await this.agents.addEvent(org.chiefOfStaffAgentId, { kind: 'info', title: `CEO vetoed the plan (${parseActions(p.actions).length} action(s))`, body: note || p.summary.slice(0, 1_000), payload: JSON.stringify({ orgId, planId: id, status: 'vetoed' }), origin: 'user' }).catch(() => {});
    return this.plan(orgId, id);
  }

  /** The CEO applies a pending plan before its window closes. */
  async applyNow(orgId: string, id: string, actor = 'user'): Promise<OrgPlan> {
    const p = await this.plan(orgId, id);
    if (p.status !== 'pending') throw new BadRequestException(`plan is ${p.status}`);
    return this.apply(orgId, id, actor);
  }

  /** The tick: apply every pending plan whose window has closed. */
  async applyDue(orgId: string, now = new Date()): Promise<number> {
    let n = 0;
    for (const p of (await this.plans(orgId, { status: 'pending' })).filter((x) => x.applyAt && x.applyAt <= now.toISOString())) {
      await this.apply(orgId, p.id, 'system').catch((err) => this.logger.warn(`plan ${p.id} failed to apply: ${err instanceof Error ? err.message : err}`));
      n++;
    }
    return n;
  }

  /** Apply the actions in order through the runtime's tool paths, stopping at
   *  the first refusal; each step is audited; the row records the outcome. */
  private async apply(orgId: string, id: string, actor: string): Promise<OrgPlan> {
    const p = await this.plan(orgId, id);
    if (p.status !== 'pending') return p;
    const org = await this.org.get(orgId);
    const actions = parseActions(p.actions);
    if (!this.applier || org.status !== 'active' || !org.chiefOfStaffAgentId) {
      await this.db.update(orgPlans).set({ status: 'expired', decidedBy: actor, appliedAt: nowIso(), result: JSON.stringify([{ tool: '', summary: '', ok: false, output: !this.applier ? 'no runtime bound' : org.status !== 'active' ? `organization is ${org.status}` : 'no chief of staff' }]) }).where(eq(orgPlans.id, id));
      await this.audit.append(orgId, { actor, action: 'plan_expired', refType: 'plan', refId: id, payload: { reason: org.status !== 'active' ? org.status : 'unavailable' } });
      return this.plan(orgId, id);
    }
    const results: PlanActionResult[] = [];
    for (const a of actions) {
      try {
        const output = await (this.toolAppliers.get(a.tool) ?? this.applier)(orgId, a);
        results.push({ tool: a.tool, summary: a.summary, ok: true, output: output.slice(0, 1_000) });
        await this.audit.append(orgId, { actor, action: 'plan_action_applied', refType: 'plan', refId: id, payload: { tool: a.tool, summary: a.summary.slice(0, 300) } });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        results.push({ tool: a.tool, summary: a.summary, ok: false, output: message.slice(0, 1_000) });
        await this.audit.append(orgId, { actor, action: 'plan_action_refused', refType: 'plan', refId: id, payload: { tool: a.tool, summary: a.summary.slice(0, 300), reason: message.slice(0, 300) } });
        break;
      }
    }
    const applied = results.filter((r) => r.ok).length;
    await this.db.update(orgPlans).set({ status: 'applied', decidedBy: actor, appliedAt: nowIso(), result: JSON.stringify(results).slice(0, 60_000) }).where(eq(orgPlans.id, id));
    await this.audit.append(orgId, { actor, action: 'plan_applied', refType: 'plan', refId: id, payload: { applied, of: actions.length, stoppedAt: results.find((r) => !r.ok)?.tool ?? null } });
    if (org.chiefOfStaffAgentId) {
      const stopped = results.find((r) => !r.ok);
      await this.agents.addEvent(org.chiefOfStaffAgentId, {
        kind: 'org_plan', title: `Plan applied: ${applied} of ${actions.length} action(s)${stopped ? ` — stopped at ${stopped.tool}` : ''}`.slice(0, 200),
        body: results.map((r) => `${r.ok ? '✓' : '✗'} ${r.summary}${r.ok ? '' : ` — ${r.output}`}`).join('\n').slice(0, 2_000),
        payload: JSON.stringify({ orgId, planId: id, status: 'applied', applied, of: actions.length }), origin: actor === 'system' ? 'loop' : 'user',
      }).catch(() => {});
    }
    return this.plan(orgId, id);
  }

  // ---- replay ----

  /** A day as a timeline: what woke, what was decided, what it cost, with
   *  the audit chain of that day's segment verified against the row before it. */
  async replay(orgId: string, day: string): Promise<Replay> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new BadRequestException('day must be YYYY-MM-DD');
    const all = await this.db.select().from(orgAudit).where(eq(orgAudit.orgId, orgId)).orderBy(orgAudit.seq);
    const rows = all.filter((r) => r.createdAt.slice(0, 10) === day);
    const names = new Map((await this.agents.list()).map((a) => [a.id, a.name]));
    const nm = (id: string | null | undefined) => (id ? names.get(id) ?? id.slice(0, 8) : 'nobody');
    const tasks = new Map((await this.tasks.list(orgId)).map((t) => [t.id, t]));
    const entries: ReplayEntry[] = [];
    let usd = 0; let runs = 0; let decisions = 0; let signalsN = 0; let plansN = 0;
    for (const r of rows) {
      const p = parse<Record<string, unknown>>(r.payload);
      const push = (kind: ReplayEntry['kind'], title: string, cost: number | null = null) => entries.push({ at: r.createdAt, kind, seq: r.seq, title: title.slice(0, 300), usd: cost, refType: r.refType, refId: r.refId });
      switch (r.action) {
        case 'run_start': push('woke', `${nm(r.actor.replace(/^agent:/, ''))} woke for "${tasks.get(String(p.taskId ?? ''))?.title ?? String(p.taskId ?? '').slice(0, 8)}" (${String(p.reason ?? '')}${p.reviewer ? ', as reviewer' : ''})${p.model ? ` on ${String(p.model)}` : ''}`); break;
        case 'run_end': { const c = Number(p.usd ?? 0); usd += c; runs++; push('ran', `${nm(r.actor.replace(/^agent:/, ''))} ended "${tasks.get(String(p.taskId ?? ''))?.title ?? String(p.taskId ?? '').slice(0, 8)}": ${String(p.outcome ?? p.status ?? '')}`, c); break; }
        case 'chief_review_start': push('woke', `chief review (${String(p.trigger ?? '')})${Array.isArray(p.reasons) && p.reasons.length ? `: ${(p.reasons as string[]).slice(0, 3).join('; ')}` : ''}`); break;
        case 'chief_review_end': { const c = Number(p.usd ?? 0); usd += c; runs++; push('ran', `chief review ended (${String(p.status ?? '')}${p.acted ? ', acted' : ''})`, c); break; }
        case 'planning_start': push('woke', `planning session (${String(p.trigger ?? '')}) by ${nm(String(p.facilitator ?? ''))}`); break;
        case 'planning_end': { const c = Number(p.usd ?? 0); usd += c; runs++; push('ran', `planning ended (${String(p.status ?? '')}${p.acted ? ', acted' : ''})`, c); break; }
        case 'audit_start': push('woke', 'audit run started'); break;
        case 'audit_end': { const c = Number(p.usd ?? 0); usd += c; runs++; push('ran', `audit ended: ${String(p.findings ?? 0)} finding(s)`, c); break; }
        case 'approval_request': push('decided', `proposed (${String(p.kind ?? '')}): ${String(p.summary ?? '')}`); break;
        case 'approval_approved': case 'approval_rejected': case 'approval_revision_requested': case 'approval_expired': decisions++; push('decided', `${r.action.replace('approval_', '').replace('_', ' ')} ${String(p.kind ?? '')} by ${String(p.decidedBy ?? r.actor)}${p.note ? ` — ${String(p.note)}` : ''}`); break;
        case 'tunable_set': case 'routing_set': case 'profile_set': case 'allocation_set': decisions++; push('decided', `${String(p.decision ?? r.action)}${p.rationale ? ` — ${String(p.rationale)}` : ''} (${r.actor})`); break;
        case 'signal_open': signalsN++; push('signal', `signal ${String(p.kind ?? '')} (${String(p.severity ?? '')}) → ${String(p.addressee ?? '')}`); break;
        case 'signal_ack': case 'signal_resolve': push('signal', `signal ${String(p.kind ?? '')} ${r.action.replace('signal_', '')} by ${String(p.by ?? r.actor)}`); break;
        case 'plan_created': case 'plan_dry_run': plansN++; push('plan', `${r.action === 'plan_dry_run' ? 'dry run' : 'plan'}: ${String(p.actions ?? 0)} action(s), est. $${Number(p.estimateUsd ?? 0).toFixed(2)}${p.applyAt ? `, applies ${String(p.applyAt).slice(11, 16)}` : ''} — ${String(p.summary ?? '')}`, Number(p.estimateUsd ?? 0) || null); break;
        case 'plan_vetoed': case 'plan_applied': case 'plan_expired': case 'plan_action_applied': case 'plan_action_refused': decisions += r.action === 'plan_vetoed' ? 1 : 0; push('plan', `${r.action.replace('plan_', 'plan ').replace('_', ' ')}${p.tool ? ` ${String(p.tool)}` : ''}${p.reason ? ` — ${String(p.reason)}` : ''}${p.applied !== undefined ? ` (${String(p.applied)} of ${String(p.of)})` : ''} by ${r.actor}`); break;
        case 'budget_warn': case 'budget_stop': push('spend', `${r.action.replace('_', ' ')}: ${r.refType} ${r.refId.slice(0, 8)}${p.cap !== undefined ? ` $${Number(p.used ?? 0).toFixed(2)} of $${Number(p.cap).toFixed(2)}` : ''}`); break;
        case 'spend_reserve': case 'spend_commit': break; // folded into run_end
        default:
          if (r.action.startsWith('auto_')) push('change', `autonomous ${r.action.slice(5).replace('_', ' ')}: ${String(p.summary ?? '')}${p.reason ? ` — ${String(p.reason)}` : ''}`);
          else if (['task_create', 'task_assign', 'task_escalate', 'review_accept', 'review_request_changes', 'vision_set', 'vision_revise', 'goal_at_risk', 'goal_risk_cleared', 'strategy_memo', 'brief', 'org_pause', 'org_resume', 'budget_set', 'member_add', 'member_terminate', 'scope_widen', 'scope_narrow'].includes(r.action)) push('change', `${r.action.replace(/_/g, ' ')} ${r.refType} ${tasks.get(r.refId)?.title ?? r.refId.slice(0, 8)} (${r.actor})`);
      }
    }
    entries.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : (a.seq ?? 0) - (b.seq ?? 0)));
    // Chain check for the segment: the first row's prevHash must be the hash
    // of the row before it, each row must recompute, seqs must be contiguous.
    let chain: Replay['chain'] = { ok: true, rows: rows.length, fromSeq: rows[0]?.seq ?? null, toSeq: rows.at(-1)?.seq ?? null, brokenAt: null };
    if (rows.length > 0) {
      const before = all.find((r) => r.seq === rows[0].seq - 1);
      let prevHash = before?.hash ?? (rows[0].seq === 1 ? '' : null);
      let expect = rows[0].seq;
      for (const r of rows) {
        if (r.seq !== expect) { chain = { ...chain, ok: false, brokenAt: r.seq, reason: `sequence gap: expected ${expect}` }; break; }
        if (prevHash !== null && r.prevHash !== prevHash) { chain = { ...chain, ok: false, brokenAt: r.seq, reason: 'prevHash does not match the previous row' }; break; }
        if (auditHash(r) !== r.hash) { chain = { ...chain, ok: false, brokenAt: r.seq, reason: 'row content does not match its hash' }; break; }
        prevHash = r.hash; expect++;
      }
    }
    return { day, entries, totals: { runs, usd: round(usd, 4), decisions, signals: signalsN, plans: plansN, auditRows: rows.length }, chain };
  }

}

export function parseActions(raw: string): PlanAction[] {
  try { const v = JSON.parse(raw || '[]') as unknown; return Array.isArray(v) ? (v as PlanAction[]) : []; } catch { return []; }
}

function hhmm(iso: string, tz?: string): string {
  try { return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso)); } catch { return iso.slice(11, 16); }
}
function mean(xs: number[]): number { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }
function round(n: number, digits = 2): number { const f = 10 ** digits; return Math.round(n * f) / f; }
function parse<T>(raw: string): T { try { return JSON.parse(raw || '{}') as T; } catch { return {} as T; } }

export type { Organization };
