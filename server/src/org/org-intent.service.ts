/**
 * OrgIntentService — the intent cascade's state (docs/company-vision.md §2,
 * execution-plan item 18): the vision, key results with metric / target /
 * owner / due date, check-ins, model-free pace and at-risk assessment, the
 * why chain and the intent tree.
 *
 * Goals (org_goals) carry a `kind`: one active *vision* per organization
 * (its horizon in dueAt, the CEO's standing rules on organizations.rules),
 * *objectives* under it, *key results* under objectives. A key result is
 * measured from startValue to targetValue by dueAt; its owner checks in a
 * current value and a confidence (0–1) on a cadence (7 days by default),
 * each check-in a row of org_checkins and the latest mirrored on the goal.
 *
 * Nothing here calls a model. `paceOf` compares the linear expectation
 * between createdAt and dueAt with the measured progress; `assessRisk` flags a
 * key result when it is behind pace by more than 15 points, its owner is
 * missing / paused / terminated, its confidence dropped on two consecutive
 * check-ins, or its check-in is overdue by twice the cadence, and an
 * objective when two or more of its key results are; transitions are audited
 * (`goal_at_risk`, `goal_risk_cleared`) and the daily wake of the unit lead
 * is deduplicated per goal through the audit log (`goal_at_risk_wake`), so a
 * restart never wakes twice. Planning runs themselves live in
 * OrgRuntimeService, which subscribes to `onIntent` for the cascade.
 */
import { BadRequestException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { orgCheckins, orgGoals, orgMetricSources, organizations, orgProjects, orgTasks } from '../database/schema';
import { newId, nowIso } from '../common/ids.util';
import { currentAccountId } from '../accounts/account-context';
import { TriggerBus } from '../chats/trigger-bus';
import { AgentsService } from '../agents/agents.service';
import { OrgService, type OrgGoal, type Organization } from './org.service';
import { OrgUnitsService, blendProgress, type GoalNode } from './org-units.service';
import { OrgAuditService } from './org-audit.service';
import { tunable } from './org-tunables';

export type OrgCheckin = typeof orgCheckins.$inferSelect;
export type Pace = 'onPace' | 'behind' | 'unknown';

/** Defaults of the §2.4 thresholds; the per-org values come from
 *  org-tunables.ts (`intent.*`) and are passed in by the callers. */
export const PACE_TOLERANCE = 0.15;
export const OVERDUE_CADENCES = 2;

export interface PaceInfo {
  pace: Pace;
  /** Linear expectation at `now` (0–1), null without a target or due date. */
  expected: number | null;
  /** Measured progress from the latest check-in (0–1), null when never checked in. */
  measured: number | null;
}

export interface IntentEvent {
  type: 'vision_set' | 'objective_assigned' | 'at_risk';
  orgId: string;
  /** The unit whose lead should plan (the root for a vision). */
  unitId: string;
  goalId: string;
  detail: string;
}
export type IntentListener = (ev: IntentEvent) => void;
/** Told after every key-result check-in is written (the prediction ledger,
 *  docs/experiments.md §2: a confidence is a probability forecast). */
export type CheckInListener = (ev: { orgId: string; goal: OrgGoal; checkin: OrgCheckin }) => Promise<void> | void;

export interface RiskVerdict { goal: OrgGoal; atRisk: boolean; reasons: string[] }
export interface RiskAssessment {
  keyResults: RiskVerdict[];
  objectives: RiskVerdict[];
  /** Goals that flipped to at risk in this pass. */
  newlyAtRisk: OrgGoal[];
  /** Two or more objectives at risk: the CEO's decision line in the brief. */
  visionAtRisk: boolean;
}

export interface WhyLink { kind: 'task' | 'vision' | 'objective' | 'key_result'; id: string; title: string; status: string }
export interface WhyChain {
  chain: WhyLink[];
  /** True when a link was abandoned or cancelled: the work has lost its why. */
  broken: boolean;
  brokenAt: string | null;
  /** False when the task is linked to no goal at all. */
  linked: boolean;
}

/** Sensing (docs/sensing.md §2): the source a key result is measured by. */
export interface MeasuredBy { sourceId: string; name: string; kind: string; lastFetchedAt: string | null; status: string }

export interface IntentNode extends GoalNode {
  /** Key results only: the metric source, or null when self-reported. */
  measuredBy: MeasuredBy | null;
  /** Key results only: true when no source measures it (check-ins are the value). */
  selfReported: boolean;
  pace: Pace;
  expected: number | null;
  measured: number | null;
  ownerName: string | null;
  children: IntentNode[];
}

/** The §2.4 pace rule, pure so the test can pin it. */
export function paceOf(g: Pick<OrgGoal, 'status' | 'targetValue' | 'startValue' | 'currentValue' | 'dueAt' | 'createdAt'>, now: Date = new Date(), tolerance = PACE_TOLERANCE): PaceInfo {
  if (g.status === 'achieved') return { pace: 'onPace', expected: 1, measured: 1 };
  const measured = measuredProgress(g);
  if (g.targetValue === null || g.targetValue === undefined || !g.dueAt) return { pace: 'unknown', expected: null, measured };
  const t0 = Date.parse(g.createdAt); const t1 = Date.parse(g.dueAt);
  if (!Number.isFinite(t0) || !Number.isFinite(t1)) return { pace: 'unknown', expected: null, measured };
  const expected = t1 <= t0 ? 1 : clamp01((now.getTime() - t0) / (t1 - t0));
  if (measured === null) return { pace: 'unknown', expected, measured };
  return { pace: measured < expected - tolerance ? 'behind' : 'onPace', expected, measured };
}

/** (current − start) / (target − start), clamped; null without a check-in or a span. */
export function measuredProgress(g: Pick<OrgGoal, 'targetValue' | 'startValue' | 'currentValue'>): number | null {
  if (g.currentValue === null || g.currentValue === undefined || g.targetValue === null || g.targetValue === undefined) return null;
  const start = g.startValue ?? 0;
  const span = g.targetValue - start;
  if (span === 0) return g.currentValue >= g.targetValue ? 1 : 0;
  return clamp01((g.currentValue - start) / span);
}

function clamp01(x: number): number { return Math.min(1, Math.max(0, x)); }

@Injectable()
export class OrgIntentService {
  private readonly listeners: IntentListener[] = [];
  private readonly checkInListeners: CheckInListener[] = [];

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly org: OrgService,
    private readonly units: OrgUnitsService,
    private readonly agents: AgentsService,
    private readonly audit: OrgAuditService,
    @Optional() private readonly bus?: TriggerBus,
  ) {
    this.org.onGoalChange((goal, before) => this.onGoalChange(goal, before));
  }

  /** The runtime subscribes: a vision, an objective handed to a unit, a risk. */
  onIntent(listener: IntentListener): () => void {
    this.listeners.push(listener);
    return () => { const i = this.listeners.indexOf(listener); if (i >= 0) this.listeners.splice(i, 1); };
  }

  /** Be told of every check-in (see CheckInListener). */
  onCheckIn(fn: CheckInListener): () => void {
    this.checkInListeners.push(fn);
    return () => { const i = this.checkInListeners.indexOf(fn); if (i >= 0) this.checkInListeners.splice(i, 1); };
  }

  private emit(ev: IntentEvent): void {
    for (const l of this.listeners) { try { l(ev); } catch { /* a listener never breaks the write */ } }
  }

  /** The cascade rule (docs/company-vision.md §2.2): an objective whose unit
   *  is set to a non-root unit — on creation or by a later move — queues a
   *  planning run for that unit. */
  private async onGoalChange(goal: OrgGoal, before: OrgGoal | null): Promise<void> {
    if (goal.kind !== 'objective' || goal.status !== 'active' || !goal.unitId) return;
    if (before && before.unitId === goal.unitId && before.kind === goal.kind && before.status === goal.status) return;
    const root = await this.units.rootUnit(goal.orgId).catch(() => null);
    if (!root || goal.unitId === root.id) return;
    this.emit({ type: 'objective_assigned', orgId: goal.orgId, unitId: goal.unitId, goalId: goal.id, detail: `objective "${goal.title}" handed to the unit` });
  }

  // ---- the vision ----

  async vision(orgId: string): Promise<OrgGoal | null> {
    return (await this.org.goals(orgId)).find((g) => g.kind === 'vision' && g.status === 'active') ?? null;
  }

  /** Write or revise the vision (CEO only, through the API): one paragraph,
   *  a horizon (dueAt), the standing rules, optionally the company envelope.
   *  A new vision — or a revised one — queues root planning. */
  async setVision(orgId: string, input: { title: string; description?: string; dueAt?: string | null; rules?: string; monthlyUsd?: number }, actor = 'user'): Promise<{ vision: OrgGoal; org: Organization }> {
    const title = (input.title ?? '').trim().slice(0, 200);
    if (!title) throw new BadRequestException('the vision needs a title (one line)');
    if (input.dueAt && !Number.isFinite(Date.parse(input.dueAt))) throw new BadRequestException('dueAt must be an ISO date');
    const root = await this.units.rootUnit(orgId);
    const existing = await this.vision(orgId);
    const vision = existing
      ? await this.org.updateGoal(orgId, existing.id, { title, description: input.description ?? existing.description, dueAt: input.dueAt === undefined ? existing.dueAt : input.dueAt }, actor)
      : await this.org.addGoal(orgId, { title, description: input.description ?? '', kind: 'vision', unitId: root.id, dueAt: input.dueAt ?? null }, actor);
    const set: Record<string, unknown> = {};
    if (input.rules !== undefined) set.rules = input.rules.slice(0, 8_000);
    if (Object.keys(set).length > 0) await this.db.update(organizations).set(set).where(eq(organizations.id, orgId));
    if (input.monthlyUsd !== undefined) await this.org.setBudget(orgId, { scope: 'company', refId: orgId, monthlyUsd: input.monthlyUsd, actor });
    await this.audit.append(orgId, { actor, action: existing ? 'vision_revise' : 'vision_set', refType: 'goal', refId: vision.id, payload: { title, dueAt: vision.dueAt, rules: input.rules !== undefined, monthlyUsd: input.monthlyUsd } });
    this.emit({ type: 'vision_set', orgId, unitId: root.id, goalId: vision.id, detail: `${existing ? 'revised' : 'new'} vision "${title}"` });
    return { vision, org: await this.org.get(orgId) };
  }

  // ---- key results ----

  /** Create a key result under an objective. Goes through
   *  OrgUnitsService.addGoal, so the objective must be visible from the unit. */
  async setKeyResult(orgId: string, input: { title: string; objectiveId: string; metric?: string; targetValue: number; startValue?: number | null; unitLabel?: string; dueAt: string; ownerAgentId: string | null; checkInCadenceDays?: number; unitId?: string | null; description?: string }, actor = 'user'): Promise<OrgGoal> {
    const objective = await this.org.goal(orgId, input.objectiveId);
    if (objective.kind === 'key_result') throw new BadRequestException('a key result hangs under an objective (or the vision), not under another key result');
    if (!Number.isFinite(Number(input.targetValue))) throw new BadRequestException('targetValue must be a number');
    if (!input.dueAt || !Number.isFinite(Date.parse(input.dueAt))) throw new BadRequestException('dueAt must be an ISO date');
    const unitId = input.unitId ?? (input.ownerAgentId ? (await this.units.unitForAssignee(orgId, input.ownerAgentId)).id : objective.unitId);
    return this.units.addGoal(orgId, {
      title: input.title, description: input.description, ownerAgentId: input.ownerAgentId, unitId, parentGoalId: objective.id,
      kind: 'key_result', metric: input.metric ?? '', targetValue: Number(input.targetValue), startValue: input.startValue ?? 0, unitLabel: input.unitLabel ?? '', dueAt: new Date(input.dueAt).toISOString(), checkInCadenceDays: input.checkInCadenceDays,
    }, actor);
  }

  /** The owner's check-in (docs/company-vision.md §2.3): a row, and the
   *  latest value / confidence on the goal. */
  async checkIn(orgId: string, goalId: string, input: { currentValue?: number | null; confidence?: number | null; note?: string }, actor = 'user'): Promise<{ goal: OrgGoal; checkin: OrgCheckin }> {
    const g = await this.org.goal(orgId, goalId);
    if (g.kind !== 'key_result') throw new BadRequestException('check-ins are for key results');
    // Sensing (docs/sensing.md §2): a measured key result takes the owner's
    // confidence and note — the judged forecast — never a value.
    if (g.metricSourceId && input.currentValue !== undefined && input.currentValue !== null && Number(input.currentValue) !== g.currentValue) {
      const src = (await this.db.select().from(orgMetricSources).where(eq(orgMetricSources.id, g.metricSourceId)).limit(1)).at(0);
      throw new BadRequestException(`measured by ${src ? `"${src.name}" (${src.kind})` : 'a metric source'}: the current value comes only from its samples — check in your confidence and a note instead`);
    }
    if (g.metricSourceId) input = { ...input, currentValue: undefined };
    if (input.currentValue !== undefined && input.currentValue !== null && !Number.isFinite(Number(input.currentValue))) throw new BadRequestException('currentValue must be a number');
    if (input.confidence !== undefined && input.confidence !== null && (Number(input.confidence) < 0 || Number(input.confidence) > 1)) throw new BadRequestException('confidence is 0–1');
    const now = nowIso();
    const checkin: OrgCheckin = {
      accountId: currentAccountId(), id: newId(), orgId, goalId: g.id, actor,
      currentValue: input.currentValue === undefined ? g.currentValue : input.currentValue, confidence: input.confidence === undefined ? g.confidence : input.confidence,
      note: (input.note ?? '').slice(0, 2_000), createdAt: now,
    };
    await this.db.insert(orgCheckins).values(checkin);
    await this.audit.append(orgId, { actor, action: 'goal_checkin', refType: 'goal', refId: g.id, payload: { currentValue: checkin.currentValue, confidence: checkin.confidence, note: checkin.note.slice(0, 200) } });
    const goal = await this.org.updateGoal(orgId, g.id, { currentValue: checkin.currentValue, confidence: checkin.confidence, lastCheckInAt: now }, actor);
    for (const fn of this.checkInListeners) await Promise.resolve(fn({ orgId, goal, checkin })).catch(() => undefined);
    return { goal, checkin };
  }

  /** Sensing (docs/sensing.md §2): bind a key result to a live metric
   *  source — its currentValue is then the source's latest sample and only
   *  that — or unbind it (null: self-reported again; the last measured value
   *  stays). A source pending approval or rejected cannot be bound. */
  async bindSource(orgId: string, goalId: string, sourceRef: string | null, actor = 'user'): Promise<OrgGoal> {
    const g = await this.org.goal(orgId, goalId);
    if (g.kind !== 'key_result') throw new BadRequestException('only a key result is measured by a metric source');
    if (!sourceRef) {
      if (!g.metricSourceId) return g;
      await this.db.update(orgGoals).set({ metricSourceId: null }).where(eq(orgGoals.id, g.id));
      await this.audit.append(orgId, { actor, action: 'kr_source_unbind', refType: 'goal', refId: g.id, payload: { sourceId: g.metricSourceId } });
      return this.org.goal(orgId, g.id);
    }
    const q = sourceRef.trim();
    const sources = await this.db.select().from(orgMetricSources).where(eq(orgMetricSources.orgId, orgId));
    const hits = sources.filter((x) => x.id === q || x.id.startsWith(q) || x.name.toLowerCase() === q.toLowerCase());
    if (hits.length !== 1) throw new BadRequestException(`metric source "${q}" matches ${hits.length} sources`);
    const src = hits[0];
    if (!['ok', 'error', 'stale'].includes(src.status)) throw new BadRequestException(`metric source "${src.name}" is ${src.status.replace('_', ' ')} — only a live source measures a key result`);
    await this.db.update(orgGoals).set({ metricSourceId: src.id, ...(src.lastValue !== null ? { currentValue: src.lastValue, lastMeasuredAt: src.lastFetchedAt } : {}) }).where(eq(orgGoals.id, g.id));
    await this.audit.append(orgId, { actor, action: 'kr_source_bind', refType: 'goal', refId: g.id, payload: { sourceId: src.id, name: src.name, kind: src.kind, from: g.currentValue, to: src.lastValue } });
    return this.org.goal(orgId, g.id);
  }

  checkIns(orgId: string, goalId: string): Promise<OrgCheckin[]> {
    return this.db.select().from(orgCheckins).where(and(eq(orgCheckins.orgId, orgId), eq(orgCheckins.goalId, goalId))).then((rows) => rows.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)));
  }

  // ---- risk (model-free) ----

  /** Assess every active key result and objective; write transitions to the
   *  goals and the audit log. Pure data in, no model. */
  async assessRisk(orgId: string, now: Date = new Date()): Promise<RiskAssessment> {
    const org = await this.org.get(orgId);
    const tolerance = tunable(org, 'intent.paceTolerance');
    const drops = tunable(org, 'intent.confidenceDrops');
    const overdueCadences = tunable(org, 'intent.overdueCadences');
    const objectiveRiskCount = tunable(org, 'intent.objectiveRiskCount');
    const goals = await this.org.goals(orgId);
    const members = await this.org.members(orgId);
    const checkins = await this.db.select().from(orgCheckins).where(eq(orgCheckins.orgId, orgId));
    const byGoal = new Map<string, OrgCheckin[]>();
    for (const c of checkins) byGoal.set(c.goalId, [...(byGoal.get(c.goalId) ?? []), c]);
    for (const list of byGoal.values()) list.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    const keyResults: RiskVerdict[] = [];
    for (const g of goals.filter((x) => x.kind === 'key_result' && x.status === 'active')) {
      const reasons: string[] = [];
      const p = paceOf(g, now, tolerance);
      if (p.pace === 'behind') reasons.push(`behind pace: ${Math.round((p.measured ?? 0) * 100)}% done where ${Math.round((p.expected ?? 0) * 100)}% was expected`);
      const owner = g.ownerAgentId ? members.find((m) => m.agentId === g.ownerAgentId) : undefined;
      if (!g.ownerAgentId) reasons.push('no owner');
      else if (!owner || owner.status !== 'active') reasons.push(`owner is ${owner?.status ?? 'not a member'}`);
      const conf = (byGoal.get(g.id) ?? []).map((c) => c.confidence).filter((c): c is number => c !== null);
      const tail = conf.slice(-(drops + 1));
      if (tail.length === drops + 1 && tail.every((c, i) => i === 0 || c < tail[i - 1])) reasons.push(`confidence fell ${drops} time(s) in a row (${tail.map((c) => Math.round(c * 100) + '%').join(' → ')})`);
      const lastSeen = Date.parse(g.lastCheckInAt ?? g.createdAt);
      const overdueMs = overdueCadences * g.checkInCadenceDays * 24 * 60 * 60_000;
      if (Number.isFinite(lastSeen) && now.getTime() - lastSeen > overdueMs) reasons.push(`check-in overdue: ${g.lastCheckInAt ? `last ${Math.floor((now.getTime() - lastSeen) / 86_400_000)} days ago` : 'never'}, cadence ${g.checkInCadenceDays} day(s)`);
      keyResults.push({ goal: g, atRisk: reasons.length > 0, reasons });
    }
    const objectives: RiskVerdict[] = [];
    for (const g of goals.filter((x) => x.kind === 'objective' && x.status === 'active')) {
      const kids = keyResults.filter((k) => k.goal.parentGoalId === g.id && k.atRisk);
      const reasons = kids.length >= objectiveRiskCount ? [`${kids.length} key results at risk: ${kids.map((k) => `"${k.goal.title}"`).join(', ')}`] : [];
      objectives.push({ goal: g, atRisk: reasons.length > 0, reasons });
    }
    const newlyAtRisk: OrgGoal[] = [];
    for (const v of [...keyResults, ...objectives]) {
      const was = v.goal.atRisk === 1;
      const reason = v.reasons.join('; ').slice(0, 600);
      if (v.atRisk && (!was || v.goal.atRiskReason !== reason)) {
        await this.org.updateGoal(orgId, v.goal.id, { atRisk: 1, atRiskReason: reason }, 'system');
        if (!was) { newlyAtRisk.push(v.goal); await this.audit.append(orgId, { actor: 'system', action: 'goal_at_risk', refType: 'goal', refId: v.goal.id, payload: { kind: v.goal.kind, reasons: v.reasons } }); }
      } else if (!v.atRisk && was) {
        await this.org.updateGoal(orgId, v.goal.id, { atRisk: 0, atRiskReason: '' }, 'system');
        await this.audit.append(orgId, { actor: 'system', action: 'goal_risk_cleared', refType: 'goal', refId: v.goal.id, payload: { kind: v.goal.kind } });
      }
    }
    return { keyResults, objectives, newlyAtRisk, visionAtRisk: objectives.filter((o) => o.atRisk).length >= objectiveRiskCount };
  }

  /** The minute tick's pass: assess, then wake the unit lead of every at-risk
   *  goal once per goal per day (audit `goal_at_risk_wake` is the backstop
   *  across restarts). An objective at risk is also a board event, so the
   *  autonomous chief reviews. */
  async sweepRisk(orgId: string, now: Date = new Date()): Promise<RiskAssessment> {
    const r = await this.assessRisk(orgId, now);
    const flagged = [...r.keyResults, ...r.objectives].filter((v) => v.atRisk);
    if (flagged.length === 0) return r;
    const today = now.toISOString().slice(0, 10);
    const wakes = await this.audit.list(orgId, { action: 'goal_at_risk_wake', limit: 200 });
    const wokenToday = new Set(wakes.filter((w) => w.createdAt.slice(0, 10) === today).map((w) => w.refId));
    const root = await this.units.rootUnit(orgId).catch(() => null);
    for (const v of flagged) {
      if (wokenToday.has(v.goal.id)) continue;
      await this.audit.append(orgId, { actor: 'system', action: 'goal_at_risk_wake', refType: 'goal', refId: v.goal.id, payload: { kind: v.goal.kind, reasons: v.reasons } });
      const unitId = v.goal.unitId ?? root?.id;
      if (unitId) this.emit({ type: 'at_risk', orgId, unitId, goalId: v.goal.id, detail: `${v.goal.kind.replace('_', ' ')} "${v.goal.title}" at risk: ${v.reasons.join('; ')}`.slice(0, 300) });
      if (v.goal.kind === 'objective') this.bus?.emitOrgBoard({ orgId, kind: 'goal', refId: v.goal.id, detail: `objective "${v.goal.title}" at risk: ${v.reasons[0] ?? ''}`.slice(0, 200) });
    }
    return r;
  }

  // ---- the why chain ----

  /** task → key result → objective → vision (or from a goal upward). */
  async whyChain(orgId: string, ref: { taskId?: string; goalId?: string }): Promise<WhyChain> {
    const goals = await this.org.goals(orgId);
    const chain: WhyLink[] = [];
    let goalId: string | null = ref.goalId ?? null;
    let linked = true;
    if (ref.taskId) {
      const t = (await this.db.select().from(orgTasks).where(and(eq(orgTasks.orgId, orgId), eq(orgTasks.id, ref.taskId))).limit(1)).at(0);
      if (!t) throw new NotFoundException(`task ${ref.taskId}`);
      chain.push({ kind: 'task', id: t.id, title: t.title, status: t.status });
      const project = t.projectId ? (await this.db.select().from(orgProjects).where(eq(orgProjects.id, t.projectId)).limit(1)).at(0) : undefined;
      goalId = project?.goalId ?? null;
      linked = Boolean(goalId);
    } else if (!goalId) throw new BadRequestException('taskId or goalId is required');
    for (let i = 0; goalId && i < 12; i++) {
      const g = goals.find((x) => x.id === goalId);
      if (!g) { if (i === 0 && !ref.taskId) throw new NotFoundException(`goal ${goalId}`); break; }
      chain.push({ kind: g.kind as WhyLink['kind'], id: g.id, title: g.title, status: g.status });
      goalId = g.parentGoalId;
    }
    const brokenLink = chain.find((l) => (l.kind === 'task' ? l.status === 'cancelled' : l.status === 'abandoned'));
    return { chain, broken: Boolean(brokenLink), brokenAt: brokenLink?.id ?? null, linked };
  }

  /** The why chain as one line for the model: "task → KR → objective → vision". */
  describeChain(w: WhyChain): string {
    const label = (l: WhyLink) => `${l.kind.replace('_', ' ')} [${l.id.slice(0, 8)}] "${l.title}"${l.status !== 'active' && l.status !== 'done' && l.status !== 'in_progress' && l.status !== 'todo' ? ` (${l.status})` : ''}`;
    const line = w.chain.map(label).join(' → ');
    if (!w.linked) return `${line} — not linked to any goal (no project with a goal); ask the chief where it belongs.`;
    return w.broken ? `${line} — BROKEN: a link was abandoned or cancelled; do not work this until it is re-homed.` : line;
  }

  // ---- the intent tree ----

  /** The goal tree with kind, pace, confidence, risk, owner and due date. A
   *  key result's progress is its measured value when it has a check-in
   *  (linked tasks otherwise); an objective blends its children (measured)
   *  with its own linked tasks through blendProgress. */
  async intentTree(orgId: string, opts: { unitId?: string | null; now?: Date } = {}): Promise<IntentNode[]> {
    const now = opts.now ?? new Date();
    const tolerance = tunable(await this.org.get(orgId), 'intent.paceTolerance');
    const names = new Map((await this.agents.list()).map((a) => [a.id, a.name]));
    const tree = await this.units.goalTree(orgId, { unitId: opts.unitId });
    const sources = new Map((await this.db.select().from(orgMetricSources).where(eq(orgMetricSources.orgId, orgId))).map((x) => [x.id, x]));
    const annotate = (n: GoalNode): IntentNode => {
      const children = n.children.map(annotate);
      const p = paceOf(n, now, tolerance);
      const progress = n.status === 'achieved' ? 1 : n.kind === 'key_result' && p.measured !== null ? p.measured : blendProgress(n.tasks, children.map((c) => c.progress));
      const src = n.metricSourceId ? sources.get(n.metricSourceId) : undefined;
      const measuredBy: MeasuredBy | null = src ? { sourceId: src.id, name: src.name, kind: src.kind, lastFetchedAt: src.lastFetchedAt, status: src.status } : null;
      return { ...n, progress, measuredBy, selfReported: n.kind === 'key_result' && !measuredBy, pace: p.pace, expected: p.expected, measured: p.measured, ownerName: n.ownerAgentId ? names.get(n.ownerAgentId) ?? n.ownerAgentId.slice(0, 8) : null, children };
    };
    return tree.map(annotate);
  }

  /** The tree as text for the model (org_intent) and the planning prompt. */
  async describeTree(orgId: string, opts: { unitId?: string | null; now?: Date } = {}): Promise<string> {
    const tree = await this.intentTree(orgId, opts);
    if (tree.length === 0) return 'No vision, objectives or key results yet.';
    const lines: string[] = [];
    const walk = (nodes: IntentNode[], depth: number) => {
      for (const g of nodes) {
        const kr = g.kind === 'key_result' ? ` ${g.metric || 'metric'}: ${fmt(g.currentValue ?? g.startValue)} → ${fmt(g.targetValue)}${g.unitLabel ? ` ${g.unitLabel}` : ''}; pace ${g.pace}${g.confidence !== null ? `, confidence ${Math.round(g.confidence * 100)}%` : ', never checked in'}; ${g.measuredBy ? `measured by "${g.measuredBy.name}" (${g.measuredBy.status})` : 'self-reported'}` : '';
        lines.push(`${'  '.repeat(depth)}- ${g.kind.replace('_', ' ')} [${g.id.slice(0, 8)}] (${g.status}${g.atRisk ? ', AT RISK' : ''}) ${g.title} — ${Math.round(g.progress * 100)}%${g.ownerName ? `, owner ${g.ownerName}` : ''}${g.dueAt ? `, due ${g.dueAt.slice(0, 10)}` : ''}${kr}${g.atRisk ? ` — ${g.atRiskReason}` : ''}`);
        walk(g.children, depth + 1);
      }
    };
    walk(tree, 0);
    return lines.join('\n');
  }

  /** The brief's "Key results" section: counts and the top at-risk items. */
  async summary(orgId: string, now: Date = new Date()): Promise<{ total: number; onPace: number; behind: number; unknown: number; selfReported: number; atRisk: Array<{ goal: OrgGoal; ownerName: string }>; objectivesAtRisk: OrgGoal[]; visionAtRisk: boolean }> {
    const org = await this.org.get(orgId);
    const goals = await this.org.goals(orgId);
    const names = new Map((await this.agents.list()).map((a) => [a.id, a.name]));
    const krs = goals.filter((g) => g.kind === 'key_result' && g.status === 'active');
    const paces = krs.map((g) => paceOf(g, now, tunable(org, 'intent.paceTolerance')).pace);
    const atRisk = krs.filter((g) => g.atRisk === 1).sort((a, b) => (a.dueAt ?? '') < (b.dueAt ?? '') ? -1 : 1).slice(0, 5).map((goal) => ({ goal, ownerName: goal.ownerAgentId ? names.get(goal.ownerAgentId) ?? goal.ownerAgentId.slice(0, 8) : 'nobody' }));
    const objectivesAtRisk = goals.filter((g) => g.kind === 'objective' && g.status === 'active' && g.atRisk === 1);
    return { total: krs.length, selfReported: krs.filter((g) => !g.metricSourceId).length, onPace: paces.filter((p) => p === 'onPace').length, behind: paces.filter((p) => p === 'behind').length, unknown: paces.filter((p) => p === 'unknown').length, atRisk, objectivesAtRisk, visionAtRisk: objectivesAtRisk.length >= tunable(org, 'intent.objectiveRiskCount') };
  }

  // ---- the strategy memo ----

  async setStrategyMemo(orgId: string, text: string, actor = 'chief'): Promise<Organization> {
    const memo = (text ?? '').trim().slice(0, 8_000);
    if (!memo) throw new BadRequestException('the memo needs text');
    await this.org.get(orgId);
    await this.db.update(organizations).set({ strategyMemo: memo, strategyMemoAt: nowIso() }).where(eq(organizations.id, orgId));
    await this.audit.append(orgId, { actor, action: 'strategy_memo', refType: 'org', refId: orgId, payload: { chars: memo.length, head: memo.slice(0, 200) } });
    return this.org.get(orgId);
  }

  async strategy(orgId: string): Promise<{ memo: string; at: string | null }> {
    const org = await this.org.get(orgId);
    return { memo: org.strategyMemo, at: org.strategyMemoAt };
  }
}

function fmt(v: number | null | undefined): string {
  return v === null || v === undefined ? '?' : Number.isInteger(v) ? String(v) : v.toFixed(2);
}
