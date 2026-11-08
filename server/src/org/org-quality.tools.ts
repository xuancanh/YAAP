/**
 * The quality-control tools (docs/quality.md), offered to org members as a
 * ToolProviderHook beside the work-tracking tools so they work the same in
 * every session kind:
 *
 *  - `org_quality` (read, every member): the standards, policies and
 *    quality figures; with `task`, the standard and policies that task is
 *    held to;
 *  - `org_quality_standard` (the chief; a head for its own unit): create
 *    (from fields or a template), revise, retire, or attach one to a task
 *    or project;
 *  - `org_policy` (the chief; a head for its own unit): create, revise or
 *    retire a policy;
 *  - `org_policy_exception` (every member): ask for a one-time exception to
 *    a call a policy blocked — a card the CEO decides;
 *  - `org_qc_grade` (the spot checker): grade accepted work sampled for
 *    post-acceptance QA.
 *
 * Its context adds, for a run on a task, the standard and result policies
 * the maker must cite evidence for or the verifier must grade. Its
 * onToolResult notes what each member fetched (url: evidence).
 */
import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ChatSession } from '../chats/chats.repository';
import { TurnLoopService, type ToolProviderHook } from '../chats/turn-loop.service';
import type { AiToolCall, AiToolSpec } from '../ai/ai-provider.interface';
import { OrgService, type Organization } from './org.service';
import { OrgRuntimeService } from './org-runtime.service';
import { OrgTasksService } from './org-tasks.service';
import { OrgUnitsService } from './org-units.service';
import { OrgQualityService } from './org-quality.service';
import { QUALITY_TEMPLATES, parseCriteria } from './quality-model';

const CRITERIA = 'Criteria: [{ id, text, weight (default 1), min (1–5 floor, optional), evidence: kinds that count — file, url, tool, action, check, task, or ["none"] for judged-only }].';
const RULE = 'For a predicate: { tools: ["gmail_send", "shop_*"] or classes: ["external_irreversible"], when: [conditions], require: [conditions], forbid: [conditions] } where a condition is { field: dot path into the call input (or text/note for a result), op: exists|absent|eq|neq|gt|gte|lt|lte|contains|not_contains|matches|not_matches|in|not_in|max_len, value }.';

const TOOLS: AiToolSpec[] = [
  { name: 'org_quality', description: 'Quality control (read-only): the company\'s quality standards (criteria graded 1–5, the pass bar, scope), its policies with their violations, and quality figures (first-pass yield, rework, escapes) — or, with task, the standard and policies that task is held to.', inputSchema: { type: 'object', properties: { task: { type: 'string', description: 'A task key (ENG-12) to see what it is held to.' }, violations: { type: 'boolean', description: 'List recent policy violations.' }, org: { type: 'string' } } } },
  { name: 'org_quality_standard', description: `Author a quality standard: what a deliverable must meet to count as done. action create (fields, or template: ${QUALITY_TEMPLATES.map((t) => t.id).join(' | ')}), revise (a new version), retire, or attach (to a task or project by key/id). Scope: company | unit | role | deliverable (a task class or "deliverable: <kind>" line: research, synthesis, ops, outreach, …) | project | task. The chief authors company standards; a head its own unit's (scopeKind unit, or unitId on a deliverable/role standard). A new or stricter standard applies by the mode and policy.authoringApproval; lowering a bar is the CEO's card. ${CRITERIA}`, inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['create', 'revise', 'retire', 'attach'] }, standard: { type: 'string', description: 'Its slug or id (revise, retire, attach).' }, template: { type: 'string' }, name: { type: 'string' }, scopeKind: { type: 'string', enum: ['company', 'unit', 'role', 'deliverable', 'project', 'task'] }, scopeRef: { type: 'string' }, unitId: { type: 'string' }, summary: { type: 'string' }, criteria: { type: 'array', items: { type: 'object' } }, passScore: { type: 'number', description: 'Weighted bar on the 1–5 scale.' }, requireEvidence: { type: 'boolean' }, verifier: { type: 'string', enum: ['default', 'agent', 'family'], description: 'family: only a verifier on another model family may accept.' }, task: { type: 'string', description: 'attach: the task key.' }, project: { type: 'string', description: 'attach: the project id.' }, why: { type: 'string' }, org: { type: 'string' } }, required: ['action'] } },
  { name: 'org_policy', description: `Author a policy as enforceable data, not prose: action create, revise or retire. kind predicate (checked model-free on every matching tool call before it runs, and/or on results at review) or judged (an independent checker reads it: a second agent key at actions, a criterion the verifier scores at review). enforcement block (refused with your remediation) | warn | log; severity low | medium | high | critical. appliesAt action | result | both. Scope company | unit | role | action_class | deliverable. A new or stricter policy applies by the mode and policy.authoringApproval (a blocking one is the CEO's card by default); retiring or weakening one is the CEO's card. ${RULE} Always give remediation: what to do instead.`, inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['create', 'revise', 'retire'] }, policy: { type: 'string', description: 'Its key or id (revise, retire).' }, key: { type: 'string' }, statement: { type: 'string', description: 'The rule in one sentence.' }, rationale: { type: 'string' }, kind: { type: 'string', enum: ['predicate', 'judged'] }, rule: { type: 'object' }, appliesAt: { type: 'string', enum: ['action', 'result', 'both'] }, scopeKind: { type: 'string', enum: ['company', 'unit', 'role', 'action_class', 'deliverable'] }, scopeRef: { type: 'string' }, severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] }, enforcement: { type: 'string', enum: ['block', 'warn', 'log'] }, remediation: { type: 'string' }, why: { type: 'string' }, org: { type: 'string' } }, required: ['action'] } },
  { name: 'org_policy_exception', description: 'Ask for a one-time exception to a call a policy blocked: the violation id from the refusal and why the rule should not apply this once. A card the CEO decides; approved, the identical call may run once.', inputSchema: { type: 'object', properties: { violation: { type: 'string' }, why: { type: 'string' }, org: { type: 'string' } }, required: ['violation', 'why'] } },
  { name: 'org_qc_grade', description: 'Grade accepted work sampled for a post-acceptance spot check (your QA spot-check task names it): a 1–5 score for every criterion and pass or fail. A fail marks the work as an escaped defect for its maker and the chief.', inputSchema: { type: 'object', properties: { task: { type: 'string', description: 'The checked task\'s key (not the spot-check task).' }, pass: { type: 'boolean' }, scores: { type: 'array', items: { type: 'object', properties: { criterion: { type: 'string' }, score: { type: 'number' }, note: { type: 'string' }, evidence: { type: 'array', items: { type: 'string' } } } } }, note: { type: 'string' }, org: { type: 'string' } }, required: ['task', 'pass'] } },
];
const NAMES = new Set(TOOLS.map((t) => t.name));
const READ = new Set(['org_quality']);
const AUTHOR = new Set(['org_quality_standard', 'org_policy']);
/** The member's own record of work and its requests: they run without the trust gate (docs/permissions.md §8). */
const FREE = new Set(['org_policy_exception', 'org_qc_grade']);

@Injectable()
export class OrgQualityTools implements ToolProviderHook {
  constructor(
    private readonly org: OrgService,
    private readonly quality: OrgQualityService,
    private readonly tasks: OrgTasksService,
    private readonly config: ConfigService,
    @Optional() private readonly units?: OrgUnitsService,
    @Optional() private readonly runtime?: OrgRuntimeService,
    @Optional() turns?: TurnLoopService,
  ) {
    turns?.addToolProvider(this);
  }

  private enabled(): boolean { return this.config.get<boolean>('companiesEnabled') !== false; }

  private async memberships(agentId: string) {
    return (await this.org.membershipsOf(agentId)).filter((m) => m.status === 'active');
  }

  /** The chief, or a head of a non-root unit. */
  private async mayAuthor(orgId: string, agentId: string): Promise<boolean> {
    const o = await this.org.get(orgId).catch(() => null);
    if (o?.chiefOfStaffAgentId === agentId) return true;
    const u = this.units ? await this.units.ledBy(orgId, agentId).catch(() => null) : null;
    return Boolean(u && u.parentUnitId !== null);
  }

  async specsFor(session: ChatSession): Promise<AiToolSpec[]> {
    if (!this.enabled() || !session.agentId) return [];
    const ctx = this.runtime?.runningCtx(session.id);
    if (ctx?.audit) return TOOLS.filter((t) => t.name === 'org_quality');
    if (ctx?.aux) return [];
    const ms = await this.memberships(session.agentId);
    if (!ms.length) return [];
    const author = (await Promise.all(ms.map((m) => this.mayAuthor(m.orgId, session.agentId!)))).some(Boolean);
    return TOOLS.filter((t) => author || !AUTHOR.has(t.name));
  }

  owns(name: string): boolean { return NAMES.has(name); }
  isReadOnly(name: string): boolean { return READ.has(name); }
  async runsFreely(_session: ChatSession, call: AiToolCall): Promise<boolean> { return FREE.has(call.name); }

  /** A run on a task: the standard the maker cites evidence for, or the verifier grades. */
  async contextFor(session: ChatSession): Promise<string | null> {
    if (!this.enabled() || !session.agentId) return null;
    const ctx = this.runtime?.runningCtx(session.id);
    if (!ctx?.taskId || ctx.audit || ctx.aux) return null;
    const task = await this.tasks.get(ctx.orgId, ctx.taskId).catch(() => null);
    if (!task || ['done', 'cancelled'].includes(task.status)) return null;
    const role = ctx.reviewer ? 'verifier' : task.assigneeAgentId === session.agentId ? 'maker' : null;
    if (!role) return null;
    return this.quality.taskBrief(ctx.orgId, task, role).catch(() => null);
  }

  onToolResult(session: ChatSession, call: AiToolCall, result: { isError: boolean; output: string }): void {
    if (session.agentId) this.quality.noteToolCall(session.agentId, call.name, call.input ?? {}, result.isError);
  }

  private async resolveOrg(agentId: string, hint: unknown): Promise<Organization> {
    const ms = await this.memberships(agentId);
    if (ms.length === 0) throw new Error('you do not belong to an organization');
    if (typeof hint === 'string' && hint.trim()) {
      const q = hint.trim().toLowerCase();
      for (const m of ms) { const o = await this.org.get(m.orgId).catch(() => null); if (o && (o.id === q || o.id.startsWith(q) || o.name.toLowerCase() === q)) return o; }
      throw new Error(`no organization "${hint}"`);
    }
    if (ms.length > 1) throw new Error(`you belong to ${ms.length} organizations — pass org: <name>`);
    return this.org.get(ms[0].orgId);
  }

  async execute(session: ChatSession, name: string, input: Record<string, unknown>): Promise<string> {
    if (!this.enabled()) throw new Error('organizations are disabled on this server');
    const agentId = session.agentId!;
    const org = await this.resolveOrg(agentId, input.org);
    if (org.status !== 'active') throw new Error(`"${org.name}" is paused by the CEO`);
    const actor = org.chiefOfStaffAgentId === agentId ? 'chief' : `agent:${agentId}`;
    const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string).trim() : '');
    const ctx = this.runtime?.runningCtx(session.id);
    const progressed = () => { if (ctx) ctx.progress = true; };
    const wrap = async <T>(fn: () => Promise<T>): Promise<T> => fn().catch((err: unknown) => { const m = err instanceof Error ? err.message : String(err); throw new Error(/^(refused|Refused)/.test(m) ? m : `refused: ${m}`); });
    const fields = (keys: string[]) => Object.fromEntries(keys.filter((k) => input[k] !== undefined && input[k] !== null && input[k] !== '').map((k) => [k, input[k]]));
    switch (name) {
      case 'org_quality': {
        if (str('task')) {
          const t = await wrap(() => this.tasks.byPrefix(org.id, str('task')));
          const brief = await this.quality.taskBrief(org.id, t, 'maker');
          const last = (await this.quality.results(org.id, { taskId: t.id })).find((r) => r.outcome !== 'pending');
          return [brief ?? `${t.key ?? t.id.slice(0, 8)} is held to no quality standard; the done_when is its bar.`, last ? `Last QC result: ${last.outcome}${last.score !== null ? ` (${last.score})` : ''}${last.note ? ` — ${last.note.slice(0, 300)}` : ''}` : ''].filter(Boolean).join('\n');
        }
        const text = await this.quality.describe(org.id);
        if (!input.violations) return text;
        const v = await this.quality.violations(org.id, { limit: 20 });
        const pols = new Map((await this.quality.listPolicies(org.id)).map((p) => [p.id, p.key]));
        return `${text}\nRecent violations:\n${v.map((x) => `- ${x.id.slice(0, 8)} ${pols.get(x.policyId) ?? x.policyId.slice(0, 8)} ${x.outcome} (${x.status}) ${x.tool || x.stage}: ${x.detail.slice(0, 160)}`).join('\n') || '- none'}`;
      }
      case 'org_quality_standard': {
        const action = str('action');
        const why = str('why');
        if (action === 'create') {
          const r = await wrap(() => this.quality.createStandard(org.id, fields(['template', 'name', 'slug', 'scopeKind', 'scopeRef', 'unitId', 'summary', 'criteria', 'passScore', 'requireEvidence', 'verifier']), actor, why));
          progressed();
          return r.applied
            ? `Standard "${r.standard.slug}" v1 is active: ${parseCriteria(r.standard.criteria).length} criteria, pass at ${r.standard.passScore}. Tasks in its scope now need evidence per criterion and a graded review.`
            : `Standard "${r.standard.slug}" proposed (card ${(r.approvalId ?? '').slice(0, 8)}); it applies when the CEO approves.`;
        }
        if (action === 'revise' || action === 'retire') {
          const r = await wrap(() => this.quality.reviseStandard(org.id, str('standard'), { ...fields(['name', 'scopeKind', 'scopeRef', 'unitId', 'summary', 'criteria', 'passScore', 'requireEvidence', 'verifier']), ...(action === 'retire' ? { action: 'retire' } : {}) }, actor, why));
          progressed();
          return r.applied ? `Standard "${r.standard.slug}" ${action === 'retire' ? 'retired' : `is now v${r.standard.version}`}.` : `${action === 'retire' ? 'Retiring' : 'The revision of'} "${r.standard.slug}" waits on the CEO's card (${(r.approvalId ?? '').slice(0, 8)}); the current version stays until then.`;
        }
        if (action === 'attach') {
          const target = str('task') ? { kind: 'task' as const, id: (await wrap(() => this.tasks.byPrefix(org.id, str('task')))).id } : str('project') ? { kind: 'project' as const, id: str('project') } : null;
          if (!target) throw new Error('attach needs task or project');
          if (!(await this.mayAuthor(org.id, agentId))) throw new Error('refused: the chief or a head attaches standards');
          await wrap(() => this.quality.attach(org.id, str('standard'), target, actor));
          progressed();
          return `Standard "${str('standard')}" now applies to that ${target.kind}.`;
        }
        throw new Error('action must be create, revise, retire or attach');
      }
      case 'org_policy': {
        const action = str('action');
        const why = str('why');
        const keys = ['key', 'statement', 'rationale', 'kind', 'rule', 'appliesAt', 'scopeKind', 'scopeRef', 'severity', 'enforcement', 'remediation'];
        if (action === 'create') {
          const r = await wrap(() => this.quality.createPolicy(org.id, fields(keys), actor, why));
          progressed();
          return r.applied ? `Policy "${r.policy.key}" v1 is active (${r.policy.enforcement}, ${r.policy.severity}).` : `Policy "${r.policy.key}" proposed (card ${(r.approvalId ?? '').slice(0, 8)}); it applies when the CEO approves.`;
        }
        if (action === 'revise' || action === 'retire') {
          const r = await wrap(() => this.quality.revisePolicy(org.id, str('policy') || str('key'), { ...fields(keys.filter((k) => k !== 'key')), ...(action === 'retire' ? { action: 'retire' } : {}) }, actor, why));
          progressed();
          return r.applied ? `Policy "${r.policy.key}" ${action === 'retire' ? 'retired' : `is now v${r.policy.version}`}.` : `${action === 'retire' ? 'Retiring' : 'The revision of'} "${r.policy.key}" waits on the CEO's card (${(r.approvalId ?? '').slice(0, 8)}).`;
        }
        throw new Error('action must be create, revise or retire');
      }
      case 'org_policy_exception': {
        const r = await wrap(() => this.quality.requestException(org.id, str('violation'), agentId, str('why')));
        progressed();
        return `Exception requested (card ${r.approvalId.slice(0, 8)}). Do not retry the call until it is approved; you are told when it is decided.`;
      }
      case 'org_qc_grade': {
        const r = await wrap(() => this.quality.gradeSpotCheck(org.id, str('task'), agentId, { pass: input.pass === true || input.pass === 'true', scores: input.scores, note: str('note') }));
        progressed();
        return `Spot check recorded: ${r.outcome}${r.score !== null ? ` (weighted ${r.score})` : ''}. Your spot-check task is done.`;
      }
    }
    throw new Error(`unknown tool ${name}`);
  }
}
