/**
 * OrgMirrorService — the company's durable records as readable files in the
 * workspace tree (docs/filesystem.md "Mirrored company records"). The
 * records stay in their tables and the agents keep their tools; these are
 * small markdown mirrors under the shared /org/ folder, so people find them
 * in Artifacts instead of in dedicated panes:
 *
 *   /org/playbooks/<name>.md            a playbook: status, version, roles, body, outcomes
 *   /org/experiments/<id8>-<slug>.md    an experiment: change, metric, baseline, result, predictions
 *   /org/evals/<role>.md                a role's golden set and its latest eval runs / rollout gates
 *   /org/outcomes.md                    value realised against spend per objective
 *   /org/metrics.md                     every metric source with its latest readings
 *
 * The services that persist a record call the matching `…Changed` hook
 * (fire-and-forget: a mirror never fails or slows the write it follows); a
 * file is rewritten only when its text changed, by the `system` author. At
 * boot a one-off backfill writes the mirrors of existing rows — idempotent
 * (unchanged text is skipped), logged, never throws.
 */
import { Inject, Injectable, Logger, OnApplicationBootstrap, Optional } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { agents, organizations, orgEvalCases, orgEvalRuns, orgExperiments, orgMetricSamples, orgMetricSources, orgPlaybooks, orgPredictions } from '../database/schema';
import { WorkspaceFs, type FsActor } from '../files/workspace-fs.service';
import { AccountsService } from '../accounts/accounts.service';

type Playbook = typeof orgPlaybooks.$inferSelect;
type Experiment = typeof orgExperiments.$inferSelect;
type Prediction = typeof orgPredictions.$inferSelect;
type EvalRun = typeof orgEvalRuns.$inferSelect;
type EvalCase = typeof orgEvalCases.$inferSelect;
type MetricSource = typeof orgMetricSources.$inferSelect;
type MetricSample = typeof orgMetricSamples.$inferSelect;

/** The shape OrgSeatService.outcomes returns (kept structural: no import cycle). */
export interface OutcomeRow {
  objectiveId: string; title: string; unitId: string | null;
  keyResults: Array<{ goalId: string; title: string; measured: boolean; movement7d: number | null; value: number | null; target: number | null }>;
  valueUsd: number; spentUsd: number; roi: number | null;
}

export const MIRROR_AUTHOR: FsActor = { kind: 'system', id: 'system', name: 'company records' };
const NOTE = '_Mirrored from the company records — read-only here; changes are made through the agents\' tools and overwrite this file._';

// ---- paths ----

/** A file-name-safe slug: lowercase words joined by '-', at most 48 chars. */
export function slugify(s: string, fallback = 'untitled'): string {
  const out = s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '');
  return out || fallback;
}
export const playbookPath = (p: Pick<Playbook, 'name' | 'id'>): string => `org/playbooks/${slugify(p.name, p.id.slice(0, 8))}.md`;
export const experimentPath = (e: Pick<Experiment, 'id' | 'title'>): string => `org/experiments/${e.id.slice(0, 8)}-${slugify(e.title)}.md`;
export const evalsPath = (roleKey: string): string => `org/evals/${slugify(roleKey, 'role')}.md`;
export const OUTCOMES_PATH = 'org/outcomes.md';
export const METRICS_PATH = 'org/metrics.md';

// ---- rendering (pure) ----

const json = <T>(s: string | null | undefined, fallback: T): T => { try { return s ? JSON.parse(s) as T : fallback; } catch { return fallback; } };
const day = (iso: string | null | undefined): string => (iso ? iso.slice(0, 10) : '—');
const when = (iso: string | null | undefined): string => (iso ? iso.slice(0, 16).replace('T', ' ') : '—');
const num = (n: number | null | undefined, digits = 2): string => (n === null || n === undefined || !Number.isFinite(n) ? '—' : String(Number(n.toFixed(digits))));
const pct = (n: number | null | undefined): string => (n === null || n === undefined ? '—' : `${Math.round(n * 100)}%`);
const usd = (n: number): string => `$${n.toFixed(2)}`;
const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
const compact = (v: unknown, max = 600): string => { const s = JSON.stringify(v); return s.length > max ? `${s.slice(0, max)}…` : s; };

export function renderPlaybook(p: Playbook): string {
  const roles = json<string[]>(p.roles, []);
  const o = json<{ uses?: number; up?: number; down?: number; successRate?: number | null; lastUsedAt?: string | null }>(p.outcomes, {});
  const lines = [
    `# ${p.title || p.name}`, '',
    `Status: **${p.status}** · version ${p.version} · offered to ${roles.length ? roles.join(', ') : 'everyone'} · updated ${day(p.updatedAt)}`, '',
    NOTE, '',
    (p.body || '').trim() || '_(empty)_', '',
    '---', '',
  ];
  if (p.why) lines.push(`Why: ${p.why.trim()}`, '');
  if (o.uses) lines.push(`Outcomes: used ${o.uses}× · 👍 ${o.up ?? 0} · 👎 ${o.down ?? 0}${o.successRate !== undefined && o.successRate !== null ? ` · success ${pct(o.successRate)}` : ''}${o.lastUsedAt ? ` · last used ${day(o.lastUsedAt)}` : ''}`, '');
  return `${lines.join('\n').trimEnd()}\n`;
}

export function renderExperiment(e: Experiment, opts: { metric?: string | null; predictions?: Prediction[]; agentName?: (id: string) => string } = {}): string {
  const change = json<Record<string, unknown>>(e.change, {});
  const baseline = json<Record<string, unknown>>(e.baseline, {});
  const result = json<Record<string, unknown>>(e.result, {});
  const effect = e.effectKind === 'relative' ? `${e.expectedEffect >= 0 ? '+' : ''}${Math.round(e.expectedEffect * 100)}%` : `${e.expectedEffect >= 0 ? '+' : ''}${num(e.expectedEffect)}`;
  const lines = [
    `# Experiment: ${e.title}`, '',
    `Status: **${e.status}** · ${e.design.replace('_', ' ')} · ${e.windowDays}-day window${e.extensions ? ` (extended ${e.extensions}×)` : ''} · proposed by ${e.proposedBy} on ${day(e.createdAt)}`,
    `Started ${day(e.startedAt)} · ends ${day(e.endsAt)}${e.decidedAt ? ` · decided ${day(e.decidedAt)}` : ''}`, '',
    NOTE, '',
  ];
  if (e.hypothesis) lines.push(`**Hypothesis.** ${e.hypothesis.trim()}`, '');
  lines.push(`**Change** (${e.changeKind}): \`${compact(change.apply ?? change)}\``, '');
  lines.push(`**Measured by** ${opts.metric ?? (e.metricSourceId ? `source ${e.metricSourceId.slice(0, 8)}` : 'nothing (unmeasured)')} — ${e.direction} is better · expected ${effect}`, '');
  if (Object.keys(baseline).length) lines.push(`**Baseline**: \`${compact(baseline, 300)}\``, '');
  if (Object.keys(result).length) {
    const verdict = typeof result.verdict === 'string' ? result.verdict : null;
    const note = typeof result.note === 'string' ? result.note : null;
    lines.push(`**Result**${verdict ? `: ${verdict}` : ''}${note ? ` — ${note}` : ''}`, '', `\`${compact(result, 400)}\``, '');
  }
  const preds = opts.predictions ?? [];
  if (preds.length) {
    lines.push('## Predictions', '');
    for (const p of preds) {
      const f = json<{ kind?: string; value?: unknown; low?: unknown; high?: unknown; unit?: string }>(p.forecast, {});
      const o = json<{ value?: unknown; reason?: string }>(p.outcome, {});
      const who = opts.agentName ? opts.agentName(p.agentId) : p.agentId.slice(0, 8);
      const range = f.low !== undefined && f.high !== undefined ? ` (${String(f.low)}–${String(f.high)})` : '';
      lines.push(`- ${who}: ${p.question || 'forecast'} → ${String(f.value ?? '?')}${f.unit ? ` ${f.unit}` : ''}${range} · ${p.status}${p.status === 'resolved' ? ` · actual ${String(o.value ?? '?')} · loss ${num(p.score)}` : ''}`);
    }
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

export function renderEvals(roleKey: string, cases: EvalCase[], runs: EvalRun[]): string {
  const live = cases.filter((c) => !c.retiredAt);
  const by = (s: string) => live.filter((c) => c.source === s).length;
  const lines = [
    `# Evals: ${roleKey}`, '',
    `Golden set: **${live.length}** active case(s) — ${by('check')} from checks, ${by('review')} from first-round reviews, ${by('manual')} added by hand.`, '',
    NOTE, '',
  ];
  const shown = runs.filter((r) => r.kind === 'candidate').slice(0, 12);
  if (!shown.length) lines.push('No eval runs yet.');
  else {
    lines.push('## Recent runs', '', '| When | Candidate | Pass rate | Baseline | Verdict | Asked by |', '|---|---|---|---|---|---|');
    for (const r of shown) {
      const c = json<{ kind?: string; ref?: string }>(r.candidate, {});
      const gate = r.requestedBy.startsWith('gate:') ? `rollout gate (${r.requestedBy.slice(5)})` : r.requestedBy;
      lines.push(`| ${when(r.startedAt)} | ${cell(`${c.kind ?? '?'}${c.ref ? ` ${c.ref}` : ''}`)} | ${pct(r.passRate)} | ${pct(r.baselinePassRate)} | ${r.status === 'running' ? 'running' : r.status === 'failed' ? 'failed' : r.verdict || '—'} | ${cell(gate)} |`);
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

export function renderOutcomes(rows: OutcomeRow[], now = new Date()): string {
  const lines = ['# Outcomes', '', `Value realised this month against spend, per active objective. Refreshed ${day(now.toISOString())}.`, '', NOTE, ''];
  if (!rows.length) lines.push('No active objectives yet.');
  for (const o of rows) {
    lines.push(`## ${o.title}`, '', `Value ${usd(o.valueUsd)} · spent ${usd(o.spentUsd)} · ROI ${o.roi === null ? '—' : `${num(o.roi)}×`}`, '');
    for (const k of o.keyResults) {
      const move = k.movement7d === null ? '' : ` · 7-day movement ${k.movement7d >= 0 ? '+' : ''}${num(k.movement7d)}`;
      lines.push(`- ${k.title}: ${num(k.value)} / ${num(k.target)}${move} (${k.measured ? 'measured' : 'self-reported'})`);
    }
    if (o.keyResults.length) lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

export function renderMetrics(sources: MetricSource[], samples: Map<string, MetricSample[]>, now = new Date()): string {
  const lines = ['# Metrics', '', `Every metric source and its latest readings. Refreshed ${when(now.toISOString())}.`, '', NOTE, ''];
  if (!sources.length) return `${[...lines, 'No metric sources yet.'].join('\n')}\n`;
  lines.push('| Source | Kind | Status | Latest | Last fetched |', '|---|---|---|---|---|');
  for (const s of sources) lines.push(`| ${cell(s.name)} | ${s.kind} | ${s.status} | ${num(s.lastValue)}${s.unit ? ` ${cell(s.unit)}` : ''} | ${when(s.lastFetchedAt)} |`);
  lines.push('');
  for (const s of sources) {
    const recent = samples.get(s.id) ?? [];
    if (!recent.length) continue;
    lines.push(`## ${s.name}`, '', ...recent.map((x) => `- ${when(x.observedAt)}: ${num(x.value)}${s.unit ? ` ${s.unit}` : ''}`), '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

// ---- the service ----

@Injectable()
export class OrgMirrorService implements OnApplicationBootstrap {
  private readonly logger = new Logger(OrgMirrorService.name);
  private readonly pending = new Set<Promise<unknown>>();
  private readonly wsOf = new Map<string, string>();
  /** OrgSeatService registers itself: the outcomes table needs its spend join. */
  private outcomesOf?: (orgId: string) => Promise<OutcomeRow[]>;

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    @Optional() private readonly fs?: WorkspaceFs,
    @Optional() private readonly accounts?: AccountsService,
  ) {}

  setOutcomesSource(fn: (orgId: string) => Promise<OutcomeRow[]>): void { this.outcomesOf = fn; }

  /** Resolves when every mirror write in flight has settled (tests). */
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  // ---- hooks (fire-and-forget) ----

  playbookChanged(orgId: string, id: string): void { this.spawn(`playbook ${id}`, () => this.writePlaybook(orgId, id)); }
  experimentChanged(orgId: string, id: string): void { this.spawn(`experiment ${id}`, () => this.writeExperiment(orgId, id)); }
  evalsChanged(orgId: string, roleKey: string): void { this.spawn(`evals ${roleKey}`, () => this.writeEvals(orgId, roleKey)); }
  outcomesChanged(orgId: string): void { this.spawn('outcomes', () => this.writeOutcomes(orgId)); }
  metricsChanged(orgId: string): void { this.spawn('metrics', () => this.writeMetrics(orgId)); }

  private spawn(what: string, fn: () => Promise<unknown>): void {
    if (!this.fs) return;
    const p = Promise.resolve().then(fn).catch((err) => this.logger.warn(`mirror of ${what} failed: ${err instanceof Error ? err.message : err}`));
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
  }

  // ---- writers ----

  async writePlaybook(orgId: string, id: string): Promise<boolean> {
    const p = (await this.db.select().from(orgPlaybooks).where(and(eq(orgPlaybooks.orgId, orgId), eq(orgPlaybooks.id, id))).limit(1)).at(0);
    return p ? this.put(orgId, playbookPath(p), renderPlaybook(p)) : false;
  }

  async writeExperiment(orgId: string, id: string): Promise<boolean> {
    const e = (await this.db.select().from(orgExperiments).where(and(eq(orgExperiments.orgId, orgId), eq(orgExperiments.id, id))).limit(1)).at(0);
    if (!e) return false;
    const metric = e.metricSourceId ? (await this.db.select({ name: orgMetricSources.name }).from(orgMetricSources).where(eq(orgMetricSources.id, e.metricSourceId)).limit(1)).at(0)?.name ?? null : null;
    const predictions = (await this.db.select().from(orgPredictions).where(and(eq(orgPredictions.orgId, orgId), eq(orgPredictions.subjectKind, 'experiment'), eq(orgPredictions.subjectId, e.id))).orderBy(asc(orgPredictions.createdAt)))
      .filter((p) => p.status !== 'void');
    const names = await this.agentNames(predictions.map((p) => p.agentId));
    return this.put(orgId, experimentPath(e), renderExperiment(e, { metric, predictions, agentName: (a) => names.get(a) ?? a.slice(0, 8) }));
  }

  async writeEvals(orgId: string, roleKey: string): Promise<boolean> {
    const cases = await this.db.select().from(orgEvalCases).where(and(eq(orgEvalCases.orgId, orgId), eq(orgEvalCases.roleKey, roleKey)));
    const runs = await this.db.select().from(orgEvalRuns).where(and(eq(orgEvalRuns.orgId, orgId), eq(orgEvalRuns.roleKey, roleKey))).orderBy(desc(orgEvalRuns.startedAt)).limit(40);
    if (!cases.length && !runs.length) return false;
    return this.put(orgId, evalsPath(roleKey), renderEvals(roleKey, cases, runs));
  }

  async writeOutcomes(orgId: string, rows?: OutcomeRow[]): Promise<boolean> {
    const data = rows ?? (this.outcomesOf ? await this.outcomesOf(orgId) : null);
    if (!data || !data.length) return false;
    return this.put(orgId, OUTCOMES_PATH, renderOutcomes(data));
  }

  async writeMetrics(orgId: string): Promise<boolean> {
    const sources = (await this.db.select().from(orgMetricSources).where(eq(orgMetricSources.orgId, orgId)).orderBy(asc(orgMetricSources.name)))
      .filter((s) => s.status !== 'rejected');
    if (!sources.length) return false;
    const samples = new Map<string, MetricSample[]>();
    for (const s of sources) samples.set(s.id, await this.db.select().from(orgMetricSamples).where(eq(orgMetricSamples.sourceId, s.id)).orderBy(desc(orgMetricSamples.observedAt)).limit(5));
    return this.put(orgId, METRICS_PATH, renderMetrics(sources, samples));
  }

  /** Write `text` at `path` in the org's workspace unless it already says exactly that. */
  private async put(orgId: string, path: string, text: string): Promise<boolean> {
    if (!this.fs) return false;
    const ws = await this.workspaceOf(orgId);
    if (!ws) return false;
    const current = await this.fs.read(ws, path).catch(() => null);
    if (current && current.body.toString('utf8') === text) return false;
    await this.fs.write(ws, path, Buffer.from(text, 'utf8'), { by: MIRROR_AUTHOR, contentType: 'text/markdown' });
    return true;
  }

  private async workspaceOf(orgId: string): Promise<string | null> {
    const hit = this.wsOf.get(orgId);
    if (hit) return hit;
    const row = (await this.db.select({ workspaceId: organizations.workspaceId }).from(organizations).where(eq(organizations.id, orgId)).limit(1)).at(0);
    if (row) this.wsOf.set(orgId, row.workspaceId);
    return row?.workspaceId ?? null;
  }

  private async agentNames(ids: string[]): Promise<Map<string, string>> {
    const uniq = [...new Set(ids)];
    if (!uniq.length) return new Map();
    const rows = await this.db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, uniq));
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  // ---- the boot backfill ----

  onApplicationBootstrap(): void {
    if (!this.fs?.versioned) return;
    void this.backfillAll().catch((err) => this.logger.warn(`org mirror backfill failed: ${err instanceof Error ? err.message : err}`));
  }

  /** Every account's organizations (one account without AccountsService). */
  async backfillAll(): Promise<number> {
    let n = 0;
    const one = async () => { n += await this.backfill(); };
    if (this.accounts) await this.accounts.forEachAccount(one);
    else await one();
    if (n) this.logger.log(`org mirror backfill: wrote ${n} file(s) under /org/`);
    return n;
  }

  /** Mirror every existing record of the current account's organizations.
   *  Idempotent: unchanged files are skipped. Never throws. Returns how many files it wrote. */
  async backfill(): Promise<number> {
    let n = 0;
    const count = async (what: string, fn: () => Promise<boolean>) => {
      try { if (await fn()) n++; } catch (err) { this.logger.warn(`org mirror backfill of ${what} failed: ${err instanceof Error ? err.message : err}`); }
    };
    let orgs: Array<{ id: string }> = [];
    try { orgs = await this.db.select({ id: organizations.id }).from(organizations); } catch (err) {
      this.logger.warn(`org mirror backfill could not list organizations: ${err instanceof Error ? err.message : err}`);
      return 0;
    }
    for (const org of orgs) {
      const playbooks = await this.db.select({ id: orgPlaybooks.id }).from(orgPlaybooks).where(eq(orgPlaybooks.orgId, org.id)).catch(() => []);
      for (const p of playbooks) await count(`playbook ${p.id}`, () => this.writePlaybook(org.id, p.id));
      const exps = await this.db.select({ id: orgExperiments.id }).from(orgExperiments).where(eq(orgExperiments.orgId, org.id)).catch(() => []);
      for (const e of exps) await count(`experiment ${e.id}`, () => this.writeExperiment(org.id, e.id));
      const roles = new Set<string>();
      for (const r of await this.db.select({ roleKey: orgEvalRuns.roleKey }).from(orgEvalRuns).where(eq(orgEvalRuns.orgId, org.id)).catch(() => [])) roles.add(r.roleKey);
      for (const r of await this.db.select({ roleKey: orgEvalCases.roleKey }).from(orgEvalCases).where(and(eq(orgEvalCases.orgId, org.id), isNull(orgEvalCases.retiredAt))).catch(() => [])) roles.add(r.roleKey);
      for (const role of roles) await count(`evals ${role}`, () => this.writeEvals(org.id, role));
      await count('metrics', () => this.writeMetrics(org.id));
      if (this.outcomesOf) await count('outcomes', () => this.writeOutcomes(org.id));
    }
    return n;
  }
}
