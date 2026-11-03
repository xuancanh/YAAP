/**
 * The work-tracking tools (docs/work-tracking.md), offered to org members as
 * a ToolProviderHook beside the runtime's matrix so they work the same in
 * every session kind (task runs, heartbeats, chats, channels), and the
 * kanban bridge: a company member's list_tasks / add_task / update_task /
 * delegate_task act on the org board.
 *
 * Classes (permissions, docs/boundary.md): reads and proposals are
 * read-only (a proposal only writes a card the CEO decides); a health update
 * and checklist steps are the member's own bookkeeping (read-only, like
 * update_task); changing a project, moving a task between projects, a
 * milestone and an appetite decision are internal writes. The CEO's bets —
 * Now, a kill, an appetite beyond the manager's share — are always cards
 * (boundary rows project_bet, project_kill, project_appetite:beyond).
 *
 *  - `org_projects` / `org_project` (read, every member): the roadmap / one project;
 *  - `org_create_project` (every member proposes; Now is a card);
 *  - `org_update_project` (lead, its managers, the unit lead, the chief);
 *  - `org_project_update` (the lead): the health call with reason and ask;
 *  - `org_milestone` (lead and up): add or tick a milestone;
 *  - `org_project_appetite` (the lead's manager chain): extend | cut_scope | kill;
 *  - `org_link_task` (owner, managers, either project's lead, the chief): move a task to a project;
 *  - `org_task_steps` (the owner): the checklist on a task;
 *  - `org_project_team` (read, every member): the cross-functional team, home units, allocations;
 *  - `org_project_add_member` / `org_project_remove_member` (the lead and up):
 *    staff the team; the member's own head approves the allocation (a card
 *    routed to it), at most 100% of a member's time across projects;
 *  - `org_project_standup` (the lead and up): the project standup's cadence in `#p-<key>`.
 */
import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ChatSession } from '../chats/chats.repository';
import { TurnLoopService, type KanbanBridge, type ToolProviderHook } from '../chats/turn-loop.service';
import type { AiToolSpec } from '../ai/ai-provider.interface';
import { AgentsService } from '../agents/agents.service';
import { OrgService, type Organization } from './org.service';
import { OrgTasksService, type OrgTask } from './org-tasks.service';
import { OrgRuntimeService } from './org-runtime.service';
import { OrgProjectsService, describeAppetite } from './org-projects.service';
import { OrgProjectTeamsService } from './org-project-teams.service';
import { BLOCKED_KINDS, describeBlockedOn, legacyBlockedOn, parseBlockedOn } from './blocked-on';
import { PROJECT_HEALTH, PROJECT_LANES, parseSteps } from './work-model';
import { taskRef } from '../common/task-keys';

const PROJECT_REF = 'The project key as the roadmap shows it, e.g. P-3 (an id prefix or the exact title also works).';
const TASK_REF = 'The task key as the board shows it, e.g. ENG-12.';
const BRIEF = { type: 'object', description: 'The lean case in four short fields.', properties: { problem: { type: 'string', description: 'The problem or opportunity, and for whom.' }, hypothesis: { type: 'string', description: 'What we believe the project will change, and how we will know.' }, done_when: { type: 'string', description: 'The observable condition that makes it done.' }, mvp: { type: 'string', description: 'The smallest version that tests the hypothesis.' } } };
const PROJECT_FIELDS = {
  title: { type: 'string' },
  goalIds: { type: 'array', items: { type: 'string' }, description: 'The key result(s) it moves (ids or id prefixes from org_intent). Required for a new project.' },
  lead: { type: 'string', description: 'The lead (a member by name); default: a Program Manager when the company has one, else you.' },
  brief: BRIEF,
  startDate: { type: 'string', description: 'YYYY-MM-DD.' },
  targetDate: { type: 'string', description: 'YYYY-MM-DD: when it should land (optional; the forecast is shown beside it).' },
  appetiteDays: { type: 'number', description: 'Appetite: calendar days the company is willing to spend on it (not an estimate).' },
  appetiteUsd: { type: 'number', description: 'Appetite: USD of model spend the company is willing to spend on it.' },
  lane: { type: 'string', enum: [...PROJECT_LANES], description: 'Roadmap lane. Now is the CEO\'s bet: asking for it creates a decision card.' },
  milestones: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, date: { type: 'string' } } }, description: 'Milestones (name + date).' },
  why: { type: 'string', description: 'One line for the card when this becomes a CEO decision.' },
  org: { type: 'string' },
};

const TOOLS: AiToolSpec[] = [
  { name: 'org_projects', description: 'The roadmap (read-only): every project with its key, lane (now / next / later), status, lead, progress (tasks done/total), health and whether an update is due or missing, target date, appetite used and the key results it moves.', inputSchema: { type: 'object', properties: { org: { type: 'string' } } } },
  { name: 'org_project', description: 'One project (read-only): its brief, key results, milestones, health history, appetite and spend, forecast, blockers and tasks by status.', inputSchema: { type: 'object', properties: { project: { type: 'string', description: PROJECT_REF }, org: { type: 'string' } }, required: ['project'] } },
  { name: 'org_create_project', description: 'Propose a project — the middle level between a key result and tasks. It names the key result(s) it moves, a lead, a brief (problem, hypothesis, done_when, MVP) and an appetite (days and/or USD it is worth, not an estimate). It starts as proposed (shaped once the brief and appetite are filled) in Next or Later; asking for lane "now" sends the CEO a decision card (the betting table). Create tasks under it with org_create_task projectId.', inputSchema: { type: 'object', properties: { ...PROJECT_FIELDS }, required: ['title', 'goalIds', 'brief'] } },
  { name: 'org_update_project', description: 'Change a project you lead (or that a report of yours leads; the chief: any): title, brief, lead, key results, dates, milestones, lane Next/Later, status done. Moving it to Now, cancelling a Now project or raising its appetite becomes the CEO\'s decision (a card) or, for an appetite within your share as the lead\'s manager, applies at once.', inputSchema: { type: 'object', properties: { project: { type: 'string', description: PROJECT_REF }, ...PROJECT_FIELDS, status: { type: 'string', enum: ['proposed', 'shaped', 'paused', 'done', 'cancelled'] }, updateCadenceDays: { type: 'number', description: 'Days between health updates for this project (default: the company tunable).' } }, required: ['project'] } },
  { name: 'org_project_update', description: 'Post the health update of a project you lead: on_track; at_risk with the ask (the support you need and from whom); off_track with the reason. "Unknown, still investigating" is a fine reason — never invent a story. Optional hill (0–1: 0–0.5 still figuring it out, 0.5–1 making it happen) and a short narrative. The diff since the last update (dates, scope, spend, tasks done) is added for you.', inputSchema: { type: 'object', properties: { project: { type: 'string', description: PROJECT_REF }, health: { type: 'string', enum: [...PROJECT_HEALTH] }, reason: { type: 'string' }, ask: { type: 'string' }, hill: { type: 'number' }, body: { type: 'string' }, org: { type: 'string' } }, required: ['project', 'health'] } },
  { name: 'org_milestone', description: 'Add a milestone to a project you lead (name + date), or update one (by its id like m2, its number or its name): rename, re-date, or mark it done.', inputSchema: { type: 'object', properties: { project: { type: 'string', description: PROJECT_REF }, add: { type: 'string', description: 'Name of a new milestone.' }, milestone: { type: 'string', description: 'An existing milestone to change.' }, date: { type: 'string', description: 'YYYY-MM-DD.' }, done: { type: 'boolean' }, name: { type: 'string' }, org: { type: 'string' } }, required: ['project'] } },
  { name: 'org_project_appetite', description: 'Decide a project whose appetite is used up (its circuit breaker paused new task claims), as the lead\'s manager: extend (by extendDays / extendUsd; within work.extendShare of the original appetite it applies at once, beyond it goes to the CEO), cut_scope (a small extension; the lead cancels or moves out what does not fit) or kill (always the CEO\'s: a card).', inputSchema: { type: 'object', properties: { project: { type: 'string', description: PROJECT_REF }, decision: { type: 'string', enum: ['extend', 'cut_scope', 'kill'] }, extendDays: { type: 'number' }, extendUsd: { type: 'number' }, note: { type: 'string' }, org: { type: 'string' } }, required: ['project', 'decision'] } },
  { name: 'org_link_task', description: 'Move a task to the project it serves (an orphan out of Unsorted, or a task filed under the wrong project). Its owner, its owner\'s managers, either project\'s lead or the chief may.', inputSchema: { type: 'object', properties: { taskId: { type: 'string', description: TASK_REF }, project: { type: 'string', description: PROJECT_REF }, org: { type: 'string' } }, required: ['taskId', 'project'] } },
  { name: 'org_project_team', description: 'A project\'s cross-functional team (read-only): each member with its role on the project, allocation (% of its time), status (pending until its own head approves), home unit and manager, its total allocation across projects and its open tasks here; the project channel and the standup cadence.', inputSchema: { type: 'object', properties: { project: { type: 'string', description: PROJECT_REF }, org: { type: 'string' } }, required: ['project'] } },
  { name: 'org_project_add_member', description: 'Add a member from any unit to a project you lead (or that a report of yours leads; the chief: any) with its role on the project and an allocation (percent of its time; a member\'s projects never sum past 100%). The member\'s own manager approves the allocation: a decision card routed to it, unless you are that manager. The team can then be assigned the project\'s tasks regardless of unit; the project channel #p-<key> opens with the first member.', inputSchema: { type: 'object', properties: { project: { type: 'string', description: PROJECT_REF }, agent: { type: 'string', description: 'The member, by name.' }, role: { type: 'string', description: 'Its role on the project, e.g. engineer, designer, analyst.' }, allocation: { type: 'number', description: 'Percent of its time, 1–100.' }, why: { type: 'string', description: 'The milestone or key result it serves — the card carries it.' }, org: { type: 'string' } }, required: ['project', 'agent', 'allocation'] } },
  { name: 'org_project_remove_member', description: 'Release a member from a project\'s team (its allocation returns to its unit). The lead, its managers, the chief or the member\'s own manager may.', inputSchema: { type: 'object', properties: { project: { type: 'string', description: PROJECT_REF }, agent: { type: 'string' }, why: { type: 'string' }, org: { type: 'string' } }, required: ['project', 'agent'] } },
  { name: 'org_project_standup', description: 'Set the project standup of a project you lead: a five-field cron (server time) for a standup in the project channel with its team (you facilitate; it skips itself when the project has no open task), or "off".', inputSchema: { type: 'object', properties: { project: { type: 'string', description: PROJECT_REF }, cron: { type: 'string', description: 'e.g. "0 9 * * 1-5", or "off".' }, org: { type: 'string' } }, required: ['project', 'cron'] } },
  { name: 'org_task_steps', description: 'The checklist on a task you own: add a step, tick one done, undo, or drop one. Steps are your notes on how the task gets done — no status, no key, no heartbeat. Name a step by its id (s2), its number or its text.', inputSchema: { type: 'object', properties: { taskId: { type: 'string', description: TASK_REF }, add: { type: 'string' }, done: { type: 'string' }, undo: { type: 'string' }, drop: { type: 'string' }, org: { type: 'string' } } } },
];
const NAMES = new Set(TOOLS.map((t) => t.name));
const READ = new Set(['org_projects', 'org_project', 'org_create_project', 'org_project_update', 'org_task_steps', 'org_project_team', 'org_project_add_member']);
const TEAM_TOOLS = new Set(['org_project_team', 'org_project_add_member', 'org_project_remove_member', 'org_project_standup']);

/** The company section of the prompt for members: which tool is for what (the mirroring the report found came from this being unsaid). */
const MEMBER_GUIDE = 'Work tracking in this company (docs/work-tracking.md): goal / key result → project → task. Every task belongs to a project; org_projects shows the roadmap. Your kanban tools act on the company board: add_task queues a task you own on your unit\'s board (pass `task` to add a checklist step to one of your tasks instead), update_task moves your org tasks (doing = in progress; done hands it to review; blocked needs `reason` and optionally `waitsOn`), list_tasks lists your tasks with their steps. Use org_create_task for briefed work for someone else, org_task_steps for the checklist on a task, org_create_project to propose a project (Now is the CEO\'s bet), and org_project_update for the health of a project you lead. Never mirror a task into a second list.';

@Injectable()
export class OrgProjectsTools implements ToolProviderHook {
  constructor(
    private readonly org: OrgService,
    private readonly projects: OrgProjectsService,
    private readonly tasks: OrgTasksService,
    private readonly agents: AgentsService,
    private readonly config: ConfigService,
    @Optional() private readonly runtime?: OrgRuntimeService,
    @Optional() turns?: TurnLoopService,
    @Optional() private readonly teams?: OrgProjectTeamsService,
  ) {
    turns?.addToolProvider(this);
    const bridge: KanbanBridge = { handles: (id) => this.handles(id), execute: (s, n, i) => this.kanban(s, n, i) };
    if (this.enabled()) turns?.setKanbanBridge(bridge);
  }

  private enabled(): boolean { return this.config.get<boolean>('companiesEnabled') !== false; }

  private async memberships(agentId: string) {
    return (await this.org.membershipsOf(agentId)).filter((m) => m.status === 'active');
  }

  async specsFor(session: ChatSession): Promise<AiToolSpec[]> {
    if (!this.enabled() || !session.agentId) return [];
    const ctx = this.runtime?.runningCtx(session.id);
    if (ctx?.audit) return TOOLS.filter((t) => t.name === 'org_projects' || t.name === 'org_project');
    if (ctx?.aux) return [];
    return (await this.memberships(session.agentId)).length ? TOOLS.filter((t) => this.teams || !TEAM_TOOLS.has(t.name)) : [];
  }

  owns(name: string): boolean { return NAMES.has(name); }
  isReadOnly(name: string): boolean { return READ.has(name); }

  async contextFor(session: ChatSession): Promise<string | null> {
    if (!this.enabled() || !session.agentId) return null;
    return (await this.memberships(session.agentId)).length ? MEMBER_GUIDE : null;
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

  private async memberRef(orgId: string, v: unknown): Promise<string> {
    const q = String(v ?? '').trim().toLowerCase();
    const names = new Map((await this.agents.list()).map((a) => [a.id, a.name]));
    const m = (await this.org.members(orgId)).find((x) => x.status !== 'terminated' && (x.agentId === q || (q.length >= 6 && x.agentId.startsWith(q)) || (names.get(x.agentId) ?? '').toLowerCase() === q));
    if (!m) throw new Error(`no member "${String(v ?? '')}"`);
    return m.agentId;
  }

  private async goalRefs(orgId: string, raw: unknown): Promise<string[] | undefined> {
    if (raw === undefined) return undefined;
    const list = Array.isArray(raw) ? raw.map(String) : String(raw).split(',').map((x) => x.trim());
    const goals = await this.org.goals(orgId);
    return list.filter(Boolean).map((ref) => {
      const hit = goals.filter((g) => g.id === ref || (ref.length >= 6 && g.id.startsWith(ref)) || g.title.toLowerCase() === ref.toLowerCase());
      if (hit.length !== 1) throw new Error(`goal "${ref}" matches ${hit.length} goals — use the id from org_intent`);
      return hit[0].id;
    });
  }

  async execute(session: ChatSession, name: string, input: Record<string, unknown>): Promise<string> {
    if (!this.enabled()) throw new Error('organizations are disabled on this server');
    const agentId = session.agentId!;
    const org = await this.resolveOrg(agentId, input.org);
    if (org.status !== 'active') throw new Error(`"${org.name}" is paused by the CEO`);
    const isChief = org.chiefOfStaffAgentId === agentId;
    const actor = `agent:${agentId}`;
    const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string).trim() : '');
    const num = (k: string) => (input[k] === undefined || input[k] === null || input[k] === '' ? undefined : Number(input[k]));
    const ctx = this.runtime?.runningCtx(session.id);
    const progressed = () => { if (ctx) ctx.progress = true; };
    const wrap = async <T>(fn: () => Promise<T>): Promise<T> => fn().catch((err: unknown) => { const m = err instanceof Error ? err.message : String(err); throw new Error(m.startsWith('refused') ? m : `refused: ${m}`); });
    switch (name) {
      case 'org_projects': return this.projects.describeForModel(org.id);
      case 'org_project': {
        const page = await wrap(() => this.projects.page(org.id, str('project')));
        const p = page.project;
        return [
          `${p.key} "${p.title}" — ${p.lane}/${p.status}, lead ${p.lead.name}${p.unitName ? `, unit ${p.unitName}` : ''}.`,
          p.goals.length ? `Moves: ${p.goals.map((g) => `[${g.id.slice(0, 8)}] ${g.title}`).join('; ')}` : 'Moves: no key result linked (link one with org_update_project goalIds).',
          `Brief — problem: ${p.brief.problem || '?'}; hypothesis: ${p.brief.hypothesis || '?'}; done when: ${p.brief.done_when || '?'}; MVP: ${p.brief.mvp || '?'}`,
          `Dates: ${p.startDate ?? '?'} → ${p.targetDate ?? 'no target'}; milestones: ${p.milestones.map((m) => `${m.id} ${m.name}${m.date ? ` (${m.date})` : ''}${m.done ? ' ✓' : ''}`).join('; ') || 'none'}`,
          `Progress: ${p.progress.done}/${p.progress.total} tasks; hill ${p.hill ?? '?'}${p.hillInferred ? ' (inferred)' : ''}; forecast: ${p.forecast.state === 'range' ? `${p.forecast.p50} (50%) – ${p.forecast.p85} (85%)` : p.forecast.note}`,
          `Health: ${p.health || 'no update yet'}${p.healthReason ? ` — ${p.healthReason}` : ''}${p.healthAsk ? ` · ask: ${p.healthAsk}` : ''}; update ${p.update.state}${p.update.dueAt ? ` (due ${p.update.dueAt.slice(0, 10)})` : ''}`,
          `Appetite: ${describeAppetite(p.appetite)}${p.appetite.tripped ? ' — BREAKER TRIPPED: claims paused' : ''}`,
          page.blockers.length ? `Blockers: ${page.blockers.map((b) => `${b.key ?? b.taskId.slice(0, 8)} ${b.text}`).join('; ')}` : 'Blockers: none',
          this.teams ? await this.teams.describe(org.id, p.id).catch(() => '') : '',
          `Tasks:\n${page.tasks.slice(0, 40).map((t) => `- ${t.key ?? t.id.slice(0, 8)} (${t.status}) ${t.title} — ${t.assigneeName}${t.source !== 'agent' ? ` · from ${t.source}` : ''}${t.blockedText ? ` · ${t.blockedText}` : ''}`).join('\n') || '(none yet)'}`,
        ].join('\n');
      }
      case 'org_create_project': {
        const r = await wrap(async () => this.projects.create(org.id, {
          title: str('title'), goalIds: await this.goalRefs(org.id, input.goalIds) ?? [], ownerAgentId: str('lead') ? await this.memberRef(org.id, str('lead')) : null,
          brief: (input.brief ?? {}) as Record<string, string>, startDate: str('startDate') || null, targetDate: str('targetDate') || null,
          appetiteDays: num('appetiteDays') ?? 0, appetiteUsd: num('appetiteUsd') ?? 0, lane: str('lane') || undefined, milestones: Array.isArray(input.milestones) ? input.milestones : undefined, why: str('why'),
        }, actor));
        progressed();
        return `${r.note} Create its tasks with org_create_task projectId=${r.project.key}.`;
      }
      case 'org_update_project': {
        const patch: Record<string, unknown> = {};
        for (const k of ['title', 'startDate', 'targetDate', 'lane', 'status']) if (str(k)) patch[k] = str(k);
        for (const k of ['appetiteDays', 'appetiteUsd', 'updateCadenceDays']) if (num(k) !== undefined) patch[k] = num(k);
        if (input.brief && typeof input.brief === 'object') patch.brief = input.brief;
        if (Array.isArray(input.milestones)) patch.milestones = input.milestones;
        if (input.goalIds !== undefined) patch.goalIds = await this.goalRefs(org.id, input.goalIds);
        if (str('lead')) patch.ownerAgentId = await this.memberRef(org.id, str('lead'));
        const r = await wrap(() => this.projects.update(org.id, str('project'), { ...patch, why: str('why') }, actor));
        progressed();
        return r.note;
      }
      case 'org_project_update': {
        const row = await wrap(() => this.projects.postUpdate(org.id, str('project'), { health: str('health'), reason: str('reason'), ask: str('ask'), body: str('body'), hill: num('hill') ?? null }, actor));
        progressed();
        const diff = JSON.parse(row.diff) as { done?: number; spentUsd?: number; scope?: number };
        return `Health update posted (${row.health.replace('_', ' ')}). Since the last one: ${diff.done ?? 0} task(s) done, scope ${diff.scope ?? 0}, spend $${(diff.spentUsd ?? 0).toFixed(2)}.`;
      }
      case 'org_milestone': {
        const p = str('add')
          ? await wrap(() => this.projects.addMilestone(org.id, str('project'), { name: str('add'), date: str('date') || null }, actor))
          : await wrap(() => this.projects.setMilestone(org.id, str('project'), str('milestone'), { ...(str('name') ? { name: str('name') } : {}), ...(str('date') ? { date: str('date') } : {}), ...(typeof input.done === 'boolean' ? { done: input.done } : {}) }, actor));
        progressed();
        return `Milestones of ${p.key}: ${JSON.parse(p.milestones).map((m: { id: string; name: string; date: string | null; done: boolean }) => `${m.id} ${m.name}${m.date ? ` (${m.date})` : ''}${m.done ? ' ✓' : ''}`).join('; ')}`;
      }
      case 'org_project_appetite': {
        const decision = str('decision') as 'extend' | 'cut_scope' | 'kill';
        const r = await wrap(() => this.projects.decideAppetite(org.id, str('project'), { decision, extendDays: num('extendDays'), extendUsd: num('extendUsd'), note: str('note') }, actor));
        progressed();
        return `${r.note}.`;
      }
      case 'org_link_task': {
        const t = await wrap(() => this.projects.linkTask(org.id, str('taskId'), str('project'), actor));
        progressed();
        return `Task ${taskRef(t)} is now under ${(await this.org.project(org.id, t.projectId!)).key}.`;
      }
      case 'org_project_team': {
        if (!this.teams) throw new Error('project teams are not available on this server');
        return wrap(() => this.teams!.describe(org.id, str('project')));
      }
      case 'org_project_add_member': {
        if (!this.teams) throw new Error('project teams are not available on this server');
        const who = await this.memberRef(org.id, str('agent'));
        const r = await wrap(() => this.teams!.propose(org.id, str('project'), { agentId: who, role: str('role'), allocation: num('allocation') ?? 0, why: str('why') }, actor));
        progressed();
        return r.note;
      }
      case 'org_project_remove_member': {
        if (!this.teams) throw new Error('project teams are not available on this server');
        const who = await this.memberRef(org.id, str('agent'));
        const r = await wrap(() => this.teams!.remove(org.id, str('project'), who, actor, str('why')));
        progressed();
        return r.note;
      }
      case 'org_project_standup': {
        if (!this.teams) throw new Error('project teams are not available on this server');
        const cron = str('cron');
        const p = await wrap(() => this.teams!.setStandup(org.id, str('project'), !cron || cron.toLowerCase() === 'off' ? null : cron, actor));
        progressed();
        return p.standupCron ? `Standup of ${p.key} set to "${p.standupCron}" (next ${p.standupNextAt?.slice(0, 16).replace('T', ' ') ?? '?'} UTC) in its project channel.` : `Standup of ${p.key} is off.`;
      }
      case 'org_task_steps': {
        const t = await this.taskOf(org.id, str('taskId') || ctx?.taskId || '');
        if (t.assigneeAgentId !== agentId && !isChief) throw new Error(`refused: ${taskRef(t)} is not yours — its owner keeps its checklist`);
        const r = await wrap(() => this.tasks.step(org.id, t.id, { add: str('add') || undefined, done: str('done') || undefined, undo: str('undo') || undefined, drop: str('drop') || undefined }, actor));
        progressed();
        return describeSteps(r.task);
      }
    }
    throw new Error(`unknown tool: ${name}`);
  }

  private async taskOf(orgId: string, ref: string): Promise<OrgTask> {
    if (!ref) throw new Error('taskId is required outside a task run');
    return this.tasks.byPrefix(orgId, ref).catch((err: unknown) => { throw new Error(err instanceof Error ? err.message : String(err)); });
  }

  // ---- the kanban bridge (docs/work-tracking.md "One task system") ----

  async handles(agentId: string): Promise<boolean> {
    if (!this.enabled()) return false;
    return (await this.memberships(agentId)).length > 0;
  }

  async kanban(session: ChatSession, name: 'list_tasks' | 'add_task' | 'update_task' | 'delegate_task', input: Record<string, unknown>): Promise<string> {
    const agentId = session.agentId!;
    const org = await this.resolveOrg(agentId, input.org);
    const actor = `agent:${agentId}`;
    const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string).trim() : '');
    const ctx = this.runtime?.runningCtx(session.id);
    const mine = async () => (await this.tasks.list(org.id)).filter((t) => t.assigneeAgentId === agentId);
    switch (name) {
      case 'list_tasks': {
        const now = Date.now();
        const rows = (await mine()).filter((t) => !['done', 'cancelled'].includes(t.status) || now - Date.parse(t.doneAt ?? t.updatedAt) < 7 * 86_400_000);
        if (rows.length === 0) return 'You own no tasks on the company board. add_task queues one; org_read_board shows the whole board.';
        const projects = new Map((await this.org.projects(org.id)).map((p) => [p.id, p.key ?? '']));
        const order = ['in_progress', 'claimed', 'todo', 'in_review', 'blocked', 'waiting', 'backlog', 'done', 'cancelled'];
        return rows.sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status)).slice(0, 60).map((t) => {
          const b = parseBlockedOn(t.blockedOn);
          const steps = parseSteps(t.steps).filter((x) => !x.dropped);
          return `${taskRef(t)} (${kanbanStatus(t.status)}) ${t.title}${t.projectId ? ` [${projects.get(t.projectId) ?? ''}]` : ''}${b && t.status === 'blocked' ? ` — ${describeBlockedOn(b)}` : ''}${steps.length ? `\n${steps.map((x) => `   ${x.done ? '[x]' : '[ ]'} ${x.id} ${x.text}`).join('\n')}` : ''}`;
        }).join('\n');
      }
      case 'add_task': {
        const title = str('title');
        const parentRef = str('task') || (ctx?.taskId && !str('project') ? ctx.taskId : '');
        if (parentRef) {
          const t = await this.taskOf(org.id, parentRef);
          if (t.assigneeAgentId === agentId) {
            const r = await this.tasks.step(org.id, t.id, { add: title }, actor);
            return `Step added to ${taskRef(r.task)} (a checklist step, not a separate task): ${title}\n${describeSteps(r.task)}`;
          }
        }
        const projectId = str('project') ? (await this.projects.resolve(org.id, str('project'))).id : null;
        const t = await this.tasks.create(org.id, {
          title, brief: { outcome: title, context: str('note'), constraints: '', done_when: '' }, assigneeAgentId: agentId, status: 'backlog', createdBy: actor, source: 'agent', projectId,
        }).catch((err: unknown) => { throw new Error(err instanceof Error ? err.message : String(err)); });
        const p = t.projectId ? await this.org.project(org.id, t.projectId).catch(() => null) : null;
        return `Task ${taskRef(t)} queued on the company board (yours, backlog${p ? `, project ${p.key} ${p.title}` : ''}): ${t.title}${p?.kind === 'unsorted' ? '. Move it under the project it serves with org_link_task.' : ''}`;
      }
      case 'update_task': {
        const ref = str('id');
        if (!ref) throw new Error('id is required: the task key from list_tasks');
        let t: OrgTask | null = await this.tasks.byPrefix(org.id, ref).catch(() => null);
        // A merged kanban item now a step: its old key ticks the step.
        if (!t) {
          const host = (await mine()).find((x) => parseSteps(x.steps).some((s) => s.from && s.from.toLowerCase() === ref.toLowerCase()));
          if (!host) throw new Error(`no task "${ref}" on the company board — list_tasks shows your keys`);
          const op = str('status') === 'done' ? { done: ref } : str('status') === 'abandoned' ? { drop: ref } : str('status') === 'todo' ? { undo: ref } : null;
          if (!op) return `${ref} is now a checklist step on ${taskRef(host)}; steps are done or not — update the task itself for its status.`;
          const r = await this.tasks.step(org.id, host.id, op, actor);
          return `Step ${ref} on ${taskRef(host)} updated.\n${describeSteps(r.task)}`;
        }
        const isChief = org.chiefOfStaffAgentId === agentId;
        if (t.assigneeAgentId !== agentId && !isChief) throw new Error(`refused: ${taskRef(t)} is not yours`);
        if (str('step')) {
          const op = str('status') === 'done' ? { done: str('step') } : str('status') === 'abandoned' ? { drop: str('step') } : { undo: str('step') };
          const r = await this.tasks.step(org.id, t.id, op, actor);
          return describeSteps(r.task);
        }
        if (str('note')) await this.tasks.comment(org.id, t.id, { text: str('note'), fromAgentId: agentId, runId: ctx?.runId ?? null, wake: false });
        if (str('title')) t = await this.tasks.update(org.id, t.id, { title: str('title') }, actor);
        const status = str('status');
        const reason = str('reason');
        if (!status) return `Task ${taskRef(t)} is (${kanbanStatus(t.status)}) ${t.title}`;
        switch (status) {
          case 'doing': t = await this.tasks.update(org.id, t.id, { status: 'in_progress' }, actor); break;
          case 'todo': t = await this.tasks.update(org.id, t.id, { status: 'todo' }, actor); break;
          case 'blocked': {
            if (!reason) throw new Error('a blocked task needs a reason: say what it waits on');
            const kind = str('waitsOn') || legacyBlockedOn({ lines: [reason], since: '' }).kind;
            t = await this.tasks.update(org.id, t.id, { blockedOn: { kind, ref: str('ref') || null, reason } }, actor).catch((err: unknown) => { throw new Error(err instanceof Error ? err.message : String(err)); });
            break;
          }
          case 'abandoned': {
            if (!reason) throw new Error('say why it is no longer worth doing in reason');
            await this.tasks.comment(org.id, t.id, { text: `Abandoned by its owner: ${reason}`, fromAgentId: agentId, runId: ctx?.runId ?? null, wake: false });
            t = await this.tasks.update(org.id, t.id, { status: 'cancelled' }, actor);
            break;
          }
          case 'done': {
            const models = new Map((await this.agents.list()).map((a) => [a.id, { provider: a.provider, model: a.model }]));
            t = await this.tasks.requestReview(org.id, t.id, { note: reason || str('note') || undefined, fromAgentId: agentId, runId: ctx?.runId ?? null, agentModels: models });
            if (ctx) ctx.progress = true;
            return t.status === 'done' ? `Task ${taskRef(t)} passed its checks and is done.` : `Task ${taskRef(t)} is in review (company tasks finish through review, not by setting done).`;
          }
          default: throw new Error('status must be todo, doing, blocked, done or abandoned');
        }
        if (ctx) ctx.progress = true;
        return `Task ${taskRef(t)} is now (${kanbanStatus(t.status)}) ${t.title}`;
      }
      case 'delegate_task': {
        const target = await this.memberRef(org.id, str('agent')).catch(() => null);
        if (!target) throw new Error(`no member named "${str('agent')}" in ${org.name} — delegate to a colleague of the company, or create the task with org_create_task for the chief to triage`);
        const me = await this.agents.get(agentId).catch(() => null);
        const t = await this.tasks.create(org.id, {
          title: str('title'), brief: { outcome: str('title'), context: `Delegated by ${me?.name ?? 'a member'}.${str('note') ? ` ${str('note')}` : ''}`, constraints: '', done_when: '' },
          assigneeAgentId: target, status: 'backlog', createdBy: actor, source: 'agent', parentTaskId: ctx?.taskId || null,
        }).catch((err: unknown) => { throw new Error(err instanceof Error ? err.message : String(err)); });
        const targetName = (await this.agents.get(target).catch(() => null))?.name ?? 'the member';
        await this.agents.addEvent(target, { kind: 'info', title: `${me?.name ?? 'A member'} delegated: ${t.title}`.slice(0, 200), body: str('note').slice(0, 300), sessionId: session.id, origin: 'org' }).catch(() => undefined);
        return `Task ${taskRef(t)} is on ${targetName}'s company board (backlog, theirs).`;
      }
    }
    throw new Error(`unknown tool: ${name}`);
  }
}

function kanbanStatus(s: string): string {
  return ({ in_progress: 'doing', claimed: 'doing', cancelled: 'abandoned' } as Record<string, string>)[s] ?? s.replace(/_/g, ' ');
}

function describeSteps(t: OrgTask): string {
  const steps = parseSteps(t.steps).filter((x) => !x.dropped);
  return `${taskRef(t)} steps (${steps.filter((x) => x.done).length}/${steps.length}):${steps.length ? `\n${steps.map((x) => `${x.done ? '[x]' : '[ ]'} ${x.id} ${x.text}`).join('\n')}` : ' none'}`;
}

export { BLOCKED_KINDS };
