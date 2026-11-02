/**
 * OrgSensingService — ground truth for the company (docs/sensing.md,
 * execution-plan item 27; capabilities C1 and C3 of
 * docs/autonomous-org-first-principles.md).
 *
 * **Metric sources.** A source is where a number the company steers by comes
 * from: an HTTP JSON endpoint read with a selector (through the SSRF guard,
 * https only unless the dev flag allows private URLs, secret headers sealed
 * with secretbox and referenced by name), a webhook a third-party system
 * posts to with its own token, a fixed-menu connection query over a grant a
 * workspace agent already holds, or a human's attestation. Every reading is
 * an `org_metric_samples` row with provenance (what was fetched, a hash of
 * the response, who attested). The minute tick polls due sources per
 * account, backs off on errors and marks a source **stale** — with a
 * `metric_stale` signal to the chief — when no sample arrived in
 * `sensing.staleMultiplier` poll intervals.
 *
 * **Trust model.** Agents never write samples, of any kind, and never
 * activate a source: `org_propose_metric_source` creates it
 * `pending_approval` behind a `metric_source` card only the CEO decides, in
 * both modes, because a source defines what counts as truth. A key result
 * bound to a source takes its `currentValue` only from the latest sample;
 * the owner's check-in carries confidence and a note.
 *
 * **Executable acceptance.** A task's checks (org-checks.ts) run here, model
 * free, before review (`OrgTasksService.setAcceptanceGate`): all pass → the
 * task is accepted `by check`; a failure sends it back with the details as
 * a review round; an error falls through to the model review with a note.
 *
 * Every write is audited; proactive transitions (a poll error, a stale
 * source) reach the chief's inbox or the signals.
 */
import { BadRequestException, ForbiddenException, HttpException, HttpStatus, Inject, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit, Optional, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, asc, desc, eq, gte } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { connectionGrants, orgGoals, orgMetricSamples, orgMetricSources, orgTaskChecks } from '../database/schema';
import { newId, nowIso } from '../common/ids.util';
import { seal, open as unseal } from '../common/secretbox';
import { fetchPublic } from '../common/url-guard';
import { currentAccountId } from '../accounts/account-context';
import { unscoped } from '../accounts/scoped-db';
import { AccountsService } from '../accounts/accounts.service';
import { AgentsService } from '../agents/agents.service';
import { ConnectionsService } from '../connections/connections.service';
import { capabilitiesFor } from '../connections/connections.tools';
import { StorageService } from '../storage/storage.service';
import { workspaceFileKey } from '../storage/storage.keys';
import { TurnLoopService, type ToolProviderHook } from '../chats/turn-loop.service';
import type { ChatSession } from '../chats/chats.repository';
import type { AiToolSpec } from '../ai/ai-provider.interface';
import { OrgService, type Organization } from './org.service';
import { OrgAuditService } from './org-audit.service';
import { OrgTasksService, parseBrief, type AcceptanceVerdict, type OrgTask } from './org-tasks.service';
import { OrgApprovalsService } from './org-approvals.service';
import { OrgSignalsService } from './org-signals.service';
import { OrgUnitsService } from './org-units.service';
import { OrgRuntimeService } from './org-runtime.service';
import { sensingTunable } from './sensing-tunables';
import { describeCheck, normalizeConnectionQuery, selectNumber, selectValue, serviceOfQuery, type Check, type CheckStatus, type ConnectionQuerySpec } from './org-checks';
import { OrgMirrorService } from './org-mirror.service';
import { taskRef } from '../common/task-keys';

export type MetricSource = typeof orgMetricSources.$inferSelect;
export type MetricSample = typeof orgMetricSamples.$inferSelect;
export type TaskCheckRow = typeof orgTaskChecks.$inferSelect;

export const SOURCE_KINDS = ['http_json', 'webhook', 'connection', 'manual_attested'] as const;
export type SourceKind = typeof SOURCE_KINDS[number];
/** Sources the tick fetches; webhooks and attestations arrive on their own. */
const POLLED: ReadonlySet<string> = new Set(['http_json', 'connection']);
/** Statuses of a live source (polled, sampled, checked for staleness). */
const LIVE: ReadonlySet<string> = new Set(['ok', 'error', 'stale']);
const DEFAULT_POLL: Record<SourceKind, number> = { http_json: 60, connection: 60, webhook: 1_440, manual_attested: 10_080 };
const MAX_POLL_MINUTES = 43_200;
const BODY_CAP = 1_000_000;
export const INGEST_RATE_PER_MIN = 30;
const SOURCE_LIMIT = 100;
/** Header names that carry credentials: their value must be a secret reference. */
const SENSITIVE_HEADER = /authorization|cookie|token|secret|key|password|auth/i;
const SECRET_REF = /\{\{secret:([A-Za-z0-9_-]{1,40})\}\}/g;
/** The secret names a header value references (`Bearer {{secret:API}}` → ['API']). */
function secretRefs(v: string): string[] { return [...v.matchAll(SECRET_REF)].map((m) => m[1]); }

export interface SourceInput {
  name?: string; kind?: string; unit?: string; pollMinutes?: number;
  /** http_json: { url, selector, headers? } · connection: { query, q?, days? } · webhook / manual_attested: {}. */
  config?: Record<string, unknown>;
  /** Header secrets by name: sealed at rest, never returned. null removes one. */
  secrets?: Record<string, string | null>;
}

/** What the API and the tools show of a source: no secret values, no token hash. */
export interface SourceView {
  id: string; orgId: string; name: string; kind: string; config: Record<string, unknown>; secretNames: string[]; hasToken: boolean;
  unit: string; pollMinutes: number; status: string; lastValue: number | null; lastFetchedAt: string | null; lastError: string;
  nextPollAt: string | null; approvalId: string | null; activatedAt: string | null; createdBy: string; createdAt: string;
  boundKeyResults: Array<{ id: string; title: string }>;
}

export interface Provenance { kind: string; url?: string; connection?: string; service?: string; query?: string; by?: string; note?: string; responseHash?: string; status?: number }

export interface CheckResult { index: number; check: Check; status: CheckStatus; detail: string; evidence: Record<string, unknown> }

const TOOL_NAMES = new Set(['org_metric_sources', 'org_metric_read', 'org_propose_metric_source', 'org_task_checks', 'org_run_checks']);

const MEMBER_TOOLS: AiToolSpec[] = [
  { name: 'org_metric_sources', description: 'The company\'s metric sources — where key results get their measured values (an HTTP endpoint, a webhook, a connection query, a human attestation): name, kind, status (ok / error / stale / pending_approval), last value and when it was fetched, which key results it measures. Ground truth: a number from a source beats a number anyone typed.', inputSchema: { type: 'object', properties: { org: { type: 'string' } } } },
  { name: 'org_metric_read', description: 'Read the samples of one metric source (newest last, at most 50) with their provenance: value, when it was observed, what was fetched.', inputSchema: { type: 'object', properties: { source: { type: 'string', description: 'Source id, id prefix or name.' }, since: { type: 'string', description: 'ISO date; default the last 30 days.' }, org: { type: 'string' } }, required: ['source'] } },
  { name: 'org_task_checks', description: 'The executable checks of a task (its done_when made testable) and their latest results: pass, fail, error or pending, with the detail.', inputSchema: { type: 'object', properties: { taskId: { type: 'string', description: 'The task key, e.g. ENG-12; defaults to your current task.' }, org: { type: 'string' } } } },
  { name: 'org_run_checks', description: 'Run a task\'s checks now (the owner, its reviewer or the chief) to see where it stands before requesting review. Reads only: nothing is accepted or changed, the results are recorded. org_request_review runs them again and accepts the task when they all pass.', inputSchema: { type: 'object', properties: { taskId: { type: 'string', description: 'The task key, e.g. ENG-12; defaults to your current task.' }, org: { type: 'string' } } } },
];
const PROPOSE_TOOL: AiToolSpec = {
  name: 'org_propose_metric_source',
  description: 'Propose a metric source (chief and unit leads): where a key result\'s number should come from. It is created pending and needs the CEO\'s approval in every mode, because a source defines what counts as truth. Kinds: http_json (url, selector like "data.subscribers" or "items.length" or "rows.sum(amount)"; headers may only reference secrets the CEO sets, as {{secret:NAME}}), connection (query: gmail_unread | gmail_matching | calendar_events_week | drive_changed, q, days — a workspace agent must hold that grant), webhook (the CEO gets the token), manual_attested (a human posts the value). You never write values yourself.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string' }, kind: { type: 'string', enum: [...SOURCE_KINDS] }, unit: { type: 'string', description: 'e.g. "subscribers", "USD".' },
      url: { type: 'string' }, selector: { type: 'string' }, headers: { type: 'object', description: 'Header name → value; credentials only as {{secret:NAME}}.' },
      query: { type: 'string', description: 'connection: gmail_unread | gmail_matching | calendar_events_week | drive_changed' }, q: { type: 'string', description: 'connection: the search string.' }, days: { type: 'number' },
      pollMinutes: { type: 'number' }, why: { type: 'string', description: 'Which key result it would measure and why this is the truth for it.' }, org: { type: 'string' },
    },
    required: ['name', 'kind', 'why'],
  },
};

@Injectable()
export class OrgSensingService implements ToolProviderHook, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OrgSensingService.name);
  private timer?: ReturnType<typeof setInterval>;
  /** sourceId → ingest timestamps in the last minute (rate limit). */
  private readonly ingestHits = new Map<string, number[]>();
  /** Test seam: the fetch behind http_json sources and http checks. */
  fetchImpl: typeof fetch = fetch;
  /** Test seam: the clock of the tick. */
  now: () => Date = () => new Date();

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly org: OrgService,
    private readonly audit: OrgAuditService,
    private readonly tasks: OrgTasksService,
    private readonly approvals: OrgApprovalsService,
    private readonly agents: AgentsService,
    private readonly config: ConfigService,
    @Optional() private readonly turns?: TurnLoopService,
    @Optional() private readonly runtime?: OrgRuntimeService,
    @Optional() private readonly units?: OrgUnitsService,
    @Optional() private readonly signals?: OrgSignalsService,
    @Optional() private readonly connections?: ConnectionsService,
    @Optional() private readonly storage?: StorageService,
    @Optional() private readonly accounts?: AccountsService,
    /** Optional: mirrors the sources and their latest readings to /org/metrics.md. */
    @Optional() private readonly mirror?: OrgMirrorService,
  ) {
    if (!this.enabled()) return;
    this.turns?.addToolProvider(this);
    this.tasks.setAcceptanceGate((orgId, task) => this.gate(orgId, task));
    this.approvals.onApply('metric_source', (orgId, payload, approval) => this.activateFromApproval(orgId, payload, approval.id));
    this.approvals.onDecided(async (ev) => {
      if (ev.approval.kind !== 'metric_source' || ev.decision === 'approve') return;
      const sourceId = String((JSON.parse(ev.approval.payload || '{}') as { sourceId?: string }).sourceId ?? '');
      const src = sourceId ? await this.find(ev.orgId, sourceId) : null;
      if (src && src.status === 'pending_approval' && ev.decision === 'reject') {
        await this.db.update(orgMetricSources).set({ status: 'rejected' }).where(eq(orgMetricSources.id, src.id));
        await this.audit.append(ev.orgId, { actor: 'user', action: 'metric_source_rejected', refType: 'metric_source', refId: src.id, payload: { name: src.name, note: ev.note.slice(0, 200) } });
      }
    });
  }

  enabled(): boolean { return this.config.get<boolean>('companiesEnabled') !== false; }

  onModuleInit(): void {
    if (!this.enabled()) return;
    this.timer = setInterval(() => { void this.tick(this.now()); }, 60_000);
  }

  onModuleDestroy(): void { clearInterval(this.timer); }

  // ---- reads ----

  private async find(orgId: string, id: string): Promise<MetricSource | null> {
    return (await this.db.select().from(orgMetricSources).where(and(eq(orgMetricSources.orgId, orgId), eq(orgMetricSources.id, id))).limit(1)).at(0) ?? null;
  }

  async get(orgId: string, id: string): Promise<MetricSource> {
    const s = await this.find(orgId, id);
    if (!s) throw new NotFoundException(`metric source ${id}`);
    return s;
  }

  /** Resolve a source by id, 8-char prefix or name (what the model sees). */
  async byRef(orgId: string, ref: string): Promise<MetricSource> {
    const q = (ref ?? '').trim();
    if (!q) throw new BadRequestException('a metric source is required (id, prefix or name)');
    const rows = await this.rows(orgId);
    const hits = rows.filter((s) => s.id === q || s.id.startsWith(q) || s.name.toLowerCase() === q.toLowerCase());
    if (hits.length !== 1) throw new BadRequestException(`metric source "${q}" matches ${hits.length} sources${rows.length ? ` — sources: ${rows.map((s) => `${s.name} [${s.id.slice(0, 8)}]`).join(', ')}` : ''}`);
    return hits[0];
  }

  private rows(orgId: string): Promise<MetricSource[]> {
    return this.db.select().from(orgMetricSources).where(eq(orgMetricSources.orgId, orgId)).orderBy(asc(orgMetricSources.createdAt));
  }

  async list(orgId: string): Promise<SourceView[]> {
    await this.org.get(orgId);
    const goals = (await this.org.goals(orgId)).filter((g) => g.metricSourceId);
    return (await this.rows(orgId)).map((s) => this.view(s, goals.filter((g) => g.metricSourceId === s.id).map((g) => ({ id: g.id, title: g.title }))));
  }

  async describe(orgId: string, id: string): Promise<SourceView> {
    const s = await this.get(orgId, id);
    const goals = (await this.org.goals(orgId)).filter((g) => g.metricSourceId === s.id).map((g) => ({ id: g.id, title: g.title }));
    return this.view(s, goals);
  }

  private view(s: MetricSource, bound: Array<{ id: string; title: string }>): SourceView {
    return {
      id: s.id, orgId: s.orgId, name: s.name, kind: s.kind, config: parseObj(s.config), secretNames: Object.keys(parseObj(s.secrets)), hasToken: Boolean(s.tokenHash),
      unit: s.unit, pollMinutes: s.pollMinutes, status: s.status, lastValue: s.lastValue, lastFetchedAt: s.lastFetchedAt, lastError: s.lastError,
      nextPollAt: s.nextPollAt, approvalId: s.approvalId, activatedAt: s.activatedAt, createdBy: s.createdBy, createdAt: s.createdAt, boundKeyResults: bound,
    };
  }

  async samples(orgId: string, sourceId: string, opts: { since?: string; limit?: number } = {}): Promise<MetricSample[]> {
    const s = await this.get(orgId, sourceId);
    const conds = [eq(orgMetricSamples.sourceId, s.id)];
    if (opts.since) {
      if (!Number.isFinite(Date.parse(opts.since))) throw new BadRequestException('since must be an ISO date');
      conds.push(gte(orgMetricSamples.observedAt, new Date(opts.since).toISOString()));
    }
    const rows = await this.db.select().from(orgMetricSamples).where(and(...conds)).orderBy(desc(orgMetricSamples.observedAt)).limit(Math.min(1_000, Math.max(1, opts.limit ?? 500)));
    return rows.reverse();
  }

  private async latestSample(sourceId: string): Promise<MetricSample | null> {
    return (await this.db.select().from(orgMetricSamples).where(eq(orgMetricSamples.sourceId, sourceId)).orderBy(desc(orgMetricSamples.observedAt), desc(orgMetricSamples.createdAt)).limit(1)).at(0) ?? null;
  }

  // ---- writes: sources ----

  /** Validate a source's kind and config into what is stored. */
  private async prepare(org: Organization, kind: string, input: SourceInput, current?: MetricSource): Promise<{ config: Record<string, unknown>; secrets: Record<string, string>; pollMinutes: number }> {
    if (!SOURCE_KINDS.includes(kind as SourceKind)) throw new BadRequestException(`kind must be one of ${SOURCE_KINDS.join(', ')}`);
    const raw = input.config ?? (current ? parseObj(current.config) : {});
    const secrets: Record<string, string> = current ? parseObj(current.secrets) as Record<string, string> : {};
    for (const [k, v] of Object.entries(input.secrets ?? {})) {
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(k)) throw new BadRequestException(`secret name "${k}" must be 1–40 letters, digits, _ or -`);
      if (v === null) delete secrets[k];
      else if (typeof v === 'string' && v) secrets[k] = seal(v.slice(0, 4_000));
    }
    let config: Record<string, unknown> = {};
    if (kind === 'http_json') {
      const url = String(raw.url ?? '').trim();
      let u: URL;
      try { u = new URL(url); } catch { throw new BadRequestException('http_json needs a valid url'); }
      if (u.protocol !== 'https:' && !(u.protocol === 'http:' && privateUrlsAllowed())) throw new BadRequestException('http_json sources must use https (http only with YAAM_ALLOW_PRIVATE_URLS=true, for local development)');
      const selector = String(raw.selector ?? '').trim();
      try { selectValue({}, selector); } catch (err) { throw new BadRequestException(err instanceof Error ? err.message : String(err)); }
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries((raw.headers ?? {}) as Record<string, unknown>)) {
        if (!/^[A-Za-z0-9-]{1,60}$/.test(name)) throw new BadRequestException(`header name "${name}" is not valid`);
        const v = String(value ?? '');
        const refs = secretRefs(v);
        // A credential header is a secret reference, optionally after a scheme word ("Bearer {{secret:API}}").
        if (SENSITIVE_HEADER.test(name) && (refs.length === 0 || !/^[A-Za-z]{0,20}$/.test(v.replace(SECRET_REF, '').trim()))) throw new BadRequestException(`header "${name}" carries a credential: give its value as {{secret:NAME}} (optionally after a scheme like "Bearer ") and the secret itself in "secrets" (sealed, never returned)`);
        const unset = refs.find((r) => !secrets[r]);
        if (unset) throw new BadRequestException(`header "${name}" references secret "${unset}", which is not set — pass it in "secrets"`);
        headers[name] = v.slice(0, 500);
      }
      config = { url: u.toString(), selector, ...(Object.keys(headers).length ? { headers } : {}) };
    } else if (kind === 'connection') {
      let spec: ConnectionQuerySpec;
      try { spec = normalizeConnectionQuery(raw); } catch (err) { throw new BadRequestException(err instanceof Error ? err.message : String(err)); }
      await this.grantHolder(org, serviceOfQuery(spec.query)).catch((err: unknown) => { throw new BadRequestException(err instanceof Error ? err.message : String(err)); });
      config = { query: spec.query, q: spec.q, days: spec.days };
    }
    const minPoll = sensingTunable(org, 'sensing.minPollMinutes');
    const requested = input.pollMinutes ?? current?.pollMinutes ?? DEFAULT_POLL[kind as SourceKind];
    if (!Number.isFinite(Number(requested))) throw new BadRequestException('pollMinutes must be a number');
    const pollMinutes = Math.min(MAX_POLL_MINUTES, Math.max(minPoll, Math.round(Number(requested))));
    return { config, secrets, pollMinutes };
  }

  /**
   * Create a source. A human with standing (the CEO, through the API)
   * creates it live; an agent's proposal (`propose: true`) lands
   * `pending_approval` behind a `metric_source` card. A webhook source
   * created live returns its token once.
   */
  async create(orgId: string, input: SourceInput, actor: string, opts: { propose?: boolean; why?: string } = {}): Promise<{ source: SourceView; token?: string; approvalId?: string }> {
    const org = await this.org.get(orgId);
    const name = (input.name ?? '').trim().slice(0, 120);
    if (!name) throw new BadRequestException('a metric source needs a name');
    const kind = String(input.kind ?? '');
    const existing = await this.rows(orgId);
    if (existing.length >= SOURCE_LIMIT) throw new BadRequestException(`source limit (${SOURCE_LIMIT}) reached — delete one first`);
    if (existing.some((s) => s.name.toLowerCase() === name.toLowerCase() && s.status !== 'rejected')) throw new BadRequestException(`a metric source named "${name}" already exists`);
    if (opts.propose && Object.keys(input.secrets ?? {}).length > 0) throw new BadRequestException('an agent never handles secrets: reference them as {{secret:NAME}} and the CEO sets them');
    const prepared = await this.prepare(org, kind, opts.propose ? { ...input, secrets: undefined } : input).catch(async (err: unknown) => {
      // A proposal may reference a secret the CEO will set on approval.
      if (opts.propose && err instanceof BadRequestException && /references secret/.test(err.message)) return this.prepareLoose(org, kind, input);
      throw err;
    });
    const now = nowIso();
    const live = !opts.propose;
    const token = live && kind === 'webhook' ? newToken() : undefined;
    const row: MetricSource = {
      accountId: currentAccountId(), id: newId(), orgId, name, kind, config: JSON.stringify(prepared.config), secrets: JSON.stringify(prepared.secrets),
      tokenHash: token ? hashToken(token) : '', unit: (input.unit ?? '').slice(0, 40), pollMinutes: prepared.pollMinutes,
      status: live ? 'ok' : 'pending_approval', lastValue: null, lastFetchedAt: null, lastError: '', failures: 0,
      nextPollAt: live ? now : null, approvalId: null, activatedAt: live ? now : null, createdBy: actor.slice(0, 80), createdAt: now,
    };
    await this.db.insert(orgMetricSources).values(row);
    await this.audit.append(orgId, { actor, action: live ? 'metric_source_create' : 'metric_source_propose', refType: 'metric_source', refId: row.id, payload: { name, kind, config: prepared.config, secretNames: Object.keys(prepared.secrets), pollMinutes: row.pollMinutes, why: (opts.why ?? '').slice(0, 300) } });
    if (!live) {
      const target = kind === 'http_json' ? String(prepared.config.url ?? '') : kind === 'connection' ? `${String(prepared.config.query)}${prepared.config.q ? ` "${String(prepared.config.q)}"` : ''}` : kind;
      const a = await this.approvals.create(orgId, { kind: 'metric_source', payload: { sourceId: row.id, name, kind, target, config: prepared.config, unit: row.unit, pollMinutes: row.pollMinutes, why: opts.why ?? '' }, requestedBy: actor, recommendation: opts.why });
      await this.db.update(orgMetricSources).set({ approvalId: a.id }).where(eq(orgMetricSources.id, row.id));
      return { source: await this.describe(orgId, row.id), approvalId: a.id };
    }
    return { source: await this.describe(orgId, row.id), ...(token ? { token } : {}) };
  }

  /** A proposal's config without the "secret is set" requirement. */
  private async prepareLoose(org: Organization, kind: string, input: SourceInput) {
    const names = new Set<string>();
    for (const v of Object.values(((input.config ?? {}).headers ?? {}) as Record<string, unknown>)) for (const n of secretRefs(String(v ?? ''))) names.add(n);
    const placeholder = Object.fromEntries([...names].map((n) => [n, '__pending__']));
    const out = await this.prepare(org, kind, { ...input, secrets: placeholder });
    return { ...out, secrets: {} };
  }

  /** The `metric_source` approval's applier: make the source live. */
  private async activateFromApproval(orgId: string, payload: Record<string, unknown>, approvalId: string): Promise<Record<string, unknown>> {
    const src = await this.get(orgId, String(payload.sourceId ?? ''));
    if (src.status !== 'pending_approval') throw new BadRequestException(`metric source "${src.name}" is ${src.status}`);
    const missing = [...new Set(Object.values((parseObj(src.config).headers ?? {}) as Record<string, string>).flatMap((v) => secretRefs(v)))].filter((n) => !parseObj(src.secrets)[n]);
    if (missing.length) throw new BadRequestException(`set the secret(s) ${missing.join(', ')} first (PATCH …/metrics/sources/${src.id} { secrets }), then approve`);
    const now = nowIso();
    await this.db.update(orgMetricSources).set({ status: 'ok', activatedAt: now, nextPollAt: now, approvalId }).where(eq(orgMetricSources.id, src.id));
    await this.audit.append(orgId, { actor: 'user', action: 'metric_source_activate', refType: 'metric_source', refId: src.id, payload: { name: src.name, kind: src.kind, approvalId } });
    return { sourceId: src.id, status: 'ok', ...(src.kind === 'webhook' ? { next: 'rotate the token (POST …/metrics/sources/:id/token) to get the webhook URL\'s secret' } : {}) };
  }

  async update(orgId: string, id: string, input: SourceInput, actor: string): Promise<SourceView> {
    const org = await this.org.get(orgId);
    const src = await this.get(orgId, id);
    const set: Record<string, unknown> = {};
    if (input.name !== undefined) { const n = input.name.trim().slice(0, 120); if (!n) throw new BadRequestException('name cannot be empty'); set.name = n; }
    if (input.unit !== undefined) set.unit = input.unit.slice(0, 40);
    if (input.config !== undefined || input.secrets !== undefined || input.pollMinutes !== undefined) {
      const p = await this.prepare(org, src.kind, input, src);
      set.config = JSON.stringify(p.config); set.secrets = JSON.stringify(p.secrets); set.pollMinutes = p.pollMinutes;
      if (LIVE.has(src.status)) set.nextPollAt = nowIso();
    }
    if (Object.keys(set).length === 0) return this.describe(orgId, id);
    await this.db.update(orgMetricSources).set(set).where(eq(orgMetricSources.id, id));
    const { secrets: _s, ...logged } = set; void _s;
    await this.audit.append(orgId, { actor, action: 'metric_source_update', refType: 'metric_source', refId: id, payload: { ...logged, ...(input.secrets ? { secretNames: Object.keys(input.secrets) } : {}) } });
    return this.describe(orgId, id);
  }

  /** Delete a source and its samples; key results it measured become self-reported (their last measured value stays). */
  async remove(orgId: string, id: string, actor: string): Promise<{ ok: true; unbound: number }> {
    const src = await this.get(orgId, id);
    const bound = (await this.org.goals(orgId)).filter((g) => g.metricSourceId === src.id);
    for (const g of bound) await this.db.update(orgGoals).set({ metricSourceId: null }).where(eq(orgGoals.id, g.id));
    await this.db.delete(orgMetricSamples).where(eq(orgMetricSamples.sourceId, src.id));
    await this.db.delete(orgMetricSources).where(eq(orgMetricSources.id, src.id));
    await this.audit.append(orgId, { actor, action: 'metric_source_delete', refType: 'metric_source', refId: src.id, payload: { name: src.name, kind: src.kind, unbound: bound.map((g) => g.id) } });
    return { ok: true, unbound: bound.length };
  }

  /** A new webhook token (shown once); the old one stops working. */
  async rotateToken(orgId: string, id: string, actor: string): Promise<{ token: string; url: string }> {
    const src = await this.get(orgId, id);
    if (src.kind !== 'webhook') throw new BadRequestException('only webhook sources have a token');
    if (!LIVE.has(src.status)) throw new BadRequestException(`metric source "${src.name}" is ${src.status}`);
    const token = newToken();
    await this.db.update(orgMetricSources).set({ tokenHash: hashToken(token) }).where(eq(orgMetricSources.id, src.id));
    await this.audit.append(orgId, { actor, action: 'metric_source_token', refType: 'metric_source', refId: src.id, payload: { name: src.name } });
    return { token, url: `/api/metrics/${src.id}/ingest` };
  }

  // ---- writes: samples (never from an agent) ----

  /**
   * The one path a sample is written by. `by` names who caused it: `poll`,
   * `webhook`, or a human actor (`user`, `human:<id>`). An agent actor is
   * refused here as a last line, whatever route reached it.
   */
  private async recordSample(org: Organization, src: MetricSource, value: number, observedAt: string, provenance: Provenance, by: string): Promise<MetricSample> {
    if (by === 'chief' || by.startsWith('agent:')) throw new ForbiddenException('agents never write metric samples');
    if (!Number.isFinite(value)) throw new BadRequestException('value must be a finite number');
    if (!LIVE.has(src.status)) throw new BadRequestException(`metric source "${src.name}" is ${src.status}`);
    const now = nowIso();
    const row: MetricSample = { accountId: currentAccountId(), id: newId(), sourceId: src.id, value, observedAt, fetchedAt: now, provenance: JSON.stringify(provenance).slice(0, 4_000), createdAt: now };
    await this.db.insert(orgMetricSamples).values(row);
    const latest = (await this.latestSample(src.id)) ?? row;
    await this.db.update(orgMetricSources).set({
      lastValue: latest.value, lastFetchedAt: now, status: 'ok', lastError: '', failures: 0,
      nextPollAt: POLLED.has(src.kind) ? new Date(Date.now() + src.pollMinutes * 60_000).toISOString() : null,
    }).where(eq(orgMetricSources.id, src.id));
    await this.audit.append(org.id, { actor: by, action: 'metric_sample', refType: 'metric_source', refId: src.id, payload: { sampleId: row.id, value, observedAt, provenance: { ...provenance, note: provenance.note?.slice(0, 200) } } });
    // A fresh sample clears the source's stale signal.
    if (this.signals) {
      for (const s of (await this.signals.list(org.id, { kind: 'metric_stale' })).filter((x) => x.refId === src.id && x.status !== 'resolved')) await this.signals.resolve(org.id, s.id, 'system').catch(() => undefined);
    }
    await this.measureKeyResults(org.id, src.id, latest);
    this.mirror?.metricsChanged(org.id);
    return row;
  }

  /** Key results bound to the source take the latest sample — and only it. */
  private async measureKeyResults(orgId: string, sourceId: string, latest: MetricSample): Promise<void> {
    const goals = (await this.org.goals(orgId)).filter((g) => g.metricSourceId === sourceId && g.kind === 'key_result');
    for (const g of goals) {
      await this.db.update(orgGoals).set({ currentValue: latest.value, lastMeasuredAt: latest.fetchedAt }).where(eq(orgGoals.id, g.id));
      if (g.currentValue !== latest.value) await this.audit.append(orgId, { actor: 'system', action: 'kr_measured', refType: 'goal', refId: g.id, payload: { sourceId, sampleId: latest.id, from: g.currentValue, to: latest.value } });
    }
  }

  /** A human's attestation (manual_attested sources; CEO, board, employee). */
  async attest(orgId: string, id: string, input: { value: number; note?: string; observedAt?: string }, actor: string): Promise<MetricSample> {
    const org = await this.org.get(orgId);
    const src = await this.get(orgId, id);
    if (src.kind !== 'manual_attested') throw new BadRequestException(`"${src.name}" is a ${src.kind} source; only manual_attested sources take attestations`);
    const note = (input.note ?? '').trim().slice(0, 1_000);
    if (!note) throw new BadRequestException('an attestation needs a note: where the number comes from');
    const observedAt = checkObservedAt(input.observedAt);
    return this.recordSample(org, src, Number(input.value), observedAt, { kind: 'manual_attested', by: actor, note }, actor);
  }

  /** The account a source belongs to, before any account is bound (the public ingest route). */
  async accountOfSource(sourceId: string): Promise<string | null> {
    const rows = await unscoped(this.db).select({ accountId: orgMetricSources.accountId }).from(orgMetricSources).where(eq(orgMetricSources.id, sourceId)).limit(1);
    return rows.at(0)?.accountId ?? null;
  }

  /** POST /api/metrics/:sourceId/ingest — the webhook's own token, timing-safe. */
  async ingest(sourceId: string, token: string, body: unknown, now: Date = new Date()): Promise<{ accepted: true; sampleId: string }> {
    const src = (await this.db.select().from(orgMetricSources).where(eq(orgMetricSources.id, sourceId)).limit(1)).at(0);
    const given = Buffer.from(hashToken(token || ''), 'hex');
    const stored = Buffer.from(src?.tokenHash ?? '', 'hex');
    if (!src || src.kind !== 'webhook' || !token || stored.length !== given.length || !timingSafeEqual(given, stored)) throw new UnauthorizedException('unknown source or bad token');
    if (!LIVE.has(src.status)) throw new UnauthorizedException('unknown source or bad token');
    const hits = (this.ingestHits.get(src.id) ?? []).filter((t) => now.getTime() - t < 60_000);
    if (hits.length >= INGEST_RATE_PER_MIN) throw new HttpException(`rate limited: ${INGEST_RATE_PER_MIN} posts per minute per source`, HttpStatus.TOO_MANY_REQUESTS);
    hits.push(now.getTime());
    this.ingestHits.set(src.id, hits);
    const b = (body && typeof body === 'object' ? body : {}) as { value?: unknown; observedAt?: unknown };
    const value = typeof b.value === 'number' ? b.value : typeof b.value === 'string' && b.value.trim() ? Number(b.value) : NaN;
    if (!Number.isFinite(value)) throw new BadRequestException('body must be { value: number, observedAt?: ISO date }');
    const observedAt = checkObservedAt(typeof b.observedAt === 'string' ? b.observedAt : undefined);
    const org = await this.org.get(src.orgId);
    const raw = JSON.stringify(body ?? {});
    const sample = await this.recordSample(org, src, value, observedAt, { kind: 'webhook', responseHash: sha256(raw) }, 'webhook');
    return { accepted: true, sampleId: sample.id };
  }

  // ---- polling ----

  /** Fetch one polled source now; an error is recorded, never thrown past the caller's report. */
  async poll(orgId: string, id: string, actor = 'system'): Promise<{ ok: boolean; value?: number; error?: string; sample?: MetricSample }> {
    const org = await this.org.get(orgId);
    const src = await this.get(orgId, id);
    if (!POLLED.has(src.kind)) throw new BadRequestException(`${src.kind} sources are not polled — they arrive by ${src.kind === 'webhook' ? 'webhook' : 'attestation'}`);
    if (!LIVE.has(src.status)) throw new BadRequestException(`metric source "${src.name}" is ${src.status}`);
    const timeoutMs = sensingTunable(org, 'acceptance.checkTimeoutSeconds') * 1_000;
    try {
      const m = src.kind === 'http_json' ? await this.measureHttp(src, timeoutMs) : await this.measureConnection(org, parseObj(src.config), timeoutMs);
      const sample = await this.recordSample(org, src, m.value, nowIso(), m.provenance, actor === 'system' ? 'poll' : actor);
      return { ok: true, value: m.value, sample };
    } catch (err) {
      const msg = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      await this.markError(org, src, msg);
      return { ok: false, error: msg };
    }
  }

  private async markError(org: Organization, src: MetricSource, msg: string): Promise<void> {
    const failures = src.failures + 1;
    const backoff = Math.min(1_440, src.pollMinutes * 2 ** Math.min(failures - 1, 6));
    await this.db.update(orgMetricSources).set({ status: src.status === 'stale' ? 'stale' : 'error', lastError: msg, failures, nextPollAt: new Date(Date.now() + backoff * 60_000).toISOString() }).where(eq(orgMetricSources.id, src.id));
    await this.audit.append(org.id, { actor: 'system', action: 'metric_error', refType: 'metric_source', refId: src.id, payload: { error: msg, failures, retryInMinutes: backoff } });
    // The first failure in a row reaches the chief's inbox; the rest back off quietly.
    if (failures === 1 && org.chiefOfStaffAgentId) {
      await this.agents.addEvent(org.chiefOfStaffAgentId, { kind: 'info', title: `Metric source "${src.name}" failed: ${msg}`.slice(0, 200), body: `Retrying in ${backoff} minute(s). Key results it measures keep their last value.`, payload: JSON.stringify({ orgId: org.id, sourceId: src.id }), origin: 'loop' }).catch(() => undefined);
    }
  }

  private async measureHttp(src: MetricSource, timeoutMs: number): Promise<{ value: number; provenance: Provenance }> {
    const cfg = parseObj(src.config) as { url?: string; selector?: string; headers?: Record<string, string> };
    const secrets = parseObj(src.secrets) as Record<string, string>;
    const headers: Record<string, string> = { accept: 'application/json' };
    for (const [name, v] of Object.entries(cfg.headers ?? {})) headers[name] = v.replace(SECRET_REF, (_m, n: string) => unseal(secrets[n] ?? ''));
    const { status, text } = await this.httpGet(String(cfg.url ?? ''), timeoutMs, headers);
    const responseHash = sha256(text);
    if (status >= 400) throw new Error(`HTTP ${status} from ${cfg.url}`);
    let doc: unknown;
    try { doc = JSON.parse(text); } catch { throw new Error('the response is not JSON'); }
    return { value: selectNumber(doc, String(cfg.selector ?? '')), provenance: { kind: 'http_json', url: cfg.url, status, responseHash } };
  }

  /** GET through the SSRF guard (every redirect re-checked), https only unless the dev flag is on, body capped. */
  private async httpGet(url: string, timeoutMs: number, headers: Record<string, string> = {}): Promise<{ status: number; text: string }> {
    let u: URL;
    try { u = new URL(url); } catch { throw new Error('invalid URL'); }
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && privateUrlsAllowed())) throw new Error('only https URLs are fetched');
    const res = await fetchPublic(u.toString(), { headers, signal: AbortSignal.timeout(timeoutMs) }, this.fetchImpl);
    const text = await res.text();
    if (text.length > BODY_CAP) throw new Error(`response larger than ${BODY_CAP} bytes`);
    return { status: res.status, text };
  }

  /** A workspace agent holding a (default) grant on the service, for unattended reads. */
  private async grantHolder(org: Organization, service: 'gmail' | 'calendar' | 'drive'): Promise<string> {
    if (!this.connections) throw new Error('connections are not available on this server');
    const inWorkspace = new Set((await this.agents.list({ workspaceId: org.workspaceId })).map((a) => a.id));
    const grant = (await this.db.select().from(connectionGrants).where(and(eq(connectionGrants.service, service), eq(connectionGrants.memberAccountId, '')))).find((g) => inWorkspace.has(g.agentId));
    if (!grant) throw new Error(`no agent of this workspace holds a ${service} grant — grant one on an agent's Skills & tools tab first`);
    return grant.agentId;
  }

  /** The fixed connection-query menu (org-checks.ts CONNECTION_QUERIES), Google only. */
  private async measureConnection(org: Organization, raw: Record<string, unknown>, timeoutMs: number): Promise<{ value: number; provenance: Provenance }> {
    const spec = normalizeConnectionQuery(raw);
    const service = serviceOfQuery(spec.query);
    const agentId = await this.grantHolder(org, service);
    const conn = await this.connections!.connectionFor(agentId, 'google', service);
    if (service === 'gmail' && !capabilitiesFor('google', JSON.parse(conn.scopes) as string[]).mailReadCapable) throw new Error('the Gmail connection has no read consent — enable "Gmail reading" in Settings → Connections');
    const now = new Date();
    let url: string;
    let count: (doc: unknown) => number;
    if (spec.query === 'gmail_unread' || spec.query === 'gmail_matching') {
      const q = spec.query === 'gmail_unread' ? `is:unread ${spec.q}`.trim() : `${spec.q} newer_than:${spec.days}d`.trim();
      url = `https://gmail.googleapis.com/gmail/v1/users/me/messages?${new URLSearchParams({ q, maxResults: '500' })}`;
      count = (d) => ((d as { messages?: unknown[] }).messages ?? []).length;
    } else if (spec.query === 'calendar_events_week') {
      const start = startOfWeek(now);
      const params = new URLSearchParams({ timeMin: start.toISOString(), timeMax: new Date(start.getTime() + 7 * 86_400_000).toISOString(), singleEvents: 'true', maxResults: '250' });
      if (spec.q) params.set('q', spec.q);
      url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`;
      count = (d) => ((d as { items?: unknown[] }).items ?? []).length;
    } else {
      const since = new Date(now.getTime() - spec.days * 86_400_000).toISOString();
      const q = `modifiedTime > '${since}' and trashed = false${spec.q ? ` and name contains '${spec.q.replace(/['\\]/g, '')}'` : ''}`;
      url = `https://www.googleapis.com/drive/v3/files?${new URLSearchParams({ q, pageSize: '1000', fields: 'files(id)' })}`;
      count = (d) => ((d as { files?: unknown[] }).files ?? []).length;
    }
    const doc = await withTimeout(this.connections!.googleGet(conn, url), timeoutMs, 'the connection query');
    return { value: count(doc), provenance: { kind: 'connection', connection: conn.id, service, query: `${spec.query}${spec.q ? ` "${spec.q}"` : ''}${spec.query.endsWith('matching') || spec.query === 'drive_changed' ? ` ${spec.days}d` : ''}`, responseHash: sha256(JSON.stringify(doc ?? null)) } };
  }

  // ---- the tick: due polls and staleness ----

  async tick(now: Date = this.now()): Promise<void> {
    if (!this.enabled()) return;
    const one = async () => {
      for (const org of await this.org.list()) {
        if (org.status !== 'active') continue;
        await this.sweep(org.id, now).catch((err) => this.logger.warn(`sensing sweep for org ${org.id} failed: ${err instanceof Error ? err.message : err}`));
      }
    };
    if (!this.accounts) return one();
    await this.accounts.forEachAccount(one);
  }

  /** Poll what is due (at most 10 per org per tick), then mark stale sources. */
  async sweep(orgId: string, now: Date = this.now()): Promise<{ polled: number; stale: number }> {
    const org = await this.org.get(orgId);
    const due = (await this.rows(orgId)).filter((s) => POLLED.has(s.kind) && LIVE.has(s.status) && (!s.nextPollAt || s.nextPollAt <= now.toISOString())).slice(0, 10);
    for (const s of due) await this.poll(orgId, s.id);
    const mult = sensingTunable(org, 'sensing.staleMultiplier');
    let stale = 0;
    for (const s of (await this.rows(orgId)).filter((x) => LIVE.has(x.status))) {
      const last = Date.parse(s.lastFetchedAt ?? s.activatedAt ?? s.createdAt);
      if (!Number.isFinite(last) || now.getTime() - last <= mult * s.pollMinutes * 60_000) continue;
      stale++;
      if (s.status !== 'stale') {
        await this.db.update(orgMetricSources).set({ status: 'stale' }).where(eq(orgMetricSources.id, s.id));
        await this.audit.append(orgId, { actor: 'system', action: 'metric_stale', refType: 'metric_source', refId: s.id, payload: { name: s.name, lastFetchedAt: s.lastFetchedAt, pollMinutes: s.pollMinutes, multiplier: mult } });
      }
      const bound = (await this.org.goals(orgId)).filter((g) => g.metricSourceId === s.id).map((g) => `"${g.title}"`);
      await this.signals?.open(orgId, {
        kind: 'metric_stale', severity: 'warn', refType: 'metric_source', refId: s.id, addressee: 'chief',
        title: `Metric source "${s.name}" is stale`,
        detail: `No sample since ${s.lastFetchedAt ? s.lastFetchedAt.slice(0, 16).replace('T', ' ') : 'it went live'} (expected every ${s.pollMinutes} min; stale after ${mult}×).${s.lastError ? ` Last error: ${s.lastError.slice(0, 200)}.` : ''}${bound.length ? ` Key results reading it: ${bound.join(', ')} — their values are old.` : ''}`,
      }, now).catch(() => undefined);
    }
    return { polled: due.length, stale };
  }

  // ---- executable acceptance ----

  /** The latest results of a task's checks, one per check (pending when never run). */
  async taskChecks(orgId: string, taskId: string): Promise<CheckResult[]> {
    const t = await this.tasks.get(orgId, taskId);
    const checks = this.tasks.checksOf(t);
    const rows = await this.db.select().from(orgTaskChecks).where(and(eq(orgTaskChecks.orgId, orgId), eq(orgTaskChecks.taskId, t.id)));
    return checks.map((check, index) => {
      const r = rows.find((x) => x.checkIndex === index);
      return { index, check, status: (r?.status ?? 'pending') as CheckStatus, detail: r?.detail ?? 'not run yet', evidence: parseObj(r?.evidence ?? '{}'), ...(r ? { ranAt: r.ranAt } : {}) };
    });
  }

  private readonly checkListeners: Array<(ev: { orgId: string; task: OrgTask; outcome: 'pass' | 'fail' | 'error'; results: CheckResult[]; actor: string }) => Promise<void> | void> = [];

  /** Be told after every check run with the task as it stood before it (incidents, docs/incidents.md §2: a task accepted by check that fails a re-run). */
  onChecksRun(fn: (ev: { orgId: string; task: OrgTask; outcome: 'pass' | 'fail' | 'error'; results: CheckResult[]; actor: string }) => Promise<void> | void): () => void {
    this.checkListeners.push(fn);
    return () => { const i = this.checkListeners.indexOf(fn); if (i >= 0) this.checkListeners.splice(i, 1); };
  }

  /** Run every check of a task now (model-free); the results replace the last ones. */
  async runChecks(orgId: string, taskId: string, actor = 'system'): Promise<{ outcome: 'none' | 'pass' | 'fail' | 'error'; results: CheckResult[] }> {
    const org = await this.org.get(orgId);
    const t = await this.tasks.get(orgId, taskId);
    const checks = this.tasks.checksOf(t);
    if (checks.length === 0) return { outcome: 'none', results: [] };
    const timeoutMs = sensingTunable(org, 'acceptance.checkTimeoutSeconds') * 1_000;
    const results: CheckResult[] = [];
    for (const [index, check] of checks.entries()) {
      let r: Omit<CheckResult, 'index' | 'check'>;
      try { r = await withTimeout(this.evaluate(org, t, check, timeoutMs), timeoutMs + 500, 'the check'); } catch (err) { r = { status: 'error', detail: (err instanceof Error ? err.message : String(err)).slice(0, 500), evidence: {} }; }
      results.push({ index, check, ...r });
    }
    const ranAt = nowIso();
    await this.db.delete(orgTaskChecks).where(and(eq(orgTaskChecks.orgId, orgId), eq(orgTaskChecks.taskId, t.id)));
    for (const r of results) await this.db.insert(orgTaskChecks).values({ accountId: currentAccountId(), id: newId(), orgId, taskId: t.id, checkIndex: r.index, status: r.status, detail: r.detail.slice(0, 1_000), evidence: JSON.stringify(r.evidence).slice(0, 4_000), ranAt });
    const outcome = results.some((r) => r.status === 'fail') ? 'fail' : results.some((r) => r.status === 'error') ? 'error' : 'pass';
    await this.audit.append(orgId, { actor, action: 'checks_run', refType: 'task', refId: t.id, payload: { outcome, results: results.map((r) => ({ i: r.index, kind: r.check.kind, status: r.status })) } });
    for (const fn of this.checkListeners) await Promise.resolve(fn({ orgId, task: t, outcome, results, actor })).catch(() => undefined);
    return { outcome, results };
  }

  /** Run one check derived elsewhere (reconciliation, docs/experiments.md §3)
   *  against a task without storing it on the task: model-free, time-boxed,
   *  audited as `check_adhoc`. */
  async runAdHocCheck(orgId: string, taskId: string, check: Check, actor = 'system'): Promise<Omit<CheckResult, 'index'>> {
    const org = await this.org.get(orgId);
    const t = await this.tasks.get(orgId, taskId);
    const timeoutMs = sensingTunable(org, 'acceptance.checkTimeoutSeconds') * 1_000;
    let r: Omit<CheckResult, 'index' | 'check'>;
    try { r = await withTimeout(this.evaluate(org, t, check, timeoutMs), timeoutMs + 500, 'the check'); } catch (err) { r = { status: 'error', detail: (err instanceof Error ? err.message : String(err)).slice(0, 500), evidence: {} }; }
    await this.audit.append(orgId, { actor, action: 'check_adhoc', refType: 'task', refId: t.id, payload: { kind: check.kind, status: r.status, detail: r.detail.slice(0, 300) } });
    return { check, ...r };
  }

  /** OrgTasksService's acceptance gate: run the checks and say what they settle. */
  private async gate(orgId: string, task: OrgTask): Promise<AcceptanceVerdict> {
    const { outcome, results } = await this.runChecks(orgId, task.id, 'check');
    if (outcome === 'none') return { outcome, detail: '', alsoReview: false };
    const org = await this.org.get(orgId);
    const lines = (outcome === 'pass' ? results : results.filter((r) => r.status !== 'pass')).map((r) => `${r.index + 1}. ${describeCheck(r.check)}: ${r.status} — ${r.detail}`);
    const detail = outcome === 'pass' ? `${results.length} check(s) passed: ${results.map((r) => describeCheck(r.check)).join('; ')}` : lines.join('\n');
    const qualitative = parseBrief(task.brief).done_when.trim().length > 0;
    return { outcome, detail, alsoReview: outcome === 'pass' && qualitative && sensingTunable(org, 'acceptance.alsoReviewWhenChecksPass') >= 1 };
  }

  private async evaluate(org: Organization, task: OrgTask, c: Check, timeoutMs: number): Promise<Omit<CheckResult, 'index' | 'check'>> {
    switch (c.kind) {
      case 'metric_at_least':
      case 'metric_increased': {
        const src = await this.byRef(org.id, c.sourceId).catch(() => null);
        if (!src) return { status: 'error', detail: `no metric source "${c.sourceId}"`, evidence: {} };
        if (!LIVE.has(src.status)) return { status: 'error', detail: `metric source "${src.name}" is ${src.status}`, evidence: { sourceId: src.id } };
        const latest = await this.latestSample(src.id);
        if (!latest) return { status: 'fail', detail: `"${src.name}" has no sample yet`, evidence: { sourceId: src.id } };
        if (c.kind === 'metric_at_least') {
          const ok = latest.value >= c.value;
          return { status: ok ? 'pass' : 'fail', detail: `"${src.name}" is ${latest.value}${src.unit ? ` ${src.unit}` : ''} (needs ≥ ${c.value}; observed ${latest.observedAt.slice(0, 16).replace('T', ' ')})`, evidence: { sourceId: src.id, sampleId: latest.id, value: latest.value } };
        }
        const all = await this.db.select().from(orgMetricSamples).where(eq(orgMetricSamples.sourceId, src.id)).orderBy(asc(orgMetricSamples.observedAt));
        const baseline = c.sinceTaskStart ? [...all].reverse().find((s) => s.observedAt <= task.createdAt) : all[0];
        if (!baseline) return { status: 'error', detail: `"${src.name}" has no sample from before the task started to compare with`, evidence: { sourceId: src.id } };
        const delta = latest.value - baseline.value;
        return { status: delta >= c.by ? 'pass' : 'fail', detail: `"${src.name}" moved ${baseline.value} → ${latest.value} (${delta >= 0 ? '+' : ''}${delta}; needs +${c.by})`, evidence: { sourceId: src.id, baselineSampleId: baseline.id, sampleId: latest.id, delta } };
      }
      case 'http_status': {
        const { status, text } = await this.httpGet(c.url, timeoutMs);
        return { status: status === c.status ? 'pass' : 'fail', detail: `GET ${c.url} answered ${status} (expected ${c.status})`, evidence: { url: c.url, status, responseHash: sha256(text) } };
      }
      case 'http_json_match': {
        const { status, text } = await this.httpGet(c.url, timeoutMs, { accept: 'application/json' });
        if (status >= 400) return { status: 'fail', detail: `GET ${c.url} answered ${status}`, evidence: { url: c.url, status } };
        let doc: unknown;
        try { doc = JSON.parse(text); } catch { return { status: 'error', detail: `${c.url} did not return JSON`, evidence: { url: c.url, status } }; }
        const v = selectValue(doc, c.selector);
        const shown = v === undefined ? 'nothing' : JSON.stringify(v).slice(0, 120);
        const fails: string[] = [];
        if (c.equals !== undefined && !(v === c.equals || (v !== undefined && v !== null && String(v) === String(c.equals)))) fails.push(`≠ ${JSON.stringify(c.equals)}`);
        if (c.contains !== undefined && !(Array.isArray(v) ? v.map(String).includes(c.contains) : typeof v === 'string' ? v.includes(c.contains) : false)) fails.push(`does not contain "${c.contains}"`);
        if (c.atLeast !== undefined && !(Number.isFinite(Number(v)) && v !== null && v !== '' && Number(v) >= c.atLeast)) fails.push(`< ${c.atLeast}`);
        return { status: fails.length ? 'fail' : 'pass', detail: `${c.selector} is ${shown}${fails.length ? ` (${fails.join(', ')})` : ''}`, evidence: { url: c.url, status, value: v === undefined ? null : v, responseHash: sha256(text) } };
      }
      case 'file_exists':
      case 'file_matches': {
        if (!this.storage) return { status: 'error', detail: 'file storage is not available', evidence: {} };
        const key = workspaceFileKey(org.workspaceId, c.path);
        const buf = await this.storage.get(key);
        if (!buf) return { status: 'fail', detail: `${c.path} does not exist in the workspace files`, evidence: { path: c.path } };
        if (c.kind === 'file_exists') return { status: 'pass', detail: `${c.path} exists (${buf.length} bytes)`, evidence: { path: c.path, bytes: buf.length, sha256: sha256(buf) } };
        const text = buf.subarray(0, BODY_CAP).toString('utf8');
        const fails: string[] = [];
        if (c.contains !== undefined && !text.includes(c.contains)) fails.push(`does not contain "${c.contains}"`);
        if (c.regex !== undefined && !new RegExp(c.regex).test(text)) fails.push(`does not match /${c.regex}/`);
        if (c.jsonSchemaKeys) {
          let doc: unknown;
          try { doc = JSON.parse(text); } catch { return { status: 'fail', detail: `${c.path} is not JSON`, evidence: { path: c.path } }; }
          const missing = c.jsonSchemaKeys.filter((k) => selectValue(doc, k) === undefined);
          if (missing.length) fails.push(`missing key(s) ${missing.join(', ')}`);
        }
        return { status: fails.length ? 'fail' : 'pass', detail: `${c.path}${fails.length ? ` ${fails.join('; ')}` : ' matches'}`, evidence: { path: c.path, bytes: buf.length, sha256: sha256(buf) } };
      }
      case 'connection_query': {
        const m = await this.measureConnection(org, { query: c.service, q: c.query, days: c.days }, timeoutMs);
        return { status: m.value >= c.atLeast ? 'pass' : 'fail', detail: `${c.service}${c.query ? ` "${c.query}"` : ''} counts ${m.value} (needs ≥ ${c.atLeast})`, evidence: { value: m.value, ...m.provenance } };
      }
    }
  }

  // ---- ToolProviderHook ----

  async specsFor(session: ChatSession): Promise<AiToolSpec[]> {
    if (!this.enabled() || !session.agentId) return [];
    const memberships = (await this.org.membershipsOf(session.agentId)).filter((m) => m.status === 'active');
    if (memberships.length === 0) return [];
    // The auditor's read-only run gets the reads it reconciles reported
    // numbers against; its restricted set refuses everything else.
    if (this.runtime?.runningCtx(session.id)?.audit) return MEMBER_TOOLS.filter((t) => t.name === 'org_metric_sources' || t.name === 'org_metric_read');
    for (const m of memberships) {
      const o = await this.org.get(m.orgId).catch(() => null);
      if (o?.chiefOfStaffAgentId === session.agentId || (this.units && await this.units.isLead(m.orgId, session.agentId))) return [...MEMBER_TOOLS, PROPOSE_TOOL];
    }
    return [...MEMBER_TOOLS];
  }

  owns(name: string): boolean { return TOOL_NAMES.has(name); }

  /** Reads, and a proposal the CEO decides: none changes state on its own. */
  isReadOnly(name: string): boolean { return TOOL_NAMES.has(name); }

  async contextFor(): Promise<string | null> { return null; }

  async execute(session: ChatSession, name: string, input: Record<string, unknown>): Promise<string> {
    if (!this.enabled()) throw new Error('organizations are disabled on this server');
    const agentId = session.agentId!;
    const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string).trim() : '');
    const org = await this.resolveOrg(agentId, input.org);
    if (org.status !== 'active') throw new Error(`"${org.name}" is paused by the CEO`);
    const member = await this.org.member(org.id, agentId);
    if (!member || member.status !== 'active') throw new Error(`you are not an active member of "${org.name}"`);
    const isChief = org.chiefOfStaffAgentId === agentId;
    const actor = isChief ? 'chief' : `agent:${agentId}`;
    const ctx = this.runtime?.runningCtx(session.id);
    const taskOf = async (): Promise<OrgTask> => {
      const id = str('taskId') || ctx?.taskId;
      if (!id) throw new Error('taskId is required outside a task run');
      return this.tasks.byPrefix(org.id, id);
    };
    switch (name) {
      case 'org_metric_sources': {
        const rows = await this.list(org.id);
        if (rows.length === 0) return 'No metric sources yet. Every key result is self-reported until one is bound to a source (org_propose_metric_source; the CEO approves).';
        return rows.map((s) => `- [${s.id.slice(0, 8)}] "${s.name}" (${s.kind}, ${s.status}) — ${s.lastValue === null ? 'no sample yet' : `${s.lastValue}${s.unit ? ` ${s.unit}` : ''} at ${(s.lastFetchedAt ?? '').slice(0, 16).replace('T', ' ')}`}${s.kind === 'http_json' || s.kind === 'connection' ? `, every ${s.pollMinutes} min` : ''}${s.lastError ? `; last error: ${s.lastError.slice(0, 120)}` : ''}${s.boundKeyResults.length ? `; measures ${s.boundKeyResults.map((g) => `"${g.title}"`).join(', ')}` : ''}`).join('\n');
      }
      case 'org_metric_read': {
        const src = await this.byRef(org.id, str('source')).catch((err: unknown) => { throw new Error(err instanceof Error ? err.message : String(err)); });
        const since = str('since') || new Date(Date.now() - 30 * 86_400_000).toISOString();
        const rows = (await this.samples(org.id, src.id, { since }).catch((err: unknown) => { throw new Error(err instanceof Error ? err.message : String(err)); })).slice(-50);
        if (rows.length === 0) return `"${src.name}" has no samples since ${since.slice(0, 10)} (status ${src.status}).`;
        return [`"${src.name}" (${src.kind}${src.unit ? `, ${src.unit}` : ''}), ${rows.length} sample(s):`, ...rows.map((r) => { const p = parseObj(r.provenance) as unknown as Provenance; return `- ${r.observedAt.slice(0, 16).replace('T', ' ')} ${r.value} — ${p.kind}${p.url ? ` ${p.url}` : ''}${p.query ? ` ${p.query}` : ''}${p.by ? ` attested by ${p.by}` : ''}${p.responseHash ? ` #${p.responseHash.slice(0, 10)}` : ''}`; })].join('\n');
      }
      case 'org_propose_metric_source': {
        const lead = this.units ? await this.units.isLead(org.id, agentId) : null;
        if (!isChief && !lead) throw new Error('org_propose_metric_source is for the chief of staff and unit leads');
        if (!str('why')) throw new Error('why is required: which key result it measures and why it is the truth for it');
        if (ctx?.plan?.dryRun && !ctx.applying) return `Recorded (dry run, nothing applied): propose metric source "${str('name')}" (${str('kind')}).`;
        const kind = str('kind');
        const config: Record<string, unknown> = kind === 'http_json' ? { url: str('url'), selector: str('selector'), headers: input.headers && typeof input.headers === 'object' ? input.headers : undefined }
          : kind === 'connection' ? { query: str('query'), q: str('q'), days: input.days } : {};
        const r = await this.create(org.id, { name: str('name'), kind, unit: str('unit'), pollMinutes: typeof input.pollMinutes === 'number' ? input.pollMinutes : undefined, config }, actor, { propose: true, why: str('why') })
          .catch((err: unknown) => { throw new Error(`refused: ${err instanceof Error ? err.message : String(err)}`); });
        if (ctx) ctx.progress = true;
        return `Metric source "${r.source.name}" proposed (pending the CEO's approval ${r.approvalId?.slice(0, 8)} — in every mode, because a source defines what counts as truth). Until it is approved it measures nothing; once live, bind it to the key result (org_set_key_result source) and the value comes only from it.`;
      }
      case 'org_task_checks': {
        const t = await taskOf();
        const rows = await this.taskChecks(org.id, t.id);
        if (rows.length === 0) return `Task ${taskRef(t)} has no checks: its done_when is judged by review.`;
        return [`Checks of ${taskRef(t)} "${t.title}":`, ...rows.map((r) => `${r.index + 1}. ${describeCheck(r.check)} — ${r.status}: ${r.detail}`)].join('\n');
      }
      case 'org_run_checks': {
        const t = await taskOf();
        if (!isChief && t.assigneeAgentId !== agentId && t.reviewerAgentId !== agentId) throw new Error('only the task owner, its reviewer or the chief runs its checks');
        const r = await this.runChecks(org.id, t.id, actor);
        if (r.outcome === 'none') return `Task ${taskRef(t)} has no checks.`;
        if (ctx) ctx.progress = true;
        return [`Checks of ${taskRef(t)}: ${r.outcome === 'pass' ? 'all pass — org_request_review will accept the task' : r.outcome === 'fail' ? 'some fail — fix them before requesting review' : 'some could not run — review will judge'}.`, ...r.results.map((x) => `${x.index + 1}. ${describeCheck(x.check)} — ${x.status}: ${x.detail}`)].join('\n');
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
}

// ---- helpers ----

function parseObj(raw: string | null | undefined): Record<string, unknown> {
  try { const v = JSON.parse(raw || '{}') as unknown; return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}; } catch { return {}; }
}

function sha256(v: string | Buffer): string { return createHash('sha256').update(v).digest('hex'); }
function newToken(): string { return randomBytes(24).toString('base64url'); }
export function hashToken(token: string): string { return sha256(`yaam-metric:${token}`); }
function privateUrlsAllowed(): boolean { return process.env.YAAM_ALLOW_PRIVATE_URLS === 'true'; }

/** Monday 00:00 UTC of the week containing `d`. */
function startOfWeek(d: Date): Date {
  const day = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
}

/** An observedAt the caller gave: ISO, not more than 5 minutes ahead, not older than a year. Defaults to now. */
function checkObservedAt(v: string | undefined): string {
  if (!v) return nowIso();
  const t = Date.parse(v);
  if (!Number.isFinite(t)) throw new BadRequestException('observedAt must be an ISO date');
  if (t > Date.now() + 5 * 60_000) throw new BadRequestException('observedAt is in the future');
  if (t < Date.now() - 366 * 86_400_000) throw new BadRequestException('observedAt is more than a year old');
  return new Date(t).toISOString();
}

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms); })]);
  } finally { clearTimeout(timer); }
}
