/**
 * OrgProjectTeamsService — cross-functional project teams
 * (docs/work-tracking.md "Project teams"). A project is led by one owner
 * (a Program Manager by default) and staffed with a **team** drawn from any
 * unit: the matrix. A member keeps its home unit and its head; the project
 * borrows a share of its time.
 *
 *  - **Team rows** (`org_project_members`): a member (an agent, or a person),
 *    its role on the project (engineer, designer, analyst, …) and its
 *    allocation in percent. A member's live allocations (active + pending)
 *    across projects that are not done or cancelled sum to at most 100.
 *  - **Allocation approval.** Adding a member is the member's own manager's
 *    call: a `project_allocation` card routed (decision routing,
 *    docs/owners-seat.md §7) to the *member's* manager, whoever asked. When
 *    the asker is that manager, the chief, or a person, it applies at once.
 *    A rejected card drops the pending row.
 *  - **Assignment.** A project task may be assigned to any active team member
 *    regardless of unit, by the project's lead (OrgRuntimeService consults
 *    `mayAssign`); everything else in a member's unit stays its head's.
 *  - **Channel and cadence.** The first active member opens the project
 *    channel `#p-<key>` (the lead and the team as members, the people of the
 *    org as in unit channels); the project standup is a five-field cron on
 *    the project, fired through the meetings machinery
 *    (OrgMeetingRuntime.addDueMeetings) in that channel with the team as
 *    attendees and the lead facilitating; it skips itself when the project
 *    has no open task.
 *
 * Model-free. Every write is audited.
 */
import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { AgentsService } from '../agents/agents.service';
import { OrgService, type Organization, type OrgProject, type OrgProjectMember } from './org.service';
import { OrgApprovalsService } from './org-approvals.service';
import { OrgAuditService } from './org-audit.service';
import { OrgAnnouncer } from './org-announcer';
import { OrgTasksService } from './org-tasks.service';
import { OrgUnitsService } from './org-units.service';
import { OrgDecisionsService } from './org-decisions.service';
import { OrgProjectsService } from './org-projects.service';
import { OrgMeetingRuntime, type DueMeeting } from './org-meeting-runtime.service';
import { isValidCron, nextCronAfter } from './org-meetings.service';
import { holderAgent } from './decision-routing';
import { taskRef } from '../common/task-keys';

const LIVE = new Set(['active', 'pending']);
const OPEN = new Set(['backlog', 'waiting', 'todo', 'claimed', 'in_progress', 'in_review', 'blocked']);
const CLOSED_PROJECT = new Set(['done', 'cancelled']);

export interface TeamMemberView {
  id: string;
  kind: 'agent' | 'person';
  agentId: string | null; humanId: string | null;
  name: string; title: string;
  role: string; allocation: number; status: string;
  /** The member's home unit (the unit its manager leads, or the one it leads). */
  homeUnit: { id: string; name: string; slug: string } | null;
  /** Its manager — who approved (or must approve) the allocation. */
  managerName: string;
  /** Its live allocation across every open project (this one included). */
  totalAllocation: number;
  openTasks: number;
  approvalId: string | null;
  joinedAt: string;
}

export interface ProjectTeam {
  projectId: string; key: string | null; title: string;
  lead: { agentId: string | null; name: string };
  channel: { id: string; slug: string } | null;
  standup: { cron: string; nextAt: string | null; lastAt: string | null };
  members: TeamMemberView[];
  /** The home units the team spans (cross-functional at a glance). */
  units: string[];
}

@Injectable()
export class OrgProjectTeamsService {
  constructor(
    private readonly org: OrgService,
    private readonly approvals: OrgApprovalsService,
    private readonly audit: OrgAuditService,
    private readonly agents: AgentsService,
    private readonly tasks: OrgTasksService,
    private readonly projects: OrgProjectsService,
    private readonly announcer: OrgAnnouncer,
    @Optional() private readonly units?: OrgUnitsService,
    @Optional() private readonly decisions?: OrgDecisionsService,
    @Optional() meetings?: OrgMeetingRuntime,
  ) {
    approvals.onApply('project_allocation', async (orgId, payload) => this.applyAllocation(orgId, String(payload.memberRowId ?? ''), 'user'));
    approvals.onDecided(async ({ orgId, approval, decision }) => {
      if (approval.kind !== 'project_allocation' || decision === 'approve') return;
      const payload = JSON.parse(approval.payload || '{}') as Record<string, unknown>;
      const row = await this.org.projectMember(orgId, String(payload.memberRowId ?? '')).catch(() => null);
      if (row && row.status === 'pending') await this.org.updateProjectMember(orgId, row.id, { status: 'left', leftAt: new Date().toISOString() });
    });
    meetings?.addDueMeetings((org, now) => this.dueStandups(org, now));
  }

  // ---- reads ----

  /** The live allocation of a member across open projects (active + pending rows). */
  async allocationOf(orgId: string, agentId: string, opts: { excludeRowId?: string } = {}): Promise<number> {
    const open = new Set((await this.org.projects(orgId)).filter((p) => !CLOSED_PROJECT.has(p.status)).map((p) => p.id));
    return (await this.org.projectMembers(orgId))
      .filter((r) => r.agentId === agentId && LIVE.has(r.status) && open.has(r.projectId) && r.id !== opts.excludeRowId)
      .reduce((sum, r) => sum + r.allocation, 0);
  }

  /** Live team rows of a project (active and pending). */
  async rows(orgId: string, projectId: string): Promise<OrgProjectMember[]> {
    return (await this.org.projectMembers(orgId, projectId)).filter((r) => LIVE.has(r.status));
  }

  /** Whether `agentId` is an active member of the project's team. */
  async isActiveMember(orgId: string, projectId: string, agentId: string): Promise<boolean> {
    return (await this.org.projectMembers(orgId, projectId)).some((r) => r.agentId === agentId && r.status === 'active');
  }

  /**
   * Whether `actorId` may assign this project's task to `assigneeId` as the
   * project's lead: the assignee is the lead itself or an active member of
   * its team (any unit — the allocation is the permission).
   */
  async mayAssign(orgId: string, projectId: string | null, actorId: string, assigneeId: string): Promise<boolean> {
    if (!projectId) return false;
    const p = await this.org.project(orgId, projectId).catch(() => null);
    if (!p || p.kind !== 'project' || p.ownerAgentId !== actorId) return false;
    return assigneeId === actorId || this.isActiveMember(orgId, projectId, assigneeId);
  }

  /** Whether the agent leads a project that has an active team (it is offered org_assign). */
  async leadsTeam(orgId: string, agentId: string): Promise<boolean> {
    const led = new Set((await this.org.projects(orgId)).filter((p) => p.ownerAgentId === agentId && p.kind === 'project' && !CLOSED_PROJECT.has(p.status)).map((p) => p.id));
    if (led.size === 0) return false;
    return (await this.org.projectMembers(orgId)).some((r) => led.has(r.projectId) && r.status === 'active');
  }

  async team(orgId: string, ref: string): Promise<ProjectTeam> {
    const p = await this.projects.resolve(orgId, ref);
    const names = new Map((await this.agents.list()).map((a) => [a.id, a.name]));
    const members = await this.org.members(orgId);
    const humans = await this.org.humans(orgId).catch(() => []);
    const units = this.units ? await this.units.units(orgId).catch(() => []) : [];
    const all = await this.tasks.list(orgId);
    const rows = await this.rows(orgId, p.id);
    const out: TeamMemberView[] = [];
    for (const r of rows) {
      const m = r.agentId ? members.find((x) => x.agentId === r.agentId) : undefined;
      const h = r.humanId ? humans.find((x) => x.memberAccountId === r.humanId) : undefined;
      const home = r.agentId ? this.homeUnitOf(r.agentId, members, units) : null;
      const mgr = m?.reportsToAgentId ? names.get(m.reportsToAgentId) ?? m.reportsToAgentId.slice(0, 8) : m ? 'the CEO' : 'their manager';
      out.push({
        id: r.id, kind: r.agentId ? 'agent' : 'person', agentId: r.agentId, humanId: r.humanId,
        name: r.agentId ? names.get(r.agentId) ?? r.agentId.slice(0, 8) : h?.title || 'a person', title: m?.title ?? h?.title ?? '',
        role: r.role, allocation: r.allocation, status: r.status,
        homeUnit: home ? { id: home.id, name: home.name, slug: home.slug } : null,
        managerName: mgr,
        totalAllocation: r.agentId ? await this.allocationOf(orgId, r.agentId) : r.allocation,
        openTasks: all.filter((t) => t.projectId === p.id && OPEN.has(t.status) && ((r.agentId && t.assigneeAgentId === r.agentId) || (r.humanId && t.assigneeHumanId === r.humanId))).length,
        approvalId: r.approvalId, joinedAt: r.joinedAt,
      });
    }
    const channel = p.channelId ? await this.announcer.meetings?.channelInfo(p.channelId).catch(() => null) : null;
    return {
      projectId: p.id, key: p.key, title: p.title,
      lead: { agentId: p.ownerAgentId, name: p.ownerAgentId ? names.get(p.ownerAgentId) ?? p.ownerAgentId.slice(0, 8) : 'nobody' },
      channel: p.channelId ? { id: p.channelId, slug: channel?.slug ?? `p-${(p.key ?? '').toLowerCase()}` } : null,
      standup: { cron: p.standupCron, nextAt: p.standupNextAt, lastAt: p.standupLastAt },
      members: out,
      units: [...new Set(out.map((x) => x.homeUnit?.name).filter((x): x is string => Boolean(x)))],
    };
  }

  /** The one-paragraph team block of org_project. */
  async describe(orgId: string, ref: string): Promise<string> {
    const t = await this.team(orgId, ref);
    if (t.members.length === 0) return `Team: none yet — the lead proposes members with org_project_add_member (their heads approve the allocation).`;
    return [
      `Team (${t.members.length}, across ${t.units.length || 1} unit(s): ${t.units.join(', ') || 'one unit'}):`,
      ...t.members.map((m) => `- ${m.name}${m.title ? ` (${m.title})` : ''} — ${m.role || 'member'}, ${m.allocation}%${m.status === 'pending' ? ' (PENDING: its head decides the allocation)' : ''}; home ${m.homeUnit?.name ?? 'the company'}, manager ${m.managerName}; ${m.totalAllocation}% allocated across projects; ${m.openTasks} open task(s) here`),
      t.channel ? `Channel #${t.channel.slug}; standup ${t.standup.cron || 'not set (org_project_standup)'}.` : 'No channel yet (it opens with the first active member).',
    ].join('\n');
  }

  // ---- writes ----

  /** May the actor change this project's team: its lead, the lead's managers, the chief, or a person. */
  private async requireSteward(orgId: string, p: OrgProject, actor: string): Promise<void> {
    if (!actor.startsWith('agent:') && actor !== 'chief') return;
    const org = await this.org.get(orgId);
    const me = actor === 'chief' ? org.chiefOfStaffAgentId : actor.slice('agent:'.length);
    if (me === org.chiefOfStaffAgentId || (me && p.ownerAgentId === me)) return;
    if (me && p.ownerAgentId && (await this.projects.managerChain(orgId, p.ownerAgentId)).includes(me)) return;
    throw new BadRequestException(`refused: only the lead of ${p.key}, its managers or the chief of staff staff its team — ask the lead (org_task_comment) instead`);
  }

  /**
   * Propose a member for a project's team. Applies at once when the asker is
   * the member's manager, the chief, a person or the member itself being the
   * lead; otherwise a pending row and a `project_allocation` card routed to
   * the member's manager.
   */
  async propose(orgId: string, ref: string, input: { agentId: string; role?: string; allocation: number; why?: string }, actor: string): Promise<{ row: OrgProjectMember; approvalId: string | null; note: string }> {
    const p = await this.projects.resolve(orgId, ref);
    if (p.kind !== 'project') throw new BadRequestException(`refused: ${p.key} is a system project; teams are for real projects`);
    if (CLOSED_PROJECT.has(p.status)) throw new BadRequestException(`refused: ${p.key} is ${p.status}`);
    await this.requireSteward(orgId, p, actor);
    const org = await this.org.get(orgId);
    const m = await this.org.member(orgId, input.agentId);
    if (!m || m.status !== 'active') throw new BadRequestException('refused: the member must be an active member of this organization');
    if (org.auditorAgentId === input.agentId) throw new BadRequestException('refused: the auditor stays independent of the work it audits; it joins no project team');
    const allocation = Math.round(Number(input.allocation));
    if (!Number.isFinite(allocation) || allocation < 1 || allocation > 100) throw new BadRequestException('allocation is a percent of the member\'s time: 1–100');
    const existing = (await this.org.projectMembers(orgId, p.id)).find((r) => r.agentId === input.agentId && LIVE.has(r.status));
    if (existing) throw new BadRequestException(`refused: ${(await this.nameOf(input.agentId))} is already on ${p.key}'s team (${existing.status}, ${existing.allocation}%) — change it by removing and re-adding`);
    const held = await this.allocationOf(orgId, input.agentId);
    if (held + allocation > 100) throw new BadRequestException(`refused: ${await this.nameOf(input.agentId)} is already allocated ${held}% across projects; ${allocation}% more would exceed 100% — lower the allocation, or ask its head to free time on another project first`);
    // Who decides: the member's manager (decision routing), unless that is the asker.
    const me = actor === 'chief' ? org.chiefOfStaffAgentId : actor.startsWith('agent:') ? actor.slice('agent:'.length) : null;
    const route = this.decisions ? await this.decisions.routeDecision(orgId, input.agentId, 'project_allocation', {}).catch(() => null) : null;
    const managerAgent = route ? holderAgent(route.holder) : m.reportsToAgentId;
    const direct = !me || me === org.chiefOfStaffAgentId || me === managerAgent || (me === input.agentId && p.ownerAgentId === me);
    const name = await this.nameOf(input.agentId);
    if (direct) {
      const row = await this.org.addProjectMember(orgId, { projectId: p.id, agentId: input.agentId, role: input.role, allocation, status: 'active', addedBy: actor });
      await this.audit.append(orgId, { actor, action: 'project_member_add', refType: 'project', refId: p.id, payload: { key: p.key, agentId: input.agentId, role: row.role, allocation, why: (input.why ?? '').slice(0, 300) } });
      await this.joined(orgId, p, row);
      return { row, approvalId: null, note: `${name} joined ${p.key}'s team as ${row.role || 'member'} at ${allocation}% (now ${held + allocation}% allocated across projects).` };
    }
    const row = await this.org.addProjectMember(orgId, { projectId: p.id, agentId: input.agentId, role: input.role, allocation, status: 'pending', addedBy: actor });
    const a = await this.approvals.create(orgId, {
      kind: 'project_allocation', requestedBy: actor, recommendation: (input.why ?? '').slice(0, 600),
      payload: { projectId: p.id, projectKey: p.key, title: p.title, memberRowId: row.id, agentId: input.agentId, agentName: name, role: row.role, allocation, totalAfter: held + allocation, routeAsAgentId: input.agentId },
      card: { recommendedAction: 'approve' },
    });
    await this.org.updateProjectMember(orgId, row.id, { approvalId: a.id });
    await this.audit.append(orgId, { actor, action: 'project_member_propose', refType: 'project', refId: p.id, payload: { key: p.key, agentId: input.agentId, role: row.role, allocation, approvalId: a.id } });
    const holderName = route?.holderName ?? 'its manager';
    return { row: { ...row, approvalId: a.id }, approvalId: a.id, note: `Proposed ${name} for ${p.key}'s team as ${row.role || 'member'} at ${allocation}%: allocation card ${a.id.slice(0, 8)} is with ${holderName} (its manager decides; you are told). It is pending until then.` };
  }

  /**
   * Seat a member at once on the decider's authority — a head approving a
   * Program Manager's resource request for its own people, or a manager
   * granting a resource conflict (OrgProgramService, docs/work-tracking.md
   * "Resource requests"). The 100% cap holds; the channel and the member's
   * inbox are told as for any join. A live seat of the member on the project
   * is resized instead of duplicated.
   */
  async grant(orgId: string, projectId: string, input: { agentId: string; role?: string; allocation: number; why?: string }, actor: string): Promise<OrgProjectMember> {
    const p = await this.org.project(orgId, projectId);
    if (p.kind !== 'project' || CLOSED_PROJECT.has(p.status)) throw new BadRequestException(`refused: ${p.key} takes no team (${p.kind === 'project' ? p.status : 'a system project'})`);
    const org = await this.org.get(orgId);
    const m = await this.org.member(orgId, input.agentId);
    if (!m || m.status !== 'active') throw new BadRequestException('refused: the member must be an active member of this organization');
    if (org.auditorAgentId === input.agentId) throw new BadRequestException('refused: the auditor stays independent of the work it audits; it joins no project team');
    const allocation = Math.round(Number(input.allocation));
    if (!Number.isFinite(allocation) || allocation < 1 || allocation > 100) throw new BadRequestException('allocation is a percent of the member\'s time: 1–100');
    const existing = (await this.org.projectMembers(orgId, p.id)).find((r) => r.agentId === input.agentId && LIVE.has(r.status));
    const held = await this.allocationOf(orgId, input.agentId, { excludeRowId: existing?.id });
    if (held + allocation > 100) throw new BadRequestException(`refused: ${await this.nameOf(input.agentId)} is already allocated ${held}% across projects; ${allocation}% more would exceed 100% — free time on another project first, or grant less`);
    if (existing) {
      const row = await this.org.updateProjectMember(orgId, existing.id, { allocation, status: 'active', ...(input.role ? { role: input.role.slice(0, 80) } : {}) });
      await this.audit.append(orgId, { actor, action: 'project_member_add', refType: 'project', refId: p.id, payload: { key: p.key, agentId: input.agentId, role: row.role, allocation, resized: true, why: (input.why ?? '').slice(0, 300) } });
      if (existing.status === 'pending') await this.joined(orgId, p, row);
      return row;
    }
    const row = await this.org.addProjectMember(orgId, { projectId: p.id, agentId: input.agentId, role: input.role, allocation, status: 'active', addedBy: actor });
    await this.audit.append(orgId, { actor, action: 'project_member_add', refType: 'project', refId: p.id, payload: { key: p.key, agentId: input.agentId, role: row.role, allocation, why: (input.why ?? '').slice(0, 300) } });
    await this.joined(orgId, p, row);
    return row;
  }

  /** The approved card's applier: the pending row becomes active. */
  async applyAllocation(orgId: string, rowId: string, actor: string): Promise<Record<string, unknown>> {
    const row = await this.org.projectMember(orgId, rowId);
    if (row.status === 'active') return { memberRowId: row.id, status: 'active' };
    if (row.status !== 'pending') throw new BadRequestException(`the team row is ${row.status}`);
    const p = await this.org.project(orgId, row.projectId);
    if (row.agentId) {
      const held = await this.allocationOf(orgId, row.agentId, { excludeRowId: row.id });
      if (held + row.allocation > 100) throw new BadRequestException(`the member is now allocated ${held}% elsewhere; ${row.allocation}% more would exceed 100%`);
    }
    const active = await this.org.updateProjectMember(orgId, row.id, { status: 'active' });
    await this.audit.append(orgId, { actor, action: 'project_member_add', refType: 'project', refId: p.id, payload: { key: p.key, agentId: row.agentId, role: row.role, allocation: row.allocation, approvalId: row.approvalId } });
    await this.joined(orgId, p, active);
    return { memberRowId: row.id, status: 'active' };
  }

  /** Release a member from a project (the lead, its managers, the chief, the member's own manager, or a person). */
  async remove(orgId: string, ref: string, agentId: string, actor: string, why = ''): Promise<{ note: string }> {
    const p = await this.projects.resolve(orgId, ref);
    const row = (await this.org.projectMembers(orgId, p.id)).find((r) => r.agentId === agentId && LIVE.has(r.status));
    if (!row) throw new BadRequestException(`refused: ${await this.nameOf(agentId)} is not on ${p.key}'s team`);
    const org = await this.org.get(orgId);
    const me = actor === 'chief' ? org.chiefOfStaffAgentId : actor.startsWith('agent:') ? actor.slice('agent:'.length) : null;
    const m = await this.org.member(orgId, agentId);
    if (!(me && m?.reportsToAgentId === me)) await this.requireSteward(orgId, p, actor);
    await this.org.updateProjectMember(orgId, row.id, { status: 'left', leftAt: new Date().toISOString() });
    await this.audit.append(orgId, { actor, action: 'project_member_remove', refType: 'project', refId: p.id, payload: { key: p.key, agentId, why: why.slice(0, 300) } });
    if (p.channelId && agentId !== p.ownerAgentId) await this.announcer.channels?.removeChannelMember(p.channelId, 'agent', agentId).catch(() => undefined);
    if (p.channelId) await this.announcer.channels?.postSystem(p.channelId, `${await this.nameOf(agentId)} left the ${p.key} team${why ? `: ${why}` : ''}.`).catch(() => undefined);
    return { note: `${await this.nameOf(agentId)} left ${p.key}'s team; its ${row.allocation}% is back with its unit.` };
  }

  /** Set (or switch off with null) the project standup's cron. */
  async setStandup(orgId: string, ref: string, cron: string | null, actor: string): Promise<OrgProject> {
    const p = await this.projects.resolve(orgId, ref);
    await this.requireSteward(orgId, p, actor);
    if (cron !== null && !isValidCron(cron)) throw new BadRequestException('cron must have five fields: minute hour day-of-month month day-of-week');
    const out = await this.org.updateProjectRitual(orgId, p.id, { standupCron: cron?.trim() ?? '', standupNextAt: cron ? nextCronAfter(cron.trim(), new Date())?.toISOString() ?? null : null });
    await this.audit.append(orgId, { actor, action: 'project_standup', refType: 'project', refId: p.id, payload: { key: p.key, cron } });
    if (cron) await this.ensureChannel(orgId, out).catch(() => undefined);
    return out;
  }

  // ---- channel and the standup ----

  /** The project channel `#p-<key>`: the lead and the active team, the org's people. */
  async ensureChannel(orgId: string, p: OrgProject): Promise<string | null> {
    const ch = this.announcer.channels;
    if (!ch) return null;
    const org = await this.org.get(orgId);
    const team = (await this.org.projectMembers(orgId, p.id)).filter((r) => r.status === 'active');
    const agentIds = [...new Set([p.ownerAgentId, ...team.map((r) => r.agentId)].filter((x): x is string => Boolean(x)))];
    const humanIds = [...new Set([...(await this.org.humans(orgId).catch(() => [])).filter((h) => h.role === 'ceo' || h.role === 'board').map((h) => h.memberAccountId), ...team.map((r) => r.humanId).filter((x): x is string => Boolean(x))])];
    if (p.channelId) {
      const have = new Set((await ch.channelMembers(p.channelId).catch(() => [])).filter((x) => x.kind === 'agent').map((x) => x.id));
      for (const id of agentIds) if (!have.has(id)) await ch.addChannelMember(p.channelId, 'agent', id).catch(() => undefined);
      return p.channelId;
    }
    const slug = `p-${(p.key ?? p.id.slice(0, 6)).toLowerCase()}`;
    const made = await ch.ensureUnitChannel(org.workspaceId, slug, slug, { topic: `Project ${p.key} "${p.title}": its cross-functional team, standups and decisions.`, agentIds, humanIds });
    await this.org.updateProjectRitual(orgId, p.id, { channelId: made.id });
    await this.audit.append(orgId, { actor: 'system', action: 'project_channel', refType: 'project', refId: p.id, payload: { key: p.key, channelId: made.id, slug: made.slug } });
    return made.id;
  }

  private async joined(orgId: string, p: OrgProject, row: OrgProjectMember): Promise<void> {
    const fresh = await this.org.project(orgId, p.id);
    const channelId = await this.ensureChannel(orgId, fresh).catch(() => null);
    const who = row.agentId ? await this.nameOf(row.agentId) : 'A person';
    if (channelId) await this.announcer.channels?.postSystem(channelId, `${who} joined the ${p.key} team as ${row.role || 'member'} (${row.allocation}%).`).catch(() => undefined);
    if (row.agentId) {
      await this.agents.addEvent(row.agentId, { kind: 'info', title: `You joined project ${p.key} "${p.title}" as ${row.role || 'member'} (${row.allocation}%)`.slice(0, 200), body: `Its lead assigns you its tasks; your head keeps the rest of your work. org_project ${p.key} shows the brief and the team.`, payload: JSON.stringify({ orgId, projectId: p.id }), origin: 'org' }).catch(() => undefined);
    }
  }

  /** The project standups due at `now` (OrgMeetingRuntime's tick). */
  async dueStandups(org: Organization, now: Date): Promise<DueMeeting[]> {
    const out: DueMeeting[] = [];
    const names = new Map((await this.agents.list()).map((a) => [a.id, a.name]));
    for (const p of await this.org.projects(org.id)) {
      if (p.kind !== 'project' || !p.standupCron || CLOSED_PROJECT.has(p.status) || !p.ownerAgentId) continue;
      if (!p.standupNextAt || p.standupNextAt > now.toISOString()) continue;
      const next = nextCronAfter(p.standupCron, now)?.toISOString() ?? null;
      await this.org.updateProjectRitual(org.id, p.id, { standupLastAt: now.toISOString(), standupNextAt: next });
      const team = (await this.org.projectMembers(org.id, p.id)).filter((r) => r.status === 'active' && r.agentId);
      if (team.length === 0) continue;
      const channelId = p.channelId ?? await this.ensureChannel(org.id, p).catch(() => null);
      if (!channelId) continue;
      const open = (await this.tasks.list(org.id, { projectId: p.id })).filter((t) => OPEN.has(t.status));
      if (open.length === 0) {
        await this.audit.append(org.id, { actor: 'system', action: 'meeting_skipped', refType: 'project', refId: p.id, payload: { kind: 'standup', reason: 'no open task in the project' } });
        continue;
      }
      const byMember = [p.ownerAgentId, ...team.map((r) => r.agentId!)].filter((x, i, a) => a.indexOf(x) === i).map((id) => {
        const mine = open.filter((t) => t.assigneeAgentId === id);
        return `- ${names.get(id) ?? id.slice(0, 8)}: ${mine.length ? mine.slice(0, 5).map((t) => `${taskRef(t)} ${t.title} (${t.status.replace('_', ' ')})`).join('; ') : 'no open task here'}`;
      });
      const unassigned = open.filter((t) => !t.assigneeAgentId).length;
      out.push({
        kind: 'standup', channelId, title: `${p.key} standup`, facilitatorAgentId: p.ownerAgentId, createdBy: 'project',
        attendees: [p.ownerAgentId, ...team.map((r) => r.agentId!)].filter((x, i, a) => a.indexOf(x) === i).map((id) => ({ kind: 'agent' as const, id })),
        agenda: [`Project ${p.key} "${p.title}" — what moved, what is next, what blocks it, by member:`, ...byMember, unassigned ? `${unassigned} open task(s) unassigned: the lead assigns them to the team.` : ''].filter(Boolean).join('\n'),
      });
    }
    return out;
  }

  private async nameOf(agentId: string): Promise<string> {
    return (await this.agents.get(agentId).catch(() => null))?.name ?? agentId.slice(0, 8);
  }

  private homeUnitOf(agentId: string, members: Array<{ agentId: string; reportsToAgentId: string | null }>, units: Array<{ id: string; name: string; slug: string; leadAgentId: string; parentUnitId: string | null }>) {
    const led = units.find((u) => u.leadAgentId === agentId && u.parentUnitId !== null);
    if (led) return led;
    let cur = members.find((m) => m.agentId === agentId)?.reportsToAgentId ?? null;
    for (let i = 0; cur && i < 10; i++) {
      const u = units.find((x) => x.leadAgentId === cur);
      if (u) return u;
      cur = members.find((m) => m.agentId === cur)?.reportsToAgentId ?? null;
    }
    return units.find((u) => u.parentUnitId === null) ?? null;
  }
}
