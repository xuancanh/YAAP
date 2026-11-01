/**
 * The item-31 tools (docs/evals.md §4, docs/owners-seat.md, C4), offered to
 * org members as a ToolProviderHook beside the runtime's matrix so they work
 * the same in every session kind (task runs, heartbeats, chats, channels):
 *
 *  - `org_capacity` (read, every member): open tasks against the WIP limit
 *    and the expected load per member, expected duration per task class;
 *  - `org_eval_cases` (read, the chief and unit leads): a role's golden set;
 *  - `org_eval_role` (the chief): replay a role's golden set for a candidate
 *    charter, playbook, model or routing tier and return the verdict. It is
 *    sandboxed (record-only), budgeted, and changes nothing.
 */
import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ChatSession } from '../chats/chats.repository';
import { TurnLoopService, type ToolProviderHook } from '../chats/turn-loop.service';
import type { AiToolSpec } from '../ai/ai-provider.interface';
import { OrgService, type Organization } from './org.service';
import { OrgUnitsService } from './org-units.service';
import { OrgRuntimeService } from './org-runtime.service';
import { OrgCapacityService } from './org-capacity.service';
import { OrgEvalsService, describeRun, type CaseResult, type TaskSnapshot } from './org-evals.service';

const TOOLS: AiToolSpec[] = [
  { name: 'org_capacity', description: 'Capacity (read-only): each member\'s open tasks against the WIP limit (capacity.wipPerMember) and the expected load from history, and the median runs and hours per task class. Assign to members below their limit.', inputSchema: { type: 'object', properties: { org: { type: 'string' } } } },
  { name: 'org_eval_cases', description: 'A role\'s golden set (read-only): past tasks with known-good outcomes, harvested from work accepted by check or accepted by review the first time. roleKey is a member title as a slug (e.g. "writer").', inputSchema: { type: 'object', properties: { roleKey: { type: 'string' }, org: { type: 'string' } } } },
  { name: 'org_eval_role', description: 'Replay a role\'s golden set for a candidate change before proposing it: a charter (after = the full new charter; ref = the member), a playbook (ref = playbook id, after = the body), a model (after = model id) or a routing tier (ref = task class, after = cheap|standard|strong). Runs in a record-only sandbox within evals.runUsdCap, compares with the current configuration and returns pass | regress | inconclusive. Changes nothing.', inputSchema: { type: 'object', properties: { roleKey: { type: 'string' }, candidate: { type: 'object', properties: { kind: { type: 'string', enum: ['charter', 'playbook', 'model', 'routing'] }, ref: { type: 'string' }, after: { type: 'string' } }, required: ['kind', 'after'] }, org: { type: 'string' } }, required: ['roleKey', 'candidate'] } },
];
const NAMES = new Set(TOOLS.map((t) => t.name));
const READ = new Set(['org_capacity', 'org_eval_cases']);

@Injectable()
export class OrgGovernanceTools implements ToolProviderHook {
  constructor(
    private readonly org: OrgService,
    private readonly runtime: OrgRuntimeService,
    private readonly capacity: OrgCapacityService,
    private readonly evals: OrgEvalsService,
    private readonly config: ConfigService,
    @Optional() private readonly units?: OrgUnitsService,
    @Optional() turns?: TurnLoopService,
  ) {
    turns?.addToolProvider(this);
  }

  private enabled(): boolean { return this.config.get<boolean>('companiesEnabled') !== false; }

  async specsFor(session: ChatSession): Promise<AiToolSpec[]> {
    if (!this.enabled() || !session.agentId) return [];
    const ctx = this.runtime.runningCtx(session.id);
    if (ctx?.audit || ctx?.aux) return [];
    const memberships = (await this.org.membershipsOf(session.agentId)).filter((m) => m.status === 'active');
    if (memberships.length === 0) return [];
    for (const m of memberships) {
      const o = await this.org.get(m.orgId).catch(() => null);
      if (o?.chiefOfStaffAgentId === session.agentId) return [...TOOLS];
      if (this.units && await this.units.isLead(m.orgId, session.agentId)) return TOOLS.filter((t) => READ.has(t.name));
    }
    return TOOLS.filter((t) => t.name === 'org_capacity');
  }

  owns(name: string): boolean { return NAMES.has(name); }
  isReadOnly(name: string): boolean { return READ.has(name); }
  async contextFor(): Promise<string | null> { return null; }

  async execute(session: ChatSession, name: string, input: Record<string, unknown>): Promise<string> {
    if (!this.enabled()) throw new Error('organizations are disabled on this server');
    const agentId = session.agentId!;
    const org = await this.resolveOrg(agentId, input.org);
    if (org.status !== 'active') throw new Error(`"${org.name}" is paused by the CEO`);
    const isChief = org.chiefOfStaffAgentId === agentId;
    const lead = !isChief && this.units ? await this.units.isLead(org.id, agentId) : null;
    const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string).trim() : '');
    switch (name) {
      case 'org_capacity':
        return this.capacity.describe(org.id);
      case 'org_eval_cases': {
        if (!isChief && !lead) throw new Error('org_eval_cases is for the chief of staff and unit leads');
        const rows = await this.evals.cases(org.id, { roleKey: str('roleKey').toLowerCase() || undefined });
        if (rows.length === 0) return `No golden cases${str('roleKey') ? ` for "${str('roleKey')}"` : ''} yet: they are harvested from tasks accepted by check or accepted by review the first time.`;
        return rows.slice(0, 40).map((c) => { const v = this.evals.view(c); const s = v.taskSnapshot as TaskSnapshot | null; return `- [${c.id.slice(0, 8)}] ${c.roleKey}: ${s?.title ?? '?'} (${c.source}; ${v.expected?.checks.length ?? 0} check(s)${v.expected?.rubric ? ', rubric' : ''})`; }).join('\n');
      }
      case 'org_eval_role': {
        if (!isChief) throw new Error('org_eval_role is a chief-of-staff tool');
        const roleKey = str('roleKey').toLowerCase();
        if (!roleKey) throw new Error('roleKey is required');
        const candidate = await this.evals.normalizeCandidate(org.id, roleKey, input.candidate).catch((err: unknown) => { throw new Error(`refused: ${err instanceof Error ? err.message : String(err)}`); });
        const run = await this.evals.run(org.id, { roleKey, candidate }, { requestedBy: 'chief' });
        const results = JSON.parse(run.results || '[]') as CaseResult[];
        return [`Eval ${run.id.slice(0, 8)}: ${describeRun(run)}.`, ...results.map((r) => `- ${r.caseId.slice(0, 8)}: ${r.pass === null ? 'not graded' : r.pass ? 'pass' : 'FAIL'} (${r.gradedBy}) — ${r.detail.slice(0, 200)}`), run.verdict === 'regress' ? 'Regression: do not propose this change as is; a gated rollout would block it.' : ''].filter(Boolean).join('\n');
      }
    }
    throw new Error(`unknown tool: ${name}`);
  }

  private async resolveOrg(agentId: string, hint: unknown): Promise<Organization> {
    const memberships = (await this.org.membershipsOf(agentId)).filter((m) => m.status === 'active');
    if (memberships.length === 0) throw new Error('you do not belong to an organization');
    if (typeof hint === 'string' && hint.trim()) {
      const q = hint.trim().toLowerCase();
      for (const m of memberships) { const o = await this.org.get(m.orgId).catch(() => null); if (o && (o.id === q || o.id.startsWith(q) || o.name.toLowerCase() === q)) return o; }
      throw new Error(`no organization "${hint}"`);
    }
    if (memberships.length > 1) throw new Error(`you belong to ${memberships.length} organizations — pass org: <name>`);
    return this.org.get(memberships[0].orgId);
  }
}
