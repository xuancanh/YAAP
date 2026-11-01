/**
 * OrgReconciliationService — claimed versus measured (docs/experiments.md §3,
 * execution-plan item 30; the remainder of C9 in
 * docs/autonomous-org-first-principles.md).
 *
 * A daily, model-free sweep per organization compares what members claim
 * with the ground truth they did not write:
 *
 *  - **Key results** bound to a metric source: the owner's confidence trend
 *    against the measured pace — confidence ≥ `reconciliation.overclaimConfidence`
 *    on the last two check-ins while the source's value at each check-in put
 *    the key result behind its linear pace by more than `intent.paceTolerance`
 *    is an `overclaim`. A number in the latest check-in note right after the
 *    key result's title or metric ("subscribers 450", "subscribers at 80%") is
 *    compared with the measured value (or progress) too; nothing else of the
 *    free text is parsed.
 *  - **Tasks accepted by review** (not by check) whose `done_when` names a
 *    metric source with a number, or a workspace file: the derived check runs
 *    once after acceptance (`OrgSensingService.runAdHocCheck`); a failure is a
 *    `claim_mismatch` signal to the chief and a minor incident.
 *  - **The brief's report numbers** (this month's company spend, tasks
 *    accepted since the last brief) recomputed from the ledger rows; a
 *    difference is a `report_drift` signal.
 *
 * The gaps of the latest sweep are kept on the audit chain
 * (`reconciliation_sweep`), served by `GET …/org/reconciliation`, shown in
 * the brief and handed to the auditor as part of its sampled material.
 */
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, desc, eq, gte, lt, lte, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { orgAudit, orgCheckins, orgMetricSamples, orgMetricSources, orgRuns, orgTasks } from '../database/schema';
import { AccountsService } from '../accounts/accounts.service';
import { OrgService, type Organization, type OrgGoal } from './org.service';
import { OrgAuditService } from './org-audit.service';
import { OrgTasksService, parseBrief, type OrgTask } from './org-tasks.service';
import { OrgSignalsService } from './org-signals.service';
import { OrgSensingService } from './org-sensing.service';
import { OrgIncidentsService } from './org-incidents.service';
import { OrgBriefService } from './org-brief.service';
import { OrgAuditorService } from './org-auditor.service';
import { measuredProgress } from './org-intent.service';
import { tunable } from './org-tunables';
import { experimentTunable } from './experiment-tunables';
import type { Check } from './org-checks';

export type GapKind = 'overclaim' | 'claimed_number' | 'claim_mismatch' | 'report_drift';
export interface Gap { kind: GapKind; refType: string; refId: string; title: string; detail: string; claimed?: number | string | null; measured?: number | null }
export interface Reconciliation { at: string | null; gaps: Gap[]; checked: { keyResults: number; tasks: number; brief: boolean } }

const DAY = 86_400_000;
const RECENT_DAYS = 14;
const FILE_RE = /(?:^|[\s`'"(])((?:[\w.-]+\/)*[\w.-]+\.(?:md|txt|json|csv|html|pdf|docx|xlsx|png|jpg|jpeg|yaml|yml|xml))\b/i;

/** The linear expectation (0–1) of a key result at `at` (pure). */
export function expectedAt(g: Pick<OrgGoal, 'createdAt' | 'dueAt'>, at: Date): number | null {
  if (!g.dueAt) return null;
  const t0 = Date.parse(g.createdAt); const t1 = Date.parse(g.dueAt);
  if (!Number.isFinite(t0) || !Number.isFinite(t1)) return null;
  return t1 <= t0 ? 1 : Math.min(1, Math.max(0, (at.getTime() - t0) / (t1 - t0)));
}

/** A number written right after the key result's title or metric (pure): "subscribers 450", "Subscribers: 80%". */
export function claimedNumber(note: string, names: string[]): { value: number; percent: boolean } | null {
  for (const name of names.map((n) => n.trim()).filter((n) => n.length >= 3)) {
    const re = new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(?:is|are|at|=|:|reached|now)?\\s*(?:at\\s*)?(-?\\d+(?:[.,]\\d+)?)\\s*(%)?`, 'i');
    const m = re.exec(note);
    if (m) return { value: Number(m[1].replace(',', '.')), percent: Boolean(m[2]) };
  }
  return null;
}

/** A check derived from `done_when` (pure): a named source with a number, else a workspace file. */
export function deriveCheck(doneWhen: string, sources: Array<{ id: string; name: string }>): Check | null {
  const text = doneWhen ?? '';
  for (const s of sources) {
    const at = text.toLowerCase().indexOf(s.name.toLowerCase());
    if (at < 0) continue;
    const after = text.slice(at + s.name.length, at + s.name.length + 40);
    const before = text.slice(Math.max(0, at - 30), at);
    const m = /(?:≥|>=|at least|reaches?|to|of|=|:)?\s*(\d+(?:\.\d+)?)/i.exec(after) ?? /(?:≥|>=|at least)\s*(\d+(?:\.\d+)?)\s*$/i.exec(before);
    if (m) return { kind: 'metric_at_least', sourceId: s.id, value: Number(m[1]) };
  }
  const f = FILE_RE.exec(text);
  if (f && !f[1].includes('..')) return { kind: 'file_exists', path: f[1].replace(/^\/+/, '') };
  return null;
}

@Injectable()
export class OrgReconciliationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OrgReconciliationService.name);
  private timer?: ReturnType<typeof setInterval>;
  now: () => Date = () => new Date();

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly org: OrgService,
    private readonly audit: OrgAuditService,
    private readonly tasks: OrgTasksService,
    private readonly config: ConfigService,
    @Optional() private readonly signals?: OrgSignalsService,
    @Optional() private readonly sensing?: OrgSensingService,
    @Optional() private readonly incidents?: OrgIncidentsService,
    @Optional() private readonly brief?: OrgBriefService,
    @Optional() private readonly auditor?: OrgAuditorService,
    @Optional() private readonly accounts?: AccountsService,
  ) {
    if (!this.enabled()) return;
    this.brief?.addSection({ position: 'improve', lines: (orgId, since) => this.briefLines(orgId, since) });
    this.auditor?.addMaterial((org) => this.auditMaterial(org));
  }

  enabled(): boolean { return this.config.get<boolean>('companiesEnabled') !== false; }

  onModuleInit(): void {
    if (!this.enabled()) return;
    this.timer = setInterval(() => { void this.tick(this.now()); }, 60 * 60_000);
  }

  onModuleDestroy(): void { clearInterval(this.timer); }

  async tick(now: Date = this.now()): Promise<void> {
    if (!this.enabled()) return;
    const one = async () => {
      for (const org of await this.org.list()) {
        if (org.status !== 'active') continue;
        const last = await this.latest(org.id);
        if (last.at && now.getTime() - Date.parse(last.at) < DAY) continue;
        await this.sweep(org.id, now).catch((err) => this.logger.warn(`reconciliation for org ${org.id} failed: ${err instanceof Error ? err.message : err}`));
      }
    };
    if (!this.accounts) return one();
    await this.accounts.forEachAccount(one);
  }

  /** The latest sweep's gaps (`GET …/org/reconciliation`). */
  async latest(orgId: string): Promise<Reconciliation> {
    const row = (await this.db.select().from(orgAudit).where(and(eq(orgAudit.orgId, orgId), eq(orgAudit.action, 'reconciliation_sweep'))).orderBy(desc(orgAudit.seq)).limit(1)).at(0);
    if (!row) return { at: null, gaps: [], checked: { keyResults: 0, tasks: 0, brief: false } };
    const p = parseObj(row.payload) as { gaps?: Gap[]; checked?: Reconciliation['checked'] };
    return { at: row.createdAt, gaps: Array.isArray(p.gaps) ? p.gaps : [], checked: p.checked ?? { keyResults: 0, tasks: 0, brief: false } };
  }

  /** One sweep: key results, review-accepted tasks, the brief. */
  async sweep(orgId: string, now: Date = this.now()): Promise<Reconciliation> {
    const org = await this.org.get(orgId);
    const gaps: Gap[] = [];
    const kr = await this.keyResults(org, now, gaps);
    const tasks = await this.reviewedTasks(org, now, gaps);
    const brief = await this.reportNumbers(org, now, gaps);
    const checked = { keyResults: kr, tasks, brief };
    await this.audit.append(orgId, { actor: 'system', action: 'reconciliation_sweep', refType: 'org', refId: orgId, payload: { gaps: fitGaps(gaps), checked } });
    return { at: now.toISOString(), gaps, checked };
  }

  // ---- key results: confidence trend versus measured pace, a claimed number ----

  private async keyResults(org: Organization, now: Date, gaps: Gap[]): Promise<number> {
    const bar = experimentTunable(org, 'reconciliation.overclaimConfidence');
    const tol = tunable(org, 'intent.paceTolerance');
    const goals = (await this.org.goals(org.id)).filter((g) => g.kind === 'key_result' && g.status === 'active' && g.metricSourceId);
    for (const g of goals) {
      const checkins = (await this.db.select().from(orgCheckins).where(and(eq(orgCheckins.orgId, org.id), eq(orgCheckins.goalId, g.id))).orderBy(desc(orgCheckins.createdAt)).limit(2));
      const valueAt = async (iso: string) => (await this.db.select().from(orgMetricSamples).where(and(eq(orgMetricSamples.sourceId, g.metricSourceId!), lte(orgMetricSamples.observedAt, iso))).orderBy(desc(orgMetricSamples.observedAt)).limit(1)).at(0)?.value ?? null;
      if (checkins.length === 2 && checkins.every((c) => c.confidence !== null && c.confidence >= bar)) {
        const behind: Array<{ at: string; progress: number; expected: number }> = [];
        for (const c of checkins) {
          const v = await valueAt(c.createdAt);
          const progress = v === null ? null : measuredProgress({ targetValue: g.targetValue, startValue: g.startValue, currentValue: v });
          const expected = expectedAt(g, new Date(c.createdAt));
          if (progress !== null && expected !== null && progress < expected - tol) behind.push({ at: c.createdAt, progress, expected });
        }
        if (behind.length === 2) {
          const detail = `Owner confidence ${checkins.map((c) => c.confidence).reverse().join(' → ')} on the last two check-ins while the source measured ${behind.map((b) => `${Math.round(b.progress * 100)}% (pace ${Math.round(b.expected * 100)}%)`).reverse().join(' → ')}: behind by more than ${Math.round(tol * 100)} points both times.`;
          gaps.push({ kind: 'overclaim', refType: 'goal', refId: g.id, title: `Overclaim on "${g.title}"`, detail, claimed: checkins[0].confidence, measured: behind[0].progress });
          await this.signals?.open(org.id, { kind: 'overclaim', severity: 'warn', refType: 'goal', refId: g.id, addressee: 'chief', title: `Overclaim: "${g.title}" is behind its measured pace while its owner stays confident`, detail, unitId: g.unitId }, now).catch(() => undefined);
        }
      }
      const note = checkins[0]?.note ?? '';
      const claim = note ? claimedNumber(note, [g.title, g.metric]) : null;
      if (claim && g.currentValue !== null) {
        const progress = measuredProgress(g);
        const measured = claim.percent && g.unitLabel !== '%' ? (progress === null ? null : Math.round(progress * 1000) / 10) : g.currentValue;
        if (measured !== null && Math.abs(claim.value - measured) > tol * Math.max(Math.abs(measured), 1)) {
          const detail = `The latest check-in note says ${claim.value}${claim.percent ? '%' : ''}; the source measures ${measured}${claim.percent && g.unitLabel !== '%' ? '% of the way' : g.unitLabel ? ` ${g.unitLabel}` : ''}.`;
          gaps.push({ kind: 'claimed_number', refType: 'goal', refId: g.id, title: `Claimed number on "${g.title}" differs from the source`, detail, claimed: claim.value, measured });
          if (claim.value > measured) await this.signals?.open(org.id, { kind: 'overclaim', severity: 'warn', refType: 'goal', refId: g.id, addressee: 'chief', title: `Overclaim: a check-in on "${g.title}" claims more than the source measures`, detail, unitId: g.unitId }, now).catch(() => undefined);
        }
      }
    }
    return goals.length;
  }

  // ---- tasks accepted by review: run the derivable check once ----

  private async reviewedTasks(org: Organization, now: Date, gaps: Gap[]): Promise<number> {
    if (!this.sensing) return 0;
    const since = new Date(now.getTime() - RECENT_DAYS * DAY).toISOString();
    const done = (await this.db.select().from(orgTasks).where(and(eq(orgTasks.orgId, org.id), eq(orgTasks.status, 'done'), eq(orgTasks.acceptedBy, 'review'), gte(orgTasks.updatedAt, since)))) as OrgTask[];
    if (done.length === 0) return 0;
    const seen = new Set((await this.db.select({ refId: orgAudit.refId }).from(orgAudit).where(and(eq(orgAudit.orgId, org.id), eq(orgAudit.action, 'reconcile_task'), gte(orgAudit.createdAt, since)))).map((r) => r.refId));
    const sources = (await this.db.select().from(orgMetricSources).where(eq(orgMetricSources.orgId, org.id))).filter((s) => ['ok', 'error', 'stale'].includes(s.status)).map((s) => ({ id: s.id, name: s.name }));
    let checked = 0;
    for (const t of done.filter((x) => !seen.has(x.id)).slice(0, 20)) {
      const check = deriveCheck(parseBrief(t.brief).done_when, sources);
      if (!check) { await this.audit.append(org.id, { actor: 'system', action: 'reconcile_task', refType: 'task', refId: t.id, payload: { status: 'none' } }); continue; }
      checked++;
      const r = await this.sensing.runAdHocCheck(org.id, t.id, check, 'reconciliation');
      await this.audit.append(org.id, { actor: 'system', action: 'reconcile_task', refType: 'task', refId: t.id, payload: { check, status: r.status, detail: r.detail.slice(0, 300) } });
      if (r.status !== 'fail') continue;
      const detail = `Accepted by review; its done_when ("${parseBrief(t.brief).done_when.slice(0, 200)}") derives a check that fails: ${r.detail}`;
      gaps.push({ kind: 'claim_mismatch', refType: 'task', refId: t.id, title: `"${t.title}" was accepted but its derived check fails`, detail });
      await this.signals?.open(org.id, { kind: 'claim_mismatch', severity: 'warn', refType: 'task', refId: t.id, addressee: 'chief', title: `Claim mismatch: "${t.title}" was accepted but ground truth disagrees`, detail, unitId: t.unitId }, now).catch(() => undefined);
      await this.incidents?.reportIncident(org.id, { kind: 'claim_mismatch', severity: 'minor', taskId: t.id, title: `Accepted work does not match ground truth: "${t.title}"`, detail, cause: `a check derived from the done_when of "${t.title.slice(0, 80)}" failed after review accepted it` })
        .catch((err) => this.logger.warn(`claim_mismatch incident failed: ${err instanceof Error ? err.message : err}`));
    }
    return checked;
  }

  // ---- the brief's numbers versus the ledger rows ----

  private async reportNumbers(org: Organization, now: Date, gaps: Gap[]): Promise<boolean> {
    if (!this.brief) return false;
    const b = await this.brief.compose(org.id, { deliver: false, now }).catch(() => null);
    if (!b) return false;
    const month = now.toISOString().slice(0, 7);
    const monthStart = `${month}-01T00:00:00.000Z`;
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
    const spend = (await this.db.select({ usd: sql<number>`coalesce(sum(${orgRuns.usd}), 0)` }).from(orgRuns).where(and(eq(orgRuns.orgId, org.id), gte(orgRuns.startedAt, monthStart), lt(orgRuns.startedAt, next)))).at(0)?.usd ?? 0;
    const since = org.lastBriefAt ?? new Date(now.getTime() - DAY).toISOString();
    const accepted = (await this.db.select({ n: sql<number>`count(*)` }).from(orgTasks).where(and(eq(orgTasks.orgId, org.id), eq(orgTasks.status, 'done'), gte(orgTasks.updatedAt, since)))).at(0)?.n ?? 0;
    const reportedSpend = /- Company: \$([\d.]+) this month/.exec(b.text)?.[1];
    const reportedTasks = /(\d+) task\(s\) accepted/.exec(b.text)?.[1];
    const drift: string[] = [];
    if (reportedSpend !== undefined && Math.abs(Number(reportedSpend) - Number(spend)) > 0.005) drift.push(`spend this month: the brief says $${reportedSpend}, the run ledger sums $${Number(spend).toFixed(2)}`);
    if (reportedTasks !== undefined && Number(reportedTasks) !== Number(accepted)) drift.push(`tasks accepted since the last brief: the brief says ${reportedTasks}, the board has ${Number(accepted)}`);
    if (drift.length) {
      const detail = `${drift.join('; ')}.`;
      gaps.push({ kind: 'report_drift', refType: 'org', refId: org.id, title: 'The brief\'s numbers differ from the ledger', detail });
      await this.signals?.open(org.id, { kind: 'report_drift', severity: 'warn', refType: 'org', refId: `brief:${month}`, addressee: 'chief', title: 'Report drift: the brief and the ledger disagree', detail }, now).catch(() => undefined);
    }
    return true;
  }

  // ---- the brief and the auditor ----

  async briefLines(orgId: string, since: string): Promise<string[]> {
    const r = await this.latest(orgId);
    if (!r.at || r.at < since || r.gaps.length === 0) return [];
    return [`## Reconciliation (${r.gaps.length} gap(s) between claims and ground truth)`, ...r.gaps.slice(0, 6).map((g) => `- ${g.kind.replace('_', ' ')}: ${g.title} — ${g.detail.slice(0, 200)}`)];
  }

  /** The auditor's sample: the gaps, and the measured key results beside their owners' confidence. */
  async auditMaterial(org: Organization): Promise<string[]> {
    const r = await this.latest(org.id);
    const lines = [`### Reconciliation gaps — claimed versus measured (ground truth the doers did not write; sweep ${r.at ? r.at.slice(0, 16).replace('T', ' ') : 'not run yet'})`];
    lines.push(...(r.gaps.length ? r.gaps.slice(0, 15).map((g) => `- [${g.kind}] ${g.refType}:${g.refId.slice(0, 8)} ${g.title.replace(/</g, '&lt;')} — ${g.detail.replace(/</g, '&lt;').slice(0, 300)}`) : ['- none found']));
    const goals = (await this.org.goals(org.id)).filter((g) => g.kind === 'key_result' && g.status === 'active' && g.metricSourceId).slice(0, 15);
    if (goals.length) {
      lines.push('', '### Measured key results (value from the metric source, beside the owner\'s confidence)');
      for (const g of goals) lines.push(`- [${g.id.slice(0, 8)}] "${g.title.replace(/</g, '&lt;')}": measured ${g.currentValue ?? '?'}${g.unitLabel ? ` ${g.unitLabel}` : ''} of ${g.targetValue ?? '?'} (measured ${g.lastMeasuredAt ? g.lastMeasuredAt.slice(0, 16).replace('T', ' ') : 'never'}), owner confidence ${g.confidence ?? 'none'}`);
    }
    return lines;
  }
}

/** Keep the gaps inside the audit payload cap (4 KB). */
function fitGaps(gaps: Gap[]): Gap[] {
  const out: Gap[] = [];
  let size = 200;
  for (const g of gaps) {
    const slim: Gap = { ...g, title: g.title.slice(0, 120), detail: g.detail.slice(0, 240), refId: g.refId };
    const n = JSON.stringify(slim).length + 1;
    if (size + n > 3_600) break;
    out.push(slim); size += n;
  }
  return out;
}

function parseObj(raw: string | null | undefined): Record<string, unknown> {
  try { const v = JSON.parse(raw || '{}') as unknown; return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}; } catch { return {}; }
}
