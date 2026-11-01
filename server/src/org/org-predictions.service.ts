/**
 * OrgPredictionsService — the prediction ledger and calibration
 * (docs/experiments.md §2, execution-plan item 30; C7 of
 * docs/autonomous-org-first-principles.md).
 *
 * Members forecast — "this task takes 2 runs", "this key result reaches its
 * target by the due date (p = 0.8)", "this experiment moves the metric +10 %"
 * — through `org_forecast_outcome`, and automatically: a task's assignee is
 * asked for a duration forecast in its first run's context; a key-result
 * check-in by its owning agent with a confidence is a probability forecast
 * (sourced key results only — a self-reported one could never be scored);
 * an experiment's proposer forecasts its expected effect.
 *
 * Resolution is model-free and reads only the record the forecaster did not
 * write: tasks by their actual runs to done (or done-by date), key results by
 * the metric source's latest sample at or before the resolution date, and
 * experiments by their measured effect. Each forecast gets a loss in 0–1:
 * the Brier score for probabilities, the normalized absolute error
 * |f − a| / max(|f|, |a|) otherwise. A member's calibration is 1 − the mean
 * loss of its last `predictions.calibrationWindow` resolved forecasts, null
 * below `predictions.calibrationMinCount`; it feeds the trust ledger through
 * calibration-registry.ts and the chief's brief ("whose estimates to
 * discount").
 */
import { BadRequestException, Inject, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, desc, eq, lte } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { orgExperiments, orgMetricSamples, orgPredictions } from '../database/schema';
import { newId, nowIso } from '../common/ids.util';
import { currentAccountId } from '../accounts/account-context';
import { AccountsService } from '../accounts/accounts.service';
import { AgentsService } from '../agents/agents.service';
import { TurnLoopService, type ToolProviderHook } from '../chats/turn-loop.service';
import type { ChatSession } from '../chats/chats.repository';
import type { AiToolSpec } from '../ai/ai-provider.interface';
import { OrgService, type Organization } from './org.service';
import { OrgAuditService } from './org-audit.service';
import { OrgTasksService } from './org-tasks.service';
import { OrgIntentService } from './org-intent.service';
import { OrgRuntimeService } from './org-runtime.service';
import { OrgUnitsService } from './org-units.service';
import { OrgBriefService } from './org-brief.service';
import { registerCalibrationProvider } from './calibration-registry';
import { experimentTunable } from './experiment-tunables';
import { TUNABLES, tunable } from './org-tunables';

export type OrgPrediction = typeof orgPredictions.$inferSelect;
export const SUBJECT_KINDS = ['task', 'key_result', 'experiment', 'hire', 'other'] as const;
export type SubjectKind = typeof SUBJECT_KINDS[number];
export const FORECAST_KINDS = ['number', 'probability', 'duration_runs', 'date'] as const;
export type ForecastKind = typeof FORECAST_KINDS[number];
export interface Forecast { kind: ForecastKind; value: number | string; low?: number; high?: number; unit?: string }
const DAY = 86_400_000;

/** Brier score of a probability forecast against a 0/1 outcome (pure). */
export function brier(p: number, outcome: 0 | 1): number { return round((p - outcome) ** 2); }

/** Normalized absolute error in 0–1 (pure): 0 exact, 1 off by the larger magnitude or more. */
export function nae(forecast: number, actual: number): number {
  const scale = Math.max(Math.abs(forecast), Math.abs(actual));
  if (scale === 0) return 0;
  return round(Math.min(1, Math.abs(forecast - actual) / scale));
}

/** The signed error the bias reads (pure): > 0 the forecast was above what happened. */
export function signedError(kind: string, forecast: number, actual: number): number {
  if (kind === 'probability') return round(forecast - actual);
  const scale = Math.max(Math.abs(forecast), Math.abs(actual));
  return scale === 0 ? 0 : round(Math.max(-1, Math.min(1, (forecast - actual) / scale)));
}

export interface CalibrationReport { agentId: string; name: string; resolved: number; open: number; brier: number | null; calibration: number | null; bias: number | null; biasLabel: 'over' | 'under' | 'balanced' | null }

const TOOL_NAMES = new Set(['org_forecast_outcome', 'org_calibration']);
const FORECAST_TOOL: AiToolSpec = {
  name: 'org_forecast_outcome',
  description: 'Record a forecast in the company\'s prediction ledger (docs/experiments.md §2). It is scored model-free against what happens — tasks by their actual runs to done, key results by their metric source at the date, experiments by their measured effect — and your calibration (how close your forecasts land) is what tells the chief whose estimates to discount and feeds your trust level. Kinds: duration_runs (a task: how many runs to done), probability (0–1: will it happen by resolvesAt — a task done, a key result at target, an experiment kept), number (a key result\'s value at resolvesAt; an experiment\'s effect, relative), date (ISO: when a task is done).',
  inputSchema: {
    type: 'object',
    properties: {
      subject: { type: 'object', properties: { kind: { type: 'string', enum: [...SUBJECT_KINDS] }, id: { type: 'string', description: 'Task, key result or experiment id (or 8-char prefix).' } }, required: ['kind'] },
      question: { type: 'string' },
      forecast: { type: 'object', properties: { kind: { type: 'string', enum: [...FORECAST_KINDS] }, value: { description: 'A number, a probability 0–1, a run count or an ISO date.' }, low: { type: 'number' }, high: { type: 'number' } }, required: ['kind', 'value'] },
      resolvesAt: { type: 'string', description: 'ISO date it is judged at (a key result: defaults to its due date).' },
      org: { type: 'string' },
    },
    required: ['subject', 'question', 'forecast'],
  },
};
const CALIBRATION_TOOL: AiToolSpec = {
  name: 'org_calibration',
  description: 'Calibration of each member\'s forecasts (chief and unit leads): resolved and open forecasts, Brier score, calibration 0–1 (1 − mean loss of the last N; none below the minimum count) and bias (over: forecasts land above what happens — optimistic probabilities, too many runs; under: below). Discount the estimates of the poorly calibrated.',
  inputSchema: { type: 'object', properties: { org: { type: 'string' } } },
};

@Injectable()
export class OrgPredictionsService implements ToolProviderHook, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OrgPredictionsService.name);
  private timer?: ReturnType<typeof setInterval>;
  now: () => Date = () => new Date();

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly org: OrgService,
    private readonly audit: OrgAuditService,
    private readonly tasks: OrgTasksService,
    private readonly agents: AgentsService,
    private readonly config: ConfigService,
    @Optional() private readonly turns?: TurnLoopService,
    @Optional() private readonly runtime?: OrgRuntimeService,
    @Optional() private readonly intent?: OrgIntentService,
    @Optional() private readonly units?: OrgUnitsService,
    @Optional() private readonly brief?: OrgBriefService,
    @Optional() private readonly accounts?: AccountsService,
  ) {
    if (!this.enabled()) return;
    this.turns?.addToolProvider(this);
    registerCalibrationProvider((workspaceId, agentId) => this.calibrationOf(workspaceId, agentId));
    this.intent?.onCheckIn((ev) => this.onCheckIn(ev.orgId, ev.goal, ev.checkin));
    this.brief?.addSection({ position: 'improve', lines: (orgId) => this.briefLines(orgId) });
  }

  enabled(): boolean { return this.config.get<boolean>('companiesEnabled') !== false; }

  onModuleInit(): void {
    if (!this.enabled()) return;
    this.timer = setInterval(() => { void this.tick(this.now()); }, 60 * 60_000);
  }

  onModuleDestroy(): void { clearInterval(this.timer); }

  // ---- reads ----

  async list(orgId: string, opts: { agentId?: string; status?: string; subjectKind?: string; subjectId?: string; limit?: number } = {}): Promise<OrgPrediction[]> {
    const conds = [eq(orgPredictions.orgId, orgId)];
    if (opts.agentId) conds.push(eq(orgPredictions.agentId, opts.agentId));
    if (opts.status) conds.push(eq(orgPredictions.status, opts.status));
    if (opts.subjectKind) conds.push(eq(orgPredictions.subjectKind, opts.subjectKind));
    if (opts.subjectId) conds.push(eq(orgPredictions.subjectId, opts.subjectId));
    return this.db.select().from(orgPredictions).where(and(...conds)).orderBy(desc(orgPredictions.createdAt)).limit(Math.min(1_000, Math.max(1, opts.limit ?? 200)));
  }

  view(p: OrgPrediction) { return { ...p, forecast: parseObj(p.forecast), outcome: parseObj(p.outcome) }; }

  // ---- recording ----

  /** Record a forecast (validated; the agent's earlier open forecast of the same subject and kind is superseded). */
  async record(orgId: string, input: { agentId: string; subjectKind: string; subjectId?: string; question: string; forecast: Record<string, unknown>; resolvesAt?: string | null; origin?: string }): Promise<OrgPrediction> {
    const member = await this.org.member(orgId, input.agentId);
    if (!member || member.status === 'terminated') throw new BadRequestException('only a member of the organization forecasts');
    const subjectKind = input.subjectKind as SubjectKind;
    if (!SUBJECT_KINDS.includes(subjectKind)) throw new BadRequestException(`subject kind must be one of ${SUBJECT_KINDS.join(', ')}`);
    const forecast = normalizeForecast(input.forecast);
    let subjectId = (input.subjectId ?? '').trim();
    let resolvesAt = input.resolvesAt ? isoOrThrow(input.resolvesAt, 'resolvesAt') : null;
    if (subjectKind === 'task') {
      subjectId = (await this.tasks.byPrefix(orgId, subjectId)).id;
      if (forecast.kind === 'number') throw new BadRequestException('a task forecast is duration_runs, date or probability (done by resolvesAt)');
      if (forecast.kind === 'probability' && !resolvesAt) throw new BadRequestException('a probability about a task needs resolvesAt (done by when?)');
    } else if (subjectKind === 'key_result') {
      const goals = (await this.org.goals(orgId)).filter((g) => g.kind === 'key_result' && (g.id === subjectId || (subjectId.length >= 6 && g.id.startsWith(subjectId))));
      if (goals.length !== 1) throw new BadRequestException(`key result "${subjectId}" matches ${goals.length} key results`);
      subjectId = goals[0].id;
      if (forecast.kind !== 'probability' && forecast.kind !== 'number') throw new BadRequestException('a key-result forecast is a probability (reaches its target) or a number (its value at resolvesAt)');
      resolvesAt = resolvesAt ?? goals[0].dueAt;
      if (!resolvesAt) throw new BadRequestException('the key result has no due date: give resolvesAt');
    } else if (subjectKind === 'experiment') {
      const rows = (await this.db.select().from(orgExperiments).where(eq(orgExperiments.orgId, orgId))).filter((e) => e.id === subjectId || (subjectId.length >= 6 && e.id.startsWith(subjectId)));
      if (rows.length !== 1) throw new BadRequestException(`experiment "${subjectId}" matches ${rows.length} experiments`);
      subjectId = rows[0].id;
      if (forecast.kind !== 'number' && forecast.kind !== 'probability') throw new BadRequestException('an experiment forecast is a number (its effect) or a probability (kept)');
      if (forecast.kind === 'number' && !forecast.unit) forecast.unit = rows[0].effectKind;
    } else if (!resolvesAt) throw new BadRequestException(`a ${subjectKind} forecast needs resolvesAt (it has no model-free resolution and is voided then)`);
    const question = (input.question ?? '').trim().slice(0, 500);
    if (!question) throw new BadRequestException('a forecast needs a question');
    // One open forecast per (agent, subject, kind): the newer supersedes.
    for (const old of (await this.list(orgId, { agentId: input.agentId, subjectKind, subjectId, status: 'open' })).filter((p) => parseObj(p.forecast).kind === forecast.kind && p.origin !== 'checkin')) {
      await this.db.update(orgPredictions).set({ status: 'void', resolvedAt: nowIso(), outcome: JSON.stringify({ reason: 'superseded' }) }).where(eq(orgPredictions.id, old.id));
    }
    const row: OrgPrediction = {
      accountId: currentAccountId(), id: newId(), orgId, agentId: input.agentId, subjectKind, subjectId, question, forecast: JSON.stringify(forecast),
      origin: (input.origin ?? 'tool').slice(0, 20), resolvesAt, outcome: '{}', resolvedAt: null, score: null, status: 'open', createdAt: nowIso(),
    };
    await this.db.insert(orgPredictions).values(row);
    await this.audit.append(orgId, { actor: `agent:${input.agentId}`, action: 'forecast', refType: 'prediction', refId: row.id, payload: { subjectKind, subjectId, forecast, resolvesAt, origin: row.origin } });
    return row;
  }

  /** A check-in with a confidence on a sourced key result, by an agent, is a probability forecast. */
  private async onCheckIn(orgId: string, goal: { id: string; title: string; metricSourceId: string | null; dueAt: string | null; ownerAgentId: string | null }, checkin: { actor: string; confidence: number | null }): Promise<void> {
    if (checkin.confidence === null || checkin.confidence === undefined || !goal.metricSourceId || !goal.dueAt) return;
    const org = await this.org.get(orgId);
    const agentId = checkin.actor === 'chief' ? org.chiefOfStaffAgentId : checkin.actor.startsWith('agent:') ? checkin.actor.slice('agent:'.length) : null;
    if (!agentId) return;
    await this.record(orgId, { agentId, subjectKind: 'key_result', subjectId: goal.id, question: `"${goal.title}" reaches its target by ${goal.dueAt.slice(0, 10)}`, forecast: { kind: 'probability', value: checkin.confidence }, resolvesAt: goal.dueAt, origin: 'checkin' })
      .catch((err) => this.logger.warn(`check-in forecast not recorded: ${err instanceof Error ? err.message : err}`));
  }

  // ---- resolution (model-free) ----

  async tick(now: Date = this.now()): Promise<void> {
    if (!this.enabled()) return;
    const one = async () => {
      for (const org of await this.org.list()) {
        if (org.status !== 'active') continue;
        await this.sweep(org.id, now).catch((err) => this.logger.warn(`prediction sweep for org ${org.id} failed: ${err instanceof Error ? err.message : err}`));
      }
    };
    if (!this.accounts) return one();
    await this.accounts.forEachAccount(one);
  }

  /** Resolve every open forecast whose subject has settled. */
  async sweep(orgId: string, now: Date = this.now()): Promise<{ resolved: number; voided: number }> {
    let resolved = 0, voided = 0;
    for (const p of await this.list(orgId, { status: 'open', limit: 1_000 })) {
      const r = await this.resolveOne(orgId, p, now).catch(() => null);
      if (r === 'resolved') resolved++; else if (r === 'void') voided++;
    }
    return { resolved, voided };
  }

  /** Resolve the open forecasts of one subject now (an experiment just decided). */
  async resolveSubject(orgId: string, subjectKind: SubjectKind, subjectId: string, now: Date = this.now()): Promise<void> {
    for (const p of await this.list(orgId, { status: 'open', subjectKind, subjectId })) await this.resolveOne(orgId, p, now);
  }

  private async resolveOne(orgId: string, p: OrgPrediction, now: Date): Promise<'resolved' | 'void' | null> {
    const f = parseObj(p.forecast) as unknown as Forecast;
    const due = p.resolvesAt && p.resolvesAt <= now.toISOString();
    switch (p.subjectKind) {
      case 'task': {
        const t = await this.tasks.get(orgId, p.subjectId).catch(() => null);
        if (!t || t.status === 'cancelled') return this.settle(p, null, { reason: t ? 'task cancelled' : 'task deleted' });
        const done = t.status === 'done';
        if (f.kind === 'probability') {
          if (done) return this.settle(p, brier(Number(f.value), !p.resolvesAt || t.updatedAt <= p.resolvesAt ? 1 : 0), { done: true, doneAt: t.updatedAt, value: !p.resolvesAt || t.updatedAt <= p.resolvesAt ? 1 : 0 }, Number(f.value) - (!p.resolvesAt || t.updatedAt <= p.resolvesAt ? 1 : 0));
          if (due) return this.settle(p, brier(Number(f.value), 0), { done: false, value: 0 }, Number(f.value));
          return null;
        }
        if (!done) return null;
        if (f.kind === 'duration_runs') {
          const runs = (await this.tasks.runs(orgId, { taskId: t.id, limit: 500 })).filter((r) => r.agentId === (t.assigneeAgentId ?? p.agentId) && r.status !== 'refused');
          const actual = Math.max(1, runs.length);
          return this.settle(p, nae(Number(f.value), actual), { value: actual, runs: runs.length }, signedError('duration_runs', Number(f.value), actual));
        }
        if (f.kind === 'date') {
          const t0 = Date.parse(p.createdAt);
          const fd = (Date.parse(String(f.value)) - t0) / DAY;
          const ad = (Date.parse(t.updatedAt) - t0) / DAY;
          return this.settle(p, nae(fd, ad), { value: t.updatedAt }, signedError('date', fd, ad));
        }
        return this.settle(p, null, { reason: 'no model-free resolution for this kind' });
      }
      case 'key_result': {
        if (!due) return null;
        const g = (await this.org.goals(orgId)).find((x) => x.id === p.subjectId);
        if (!g) return this.settle(p, null, { reason: 'key result deleted' });
        if (!g.metricSourceId) return this.settle(p, null, { reason: 'self-reported key result: no measured value to score against' });
        const sample = (await this.db.select().from(orgMetricSamples).where(and(eq(orgMetricSamples.sourceId, g.metricSourceId), lte(orgMetricSamples.observedAt, p.resolvesAt!))).orderBy(desc(orgMetricSamples.observedAt)).limit(1)).at(0);
        if (!sample) return this.settle(p, null, { reason: 'no sample at or before the resolution date' });
        if (f.kind === 'probability') {
          const start = g.startValue ?? 0;
          const target = g.targetValue ?? 0;
          const reached: 0 | 1 = (target >= start ? sample.value >= target : sample.value <= target) ? 1 : 0;
          return this.settle(p, brier(Number(f.value), reached), { value: reached, measured: sample.value, sampleId: sample.id, target }, Number(f.value) - reached);
        }
        return this.settle(p, nae(Number(f.value), sample.value), { value: sample.value, sampleId: sample.id }, signedError('number', Number(f.value), sample.value));
      }
      case 'experiment': {
        const e = (await this.db.select().from(orgExperiments).where(and(eq(orgExperiments.orgId, orgId), eq(orgExperiments.id, p.subjectId))).limit(1)).at(0);
        if (!e) return this.settle(p, null, { reason: 'experiment deleted' });
        if (e.status === 'abandoned') return this.settle(p, null, { reason: 'experiment abandoned' });
        if (e.status !== 'kept' && e.status !== 'reverted') return null;
        const res = parseObj(e.result);
        if (f.kind === 'probability') { const kept: 0 | 1 = e.status === 'kept' ? 1 : 0; return this.settle(p, brier(Number(f.value), kept), { value: kept, status: e.status }, Number(f.value) - kept); }
        const raw = f.unit === 'absolute' ? Number(res.delta) : res.relative === null || res.relative === undefined ? NaN : Number(res.relative);
        if (!Number.isFinite(raw)) return this.settle(p, null, { reason: 'no measured effect' });
        return this.settle(p, nae(Number(f.value), raw), { value: raw, verdict: res.verdict }, signedError('number', Number(f.value), raw));
      }
      default:
        return due ? this.settle(p, null, { reason: `a ${p.subjectKind} forecast has no model-free resolution` }) : null;
    }
  }

  private async settle(p: OrgPrediction, score: number | null, outcome: Record<string, unknown>, signed?: number): Promise<'resolved' | 'void'> {
    const status = score === null ? 'void' : 'resolved';
    const out = { ...outcome, ...(signed !== undefined ? { signed: round(signed) } : {}) };
    await this.db.update(orgPredictions).set({ status, score, outcome: JSON.stringify(out), resolvedAt: nowIso() }).where(eq(orgPredictions.id, p.id));
    await this.audit.append(p.orgId, { actor: 'system', action: status === 'resolved' ? 'forecast_resolved' : 'forecast_void', refType: 'prediction', refId: p.id, payload: { agentId: p.agentId, subjectKind: p.subjectKind, subjectId: p.subjectId, score, outcome: out } });
    return status;
  }

  // ---- calibration ----

  /** One member's calibration from its last N resolved forecasts. */
  async calibration(orgId: string, agentId: string, org?: Organization): Promise<Omit<CalibrationReport, 'name'>> {
    const o = org ?? await this.org.get(orgId);
    const n = experimentTunable(o, 'predictions.calibrationWindow');
    const min = experimentTunable(o, 'predictions.calibrationMinCount');
    const rows = await this.db.select().from(orgPredictions).where(and(eq(orgPredictions.orgId, orgId), eq(orgPredictions.agentId, agentId))).orderBy(desc(orgPredictions.resolvedAt));
    const resolved = rows.filter((r) => r.status === 'resolved' && r.score !== null).slice(0, n);
    const open = rows.filter((r) => r.status === 'open').length;
    const probs = resolved.filter((r) => parseObj(r.forecast).kind === 'probability');
    const brierMean = probs.length ? round(probs.reduce((a, r) => a + (r.score ?? 0), 0) / probs.length) : null;
    const signed = resolved.map((r) => Number(parseObj(r.outcome).signed)).filter((x) => Number.isFinite(x));
    const bias = signed.length ? round(signed.reduce((a, x) => a + x, 0) / signed.length) : null;
    const enough = resolved.length >= min;
    const calibration = enough ? round(1 - resolved.reduce((a, r) => a + (r.score ?? 0), 0) / resolved.length) : null;
    return { agentId, resolved: resolved.length, open, brier: brierMean, calibration, bias, biasLabel: bias === null ? null : bias > 0.1 ? 'over' : bias < -0.1 ? 'under' : 'balanced' };
  }

  /** The calibration registry's provider (the trust ledger, item 28). */
  async calibrationOf(workspaceId: string, agentId: string): Promise<number | null> {
    const org = await this.org.byWorkspace(workspaceId).catch(() => null);
    if (!org) return null;
    return (await this.calibration(org.id, agentId, org)).calibration;
  }

  /** `GET …/org/calibration`: every live member. */
  async report(orgId: string): Promise<CalibrationReport[]> {
    const org = await this.org.get(orgId);
    const names = new Map((await this.agents.list()).map((a) => [a.id, a.name]));
    const out: CalibrationReport[] = [];
    for (const m of (await this.org.members(orgId)).filter((x) => x.status !== 'terminated')) out.push({ name: names.get(m.agentId) ?? m.agentId.slice(0, 8), ...(await this.calibration(orgId, m.agentId, org)) });
    return out;
  }

  /** The chief's "Calibration" line: whose estimates to discount. */
  async briefLines(orgId: string): Promise<string[]> {
    const rows = (await this.report(orgId)).filter((r) => r.calibration !== null);
    if (rows.length === 0) return [];
    // The trust ledger's bar (item 28) when registered: the same line promotion uses.
    const org = await this.org.get(orgId);
    const bar = TUNABLES['trust.calibrationBar'] ? tunable(org, 'trust.calibrationBar') : 0.7;
    const line = rows.sort((a, b) => (a.calibration ?? 0) - (b.calibration ?? 0)).map((r) => `${r.name} ${Math.round((r.calibration ?? 0) * 100)}% (${r.resolved}${r.biasLabel && r.biasLabel !== 'balanced' ? `, ${r.biasLabel}-forecasts` : ''})`).join('; ');
    const discount = rows.filter((r) => (r.calibration ?? 0) < bar).map((r) => r.name);
    return ['## Calibration', `- ${line}.${discount.length ? ` Discount the estimates of ${discount.join(', ')}.` : ' Every scored member is calibrated.'}`];
  }

  // ---- ToolProviderHook ----

  async specsFor(session: ChatSession): Promise<AiToolSpec[]> {
    if (!this.enabled() || !session.agentId) return [];
    const restricted = this.runtime?.runningCtx(session.id);
    if (restricted?.audit || restricted?.aux?.restrict) return [];
    const memberships = (await this.org.membershipsOf(session.agentId)).filter((m) => m.status === 'active');
    if (memberships.length === 0) return [];
    for (const m of memberships) {
      const o = await this.org.get(m.orgId).catch(() => null);
      if (o?.chiefOfStaffAgentId === session.agentId || (this.units && await this.units.isLead(m.orgId, session.agentId))) return [FORECAST_TOOL, CALIBRATION_TOOL];
    }
    return [FORECAST_TOOL];
  }

  owns(name: string): boolean { return TOOL_NAMES.has(name); }

  /** A forecast is a ledger row about the forecaster; it changes nothing else. */
  isReadOnly(name: string): boolean { return TOOL_NAMES.has(name); }

  /** A task run's first wake: ask its assignee for a duration forecast once. */
  async contextFor(session: ChatSession): Promise<string | null> {
    if (!this.enabled() || !session.agentId) return null;
    const ctx = this.runtime?.runningCtx(session.id);
    if (!ctx || !ctx.taskId || ctx.reviewer || ctx.audit || ctx.agentId !== session.agentId) return null;
    const t = await this.tasks.get(ctx.orgId, ctx.taskId).catch(() => null);
    if (!t || t.assigneeAgentId !== session.agentId) return null;
    const mine = await this.list(ctx.orgId, { agentId: session.agentId, subjectKind: 'task', subjectId: t.id, limit: 5 });
    if (mine.some((p) => parseObj(p.forecast).kind === 'duration_runs')) return null;
    const runs = (await this.tasks.runs(ctx.orgId, { taskId: t.id, limit: 10 })).filter((r) => r.agentId === session.agentId);
    if (runs.length > 1) return null;
    return `## Forecast (once)\nBefore you start [${t.id.slice(0, 8)}] "${t.title}": how many runs (wakes, this one included) will it take you to get it accepted? Record it with org_forecast_outcome {subject: {kind: "task", id: "${t.id.slice(0, 8)}"}, question: "runs to done", forecast: {kind: "duration_runs", value: N}}. It is scored against the actual runs; your calibration tells the chief whose estimates to trust.`;
  }

  async execute(session: ChatSession, name: string, input: Record<string, unknown>): Promise<string> {
    if (!this.enabled()) throw new Error('organizations are disabled on this server');
    const agentId = session.agentId!;
    const org = await this.resolveOrg(agentId, input.org);
    if (org.status !== 'active') throw new Error(`"${org.name}" is paused by the CEO`);
    const ctx = this.runtime?.runningCtx(session.id);
    if (name === 'org_calibration') {
      const lead = org.chiefOfStaffAgentId === agentId || (this.units ? await this.units.isLead(org.id, agentId) : null);
      if (!lead) throw new Error('org_calibration is for the chief of staff and unit leads');
      const rows = await this.report(org.id);
      return rows.map((r) => `- ${r.name}: ${r.resolved} resolved, ${r.open} open; ${r.calibration === null ? 'no calibration yet (too few resolved)' : `calibration ${Math.round(r.calibration * 100)}%`}${r.brier !== null ? `, Brier ${r.brier.toFixed(3)}` : ''}${r.biasLabel ? `, bias ${r.biasLabel}` : ''}`).join('\n') || 'No members.';
    }
    if (name === 'org_forecast_outcome') {
      const subject = input.subject && typeof input.subject === 'object' ? input.subject as Record<string, unknown> : {};
      const forecast = input.forecast && typeof input.forecast === 'object' ? input.forecast as Record<string, unknown> : {};
      const subjectKind = String(subject.kind ?? '');
      let subjectId = String(subject.id ?? '').trim();
      if (!subjectId && subjectKind === 'task' && ctx?.taskId) subjectId = ctx.taskId;
      if (ctx?.plan?.dryRun && !ctx.applying) return 'Recorded (dry run, nothing applied): forecast.';
      const row = await this.record(org.id, { agentId, subjectKind, subjectId, question: String(input.question ?? ''), forecast, resolvesAt: typeof input.resolvesAt === 'string' ? input.resolvesAt : null, origin: 'tool' })
        .catch((err: unknown) => { throw new Error(`refused: ${err instanceof Error ? err.message : String(err)}`); });
      const f = parseObj(row.forecast);
      return `Forecast [${row.id.slice(0, 8)}] recorded: ${row.question} — ${String(f.kind)} ${String(f.value)}${row.resolvesAt ? `, judged ${row.resolvesAt.slice(0, 10)}` : ', judged when it settles'}. It is scored against what the record shows, model-free.`;
    }
    throw new Error(`unknown tool: ${name}`);
  }

  private async resolveOrg(agentId: string, orgHint: unknown): Promise<Organization> {
    const memberships = (await this.org.membershipsOf(agentId)).filter((m) => m.status === 'active');
    if (memberships.length === 0) throw new Error('you do not belong to an organization');
    if (typeof orgHint === 'string' && orgHint.trim()) {
      const q = orgHint.trim().toLowerCase();
      for (const m of memberships) { const o = await this.org.get(m.orgId).catch(() => null); if (o && (o.id === q || o.id.startsWith(q) || o.name.toLowerCase() === q)) return o; }
      throw new Error(`no organization "${orgHint}"`);
    }
    if (memberships.length > 1) throw new Error(`you belong to ${memberships.length} organizations — pass org: <name>`);
    return this.org.get(memberships[0].orgId);
  }

  async get(orgId: string, id: string): Promise<OrgPrediction> {
    const r = (await this.db.select().from(orgPredictions).where(and(eq(orgPredictions.orgId, orgId), eq(orgPredictions.id, id))).limit(1)).at(0);
    if (!r) throw new NotFoundException(`prediction ${id}`);
    return r;
  }
}

/** Validate a forecast's shape (pure). */
export function normalizeForecast(raw: Record<string, unknown>): Forecast {
  const kind = String(raw.kind ?? '') as ForecastKind;
  if (!FORECAST_KINDS.includes(kind)) throw new BadRequestException(`forecast.kind must be one of ${FORECAST_KINDS.join(', ')}`);
  const out: Forecast = { kind, value: 0 };
  if (kind === 'date') out.value = isoOrThrow(String(raw.value ?? ''), 'forecast.value');
  else {
    const v = Number(raw.value);
    if (!Number.isFinite(v)) throw new BadRequestException('forecast.value must be a number');
    if (kind === 'probability' && (v < 0 || v > 1)) throw new BadRequestException('a probability is 0–1');
    if (kind === 'duration_runs' && (v < 1 || v > 1_000)) throw new BadRequestException('duration_runs is a run count, 1–1000');
    out.value = kind === 'duration_runs' ? Math.round(v) : v;
  }
  for (const k of ['low', 'high'] as const) if (raw[k] !== undefined && Number.isFinite(Number(raw[k]))) out[k] = Number(raw[k]);
  if (typeof raw.unit === 'string' && ['relative', 'absolute'].includes(raw.unit)) out.unit = raw.unit;
  return out;
}

function isoOrThrow(v: string, what: string): string {
  const t = Date.parse(v);
  if (!Number.isFinite(t)) throw new BadRequestException(`${what} must be an ISO date`);
  return new Date(t).toISOString();
}
function round(x: number): number { return Math.round(x * 1e6) / 1e6; }
function parseObj(raw: string | null | undefined): Record<string, unknown> {
  try { const v = JSON.parse(raw || '{}') as unknown; return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}; } catch { return {}; }
}
