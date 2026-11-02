/**
 * OrgExperimentsService — improvement as experiments (docs/experiments.md §1,
 * execution-plan item 30; C5 of docs/autonomous-org-first-principles.md).
 *
 * An experiment is a change declared as a hypothesis: what to change (a
 * tunable, a cadence, a routing tier, a playbook's activation, a charter, the
 * structure, or `other`), the metric source it should move, the direction and
 * the expected effect, a window and a revert rule. Nothing here calls a model:
 *
 *  - **Propose** (`org_propose_experiment`, chief and unit leads; the CEO
 *    through `POST …/org/experiments`) validates a measured metric (a live
 *    source, or a key result's), the window within the tunable's bounds and a
 *    revert recipe the system can execute — tunable, cadence, routing and
 *    playbook changes are applied and undone by the system; charter and
 *    structure changes (and their reverts) go through the existing approval
 *    cards. The proposer's expected effect is recorded as a forecast.
 *  - **Governance.** Supervised: an `experiment` card the CEO decides.
 *    Autonomous: tunable / cadence / routing / playbook / other experiments
 *    start at once within bounds; charter and structure experiments are held
 *    in a plan for item 23's veto window (`org_start_experiment` in
 *    `org_plans`), then their change card goes to the CEO. At most
 *    `experiments.concurrentPerUnit` run at once per unit.
 *  - **Start** snapshots the baseline from the source's samples over the
 *    previous window (at least `experiments.minSamples`) and applies the
 *    change through the same code paths the tools use (`OrgService.setTunable`,
 *    `OrgMeetingsService.setCadence`, `OrgService.setRouting`,
 *    `OrgPlaybooksService.activate | retire`, `charter_change` / `reorg`
 *    cards), recording the revert recipe.
 *  - **The tick** checks running experiments daily against the revert rule
 *    (worse than baseline by more than it → revert at once and a minor
 *    `experiment_harm` incident) and, at `endsAt`, computes the verdict from
 *    samples: the mean difference, counted only when both sides have
 *    `experiments.minSamples` and |delta| exceeds `experiments.noiseFloor` ×
 *    the baseline's standard deviation. Improved → kept; worse → reverted;
 *    inconclusive → extended by its window up to `experiments.maxExtensions`,
 *    then reverted. Every verdict is an `org_decisions` row with the
 *    hypothesis and the numbers, an inbox event and a brief line.
 *
 * Direct changes stay allowed; the brief flags a tunable, routing or cadence
 * change an agent made outside an experiment as an "unmeasured change".
 */
import { BadRequestException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, asc, desc, eq, gte, lte } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { orgAudit, orgDecisions, orgExperiments, orgMetricSamples, orgMetricSources } from '../database/schema';
import { newId, nowIso } from '../common/ids.util';
import { currentAccountId } from '../accounts/account-context';
import { AccountsService } from '../accounts/accounts.service';
import { AgentsService } from '../agents/agents.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { TurnLoopService, type ToolProviderHook } from '../chats/turn-loop.service';
import type { ChatSession } from '../chats/chats.repository';
import type { AiToolSpec } from '../ai/ai-provider.interface';
import { OrgService, type Organization } from './org.service';
import { OrgAuditService } from './org-audit.service';
import { OrgApprovalsService, type ReorgChange } from './org-approvals.service';
import { OrgRuntimeService } from './org-runtime.service';
import { OrgUnitsService } from './org-units.service';
import { OrgMeetingsService, MEETING_KINDS } from './org-meetings.service';
import { OrgMeetingRuntime } from './org-meeting-runtime.service';
import { OrgPlaybooksService } from './org-playbooks.service';
import { OrgCapitalService, type PlanAction } from './org-capital.service';
import { OrgIncidentsService } from './org-incidents.service';
import { OrgBriefService } from './org-brief.service';
import { OrgAnnouncer } from './org-announcer';
import { OrgMirrorService } from './org-mirror.service';
import { OrgPredictionsService } from './org-predictions.service';
import { isTier, MODEL_TIERS, parseRouting } from './org-routing';
import { TUNABLES, checkTunable, tunable } from './org-tunables';
import { experimentTunable, EXPERIMENT_TUNABLES } from './experiment-tunables';

export type OrgExperiment = typeof orgExperiments.$inferSelect;
export const CHANGE_KINDS = ['tunable', 'cadence', 'routing', 'playbook', 'charter', 'structure', 'other'] as const;
export type ChangeKind = typeof CHANGE_KINDS[number];
export const EXPERIMENT_STATUSES = ['proposed', 'running', 'extended', 'kept', 'reverted', 'abandoned'] as const;
/** Kinds whose change (and revert) goes through an approval card; the rest the system applies and reverts itself. */
const STRUCTURAL: ReadonlySet<string> = new Set(['charter', 'structure']);
const LIVE: ReadonlySet<string> = new Set(['running', 'extended']);
const LIVE_SOURCE: ReadonlySet<string> = new Set(['ok', 'error', 'stale']);
const DAY = 86_400_000;
const START_TOOL = 'org_start_experiment';

export type Verdict = 'improved' | 'worse' | 'inconclusive' | 'harm';
export interface Stats { mean: number; n: number; sd: number }
export interface Baseline extends Stats { from: string; to: string; sourceId: string }
export interface ExperimentResult extends Stats { from: string; to: string; delta: number; relative: number | null; threshold: number; verdict: Verdict; expected: number; met: boolean; revertApprovalId?: string; note?: string }
export interface RevertRule { worseBy: number; relative: boolean }

/** Mean, count and sample standard deviation (pure). */
export function statsOf(values: number[]): Stats {
  const n = values.length;
  if (n === 0) return { mean: 0, n: 0, sd: 0 };
  const mean = values.reduce((a, x) => a + x, 0) / n;
  const sd = n < 2 ? 0 : Math.sqrt(values.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1));
  return { mean: round(mean), n, sd: round(sd) };
}

/** The model-free verdict (pure): a mean difference that clears the noise guard, in the wanted direction or not. */
export function verdictOf(input: { baseline: Stats; window: Stats; direction: 'up' | 'down'; minSamples: number; noiseFloor: number }): { delta: number; relative: number | null; threshold: number; verdict: Exclude<Verdict, 'harm'> } {
  const delta = round(input.window.mean - input.baseline.mean);
  const relative = input.baseline.mean !== 0 ? round(delta / Math.abs(input.baseline.mean)) : null;
  const threshold = round(input.noiseFloor * input.baseline.sd);
  if (input.baseline.n < input.minSamples || input.window.n < input.minSamples || Math.abs(delta) <= threshold) return { delta, relative, threshold, verdict: 'inconclusive' };
  const better = input.direction === 'up' ? delta > 0 : delta < 0;
  return { delta, relative, threshold, verdict: better ? 'improved' : 'worse' };
}

/** The revert rule (pure): is the window worse than the baseline by more than the rule allows? */
export function tripsRevertRule(rule: RevertRule, baseline: Stats, window: Stats, direction: 'up' | 'down'): boolean {
  if (window.n < 2 || baseline.n === 0) return false;
  const worse = direction === 'up' ? baseline.mean - window.mean : window.mean - baseline.mean;
  const limit = rule.relative ? rule.worseBy * Math.abs(baseline.mean) : rule.worseBy;
  return worse > limit;
}

export interface ExperimentInput {
  title?: string; hypothesis?: string; changeKind?: string; change?: Record<string, unknown>;
  /** A metric source (id, prefix or name). */
  metric?: string;
  /** Or a key result whose source measures it (goal id or prefix). */
  keyResult?: string;
  direction?: string; expectedEffect?: number; effectKind?: string; windowDays?: number;
  design?: string; slice?: Record<string, unknown>; revertRule?: { worseBy?: number; relative?: boolean }; unitId?: string | null;
}

const TOOL_NAMES = new Set(['org_propose_experiment', 'org_experiments']);
const READ_TOOL: AiToolSpec = {
  name: 'org_experiments',
  description: 'The company\'s experiments (docs/experiments.md): each change declared as a hypothesis with the metric it should move, its window, its baseline and — once decided — the measured result and the verdict (kept, reverted, extended). Filter by status (proposed | running | extended | kept | reverted | abandoned).',
  inputSchema: { type: 'object', properties: { status: { type: 'string', enum: [...EXPERIMENT_STATUSES] }, org: { type: 'string' } } },
};
const PROPOSE_TOOL: AiToolSpec = {
  name: 'org_propose_experiment',
  description: 'Propose a change as an experiment (chief and unit leads) — the default way to improve anything that should move a metric. Give the hypothesis, the metric source it should move (or the key result whose source measures it), the direction (up | down), the expected effect (relative 0.2 = +20 %, or absolute in the metric\'s unit) and a window in days. The change: tunable {key, value} | cadence {unit?, kind, cron | "off"} | routing {class, tier} | playbook {playbook, action: activate | retire} | charter {agent, text, mode: append | replace} | structure {changes: [{op: move | retitle | pause | resume, agent, reportsTo? | title?}]} | other {description}. The system snapshots a baseline from the samples, applies the change, measures, and keeps it, reverts it or extends it on its own; the verdict goes to the decision log. Supervised: the CEO approves first. Autonomous: tunable, cadence, routing and playbook experiments start at once within bounds; charter and structure ones wait for the plan veto window and their change card.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string' }, hypothesis: { type: 'string', description: 'What changes, what it should move and why, e.g. "question-form subject lines raise the open rate".' },
      changeKind: { type: 'string', enum: [...CHANGE_KINDS] }, change: { type: 'object', description: 'What to apply (see the description for each kind).' },
      metric: { type: 'string', description: 'The metric source (id, prefix or name; org_metric_sources). Required except for changeKind other.' },
      keyResult: { type: 'string', description: 'Instead of metric: a key result bound to a source.' },
      direction: { type: 'string', enum: ['up', 'down'] }, expectedEffect: { type: 'number', description: 'How much better, in the direction (0.1 = 10 % with effectKind relative).' },
      effectKind: { type: 'string', enum: ['relative', 'absolute'] }, windowDays: { type: 'number' },
      revertWorseBy: { type: 'number', description: 'Revert at once when the metric is worse than the baseline by more than this (relative by default; 0.1 = 10 %).' },
      unit: { type: 'string', description: 'The unit it runs in (the chief; a lead\'s own unit otherwise).' }, org: { type: 'string' },
    },
    required: ['title', 'hypothesis', 'changeKind', 'change', 'direction', 'expectedEffect'],
  },
};

@Injectable()
export class OrgExperimentsService implements ToolProviderHook, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OrgExperimentsService.name);
  private timer?: ReturnType<typeof setInterval>;
  /** Test seam: the clock of the tick and of start/decide. */
  now: () => Date = () => new Date();

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly org: OrgService,
    private readonly audit: OrgAuditService,
    private readonly approvals: OrgApprovalsService,
    private readonly agents: AgentsService,
    private readonly workspaces: WorkspacesService,
    private readonly config: ConfigService,
    @Optional() private readonly turns?: TurnLoopService,
    @Optional() private readonly runtime?: OrgRuntimeService,
    @Optional() private readonly units?: OrgUnitsService,
    @Optional() private readonly meetings?: OrgMeetingsService,
    @Optional() private readonly playbooks?: OrgPlaybooksService,
    @Optional() private readonly capital?: OrgCapitalService,
    @Optional() private readonly incidents?: OrgIncidentsService,
    @Optional() private readonly brief?: OrgBriefService,
    @Optional() private readonly predictions?: OrgPredictionsService,
    @Optional() private readonly meetingRuntime?: OrgMeetingRuntime,
    @Optional() private readonly announcer?: OrgAnnouncer,
    @Optional() private readonly accounts?: AccountsService,
    /** Optional: mirrors each experiment to /org/experiments/ (docs/filesystem.md). */
    @Optional() private readonly mirror?: OrgMirrorService,
  ) {
    if (!this.enabled()) return;
    this.turns?.addToolProvider(this);
    this.approvals.onApply('experiment', (orgId, payload, approval) => this.applyApproval(orgId, payload, approval.id));
    this.approvals.onDecided(async (ev) => {
      const payload = parseObj(ev.approval.payload);
      const experimentId = typeof payload.experimentId === 'string' ? payload.experimentId : '';
      if (!experimentId) return;
      const row = await this.find(ev.orgId, experimentId);
      if (!row || row.status !== 'proposed') return;
      // The experiment card itself: rejecting it abandons the proposal.
      if (ev.approval.kind === 'experiment' && ev.decision === 'reject') await this.abandon(ev.orgId, row, 'user', `the CEO rejected the experiment${ev.note ? `: ${ev.note}` : ''}`);
      // A charter / structure experiment's change card: approved → measuring starts; rejected → abandoned.
      if (row.changeApprovalId === ev.approval.id) {
        if (ev.decision === 'approve') await this.begin(ev.orgId, row.id, 'user').catch((err) => this.logger.warn(`experiment ${row.id} could not begin: ${err instanceof Error ? err.message : err}`));
        else if (ev.decision === 'reject') await this.abandon(ev.orgId, row, 'user', 'the CEO rejected its change card');
      }
    });
    this.capital?.addToolApplier(START_TOOL, async (orgId, action) => {
      const r = await this.start(orgId, String(action.input.experimentId ?? ''), 'chief');
      return `experiment "${r.title}" ${r.status === 'proposed' ? `waits for its change card ${r.changeApprovalId?.slice(0, 8)}` : `started (ends ${(r.endsAt ?? '').slice(0, 10)})`}`;
    });
    this.brief?.addSection({ position: 'improve', lines: (orgId, since, now) => this.briefLines(orgId, since, now) });
    this.meetingRuntime?.addAgendaProvider((orgId, m) => (m.kind === 'retro' ? this.retroAgenda(orgId) : Promise.resolve(null)));
  }

  enabled(): boolean { return this.config.get<boolean>('companiesEnabled') !== false; }

  onModuleInit(): void {
    if (!this.enabled()) return;
    this.timer = setInterval(() => { void this.tick(this.now()); }, 15 * 60_000);
  }

  onModuleDestroy(): void { clearInterval(this.timer); }

  // ---- reads ----

  private async find(orgId: string, id: string): Promise<OrgExperiment | null> {
    const exact = (await this.db.select().from(orgExperiments).where(and(eq(orgExperiments.orgId, orgId), eq(orgExperiments.id, id))).limit(1)).at(0);
    if (exact) return exact;
    if ((id ?? '').length < 6) return null;
    const hits = (await this.rows(orgId)).filter((r) => r.id.startsWith(id));
    return hits.length === 1 ? hits[0] : null;
  }

  async get(orgId: string, id: string): Promise<OrgExperiment> {
    const r = await this.find(orgId, id);
    if (!r) throw new NotFoundException(`experiment ${id}`);
    return r;
  }

  rows(orgId: string): Promise<OrgExperiment[]> {
    return this.db.select().from(orgExperiments).where(eq(orgExperiments.orgId, orgId)).orderBy(desc(orgExperiments.createdAt));
  }

  async list(orgId: string, opts: { status?: string } = {}): Promise<OrgExperiment[]> {
    await this.org.get(orgId);
    return (await this.rows(orgId)).filter((r) => !opts.status || r.status === opts.status || (opts.status === 'running' && r.status === 'extended'));
  }

  /** The API shape: JSON columns parsed. */
  view(r: OrgExperiment) {
    return { ...r, change: parseObj(r.change), slice: parseObj(r.slice), baseline: parseObj(r.baseline), result: parseObj(r.result), revertRule: parseObj(r.revertRule) };
  }

  private async source(orgId: string, ref: string) {
    const q = (ref ?? '').trim();
    const rows = await this.db.select().from(orgMetricSources).where(eq(orgMetricSources.orgId, orgId));
    const hits = rows.filter((s) => s.id === q || (q.length >= 4 && s.id.startsWith(q)) || s.name.toLowerCase() === q.toLowerCase());
    if (hits.length !== 1) throw new BadRequestException(`metric source "${q}" matches ${hits.length} sources${rows.length ? ` — sources: ${rows.map((s) => `${s.name} [${s.id.slice(0, 8)}]`).join(', ')}` : ' — none exist yet (org_propose_metric_source)'}`);
    return hits[0];
  }

  private async samplesBetween(sourceId: string, from: string, to: string): Promise<number[]> {
    const rows = await this.db.select().from(orgMetricSamples).where(and(eq(orgMetricSamples.sourceId, sourceId), gte(orgMetricSamples.observedAt, from), lte(orgMetricSamples.observedAt, to))).orderBy(asc(orgMetricSamples.observedAt));
    return rows.map((r) => r.value);
  }

  // ---- propose ----

  /** Validate and record a proposal (status `proposed`); governance is the caller's (the tool, the route). */
  async propose(orgId: string, input: ExperimentInput, actor: string): Promise<OrgExperiment> {
    const org = await this.org.get(orgId);
    const title = (input.title ?? '').trim().slice(0, 160);
    const hypothesis = (input.hypothesis ?? '').trim().slice(0, 2_000);
    if (!title) throw new BadRequestException('an experiment needs a title');
    if (!hypothesis) throw new BadRequestException('an experiment needs a hypothesis: what changes, what it should move, and why');
    const changeKind = String(input.changeKind ?? '') as ChangeKind;
    if (!CHANGE_KINDS.includes(changeKind)) throw new BadRequestException(`changeKind must be one of ${CHANGE_KINDS.join(', ')}`);
    // The metric: a live source, or a key result's. Only `other` may go unmeasured.
    let metricSourceId: string | null = null;
    if (input.keyResult) {
      const goals = (await this.org.goals(orgId)).filter((g) => g.kind === 'key_result' && (g.id === input.keyResult || g.id.startsWith(String(input.keyResult))));
      if (goals.length !== 1) throw new BadRequestException(`key result "${input.keyResult}" matches ${goals.length} key results`);
      if (!goals[0].metricSourceId) throw new BadRequestException(`key result "${goals[0].title}" is self-reported (no metric source) — an experiment needs a measured metric; bind a source first`);
      metricSourceId = goals[0].metricSourceId;
    } else if (input.metric) metricSourceId = (await this.source(orgId, input.metric)).id;
    if (!metricSourceId && changeKind !== 'other') throw new BadRequestException('an experiment needs a measured metric: a metric source (metric) or a key result bound to one (keyResult) — a self-reported number cannot judge it');
    if (metricSourceId) {
      const src = (await this.db.select().from(orgMetricSources).where(eq(orgMetricSources.id, metricSourceId)).limit(1)).at(0);
      if (!src || !LIVE_SOURCE.has(src.status)) throw new BadRequestException(`metric source "${src?.name ?? metricSourceId}" is ${src?.status.replace('_', ' ') ?? 'missing'} — only a live source measures an experiment`);
    }
    const direction = input.direction === 'down' ? 'down' : input.direction === 'up' ? 'up' : null;
    if (!direction) throw new BadRequestException('direction must be up or down (which way is better)');
    const expectedEffect = Number(input.expectedEffect);
    if (!Number.isFinite(expectedEffect) || expectedEffect <= 0) throw new BadRequestException('expectedEffect must be a positive number: how much better, in the direction');
    const effectKind = input.effectKind === 'absolute' ? 'absolute' : 'relative';
    if (effectKind === 'relative' && expectedEffect > 10) throw new BadRequestException('a relative expectedEffect is a fraction (0.2 = +20 %); at most 10');
    const bound = EXPERIMENT_TUNABLES['experiments.windowDays'];
    const windowDays = input.windowDays === undefined || input.windowDays === null ? experimentTunable(org, 'experiments.windowDays') : Number(input.windowDays);
    if (!Number.isInteger(windowDays) || windowDays < bound.min || windowDays > bound.max) throw new BadRequestException(`windowDays must be a whole number within ${bound.min}–${bound.max} (the bound of experiments.windowDays)`);
    const design = input.design === 'slice' ? 'slice' : 'before_after';
    const slice = design === 'slice' ? await this.checkSlice(orgId, input.slice ?? {}) : {};
    const worseBy = input.revertRule?.worseBy === undefined ? 0.1 : Number(input.revertRule.worseBy);
    if (!Number.isFinite(worseBy) || worseBy <= 0) throw new BadRequestException('revertRule.worseBy must be a positive number');
    const revertRule: RevertRule = { worseBy, relative: input.revertRule?.relative !== false };
    const apply = await this.checkChange(org, changeKind, input.change ?? {}, actor);
    const unitId = await this.unitFor(orgId, input.unitId ?? null, actor);
    const now = nowIso();
    const row: OrgExperiment = {
      accountId: currentAccountId(), id: newId(), orgId, unitId, title, hypothesis, changeKind, change: JSON.stringify({ apply }), metricSourceId,
      direction, expectedEffect, effectKind, windowDays, design, slice: JSON.stringify(slice), baseline: '{}', result: '{}', status: 'proposed',
      revertRule: JSON.stringify(revertRule), extensions: 0, proposedBy: actor.slice(0, 80), approvalId: null, changeApprovalId: null,
      startedAt: null, endsAt: null, lastCheckAt: null, decidedAt: null, decisionId: null, createdAt: now,
    };
    await this.db.insert(orgExperiments).values(row);
    this.mirror?.experimentChanged(orgId, row.id);
    await this.audit.append(orgId, { actor, action: 'experiment_propose', refType: 'experiment', refId: row.id, payload: { title, changeKind, apply, metricSourceId, direction, expectedEffect, effectKind, windowDays, design, revertRule } });
    // The proposer's expected effect is a forecast in the ledger (docs/experiments.md §2).
    const forecaster = this.agentOf(org, actor);
    if (forecaster && metricSourceId && this.predictions) {
      await this.predictions.record(orgId, {
        agentId: forecaster, subjectKind: 'experiment', subjectId: row.id, origin: 'experiment',
        question: `effect of "${title}" on the metric (${effectKind})`,
        forecast: { kind: 'number', value: direction === 'up' ? expectedEffect : -expectedEffect, unit: effectKind },
      }).catch((err) => this.logger.warn(`experiment forecast not recorded: ${err instanceof Error ? err.message : err}`));
    }
    return row;
  }

  private agentOf(org: Organization, actor: string): string | null {
    if (actor === 'chief') return org.chiefOfStaffAgentId;
    return actor.startsWith('agent:') ? actor.slice('agent:'.length) : null;
  }

  private async unitFor(orgId: string, unitRef: string | null, actor: string): Promise<string | null> {
    if (!this.units) return unitRef;
    const org = await this.org.get(orgId);
    const agentId = this.agentOf(org, actor);
    if (agentId && agentId !== org.chiefOfStaffAgentId) {
      const lead = await this.units.isLead(orgId, agentId);
      if (lead) {
        if (unitRef && unitRef !== lead.id && !lead.id.startsWith(unitRef) && lead.slug !== unitRef.replace(/^#/, '')) throw new BadRequestException(`refused: you may experiment only in your own unit (${lead.name})`);
        return lead.id;
      }
    }
    if (unitRef) {
      const all = await this.units.units(orgId);
      const q = unitRef.toLowerCase().replace(/^#/, '');
      const u = all.find((x) => x.id === unitRef || x.id.startsWith(unitRef) || x.slug === q || x.name.toLowerCase() === q);
      if (!u) throw new BadRequestException(`no unit "${unitRef}"`);
      return u.id;
    }
    return (await this.units.rootUnit(orgId).catch(() => null))?.id ?? null;
  }

  private async checkSlice(orgId: string, raw: Record<string, unknown>): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    if (Array.isArray(raw.units)) {
      const all = this.units ? await this.units.units(orgId) : [];
      const ids = raw.units.map(String).map((ref) => all.find((u) => u.id === ref || u.id.startsWith(ref) || u.slug === ref.replace(/^#/, ''))?.id);
      if (ids.some((x) => !x)) throw new BadRequestException('slice.units names a unit that does not exist');
      out.units = ids;
    }
    if (raw.share !== undefined) {
      const share = Number(raw.share);
      if (!Number.isFinite(share) || share <= 0 || share > 1) throw new BadRequestException('slice.share is a fraction of tasks, 0–1');
      out.share = share;
    }
    if (!out.units && out.share === undefined) throw new BadRequestException('a slice design names slice.units or slice.share');
    return out;
  }

  /** Validate the change and return its normalized `apply` spec (bounds checked now and again at start). */
  private async checkChange(org: Organization, kind: ChangeKind, c: Record<string, unknown>, actor: string): Promise<Record<string, unknown>> {
    const str = (k: string) => (typeof c[k] === 'string' ? (c[k] as string).trim() : '');
    switch (kind) {
      case 'tunable': {
        const key = str('key');
        if (key.startsWith('experiments.')) throw new BadRequestException('an experiment cannot change the experiment rules themselves');
        // The self-modification boundary (docs/boundary.md, item 31): never-keys are nobody's to test; propose-keys are the CEO's card.
        const d = await this.org.boundaryDecide(org.id, { kind: 'tunable', key, summary: `experiment on ${key}` }, actor);
        if (d.outcome === 'refuse') throw new BadRequestException(d.reason);
        if (d.outcome === 'card') throw new BadRequestException(`${d.reason} — propose it with org_tune (a card for the CEO), not as an experiment`);
        const check = checkTunable(key, c.value);
        if (!check.ok) throw new BadRequestException(check.reason);
        if (tunable(org, key) === check.value) throw new BadRequestException(`${key} is already ${check.value}: nothing to test`);
        return { key, value: check.value };
      }
      case 'cadence': {
        if (!this.meetings) throw new BadRequestException('meetings are not available on this server');
        const mkind = str('kind').toLowerCase().replace('-', '_');
        if (!MEETING_KINDS.includes(mkind as never) || mkind === 'adhoc') throw new BadRequestException(`change.kind must be one of ${MEETING_KINDS.filter((k) => k !== 'adhoc').join(', ')}`);
        const cronRaw = str('cron');
        const cron = /^(off|none|never|disable|disabled)?$/i.test(cronRaw) ? null : cronRaw;
        if (cron !== null) { const err = await this.meetings.cadenceBoundsError(org, mkind, cron); if (err) throw new BadRequestException(err); }
        const unitId = await this.unitFor(org.id, str('unit') || null, actor);
        if (!unitId) throw new BadRequestException('a cadence experiment needs a unit');
        return { unitId, kind: mkind, cron };
      }
      case 'routing': {
        const cls = str('class').toLowerCase();
        const tier = str('tier').toLowerCase();
        if (!/^[a-z][a-z0-9_-]{0,23}$/.test(cls)) throw new BadRequestException('change.class must be a task class (a lowercase slug)');
        if (!isTier(tier)) throw new BadRequestException(`change.tier must be one of ${MODEL_TIERS.join(', ')}`);
        if (parseRouting(org.routing).classes[cls] === tier) throw new BadRequestException(`${cls} already routes to ${tier}: nothing to test`);
        return { class: cls, tier };
      }
      case 'playbook': {
        if (!this.playbooks) throw new BadRequestException('playbooks are not available on this server');
        const p = await this.playbooks.byRef(org.id, str('playbook') || str('playbookId'));
        const action = str('action') || 'activate';
        // Activation bypasses no review: only a version that was active before (now retired) may be switched back on.
        if (action === 'activate' && p.status !== 'retired') throw new BadRequestException(`playbook "${p.title}" is ${p.status}: an experiment may re-activate a retired (reviewed) playbook, or retire an active one — a new playbook goes through review first`);
        if (action === 'retire' && p.status !== 'active') throw new BadRequestException(`playbook "${p.title}" is ${p.status}, not active`);
        if (action !== 'activate' && action !== 'retire') throw new BadRequestException('change.action is activate or retire');
        return { playbookId: p.id, title: p.title, action };
      }
      case 'charter': {
        const ref = str('agent').toLowerCase();
        const text = str('text');
        if (!text) throw new BadRequestException('change.text is the charter text to append or the replacement');
        const names = new Map((await this.agents.list()).map((a) => [a.id, a.name]));
        const m = (await this.org.members(org.id)).find((x) => x.status !== 'terminated' && (x.agentId === ref || x.agentId.startsWith(ref) || (names.get(x.agentId) ?? '').toLowerCase() === ref));
        if (!m) throw new BadRequestException(`no member "${str('agent')}"`);
        return { agentId: m.agentId, agentName: names.get(m.agentId) ?? m.agentId, text: text.slice(0, 8_000), mode: str('mode') === 'replace' ? 'replace' : 'append' };
      }
      case 'structure': {
        const raw = Array.isArray(c.changes) ? c.changes as Array<Record<string, unknown>> : [];
        if (raw.length === 0 || raw.length > 10) throw new BadRequestException('change.changes is 1–10 reorg steps');
        const names = new Map((await this.agents.list()).map((a) => [a.id, a.name]));
        const members = (await this.org.members(org.id)).filter((x) => x.status !== 'terminated');
        const byRef = (ref: unknown) => { const q = String(ref ?? '').toLowerCase(); return members.find((x) => x.agentId === q || (q.length >= 6 && x.agentId.startsWith(q)) || (names.get(x.agentId) ?? '').toLowerCase() === q); };
        const changes: ReorgChange[] = [];
        for (const step of raw) {
          const op = String(step.op ?? '');
          const m = byRef(step.agent ?? step.agentId);
          if (!m) throw new BadRequestException(`no member "${String(step.agent ?? step.agentId ?? '')}"`);
          if (op === 'move') { const to = byRef(step.reportsTo ?? step.reportsToAgentId); if (!to) throw new BadRequestException('move needs reportsTo, a member'); changes.push({ op, agentId: m.agentId, reportsToAgentId: to.agentId }); }
          else if (op === 'retitle') { const t = String(step.title ?? '').trim(); if (!t) throw new BadRequestException('retitle needs a title'); changes.push({ op, agentId: m.agentId, title: t.slice(0, 80) }); }
          else if (op === 'pause' || op === 'resume') changes.push({ op, agentId: m.agentId });
          else throw new BadRequestException('structure steps are move, retitle, pause or resume — terminate cannot be reverted, so it is not an experiment');
        }
        return { changes };
      }
      case 'other': {
        const description = str('description') || str('what');
        if (!description) throw new BadRequestException('change.description says what changes (the system applies nothing for kind other)');
        return { description: description.slice(0, 1_000) };
      }
    }
  }

  // ---- governance ----

  /** The tool's (and the API's) governance after `propose`: a card, a plan, or a start. */
  async govern(orgId: string, row: OrgExperiment, actor: string): Promise<{ row: OrgExperiment; how: 'approval' | 'plan' | 'started' | 'waiting_change'; approvalId?: string; planId?: string }> {
    const org = await this.org.get(orgId);
    const ws = await this.workspaces.get(org.workspaceId).catch(() => null);
    if (ws?.orgMode !== 'autonomous') {
      const src = row.metricSourceId ? (await this.db.select().from(orgMetricSources).where(eq(orgMetricSources.id, row.metricSourceId)).limit(1)).at(0) : null;
      const a = await this.approvals.create(orgId, {
        kind: 'experiment',
        payload: { experimentId: row.id, title: row.title, hypothesis: row.hypothesis, changeKind: row.changeKind, change: parseObj(row.change).apply, metric: src?.name ?? 'unmeasured', direction: row.direction, expected: `${row.effectKind === 'relative' ? `${Math.round(row.expectedEffect * 100)}%` : row.expectedEffect}`, windowDays: row.windowDays, unitId: row.unitId, why: row.hypothesis },
        requestedBy: actor, recommendation: row.hypothesis.slice(0, 600),
      });
      await this.db.update(orgExperiments).set({ approvalId: a.id }).where(eq(orgExperiments.id, row.id));
      this.mirror?.experimentChanged(orgId, row.id);
      return { row: await this.get(orgId, row.id), how: 'approval', approvalId: a.id };
    }
    if (STRUCTURAL.has(row.changeKind)) {
      if (!this.capital) return this.govern(orgId, row, actor);
      const action: PlanAction = { tool: START_TOOL, input: { experimentId: row.id }, estimateUsd: 0, summary: `start experiment "${row.title}" (${row.changeKind})`.slice(0, 300) };
      const plan = await this.capital.createPlan(orgId, { trigger: 'experiment', actions: [action], dryRun: false }, { by: actor });
      const after = await this.get(orgId, row.id);
      return { row: after, how: after.status === 'proposed' && !after.changeApprovalId ? 'plan' : 'waiting_change', planId: plan.id };
    }
    const started = await this.start(orgId, row.id, actor);
    return { row: started, how: 'started' };
  }

  private async applyApproval(orgId: string, payload: Record<string, unknown>, approvalId: string): Promise<Record<string, unknown>> {
    const r = await this.start(orgId, String(payload.experimentId ?? ''), 'user', { approvalId });
    return { experimentId: r.id, status: r.status, endsAt: r.endsAt, changeApprovalId: r.changeApprovalId };
  }

  // ---- start ----

  /** Snapshot the baseline and apply the change (charter / structure: send its card; measuring begins on approval). */
  async start(orgId: string, id: string, actor: string, opts: { approvalId?: string } = {}): Promise<OrgExperiment> {
    const org = await this.org.get(orgId);
    if (org.status !== 'active') throw new BadRequestException(`"${org.name}" is paused`);
    const row = await this.get(orgId, id);
    if (row.status !== 'proposed') throw new BadRequestException(`experiment "${row.title}" is ${row.status}`);
    if (row.changeApprovalId) throw new BadRequestException(`experiment "${row.title}" waits for its change card ${row.changeApprovalId.slice(0, 8)}`);
    await this.assertCapacity(org, row);
    const now = this.now();
    const baseline = await this.baselineOf(org, row, now);
    const apply = parseObj(row.change).apply as Record<string, unknown>;
    // Bounds again at apply time: the org may have changed since the proposal.
    const fresh = await this.checkChange(org, row.changeKind as ChangeKind, this.asInput(row.changeKind, apply), actor === 'user' ? 'user' : row.proposedBy).catch((err: unknown) => { throw new BadRequestException(`refused at start: ${err instanceof Error ? err.message : String(err)}`); });
    if (STRUCTURAL.has(row.changeKind)) {
      // The revert recipe is the state before the card applies.
      const revert = await this.inverseOf(org, row.changeKind, fresh);
      const card = await this.changeCard(org, row, fresh, 'apply');
      await this.db.update(orgExperiments).set({ changeApprovalId: card, approvalId: opts.approvalId ?? row.approvalId, baseline: JSON.stringify(baseline), change: JSON.stringify({ apply: fresh, revert }) }).where(eq(orgExperiments.id, row.id));
      this.mirror?.experimentChanged(orgId, row.id);
      await this.audit.append(orgId, { actor, action: 'experiment_change_card', refType: 'experiment', refId: row.id, payload: { approvalId: card, changeKind: row.changeKind } });
      return this.get(orgId, row.id);
    }
    const revert = await this.applyChange(org, row, fresh);
    const endsAt = new Date(now.getTime() + row.windowDays * DAY).toISOString();
    await this.db.update(orgExperiments).set({
      status: 'running', startedAt: now.toISOString(), endsAt, lastCheckAt: now.toISOString(), baseline: JSON.stringify(baseline),
      change: JSON.stringify({ apply: fresh, revert }), approvalId: opts.approvalId ?? row.approvalId,
    }).where(eq(orgExperiments.id, row.id));
    this.mirror?.experimentChanged(orgId, row.id);
    await this.announceStart(org, row, baseline, endsAt, actor);
    return this.get(orgId, row.id);
  }

  /** A charter / structure experiment's change card was approved: measure from now. */
  async begin(orgId: string, id: string, actor: string): Promise<OrgExperiment> {
    const org = await this.org.get(orgId);
    const row = await this.get(orgId, id);
    if (row.status !== 'proposed' || !row.changeApprovalId) return row;
    const now = this.now();
    const baseline = await this.baselineOf(org, row, now).catch(() => parseObj(row.baseline) as unknown as Baseline);
    const change = parseObj(row.change);
    const apply = change.apply as Record<string, unknown>;
    const revert = (change.revert as Record<string, unknown> | undefined) ?? await this.inverseOf(org, row.changeKind, apply);
    const endsAt = new Date(now.getTime() + row.windowDays * DAY).toISOString();
    await this.db.update(orgExperiments).set({ status: 'running', startedAt: now.toISOString(), endsAt, lastCheckAt: now.toISOString(), baseline: JSON.stringify(baseline), change: JSON.stringify({ apply, revert }) }).where(eq(orgExperiments.id, row.id));
    this.mirror?.experimentChanged(orgId, row.id);
    await this.announceStart(org, row, baseline, endsAt, actor);
    return this.get(orgId, row.id);
  }

  private asInput(kind: string, apply: Record<string, unknown>): Record<string, unknown> {
    switch (kind) {
      case 'cadence': return { unit: apply.unitId, kind: apply.kind, cron: apply.cron ?? 'off' };
      case 'playbook': return { playbook: apply.playbookId, action: apply.action };
      case 'charter': return { agent: apply.agentId, text: apply.text, mode: apply.mode };
      case 'structure': return { changes: (apply.changes as ReorgChange[] ?? []).map((c) => ({ ...c, agent: c.agentId, reportsTo: (c as { reportsToAgentId?: string }).reportsToAgentId })) };
      default: return apply;
    }
  }

  private async assertCapacity(org: Organization, row: OrgExperiment): Promise<void> {
    const cap = experimentTunable(org, 'experiments.concurrentPerUnit');
    const live = (await this.rows(org.id)).filter((r) => r.id !== row.id && (LIVE.has(r.status) || (r.status === 'proposed' && r.changeApprovalId)) && r.unitId === row.unitId);
    if (live.length >= cap) throw new BadRequestException(`refused: ${live.length} experiment(s) already run in this unit (experiments.concurrentPerUnit = ${cap}) — their effects would confound: ${live.map((r) => `"${r.title}"`).join(', ')}`);
  }

  private async baselineOf(org: Organization, row: OrgExperiment, now: Date): Promise<Baseline | Record<string, never>> {
    if (!row.metricSourceId) return {};
    const from = new Date(now.getTime() - row.windowDays * DAY).toISOString();
    const to = now.toISOString();
    const values = await this.samplesBetween(row.metricSourceId, from, to);
    const min = experimentTunable(org, 'experiments.minSamples');
    if (values.length < min) throw new BadRequestException(`the baseline has ${values.length} sample(s) in the previous ${row.windowDays} day(s); at least ${min} are needed (experiments.minSamples) — wait for more readings or shorten the window`);
    return { ...statsOf(values), from, to, sourceId: row.metricSourceId };
  }

  private async announceStart(org: Organization, row: OrgExperiment, baseline: Baseline | Record<string, never>, endsAt: string, actor: string): Promise<void> {
    const b = baseline as Partial<Baseline>;
    await this.audit.append(org.id, { actor, action: 'experiment_start', refType: 'experiment', refId: row.id, payload: { title: row.title, changeKind: row.changeKind, baseline: { mean: b.mean, n: b.n, sd: b.sd }, endsAt } });
    const line = `Experiment started: "${row.title}" (${row.changeKind}) — baseline ${b.n ? `${fmt(b.mean)} over ${b.n} sample(s)` : 'none (unmeasured)'}; verdict by ${endsAt.slice(0, 10)}.`;
    if (org.chiefOfStaffAgentId) await this.agents.addEvent(org.chiefOfStaffAgentId, { kind: 'org_experiment', title: line.slice(0, 200), body: row.hypothesis.slice(0, 1_000), payload: JSON.stringify({ orgId: org.id, experimentId: row.id, status: 'running' }), origin: 'loop' }).catch(() => undefined);
    await this.announcer?.announce(org.workspaceId, line).catch(() => undefined);
  }

  /** Apply a system-applied change through the tools' own code paths; return the revert recipe. */
  private async applyChange(org: Organization, row: OrgExperiment, apply: Record<string, unknown>): Promise<Record<string, unknown>> {
    const why = `experiment "${row.title}": ${row.hypothesis}`.slice(0, 600);
    const revert = await this.inverseOf(org, row.changeKind, apply);
    switch (row.changeKind) {
      case 'tunable': await this.org.setTunable(org.id, String(apply.key), apply.value, { actor: 'experiment', why, decidedBy: row.proposedBy }); break;
      case 'cadence': await this.meetings!.setCadence(org.id, { unitId: String(apply.unitId), kind: String(apply.kind), cron: (apply.cron as string | null) ?? null, why, actor: 'experiment', decidedBy: row.proposedBy }); break;
      case 'routing': await this.org.setRouting(org.id, { classes: { [String(apply.class)]: apply.tier } }, { actor: 'experiment', why, decidedBy: row.proposedBy }); break;
      case 'playbook': if (apply.action === 'activate') await this.playbooks!.activate(org.id, String(apply.playbookId), 'experiment'); else await this.playbooks!.retire(org.id, String(apply.playbookId), 'experiment', why); break;
      case 'other': break;
    }
    return revert;
  }

  /** The recipe that undoes `apply`, from the state before it. */
  private async inverseOf(org: Organization, kind: string, apply: Record<string, unknown>): Promise<Record<string, unknown>> {
    switch (kind) {
      case 'tunable': { const key = String(apply.key); const stored = (JSON.parse(org.tunables || '{}') as Record<string, unknown>)[key]; return { key, value: tunable(org, key), wasDefault: stored === undefined }; }
      case 'cadence': {
        const existing = (await this.meetings!.cadences(org.id)).find((c) => c.unitId === apply.unitId && c.kind === apply.kind);
        return { unitId: apply.unitId, kind: apply.kind, cron: existing && existing.enabled ? existing.cron : null };
      }
      case 'routing': return { class: apply.class, tier: parseRouting(org.routing).classes[String(apply.class)] ?? null };
      case 'playbook': return { playbookId: apply.playbookId, title: apply.title, action: apply.action === 'activate' ? 'retire' : 'activate' };
      case 'charter': { const a = await this.agents.get(String(apply.agentId)).catch(() => null); return { agentId: apply.agentId, agentName: apply.agentName, charter: a?.charter ?? '' }; }
      case 'structure': {
        const members = await this.org.members(org.id);
        const inverse: ReorgChange[] = [];
        for (const c of [...((apply.changes as ReorgChange[]) ?? [])].reverse()) {
          const m = members.find((x) => x.agentId === c.agentId);
          if (!m) continue;
          if (c.op === 'move') inverse.push({ op: 'move', agentId: c.agentId, reportsToAgentId: m.reportsToAgentId ?? '' });
          else if (c.op === 'retitle') inverse.push({ op: 'retitle', agentId: c.agentId, title: m.title });
          else if (c.op === 'pause') inverse.push({ op: 'resume', agentId: c.agentId });
          else if (c.op === 'resume') inverse.push({ op: 'pause', agentId: c.agentId });
        }
        return { changes: inverse };
      }
      default: return {};
    }
  }

  /** A charter / structure change goes through its existing approval card. */
  private async changeCard(org: Organization, row: OrgExperiment, spec: Record<string, unknown>, phase: 'apply' | 'revert'): Promise<string> {
    const tag = phase === 'apply' ? `Experiment "${row.title}"` : `Revert of experiment "${row.title}"`;
    if (row.changeKind === 'charter') {
      const agentId = String(spec.agentId);
      const target = await this.agents.get(agentId);
      const before = target.charter ?? '';
      const after = phase === 'revert' ? String(spec.charter ?? '') : spec.mode === 'replace' ? String(spec.text) : `${before.trimEnd()}\n\n${String(spec.text)}`.trim();
      const a = await this.approvals.create(org.id, { kind: 'charter_change', payload: { agentId, agentName: target.name, before, after, mode: phase === 'revert' ? 'replace' : spec.mode, lesson: `${tag}: ${row.hypothesis}`.slice(0, 600), experimentId: row.id, phase }, requestedBy: row.proposedBy, recommendation: `${tag}: ${row.hypothesis}`.slice(0, 600) });
      return a.id;
    }
    const a = await this.approvals.create(org.id, { kind: 'reorg', payload: { changes: spec.changes ?? [], experimentId: row.id, phase, why: `${tag}: ${row.hypothesis}`.slice(0, 600) }, requestedBy: row.proposedBy, recommendation: `${tag}: ${row.hypothesis}`.slice(0, 600) });
    return a.id;
  }

  // ---- the tick: early stop, verdicts ----

  async tick(now: Date = this.now()): Promise<void> {
    if (!this.enabled()) return;
    const one = async () => {
      for (const org of await this.org.list()) {
        if (org.status !== 'active') continue;
        await this.sweep(org.id, now).catch((err) => this.logger.warn(`experiments sweep for org ${org.id} failed: ${err instanceof Error ? err.message : err}`));
      }
    };
    if (!this.accounts) return one();
    await this.accounts.forEachAccount(one);
  }

  /** Daily revert-rule checks and the verdicts that are due. */
  async sweep(orgId: string, now: Date = this.now()): Promise<Array<{ id: string; status: string; verdict?: string }>> {
    const out: Array<{ id: string; status: string; verdict?: string }> = [];
    for (const row of (await this.rows(orgId)).filter((r) => LIVE.has(r.status))) {
      if (row.endsAt && row.endsAt <= now.toISOString()) { const r = await this.conclude(orgId, row.id, { now }); out.push({ id: r.id, status: r.status, verdict: String(parseObj(r.result).verdict ?? '') }); continue; }
      if (row.lastCheckAt && now.getTime() - Date.parse(row.lastCheckAt) < DAY) continue;
      const r = await this.earlyStop(orgId, row, now);
      if (r) out.push({ id: r.id, status: r.status, verdict: 'harm' });
    }
    return out;
  }

  private async windowStats(row: OrgExperiment, now: Date): Promise<Stats & { from: string; to: string }> {
    const from = row.startedAt ?? now.toISOString();
    const to = (row.endsAt && row.endsAt < now.toISOString() ? row.endsAt : now.toISOString());
    const values = row.metricSourceId ? await this.samplesBetween(row.metricSourceId, from, to) : [];
    return { ...statsOf(values), from, to };
  }

  /** The revert rule, once a day: worse than baseline by more than it → revert now, minor incident. */
  private async earlyStop(orgId: string, row: OrgExperiment, now: Date): Promise<OrgExperiment | null> {
    await this.db.update(orgExperiments).set({ lastCheckAt: now.toISOString() }).where(eq(orgExperiments.id, row.id));
    if (!row.metricSourceId) return null;
    const baseline = parseObj(row.baseline) as unknown as Baseline;
    const window = await this.windowStats(row, now);
    const rule = parseObj(row.revertRule) as unknown as RevertRule;
    if (!tripsRevertRule({ worseBy: Number(rule.worseBy ?? 0.1), relative: rule.relative !== false }, baseline, window, row.direction as 'up' | 'down')) return null;
    const org = await this.org.get(orgId);
    const v = verdictOf({ baseline, window, direction: row.direction as 'up' | 'down', minSamples: 0, noiseFloor: 0 });
    const result: ExperimentResult = { ...window, delta: v.delta, relative: v.relative, threshold: v.threshold, verdict: 'harm', expected: row.expectedEffect, met: false, note: `the revert rule tripped: worse than the baseline by more than ${rule.relative !== false ? `${Math.round(Number(rule.worseBy) * 100)}%` : rule.worseBy}` };
    const decided = await this.decide(org, row, 'reverted', result, 'system', now);
    const agentId = this.agentOf(org, row.proposedBy);
    await this.incidents?.reportIncident(orgId, {
      kind: 'experiment_harm', severity: 'minor', agentId, refType: 'experiment', refId: row.id,
      title: `Experiment "${row.title}" made the metric worse and was reverted`,
      detail: `Baseline ${fmt(baseline.mean)} (n=${baseline.n}); since the start ${fmt(window.mean)} (n=${window.n}), delta ${fmt(v.delta)}. ${result.note}. The change was reverted at once.`,
      cause: `experiment "${row.title.slice(0, 80)}" tripped its revert rule`,
    }).catch((err) => this.logger.warn(`experiment_harm incident failed: ${err instanceof Error ? err.message : err}`));
    return decided;
  }

  /** The verdict at endsAt (or the CEO's keep / revert): model-free. */
  async conclude(orgId: string, id: string, opts: { now?: Date; force?: 'keep' | 'revert'; actor?: string } = {}): Promise<OrgExperiment> {
    const now = opts.now ?? this.now();
    const org = await this.org.get(orgId);
    const row = await this.get(orgId, id);
    if (!LIVE.has(row.status)) throw new BadRequestException(`experiment "${row.title}" is ${row.status}`);
    const baseline = parseObj(row.baseline) as unknown as Baseline;
    const window = await this.windowStats(row, now);
    const v = row.metricSourceId
      ? verdictOf({ baseline, window, direction: row.direction as 'up' | 'down', minSamples: experimentTunable(org, 'experiments.minSamples'), noiseFloor: experimentTunable(org, 'experiments.noiseFloor') })
      : { delta: 0, relative: null, threshold: 0, verdict: 'inconclusive' as const };
    const effect = row.effectKind === 'relative' ? v.relative : v.delta;
    const signed = effect === null ? null : row.direction === 'up' ? effect : -effect;
    const result: ExperimentResult = { ...window, delta: v.delta, relative: v.relative, threshold: v.threshold, verdict: v.verdict, expected: row.expectedEffect, met: signed !== null && signed >= row.expectedEffect };
    const actor = opts.actor ?? 'system';
    if (opts.force) return this.decide(org, row, opts.force === 'keep' ? 'kept' : 'reverted', { ...result, note: `decided by the CEO (${opts.force})` }, actor, now);
    if (v.verdict === 'improved') return this.decide(org, row, 'kept', result, actor, now);
    if (v.verdict === 'worse') return this.decide(org, row, 'reverted', result, actor, now);
    if (row.extensions < experimentTunable(org, 'experiments.maxExtensions')) {
      const endsAt = new Date(Date.parse(row.endsAt ?? now.toISOString()) + row.windowDays * DAY).toISOString();
      await this.db.update(orgExperiments).set({ status: 'extended', extensions: row.extensions + 1, endsAt, result: JSON.stringify({ ...result, note: 'inconclusive — extended once by its window' }) }).where(eq(orgExperiments.id, row.id));
      this.mirror?.experimentChanged(orgId, row.id);
      await this.audit.append(orgId, { actor, action: 'experiment_extend', refType: 'experiment', refId: row.id, payload: { delta: v.delta, threshold: v.threshold, n: window.n, baselineN: baseline.n, endsAt, extensions: row.extensions + 1 } });
      if (org.chiefOfStaffAgentId) await this.agents.addEvent(org.chiefOfStaffAgentId, { kind: 'org_experiment', title: `Experiment extended: "${row.title}" — inconclusive so far (delta ${fmt(v.delta)}, noise ±${fmt(v.threshold)}, n=${window.n}); new end ${endsAt.slice(0, 10)}`.slice(0, 200), payload: JSON.stringify({ orgId, experimentId: row.id, status: 'extended' }), origin: 'loop' }).catch(() => undefined);
      return this.get(orgId, row.id);
    }
    return this.decide(org, row, 'reverted', { ...result, note: `inconclusive after ${row.extensions} extension(s) — reverted` }, actor, now);
  }

  /** Write the verdict: revert when it says so, the decision log, the inbox, the forecasts. */
  private async decide(org: Organization, row: OrgExperiment, status: 'kept' | 'reverted' | 'abandoned', result: ExperimentResult, actor: string, now: Date): Promise<OrgExperiment> {
    if (status !== 'kept') {
      const revert = await this.revert(org, row).catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }));
      if ('error' in revert) result.note = `${result.note ? `${result.note}; ` : ''}the automatic revert failed: ${revert.error}`;
      else if (revert.approvalId) result.revertApprovalId = revert.approvalId;
    }
    const src = row.metricSourceId ? (await this.db.select().from(orgMetricSources).where(eq(orgMetricSources.id, row.metricSourceId)).limit(1)).at(0) : null;
    const baseline = parseObj(row.baseline) as unknown as Partial<Baseline>;
    const numbers = row.metricSourceId
      ? `${src?.name ?? 'metric'}: baseline ${fmt(baseline.mean)} (n=${baseline.n ?? 0}, sd ${fmt(baseline.sd)}) → ${fmt(result.mean)} (n=${result.n}); delta ${result.delta >= 0 ? '+' : ''}${fmt(result.delta)}${result.relative !== null ? ` (${result.relative >= 0 ? '+' : ''}${Math.round(result.relative * 100)}%)` : ''}, noise ±${fmt(result.threshold)}; expected ${row.direction === 'up' ? '+' : '−'}${row.effectKind === 'relative' ? `${Math.round(row.expectedEffect * 100)}%` : fmt(row.expectedEffect)} (${result.met ? 'met' : 'not met'})`
      : 'unmeasured (kind other)';
    const verb = status === 'kept' ? 'Kept' : status === 'reverted' ? 'Reverted' : 'Abandoned';
    const decision = await this.logDecision(org.id, {
      title: `Experiment ${status}: ${row.title}`.slice(0, 200),
      decision: `${verb} the ${row.changeKind} change — verdict ${result.verdict}${result.note ? ` (${result.note})` : ''}.`,
      alternatives: status === 'kept' ? 'Revert it; extend it.' : 'Keep it; extend it.',
      rationale: `Hypothesis: ${row.hypothesis} Numbers: ${numbers}.${result.revertApprovalId ? ` The revert goes through approval ${result.revertApprovalId.slice(0, 8)}.` : ''}`,
      decidedBy: actor === 'system' ? 'experiment' : actor, unitId: row.unitId, refType: 'experiment', refId: row.id,
    });
    await this.db.update(orgExperiments).set({ status, result: JSON.stringify(result), decidedAt: now.toISOString(), decisionId: decision?.id ?? null }).where(eq(orgExperiments.id, row.id));
    this.mirror?.experimentChanged(org.id, row.id);
    await this.audit.append(org.id, { actor, action: `experiment_${status === 'kept' ? 'keep' : status === 'reverted' ? 'revert' : 'abandon'}`, refType: 'experiment', refId: row.id, payload: { verdict: result.verdict, delta: result.delta, relative: result.relative, n: result.n, threshold: result.threshold, met: result.met, revertApprovalId: result.revertApprovalId ?? null } });
    if (org.chiefOfStaffAgentId) {
      await this.agents.addEvent(org.chiefOfStaffAgentId, { kind: 'org_experiment', title: `Experiment ${status}: "${row.title}" — ${result.verdict}`.slice(0, 200), body: numbers.slice(0, 1_000), payload: JSON.stringify({ orgId: org.id, experimentId: row.id, status, verdict: result.verdict }), origin: 'loop' }).catch(() => undefined);
    }
    await this.predictions?.resolveSubject(org.id, 'experiment', row.id, now).catch(() => undefined);
    return this.get(org.id, row.id);
  }

  private async logDecision(orgId: string, input: { title: string; decision: string; alternatives: string; rationale: string; decidedBy: string; unitId: string | null; refType: string; refId: string }): Promise<{ id: string } | null> {
    if (this.meetings) return this.meetings.logDecision(orgId, input).catch(() => null);
    const row = { accountId: currentAccountId(), id: newId(), orgId, unitId: input.unitId, meetingId: null, approvalId: null, title: input.title, decision: input.decision.slice(0, 4_000), alternatives: input.alternatives, rationale: input.rationale.slice(0, 4_000), decidedBy: input.decidedBy.slice(0, 80), refType: input.refType, refId: input.refId, createdAt: nowIso() };
    await this.db.insert(orgDecisions).values(row);
    await this.audit.append(orgId, { actor: row.decidedBy, action: 'decision_log', refType: 'decision', refId: row.id, payload: { title: row.title } });
    return row;
  }

  /** Execute the revert recipe (charter / structure: the inverse card). */
  private async revert(org: Organization, row: OrgExperiment): Promise<{ approvalId?: string }> {
    const fresh = await this.org.get(org.id);
    const rev = (parseObj(row.change).revert ?? {}) as Record<string, unknown>;
    const why = `revert of experiment "${row.title}"`;
    switch (row.changeKind) {
      case 'tunable': {
        const key = String(rev.key ?? '');
        if (!TUNABLES[key]) throw new Error('no revert recipe');
        await this.org.setTunable(fresh.id, key, rev.value, { actor: 'experiment', why, decidedBy: 'experiment' });
        return {};
      }
      case 'cadence': await this.meetings!.setCadence(fresh.id, { unitId: String(rev.unitId), kind: String(rev.kind), cron: (rev.cron as string | null) ?? null, why, actor: 'experiment', decidedBy: 'experiment' }); return {};
      case 'routing': await this.org.setRouting(fresh.id, { classes: { [String(rev.class)]: rev.tier ?? null } }, { actor: 'experiment', why, decidedBy: 'experiment' }); return {};
      case 'playbook': if (rev.action === 'retire') await this.playbooks!.retire(fresh.id, String(rev.playbookId), 'experiment', why); else await this.playbooks!.activate(fresh.id, String(rev.playbookId), 'experiment'); return {};
      case 'charter':
      case 'structure': return { approvalId: await this.changeCard(fresh, row, rev, 'revert') };
      default: return {};
    }
  }

  // ---- the CEO's controls ----

  /** stop: a proposal is abandoned; a running experiment is reverted and abandoned. */
  async stop(orgId: string, id: string, actor: string, note = ''): Promise<OrgExperiment> {
    const org = await this.org.get(orgId);
    const row = await this.get(orgId, id);
    if (row.status === 'proposed') return this.abandon(orgId, row, actor, note || 'stopped by the CEO');
    if (!LIVE.has(row.status)) throw new BadRequestException(`experiment "${row.title}" is ${row.status}`);
    const window = await this.windowStats(row, this.now());
    const baseline = parseObj(row.baseline) as unknown as Baseline;
    const v = row.metricSourceId ? verdictOf({ baseline, window, direction: row.direction as 'up' | 'down', minSamples: experimentTunable(org, 'experiments.minSamples'), noiseFloor: experimentTunable(org, 'experiments.noiseFloor') }) : { delta: 0, relative: null, threshold: 0, verdict: 'inconclusive' as const };
    return this.decide(org, row, 'abandoned', { ...window, ...v, expected: row.expectedEffect, met: false, note: note || 'stopped by the CEO' }, actor, this.now());
  }

  private async abandon(orgId: string, row: OrgExperiment, actor: string, note: string): Promise<OrgExperiment> {
    await this.db.update(orgExperiments).set({ status: 'abandoned', decidedAt: nowIso(), result: JSON.stringify({ note }) }).where(eq(orgExperiments.id, row.id));
    this.mirror?.experimentChanged(orgId, row.id);
    await this.audit.append(orgId, { actor, action: 'experiment_abandon', refType: 'experiment', refId: row.id, payload: { note: note.slice(0, 300), status: row.status } });
    await this.predictions?.resolveSubject(orgId, 'experiment', row.id, this.now()).catch(() => undefined);
    return this.get(orgId, row.id);
  }

  // ---- the brief and the retro ----

  /** "Experiments": running ones with their reading so far, verdicts since the last brief, unmeasured changes. */
  async briefLines(orgId: string, since: string, now: Date = this.now()): Promise<string[]> {
    const rows = await this.rows(orgId);
    const running = rows.filter((r) => LIVE.has(r.status));
    const decided = rows.filter((r) => ['kept', 'reverted', 'abandoned'].includes(r.status) && (r.decidedAt ?? '') >= since);
    const unmeasured = await this.unmeasuredChanges(orgId, since);
    if (running.length === 0 && decided.length === 0 && unmeasured.length === 0) return [];
    const out = [`## Experiments (${running.length} running)`];
    for (const r of running.slice(0, 6)) {
      const b = parseObj(r.baseline) as unknown as Partial<Baseline>;
      const w = r.metricSourceId ? await this.windowStats(r, now) : null;
      const day = r.startedAt ? Math.max(1, Math.ceil((now.getTime() - Date.parse(r.startedAt)) / DAY)) : 0;
      out.push(`- ▶ ${r.title} (${r.changeKind}) — day ${day} of ${r.windowDays * (r.extensions + 1)}; ${w && w.n ? `${fmt(w.mean)} so far (n=${w.n}) vs baseline ${fmt(b.mean)}` : `baseline ${fmt(b.mean)}, no reading yet`}; expects ${r.direction === 'up' ? '+' : '−'}${r.effectKind === 'relative' ? `${Math.round(r.expectedEffect * 100)}%` : fmt(r.expectedEffect)}.`);
    }
    for (const r of decided.slice(0, 6)) {
      const res = parseObj(r.result) as unknown as Partial<ExperimentResult>;
      const mark = r.status === 'kept' ? '✓ kept' : r.status === 'reverted' ? '↺ reverted' : '✗ abandoned';
      out.push(`- ${mark}: ${r.title} — ${res.verdict ?? 'no verdict'}${res.delta !== undefined ? `, delta ${res.delta >= 0 ? '+' : ''}${fmt(res.delta)}${res.relative !== null && res.relative !== undefined ? ` (${res.relative >= 0 ? '+' : ''}${Math.round(res.relative * 100)}%)` : ''}` : ''}${res.note ? ` (${res.note})` : ''}.`);
    }
    for (const u of unmeasured.slice(0, 6)) out.push(`- ⚠ unmeasured change: ${u} — made directly, not as an experiment, so nobody will know whether it helped.`);
    return out;
  }

  /** Tunable, routing and cadence changes an agent made outside an experiment since `since`. */
  async unmeasuredChanges(orgId: string, since: string): Promise<string[]> {
    const rows = await this.db.select().from(orgAudit).where(and(eq(orgAudit.orgId, orgId), gte(orgAudit.createdAt, since))).orderBy(desc(orgAudit.seq)).limit(400);
    const out: string[] = [];
    for (const r of rows) {
      if (!['tunable_set', 'routing_set', 'cadence_set'].includes(r.action)) continue;
      if (!(r.actor === 'chief' || r.actor.startsWith('agent:'))) continue;
      const p = parseObj(r.payload);
      const who = r.actor === 'chief' ? 'the chief' : 'a lead';
      out.push(r.action === 'tunable_set' ? `tune ${String(p.key)} ${String(p.from)} → ${String(p.to)} (${who})` : r.action === 'routing_set' ? `${String(p.decision ?? 'routing change')} (${who})` : `${String(p.kind ?? 'meeting')} cadence → ${p.cron === null ? 'off' : String(p.cron)} (${who})`);
    }
    return out;
  }

  /** A retro's agenda: improve through experiments, and what the running ones say. */
  async retroAgenda(orgId: string): Promise<string | null> {
    const rows = await this.rows(orgId);
    const lines = ['## Improvement as experiments', 'For any change meant to move a metric (a tunable, a cadence, routing, a playbook, a charter, the structure), propose an experiment (org_propose_experiment: hypothesis, metric source, direction, expected effect, window) rather than making the change directly; the system measures it against the baseline and keeps or reverts it.'];
    const live = rows.filter((r) => LIVE.has(r.status));
    const recent = rows.filter((r) => ['kept', 'reverted'].includes(r.status)).slice(0, 5);
    if (live.length) lines.push(`Running: ${live.map((r) => `"${r.title}" (ends ${(r.endsAt ?? '').slice(0, 10)})`).join(', ')}.`);
    for (const r of recent) { const res = parseObj(r.result); lines.push(`- ${r.status}: "${r.title}" — ${String(res.verdict ?? '')}, delta ${fmt(Number(res.delta))}`); }
    return lines.join('\n');
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
      if (o?.chiefOfStaffAgentId === session.agentId || (this.units && await this.units.isLead(m.orgId, session.agentId))) return [READ_TOOL, PROPOSE_TOOL];
    }
    return [READ_TOOL];
  }

  owns(name: string): boolean { return TOOL_NAMES.has(name); }

  /** Internal and governed: a proposal is a card (supervised), a plan or a bounded, auto-reverting change (autonomous). */
  isReadOnly(name: string): boolean { return TOOL_NAMES.has(name); }

  async contextFor(): Promise<string | null> { return null; }

  async execute(session: ChatSession, name: string, input: Record<string, unknown>): Promise<string> {
    if (!this.enabled()) throw new Error('organizations are disabled on this server');
    const agentId = session.agentId!;
    const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string).trim() : '');
    const org = await this.resolveOrg(agentId, input.org);
    if (org.status !== 'active') throw new Error(`"${org.name}" is paused by the CEO`);
    const isChief = org.chiefOfStaffAgentId === agentId;
    const actor = isChief ? 'chief' : `agent:${agentId}`;
    const ctx = this.runtime?.runningCtx(session.id);
    if (name === 'org_experiments') {
      const rows = await this.list(org.id, { status: str('status') || undefined });
      if (rows.length === 0) return 'No experiments yet. Propose one with org_propose_experiment (chief and unit leads) for any change meant to move a metric.';
      const srcs = new Map((await this.db.select().from(orgMetricSources).where(eq(orgMetricSources.orgId, org.id))).map((s) => [s.id, s.name]));
      return rows.slice(0, 30).map((r) => {
        const b = parseObj(r.baseline); const res = parseObj(r.result);
        return `- [${r.id.slice(0, 8)}] ${r.status} "${r.title}" (${r.changeKind}) — ${r.metricSourceId ? `${srcs.get(r.metricSourceId) ?? 'metric'} ${r.direction === 'up' ? '↑' : '↓'} ${r.effectKind === 'relative' ? `${Math.round(r.expectedEffect * 100)}%` : r.expectedEffect}` : 'unmeasured'}, ${r.windowDays}d${b.n ? `; baseline ${fmt(Number(b.mean))} (n=${String(b.n)})` : ''}${res.verdict ? `; ${String(res.verdict)}, delta ${fmt(Number(res.delta))}` : ''}${r.endsAt && LIVE.has(r.status) ? `; ends ${r.endsAt.slice(0, 10)}` : ''}`;
      }).join('\n');
    }
    if (name === 'org_propose_experiment') {
      const lead = this.units ? await this.units.isLead(org.id, agentId) : null;
      if (!isChief && !lead) throw new Error('org_propose_experiment is for the chief of staff and unit leads');
      const change = input.change && typeof input.change === 'object' && !Array.isArray(input.change) ? input.change as Record<string, unknown> : {};
      const proposal: ExperimentInput = {
        title: str('title'), hypothesis: str('hypothesis'), changeKind: str('changeKind'), change, metric: str('metric') || undefined, keyResult: str('keyResult') || undefined,
        direction: str('direction'), expectedEffect: Number(input.expectedEffect), effectKind: str('effectKind') || undefined, windowDays: typeof input.windowDays === 'number' ? input.windowDays : undefined,
        revertRule: typeof input.revertWorseBy === 'number' ? { worseBy: input.revertWorseBy } : undefined, unitId: str('unit') || null,
      };
      if (ctx?.plan?.dryRun && !ctx.applying) {
        ctx.plan.actions.push({ tool: 'org_propose_experiment', input: { ...proposal }, estimateUsd: 0, summary: `experiment "${proposal.title}" (${proposal.changeKind})` });
        ctx.progress = true;
        return `Recorded (dry run, nothing applied): experiment "${proposal.title}".`;
      }
      const refusal = (err: unknown) => `refused: ${(err instanceof Error ? err.message : String(err)).replace(/^refused: /, '')}`;
      const row = await this.propose(org.id, proposal, actor).catch((err: unknown) => { throw new Error(refusal(err)); });
      // Inside an autonomous planning run, a structural experiment joins the run's plan.
      if (ctx?.plan && !ctx.applying && STRUCTURAL.has(row.changeKind) && (await this.workspaces.get(org.workspaceId).catch(() => null))?.orgMode === 'autonomous') {
        ctx.plan.actions.push({ tool: START_TOOL, input: { experimentId: row.id }, estimateUsd: 0, summary: `start experiment "${row.title}" (${row.changeKind})` });
        ctx.progress = true;
        return `Experiment [${row.id.slice(0, 8)}] "${row.title}" proposed and held in this plan: it starts after the CEO's veto window, then its ${row.changeKind} change goes to the CEO as a card.`;
      }
      const g = await this.govern(org.id, row, actor).catch(async (err: unknown) => {
        await this.abandon(org.id, row, 'system', `could not start: ${err instanceof Error ? err.message : String(err)}`);
        throw new Error(refusal(err));
      });
      if (ctx) ctx.progress = true;
      switch (g.how) {
        case 'approval': return `Experiment [${row.id.slice(0, 8)}] "${row.title}" proposed (approval ${g.approvalId?.slice(0, 8)}). Nothing changes until the CEO approves; then the baseline is snapshotted, the change applied and the verdict computed from the metric after ${row.windowDays} day(s).`;
        case 'plan': return `Experiment [${row.id.slice(0, 8)}] "${row.title}" is held in plan ${g.planId?.slice(0, 8)}: it starts after the CEO's veto window, then its ${row.changeKind} change goes to the CEO as a card.`;
        case 'waiting_change': return `Experiment [${row.id.slice(0, 8)}] "${row.title}": its ${row.changeKind} change went to the CEO as card ${g.row.changeApprovalId?.slice(0, 8)}; measuring starts when it is approved.`;
        default: {
          const b = parseObj(g.row.baseline);
          return `Experiment [${row.id.slice(0, 8)}] "${row.title}" started: baseline ${fmt(Number(b.mean))} over ${String(b.n ?? 0)} sample(s); the change is applied and the verdict comes on ${(g.row.endsAt ?? '').slice(0, 10)} — kept if the metric moves the right way beyond noise, reverted automatically otherwise (or at once if it gets worse than the revert rule allows).`;
        }
      }
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

  /** The CEO (only) decides experiments through the API. */
  async assertCeo(orgId: string, actor: string): Promise<void> {
    if ((await this.org.humanRole(orgId, actor)) !== 'ceo') throw new ForbiddenException('experiments are started, stopped, kept and reverted by the CEO');
  }
}

function round(x: number): number { return Math.round(x * 1e6) / 1e6; }
export function fmt(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '?';
  return Number.isInteger(v) ? String(v) : Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(2);
}
export function parseObj(raw: string | null | undefined): Record<string, unknown> {
  try { const v = JSON.parse(raw || '{}') as unknown; return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}; } catch { return {}; }
}
