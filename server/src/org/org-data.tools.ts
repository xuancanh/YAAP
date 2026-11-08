/**
 * Company data as read tools (docs/agent-data-access.md): the domains no
 * other org tool reads, offered to every active member as a
 * ToolProviderHook beside the runtime's matrix so they work the same in
 * every session kind (task runs, heartbeats, chats, channels). All are
 * class `read`; none writes. One tool per domain with a `view`, compact
 * lines, ids/keys to drill down, and a limit/offset page.
 *
 *  - `org_company`: profile (mission, constitution, values, culture, memo,
 *    caps), the operating system, tunables, the boundary table, envelopes;
 *  - `org_people`: the org chart, units, human employees, one member;
 *  - `org_task`: one task in full (brief, blocker, steps, checks, timeline);
 *  - `org_meetings`: upcoming meetings and rituals, recent ones, minutes, cadences;
 *  - `org_approvals`: decision cards, pending and decided (approvals history).
 *
 * Scope (§4 of the doc): the chief sees everything; a member sees
 * company-level information, its own unit (a lead: its unit's subtree) and
 * private details (scopes, model, budget) only of itself and of members who
 * report to it, climbing. Secrets never appear: no connection tokens, no
 * emails or account ids of people, no agent memory.
 */
import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ChatSession } from '../chats/chats.repository';
import { TurnLoopService, type ToolProviderHook } from '../chats/turn-loop.service';
import type { AiToolSpec } from '../ai/ai-provider.interface';
import { AgentsService } from '../agents/agents.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { OrgService, type Organization, type OrgMember } from './org.service';
import { OrgUnitsService } from './org-units.service';
import { OrgTasksService, parseBrief } from './org-tasks.service';
import { OrgMeetingsService, nextCronAfter, parseMinutes, type OrgMeeting } from './org-meetings.service';
import { OrgApprovalsService } from './org-approvals.service';
import { OrgRuntimeService } from './org-runtime.service';
import { describeTunables } from './org-tunables';
import { describeBoundary } from './boundary';
import { diagnoseProfile } from './chief-os';
import { parseRouting } from './org-routing';
import { describeBlockedOn, parseBlockedOn } from './blocked-on';
import { parseSteps } from './work-model';
import { taskRef } from '../common/task-keys';
import { PAGE_PROPS, clip, matches, pageOf } from '../common/data-page';
import { claimTag } from './claims-model';

const ORG = { type: 'string' } as const;

const TOOLS: AiToolSpec[] = [
  { name: 'org_company', description: 'The company (read-only). view: profile (mode, mission, rules, values, culture, memo, caps) | os (stage, culture type, norms, rituals, routing) | tunables (with bounds) | boundary (what agents may change alone / by experiment / by proposal / never) | budgets (envelopes you may see).', inputSchema: { type: 'object', properties: { view: { type: 'string', enum: ['profile', 'os', 'tunables', 'boundary', 'budgets'] }, ...PAGE_PROPS, org: ORG } } },
  { name: 'org_people', description: 'Who is who (read-only). view: chart (members, titles, units, managers) | units | humans (titles and roles only) | member (one by name; scopes, model, budget only for you and your reports).', inputSchema: { type: 'object', properties: { view: { type: 'string', enum: ['chart', 'units', 'humans', 'member'] }, member: { type: 'string' }, unit: { type: 'string', description: 'Name or #slug.' }, ...PAGE_PROPS, org: ORG } } },
  { name: 'org_task', description: 'One task in full (read-only): brief, owner, project, blocker, steps, checks, timeline of transitions and comments (limit caps it).', inputSchema: { type: 'object', properties: { task: { type: 'string', description: 'Key, e.g. ENG-12.' }, limit: { type: 'number' }, org: ORG }, required: ['task'] } },
  { name: 'org_meetings', description: 'Meetings (read-only) of the company and your unit (a lead: its subtree; the chief: all). view: upcoming | recent | minutes (meeting: id) | cadences.', inputSchema: { type: 'object', properties: { view: { type: 'string', enum: ['upcoming', 'recent', 'minutes', 'cadences'] }, meeting: { type: 'string' }, unit: { type: 'string' }, ...PAGE_PROPS, org: ORG } } },
  { name: 'org_approvals', description: 'Decision cards, pending and decided (read-only history): yours, those that passed through you and your reports\'; the chief all.', inputSchema: { type: 'object', properties: { status: { type: 'string', enum: ['pending', 'decided', 'all'] }, kind: { type: 'string', description: 'e.g. hire, escalation.' }, ...PAGE_PROPS, org: ORG } } },
];
const NAMES = new Set(TOOLS.map((t) => t.name));
export const ORG_DATA_TOOL_NAMES: readonly string[] = TOOLS.map((t) => t.name);

/** Who is reading, and what they may see. */
interface Viewer {
  org: Organization;
  agentId: string;
  isChief: boolean;
  members: OrgMember[];
  names: Map<string, string>;
  /** Units whose items this viewer reads (company-level root included). */
  units: Set<string>;
  /** Members whose private details this viewer reads (itself and its reports, climbing). */
  line: Set<string>;
  /** The company-level unit (its items are everyone's). */
  rootUnitId: string | null;
}

@Injectable()
export class OrgDataTools implements ToolProviderHook {
  constructor(
    private readonly org: OrgService,
    private readonly units: OrgUnitsService,
    private readonly tasks: OrgTasksService,
    private readonly meetings: OrgMeetingsService,
    private readonly approvals: OrgApprovalsService,
    private readonly agents: AgentsService,
    private readonly config: ConfigService,
    @Optional() private readonly workspaces?: WorkspacesService,
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
    if (ctx?.audit || ctx?.aux) return [];
    return (await this.memberships(session.agentId)).length ? [...TOOLS] : [];
  }

  owns(name: string): boolean { return NAMES.has(name); }
  isReadOnly(name: string): boolean { return NAMES.has(name); }
  async contextFor(): Promise<string | null> { return null; }

  async execute(session: ChatSession, name: string, input: Record<string, unknown>): Promise<string> {
    if (!this.enabled()) throw new Error('organizations are disabled on this server');
    const v = await this.viewer(session.agentId!, input.org);
    switch (name) {
      case 'org_company': return this.company(v, input);
      case 'org_people': return this.people(v, input);
      case 'org_task': return this.task(v, input);
      case 'org_meetings': return this.meetingsView(v, input);
      case 'org_approvals': return this.approvalsView(v, input);
    }
    throw new Error(`unknown tool: ${name}`);
  }

  // ---- scope ----

  private async viewer(agentId: string, hint: unknown): Promise<Viewer> {
    const ms = await this.memberships(agentId);
    if (ms.length === 0) throw new Error('you do not belong to an organization');
    let org: Organization | null = null;
    if (typeof hint === 'string' && hint.trim()) {
      const q = hint.trim().toLowerCase();
      for (const m of ms) { const o = await this.org.get(m.orgId).catch(() => null); if (o && (o.id === q || o.id.startsWith(q) || o.name.toLowerCase() === q)) org = o; }
      if (!org) throw new Error(`no organization "${hint}"`);
    } else {
      if (ms.length > 1) throw new Error(`you belong to ${ms.length} organizations — pass org: <name>`);
      org = await this.org.get(ms[0].orgId);
    }
    const members = (await this.org.members(org.id)).filter((m) => m.status !== 'terminated');
    const names = new Map((await this.agents.list()).map((a) => [a.id, a.name]));
    const isChief = org.chiefOfStaffAgentId === agentId;
    const all = await this.units.units(org.id);
    const units = new Set<string>();
    const line = new Set<string>([agentId]);
    if (isChief) { for (const u of all) units.add(u.id); for (const m of members) line.add(m.agentId); }
    else {
      const root = all.find((u) => u.parentUnitId === null);
      if (root) units.add(root.id);
      const home = await this.units.unitForAssignee(org.id, agentId).catch(() => null);
      if (home) units.add(home.id);
      const led = await this.units.ledBy(org.id, agentId);
      if (led) for (const id of await this.units.subtree(org.id, led.id)) units.add(id);
      // Reports, climbing: anyone whose chain of managers reaches this agent.
      const managerOf = new Map(members.map((m) => [m.agentId, m.reportsToAgentId]));
      for (const m of members) {
        let cur = m.reportsToAgentId;
        for (let i = 0; cur && i < 12; i++) { if (cur === agentId) { line.add(m.agentId); break; } cur = managerOf.get(cur) ?? null; }
      }
    }
    return { org, agentId, isChief, members, names, units, line, rootUnitId: all.find((u) => u.parentUnitId === null)?.id ?? null };
  }

  private nm(v: Viewer, id: string | null | undefined): string { return id ? v.names.get(id) ?? id.slice(0, 8) : 'nobody'; }

  private async unitRef(v: Viewer, ref: unknown): Promise<string | null> {
    const q = typeof ref === 'string' ? ref.trim().replace(/^#/, '').toLowerCase() : '';
    if (!q) return null;
    const u = (await this.units.units(v.org.id)).find((x) => x.slug.toLowerCase() === q || x.name.toLowerCase() === q || x.id === q || (q.length >= 6 && x.id.startsWith(q)));
    if (!u) throw new Error(`no unit "${String(ref)}" — org_people view units lists them`);
    return u.id;
  }

  // ---- org_company ----

  private async company(v: Viewer, input: Record<string, unknown>): Promise<string> {
    const o = v.org;
    const view = typeof input.view === 'string' ? input.view : 'profile';
    const ws = this.workspaces ? await this.workspaces.get(o.workspaceId).catch(() => null) : null;
    switch (view) {
      case 'profile': {
        return [
          `"${o.name}" — ${o.status}, ${ws?.orgMode ?? 'supervised'} mode${o.frozenClasses && o.frozenClasses !== '[]' ? `, frozen action classes ${o.frozenClasses}` : ''}.`,
          `Mission: ${o.mission || '(none)'}`,
          o.ceoUserNote ? `CEO note: ${clip(o.ceoUserNote, 800)}` : '',
          `Standing rules (constitution): ${o.rules ? clip(o.rules, 2_000) : '(none)'}`,
          `Values: ${o.values ? clip(o.values, 1_500) : '(none)'}`,
          `Culture: ${o.culture ? clip(o.culture, 1_500) : '(none)'}`,
          o.strategyMemo ? `Strategy memo (${o.strategyMemoAt?.slice(0, 10) ?? '?'}): ${clip(o.strategyMemo, 1_500)}` : 'Strategy memo: (none yet)',
          `Caps: depth ≤ ${o.maxDepth}, ≤ ${o.maxDirectReports} direct reports, ≤ ${ws?.orgAgentCap ?? 12} members, company envelope $${(ws?.orgMonthlyUsd || o.monthlyBudgetUsd).toFixed(2)}/month. Chief of staff: ${this.nm(v, o.chiefOfStaffAgentId)}. Daily brief at ${o.briefHour}:00.`,
          'More: org_intent (vision → objectives → key results), org_projects (roadmap), org_company view os | tunables | boundary | budgets.',
        ].filter(Boolean).join('\n');
      }
      case 'os': {
        const d = diagnoseProfile({ values: o.values, culture: o.culture, mission: o.mission, size: v.members.length });
        const routing = parseRouting(o.routing);
        const cad = await this.meetings.cadences(o.id).catch(() => []);
        const unitNames = new Map((await this.units.units(o.id)).map((u) => [u.id, u.name]));
        return [
          `Operating system of "${o.name}" (derived from the profile; the CEO's answers win): stage ${d.stage} (${d.stageWhy}), culture ${d.cultureType}; norms: ${[d.speed ? 'speed' : '', d.rigor ? 'rigour' : '', d.writing ? 'writing' : ''].filter(Boolean).join(', ') || 'none flagged'}.`,
          d.values.length ? `Values as mechanisms: ${d.values.slice(0, 8).map((x) => clip(x, 80)).join('; ')}` : '',
          `Rituals: ${cad.length ? cad.filter((c) => v.units.has(c.unitId)).map((c) => `${unitNames.get(c.unitId) ?? 'unit'} ${c.kind} ${c.enabled ? `"${c.cron}"` : 'off'}`).join('; ') || '(none in your units)' : '(none)'}`,
          `Model routing by task class: ${Object.entries(routing.classes).map(([k, t]) => `${k}→${t}`).join(', ') || 'defaults'}${Object.keys(routing.models).length ? `; tier models ${Object.entries(routing.models).map(([k, m]) => `${k}=${m}`).join(', ')}` : ''}.`,
          'The ledger lives in /org/ (its README.md says what lives where). Tunables: org_company view tunables.',
        ].filter(Boolean).join('\n');
      }
      case 'tunables': {
        const rows = describeTunables(o).filter((t) => matches(input.q, t.key, t.area, t.description))
          .map((t) => `- ${t.key} = ${t.value}${t.stored === null ? ' (default)' : ''} [${t.min}–${t.max}] ${t.area}: ${clip(t.description, 140)}`);
        return pageOf(rows, input, { def: 25, max: 80, header: `Tunables (${rows.length}${typeof input.q === 'string' && input.q ? ` matching "${input.q}"` : ''}); the chief changes one with org_tune within its bound.`, empty: `No tunable matches "${String(input.q ?? '')}".` });
      }
      case 'boundary': {
        const rows = describeBoundary().filter((r) => matches(input.q, r.id, r.kind, r.match, r.verdict))
          .map((r) => `- ${r.id}: ${r.verdict.toUpperCase()} — ${r.match} (${clip(r.reason, 140)})`);
        return pageOf(rows, input, { def: 25, max: 60, header: 'The self-modification boundary: alone = an agent may act within caps; experiment = only as a measured experiment; propose = a card for the CEO; never = no agent.' });
      }
      case 'budgets': {
        const budgets = await this.org.budgets(o.id);
        const allocations = await this.org.allocations(o.id);
        const goals = new Map((await this.org.goals(o.id)).map((g) => [g.id, g]));
        const projects = new Map((await this.org.projects(o.id)).map((p) => [p.id, p]));
        const seesProject = (pid: string) => { const p = projects.get(pid); return v.isChief || Boolean(p && ((p.ownerAgentId && v.line.has(p.ownerAgentId)) || (p.unitId && p.unitId !== v.rootUnitId && v.units.has(p.unitId)))); };
        const rows: string[] = [];
        rows.push(`- company: $${(ws?.orgMonthlyUsd || o.monthlyBudgetUsd).toFixed(2)}/month envelope (the CEO's)`);
        for (const b of budgets) {
          if (b.scope === 'agent' && !v.line.has(b.refId)) continue;
          if (b.scope === 'project' && !seesProject(b.refId)) continue;
          if (b.scope === 'company') continue;
          const label = b.scope === 'agent' ? `agent ${this.nm(v, b.refId)}` : `project ${projects.get(b.refId)?.key ?? b.refId.slice(0, 8)} ${clip(projects.get(b.refId)?.title, 60)}`;
          rows.push(`- ${label}: $${b.monthlyUsd.toFixed(2)}/month, spent $${b.spentUsd.toFixed(2)} this month`);
        }
        for (const a of allocations) {
          if (!v.isChief && !(a.unitId && v.units.has(a.unitId)) && !(a.scope === 'agent' && a.refId && v.line.has(a.refId))) continue;
          rows.push(`- objective ${clip(goals.get(a.goalId)?.title ?? a.goalId.slice(0, 8), 60)}: $${a.monthlyUsd.toFixed(2)}/month${a.scope && a.refId ? ` via ${a.scope} ${a.scope === 'agent' ? this.nm(v, a.refId) : a.refId.slice(0, 8)}` : ''}${a.rationale ? ` — ${clip(a.rationale, 100)}` : ''}`);
        }
        return pageOf(rows, input, { def: 30, max: 80, header: `Envelopes you may see${v.isChief ? ' (all)' : ' (the company, yourself, your reports and your unit)'}. Spend by outcome: org_costs; the month-end projection: org_forecast.` });
      }
    }
    throw new Error('view must be profile | os | tunables | boundary | budgets');
  }

  // ---- org_people ----

  private async people(v: Viewer, input: Record<string, unknown>): Promise<string> {
    const view = typeof input.view === 'string' ? input.view : (typeof input.member === 'string' && input.member ? 'member' : 'chart');
    const allUnits = await this.units.units(v.org.id);
    const unitOfLead = new Map(allUnits.map((u) => [u.leadAgentId, u]));
    const homeOf = async (agentId: string) => unitOfLead.get(agentId) ?? await this.units.unitForAssignee(v.org.id, agentId).catch(() => null);
    const unitFilter = await this.unitRef(v, input.unit);
    const inUnit = unitFilter ? new Set(await this.units.subtree(v.org.id, unitFilter)) : null;
    switch (view) {
      case 'chart': {
        // Depth-first from the top so the reporting lines read as a tree.
        const byManager = new Map<string | null, OrgMember[]>();
        for (const m of v.members) { const k = m.reportsToAgentId && v.members.some((x) => x.agentId === m.reportsToAgentId) ? m.reportsToAgentId : null; byManager.set(k, [...(byManager.get(k) ?? []), m]); }
        const rows: string[] = [];
        const walk = async (k: string | null, depth: number) => {
          for (const m of (byManager.get(k) ?? []).sort((a, b) => this.nm(v, a.agentId).localeCompare(this.nm(v, b.agentId)))) {
            const u = await homeOf(m.agentId);
            if ((!inUnit || (u && inUnit.has(u.id))) && matches(input.q, this.nm(v, m.agentId), m.title)) {
              rows.push(`${'  '.repeat(depth)}- ${this.nm(v, m.agentId)} — ${m.title || 'member'}${m.agentId === v.org.chiefOfStaffAgentId ? ' (chief of staff)' : ''}${u ? ` [#${u.slug}]` : ''}${m.status !== 'active' ? ` (${m.status})` : ''}${m.agentId === v.agentId ? ' ← you' : ''}`);
            }
            if (depth < 10) await walk(m.agentId, depth + 1);
          }
        };
        await walk(null, 0);
        const humans = (await this.org.humans(v.org.id)).length;
        return pageOf(rows, input, { def: 40, max: 120, header: `Org chart of "${v.org.name}": ${v.members.length} member(s)${humans ? `, ${humans} human(s) (view humans)` : ''}. Indentation = reports to.`, empty: 'No member matches.' });
      }
      case 'units': {
        const tree = await this.units.unitTree(v.org.id);
        const rows: string[] = [];
        const walk = (nodes: typeof tree, depth: number) => { for (const n of nodes) { if ((!inUnit || inUnit.has(n.id)) && matches(input.q, n.name, n.slug)) rows.push(`${'  '.repeat(depth)}- ${n.name} #${n.slug} — lead ${this.nm(v, n.leadAgentId)}, ${n.memberAgentIds.length} member(s)${n.memberHumanIds.length ? ` + ${n.memberHumanIds.length} human(s)` : ''}, ${n.counts.openTasks} open task(s), ${n.counts.goals} goal(s)${v.units.has(n.id) ? '' : ' (outside your unit)'}`); walk(n.children, depth + 1); } };
        walk(tree, 0);
        return pageOf(rows, input, { def: 30, max: 80, header: 'Units (a unit = a lead and its reports; indentation = parent).' });
      }
      case 'humans': {
        const rows = (await this.org.humans(v.org.id)).filter((h) => matches(input.q, h.title, h.role))
          .map((h) => `- ${h.title || 'Untitled'} — ${h.role}${h.reportsToAgentId ? `, reports to ${this.nm(v, h.reportsToAgentId)}` : ''}`);
        return pageOf(rows, input, { header: 'Human employees and board members (titles and roles only; contact details stay private). The workspace owner is the CEO.', empty: 'No humans besides the CEO (the workspace owner).' });
      }
      case 'member': {
        const q = typeof input.member === 'string' ? input.member.trim().toLowerCase() : '';
        if (!q) throw new Error('view member needs member: <name>');
        const m = v.members.find((x) => this.nm(v, x.agentId).toLowerCase() === q || x.agentId === q || (q.length >= 6 && x.agentId.startsWith(q)));
        if (!m) throw new Error(`no member "${String(input.member)}" — org_people view chart lists them`);
        const u = await homeOf(m.agentId);
        const reports = v.members.filter((x) => x.reportsToAgentId === m.agentId);
        const open = (await this.tasks.openTasksOf(v.org.id, m.agentId).catch(() => [])).slice(0, 8);
        const lines = [
          `${this.nm(v, m.agentId)} — ${m.title || 'member'} (${m.status})${m.agentId === v.org.chiefOfStaffAgentId ? ', chief of staff' : ''}${u ? `, unit ${u.name} #${u.slug}` : ''}; reports to ${m.reportsToAgentId ? this.nm(v, m.reportsToAgentId) : m.reportsToHumanId ? 'a human' : 'the CEO'}; joined ${m.joinedAt.slice(0, 10)}.`,
          `Direct reports: ${reports.length ? reports.map((r) => `${this.nm(v, r.agentId)} (${r.title || 'member'})`).join(', ') : 'none'}.`,
          `Open work (${open.length}): ${open.length ? open.map((t) => `${taskRef(t)} ${clip(t.title, 60)} (${t.status})`).join('; ') : 'none'}.`,
        ];
        if (v.line.has(m.agentId)) {
          const a = await this.agents.get(m.agentId).catch(() => null);
          const budget = await this.org.budget(v.org.id, 'agent', m.agentId).catch(() => null);
          lines.push(`Scopes: ${this.org.scopesOf(m).join(', ') || 'none'}.`, `Model: ${a ? `${a.provider}/${a.model || 'default'}` : '?'}. Budget: ${budget ? `$${budget.monthlyUsd.toFixed(2)}/month, spent $${budget.spentUsd.toFixed(2)}` : 'no own envelope'}.`);
        } else lines.push('Scopes, model and budget: visible to its managers and the chief.');
        lines.push('Live status (working, blocked, idle): ws_agents.');
        return lines.join('\n');
      }
    }
    throw new Error('view must be chart | units | humans | member');
  }

  // ---- org_task ----

  private async task(v: Viewer, input: Record<string, unknown>): Promise<string> {
    const ref = typeof input.task === 'string' ? input.task.trim() : '';
    if (!ref) throw new Error('task is required (its key, e.g. ENG-12)');
    const t = await this.tasks.byPrefix(v.org.id, ref).catch(() => { throw new Error(`no task "${ref}" — org_read_board lists them`); });
    const b = parseBrief(t.brief);
    const project = t.projectId ? await this.org.project(v.org.id, t.projectId).catch(() => null) : null;
    const blocked = parseBlockedOn(t.blockedOn);
    const steps = parseSteps(t.steps);
    const checks = this.tasks.checksOf(t);
    const deps = (() => { try { return JSON.parse(t.dependsOn || '[]') as string[]; } catch { return []; } })();
    const depRows = await Promise.all(deps.slice(0, 8).map((id) => this.tasks.get(v.org.id, id).catch(() => null)));
    const limit = Math.min(50, Math.max(1, Number(input.limit) || 15));
    const transitions = (await this.tasks.transitions(v.org.id, t.id)).map((x) => ({ at: x.at, line: `${x.at.slice(0, 16).replace('T', ' ')} ${x.fromStatus ?? '∅'} → ${x.toStatus} by ${this.actorName(v, x.actor)}${x.reason ? ` — ${clip(x.reason, 120)}` : ''}` }));
    const msgs = await this.tasks.messages(v.org.id, { taskId: t.id, limit: 50 });
    // Evidence-gated claims (docs/evidence.md): an update nothing verified says so where it is read.
    const flags = await this.tasks.evidence?.flags(v.org.id, 'task_comment', msgs.map((m) => m.id)).catch(() => null);
    const comments = msgs.map((m) => ({ at: m.createdAt, line: `${m.createdAt.slice(0, 16).replace('T', ' ')} ${m.fromAgentId ? this.nm(v, m.fromAgentId) : 'system'}: ${clip(m.text, 240)}${flags?.has(m.id) ? ` ${claimTag(flags.get(m.id))}` : ''}` }));
    const timeline = [...transitions, ...comments].sort((a, b2) => a.at.localeCompare(b2.at)).slice(-limit);
    return [
      `${taskRef(t)} ${t.title} — ${t.status}${t.class ? `, class ${t.class}` : ''}${t.source ? `, source ${t.source}` : ''}`,
      `Owner: ${t.assigneeAgentId ? this.nm(v, t.assigneeAgentId) : t.assigneeHumanId ? 'a human employee' : 'unassigned'}; reviewer: ${t.reviewerAgentId ? this.nm(v, t.reviewerAgentId) : t.reviewerHumanId ? 'a human' : 'none'}; project: ${project ? `${project.key ?? project.id.slice(0, 8)} ${project.title}` : 'none'}${t.dueAt ? `; due ${t.dueAt.slice(0, 10)}` : ''}.`,
      `- Outcome: ${b.outcome || '(not stated)'}`,
      b.context ? `- Context: ${clip(b.context, 600)}` : '',
      b.constraints ? `- Constraints: ${clip(b.constraints, 400)}` : '',
      `- Done when: ${b.done_when || '(not stated)'}`,
      blocked ? `Blocked: ${describeBlockedOn(blocked, (_k, r) => v.names.get(r) ?? r)}` : '',
      depRows.filter(Boolean).length ? `Depends on: ${depRows.filter((d): d is NonNullable<typeof d> => Boolean(d)).map((d) => `${taskRef(d)} (${d.status})`).join(', ')}` : '',
      steps.length ? `Steps: ${steps.map((s) => `${s.id} ${s.done ? '✓' : '○'} ${clip(s.text, 80)}`).join('; ')}` : '',
      checks.length ? `Checks: ${checks.length} (org_task_checks runs them)` : '',
      `Timeline (${timeline.length} of ${transitions.length + comments.length}):`,
      ...(timeline.length ? timeline.map((x) => `  ${x.line}`) : ['  (empty)']),
    ].filter(Boolean).join('\n');
  }

  private actorName(v: Viewer, actor: string): string {
    if (actor.startsWith('agent:')) return this.nm(v, actor.slice(6));
    if (actor === 'chief') return this.nm(v, v.org.chiefOfStaffAgentId);
    if (actor === 'user') return 'the CEO';
    return actor.startsWith('human:') ? 'a person' : actor || 'system';
  }

  // ---- org_meetings ----

  private async meetingsView(v: Viewer, input: Record<string, unknown>): Promise<string> {
    const view = typeof input.view === 'string' ? input.view : (typeof input.meeting === 'string' && input.meeting ? 'minutes' : 'upcoming');
    const unitNames = new Map((await this.units.units(v.org.id, { archived: true })).map((u) => [u.id, u]));
    const unitFilter = await this.unitRef(v, input.unit);
    const visible = (unitId: string | null) => !unitId || v.units.has(unitId);
    const keep = (unitId: string | null) => visible(unitId) && (!unitFilter || unitId === unitFilter);
    const where = (unitId: string | null) => (unitId ? `#${unitNames.get(unitId)?.slug ?? unitId.slice(0, 8)}` : 'company');
    const when = (m: OrgMeeting) => (m.scheduledFor ?? m.startedAt ?? m.createdAt).slice(0, 16).replace('T', ' ');
    switch (view) {
      case 'upcoming': {
        const now = new Date();
        const scheduled = (await this.meetings.list(v.org.id, { status: 'scheduled', limit: 200 })).filter((m) => keep(m.unitId) && matches(input.q, m.title, m.kind))
          .map((m) => ({ at: m.scheduledFor ?? m.createdAt, line: `- ${when(m)} ${m.title || m.kind} (${m.kind}, ${where(m.unitId)}) [${m.id.slice(0, 8)}]` }));
        const rituals = (await this.meetings.cadences(v.org.id)).filter((c) => c.enabled && keep(c.unitId) && matches(input.q, c.kind))
          .map((c) => { const next = c.nextRunAt ?? nextCronAfter(c.cron, now)?.toISOString() ?? null; return next ? { at: next, line: `- ${next.slice(0, 16).replace('T', ' ')} ${c.kind} ritual (${where(c.unitId)}, "${c.cron}")` } : null; })
          .filter((x): x is { at: string; line: string } => Boolean(x));
        const rows = [...scheduled, ...rituals].sort((a, b) => a.at.localeCompare(b.at)).map((x) => x.line);
        return pageOf(rows, input, { header: 'Upcoming meetings and ritual fires (server time); meeting_propose_agenda adds an item to one you attend.', empty: 'Nothing scheduled in your units.' });
      }
      case 'recent': {
        const rows = (await this.meetings.list(v.org.id, { limit: 200 })).filter((m) => m.status !== 'scheduled' && keep(m.unitId) && matches(input.q, m.title, m.kind))
          .sort((a, b) => when(b).localeCompare(when(a)))
          .map((m) => { const mins = parseMinutes(m.minutes); return `- ${when(m)} ${m.title || m.kind} (${m.status}, ${where(m.unitId)}) [${m.id.slice(0, 8)}]${mins.summary ? ` — ${clip(mins.summary, 160)}` : ''}${mins.decisions.length ? `; ${mins.decisions.length} decision(s)` : ''}${mins.actions.length ? `, ${mins.actions.length} action(s)` : ''}`; });
        return pageOf(rows, input, { header: 'Recent meetings, newest first; view minutes with meeting: <id> for the full record.', empty: 'No meetings held in your units yet.' });
      }
      case 'minutes': {
        const ref = typeof input.meeting === 'string' ? input.meeting.trim() : '';
        if (!ref) throw new Error('view minutes needs meeting: <id>');
        const m = (await this.meetings.list(v.org.id, { limit: 500 })).find((x) => x.id === ref || (ref.length >= 6 && x.id.startsWith(ref)));
        if (!m) throw new Error(`no meeting "${ref}" — org_meetings view recent lists them`);
        if (!visible(m.unitId)) throw new Error(`not visible to you: that meeting belongs to ${where(m.unitId)}; its members, its leads and the chief read its minutes`);
        const mins = parseMinutes(m.minutes);
        const body = this.meetings.renderMinutes(m, mins, v.names);
        return [`${m.title || m.kind} — ${m.status}, ${where(m.unitId)}, ${when(m)}${m.minutesPath ? `; file ${m.minutesPath}` : ''}`, body].join('\n');
      }
      case 'cadences': {
        const rows = (await this.meetings.cadences(v.org.id)).filter((c) => keep(c.unitId) && matches(input.q, c.kind))
          .map((c) => `- ${where(c.unitId)} ${c.kind}: ${c.enabled ? `"${c.cron}"` : 'off'}; last ${c.lastRunAt?.slice(0, 16) ?? 'never'}, next ${c.nextRunAt?.slice(0, 16) ?? '?'}`);
        return pageOf(rows, input, { header: 'Ritual cadences (cron, server time); the chief or the unit lead changes one with org_set_cadence.', empty: 'No cadences in your units.' });
      }
    }
    throw new Error('view must be upcoming | recent | minutes | cadences');
  }

  // ---- org_approvals ----

  private async approvalsView(v: Viewer, input: Record<string, unknown>): Promise<string> {
    const status = typeof input.status === 'string' ? input.status : 'all';
    const kind = typeof input.kind === 'string' ? input.kind.trim() : '';
    const me = `agent:${v.agentId}`;
    const requester = (r: string) => (r.startsWith('agent:') ? r.slice(6) : r === 'chief' ? v.org.chiefOfStaffAgentId : null);
    const rows = (await this.approvals.list(v.org.id))
      .filter((a) => (status === 'all' ? true : status === 'pending' ? a.status === 'pending' : a.status !== 'pending'))
      .filter((a) => !kind || a.kind === kind)
      .filter((a) => {
        if (v.isChief) return true;
        const by = requester(a.requestedBy);
        if (by && v.line.has(by)) return true;
        return a.holder === me || (a.chain ?? '').includes(me);
      })
      .filter((a) => matches(input.q, a.kind, a.recommendation, a.decisionNote, a.payload))
      .sort((a, b) => (b.decidedAt ?? b.createdAt).localeCompare(a.decidedAt ?? a.createdAt))
      .map((a) => {
        const title = (() => { try { const p = JSON.parse(a.payload) as Record<string, unknown>; return String(p.title ?? p.name ?? p.reason ?? p.why ?? '').slice(0, 100); } catch { return ''; } })();
        const holder = a.holder.startsWith('agent:') ? this.nm(v, a.holder.slice(6)) : a.holder.startsWith('human:') ? 'a person' : 'the CEO';
        const by = requester(a.requestedBy);
        return `- [${a.id.slice(0, 8)}] ${a.kind}${title ? `: ${clip(title, 100)}` : ''} — asked by ${by ? this.nm(v, by) : a.requestedBy || 'system'} ${a.createdAt.slice(0, 10)}; ${a.status === 'pending' ? `pending with ${holder}` : `${a.status} ${a.decidedAt?.slice(0, 10) ?? ''}${a.decidedVia ? ` (${a.decidedVia.split(':')[0]})` : ''}`}${a.recommendation ? `; rec: ${clip(a.recommendation, 100)}` : ''}${a.decisionNote ? `; note: ${clip(a.decisionNote, 120)}` : ''}`;
      });
    return pageOf(rows, input, { header: `Decision cards you may see${v.isChief ? ' (all)' : ' (yours, those that passed through you, and your reports\')'}, newest first.`, empty: 'No decision cards you may see match.' });
  }
}
