/**
 * Workspace data as read tools (docs/agent-data-access.md): what an agent
 * may know about the workspace it belongs to, whether or not the workspace
 * runs a company. All are class `read`; none writes.
 *
 *  - `ws_catalog`: discovery — every data domain, the tools that read it and
 *    the tools that change it, marked by whether this agent holds them;
 *  - `ws_workspace`: profile, people (names and roles only), usage, the
 *    agent's own connection grants, the skills it can load;
 *  - `ws_agents`: the agents directory with the shared live status
 *    (home/agent-status.ts — the same state Home and mission control show);
 *  - `ws_market`: the market — packs, connectors, the registry;
 *  - `ws_plugins`: installed plugins, interfaces, providers, bindings,
 *    conformance and the first-party catalog.
 *
 * Scope: the agent's own workspace only (agents never cross workspaces).
 * Never secrets (connection tokens, account emails), never another agent's
 * memory, lessons or private skills; in a company the per-agent usage split
 * is the chief's (others see the totals and their own row).
 */
import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { agentTasks, workspaceMembers } from '../database/schema';
import type { LoopDef } from '../chats/loop-def';
import type { ChatSession } from '../chats/chats.repository';
import { TurnLoopService, type ToolProviderHook } from '../chats/turn-loop.service';
import type { AiToolSpec } from '../ai/ai-provider.interface';
import { ProviderHealthService } from '../ai/provider-health';
import { AgentsService } from '../agents/agents.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { SkillsService } from '../skills/skills.service';
import { ConnectionsService } from '../connections/connections.service';
import { UsageService } from '../usage/usage.module';
import { PluginsService } from '../plugins/plugins.service';
import { RegistryService } from '../registry/registry.service';
import { OrgService, type Organization } from '../org/org.service';
import { OrgTasksService, type OrgTask } from '../org/org-tasks.service';
import { OrgUnitsService } from '../org/org-units.service';
import { agentStatuses, sortTeam } from '../home/agent-status';
import { AUTHORED_PACKS } from '../market/authored-packs.generated';
import { PROFESSION_PACKS } from '../market/profession-packs.generated';
import { CONNECTORS } from '../market/connectors.catalog';
import { orgHireRef, segmentOf } from '../market/segments';
import { spendStatus } from '../workspaces/spend.util';
import { actorId } from '../accounts/account-context';
import { PAGE_PROPS, clip, matches, pageOf } from '../common/data-page';
import { effectivePersonality } from '../agents/personalities';

const PACKS = [...AUTHORED_PACKS, ...PROFESSION_PACKS];

const TOOLS: AiToolSpec[] = [
  { name: 'ws_catalog', description: 'What data can I query? Every data domain with the tools that read and change it, marked by whether you hold them. Start here.', inputSchema: { type: 'object', properties: { domain: { type: 'string' } } } },
  { name: 'ws_workspace', description: 'This workspace (read-only). view: profile | people (names, roles) | usage (days) | connections (your grants) | skills (yours and shared).', inputSchema: { type: 'object', properties: { view: { type: 'string', enum: ['profile', 'people', 'usage', 'connections', 'skills'] }, days: { type: 'number' }, ...PAGE_PROPS } } },
  { name: 'ws_agents', description: 'Agents directory (read-only): role, model, live status (working / blocked on what / idle / paused / error), current work. agent: one by name.', inputSchema: { type: 'object', properties: { agent: { type: 'string' }, state: { type: 'string', enum: ['working', 'blocked', 'idle', 'paused', 'error'] }, ...PAGE_PROPS } } },
  { name: 'ws_market', description: 'The market (read-only). view: packs (function filter) | pack (id) | connectors | registry (kind).', inputSchema: { type: 'object', properties: { view: { type: 'string', enum: ['packs', 'pack', 'connectors', 'registry'] }, id: { type: 'string' }, function: { type: 'string' }, kind: { type: 'string', enum: ['agent', 'skill', 'app', 'company'] }, ...PAGE_PROPS } } },
  { name: 'ws_plugins', description: 'Plugins (read-only). view: installed | interfaces (operations, classes, providers, bindings) | catalog | plugin (id: conformance, your grant).', inputSchema: { type: 'object', properties: { view: { type: 'string', enum: ['installed', 'interfaces', 'catalog', 'plugin'] }, id: { type: 'string' }, ...PAGE_PROPS } } },
];
const NAMES = new Set(TOOLS.map((t) => t.name));
export const WS_DATA_TOOL_NAMES: readonly string[] = TOOLS.map((t) => t.name);

/** The data map ws_catalog prints (docs/agent-data-access.md §2): a domain,
 *  the tools that read it, the tools that change it. A tool listed here and
 *  not offered to the agent is shown as someone else's. */
export const DATA_DOMAINS: Array<{ domain: string; about: string; read: string[]; write: string[] }> = [
  { domain: 'workspace', about: 'name, mode, quiet hours, budget, the humans', read: ['ws_workspace'], write: ['update_user_profile'] },
  { domain: 'usage', about: 'tokens and cost; company spend by outcome, forecast, pulse', read: ['ws_workspace', 'org_costs', 'org_forecast', 'org_pulse'], write: ['org_allocate_budget'] },
  { domain: 'agents', about: 'the agents directory and live status', read: ['ws_agents', 'org_people', 'org_capacity'], write: ['delegate_task', 'org_update_member'] },
  { domain: 'connections', about: 'services granted to you and their context cards', read: ['ws_workspace'], write: [] },
  { domain: 'skills', about: 'skills you can load (skill_* tools), playbooks', read: ['ws_workspace', 'org_playbooks'], write: ['draft_skill', 'revise_skill', 'org_write_playbook'] },
  { domain: 'market', about: 'agent packs, connectors, the registry, the role catalog', read: ['ws_market', 'org_roles'], write: ['org_hire_agent'] },
  { domain: 'plugins', about: 'plugins, interfaces, providers, bindings, conformance, change records', read: ['ws_plugins', 'change_list', 'change_status'], write: ['change_request_apply'] },
  { domain: 'company', about: 'mode, mission, constitution, values, culture, operating system, tunables, boundary, envelopes', read: ['org_company'], write: ['org_tune', 'org_set_routing', 'org_strategy_memo', 'org_allocate_budget'] },
  { domain: 'vision', about: 'vision → objectives → key results, check-ins, why a task exists', read: ['org_intent', 'org_why', 'org_read_goal'], write: ['org_set_goal', 'org_set_key_result', 'org_check_in'] },
  { domain: 'projects', about: 'the roadmap, a project, milestones, health updates', read: ['org_projects', 'org_project'], write: ['org_create_project', 'org_update_project', 'org_project_update', 'org_milestone', 'org_project_appetite', 'org_link_task'] },
  { domain: 'tasks', about: 'the board, one task with its timeline, a unit\'s board, your own kanban', read: ['org_read_board', 'org_task', 'org_unit_report', 'list_tasks'], write: ['org_create_task', 'org_task_update', 'org_task_comment', 'org_task_steps', 'org_assign', 'org_request_review', 'org_review', 'add_task', 'update_task'] },
  { domain: 'people', about: 'org chart, units, reporting lines, human employees, structure review', read: ['org_people', 'org_review_structure'], write: ['org_hire_agent', 'org_reorg', 'org_set_scope', 'org_pause_agent', 'org_terminate_agent'] },
  { domain: 'channels', about: 'group-chat channels and threads', read: ['channel_list', 'channel_read'], write: ['channel_post', 'channel_make_task'] },
  { domain: 'meetings', about: 'upcoming meetings, minutes, ritual cadences', read: ['org_meetings'], write: ['meeting_propose_agenda', 'org_set_cadence'] },
  { domain: 'decisions', about: 'the decision log, cards waiting on you, the approvals history', read: ['org_decisions', 'org_decision_queue', 'org_approvals'], write: ['org_decide', 'org_escalate'] },
  { domain: 'signals', about: 'signals, the pulse, metric sources and samples', read: ['org_signals', 'org_pulse', 'org_metric_sources', 'org_metric_read'], write: ['org_ack_signal', 'org_propose_metric_source'] },
  { domain: 'incidents', about: 'incidents and their containment', read: ['org_incidents'], write: ['org_report_incident'] },
  { domain: 'experiments', about: 'experiments, predictions and calibration, golden sets', read: ['org_experiments', 'org_calibration', 'org_eval_cases'], write: ['org_propose_experiment', 'org_forecast_outcome', 'org_eval_role'] },
  { domain: 'memory', about: 'what the company knows (cited), your past conversations', read: ['org_recall', 'search_history'], write: [] },
  { domain: 'audit', about: 'the hash-chained audit log', read: ['org_audit_query'], write: [] },
  { domain: 'follows', about: 'what you follow', read: ['list_follows'], write: ['follow', 'unfollow'] },
  { domain: 'files', about: 'the workspace filesystem (ledger in /org/, mirrored playbooks and minutes)', read: ['fs_list', 'fs_read', 'fs_search'], write: ['fs_write', 'fs_edit', 'fs_append'] },
  { domain: 'owner', about: 'writing to your owner directly', read: [], write: ['message_owner'] },
];

interface Ctx { workspaceId: string; agentId: string; org: Organization | null; isChief: boolean; manages: boolean }

@Injectable()
export class WorkspaceDataTools implements ToolProviderHook {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly agents: AgentsService,
    private readonly workspaces: WorkspacesService,
    private readonly skills: SkillsService,
    private readonly config: ConfigService,
    @Optional() private readonly turns?: TurnLoopService,
    @Optional() private readonly connections?: ConnectionsService,
    @Optional() private readonly usage?: UsageService,
    @Optional() private readonly plugins?: PluginsService,
    @Optional() private readonly registry?: RegistryService,
    @Optional() private readonly org?: OrgService,
    @Optional() private readonly tasks?: OrgTasksService,
    @Optional() private readonly units?: OrgUnitsService,
    @Optional() private readonly health?: ProviderHealthService,
  ) {
    turns?.addToolProvider(this);
  }

  private companiesOn(): boolean { return this.config.get<boolean>('companiesEnabled') !== false; }

  /** The agent's company in its own workspace (null outside one) and its standing. */
  private async ctx(session: ChatSession): Promise<Ctx> {
    const agentId = session.agentId!;
    const agent = await this.agents.get(agentId).catch(() => null);
    const workspaceId = agent?.workspaceId || session.workspaceId;
    let org: Organization | null = null;
    let isChief = false;
    let manages = false;
    if (this.org && this.companiesOn()) {
      const ws = await this.workspaces.get(workspaceId).catch(() => null);
      const o = ws && ws.orgMode !== 'off' ? await this.org.byWorkspace(workspaceId).catch(() => null) : null;
      const member = o ? await this.org.member(o.id, agentId).catch(() => null) : null;
      if (o && member && member.status !== 'terminated') {
        org = o;
        isChief = o.chiefOfStaffAgentId === agentId;
        manages = isChief || (await this.org.members(o.id)).some((m) => m.reportsToAgentId === agentId && m.status !== 'terminated') || Boolean(this.units && await this.units.isLead(o.id, agentId));
      }
    }
    return { workspaceId, agentId, org, isChief, manages };
  }

  async specsFor(session: ChatSession): Promise<AiToolSpec[]> {
    if (!session.agentId) return [];
    const c = await this.ctx(session);
    // The market is for whoever staffs: the chief, managers and leads, and
    // agents outside a company (their owner hires from it with them).
    return TOOLS.filter((t) => t.name !== 'ws_market' || !c.org || c.manages)
      .filter((t) => t.name !== 'ws_plugins' || Boolean(this.plugins));
  }

  owns(name: string): boolean { return NAMES.has(name); }
  isReadOnly(name: string): boolean { return NAMES.has(name); }
  /** Outside a company: a small workspace briefing (docs/agent-data-access.md §7)
   *  — the workspace's name, the agent's open board tasks and its loops. A
   *  company member gets the company briefing (OrgBriefingService) instead. */
  async contextFor(session: ChatSession): Promise<string | null> {
    if (!session.agentId) return null;
    const c = await this.ctx(session);
    if (c.org) return null;
    return workspaceBriefing(this.db, this.agents, this.workspaces, c).catch(() => null);
  }

  async execute(session: ChatSession, name: string, input: Record<string, unknown>): Promise<string> {
    const c = await this.ctx(session);
    switch (name) {
      case 'ws_catalog': return this.catalog(session, input);
      case 'ws_workspace': return this.workspace(c, input);
      case 'ws_agents': return this.agentsView(c, input);
      case 'ws_market':
        if (c.org && !c.manages) throw new Error('ws_market is for the chief of staff, managers and unit leads; ask your manager for a hire');
        return this.market(c, input);
      case 'ws_plugins': return this.pluginsView(c, input);
    }
    throw new Error(`unknown tool: ${name}`);
  }

  // ---- ws_catalog ----

  private async catalog(session: ChatSession, input: Record<string, unknown>): Promise<string> {
    const offered = new Set(this.turns ? (await this.turns.offeredTools(session, actorId())).specs.map((t) => t.name) : []);
    const q = typeof input.domain === 'string' ? input.domain.trim().toLowerCase() : '';
    const domains = DATA_DOMAINS.filter((d) => !q || d.domain.includes(q) || d.about.toLowerCase().includes(q) || [...d.read, ...d.write].some((t) => t.includes(q)));
    if (domains.length === 0) return `No data domain matches "${q}". Domains: ${DATA_DOMAINS.map((d) => d.domain).join(', ')}.`;
    const lines = domains.map((d) => {
      const read = d.read.filter((t) => offered.has(t));
      const write = d.write.filter((t) => offered.has(t));
      if (read.length === 0 && write.length === 0) return `- ${d.domain} (${d.about}): not offered to you${d.read.length ? ` — ${d.read.join(', ')} belong to other roles` : ''}`;
      return `- ${d.domain} (${d.about}): read ${read.join(', ') || '—'}${write.length ? `; change ${write.join(', ')}` : ''}`;
    });
    return ['Data you can query (read tools run freely; changes follow your gates). Each read tool takes a `view` or filters and pages with limit/offset.', ...lines].join('\n');
  }

  // ---- ws_workspace ----

  private async workspace(c: Ctx, input: Record<string, unknown>): Promise<string> {
    const view = typeof input.view === 'string' ? input.view : 'profile';
    const ws = await this.workspaces.get(c.workspaceId);
    switch (view) {
      case 'profile': {
        const spend = spendStatus(ws);
        return [
          `Workspace "${ws.name}" — company mode ${ws.orgMode}${c.org ? ` ("${c.org.name}"; org_company has its profile)` : ''}.`,
          `Quiet hours: ${ws.quietHours || 'none'}.`,
          `Monthly token budget: ${spend.budgetTokens ? `${spend.spentTokens.toLocaleString('en-US')} of ${spend.budgetTokens.toLocaleString('en-US')} used in ${spend.month}${spend.over ? ' (reached: loops are refused)' : ''}` : `unlimited (${spend.spentTokens.toLocaleString('en-US')} used in ${spend.month})`}.`,
          ws.orgMode !== 'off' ? `Company caps: ≤ ${ws.orgAgentCap} members, $${ws.orgMonthlyUsd.toFixed(2)}/month envelope.` : '',
          'The workspace memory and what you know about the user are already in your instructions.',
        ].filter(Boolean).join('\n');
      }
      case 'people': {
        const rows = (await this.db.select({ role: workspaceMembers.role, displayName: workspaceMembers.displayName }).from(workspaceMembers).where(eq(workspaceMembers.workspaceId, c.workspaceId)))
          .filter((m) => matches(input.q, m.displayName, m.role))
          .map((m) => `- ${m.displayName || 'A member'} — ${m.role}`);
        return pageOf(['- The owner — owner', ...rows], input, { header: 'People in this workspace (names and roles; contact details stay private).' });
      }
      case 'usage': {
        if (!this.usage) throw new Error('usage is not available on this server');
        const days = Math.min(365, Math.max(1, Number(input.days) || 30));
        const u = await this.usage.workspaceUsage(c.workspaceId, days);
        const all = !c.org || c.isChief;
        const rows = u.byAgent.filter((a) => all || a.agentId === c.agentId).sort((a, b) => b.usd - a.usd)
          .map((a) => `- ${a.name}: $${a.usd.toFixed(2)}, ${(a.tokensIn + a.tokensOut).toLocaleString('en-US')} tokens, ${a.turns} turn(s)`);
        return [
          `Usage over ${u.days} day(s) (${u.from.slice(0, 10)} → ${u.to.slice(0, 10)}): $${u.totals.usd.toFixed(2)}, ${(u.totals.tokensIn + u.totals.tokensOut).toLocaleString('en-US')} tokens, ${u.totals.turns} turn(s)${u.unpricedModels.length ? `; unpriced models ${u.unpricedModels.join(', ')}` : ''}.`,
          `Budget ${u.budget.month}: ${u.budget.budgetTokens ? `${u.budget.spentTokens.toLocaleString('en-US')} of ${u.budget.budgetTokens.toLocaleString('en-US')} tokens` : 'unlimited'}.`,
          all ? 'By agent:' : 'Your share (the per-agent split is the chief\'s; company spend by outcome: org_costs):',
          pageOf(rows, input, { empty: '- nothing yet' }),
        ].join('\n');
      }
      case 'connections': {
        if (!this.connections) return 'No connections on this server.';
        const held = await this.connections.heldCards(c.agentId, actorId()).catch(() => []);
        if (held.length === 0) return 'You hold no connection grants. The owner grants a service (calendar, mail, drive) to you in the app; ws_market view connectors lists what can be connected.';
        return ['Connections granted to you (the tools appear as their own tools; tokens never reach you):', ...held.map((h) => `- ${h.card.title} (${h.card.provider || 'surface'} ${h.card.service}): ${h.level} — ${clip(h.card.summary, 140)}`)].join('\n');
      }
      case 'skills': {
        const rows = (await this.skills.list(c.workspaceId, c.agentId))
          .filter((s) => s.enabled === 1 && matches(input.q, s.name, s.description))
          .map((s) => `- skill_${s.name.replace(/-/g, '_')}${s.draft ? ' (draft, not loadable yet)' : ''} — ${s.agentId === c.agentId ? 'yours' : s.workspaceId ? 'shared in this workspace' : 'built in'}: ${clip(s.description, 140)}`);
        return pageOf(rows, input, { def: 30, max: 100, header: 'Skills you can load (call the skill_* tool for its instructions).', empty: 'No skills match.' });
      }
    }
    throw new Error('view must be profile | people | usage | connections | skills');
  }

  // ---- ws_agents ----

  private async agentsView(c: Ctx, input: Record<string, unknown>): Promise<string> {
    const agents = await this.agents.list({ workspaceId: c.workspaceId });
    const org = c.org ?? (this.org && this.companiesOn() ? await this.org.byWorkspace(c.workspaceId).catch(() => null) : null);
    const ws = await this.workspaces.get(c.workspaceId);
    const orgOn = Boolean(org && ws.orgMode !== 'off');
    const orgTasks: OrgTask[] = orgOn && org && this.tasks ? await this.tasks.list(org.id).catch(() => []) : [];
    const members = orgOn && org && this.org ? await this.org.members(org.id).catch(() => []) : [];
    const list = sortTeam(await agentStatuses({ db: this.db, agents: this.agents, providerHealth: this.health, tasks: this.tasks }, { workspaceId: c.workspaceId, org: orgOn ? org : null, orgOn, agents, orgTasks, members, now: new Date() }));
    const byId = new Map(agents.map((a) => [a.id, a]));
    const names = new Map(agents.map((a) => [a.id, a.name]));
    const ago = (at: string | null) => { if (!at) return 'never'; const m = Math.round((Date.now() - Date.parse(at)) / 60_000); return m < 60 ? `${m}m ago` : m < 2_880 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1_440)}d ago`; };
    const one = typeof input.agent === 'string' ? input.agent.trim().toLowerCase() : '';
    if (one) {
      const s = list.find((x) => x.name.toLowerCase() === one || x.id === one);
      if (!s) throw new Error(`no agent "${String(input.agent)}" in this workspace`);
      const a = byId.get(s.id)!;
      const loops = (() => { try { return (JSON.parse(a.loops || '[]') as Array<{ name?: string; cron?: string; enabled?: boolean }>).map((l) => `${l.name ?? 'loop'} "${l.cron ?? ''}"${l.enabled === false ? ' off' : ''}`); } catch { return []; } })();
      return [
        `${s.name} ${a.emoji} — ${s.title || a.role || 'agent'}${s.isChief ? ' (chief of staff)' : ''}; ${a.provider}/${a.model || 'default'}.`,
        `State: ${s.state}${s.doing ? ` — ${clip(s.doing, 160)}` : ''}; last active ${ago(s.lastActiveAt)}${s.open ? `; ${s.open} open task(s)` : ''}${s.reportsToAgentId ? `; reports to ${names.get(s.reportsToAgentId) ?? '?'}` : ''}.`,
        s.blocked.length ? `Blocked: ${s.blocked.map((b) => `${b.key ?? b.taskId.slice(0, 8)} on ${b.blocker.waitsOn.name || b.blocker.waitsOn.kind}${b.blocker.reason ? ` (${clip(b.blocker.reason, 100)})` : ''}`).join('; ')}` : '',
        s.errors.length ? `Errors: ${s.errors.map((e) => `${e.kind}: ${clip(redact(e.message), 140)}`).join('; ')}` : '',
        `Charter: ${clip(a.charter, 400) || '(none)'}`,
        `Personality: ${effectivePersonality(a)?.name ?? 'neutral'}.`,
        loops.length ? `Loops: ${loops.join(', ')}` : '',
        'Its memory, lessons and private skills stay its own.',
      ].filter(Boolean).join('\n');
    }
    const state = typeof input.state === 'string' ? input.state : '';
    const rows = list.filter((s) => (!state || s.state === state) && matches(input.q, s.name, s.title, byId.get(s.id)?.role))
      .map((s) => { const a = byId.get(s.id); return `- ${s.name} — ${s.title || a?.role || 'agent'}${s.isChief ? ' (chief)' : ''}, ${a?.provider ?? '?'}/${a?.model || 'default'}: ${s.state}${s.doing ? ` — ${clip(s.doing, 90)}` : ''} (active ${ago(s.lastActiveAt)})${s.id === c.agentId ? ' ← you' : ''}`; });
    return pageOf(rows, input, { def: 30, max: 100, header: `Agents of this workspace (${list.length}); agent: <name> for one.`, empty: 'No agent matches.' });
  }

  // ---- ws_market ----

  private async market(_c: Ctx, input: Record<string, unknown>): Promise<string> {
    const view = typeof input.view === 'string' ? input.view : (typeof input.id === 'string' && input.id ? 'pack' : 'packs');
    switch (view) {
      case 'packs': {
        const fn = typeof input.function === 'string' ? input.function.trim().toLowerCase() : '';
        const rows = PACKS.filter((p) => (!fn || (p.function ?? '').toLowerCase() === fn) && matches(input.q, p.name, p.role, p.tagline, p.function, p.cat))
          .map((p) => `- ${p.id}: ${p.name} — ${p.role}; ${segmentOf(p)}${p.function ? `/${p.function}` : ''}${p.level ? ` ${p.level}` : ''}; ${clip(p.tagline, 100)}`);
        return pageOf(rows, input, { header: `Agent packs (${rows.length}); view pack with id for one.`, empty: 'No pack matches.' });
      }
      case 'pack': {
        const id = typeof input.id === 'string' ? input.id.trim() : '';
        const p = PACKS.find((x) => x.id === id || x.id === `pack-${id}`);
        if (!p) throw new Error(`no pack "${id}" — ws_market view packs lists them`);
        const hire = orgHireRef(p);
        return [
          `${p.name} ${p.emoji} (${p.id}) — ${p.role}; ${segmentOf(p)}${p.function ? `/${p.function}` : ''}${p.level ? ` ${p.level}` : ''}${p.reportsTo ? `, reports to ${p.reportsTo}` : ''}; ${p.price}.`,
          p.tagline,
          `Charter: ${clip(p.charter, 700)}`,
          p.skills?.length ? `Skills: ${p.skills.map((s) => s.name).join(', ')}` : '',
          p.loops.length ? `Loops: ${p.loops.map((l) => `${l.name} "${l.cron}"`).join(', ')}` : '',
          p.kpis?.length ? `KPIs: ${p.kpis.join('; ')}` : '',
          p.cadence ? `Cadence: ${p.cadence}` : '',
          `Capabilities: ${p.caps.join(', ') || 'none'}`,
          hire ? `Hire into the company: org_hire_agent templateOrPack "${hire}".` : '',
        ].filter(Boolean).join('\n');
      }
      case 'connectors': {
        const rows = CONNECTORS.filter((x) => matches(input.q, x.name, x.vendor, x.cat, x.desc))
          .map((x) => `- ${x.id}: ${x.name} (${x.vendor}, ${x.kind}, ${x.tier}) — ${clip(x.desc, 100)}`);
        return pageOf(rows, input, { header: 'Connectors the owner can connect (in the app) and grant you.' });
      }
      case 'registry': {
        if (!this.registry) return 'The registry is not available on this server.';
        const kind = typeof input.kind === 'string' ? input.kind : undefined;
        const { items } = await this.registry.list({ kind, q: typeof input.q === 'string' ? input.q : undefined });
        const rows = items.map((i) => `- ${i.id.slice(0, 12)} ${i.kind}: ${i.name} v${i.version} by ${i.publisherName || '?'} — ${clip(i.description, 100)}; ${i.installs} install(s), ↑${i.ratingUp} ↓${i.ratingDown}${i.installed ? ', installed' : ''}`);
        return pageOf(rows, input, { header: 'Registry items (published agents, skills, apps, company blueprints).', empty: 'Nothing published in the registry yet.' });
      }
    }
    throw new Error('view must be packs | pack | connectors | registry');
  }

  // ---- ws_plugins ----

  private async pluginsView(c: Ctx, input: Record<string, unknown>): Promise<string> {
    if (!this.plugins) return 'Plugins are not available on this server.';
    const view = typeof input.view === 'string' ? input.view : (typeof input.id === 'string' && input.id ? 'plugin' : 'installed');
    const s = (v: unknown) => (typeof v === 'string' ? v : v === null || v === undefined ? '' : JSON.stringify(v));
    switch (view) {
      case 'installed': {
        const rows = (await this.plugins.list(c.workspaceId)).filter((p) => matches(input.q, s(p.id), s(p.name), s(p.description)))
          .map((p) => `- ${s(p.id)} ${s(p.name)} v${s(p.version)} (${s(p.tier)}, ${s(p.status)}) — provides ${(p.interfaces as string[] | undefined)?.join(', ') || 'nothing'}${p.pendingUpdate ? '; update pending' : ''}`);
        return pageOf(rows, input, { header: 'Installed plugins; view plugin with id for one.', empty: 'No plugins installed.' });
      }
      case 'interfaces': {
        const rows = (await this.plugins.interfacesView(c.workspaceId)).filter((i) => matches(input.q, s(i.name)))
          .map((i) => {
            const ops = (i.operations as Array<{ tool: string; effectiveClass: string }>).map((o) => `${o.tool} (${o.effectiveClass})`).join(', ');
            const prov = (i.providers as Array<{ pluginId: string; status: string; healthy: boolean }>).map((p) => `${p.pluginId}${p.healthy ? '' : ' unhealthy'} ${p.status}`).join(', ');
            const binds = (i.bindings as Array<{ scopeKind: string; scopeRef: string; pluginId: string | null }>).map((b) => `${b.scopeKind}${b.scopeRef ? `:${b.scopeRef}` : ''}→${b.pluginId ?? 'none'}`).join(', ');
            return `- ${s(i.name)}@${s(i.version)}: ops ${ops || 'none'}; providers ${prov || 'none'}; bindings ${binds || 'none'}`;
          });
        return pageOf(rows, input, { header: 'Interfaces (each operation is a tool; its class decides the gate).', empty: 'No interfaces: install a plugin that provides one.' });
      }
      case 'catalog': {
        // Installed first: what the company already runs, then what it could add.
        const rows = (await this.plugins.catalogView(c.workspaceId)).filter((p) => matches(input.q, s(p.id), s(p.name), s(p.description)))
          .sort((a, b) => Number(!!b.installed) - Number(!!a.installed))
          .map((p) => `- ${s(p.id)} ${s(p.name)} v${s(p.version)}: ${clip(s(p.description), 100)}${p.installed ? `; installed v${s(p.installedVersion)}${p.updateAvailable ? ', update available' : ''}` : ''}`);
        return pageOf(rows, input, { header: 'First-party plugin catalog (the owner installs in the app).', empty: 'The catalog is empty.' });
      }
      case 'plugin': {
        const id = typeof input.id === 'string' ? input.id.trim() : '';
        if (!id) throw new Error('view plugin needs id');
        const d = await this.plugins.detail(c.workspaceId, id).catch(() => { throw new Error(`plugin "${id}" is not installed — ws_plugins view installed lists them`); });
        const conf = (d.conformance as Array<{ result: string; startedAt: string; candidate: boolean }>).slice(0, 5);
        const mine = (d.grants as Array<{ agentId: string; level: string }>).find((g) => g.agentId === c.agentId);
        return [
          `${s(d.id)} ${s(d.name)} v${s(d.version)} (${s(d.tier)}, ${s(d.status)}${d.suspendedReason ? `: ${s(d.suspendedReason)}` : ''}) — ${clip(s(d.description), 200)}`,
          `Providers: ${(d.providers as Array<{ interface: string; status: string; range: string }>).map((p) => `${p.interface} ${p.range} ${p.status}`).join(', ') || 'none'}`,
          `Conformance: ${conf.length ? conf.map((r) => `${r.result} ${r.startedAt.slice(0, 10)}${r.candidate ? ' (candidate)' : ''}`).join(', ') : 'never run'}`,
          `Your grant: ${mine ? mine.level : 'none'}.`,
        ].join('\n');
      }
    }
    throw new Error('view must be installed | interfaces | catalog | plugin');
  }
}

/** Strip anything that looks like a credential from a status line. */
function redact(s: string): string {
  return s.replace(/\b(sk|pk|rk|xox[abp]|ghp|gho|AKIA)[-_A-Za-z0-9]{8,}/g, '[redacted]').replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[redacted]');
}

/** The workspace briefing's ceiling, in characters (the tests measure it). */
export const WORKSPACE_BRIEFING_BUDGET = 600;

/** The non-company agent's briefing: the workspace, its open tasks (top 3 keys), its loops. One query per part. */
async function workspaceBriefing(db: DrizzleDb, agents: AgentsService, workspaces: WorkspacesService, c: Ctx): Promise<string | null> {
  const ws = await workspaces.get(c.workspaceId).catch(() => null);
  if (!ws) return null;
  const open = await db.select({ id: agentTasks.id, key: agentTasks.key, status: agentTasks.status }).from(agentTasks)
    .where(and(eq(agentTasks.agentId, c.agentId), isNull(agentTasks.mergedInto), inArray(agentTasks.status, ['todo', 'doing', 'blocked'])));
  const rank: Record<string, number> = { blocked: 0, doing: 1, todo: 2 };
  open.sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9));
  const agent = await agents.get(c.agentId).catch(() => null);
  let loops: LoopDef[];
  try { const v = JSON.parse(agent?.loops || '[]') as unknown; loops = Array.isArray(v) ? (v as LoopDef[]).filter((l) => l && l.enabled !== false && typeof l.name === 'string') : []; } catch { loops = []; }
  const lines = [
    `# Workspace briefing: "${ws.name}"`,
    `Your open tasks: ${open.length ? `${open.length} — ${open.slice(0, 3).map((t) => `${t.key ?? t.id.slice(0, 8)}${t.status === 'todo' ? '' : ` ${t.status}`}`).join(', ')}${open.length > 3 ? ', …' : ''}` : 'none'}.`,
    `Your loops: ${loops.length ? loops.slice(0, 4).map((l) => `"${l.name.slice(0, 40)}"${l.cron ? ` (${l.cron})` : l.trigger ? ` (on ${l.trigger.kind})` : ''}`).join(', ') + (loops.length > 4 ? ', …' : '') : 'none'}.`,
    'More: ws_workspace (profile, people, usage), list_tasks, ws_catalog (every domain).',
  ];
  const text = lines.join('\n');
  return text.length > WORKSPACE_BRIEFING_BUDGET ? `${text.slice(0, WORKSPACE_BRIEFING_BUDGET - 1)}…` : text;
}
