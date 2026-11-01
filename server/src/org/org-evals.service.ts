/**
 * OrgEvalsService — golden sets per role and gated rollout (docs/evals.md,
 * execution-plan item 31, capability C6 of
 * docs/autonomous-org-first-principles.md).
 *
 *  1. **Harvest.** A task accepted by check (item 27), or by review within
 *     `evals.harvestReviewMaxRounds` request-changes rounds (the strong
 *     verdict: accepted the first time by default), becomes a case of its
 *     assignee's role (the member title as a slug): a snapshot of the task
 *     (title, brief, checks, class, the paths it named) and what good looked
 *     like (its checks and done_when as the rubric), at most
 *     `evals.casesPerRole` live cases per role. The CEO adds and retires
 *     cases by hand.
 *  2. **Replay.** A run replays up to `evals.casesPerRun` cases of a role for
 *     a candidate — a charter, a playbook version, a model, a routing tier —
 *     and, for the baseline, for the current configuration (cached per
 *     version hash for `evals.baselineCacheDays`). Each case is a throwaway
 *     session of the member's own agent (same tools) made **record-only**
 *     with `TurnLoopService.setSandbox` — the red-team path of item 29 — so
 *     nothing executes, queues or leaves the company; the candidate charter
 *     or playbook rides in the run's context, the model on the session; the
 *     session is deleted after. File checks are graded model-free against the
 *     sandbox's recorded `fs_write` calls; everything else (metric, HTTP and
 *     connection checks, the rubric) by the independent reviewer on another
 *     model family (`OrgRuntimeService.judge`). The run's USD cap
 *     (`evals.runUsdCap`) is reserved against the member's and the company's
 *     envelopes before the first case and settled after; cases past the cap
 *     are skipped.
 *  3. **Gate.** Before a charter change (a `charter_change` card), a new
 *     playbook version, or an agent's routing change rolls out, the role's
 *     golden set is replayed; a regression (pass rate below the baseline by
 *     more than `evals.regressionMargin`) blocks it with the result attached;
 *     a pass (or no golden set) lets the existing path continue.
 *
 * Verdicts and the comparison are model-free; only the rubric grader calls a
 * model.
 */
import { BadRequestException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { orgEvalCases, orgEvalRuns, skills } from '../database/schema';
import { newId, nowIso } from '../common/ids.util';
import { currentAccountId } from '../accounts/account-context';
import { AgentsService } from '../agents/agents.service';
import { ChatsRepository } from '../chats/chats.repository';
import { TurnLoopService } from '../chats/turn-loop.service';
import type { AiToolCall } from '../ai/ai-provider.interface';
import { OrgService, type Organization, type OrgMember } from './org.service';
import { OrgTasksService, parseBrief, type OrgTask } from './org-tasks.service';
import { OrgAuditService } from './org-audit.service';
import { OrgRuntimeService, type RunCtx } from './org-runtime.service';
import { OrgApprovalsService, type OrgApproval } from './org-approvals.service';
import { OrgPlaybooksService, type OrgPlaybook } from './org-playbooks.service';
import { describeCheck, normalizeChecks, parseChecks, selectValue, type Check } from './org-checks';
import { isTier, parseRouting, tierModel, type ModelTier } from './org-routing';
import { govTunable } from './governance-tunables';

export type OrgEvalCase = typeof orgEvalCases.$inferSelect;
export type OrgEvalRun = typeof orgEvalRuns.$inferSelect;
export type CandidateKind = 'charter' | 'playbook' | 'model' | 'routing';
export const CANDIDATE_KINDS: readonly CandidateKind[] = ['charter', 'playbook', 'model', 'routing'];
export interface Candidate { kind: CandidateKind; ref: string; before: string | null; after: string }
export interface TaskSnapshot { title: string; brief: ReturnType<typeof parseBrief>; checks: Check[]; class: string; inputs: string[] }
export interface Expected { checks: Check[]; rubric: string }
export interface CaseResult { caseId: string; pass: boolean | null; detail: string; usd: number; gradedBy: 'check' | 'rubric' | 'none' | 'skipped' }
export type EvalVerdict = 'pass' | 'regress' | 'inconclusive';
export interface RubricGrade { pass: boolean | null; detail: string }
export type RubricGrader = (input: { org: Organization; agentId: string; snapshot: TaskSnapshot; expected: Expected; transcript: string; calls: Array<{ name: string; input: Record<string, unknown> }>; checks: Check[] }) => Promise<RubricGrade>;

const FILE_KINDS = new Set(['file_exists', 'file_matches']);

/** The role a member plays, as a key: its title as a slug, else its agent id. */
export function roleKeyOf(m: Pick<OrgMember, 'title' | 'agentId'>): string {
  const slug = (m.title ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return slug || `agent-${m.agentId.slice(0, 8)}`;
}

/** Grade a file check against the sandbox's recorded writes. Pure. */
export function gradeFileCheck(c: Check, calls: Array<{ name: string; input: Record<string, unknown> }>): { pass: boolean; detail: string } {
  if (c.kind !== 'file_exists' && c.kind !== 'file_matches') return { pass: false, detail: 'not a file check' };
  const writes = calls.filter((x) => x.name === 'fs_write' && typeof x.input.path === 'string');
  const norm = (p: string) => p.replace(/^\.?\/+/, '');
  const hit = [...writes].reverse().find((w) => { const p = norm(String(w.input.path)); return p === c.path || p.endsWith(`/${c.path}`) || c.path.endsWith(`/${p}`); });
  if (!hit) return { pass: false, detail: `${c.path} was not written` };
  if (c.kind === 'file_exists') return { pass: true, detail: `${c.path} written` };
  const content = String(hit.input.content ?? '');
  const fails: string[] = [];
  if (c.contains !== undefined && !content.includes(c.contains)) fails.push(`does not contain "${c.contains}"`);
  if (c.regex && !new RegExp(c.regex).test(content)) fails.push(`does not match /${c.regex}/`);
  if (c.jsonSchemaKeys) {
    let doc: unknown;
    try { doc = JSON.parse(content); } catch { fails.push('is not JSON'); }
    if (doc !== undefined) for (const k of c.jsonSchemaKeys) { try { if (selectValue(doc, k) === undefined) fails.push(`lacks ${k}`); } catch { fails.push(`lacks ${k}`); } }
  }
  return { pass: fails.length === 0, detail: `${c.path}${fails.length ? ` ${fails.join('; ')}` : ' matches'}` };
}

/** The verdict from two pass rates. Pure. */
export function verdictOf(passRate: number | null, baseline: number | null, margin: number): EvalVerdict {
  if (passRate === null) return 'inconclusive';
  if (baseline === null) return passRate > 0 ? 'pass' : 'inconclusive';
  return passRate < baseline - margin - 1e-9 ? 'regress' : 'pass';
}

export function passRateOf(results: CaseResult[]): number | null {
  const graded = results.filter((r) => r.pass !== null);
  if (graded.length === 0) return null;
  return Math.round((graded.filter((r) => r.pass).length / graded.length) * 1000) / 1000;
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T { try { return JSON.parse(raw || '') as T; } catch { return fallback; } }

@Injectable()
export class OrgEvalsService {
  private readonly logger = new Logger(OrgEvalsService.name);
  /** Test seam: the rubric grader (default: the independent reviewer on another family). */
  gradeFn?: RubricGrader;

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly org: OrgService,
    private readonly tasks: OrgTasksService,
    private readonly audit: OrgAuditService,
    private readonly agents: AgentsService,
    private readonly repo: ChatsRepository,
    private readonly turns: TurnLoopService,
    private readonly runtime: OrgRuntimeService,
    private readonly approvals: OrgApprovalsService,
    @Optional() private readonly playbooks?: OrgPlaybooksService,
  ) {
    tasks.onAccepted((ev) => this.harvest(ev.orgId, ev.task, ev.by, ev.rounds).then(() => undefined));
    approvals.onBeforeApply('charter_change', (orgId, a, payload) => this.gateCard(orgId, a, payload));
    approvals.onBeforeApply('routing', (orgId, a, payload) => this.gateCard(orgId, a, payload));
    playbooks?.setActivationGate((orgId, p, before) => this.gatePlaybook(orgId, p, before));
    runtime.setRolloutGate(async (orgId, cand, by) => {
      const role = await this.roleForClass(orgId, cand.ref);
      if (!role) return { blocked: false, summary: `no golden set covers ${cand.ref} tasks` };
      const g = await this.gate(orgId, role, cand, by);
      return { blocked: g.verdict === 'regress', summary: g.summary };
    });
  }

  // ---- golden sets ----

  async cases(orgId: string, opts: { roleKey?: string; includeRetired?: boolean } = {}): Promise<OrgEvalCase[]> {
    const rows = await this.db.select().from(orgEvalCases).where(eq(orgEvalCases.orgId, orgId)).orderBy(desc(orgEvalCases.createdAt));
    return rows.filter((c) => (!opts.roleKey || c.roleKey === opts.roleKey) && (opts.includeRetired || !c.retiredAt));
  }

  view(c: OrgEvalCase) { return { ...c, taskSnapshot: parseJson<TaskSnapshot | null>(c.taskSnapshot, null), expected: parseJson<Expected | null>(c.expected, null) }; }

  private snapshotOf(t: OrgTask): TaskSnapshot {
    const checks = parseChecks(t.checks);
    const paths = [...parseJson<string[]>(t.fileScope, []), ...checks.filter((c) => FILE_KINDS.has(c.kind)).map((c) => (c as { path: string }).path)];
    return { title: t.title, brief: parseBrief(t.brief), checks, class: t.class, inputs: [...new Set(paths)].slice(0, 20) };
  }

  /** A task was accepted: make it a golden case of its assignee's role. Idempotent per task. */
  async harvest(orgId: string, t: OrgTask, by: 'check' | 'review', rounds: number): Promise<OrgEvalCase | null> {
    if (!t.assigneeAgentId) return null;
    const org = await this.org.get(orgId);
    if (by === 'review' && rounds > govTunable(org, 'evals.harvestReviewMaxRounds')) return null;
    const m = await this.org.member(orgId, t.assigneeAgentId);
    if (!m) return null;
    const roleKey = roleKeyOf(m);
    const existing = await this.cases(orgId, { includeRetired: true });
    if (existing.some((c) => c.sourceTaskId === t.id)) return null;
    if (existing.filter((c) => c.roleKey === roleKey && !c.retiredAt).length >= govTunable(org, 'evals.casesPerRole')) return null;
    const snapshot = this.snapshotOf(t);
    const row: OrgEvalCase = {
      accountId: currentAccountId(), id: newId(), orgId, roleKey,
      taskSnapshot: JSON.stringify(snapshot), expected: JSON.stringify({ checks: snapshot.checks, rubric: snapshot.brief.done_when } satisfies Expected),
      sourceTaskId: t.id, source: by, createdAt: nowIso(), retiredAt: null,
    };
    await this.db.insert(orgEvalCases).values(row);
    await this.audit.append(orgId, { actor: 'system', action: 'eval_case_harvest', refType: 'task', refId: t.id, payload: { caseId: row.id, roleKey, by, checks: snapshot.checks.length } });
    return row;
  }

  /** The CEO's manual case (a task by id, or a snapshot written by hand). */
  async addCase(orgId: string, input: { roleKey?: string; taskId?: string; title?: string; brief?: Record<string, string>; checks?: unknown; rubric?: string }, actor = 'user'): Promise<OrgEvalCase> {
    await this.org.gate(orgId, { kind: 'eval_cases', summary: 'add a golden case' }, actor);
    let snapshot: TaskSnapshot;
    let roleKey = (input.roleKey ?? '').trim().toLowerCase();
    let sourceTaskId: string | null = null;
    if (input.taskId) {
      const t = await this.tasks.byPrefix(orgId, input.taskId);
      snapshot = this.snapshotOf(t);
      sourceTaskId = t.id;
      if (!roleKey && t.assigneeAgentId) { const m = await this.org.member(orgId, t.assigneeAgentId); if (m) roleKey = roleKeyOf(m); }
    } else {
      const title = (input.title ?? '').trim().slice(0, 200);
      if (!title) throw new BadRequestException('a case needs a taskId or a title and a brief');
      let checks: Check[];
      try { checks = normalizeChecks(input.checks); } catch (err) { throw new BadRequestException(err instanceof Error ? err.message : String(err)); }
      snapshot = { title, brief: parseBrief(input.brief), checks, class: 'general', inputs: [] };
    }
    if (!roleKey) throw new BadRequestException('roleKey is required (a member title as a slug, e.g. "writer")');
    const rubric = (input.rubric ?? snapshot.brief.done_when ?? '').slice(0, 4_000);
    if (!rubric && snapshot.checks.length === 0) throw new BadRequestException('a case needs checks or a rubric to be graded by');
    const row: OrgEvalCase = { accountId: currentAccountId(), id: newId(), orgId, roleKey, taskSnapshot: JSON.stringify(snapshot), expected: JSON.stringify({ checks: snapshot.checks, rubric } satisfies Expected), sourceTaskId, source: 'manual', createdAt: nowIso(), retiredAt: null };
    await this.db.insert(orgEvalCases).values(row);
    await this.audit.append(orgId, { actor, action: 'eval_case_add', refType: 'eval_case', refId: row.id, payload: { roleKey, sourceTaskId } });
    return row;
  }

  async retireCase(orgId: string, id: string, actor = 'user'): Promise<OrgEvalCase> {
    await this.org.gate(orgId, { kind: 'eval_cases', summary: 'retire a golden case' }, actor);
    const c = (await this.cases(orgId, { includeRetired: true })).find((x) => x.id === id || x.id.startsWith(id));
    if (!c) throw new NotFoundException(`eval case ${id}`);
    await this.db.update(orgEvalCases).set({ retiredAt: nowIso() }).where(eq(orgEvalCases.id, c.id));
    await this.audit.append(orgId, { actor, action: 'eval_case_retire', refType: 'eval_case', refId: c.id, payload: { roleKey: c.roleKey } });
    return (await this.cases(orgId, { includeRetired: true })).find((x) => x.id === c.id)!;
  }

  // ---- runs ----

  async runs(orgId: string, opts: { roleKey?: string; limit?: number } = {}): Promise<OrgEvalRun[]> {
    const conds = [eq(orgEvalRuns.orgId, orgId)];
    if (opts.roleKey) conds.push(eq(orgEvalRuns.roleKey, opts.roleKey));
    return this.db.select().from(orgEvalRuns).where(and(...conds)).orderBy(desc(orgEvalRuns.startedAt)).limit(Math.min(200, opts.limit ?? 50));
  }

  viewRun(r: OrgEvalRun) { return { ...r, candidate: parseJson<Candidate | null>(r.candidate, null), cases: parseJson<string[]>(r.cases, []), results: parseJson<CaseResult[]>(r.results, []) }; }

  /** A member who plays the role (for a charter candidate: the agent it names). */
  private async memberFor(orgId: string, roleKey: string, candidate: Candidate): Promise<OrgMember> {
    const members = (await this.org.members(orgId)).filter((m) => m.status === 'active');
    if (candidate.kind === 'charter' && candidate.ref) {
      const m = members.find((x) => x.agentId === candidate.ref || x.agentId.startsWith(candidate.ref));
      if (m) return m;
    }
    const m = members.find((x) => roleKeyOf(x) === roleKey);
    if (!m) throw new BadRequestException(`no active member plays the role "${roleKey}"`);
    return m;
  }

  /** Validate a candidate from a tool or the API; fills `before` from the live configuration. */
  async normalizeCandidate(orgId: string, roleKey: string, raw: unknown): Promise<Candidate> {
    const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const kind = String(o.kind ?? '') as CandidateKind;
    if (!CANDIDATE_KINDS.includes(kind)) throw new BadRequestException(`candidate.kind must be one of ${CANDIDATE_KINDS.join(', ')}`);
    const after = String(o.after ?? '').slice(0, 20_000);
    if (!after.trim()) throw new BadRequestException('candidate.after is required (the charter, playbook body, model id or tier to try)');
    let ref = String(o.ref ?? '').trim();
    let before: string | null = o.before === undefined || o.before === null ? null : String(o.before);
    if (kind === 'charter') {
      const m = await this.memberFor(orgId, roleKey, { kind, ref, before, after });
      ref = m.agentId;
      if (before === null) before = (await this.agents.get(m.agentId)).charter ?? '';
    } else if (kind === 'model') {
      if (before === null) { const m = await this.memberFor(orgId, roleKey, { kind, ref, before, after }); before = (await this.agents.get(m.agentId)).model || ''; }
    } else if (kind === 'routing') {
      if (!isTier(after)) throw new BadRequestException('a routing candidate\'s after is a tier: cheap, standard or strong');
      if (!ref) throw new BadRequestException('a routing candidate names the task class in ref');
      if (before === null) before = parseRouting((await this.org.get(orgId)).routing).classes[ref] ?? null;
    } else if (kind === 'playbook' && before === null && ref && this.playbooks) {
      const p = await this.playbooks.byRef(orgId, ref).catch(() => null);
      if (p?.skillId) before = (await this.db.select().from(skills).where(eq(skills.id, p.skillId)).limit(1)).at(0)?.instructions ?? null;
    }
    return { kind, ref, before, after };
  }

  /** Replay the role's golden set for a candidate and compare with the baseline. */
  async run(orgId: string, input: { roleKey: string; candidate: Candidate }, opts: { requestedBy?: string } = {}): Promise<OrgEvalRun> {
    const org = await this.org.get(orgId);
    const roleKey = input.roleKey.trim().toLowerCase();
    const cases = (await this.cases(orgId, { roleKey })).slice(0, govTunable(org, 'evals.casesPerRun'));
    const member = await this.memberFor(orgId, roleKey, input.candidate);
    const caseIds = cases.map((c) => c.id).sort();
    const hash = createHash('sha256').update(JSON.stringify([roleKey, input.candidate.kind, input.candidate.ref, input.candidate.before, caseIds])).digest('hex').slice(0, 32);
    // The baseline: the current configuration on the same cases, cached per version hash.
    const cacheMs = govTunable(org, 'evals.baselineCacheDays') * 86_400_000;
    let baseline = cacheMs > 0 ? (await this.runs(orgId, { roleKey, limit: 200 })).find((r) => r.kind === 'baseline' && r.versionHash === hash && r.status === 'done' && r.endedAt && Date.now() - Date.parse(r.endedAt) <= cacheMs) ?? null : null;
    const cap = govTunable(org, 'evals.runUsdCap');
    const reservation = await this.runtime.reserve(orgId, { agentId: member.agentId, projectId: null }, cap);
    if (!reservation.ok) {
      const row = await this.insertRun(orgId, roleKey, 'candidate', input.candidate, hash, caseIds, opts.requestedBy ?? 'user');
      await this.finishRun(row.id, { results: [], passRate: null, baselinePassRate: baseline?.passRate ?? null, baselineRunId: baseline?.id ?? null, verdict: 'inconclusive', usd: 0, status: 'failed' });
      await this.audit.append(orgId, { actor: opts.requestedBy ?? 'user', action: 'eval_refused', refType: 'eval_run', refId: row.id, payload: { scope: reservation.scope, roleKey } });
      return this.getRun(orgId, row.id);
    }
    let spent = 0;
    try {
      if (!baseline) {
        const b = await this.insertRun(orgId, roleKey, 'baseline', { ...input.candidate, after: input.candidate.before ?? '' }, hash, caseIds, opts.requestedBy ?? 'user');
        const res = await this.replay(org, member, cases, input.candidate, 'before', cap - spent);
        spent += res.usd;
        await this.finishRun(b.id, { results: res.results, passRate: passRateOf(res.results), baselinePassRate: null, baselineRunId: null, verdict: '', usd: res.usd, status: 'done' });
        baseline = await this.getRun(orgId, b.id);
      }
      const row = await this.insertRun(orgId, roleKey, 'candidate', input.candidate, hash, caseIds, opts.requestedBy ?? 'user');
      await this.audit.append(orgId, { actor: opts.requestedBy ?? 'user', action: 'eval_start', refType: 'eval_run', refId: row.id, payload: { roleKey, candidate: { kind: input.candidate.kind, ref: input.candidate.ref }, cases: caseIds.length, baselineRunId: baseline.id, capUsd: cap } });
      const res = await this.replay(org, member, cases, input.candidate, 'after', cap - spent);
      spent += res.usd;
      const passRate = passRateOf(res.results);
      const verdict = cases.length === 0 ? 'inconclusive' : verdictOf(passRate, baseline.passRate, govTunable(org, 'evals.regressionMargin'));
      await this.finishRun(row.id, { results: res.results, passRate, baselinePassRate: baseline.passRate, baselineRunId: baseline.id, verdict, usd: res.usd, status: 'done' });
      await this.audit.append(orgId, { actor: 'system', action: 'eval_end', refType: 'eval_run', refId: row.id, payload: { roleKey, verdict, passRate, baselinePassRate: baseline.passRate, usd: Number(spent.toFixed(6)) } });
      return this.getRun(orgId, row.id);
    } finally {
      await this.runtime.settle(orgId, { agentId: member.agentId, projectId: null }, cap, spent);
    }
  }

  private async insertRun(orgId: string, roleKey: string, kind: 'candidate' | 'baseline', candidate: Candidate, hash: string, caseIds: string[], requestedBy: string): Promise<OrgEvalRun> {
    const row: OrgEvalRun = { accountId: currentAccountId(), id: newId(), orgId, roleKey, kind, candidate: JSON.stringify(candidate).slice(0, 60_000), versionHash: hash, cases: JSON.stringify(caseIds), results: '[]', passRate: null, baselinePassRate: null, baselineRunId: null, verdict: '', usd: 0, requestedBy: requestedBy.slice(0, 120), startedAt: nowIso(), endedAt: null, status: 'running' };
    await this.db.insert(orgEvalRuns).values(row);
    return row;
  }

  private async finishRun(id: string, patch: { results: CaseResult[]; passRate: number | null; baselinePassRate: number | null; baselineRunId: string | null; verdict: EvalVerdict | ''; usd: number; status: 'done' | 'failed' }): Promise<void> {
    await this.db.update(orgEvalRuns).set({ results: JSON.stringify(patch.results).slice(0, 60_000), passRate: patch.passRate, baselinePassRate: patch.baselinePassRate, baselineRunId: patch.baselineRunId, verdict: patch.verdict, usd: Number(patch.usd.toFixed(6)), status: patch.status, endedAt: nowIso() }).where(eq(orgEvalRuns.id, id));
  }

  async getRun(orgId: string, id: string): Promise<OrgEvalRun> {
    const r = (await this.db.select().from(orgEvalRuns).where(and(eq(orgEvalRuns.orgId, orgId), eq(orgEvalRuns.id, id))).limit(1)).at(0);
    if (!r) throw new NotFoundException(`eval run ${id}`);
    return r;
  }

  /** Replay the cases with one side of the candidate, within `budget` USD. */
  private async replay(org: Organization, member: OrgMember, cases: OrgEvalCase[], candidate: Candidate, side: 'before' | 'after', budget: number): Promise<{ results: CaseResult[]; usd: number }> {
    const results: CaseResult[] = [];
    let usd = 0;
    const value = side === 'after' ? candidate.after : candidate.before;
    for (const c of cases) {
      if (usd >= budget) { results.push({ caseId: c.id, pass: null, detail: 'skipped: the run\'s USD cap (evals.runUsdCap) was reached', usd: 0, gradedBy: 'skipped' }); continue; }
      const snapshot = parseJson<TaskSnapshot | null>(c.taskSnapshot, null);
      const expected = parseJson<Expected>(c.expected, { checks: [], rubric: '' });
      if (!snapshot) { results.push({ caseId: c.id, pass: null, detail: 'unreadable snapshot', usd: 0, gradedBy: 'none' }); continue; }
      const r = await this.runCase(org, member, snapshot, candidate.kind, value).catch((err: unknown) => ({ calls: [], answer: '', usd: 0, error: err instanceof Error ? err.message : String(err) }));
      usd += r.usd;
      const g = await this.grade(org, member.agentId, snapshot, expected, r);
      results.push({ caseId: c.id, pass: g.pass, detail: `${g.detail}${r.error ? ` (run error: ${r.error.slice(0, 120)})` : ''}`.slice(0, 600), usd: Number(r.usd.toFixed(6)), gradedBy: g.gradedBy });
    }
    return { results, usd };
  }

  /** One case: a throwaway, record-only session of the member's agent. */
  private async runCase(org: Organization, member: OrgMember, snapshot: TaskSnapshot, kind: CandidateKind, value: string | null): Promise<{ calls: Array<{ name: string; input: Record<string, unknown> }>; answer: string; usd: number; error: string | null }> {
    const agent = await this.agents.get(member.agentId);
    const nonce = randomBytes(4).toString('hex');
    let model = agent.model || '';
    let charterLine = '';
    let playbookLine = '';
    if (kind === 'model' && value) model = value;
    if (kind === 'routing' && value && isTier(value)) model = tierModel(parseRouting(org.routing), value as ModelTier, agent.provider, agent.model || await this.runtime.modelFor(agent.id, org.workspaceId));
    if (kind === 'charter' && value !== null) charterLine = `## Your charter for this evaluation (it replaces the charter above)\n${value}`;
    if (kind === 'playbook' && value) playbookLine = `## Playbook to follow for this kind of work\n${value.slice(0, 8_000)}`;
    const session = await this.repo.createSession({ workspaceId: org.workspaceId, agentId: agent.id, name: `Eval · ${nonce}`, permissionMode: 'auto', model });
    const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
    this.turns.setSandbox(session.id, (call: AiToolCall) => { calls.push({ name: call.name, input: call.input }); return call.name === 'fs_write' ? `Wrote ${String(call.input.path ?? 'the file')}.` : 'ok (recorded in an evaluation sandbox)'; });
    const context = [
      '# Evaluation run',
      `You are replaying a past task of "${org.name}" so a change to how you work can be measured. Do the work as you would for real; every tool call is recorded and nothing leaves this run.`,
      charterLine, playbookLine,
      `## Task: ${snapshot.title}`,
      `- Outcome: ${snapshot.brief.outcome || '(not stated)'}`,
      `- Context: ${snapshot.brief.context || '(none)'}`,
      `- Constraints: ${snapshot.brief.constraints || '(none)'}`,
      `- Done when: ${snapshot.brief.done_when || '(not stated)'}`,
      snapshot.checks.length ? `- Checks that will be run: ${snapshot.checks.map(describeCheck).join('; ')}` : '',
      snapshot.inputs.length ? `- Paths it names: ${snapshot.inputs.join(', ')}` : '',
    ].filter(Boolean).join('\n');
    const ctx: RunCtx = { orgId: org.id, taskId: '', agentId: agent.id, runId: `eval-${nonce}`, sessionId: session.id, isChief: false, reviewer: false, progress: false, calls: new Map(), loopDetected: false, aux: { kind: 'eval', context } };
    this.runtime.beginAuxRun(ctx);
    let tokensIn = 0; let tokensOut = 0; let answer = ''; let error: string | null = null;
    try {
      for await (const ev of this.turns.run(session.id, { text: `Do the task "${snapshot.title}" described in your context, then say in two lines what you produced.`, origin: 'loop' })) {
        if (ev.type === 'answer') answer += ev.text;
        if (ev.type === 'usage') { tokensIn += ev.inputTokens; tokensOut += ev.outputTokens; }
        if (ev.type === 'error') error = ev.message;
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      this.runtime.endAuxRun(session.id);
      this.turns.clearSandbox(session.id);
      await this.repo.deleteSession(session.id).catch(() => undefined);
    }
    const usedModel = model || await this.runtime.modelFor(agent.id, org.workspaceId);
    return { calls, answer, usd: this.runtime.costUsd(usedModel, tokensIn, tokensOut), error };
  }

  /** File checks model-free against the recorded writes; the rest by the rubric grader. */
  private async grade(org: Organization, agentId: string, snapshot: TaskSnapshot, expected: Expected, r: { calls: Array<{ name: string; input: Record<string, unknown> }>; answer: string }): Promise<{ pass: boolean | null; detail: string; gradedBy: CaseResult['gradedBy'] }> {
    const fileChecks = expected.checks.filter((c) => FILE_KINDS.has(c.kind));
    const other = expected.checks.filter((c) => !FILE_KINDS.has(c.kind));
    const fileResults = fileChecks.map((c) => gradeFileCheck(c, r.calls));
    const fileFail = fileResults.filter((x) => !x.pass);
    if (fileChecks.length && fileFail.length) return { pass: false, detail: `checks: ${fileResults.map((x) => x.detail).join('; ')}`, gradedBy: 'check' };
    // Checks settle it when every check could be run model-free; the rubric only fills the gap.
    if (fileChecks.length && other.length === 0) return { pass: true, detail: `checks: ${fileResults.map((x) => x.detail).join('; ')}`, gradedBy: 'check' };
    if (other.length === 0 && !expected.rubric.trim()) return { pass: null, detail: 'nothing to grade by', gradedBy: 'none' };
    const transcript = [r.answer, ...r.calls.map((c) => `${c.name} ${JSON.stringify(c.input).slice(0, 600)}`)].join('\n').slice(0, 6_000);
    const g = await this.rubric({ org, agentId, snapshot, expected, transcript, calls: r.calls, checks: other });
    const prefix = fileChecks.length ? `checks: ${fileResults.map((x) => x.detail).join('; ')}; ` : '';
    return { pass: g.pass, detail: `${prefix}rubric: ${g.detail}`, gradedBy: g.pass === null && !fileChecks.length ? 'none' : 'rubric' };
  }

  private async rubric(input: Parameters<RubricGrader>[0]): Promise<RubricGrade> {
    if (this.gradeFn) return this.gradeFn(input);
    const rubric = [input.expected.rubric, ...input.checks.map((c) => `(would be checked: ${describeCheck(c)})`)].filter(Boolean).join('\n');
    const r = await this.runtime.judge(input.org, input.agentId, {
      userRequest: `Grade an evaluation replay of the task "${input.snapshot.title}". Allow only if the work shown meets this rubric:\n${rubric}`,
      conversationSummary: `Outcome wanted: ${input.snapshot.brief.outcome || '(unstated)'}. Constraints: ${input.snapshot.brief.constraints || 'none'}.`,
      recentContent: input.transcript,
      call: { name: 'org_eval_accept', input: { title: input.snapshot.title, rubric: rubric.slice(0, 2_000) } },
      origin: 'loop',
    }).catch(() => null);
    if (!r) return { pass: null, detail: 'no independent reviewer available' };
    return { pass: r.verdict === 'allow' ? true : r.verdict === 'deny' ? false : null, detail: `${r.verdict} (${r.model}${r.single ? ', single-model' : ''}): ${r.reason}`.slice(0, 400) };
  }

  // ---- the gate (docs/evals.md §3) ----

  /** Gate a candidate for a role. `regress` blocks; anything else continues. */
  async gate(orgId: string, roleKey: string, candidate: Candidate, requestedBy: string): Promise<{ verdict: EvalVerdict | 'skipped'; run: OrgEvalRun | null; summary: string }> {
    const org = await this.org.get(orgId);
    if (govTunable(org, 'evals.gate') < 1) return { verdict: 'skipped', run: null, summary: 'the eval gate is off (evals.gate = 0)' };
    if ((await this.cases(orgId, { roleKey })).length === 0) return { verdict: 'skipped', run: null, summary: `no golden set for "${roleKey}" yet` };
    const run = await this.run(orgId, { roleKey, candidate }, { requestedBy });
    return { verdict: (run.verdict || 'inconclusive') as EvalVerdict, run, summary: describeRun(run) };
  }

  /** A charter_change or routing card is about to apply: replay first. */
  private async gateCard(orgId: string, a: OrgApproval, payload: Record<string, unknown>): Promise<void> {
    let roleKey: string; let candidate: Candidate;
    if (a.kind === 'charter_change') {
      const m = await this.org.member(orgId, String(payload.agentId ?? ''));
      if (!m) return;
      roleKey = roleKeyOf(m);
      candidate = { kind: 'charter', ref: m.agentId, before: String(payload.before ?? ''), after: String(payload.after ?? '') };
    } else {
      const cls = String(payload.class ?? '');
      const target = await this.roleForClass(orgId, cls);
      if (!target) return;
      roleKey = target;
      candidate = { kind: 'routing', ref: cls, before: payload.from === null || payload.from === undefined ? null : String(payload.from), after: String(payload.tier ?? '') };
    }
    const prior = payload.eval as { verdict?: string; candidate?: string } | undefined;
    const sig = createHash('sha256').update(JSON.stringify(candidate)).digest('hex').slice(0, 16);
    if (prior?.verdict === 'regress' && prior.candidate === sig) throw new BadRequestException(`blocked by evals: the candidate regressed on the "${roleKey}" golden set (see the result on the card); revise or reject it`);
    const g = await this.gate(orgId, roleKey, candidate, `gate:${a.kind}:${a.id}`);
    if (g.verdict === 'skipped') return;
    await this.approvals.attach(orgId, a.id, { eval: { runId: g.run?.id ?? null, verdict: g.verdict, passRate: g.run?.passRate ?? null, baselinePassRate: g.run?.baselinePassRate ?? null, roleKey, summary: g.summary, candidate: sig } });
    if (g.verdict === 'regress') {
      await this.audit.append(orgId, { actor: 'system', action: 'eval_blocked', refType: 'approval', refId: a.id, payload: { kind: a.kind, roleKey, runId: g.run?.id } });
      throw new BadRequestException(`blocked by evals: ${g.summary} — the card stays pending with the result attached; revise or reject it`);
    }
  }

  /** A playbook's new version is about to activate: replay with it. */
  private async gatePlaybook(orgId: string, p: OrgPlaybook, before: string | null): Promise<{ ok: boolean; summary: string }> {
    if (p.version <= 1) return { ok: true, summary: 'first version' };
    const roles = parseJson<string[]>(p.roles, []).map((r) => roleKeyOf({ title: r, agentId: '' }));
    let roleKey: string | null = null;
    for (const r of roles) if ((await this.cases(orgId, { roleKey: r })).length) { roleKey = r; break; }
    if (!roleKey) return { ok: true, summary: 'no golden set for its roles' };
    const g = await this.gate(orgId, roleKey, { kind: 'playbook', ref: p.id, before, after: p.body }, `gate:playbook:${p.id}`);
    return { ok: g.verdict !== 'regress', summary: g.summary };
  }

  /** The role whose golden set covers a task class best (routing gate). */
  async roleForClass(orgId: string, cls: string): Promise<string | null> {
    const counts = new Map<string, number>();
    for (const c of await this.cases(orgId)) { const s = parseJson<TaskSnapshot | null>(c.taskSnapshot, null); if (s?.class === cls) counts.set(c.roleKey, (counts.get(c.roleKey) ?? 0) + 1); }
    const members = (await this.org.members(orgId)).filter((m) => m.status === 'active').map(roleKeyOf);
    const best = [...counts.entries()].filter(([k]) => members.includes(k)).sort((a, b) => b[1] - a[1])[0];
    return best?.[0] ?? null;
  }
}

/** One line for a card, a tool result and the audit. */
export function describeRun(r: Pick<OrgEvalRun, 'roleKey' | 'verdict' | 'passRate' | 'baselinePassRate' | 'usd' | 'results'>): string {
  const pct = (v: number | null) => (v === null ? 'n/a' : `${Math.round(v * 100)}%`);
  const results = parseJson<CaseResult[]>(r.results, []);
  return `${r.verdict || 'running'} on the "${r.roleKey}" golden set: ${pct(r.passRate)} passed vs ${pct(r.baselinePassRate)} for the current configuration (${results.filter((x) => x.pass !== null).length} graded of ${results.length}, $${r.usd.toFixed(4)})`;
}
