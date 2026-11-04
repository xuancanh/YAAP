/**
 * The program-management tools (docs/work-tracking.md "Program management:
 * the matrix"), offered to org members as a ToolProviderHook beside the
 * work-tracking tools so they work the same in every session kind.
 *
 *  - `org_program` (read, every member): what you own — each goal and
 *    project with its rhythm, team and resource requests — and the requests
 *    waiting on you; the chief sees the whole matrix and its health;
 *  - `org_program_assign` (the chief; an owner handing over): make a member
 *    (a Program Manager) the accountable owner of a goal or project;
 *  - `org_program_cadence` (the owner and up): an item's rhythm — a
 *    project's sync and milestone review, an objective's goal review —
 *    within the company's bounds;
 *  - `org_resource_request` (the owner and up): ask a head for a role, a
 *    share of a member's time, a window and a budget;
 *  - `org_resource_decide` (the head it is addressed to, and up): approve,
 *    adjust, decline (with the reason) or hire to fill;
 *  - `org_resource_escalate` (the owner): a disagreement, or no answer in
 *    time, goes to the head's manager as a `resource_conflict` card.
 *
 * Classes (docs/boundary.md): the read is read-only; a request is a
 * proposal (the head decides), so it is read-only too; assigning, setting a
 * rhythm, deciding and escalating are internal writes.
 */
import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ChatSession } from '../chats/chats.repository';
import { TurnLoopService, type ToolProviderHook } from '../chats/turn-loop.service';
import type { AiToolSpec } from '../ai/ai-provider.interface';
import { AgentsService } from '../agents/agents.service';
import { OrgService, type Organization } from './org.service';
import { OrgRuntimeService } from './org-runtime.service';
import { OrgProgramService } from './org-program.service';

const REF = 'A goal (its id or id prefix from org_intent) or a project (its key, e.g. P-3).';
const PROJECT_REF = 'The project key, e.g. P-3.';

const TOOLS: AiToolSpec[] = [
  { name: 'org_program', description: 'Program management (read-only): the goals and projects you own as their Program Manager, each with its rhythm (project sync, milestone review, goal review, status update, key-result check-ins — next occurrence and whether it is stale), its team with allocations and each member\'s head, and its resource requests with the heads\' answers; the requests waiting on you as a head; your own project seats. The chief: the whole matrix and its health (unowned items, the chief acting as PM, stretched members, stale rhythms, waiting requests).', inputSchema: { type: 'object', properties: { org: { type: 'string' } } } },
  { name: 'org_program_assign', description: 'Make a member the accountable owner of a goal (objective or key result) or a project — a Program Manager by default. The chief assigns; the current owner may hand over. An objective\'s key results move with it. The new owner is told and its default rhythm is set.', inputSchema: { type: 'object', properties: { ref: { type: 'string', description: REF }, owner: { type: 'string', description: 'The member, by name (a Program Manager).' }, why: { type: 'string' }, org: { type: 'string' } }, required: ['ref', 'owner'] } },
  { name: 'org_program_cadence', description: 'Set the rhythm of a goal or project you own: kind "sync" (the project\'s standup with its team) or "milestone_review" for a project, "goal_review" for an objective — a five-field cron (server time) within the company\'s bounds (org_program shows them), or "off". Each review is held in its channel with you facilitating and closes with your status update.', inputSchema: { type: 'object', properties: { ref: { type: 'string', description: REF }, kind: { type: 'string', enum: ['sync', 'milestone_review', 'goal_review'] }, cron: { type: 'string', description: 'e.g. "0 10 * * 2", or "off".' }, org: { type: 'string' } }, required: ['ref', 'kind', 'cron'] } },
  { name: 'org_resource_request', description: 'Ask a head for what a project you own needs: a role (and skills), a share of a member\'s time (1–100%), a window and a budget, with why (the milestone or key result it serves). Name the member you want (its head decides) or the head whose unit has the people (it picks). The head approves (the member joins the team at once), adjusts, declines with the reason, or hires to fill; unanswered in time it goes to the head\'s manager.', inputSchema: { type: 'object', properties: { project: { type: 'string', description: PROJECT_REF }, role: { type: 'string', description: 'Its role on the project: engineer, designer, analyst, …' }, skills: { type: 'string' }, member: { type: 'string', description: 'A member by name (optional).' }, head: { type: 'string', description: 'The head, by name, when no member is named.' }, allocation: { type: 'number', description: 'Percent of the member\'s time, 1–100.' }, startDate: { type: 'string', description: 'YYYY-MM-DD.' }, endDate: { type: 'string', description: 'YYYY-MM-DD.' }, budgetUsd: { type: 'number' }, why: { type: 'string' }, org: { type: 'string' } }, required: ['project', 'role', 'allocation', 'why'] } },
  { name: 'org_resource_decide', description: 'Answer a Program Manager\'s resource request addressed to you as the head (you own your people): approve (name the member: it joins the project team at the asked share), adjust (another member, a smaller share or a shorter window — with the reason), decline (with the reason), or hire (you will hire to fill; approve once the hire is in seat). A member\'s projects never sum past 100%.', inputSchema: { type: 'object', properties: { request: { type: 'string', description: 'The request id (prefix) from org_program or your heartbeat.' }, action: { type: 'string', enum: ['approve', 'adjust', 'decline', 'hire'] }, member: { type: 'string', description: 'The member who fills it, by name.' }, allocation: { type: 'number' }, endDate: { type: 'string', description: 'YYYY-MM-DD.' }, note: { type: 'string', description: 'The reason (required to adjust or decline).' }, org: { type: 'string' } }, required: ['request', 'action'] } },
  { name: 'org_resource_escalate', description: 'Escalate a resource request the head declined, cut, is slow to hire for, or did not answer in time: a decision card to the head\'s manager (then the CEO) with your case and the head\'s answer. Approved, the request is granted as asked; rejected, the head\'s answer stands. Or withdraw it (withdraw: true).', inputSchema: { type: 'object', properties: { request: { type: 'string' }, why: { type: 'string', description: 'Why the project needs it: the milestone or key result at stake.' }, withdraw: { type: 'boolean' }, org: { type: 'string' } }, required: ['request'] } },
];
const NAMES = new Set(TOOLS.map((t) => t.name));
const READ = new Set(['org_program', 'org_resource_request']);

@Injectable()
export class OrgProgramTools implements ToolProviderHook {
  constructor(
    private readonly org: OrgService,
    private readonly program: OrgProgramService,
    private readonly agents: AgentsService,
    private readonly config: ConfigService,
    @Optional() private readonly runtime?: OrgRuntimeService,
    @Optional() turns?: TurnLoopService,
  ) {
    turns?.addToolProvider(this);
  }

  private enabled(): boolean { return this.config.get<boolean>('companiesEnabled') !== false; }

  private async memberships(agentId: string) {
    return (await this.org.membershipsOf(agentId)).filter((m) => m.status === 'active');
  }

  async specsFor(session: ChatSession): Promise<AiToolSpec[]> {
    if (!this.enabled() || !session.agentId) return [];
    const ctx = this.runtime?.runningCtx(session.id);
    if (ctx?.audit) return TOOLS.filter((t) => t.name === 'org_program');
    if (ctx?.aux) return [];
    return (await this.memberships(session.agentId)).length ? TOOLS : [];
  }

  owns(name: string): boolean { return NAMES.has(name); }
  isReadOnly(name: string): boolean { return READ.has(name); }
  async contextFor(): Promise<string | null> { return null; }

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

  private async memberRef(orgId: string, v: unknown): Promise<string> {
    const q = String(v ?? '').trim().toLowerCase();
    const names = new Map((await this.agents.list()).map((a) => [a.id, a.name]));
    const m = (await this.org.members(orgId)).find((x) => x.status !== 'terminated' && (x.agentId === q || (q.length >= 6 && x.agentId.startsWith(q)) || (names.get(x.agentId) ?? '').toLowerCase() === q));
    if (!m) throw new Error(`no member "${String(v ?? '')}"`);
    return m.agentId;
  }

  async execute(session: ChatSession, name: string, input: Record<string, unknown>): Promise<string> {
    if (!this.enabled()) throw new Error('organizations are disabled on this server');
    const agentId = session.agentId!;
    const org = await this.resolveOrg(agentId, input.org);
    if (org.status !== 'active') throw new Error(`"${org.name}" is paused by the CEO`);
    const actor = `agent:${agentId}`;
    const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string).trim() : '');
    const num = (k: string) => (input[k] === undefined || input[k] === null || input[k] === '' ? undefined : Number(input[k]));
    const ctx = this.runtime?.runningCtx(session.id);
    const progressed = () => { if (ctx) ctx.progress = true; };
    const wrap = async <T>(fn: () => Promise<T>): Promise<T> => fn().catch((err: unknown) => { const m = err instanceof Error ? err.message : String(err); throw new Error(m.startsWith('refused') ? m : `refused: ${m}`); });
    switch (name) {
      case 'org_program': return this.program.describeFor(org.id, agentId);
      case 'org_program_assign': {
        const owner = await this.memberRef(org.id, str('owner'));
        const r = await wrap(() => this.program.assign(org.id, str('ref'), owner, actor, { why: str('why') }));
        progressed();
        return r.note;
      }
      case 'org_program_cadence': {
        const cron = str('cron');
        const r = await wrap(() => this.program.setCadence(org.id, str('ref'), str('kind'), !cron || cron.toLowerCase() === 'off' ? null : cron, actor));
        progressed();
        return r.note;
      }
      case 'org_resource_request': {
        const member = str('member') ? await this.memberRef(org.id, str('member')) : null;
        const head = str('head') ? await this.memberRef(org.id, str('head')) : null;
        const r = await wrap(() => this.program.request(org.id, { project: str('project'), role: str('role'), skills: str('skills'), member, head, allocation: num('allocation') ?? 0, startDate: str('startDate') || null, endDate: str('endDate') || null, budgetUsd: num('budgetUsd'), why: str('why') }, actor));
        progressed();
        return r.note;
      }
      case 'org_resource_decide': {
        const action = str('action') as 'approve' | 'adjust' | 'decline' | 'hire';
        if (!['approve', 'adjust', 'decline', 'hire'].includes(action)) throw new Error('action is approve, adjust, decline or hire');
        const member = str('member') ? await this.memberRef(org.id, str('member')) : null;
        const r = await wrap(() => this.program.decide(org.id, str('request'), { action, member, allocation: num('allocation'), endDate: str('endDate') || null, note: str('note') }, actor));
        progressed();
        return r.note;
      }
      case 'org_resource_escalate': {
        if (input.withdraw === true) { const r = await wrap(() => this.program.withdraw(org.id, str('request'), actor)); progressed(); return r.note; }
        const r = await wrap(() => this.program.escalate(org.id, str('request'), str('why'), actor));
        progressed();
        return r.note;
      }
    }
    throw new Error(`unknown tool: ${name}`);
  }
}
