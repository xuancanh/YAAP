/**
 * OrgUnitsService — a board, a channel and a goal tracker per org level
 * (docs/group-chat.md §7, execution-plan item 17).
 *
 * Every member with at least one direct report leads a unit; the root unit
 * is the company, led by the chief of staff, with `#company` as its channel.
 * Units are derived from the org chart, never edited by hand (a rename is
 * the one exception): `syncMembership` recomputes them after every structural
 * change — OrgService calls it through `onStructureChange` after a hire, a
 * reorg, a termination, enrolment and a chief swap — creating a unit (and its
 * `#<slug>` channel with lead + direct reports + the human CEO and board)
 * when a member gains its first report, archiving it (data kept, channel
 * archived) when its last report leaves, un-archiving the same row when the
 * lead gains reports again (one row per (org, lead), ever), and keeping every
 * unit channel's membership equal to the chart.
 *
 * Boards: `defaultUnitId` is the rule tasks follow — the unit led by the
 * assignee's manager, so a lead's own tasks sit on its parent's board and
 * the tasks it hands to reports sit on its own. Goals: `goalProgress` is
 * done/total of the tasks linked through the goal's projects, blended with
 * the mean progress of its child goals. The channel operations go through
 * the `UnitChannels` seam on OrgAnnouncer (the group chat binds it), so this
 * module compiles and tests without the group chat.
 */
import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { orgProjects, orgTasks, orgUnits } from '../database/schema';
import { newId, nowIso } from '../common/ids.util';
import { currentAccountId } from '../accounts/account-context';
import { AgentsService } from '../agents/agents.service';
import { OrgService, type GoalIntentFields, type OrgGoal, type OrgMember } from './org.service';
import { OrgAuditService } from './org-audit.service';
import { OrgAnnouncer } from './org-announcer';

export type OrgUnit = typeof orgUnits.$inferSelect;

export const ROOT_UNIT_SLUG = 'company';

export interface UnitNode {
  id: string; orgId: string; leadAgentId: string; parentUnitId: string | null; name: string; slug: string; channelId: string | null; archivedAt: string | null; createdAt: string;
  /** The lead plus its active direct reports. */
  memberAgentIds: string[];
  counts: { openTasks: number; tasks: number; goals: number };
  children: UnitNode[];
}

export interface GoalNode extends OrgGoal {
  /** 0..1 — done/total of linked tasks blended with the mean of the children. */
  progress: number;
  tasks: { total: number; done: number };
  children: GoalNode[];
}

/** Slug of a unit from its lead's name (mirrors groupchat/mentions.ts slugify). */
export function unitSlug(name: string): string {
  const s = name.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return s || 'unit';
}

/** The §7 progress formula, pure so the test can pin it: tasks' done/total
 *  and the children's mean, averaged when both exist. */
export function blendProgress(tasks: { total: number; done: number }, children: number[]): number {
  const t = tasks.total > 0 ? tasks.done / tasks.total : null;
  const c = children.length > 0 ? children.reduce((a, b) => a + b, 0) / children.length : null;
  if (t !== null && c !== null) return (t + c) / 2;
  return t ?? c ?? 0;
}

@Injectable()
export class OrgUnitsService {
  private readonly logger = new Logger(OrgUnitsService.name);

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly org: OrgService,
    private readonly agents: AgentsService,
    private readonly audit: OrgAuditService,
    private readonly announcer: OrgAnnouncer,
  ) {
    this.org.onStructureChange((orgId) => this.syncMembership(orgId));
  }

  // ---- reads ----

  async units(orgId: string, opts: { archived?: boolean } = {}): Promise<OrgUnit[]> {
    const rows = await this.db.select().from(orgUnits).where(eq(orgUnits.orgId, orgId));
    return rows.filter((u) => (opts.archived ? true : u.archivedAt === null)).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }

  async get(orgId: string, unitId: string): Promise<OrgUnit> {
    const u = (await this.db.select().from(orgUnits).where(and(eq(orgUnits.orgId, orgId), eq(orgUnits.id, unitId))).limit(1)).at(0);
    if (!u) throw new NotFoundException(`unit ${unitId}`);
    return u;
  }

  /** The unit `agentId` leads (live), or null. */
  async ledBy(orgId: string, agentId: string): Promise<OrgUnit | null> {
    return (await this.units(orgId)).find((u) => u.leadAgentId === agentId) ?? null;
  }

  /** Whether `agentId` leads a non-root unit (the chief has the company set). */
  async isLead(orgId: string, agentId: string): Promise<OrgUnit | null> {
    const u = await this.ledBy(orgId, agentId);
    return u && u.parentUnitId !== null ? u : null;
  }

  /** The root unit, created on first use when the org has a chief. */
  async rootUnit(orgId: string): Promise<OrgUnit> {
    const live = (await this.units(orgId)).find((u) => u.parentUnitId === null);
    if (live) return live;
    const org = await this.org.get(orgId);
    if (!org.chiefOfStaffAgentId) throw new BadRequestException('the organization has no chief of staff, so no root unit');
    return this.ensureUnitFor(orgId, org.chiefOfStaffAgentId);
  }

  /** The unit a task or goal of `agentId` belongs to by default: the one led
   *  by its manager (walking up to the nearest unit-leading manager); the
   *  chief and root-level members land in the root unit. */
  async unitForAssignee(orgId: string, agentId: string | null | undefined): Promise<OrgUnit> {
    const root = await this.rootUnit(orgId);
    if (!agentId) return root;
    const members = await this.org.members(orgId);
    const units = await this.units(orgId);
    const byAgent = new Map(members.map((m) => [m.agentId, m]));
    let cur = byAgent.get(agentId)?.reportsToAgentId ?? null;
    for (let i = 0; cur && i < 10; i++) {
      const u = units.find((x) => x.leadAgentId === cur);
      if (u) return u;
      cur = byAgent.get(cur)?.reportsToAgentId ?? null;
    }
    return root;
  }

  /** The default unit for a new task (docs/group-chat.md §7): by the
   *  assignee when there is one; an unassigned task created by a lead sits on
   *  that lead's own board, one created by any other agent on its manager's;
   *  everything else is the company's. */
  async defaultUnitId(orgId: string, input: { assigneeAgentId?: string | null; createdBy?: string }): Promise<string> {
    if (input.assigneeAgentId) return (await this.unitForAssignee(orgId, input.assigneeAgentId)).id;
    const creator = input.createdBy?.startsWith('agent:') ? input.createdBy.slice(6) : input.createdBy === 'chief' ? (await this.org.get(orgId)).chiefOfStaffAgentId : null;
    if (creator) {
      const led = await this.ledBy(orgId, creator);
      if (led) return led.id;
      return (await this.unitForAssignee(orgId, creator)).id;
    }
    return (await this.rootUnit(orgId)).id;
  }

  /** Root → … → unit, as ids. */
  async ancestry(orgId: string, unitId: string): Promise<string[]> {
    const all = await this.units(orgId, { archived: true });
    const out: string[] = [];
    let cur = all.find((u) => u.id === unitId);
    for (let i = 0; cur && i < 10; i++) { out.unshift(cur.id); cur = cur.parentUnitId ? all.find((u) => u.id === cur!.parentUnitId) : undefined; }
    return out;
  }

  /** The unit and every live unit below it, as ids. */
  async subtree(orgId: string, unitId: string): Promise<string[]> {
    const all = await this.units(orgId);
    const out = [unitId];
    for (let i = 0; i < out.length; i++) for (const u of all) if (u.parentUnitId === out[i] && !out.includes(u.id)) out.push(u.id);
    return out;
  }

  // ---- structure ----

  /** Create (or un-archive) the unit `leadAgentId` leads, with its channel. */
  async ensureUnitFor(orgId: string, leadAgentId: string): Promise<OrgUnit> {
    const org = await this.org.get(orgId);
    const isRoot = org.chiefOfStaffAgentId === leadAgentId;
    const members = (await this.org.members(orgId)).filter((m) => m.status !== 'terminated');
    const lead = members.find((m) => m.agentId === leadAgentId);
    if (!lead) throw new BadRequestException('a unit lead must be a live member');
    const all = await this.units(orgId, { archived: true });
    const existing = all.find((u) => u.leadAgentId === leadAgentId);
    const agent = await this.agents.get(leadAgentId).catch(() => null);
    const leadName = agent?.name ?? leadAgentId.slice(0, 8);
    const humans = await this.unitHumans(orgId);
    const reports = members.filter((m) => m.reportsToAgentId === leadAgentId).map((m) => m.agentId);
    const channels = this.announcer.channels;
    if (existing) {
      const set: Partial<OrgUnit> = {};
      if (existing.archivedAt) set.archivedAt = null;
      if (isRoot && existing.parentUnitId !== null) set.parentUnitId = null;
      if (!existing.channelId && channels) {
        const ch = isRoot
          ? await channels.companyChannel(org.workspaceId)
          : await channels.ensureUnitChannel(org.workspaceId, existing.slug, existing.name, { topic: `Unit channel of ${existing.name}.`, agentIds: [leadAgentId, ...reports], humanIds: humans });
        set.channelId = ch.id; set.slug = ch.slug;
      } else if (existing.archivedAt && existing.channelId && channels) {
        await channels.updateChannel(existing.channelId, { archived: false }).catch(() => undefined);
      }
      if (Object.keys(set).length > 0) {
        await this.db.update(orgUnits).set(set).where(eq(orgUnits.id, existing.id));
        if (set.archivedAt === null) await this.audit.append(orgId, { actor: 'system', action: 'unit_restore', refType: 'unit', refId: existing.id, payload: { leadAgentId } });
      }
      return { ...existing, ...set };
    }
    const base = isRoot ? ROOT_UNIT_SLUG : unitSlug(leadName);
    let slug = base; for (let n = 2; all.some((u) => u.slug === slug); n++) slug = `${base}-${n}`;
    const name = isRoot ? org.name : `${leadName}'s team`;
    let channelId: string | null = null;
    if (channels) {
      const ch = isRoot
        ? await channels.companyChannel(org.workspaceId)
        : await channels.ensureUnitChannel(org.workspaceId, slug, slug, { topic: `Unit channel of ${name}: ${leadName} and its reports.`, agentIds: [leadAgentId, ...reports], humanIds: humans });
      channelId = ch.id; slug = ch.slug;
    }
    const row: OrgUnit = { accountId: currentAccountId(), id: newId(), orgId, leadAgentId, parentUnitId: null, name, slug, channelId, archivedAt: null, createdAt: nowIso() };
    await this.db.insert(orgUnits).values(row);
    await this.audit.append(orgId, { actor: 'system', action: 'unit_create', refType: 'unit', refId: row.id, payload: { leadAgentId, name, slug, root: isRoot } });
    return row;
  }

  /** Archive a non-root unit whose lead has no live direct reports left (data kept). */
  async archiveIfEmpty(unitId: string): Promise<boolean> {
    const u = (await this.db.select().from(orgUnits).where(eq(orgUnits.id, unitId)).limit(1)).at(0);
    if (!u || u.archivedAt || u.parentUnitId === null) return false;
    const members = (await this.org.members(u.orgId)).filter((m) => m.status !== 'terminated');
    const lead = members.find((m) => m.agentId === u.leadAgentId);
    if (lead && members.some((m) => m.reportsToAgentId === u.leadAgentId)) return false;
    await this.db.update(orgUnits).set({ archivedAt: nowIso() }).where(eq(orgUnits.id, u.id));
    if (u.channelId) {
      const leadName = (await this.agents.get(u.leadAgentId).catch(() => null))?.name ?? u.leadAgentId.slice(0, 8);
      await this.announcer.channels?.postSystem(u.channelId, `Unit archived: ${leadName} has no direct reports left. Messages and files are kept; the channel is read-only until the unit returns.`).catch(() => undefined);
      await this.announcer.channels?.updateChannel(u.channelId, { archived: true }).catch(() => undefined);
    }
    await this.audit.append(u.orgId, { actor: 'system', action: 'unit_archive', refType: 'unit', refId: u.id, payload: { leadAgentId: u.leadAgentId } });
    return true;
  }

  /**
   * Recompute every unit from the reports-to tree and every unit channel's
   * membership. Called after hire, reorg, terminate, enrolment and a chief
   * change (OrgService.onStructureChange). Never throws: a channel failure is
   * logged and the chart stays authoritative.
   */
  async syncMembership(orgId: string): Promise<void> {
    try { await this.sync(orgId); } catch (err) {
      this.logger.warn(`unit sync for org ${orgId} failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async sync(orgId: string): Promise<void> {
    const org = await this.org.get(orgId).catch(() => null);
    if (!org || org.status === 'archived' || !org.chiefOfStaffAgentId) return;
    const chiefId = org.chiefOfStaffAgentId;
    const members = await this.org.members(orgId);
    const live = members.filter((m) => m.status !== 'terminated');
    // 1. The root follows the chief's seat: a chief swap re-roots.
    let all = await this.units(orgId, { archived: true });
    const root = all.find((u) => u.parentUnitId === null && u.archivedAt === null);
    if (root && root.leadAgentId !== chiefId) {
      const clash = all.find((u) => u.leadAgentId === chiefId && u.id !== root.id);
      if (clash) {
        // The new chief's former unit row makes way (unique (org, lead)); its channel is archived.
        await this.db.delete(orgUnits).where(eq(orgUnits.id, clash.id));
        if (clash.channelId) await this.announcer.channels?.updateChannel(clash.channelId, { archived: true }).catch(() => undefined);
      }
      await this.db.update(orgUnits).set({ leadAgentId: chiefId }).where(eq(orgUnits.id, root.id));
      await this.audit.append(orgId, { actor: 'system', action: 'unit_reroot', refType: 'unit', refId: root.id, payload: { previous: root.leadAgentId, leadAgentId: chiefId } });
    }
    await this.rootUnit(orgId);
    // 2. A unit for every live member with live reports.
    const leads = new Set(live.filter((m) => m.reportsToAgentId && live.some((x) => x.agentId === m.reportsToAgentId)).map((m) => m.reportsToAgentId!));
    for (const lead of leads) if (lead !== chiefId) await this.ensureUnitFor(orgId, lead);
    // 3. Archive units whose lead lost every report (or left).
    all = await this.units(orgId);
    for (const u of all) if (u.leadAgentId !== chiefId && !leads.has(u.leadAgentId)) await this.archiveIfEmpty(u.id);
    // 4. Parents: the unit led by the lead's nearest unit-leading manager.
    all = await this.units(orgId);
    const rootNow = all.find((u) => u.leadAgentId === chiefId)!;
    const byAgent = new Map(members.map((m) => [m.agentId, m]));
    for (const u of all) {
      if (u.id === rootNow.id) { if (u.parentUnitId !== null) await this.db.update(orgUnits).set({ parentUnitId: null }).where(eq(orgUnits.id, u.id)); continue; }
      let cur = byAgent.get(u.leadAgentId)?.reportsToAgentId ?? null;
      let parent = rootNow.id;
      for (let i = 0; cur && i < 10; i++) { const p = all.find((x) => x.leadAgentId === cur); if (p) { parent = p.id; break; } cur = byAgent.get(cur)?.reportsToAgentId ?? null; }
      if (u.parentUnitId !== parent) await this.db.update(orgUnits).set({ parentUnitId: parent }).where(eq(orgUnits.id, u.id));
    }
    // 5. Channel membership = the chart.
    const channels = this.announcer.channels;
    if (!channels) return;
    const humans = await this.unitHumans(orgId);
    const terminated = new Set(members.filter((m) => m.status === 'terminated').map((m) => m.agentId));
    for (const u of all) {
      if (!u.channelId) continue;
      const isRoot = u.id === rootNow.id;
      const want = new Set(isRoot ? live.map((m) => m.agentId) : [u.leadAgentId, ...live.filter((m) => m.reportsToAgentId === u.leadAgentId).map((m) => m.agentId)]);
      const current = await channels.channelMembers(u.channelId).catch(() => null);
      if (!current) continue;
      const haveAgents = new Set(current.filter((m) => m.kind === 'agent').map((m) => m.id));
      const haveHumans = new Set(current.filter((m) => m.kind === 'human').map((m) => m.id));
      for (const id of want) if (!haveAgents.has(id)) await channels.addChannelMember(u.channelId, 'agent', id).catch(() => undefined);
      for (const id of haveAgents) if (!want.has(id) && (!isRoot || terminated.has(id))) await channels.removeChannelMember(u.channelId, 'agent', id).catch(() => undefined);
      for (const id of humans) if (!haveHumans.has(id)) await channels.addChannelMember(u.channelId, 'human', id).catch(() => undefined);
    }
  }

  /** The humans every unit channel carries: the owner (CEO by default) and
   *  the org's CEO / board rows. */
  private async unitHumans(orgId: string): Promise<string[]> {
    const out = new Set<string>([currentAccountId()]);
    for (const h of await this.org.humans(orgId).catch(() => [])) if (h.role === 'ceo' || h.role === 'board') out.add(h.memberAccountId);
    return [...out];
  }

  async rename(orgId: string, unitId: string, name: string, actor = 'user'): Promise<OrgUnit> {
    const u = await this.get(orgId, unitId);
    const n = (name ?? '').trim().slice(0, 80);
    if (!n) throw new BadRequestException('name cannot be empty');
    await this.db.update(orgUnits).set({ name: n }).where(eq(orgUnits.id, u.id));
    if (u.channelId && u.parentUnitId !== null) await this.announcer.channels?.updateChannel(u.channelId, { name: n }).catch(() => undefined);
    await this.audit.append(orgId, { actor, action: 'unit_rename', refType: 'unit', refId: u.id, payload: { name: n, previous: u.name } });
    return { ...u, name: n };
  }

  /** One system line into the (non-root) unit channels of `agentIds` — what
   *  an autonomous hire or reorg posts besides `#company`. */
  async announceIn(orgId: string, agentIds: string[], text: string): Promise<string[]> {
    const channels = this.announcer.channels;
    if (!channels) return [];
    const posted: string[] = [];
    const seen = new Set<string>();
    for (const agentId of agentIds) {
      const u = await this.unitForAssignee(orgId, agentId).catch(() => null);
      if (!u || !u.channelId || u.parentUnitId === null || seen.has(u.id)) continue;
      seen.add(u.id);
      await channels.postSystem(u.channelId, text.slice(0, 2_000)).catch(() => undefined);
      posted.push(u.id);
    }
    return posted;
  }

  // ---- the tree, the goals and the report ----

  async unitTree(orgId: string): Promise<UnitNode[]> {
    await this.rootUnit(orgId).catch(() => undefined);
    const units = await this.units(orgId);
    const members = (await this.org.members(orgId)).filter((m) => m.status !== 'terminated');
    const tasks = await this.db.select().from(orgTasks).where(eq(orgTasks.orgId, orgId));
    const goals = await this.org.goals(orgId);
    const root = units.find((u) => u.parentUnitId === null);
    const node = (u: OrgUnit): UnitNode => {
      const isRoot = u.id === root?.id;
      const mine = tasks.filter((t) => (t.unitId ?? root?.id) === u.id);
      return {
        ...u,
        memberAgentIds: [u.leadAgentId, ...members.filter((m) => m.reportsToAgentId === u.leadAgentId).map((m) => m.agentId)],
        counts: { openTasks: mine.filter((t) => !['done', 'cancelled'].includes(t.status)).length, tasks: mine.length, goals: goals.filter((g) => (g.unitId ?? root?.id) === u.id || (isRoot && !g.unitId)).length },
        children: units.filter((c) => c.parentUnitId === u.id).map(node),
      };
    };
    return units.filter((u) => u.parentUnitId === null).map(node);
  }

  /** Tasks linked to each goal through its projects (non-cancelled). */
  private async linkedTasks(orgId: string): Promise<Map<string, { total: number; done: number }>> {
    const projects = await this.db.select().from(orgProjects).where(eq(orgProjects.orgId, orgId));
    const tasks = await this.db.select().from(orgTasks).where(eq(orgTasks.orgId, orgId));
    const out = new Map<string, { total: number; done: number }>();
    for (const t of tasks) {
      if (t.status === 'cancelled' || !t.projectId) continue;
      const goalId = projects.find((p) => p.id === t.projectId)?.goalId;
      if (!goalId) continue;
      const c = out.get(goalId) ?? { total: 0, done: 0 };
      c.total++; if (t.status === 'done') c.done++;
      out.set(goalId, c);
    }
    return out;
  }

  /** Progress of one goal (docs/group-chat.md §7). */
  async goalProgress(orgId: string, goalId: string): Promise<{ progress: number; tasks: { total: number; done: number }; children: number }> {
    const goals = await this.org.goals(orgId);
    const linked = await this.linkedTasks(orgId);
    const g = goals.find((x) => x.id === goalId);
    if (!g) throw new NotFoundException(`goal ${goalId}`);
    const compute = (goal: OrgGoal, depth = 0): number => {
      if (goal.status === 'achieved') return 1;
      const kids = depth > 8 ? [] : goals.filter((k) => k.parentGoalId === goal.id && k.status !== 'abandoned');
      return blendProgress(linked.get(goal.id) ?? { total: 0, done: 0 }, kids.map((k) => compute(k, depth + 1)));
    };
    return { progress: compute(g), tasks: linked.get(g.id) ?? { total: 0, done: 0 }, children: goals.filter((k) => k.parentGoalId === g.id).length };
  }

  /** The goal tree with progress, for the whole company or one unit (its
   *  goals and those of the units below it). A goal whose parent falls
   *  outside the filter is shown as a root of the filtered tree. */
  async goalTree(orgId: string, opts: { unitId?: string | null } = {}): Promise<GoalNode[]> {
    const goals = await this.org.goals(orgId);
    const linked = await this.linkedTasks(orgId);
    const root = await this.rootUnit(orgId).catch(() => null);
    let scope: Set<string> | null = null;
    if (opts.unitId) scope = new Set(await this.subtree(orgId, opts.unitId));
    const inScope = (g: OrgGoal) => !scope || scope.has(g.unitId ?? root?.id ?? '');
    const visible = goals.filter(inScope);
    const ids = new Set(visible.map((g) => g.id));
    const progressOf = new Map<string, number>();
    const compute = (goal: OrgGoal, depth = 0): number => {
      if (progressOf.has(goal.id)) return progressOf.get(goal.id)!;
      const kids = depth > 8 ? [] : goals.filter((k) => k.parentGoalId === goal.id && k.status !== 'abandoned');
      const p = goal.status === 'achieved' ? 1 : blendProgress(linked.get(goal.id) ?? { total: 0, done: 0 }, kids.map((k) => compute(k, depth + 1)));
      progressOf.set(goal.id, p);
      return p;
    };
    const node = (g: OrgGoal): GoalNode => ({
      ...g, progress: compute(g), tasks: linked.get(g.id) ?? { total: 0, done: 0 },
      children: visible.filter((k) => k.parentGoalId === g.id).sort(byCreated).map(node),
    });
    return visible.filter((g) => !g.parentGoalId || !ids.has(g.parentGoalId)).sort(byCreated).map(node);
  }

  /** Create a goal in a unit; the parent must belong to that unit or one of
   *  its ancestors (a lead sets children of goals it can see). */
  async addGoal(orgId: string, input: { title: string; description?: string; ownerAgentId?: string | null; status?: string; unitId?: string | null; parentGoalId?: string | null } & GoalIntentFields, actor = 'user'): Promise<OrgGoal> {
    const root = await this.rootUnit(orgId);
    const unitId = input.unitId ? (await this.get(orgId, input.unitId)).id : (input.ownerAgentId ? (await this.unitForAssignee(orgId, input.ownerAgentId)).id : root.id);
    if (input.parentGoalId) {
      const parent = await this.org.goal(orgId, input.parentGoalId);
      const allowed = await this.ancestry(orgId, unitId);
      if (!allowed.includes(parent.unitId ?? root.id)) throw new BadRequestException('parentGoalId must be a goal of this unit or of a unit above it');
    }
    return this.org.addGoal(orgId, { ...input, unitId, parentGoalId: input.parentGoalId ?? null }, actor);
  }

  /** The lead's `org_unit_report`: board and goal progress of one unit, for the model. */
  async unitReport(orgId: string, unitId: string, names: Map<string, string>): Promise<string> {
    const u = await this.get(orgId, unitId);
    const members = (await this.org.members(orgId)).filter((m) => m.status !== 'terminated');
    const reports = members.filter((m) => m.reportsToAgentId === u.leadAgentId);
    const tasks = (await this.db.select().from(orgTasks).where(eq(orgTasks.orgId, orgId))).filter((t) => t.unitId === u.id);
    const nm = (id: string | null) => (id ? names.get(id) ?? id.slice(0, 8) : 'nobody');
    const lines = [`# ${u.name} (#${u.slug})`, `Lead: ${nm(u.leadAgentId)}. Reports: ${reports.map((r) => `${nm(r.agentId)} (${r.status})`).join(', ') || 'none'}.`, '', '## Board'];
    const byStatus = new Map<string, number>();
    for (const t of tasks) byStatus.set(t.status, (byStatus.get(t.status) ?? 0) + 1);
    lines.push(tasks.length === 0 ? '- no tasks on this board' : `- ${tasks.length} task(s): ${[...byStatus.entries()].map(([s, n]) => `${n} ${s.replace('_', ' ')}`).join(', ')}`);
    for (const t of tasks.filter((t) => !['done', 'cancelled'].includes(t.status)).slice(0, 20)) lines.push(`  - [${t.id.slice(0, 8)}] (${t.status}) ${t.title} — ${nm(t.assigneeAgentId)}`);
    lines.push('', '## Goals');
    const tree = await this.goalTree(orgId, { unitId: u.id });
    const walk = (nodes: GoalNode[], depth: number) => {
      for (const g of nodes) {
        lines.push(`${'  '.repeat(depth)}- [${g.id.slice(0, 8)}] (${g.status}) ${g.title} — ${Math.round(g.progress * 100)}%${g.tasks.total ? ` (${g.tasks.done}/${g.tasks.total} tasks)` : ''}`);
        walk(g.children, depth + 1);
      }
    };
    if (tree.length === 0) lines.push('- no goals yet (org_set_goal adds one)');
    walk(tree, 0);
    return lines.join('\n');
  }

  /** Whether `m` reports directly to `leadAgentId` (or is the lead). */
  static inUnit(lead: string, m: OrgMember): boolean {
    return m.agentId === lead || m.reportsToAgentId === lead;
  }
}

function byCreated(a: { createdAt: string }, b: { createdAt: string }): number {
  return a.createdAt < b.createdAt ? -1 : 1;
}
