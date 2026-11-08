/**
 * OrgClaimsService — evidence-gated claims on the write path of shared
 * company state (docs/evidence.md; reports/Process abstractions for agent
 * companies.md, "Evidence-gated claims": move reconciliation from after the
 * fact to the write path).
 *
 * Agents state progress and facts that other agents build on. A write that
 * carries a claim — a key-result value, a project or task update that says
 * "done / sent / contacted N", a fact inside a decision, a process step
 * output, a shared lesson — passes the evidence gate bound on
 * OrgTasksService (`setEvidenceGate`):
 *
 *  - the cited references are verified model-free by the quality verifier
 *    (`OrgQualityService.verifyEvidence`: action log rows, tool calls,
 *    workspace files and hashes, fetched URLs, task checks, done tasks);
 *  - counts the record can answer ("sent 40 emails", "completed 5 tasks",
 *    "ran 20 actions") are cross-checked against the action log and the
 *    board; a contradicted count is a `mismatch`;
 *  - the class's strictness (a per-company tunable derived from values and
 *    culture, claims-tunables.ts) decides: **block** refuses with
 *    remediation naming what to cite and how; **mark** lets the write land
 *    flagged unverified — shown so in the briefing, the readers and the UI,
 *    and not counted (a key result keeps its last verified value) until a
 *    person confirms it or the author writes it again with evidence;
 *    **log** records it only.
 *
 * Provenance: one `org_claims` row per claim against the record written
 * (refType/refId), with the verified refs, the counts and the verdict.
 *
 * Fabrication: a cited reference whose referent does not exist (no such
 * action, file, task or check; a tool never run) is a fabrication signal —
 * recorded, a `claim_fabricated` signal for the chief, a rejection on the
 * author's trust ledger (as a QC escape is), and at
 * `claims.fabricationIncident` within the window an incident.
 */
import { BadRequestException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, desc, eq, gte, inArray, isNull, ne } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { actionLog, orgCheckins, orgClaims, orgTasks } from '../database/schema';
import { newId, nowIso } from '../common/ids.util';
import { currentAccountId } from '../accounts/account-context';
import { AgentsService } from '../agents/agents.service';
import { TrustService } from '../actions/trust.service';
import { EXTERNAL_CLASSES } from '../actions/action-classes';
import { OrgService } from './org.service';
import { OrgTasksService } from './org-tasks.service';
import { OrgAuditService } from './org-audit.service';
import { OrgQualityService } from './org-quality.service';
import { OrgSignalsService } from './org-signals.service';
import { OrgIncidentsService } from './org-incidents.service';
import { OrgMeetingsService } from './org-meetings.service';
import { normalizeEvidence } from './quality-model';
import {
  CLAIM_CLASSES, STRICTNESS_WORD, carriesClaim, claimStatus, claimTag, claimTallies, countClaims, countMismatch, factualSentences, remediation,
  type ClaimInput, type ClaimRef, type ClaimStatus, type ClaimTicket, type CountClaim, type CountMeasure, type Strictness,
} from './claims-model';
import { claimTunable } from './claims-tunables';

export type OrgClaim = typeof orgClaims.$inferSelect;

const DAY = 86_400_000;
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const parse = <T>(raw: string | null | undefined, fallback: T): T => { try { return raw ? JSON.parse(raw) as T : fallback; } catch { return fallback; } };

@Injectable()
export class OrgClaimsService {
  private readonly logger = new Logger(OrgClaimsService.name);
  now: () => Date = () => new Date();

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly org: OrgService,
    private readonly tasks: OrgTasksService,
    private readonly quality: OrgQualityService,
    private readonly audit: OrgAuditService,
    private readonly agents: AgentsService,
    @Optional() private readonly config?: ConfigService,
    @Optional() private readonly signals?: OrgSignalsService,
    @Optional() private readonly incidents?: OrgIncidentsService,
    @Optional() private readonly trust?: TrustService,
    @Optional() meetings?: OrgMeetingsService,
  ) {
    if (!this.enabled()) return;
    tasks.setEvidenceGate({
      check: (orgId, input) => this.check(orgId, input),
      flags: (orgId, refType, ids) => this.flags(orgId, refType, ids),
      unverified: (orgId, opts) => this.unverified(orgId, opts),
    });
    // A decision proposed in a meeting is logged when the meeting closes:
    // its claim moves from the minutes entry to the decision row.
    meetings?.onMaterialise(async (orgId, meeting, minutes) => {
      for (const [i, d] of minutes.decisions.entries()) {
        if (!d.decisionId) continue;
        await this.db.update(orgClaims).set({ refType: 'decision', refId: d.decisionId })
          .where(and(eq(orgClaims.orgId, orgId), eq(orgClaims.refType, 'minutes_decision'), eq(orgClaims.refId, `${meeting.id}#${i}`)));
      }
    });
  }

  enabled(): boolean { return this.config?.get<boolean>('companiesEnabled') !== false; }

  // ---- the gate ----

  /** Verify a write's claim; throw to refuse (block), else a ticket to commit once the record exists. */
  async check(orgId: string, input: ClaimInput): Promise<ClaimTicket | null> {
    if (!input.actor.startsWith('agent:')) return null;
    const agentId = input.actor.slice('agent:'.length);
    const c = CLAIM_CLASSES[input.cls];
    if (!c) return null;
    const text = (input.text ?? '').slice(0, 4_000);
    const { cited, bad } = normalizeEvidence(input.evidence ?? []);
    const parsed = cited.flatMap((x) => x.refs);
    if (!carriesClaim(c, text, input.value) && parsed.length === 0 && bad.length === 0) return null;
    const org = await this.org.get(orgId);
    const level = claimTunable(org, c.tunable as never) as Strictness;
    const enforcement = STRICTNESS_WORD[level];
    const task = input.context?.taskId ? await this.tasks.get(orgId, input.context.taskId).catch(() => null) : null;
    const since = task?.createdAt ?? new Date(this.now().getTime() - claimTunable(org, 'claims.evidenceWindowDays') * DAY).toISOString();
    const verified = parsed.length ? await this.quality.verifyEvidence(org, { since, taskId: task?.id ?? null }, parsed, agentId) : new Map();
    const refs: ClaimRef[] = [...verified.values()].map((v) => ({ raw: v.raw, kind: v.kind, ok: v.ok, detail: v.detail, ...(v.missing ? { missing: true } : {}) }));
    const counts = await this.measure(org.workspaceId, orgId, agentId, countClaims(text), since, claimTunable(org, 'claims.countTolerancePct'));
    const facts = c.always ? [] : factualSentences(text);
    const status = claimStatus({ refs, counts, bad, kinds: c.evidence });
    const statement = (c.always ? `${input.value ?? ''}${text ? ` — ${text}` : ''}` : facts.join(' ') || text).slice(0, 600);
    const verdict = { refs, counts, bad, kinds: c.evidence, status, tool: input.tool, facts };
    const row = (refType: string, refId: string): OrgClaim => ({
      accountId: currentAccountId(), id: newId(), orgId, classKey: c.key, refType, refId, agentId,
      context: JSON.stringify({ ...(input.context ?? {}), ...(task ? { taskId: task.id } : {}) }), statement,
      value: typeof input.value === 'number' && Number.isFinite(input.value) ? input.value : null,
      status, enforcement, refs: JSON.stringify(refs), counts: JSON.stringify(counts),
      detail: status === 'verified' ? '' : remediation(c, verdict).slice(0, 1_200), verifiedBy: status === 'verified' ? 'evidence' : '', verifiedAt: status === 'verified' ? nowIso() : null, createdAt: nowIso(),
    });
    if (status !== 'verified' && enforcement === 'block') {
      // A refused claim is still on the record: the panel counts it, a fabrication still answers for itself.
      await this.insert(org, row('refused', newId()), true);
      throw new BadRequestException(`Refused: ${c.label.toLowerCase()} ${status === 'fabricated' ? 'cites evidence that does not exist' : status === 'mismatch' ? 'is contradicted by the record' : 'has no evidence that checks out'} — this company refuses unevidenced claims of this kind (${c.tunable} = 2), so nothing was written. ${remediation(c, verdict)}`);
    }
    const counted = status === 'verified' || enforcement === 'log';
    const okRefs = refs.filter((r) => r.ok);
    const note = status === 'verified'
      ? `Claim verified${okRefs.length ? ` by ${okRefs.slice(0, 3).map((r) => r.raw).join(', ')}` : ''}${counts.length ? `${okRefs.length ? ';' : ' —'} ${counts.map((k) => `"${k.phrase}" matches the record (${k.measured})`).join('; ')}` : ''}.`
      : enforcement === 'log'
        ? `Logged as ${claimTag(status).replace(/[[\]]/g, '')}: cite evidence next time. ${remediation(c, verdict)}`
        : `Recorded but flagged ${claimTag(status)} — ${c.effect}. Others are told not to build on it until it is verified. ${remediation(c, verdict)}`;
    return {
      status, enforcement, counts: counted, note,
      commit: async (refType, refId) => { const r = row(refType, refId); await this.insert(org, r, false); return r.id; },
    };
  }

  private async insert(org: { id: string; workspaceId: string }, r: OrgClaim, refused: boolean): Promise<void> {
    await this.db.insert(orgClaims).values(r);
    await this.audit.append(org.id, { actor: `agent:${r.agentId}`, action: refused ? 'claim_refused' : 'claim_recorded', refType: 'claim', refId: r.id, payload: { classKey: r.classKey, status: r.status, enforcement: r.enforcement, refType: r.refType, refId: r.refId } });
    if (r.status === 'fabricated') await this.fabricated(org, r).catch((err: unknown) => this.logger.warn(`fabrication response failed: ${err instanceof Error ? err.message : err}`));
    else if (r.status === 'mismatch') {
      const name = (await this.agents.get(r.agentId).catch(() => null))?.name ?? 'A member';
      await this.signals?.open(org.id, { kind: 'claim_mismatch', severity: 'warn', refType: 'claim', refId: r.id, title: `${name} claimed more than the record shows`.slice(0, 200), detail: `${CLAIM_CLASSES[r.classKey as keyof typeof CLAIM_CLASSES]?.label ?? r.classKey}: ${r.statement.slice(0, 300)}. ${parse<Array<CountClaim & { measured: number; mismatch: boolean }>>(r.counts, []).filter((k) => k.mismatch).map((k) => `"${k.phrase}" — record ${k.measured}`).join('; ')}`.slice(0, 1_000), addressee: 'chief' }).catch(() => undefined);
    }
  }

  /** The fabrication response: a signal, the trust ledger, and repeated → an incident. */
  private async fabricated(org: { id: string; workspaceId: string }, r: OrgClaim): Promise<void> {
    const name = (await this.agents.get(r.agentId).catch(() => null))?.name ?? 'A member';
    const missing = parse<ClaimRef[]>(r.refs, []).filter((x) => x.missing).map((x) => x.raw);
    await this.trust?.record(org.workspaceId, r.agentId, 'internal_write', 'rejected', { refType: 'claim', refId: r.id }).catch(() => null);
    await this.signals?.open(org.id, { kind: 'claim_fabricated', severity: 'warn', refType: 'claim', refId: r.id, title: `${name} cited evidence that does not exist`.slice(0, 200), detail: `${CLAIM_CLASSES[r.classKey as keyof typeof CLAIM_CLASSES]?.label ?? r.classKey}: "${r.statement.slice(0, 240)}" — cited ${missing.slice(0, 5).join(', ')}. Check the claim before anyone builds on it.`.slice(0, 1_000), addressee: 'chief' }).catch(() => undefined);
    const o = await this.org.get(org.id);
    const since = new Date(this.now().getTime() - claimTunable(o, 'claims.fabricationWindowHours') * 3_600_000).toISOString();
    const n = (await this.db.select({ id: orgClaims.id }).from(orgClaims).where(and(eq(orgClaims.orgId, org.id), eq(orgClaims.agentId, r.agentId), eq(orgClaims.status, 'fabricated'), gte(orgClaims.createdAt, since)))).length;
    if (n >= claimTunable(o, 'claims.fabricationIncident')) {
      await this.incidents?.open(org.id, { kind: 'fabrication', severity: 'minor', title: `${name} keeps citing evidence that does not exist (${n} in the window)`.slice(0, 200), detail: `Latest: "${r.statement.slice(0, 300)}" citing ${missing.slice(0, 5).join(', ')}.`, cause: 'fabricated evidence on claims in shared state', agentId: r.agentId, refType: 'agent', refId: `fabrication:${r.agentId}`, detectedBy: 'system' }).catch(() => undefined);
    }
  }

  /** Counts the record can answer, measured over the author's own record since `since`. */
  private async measure(workspaceId: string, orgId: string, agentId: string, claims: CountClaim[], since: string, tolerancePct: number): Promise<Array<CountClaim & { measured: number; mismatch: boolean }>> {
    if (!claims.length) return [];
    const cache = new Map<CountMeasure, number>();
    const value = async (m: CountMeasure): Promise<number> => {
      if (cache.has(m)) return cache.get(m)!;
      let n: number;
      if (m === 'tasks_done') {
        n = (await this.db.select({ id: orgTasks.id }).from(orgTasks).where(and(eq(orgTasks.orgId, orgId), eq(orgTasks.assigneeAgentId, agentId), eq(orgTasks.status, 'done'), gte(orgTasks.doneAt, since)))).length;
      } else {
        const rows = await this.db.select({ input: actionLog.input, cls: actionLog.class }).from(actionLog)
          .where(and(eq(actionLog.workspaceId, workspaceId), eq(actionLog.agentId, agentId), eq(actionLog.status, 'succeeded'), gte(actionLog.createdAt, since), ...(m === 'outward' ? [inArray(actionLog.class, [...EXTERNAL_CLASSES])] : [])));
        // An outward action counts once per recipient it names (an email to 12 people contacted 12).
        n = m === 'outward' ? rows.reduce((sum, r) => sum + Math.max(1, new Set((r.input ?? '').match(EMAIL_RE) ?? []).size), 0) : rows.length;
      }
      cache.set(m, n);
      return n;
    };
    const out: Array<CountClaim & { measured: number; mismatch: boolean }> = [];
    for (const k of claims) { const measured = await value(k.measure); out.push({ ...k, measured, mismatch: countMismatch(k.n, measured, tolerancePct) }); }
    return out;
  }

  // ---- readers ----

  /** The latest flagged status per record (verified records and logged-only claims are not flagged). */
  async flags(orgId: string, refType: string, refIds: string[]): Promise<Map<string, ClaimStatus>> {
    const ids = [...new Set(refIds.filter(Boolean))];
    const out = new Map<string, ClaimStatus>();
    if (!ids.length) return out;
    const rows = await this.db.select({ refId: orgClaims.refId, status: orgClaims.status, enforcement: orgClaims.enforcement, createdAt: orgClaims.createdAt }).from(orgClaims)
      .where(and(eq(orgClaims.orgId, orgId), eq(orgClaims.refType, refType), inArray(orgClaims.refId, ids.slice(0, 500))));
    for (const r of rows.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))) {
      if (r.enforcement === 'log' || r.status === 'verified') out.delete(r.refId);
      else out.set(r.refId, r.status as ClaimStatus);
    }
    return out;
  }

  async unverified(orgId: string, opts: { days?: number; limit?: number } = {}): Promise<Array<{ agentId: string; classKey: string; statement: string; status: ClaimStatus; refType: string; refId: string; createdAt: string }>> {
    const since = new Date(this.now().getTime() - (opts.days ?? 14) * DAY).toISOString();
    const rows = await this.db.select().from(orgClaims).where(and(eq(orgClaims.orgId, orgId), ne(orgClaims.status, 'verified'), ne(orgClaims.enforcement, 'log'), ne(orgClaims.refType, 'refused'), isNull(orgClaims.verifiedAt), gte(orgClaims.createdAt, since)))
      .orderBy(desc(orgClaims.createdAt)).limit(Math.min(50, opts.limit ?? 10));
    return rows.map((r) => ({ agentId: r.agentId, classKey: r.classKey, statement: r.statement, status: r.status as ClaimStatus, refType: r.refType, refId: r.refId, createdAt: r.createdAt }));
  }

  async list(orgId: string, opts: { refType?: string; refIds?: string[]; agentId?: string; status?: string; days?: number; limit?: number } = {}): Promise<OrgClaim[]> {
    const conds = [eq(orgClaims.orgId, orgId)];
    if (opts.refType) conds.push(eq(orgClaims.refType, opts.refType));
    if (opts.refIds?.length) conds.push(inArray(orgClaims.refId, opts.refIds.slice(0, 500)));
    if (opts.agentId) conds.push(eq(orgClaims.agentId, opts.agentId));
    if (opts.status) conds.push(eq(orgClaims.status, opts.status));
    if (opts.days) conds.push(gte(orgClaims.createdAt, new Date(this.now().getTime() - opts.days * DAY).toISOString()));
    return this.db.select().from(orgClaims).where(and(...conds)).orderBy(desc(orgClaims.createdAt)).limit(Math.min(500, opts.limit ?? 200));
  }

  /** The Oversight figures: per member, verified / unverified / mismatch / fabricated, and the latest flagged claims. */
  async summary(orgId: string, days = 30): Promise<{ days: number; totals: Record<ClaimStatus, number> & { total: number }; byAgent: ReturnType<typeof claimTallies>; recent: OrgClaim[] }> {
    const rows = await this.list(orgId, { days, limit: 500 });
    const byAgent = claimTallies(rows);
    const totals = claimTallies(rows.map((r) => ({ agentId: '*', status: r.status })))['*'] ?? { verified: 0, unverified: 0, mismatch: 0, fabricated: 0, total: 0 };
    return { days, totals, byAgent, recent: rows.filter((r) => r.status !== 'verified').slice(0, 20) };
  }

  /** A person confirms a flagged claim (CEO or board): it counts from now; a held key-result value is applied when it is still the latest check-in. */
  async confirm(orgId: string, claimId: string, actor: string, note = ''): Promise<OrgClaim> {
    if (actor.startsWith('agent:')) throw new ForbiddenException('only a person confirms a flagged claim; an agent writes it again with evidence');
    const c = (await this.db.select().from(orgClaims).where(and(eq(orgClaims.orgId, orgId), eq(orgClaims.id, claimId))).limit(1)).at(0)
      ?? (await this.db.select().from(orgClaims).where(eq(orgClaims.orgId, orgId))).find((x) => x.id.startsWith(claimId));
    if (!c) throw new NotFoundException(`claim ${claimId}`);
    if (c.status === 'verified') return c;
    await this.db.update(orgClaims).set({ status: 'verified', verifiedBy: actor, verifiedAt: nowIso(), detail: `${c.detail ? `${c.detail} ` : ''}Confirmed by a person${note ? `: ${note.slice(0, 300)}` : ''}.`.slice(0, 1_500) }).where(eq(orgClaims.id, c.id));
    if (c.classKey === 'kr_checkin' && c.value !== null && c.refType === 'checkin') {
      const ci = (await this.db.select().from(orgCheckins).where(eq(orgCheckins.id, c.refId)).limit(1)).at(0);
      const latest = ci ? (await this.db.select({ id: orgCheckins.id }).from(orgCheckins).where(eq(orgCheckins.goalId, ci.goalId)).orderBy(desc(orgCheckins.createdAt)).limit(1)).at(0) : undefined;
      if (ci && latest?.id === ci.id) await this.org.updateGoal(orgId, ci.goalId, { currentValue: c.value }, actor);
    }
    await this.audit.append(orgId, { actor, action: 'claim_confirmed', refType: 'claim', refId: c.id, payload: { classKey: c.classKey, refType: c.refType, refId: c.refId, note: note.slice(0, 200) } });
    return (await this.db.select().from(orgClaims).where(eq(orgClaims.id, c.id))).at(0)!;
  }
}
