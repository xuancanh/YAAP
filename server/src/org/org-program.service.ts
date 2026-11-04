/**
 * OrgProgramService — program management as a matrix (docs/work-tracking.md
 * "Program management: the matrix"). Two axes:
 *
 *  - **functional heads own people and capacity**: their unit, hiring,
 *    skills and the quality of their function's work;
 *  - **Program Managers own outcomes**: goals (objectives and key results)
 *    and projects are assigned to a PM as the accountable owner. A PM may
 *    own several; a company without one has the chief of staff as the
 *    *acting* PM — said so wherever an owner is shown, never silent.
 *
 * What this service holds:
 *
 *  - **Ownership.** `assign` hands a goal or project to a PM (the chief, a
 *    person, or the current owner handing over). A company-level goal the
 *    chief sets is handed to the least-loaded PM at once when the company
 *    has one; when a PM joins, the items the chief was acting on are handed
 *    over. Audited `program_assign`.
 *  - **Resource requests** (`org_resource_requests`): for an owned project
 *    the PM asks a head for a role, a share of a member's time, a window
 *    and a budget. The head approves (a project seat at once —
 *    `org_project_members` is the allocation record), adjusts (a seat on its
 *    terms, with the reason), declines (with the reason) or says it will
 *    hire to fill. A dispute — or no answer within
 *    `program.requestAnswerHours` — climbs as a `resource_conflict` card
 *    through decision routing: the head's manager first (the chief), then
 *    the CEO. Every step is audited (`resource_request`, `resource_decide`,
 *    `resource_escalate`) and reaches the owner's feed.
 *  - **Per-goal and per-project cadence** (`org_program_cadences`): a goal
 *    review for each objective and a milestone review for each project, on
 *    a cron its PM chooses within the company's `program.*` bounds (derived
 *    from the operating profile); a project's sync is its standup
 *    (`org_projects.standupCron`), also PM-chosen within bounds. Defaults are
 *    seeded when an item gets its owner (and lazily for older items). The
 *    reviews fire through the meetings machinery (OrgMeetingRuntime
 *    addDueMeetings) with the PM facilitating, and close with the PM's
 *    status update — the project health the roadmap reads ("Update
 *    missing") and the key-result check-ins.
 *  - **Matrix health**: items with no PM owner, the chief acting as PM,
 *    members stretched past `program.allocationWarnPct` (told to the head
 *    and to each PM they serve), stale rhythms, requests waiting — as
 *    signals (OrgSignalsService.addSource), heartbeat reasons, and the
 *    matrix view the UI draws.
 *
 * Model-free. Every write is audited.
 */
import { BadRequestException, ForbiddenException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { orgProgramCadences, orgResourceRequests } from '../database/schema';
import { newId, nowIso } from '../common/ids.util';
import { currentAccountId } from '../accounts/account-context';
import { AgentsService } from '../agents/agents.service';
import { HeartbeatService } from '../chats/heartbeat.service';
import { OrgService, type Organization, type OrgGoal, type OrgMember, type OrgProject, type OrgProjectMember } from './org.service';
import { OrgAuditService } from './org-audit.service';
import { OrgApprovalsService } from './org-approvals.service';
import { OrgTasksService } from './org-tasks.service';
import { OrgUnitsService, type OrgUnit } from './org-units.service';
import { OrgDecisionsService } from './org-decisions.service';
import { OrgProjectsService } from './org-projects.service';
import { OrgProjectTeamsService } from './org-project-teams.service';
import { OrgMeetingRuntime, type DueMeeting } from './org-meeting-runtime.service';
import { OrgSignalsService, type SignalInput } from './org-signals.service';
import { OrgAnnouncer } from './org-announcer';
import { holderAgent } from './decision-routing';
import { isHeadMember, isProgramManagerTitle } from './heads';
import { programTunable, cronForDays, cronIntervalDays, cadenceBoundsError, nextFire } from './program-tunables';
import { tunable } from './org-tunables';
import { paceOf } from './org-intent.service';

export type OrgProgramCadence = typeof orgProgramCadences.$inferSelect;
export type OrgResourceRequest = typeof orgResourceRequests.$inferSelect;

/** Who owns an item, as the matrix shows it. */
export type OwnerRole = 'pm' | 'acting_chief' | 'head' | 'member' | 'person' | 'inactive' | 'none';
export interface ProgramOwner { agentId: string | null; name: string; role: OwnerRole }

export type CadenceKind = 'sync' | 'milestone_review' | 'status_update' | 'goal_review' | 'kr_checkin';
export const CADENCE_LABELS: Record<CadenceKind, string> = {
  sync: 'Project sync', milestone_review: 'Milestone review', status_update: 'Status update', goal_review: 'Goal review', kr_checkin: 'Key-result check-in',
};
/** The rhythms a PM sets with a cron (the others follow a day count). */
export const SETTABLE_CADENCES: Record<'goal' | 'project', CadenceKind[]> = { goal: ['goal_review'], project: ['sync', 'milestone_review'] };

export interface CadenceView {
  kind: CadenceKind; label: string;
  /** Five-field cron (server time) for meetings; null for day-count rhythms. */
  cron: string | null;
  /** Typical days between occurrences. */
  everyDays: number | null;
  nextAt: string | null; lastAt: string | null;
  enabled: boolean;
  /** No output for `program.staleCadences` intervals (no update, no check-in, never held). */
  stale: boolean;
}

export interface RequestView {
  id: string; projectId: string; projectKey: string | null; projectTitle: string; goalId: string | null;
  pmAgentId: string | null; pmName: string; headAgentId: string | null; headName: string; unitName: string | null;
  role: string; skills: string; agentId: string | null; agentName: string | null; allocation: number;
  startDate: string | null; endDate: string | null; budgetUsd: number; why: string;
  status: string; decidedAgentId: string | null; decidedAgentName: string | null; decidedAllocation: number | null;
  decisionNote: string; decidedBy: string; decidedAt: string | null; approvalId: string | null; memberRowId: string | null;
  answerBy: string | null; overdue: boolean; createdAt: string;
}

export interface SeatView { agentId: string | null; name: string; role: string; allocation: number; status: string; headName: string }

export interface ProgramItem {
  refType: 'goal' | 'project'; id: string; key: string | null;
  /** objective | key_result | project. */
  kind: string; title: string; status: string; lane: string | null; health: string | null;
  owner: ProgramOwner;
  cadences: CadenceView[];
  /** A project's seats; a goal's: the seats of the projects that move it. */
  team: SeatView[];
  requests: RequestView[];
  /** Projects that move a goal (keys), or the goals a project moves (ids). */
  links: Array<{ id: string; key: string | null; title: string }>;
  stale: boolean;
}

export interface MatrixMember {
  agentId: string; name: string; title: string;
  /** Its line manager (the head who owns its capacity). */
  lineManager: string; unitName: string | null;
  assignments: Array<{ projectId: string; key: string | null; title: string; role: string; allocation: number; status: string; pmName: string }>;
  owns: Array<{ refType: 'goal' | 'project'; id: string; key: string | null; title: string }>;
  total: number; stretched: boolean; isPm: boolean; isHead: boolean;
}

export interface ProgramMatrix {
  pms: Array<{ agentId: string; name: string; owns: number }>;
  /** True when the company has no Program Manager: the chief acts as PM. */
  chiefActing: boolean; chiefName: string;
  items: ProgramItem[];
  members: MatrixMember[];
  requests: RequestView[];
  health: { items: number; unowned: number; acting: number; nonPm: number; stretched: number; staleCadences: number; openRequests: number; overdueRequests: number };
  bounds: { syncMinDays: number; syncMaxDays: number; reviewMinDays: number; reviewMaxDays: number; allocationWarnPct: number; requestAnswerHours: number };
}

const LIVE_SEAT = new Set(['active', 'pending']);
const CLOSED_PROJECT = new Set(['done', 'cancelled']);
const OPEN_REQUEST = new Set(['open', 'hiring', 'granted', 'escalated']);
const DAY_MS = 86_400_000;
/** How often the lazy defaults pass runs per org (the tick is per minute). */
const SEED_EVERY_MS = 10 * 60_000;

function idList(raw: string | null | undefined): string[] {
  try { const v = JSON.parse(raw || '[]') as unknown; return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
}
function milestonesOf(p: OrgProject): Array<{ name: string; date: string | null; done: boolean }> {
  try { const v = JSON.parse(p.milestones || '[]') as unknown; return Array.isArray(v) ? v.map((m) => ({ name: String((m as { name?: unknown }).name ?? ''), date: ((m as { date?: unknown }).date as string | null) ?? null, done: Boolean((m as { done?: unknown }).done) })) : []; } catch { return []; }
}
const isPerson = (actor: string) => actor === 'user' || actor.startsWith('human:');

@Injectable()
export class OrgProgramService {
  private readonly logger = new Logger(OrgProgramService.name);
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly seededAt = new Map<string, number>();

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly org: OrgService,
    private readonly audit: OrgAuditService,
    private readonly agents: AgentsService,
    private readonly approvals: OrgApprovalsService,
    private readonly tasks: OrgTasksService,
    private readonly projects: OrgProjectsService,
    private readonly teams: OrgProjectTeamsService,
    @Optional() private readonly units?: OrgUnitsService,
    @Optional() private readonly decisions?: OrgDecisionsService,
    @Optional() meetings?: OrgMeetingRuntime,
    @Optional() signals?: OrgSignalsService,
    @Optional() heartbeat?: HeartbeatService,
    @Optional() private readonly announcer?: OrgAnnouncer,
  ) {
    approvals.onApply('resource_conflict', async (orgId, payload, a) => this.applyConflict(orgId, String(payload.requestId ?? ''), a.holder ?? 'ceo'));
    approvals.onDecided(async ({ orgId, approval, decision, note }) => {
      if (approval.kind !== 'resource_conflict' || decision === 'approve') return;
      const payload = JSON.parse(approval.payload || '{}') as Record<string, unknown>;
      await this.upheld(orgId, String(payload.requestId ?? ''), String(payload.prevStatus ?? 'declined'), note ?? '').catch(() => undefined);
    });
    audit.onAppend((orgId, entry) => {
      if (entry.action === 'goal_create' && entry.refId) this.track(this.onGoalCreated(orgId, entry.refId, entry.actor));
      else if (entry.action === 'member_add' && isProgramManagerTitle(String((entry.payload as { title?: unknown } | undefined)?.title ?? ''))) this.track(this.onPmJoined(orgId, entry.refId ?? ''));
      else if (entry.action === 'member_update' && isProgramManagerTitle(String((entry.payload as { title?: unknown } | undefined)?.title ?? ''))) this.track(this.onPmJoined(orgId, entry.refId ?? ''));
    });
    meetings?.addDueMeetings((org, now) => this.tick(org, now));
    signals?.addSource({ kinds: ['program_unowned', 'program_acting', 'member_stretched', 'cadence_stale'], compute: (org, now) => this.signals(org, now) });
    heartbeat?.addReasonProvider({ name: 'program', reasons: (agentId, ctx) => this.heartbeatReasons(agentId, ctx.now) });
  }

  /** Wait for the listeners' follow-ups (tests). */
  async settle(): Promise<void> { while (this.inflight.size) await Promise.allSettled([...this.inflight]); }
  private track(p: Promise<unknown>): void {
    const q = p.catch((err: unknown) => this.logger.warn(`program follow-up failed: ${err instanceof Error ? err.message : err}`));
    this.inflight.add(q);
    void q.finally(() => this.inflight.delete(q));
  }

  // ---- owners ----

  /** The company's active Program Managers. */
  async programManagers(orgId: string): Promise<OrgMember[]> {
    return (await this.org.members(orgId)).filter((m) => m.status === 'active' && isProgramManagerTitle(m.title));
  }

  /** Who should own a new goal or project: the least-loaded PM, else the
   *  chief as the acting PM (said so: `acting`). */
  async defaultOwner(orgId: string): Promise<{ agentId: string | null; acting: boolean }> {
    const pms = await this.programManagers(orgId);
    if (pms.length === 0) return { agentId: (await this.org.get(orgId)).chiefOfStaffAgentId, acting: true };
    const load = await this.loadByOwner(orgId);
    return { agentId: [...pms].sort((a, b) => (load.get(a.agentId) ?? 0) - (load.get(b.agentId) ?? 0) || (a.joinedAt < b.joinedAt ? -1 : 1))[0].agentId, acting: false };
  }

  private async loadByOwner(orgId: string): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (const g of await this.org.goals(orgId)) if (g.status === 'active' && g.kind !== 'vision' && g.ownerAgentId) out.set(g.ownerAgentId, (out.get(g.ownerAgentId) ?? 0) + 1);
    for (const p of await this.org.projects(orgId)) if (p.kind === 'project' && !CLOSED_PROJECT.has(p.status) && p.ownerAgentId) out.set(p.ownerAgentId, (out.get(p.ownerAgentId) ?? 0) + 1);
    return out;
  }

  ownerOf(org: Organization, members: OrgMember[], names: Map<string, string>, agentId: string | null, leadHumanId: string | null = null): ProgramOwner {
    if (!agentId) return leadHumanId ? { agentId: null, name: 'a person', role: 'person' } : { agentId: null, name: 'nobody', role: 'none' };
    const m = members.find((x) => x.agentId === agentId);
    const name = names.get(agentId) ?? agentId.slice(0, 8);
    if (!m || m.status !== 'active') return { agentId, name, role: 'inactive' };
    if (agentId === org.chiefOfStaffAgentId) return { agentId, name, role: 'acting_chief' };
    if (isProgramManagerTitle(m.title)) return { agentId, name, role: 'pm' };
    return { agentId, name, role: isHeadMember(m, org, members.some((x) => x.reportsToAgentId === agentId && x.status !== 'terminated')) ? 'head' : 'member' };
  }

  /** A goal (id, id prefix or title) or a project (key, id or title). */
  async resolve(orgId: string, ref: string): Promise<{ refType: 'goal'; goal: OrgGoal } | { refType: 'project'; project: OrgProject }> {
    const q = (ref ?? '').trim();
    if (!q) throw new BadRequestException('name the goal (id from org_intent) or the project (key, e.g. P-3)');
    const goals = (await this.org.goals(orgId)).filter((g) => g.kind !== 'vision');
    const g = goals.filter((x) => x.id === q || (q.length >= 6 && x.id.startsWith(q)) || x.title.toLowerCase() === q.toLowerCase());
    if (g.length === 1 && !/^p-\d+$/i.test(q)) return { refType: 'goal', goal: g[0] };
    const project = await this.projects.resolve(orgId, q).catch(() => null);
    if (project) return { refType: 'project', project };
    throw new BadRequestException(`no single goal or project matches "${q}" — org_intent lists goals, org_projects the roadmap`);
  }

  /**
   * Make `agentId` the accountable owner of a goal or project. A person,
   * the chief, the item's current owner (handing over) or the owner's
   * manager chain may. An objective's key results the previous owner (or
   * the chief) held move with it (`cascade`). Seeds the item's default
   * rhythm and tells the new owner.
   */
  async assign(orgId: string, ref: string, agentId: string, actor: string, opts: { cascade?: boolean; why?: string; auto?: boolean } = {}): Promise<{ note: string; refType: 'goal' | 'project'; id: string }> {
    const org = await this.org.get(orgId);
    const target = await this.org.member(orgId, agentId);
    if (!target || target.status !== 'active') throw new BadRequestException('refused: the owner must be an active member of this organization');
    if (org.auditorAgentId === agentId) throw new BadRequestException('refused: the auditor owns no goal or project — it stays independent of the work it audits');
    const r = await this.resolve(orgId, ref);
    const prev = r.refType === 'goal' ? r.goal.ownerAgentId : r.project.ownerAgentId;
    await this.requireAssigner(org, actor, prev);
    const name = await this.nameOf(agentId);
    const moved: string[] = [];
    if (r.refType === 'goal') {
      if (r.goal.status !== 'active' && r.goal.status !== 'draft') throw new BadRequestException(`refused: the goal is ${r.goal.status}`);
      await this.org.updateGoal(orgId, r.goal.id, { ownerAgentId: agentId }, actor);
      if (r.goal.kind === 'objective' && opts.cascade !== false) {
        for (const kr of (await this.org.goals(orgId)).filter((x) => x.parentGoalId === r.goal.id && x.kind === 'key_result' && x.status === 'active' && (!x.ownerAgentId || x.ownerAgentId === prev || x.ownerAgentId === org.chiefOfStaffAgentId))) {
          if (kr.ownerAgentId === agentId) continue;
          await this.org.updateGoal(orgId, kr.id, { ownerAgentId: agentId }, actor);
          moved.push(kr.title);
        }
      }
    } else {
      if (r.project.kind !== 'project') throw new BadRequestException(`refused: ${r.project.key} is a system project; its unit's lead keeps it`);
      if (CLOSED_PROJECT.has(r.project.status)) throw new BadRequestException(`refused: ${r.project.key} is ${r.project.status}`);
      await this.org.updateProject(orgId, r.project.id, { ownerAgentId: agentId }, actor);
      if (r.project.channelId) await this.announcer?.channels?.addChannelMember(r.project.channelId, 'agent', agentId).catch(() => undefined);
    }
    const id = r.refType === 'goal' ? r.goal.id : r.project.id;
    const label = r.refType === 'goal' ? `${r.goal.kind.replace('_', ' ')} "${r.goal.title}"` : `${r.project.key} "${r.project.title}"`;
    await this.ensureDefaults(org, r.refType, id, actor).catch(() => undefined);
    const role = isProgramManagerTitle(target.title) ? 'Program Manager' : agentId === org.chiefOfStaffAgentId ? 'acting Program Manager (the company has none)' : target.title || 'member';
    await this.audit.append(orgId, { actor, action: 'program_assign', refType: r.refType, refId: id, payload: { title: r.refType === 'goal' ? r.goal.title : r.project.title, key: r.refType === 'project' ? r.project.key : null, kind: r.refType === 'goal' ? r.goal.kind : 'project', agentId, previous: prev, role, cascaded: moved.length, auto: Boolean(opts.auto), why: (opts.why ?? '').slice(0, 300) } });
    if (agentId !== prev) {
      await this.agents.addEvent(agentId, {
        kind: 'info', title: `You own ${label} as its ${role}`.slice(0, 200), origin: 'org', payload: JSON.stringify({ orgId, refType: r.refType, id }),
        body: 'You are accountable for its outcome: set its rhythm (org_program_cadence), work out what it needs from the heads (org_resource_request), and post its status on cadence. org_program shows what you own.',
      }).catch(() => undefined);
    }
    return { refType: r.refType, id, note: `${label} is owned by ${name} (${role})${moved.length ? `, with ${moved.length} key result(s)` : ''}.` };
  }

  private async requireAssigner(org: Organization, actor: string, prevOwner: string | null): Promise<void> {
    if (isPerson(actor) || actor === 'system') return;
    const me = actor === 'chief' ? org.chiefOfStaffAgentId : actor.startsWith('agent:') ? actor.slice('agent:'.length) : null;
    if (!me) return;
    if (me === org.chiefOfStaffAgentId || me === prevOwner) return;
    if (prevOwner && (await this.projects.managerChain(org.id, prevOwner)).includes(me)) return;
    throw new ForbiddenException('refused: goals and projects are assigned by the chief of staff (or handed over by their owner) — ask the chief (org_message)');
  }

  /** A company-level goal the chief (or a person) set goes to a PM at once when the company has one. */
  private async onGoalCreated(orgId: string, goalId: string, actor: string): Promise<void> {
    const org = await this.org.get(orgId).catch(() => null);
    if (!org || org.status !== 'active') return;
    const g = await this.org.goal(orgId, goalId).catch(() => null);
    if (!g || (g.kind !== 'objective' && g.kind !== 'key_result')) return;
    const root = this.units ? await this.units.rootUnit(orgId).catch(() => null) : null;
    const companyLevel = !g.unitId || g.unitId === root?.id;
    const chiefOwned = !g.ownerAgentId || g.ownerAgentId === org.chiefOfStaffAgentId;
    if (!companyLevel || !chiefOwned) return;
    // A key result follows its objective's owner.
    if (g.kind === 'key_result' && g.parentGoalId) {
      const parent = await this.org.goal(orgId, g.parentGoalId).catch(() => null);
      if (parent?.ownerAgentId && parent.ownerAgentId !== org.chiefOfStaffAgentId && parent.ownerAgentId !== g.ownerAgentId) {
        await this.assign(orgId, g.id, parent.ownerAgentId, 'system', { auto: true, why: 'a key result follows its objective\'s Program Manager' });
        return;
      }
    }
    const def = await this.defaultOwner(orgId);
    if (def.acting || !def.agentId) {
      if (g.kind === 'objective') await this.ensureDefaults(org, 'goal', g.id, actor).catch(() => undefined);
      return;
    }
    await this.assign(orgId, g.id, def.agentId, 'system', { auto: true, why: 'goals are owned by Program Managers; the least-loaded one takes it' });
  }

  /** A PM joined: the items the chief was acting on are handed over, by load. */
  private async onPmJoined(orgId: string, agentId: string): Promise<void> {
    const org = await this.org.get(orgId).catch(() => null);
    if (!org || org.status !== 'active' || !org.chiefOfStaffAgentId) return;
    const m = await this.org.member(orgId, agentId);
    if (!m || m.status !== 'active' || !isProgramManagerTitle(m.title)) return;
    const chief = org.chiefOfStaffAgentId;
    const root = this.units ? await this.units.rootUnit(orgId).catch(() => null) : null;
    const objectives = (await this.org.goals(orgId)).filter((g) => g.kind === 'objective' && g.status === 'active' && g.ownerAgentId === chief && (!g.unitId || g.unitId === root?.id));
    const projects = (await this.org.projects(orgId)).filter((p) => p.kind === 'project' && !CLOSED_PROJECT.has(p.status) && p.ownerAgentId === chief);
    for (const g of objectives) {
      const def = await this.defaultOwner(orgId);
      if (def.agentId && !def.acting) await this.assign(orgId, g.id, def.agentId, 'system', { auto: true, why: 'a Program Manager joined: the chief no longer acts as PM' }).catch(() => undefined);
    }
    for (const p of projects) {
      const def = await this.defaultOwner(orgId);
      if (def.agentId && !def.acting) await this.assign(orgId, p.id, def.agentId, 'system', { auto: true, why: 'a Program Manager joined: the chief no longer acts as PM' }).catch(() => undefined);
    }
    // Loose key results the chief still holds whose objective moved.
    for (const kr of (await this.org.goals(orgId)).filter((g) => g.kind === 'key_result' && g.status === 'active' && g.ownerAgentId === chief && g.parentGoalId)) {
      const parent = await this.org.goal(orgId, kr.parentGoalId!).catch(() => null);
      if (parent?.ownerAgentId && parent.ownerAgentId !== chief) await this.assign(orgId, kr.id, parent.ownerAgentId, 'system', { auto: true, why: 'a key result follows its objective\'s Program Manager' }).catch(() => undefined);
    }
  }

  // ---- cadences ----

  async cadenceRows(orgId: string, refType?: 'goal' | 'project', refId?: string): Promise<OrgProgramCadence[]> {
    const rows = await this.db.select().from(orgProgramCadences).where(eq(orgProgramCadences.orgId, orgId));
    return rows.filter((r) => (!refType || r.refType === refType) && (!refId || r.refId === refId));
  }

  /** Seed an item's default rhythm from the company's tunables (only what is unset). */
  async ensureDefaults(org: Organization, refType: 'goal' | 'project', refId: string, actor = 'system', now = new Date()): Promise<void> {
    const hour = programTunable(org, 'program.cadenceHour');
    const have = new Set((await this.cadenceRows(org.id, refType, refId)).map((r) => r.kind));
    if (refType === 'goal') {
      const g = await this.org.goal(org.id, refId).catch(() => null);
      if (!g || g.kind !== 'objective' || g.status !== 'active') return;
      if (!have.has('goal_review')) await this.writeCadence(org.id, refType, refId, 'goal_review', cronForDays(programTunable(org, 'program.reviewDays'), hour, 2), actor, now);
      return;
    }
    const p = await this.org.project(org.id, refId).catch(() => null);
    if (!p || p.kind !== 'project' || CLOSED_PROJECT.has(p.status)) return;
    if (!have.has('milestone_review')) await this.writeCadence(org.id, refType, refId, 'milestone_review', cronForDays(programTunable(org, 'program.reviewDays'), hour, 3), actor, now);
    if (!p.standupCron) {
      const cron = cronForDays(programTunable(org, 'program.syncDays'), Math.max(0, hour - 1), 1);
      await this.org.updateProjectRitual(org.id, p.id, { standupCron: cron, standupNextAt: nextFire(cron, now)?.toISOString() ?? null });
    }
  }

  private async writeCadence(orgId: string, refType: string, refId: string, kind: string, cron: string | null, actor: string, now: Date): Promise<OrgProgramCadence> {
    const existing = (await this.cadenceRows(orgId)).find((r) => r.refType === refType && r.refId === refId && r.kind === kind);
    const next = cron ? nextFire(cron, now)?.toISOString() ?? null : null;
    if (existing) {
      const set = cron === null ? { enabled: 0, nextAt: null, setBy: actor.slice(0, 80), updatedAt: nowIso() } : { cron, enabled: 1, nextAt: next, setBy: actor.slice(0, 80), updatedAt: nowIso() };
      await this.db.update(orgProgramCadences).set(set).where(eq(orgProgramCadences.id, existing.id));
      return { ...existing, ...set };
    }
    const row: OrgProgramCadence = { accountId: currentAccountId(), id: newId(), orgId, refType, refId, kind, cron: cron ?? '0 0 31 2 *', enabled: cron ? 1 : 0, nextAt: next, lastAt: null, setBy: actor.slice(0, 80), createdAt: nowIso(), updatedAt: null };
    await this.db.insert(orgProgramCadences).values(row);
    return row;
  }

  /**
   * The owner sets an item's rhythm: `sync` (the project's standup with its
   * team) and `milestone_review` for a project, `goal_review` for an
   * objective — a five-field cron within the company's bounds, or null
   * (off). The owner, its manager chain, the chief or a person may.
   */
  async setCadence(orgId: string, ref: string, kind: string, cron: string | null, actor: string, now = new Date()): Promise<{ note: string }> {
    const org = await this.org.get(orgId);
    const r = await this.resolve(orgId, ref);
    const owner = r.refType === 'goal' ? r.goal.ownerAgentId : r.project.ownerAgentId;
    await this.requireOwnerOrAbove(org, actor, owner, r.refType === 'goal' ? 'goal' : `${r.project.key}`);
    const allowed = SETTABLE_CADENCES[r.refType];
    if (!allowed.includes(kind as CadenceKind)) throw new BadRequestException(`a ${r.refType}'s rhythm is set as ${allowed.join(' or ')}${r.refType === 'goal' ? ' (key results keep their check-in cadence in days: org_set_key_result)' : ''}`);
    if (r.refType === 'goal' && r.goal.kind !== 'objective') throw new BadRequestException('a goal review belongs to an objective; its key results are reviewed in it');
    const c = cron?.trim() || null;
    if (c) {
      const parts = c.split(/\s+/);
      if (parts.length !== 5 || !parts.every((x) => /^[\d*,/-]+$/.test(x))) throw new BadRequestException('cron must have five fields: minute hour day-of-month month day-of-week (server time)');
      const [lo, hi] = kind === 'sync' ? [programTunable(org, 'program.syncMinDays'), programTunable(org, 'program.syncMaxDays')] : [programTunable(org, 'program.reviewMinDays'), programTunable(org, 'program.reviewMaxDays')];
      const err = cadenceBoundsError(c, lo, hi, now);
      if (err) throw new BadRequestException(`refused: ${err} (program.${kind === 'sync' ? 'sync' : 'review'}MinDays–MaxDays: ${lo}–${hi} days, derived from the company's profile)`);
    }
    let label: string;
    if (r.refType === 'project' && kind === 'sync') {
      await this.org.updateProjectRitual(orgId, r.project.id, { standupCron: c ?? '', standupNextAt: c ? nextFire(c, now)?.toISOString() ?? null : null });
      if (c) await this.teams.ensureChannel(orgId, await this.org.project(orgId, r.project.id)).catch(() => undefined);
      label = `${r.project.key} sync`;
    } else {
      await this.writeCadence(orgId, r.refType, r.refType === 'goal' ? r.goal.id : r.project.id, kind, c, actor, now);
      label = r.refType === 'goal' ? `goal review of "${r.goal.title}"` : `${r.project.key} milestone review`;
    }
    const id = r.refType === 'goal' ? r.goal.id : r.project.id;
    await this.audit.append(orgId, { actor, action: 'program_cadence', refType: r.refType, refId: id, payload: { kind, cron: c } });
    const next = c ? nextFire(c, now) : null;
    return { note: c ? `${label}: "${c}" (server time; every ~${Math.round((cronIntervalDays(c, now) ?? 30) * 10) / 10} day(s)), next ${next ? next.toISOString().slice(0, 16).replace('T', ' ') : '?'}.` : `${label} is off — the item has no rhythm of that kind (the chief sees it).` };
  }

  private async requireOwnerOrAbove(org: Organization, actor: string, owner: string | null, what: string): Promise<void> {
    if (isPerson(actor) || actor === 'system') return;
    const me = actor === 'chief' ? org.chiefOfStaffAgentId : actor.startsWith('agent:') ? actor.slice('agent:'.length) : null;
    if (!me || me === org.chiefOfStaffAgentId || me === owner) return;
    if (owner && (await this.projects.managerChain(org.id, owner)).includes(me)) return;
    throw new ForbiddenException(`refused: only the owner of ${what} (its Program Manager), its managers or the chief set its rhythm and its resources`);
  }

  /** The rhythms of an item, with their next occurrence and staleness. */
  async cadencesOf(org: Organization, item: { refType: 'goal'; goal: OrgGoal; krs: OrgGoal[]; projects: OrgProject[] } | { refType: 'project'; project: OrgProject }, rows: OrgProgramCadence[], now: Date): Promise<CadenceView[]> {
    const staleN = programTunable(org, 'program.staleCadences');
    const out: CadenceView[] = [];
    const fromRow = (kind: CadenceKind, refId: string, output: string | null): CadenceView => {
      const r = rows.find((x) => x.refId === refId && x.kind === kind);
      const enabled = Boolean(r && r.enabled === 1);
      const every = r && enabled ? cronIntervalDays(r.cron, now) ?? 30 : null;
      const since = output ?? r?.lastAt ?? r?.createdAt ?? null;
      const stale = !enabled || (every !== null && since !== null && now.getTime() - Date.parse(since) > staleN * every * DAY_MS);
      return { kind, label: CADENCE_LABELS[kind], cron: enabled ? r!.cron : null, everyDays: every === null ? null : Math.round(every * 10) / 10, nextAt: enabled ? r!.nextAt : null, lastAt: r?.lastAt ?? null, enabled, stale };
    };
    if (item.refType === 'project') {
      const p = item.project;
      const syncEvery = p.standupCron ? cronIntervalDays(p.standupCron, now) ?? 30 : null;
      out.push({ kind: 'sync', label: CADENCE_LABELS.sync, cron: p.standupCron || null, everyDays: syncEvery === null ? null : Math.round(syncEvery * 10) / 10, nextAt: p.standupCron ? p.standupNextAt : null, lastAt: p.standupLastAt, enabled: Boolean(p.standupCron), stale: !p.standupCron });
      // A milestone review is stale when the PM posted no health update for staleCadences intervals.
      out.push(fromRow('milestone_review', p.id, p.healthAt));
      const u = this.projects.updateState(org, p, now);
      out.push({ kind: 'status_update', label: CADENCE_LABELS.status_update, cron: null, everyDays: u.cadenceDays, nextAt: u.dueAt, lastAt: p.healthAt, enabled: u.state !== 'none', stale: u.state === 'missing' });
    } else {
      const lastCheckIn = item.krs.map((k) => k.lastCheckInAt).filter((x): x is string => Boolean(x)).sort().at(-1) ?? null;
      if (item.goal.kind === 'objective') out.push(fromRow('goal_review', item.goal.id, lastCheckIn));
      const krs = item.goal.kind === 'key_result' ? [item.goal] : item.krs;
      if (krs.length) {
        const days = Math.min(...krs.map((k) => k.checkInCadenceDays || tunable(org, 'intent.checkInCadenceDays')));
        const due = krs.map((k) => Date.parse(k.lastCheckInAt ?? k.createdAt) + (k.checkInCadenceDays || 7) * DAY_MS).sort((a, b) => a - b)[0];
        const overdue = krs.some((k) => now.getTime() - Date.parse(k.lastCheckInAt ?? k.createdAt) > staleN * (k.checkInCadenceDays || 7) * DAY_MS);
        out.push({ kind: 'kr_checkin', label: CADENCE_LABELS.kr_checkin, cron: null, everyDays: days, nextAt: Number.isFinite(due) ? new Date(due).toISOString() : null, lastAt: krs.map((k) => k.lastCheckInAt).filter((x): x is string => Boolean(x)).sort().at(-1) ?? null, enabled: true, stale: overdue });
      }
    }
    return out;
  }

  // ---- resource requests ----

  async requestRows(orgId: string): Promise<OrgResourceRequest[]> {
    return (await this.db.select().from(orgResourceRequests).where(eq(orgResourceRequests.orgId, orgId))).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  async requestRow(orgId: string, id: string): Promise<OrgResourceRequest> {
    const q = (id ?? '').trim();
    const rows = (await this.requestRows(orgId)).filter((r) => r.id === q || (q.length >= 6 && r.id.startsWith(q)));
    if (rows.length !== 1) throw new BadRequestException(`no single resource request matches "${q}" — org_program lists them`);
    return rows[0];
  }

  private async patchRequest(orgId: string, id: string, patch: Partial<OrgResourceRequest>): Promise<OrgResourceRequest> {
    await this.db.update(orgResourceRequests).set({ ...patch, updatedAt: nowIso() }).where(and(eq(orgResourceRequests.orgId, orgId), eq(orgResourceRequests.id, id)));
    return this.requestRow(orgId, id);
  }

  /**
   * A Program Manager asks a head for what a project it owns needs: a role
   * (and the skills), a share of a member's time (1–100%), a window and a
   * budget. Name a member (its head decides) or a head (it picks the
   * member). When the asker is that head, or a person, it is granted at
   * once. Audited `resource_request`; the head is told.
   */
  async request(orgId: string, input: { project: string; role: string; skills?: string; member?: string | null; head?: string | null; allocation: number; startDate?: string | null; endDate?: string | null; budgetUsd?: number; why?: string; goalId?: string | null }, actor: string, now = new Date()): Promise<{ row: OrgResourceRequest; note: string }> {
    const org = await this.org.get(orgId);
    const p = await this.projects.resolve(orgId, input.project);
    if (p.kind !== 'project' || CLOSED_PROJECT.has(p.status)) throw new BadRequestException(`refused: ${p.key} takes no resources (${p.kind === 'project' ? p.status : 'a system project'})`);
    await this.requireOwnerOrAbove(org, actor, p.ownerAgentId, `${p.key}`);
    const allocation = Math.round(Number(input.allocation));
    if (!Number.isFinite(allocation) || allocation < 1 || allocation > 100) throw new BadRequestException('allocation is a percent of a member\'s time: 1–100');
    const day = (v: string | null | undefined, what: string) => { if (!v) return null; if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new BadRequestException(`${what} is YYYY-MM-DD`); return v; };
    const startDate = day(input.startDate, 'startDate'); const endDate = day(input.endDate, 'endDate');
    if (startDate && endDate && endDate < startDate) throw new BadRequestException('endDate is before startDate');
    const members = await this.org.members(orgId);
    let member: OrgMember | null = null;
    if (input.member) {
      member = members.find((m) => m.agentId === input.member) ?? null;
      if (!member || member.status !== 'active') throw new BadRequestException('refused: the member must be an active member of this organization');
      if (org.auditorAgentId === member.agentId) throw new BadRequestException('refused: the auditor joins no project team');
    }
    let headId: string | null;
    if (member) {
      const route = this.decisions ? await this.decisions.routeDecision(orgId, member.agentId, 'project_allocation', {}).catch(() => null) : null;
      headId = (route ? holderAgent(route.holder) : null) ?? member.reportsToAgentId ?? org.chiefOfStaffAgentId;
    } else if (input.head) {
      const h = members.find((m) => m.agentId === input.head);
      if (!h || h.status !== 'active') throw new BadRequestException('refused: the head must be an active member');
      headId = h.agentId;
    } else throw new BadRequestException('name the head whose unit has the people (head), or the member you want (member) — its head decides');
    const unit = this.units && headId ? await this.units.ledBy(orgId, headId).catch(() => null) : null;
    const me = actor === 'chief' ? org.chiefOfStaffAgentId : actor.startsWith('agent:') ? actor.slice('agent:'.length) : null;
    const answerHours = programTunable(org, 'program.requestAnswerHours');
    const row: OrgResourceRequest = {
      accountId: currentAccountId(), id: newId(), orgId, projectId: p.id, goalId: input.goalId ?? idList(p.goalIds)[0] ?? null,
      requestedBy: actor.slice(0, 80), pmAgentId: p.ownerAgentId, headAgentId: headId, unitId: unit?.id ?? null,
      role: (input.role ?? '').trim().slice(0, 80), skills: (input.skills ?? '').trim().slice(0, 300), agentId: member?.agentId ?? null,
      allocation, startDate, endDate, budgetUsd: Math.max(0, Number(input.budgetUsd ?? 0) || 0), why: (input.why ?? '').trim().slice(0, 600),
      status: 'open', decidedAgentId: null, decidedAllocation: null, decisionNote: '', decidedBy: '', decidedAt: null, approvalId: null, memberRowId: null,
      answerBy: new Date(now.getTime() + answerHours * 3_600_000).toISOString(), createdAt: nowIso(), updatedAt: null,
    };
    if (!row.role) throw new BadRequestException('role is required: what the project needs (engineer, designer, analyst, …)');
    await this.db.insert(orgResourceRequests).values(row);
    const headName = headId ? await this.nameOf(headId) : 'the head';
    await this.audit.append(orgId, { actor, action: 'resource_request', refType: 'project', refId: p.id, payload: { requestId: row.id, key: p.key, role: row.role, allocation, agentId: row.agentId, headAgentId: headId, startDate, endDate, budgetUsd: row.budgetUsd } });
    // The head asking for its own people, or a person: granted at once.
    if (member && (isPerson(actor) || (me && me === headId))) {
      const out = await this.decide(orgId, row.id, { action: 'approve', member: member.agentId, note: 'granted by the head on asking' }, actor);
      return { row: out.row, note: out.note };
    }
    if (headId) {
      await this.agents.addEvent(headId, {
        kind: 'info', title: `Resource request for ${p.key}: ${row.role} at ${allocation}%${member ? ` (${await this.nameOf(member.agentId)})` : ''}`.slice(0, 200), origin: 'org', payload: JSON.stringify({ orgId, requestId: row.id, projectId: p.id }),
        body: `${await this.nameOf(p.ownerAgentId)} asks for ${row.role}${row.skills ? ` (${row.skills})` : ''} at ${allocation}%${startDate || endDate ? `, ${startDate ?? 'now'} → ${endDate ?? 'open-ended'}` : ''}${row.budgetUsd ? `, budget $${row.budgetUsd.toFixed(0)}` : ''}. Why: ${row.why || '—'}. Answer with org_resource_decide ${row.id.slice(0, 8)} (approve with the member, adjust, decline with the reason, or hire) by ${row.answerBy!.slice(0, 16).replace('T', ' ')} UTC, or it goes to your manager.`.slice(0, 1_000),
      }).catch(() => undefined);
    }
    return { row, note: `Resource request ${row.id.slice(0, 8)} for ${p.key}: ${row.role} at ${allocation}%${member ? ` (${await this.nameOf(member.agentId)})` : ''} — with ${headName} to approve, adjust, decline or hire by ${row.answerBy!.slice(0, 16).replace('T', ' ')} UTC; unanswered or disputed it goes to ${headName}'s manager.` };
  }

  /**
   * The head answers: approve (a seat for the member at the asked share),
   * adjust (a seat on the head's terms — another member, a smaller share, a
   * shorter window — with the reason), decline (with the reason) or hire
   * (it will hire to fill; approve once the hire is in seat). The head, its
   * manager chain, the chief or a person may.
   */
  async decide(orgId: string, id: string, input: { action: 'approve' | 'adjust' | 'decline' | 'hire'; member?: string | null; allocation?: number; endDate?: string | null; note?: string }, actor: string): Promise<{ row: OrgResourceRequest; note: string }> {
    const org = await this.org.get(orgId);
    const r = await this.requestRow(orgId, id);
    if (!['open', 'hiring', 'granted'].includes(r.status)) throw new BadRequestException(`that request is ${r.status}`);
    await this.requireHeadOrAbove(org, actor, r.headAgentId);
    const p = await this.org.project(orgId, r.projectId);
    const note = (input.note ?? '').trim().slice(0, 600);
    const pmName = await this.nameOf(r.pmAgentId);
    let out: OrgResourceRequest;
    let text: string;
    if (input.action === 'decline') {
      if (r.status === 'granted') throw new BadRequestException('refused: this request was granted on escalation — fill it with a member (approve) or take it back to your manager');
      if (!note) throw new BadRequestException('a decline needs the reason (note): the PM and, if it climbs, your manager read it');
      out = await this.patchRequest(orgId, r.id, { status: 'declined', decisionNote: note, decidedBy: actor.slice(0, 80), decidedAt: nowIso() });
      text = `Declined ${p.key}'s request for ${r.role}: ${note}`;
    } else if (input.action === 'hire') {
      out = await this.patchRequest(orgId, r.id, { status: 'hiring', decisionNote: note || 'the head will hire to fill it', decidedBy: actor.slice(0, 80), decidedAt: nowIso() });
      text = `${p.key}'s request for ${r.role} will be filled by a hire${note ? `: ${note}` : ''} — approve it with the new member once in seat`;
    } else {
      const memberId = input.member || r.agentId;
      if (!memberId) throw new BadRequestException('name the member who fills it (member), or answer hire / decline');
      const allocation = Math.round(Number(input.allocation ?? r.allocation));
      if (input.action === 'adjust' && !note) throw new BadRequestException('an adjustment needs the reason (note)');
      // The member is the decider's own people (its line), unless the chief or a person decides.
      const me = actor === 'chief' ? org.chiefOfStaffAgentId : actor.startsWith('agent:') ? actor.slice('agent:'.length) : null;
      if (me && me !== org.chiefOfStaffAgentId && memberId !== me && !(await this.projects.managerChain(orgId, memberId)).includes(me)) throw new ForbiddenException(`refused: ${await this.nameOf(memberId)} is not in your reporting line — a head lends its own people`);
      const seat = await this.teams.grant(orgId, r.projectId, { agentId: memberId, role: r.role, allocation, why: `resource request ${r.id.slice(0, 8)}${r.why ? `: ${r.why}` : ''}` }, actor);
      const adjusted = input.action === 'adjust' || allocation < r.allocation || (r.agentId !== null && memberId !== r.agentId) || Boolean(input.endDate && input.endDate !== r.endDate);
      out = await this.patchRequest(orgId, r.id, { status: adjusted ? 'adjusted' : 'approved', decidedAgentId: memberId, decidedAllocation: allocation, endDate: input.endDate ?? r.endDate, decisionNote: note, decidedBy: actor.slice(0, 80), decidedAt: nowIso(), memberRowId: seat.id });
      text = `${adjusted ? 'Adjusted' : 'Approved'} ${p.key}'s request: ${await this.nameOf(memberId)} joins as ${r.role} at ${allocation}%${input.endDate ? ` until ${input.endDate}` : ''}${note ? ` — ${note}` : ''}`;
    }
    await this.audit.append(orgId, { actor, action: 'resource_decide', refType: 'project', refId: p.id, payload: { requestId: r.id, key: p.key, decision: out.status, role: r.role, agentId: out.decidedAgentId, allocation: out.decidedAllocation ?? r.allocation, asked: r.allocation, note } });
    if (r.pmAgentId && `agent:${r.pmAgentId}` !== actor) {
      await this.agents.addEvent(r.pmAgentId, {
        kind: 'info', title: `${text}`.slice(0, 200), origin: 'org', payload: JSON.stringify({ orgId, requestId: r.id, projectId: p.id }),
        body: out.status === 'declined' || out.status === 'adjusted' ? `If the project cannot meet its goal without it, escalate with org_resource_escalate ${r.id.slice(0, 8)} (your case goes to the head's manager), or re-plan the scope.` : out.status === 'hiring' ? 'The head is hiring; plan the work that does not need the seat first.' : 'Assign the project\'s tasks to the new member (org_assign).',
      }).catch(() => undefined);
    }
    if (p.channelId) await this.announcer?.channels?.postSystem(p.channelId, `${text}.`).catch(() => undefined);
    return { row: out, note: `${text}. ${pmName} is told.` };
  }

  private async requireHeadOrAbove(org: Organization, actor: string, headId: string | null): Promise<void> {
    if (isPerson(actor) || actor === 'system') return;
    const me = actor === 'chief' ? org.chiefOfStaffAgentId : actor.startsWith('agent:') ? actor.slice('agent:'.length) : null;
    if (!me || me === org.chiefOfStaffAgentId || me === headId) return;
    if (headId && (await this.projects.managerChain(org.id, headId)).includes(me)) return;
    throw new ForbiddenException('refused: a resource request is decided by the head it is addressed to (or its managers) — the head owns its people');
  }

  /**
   * The PM disagrees with the head's answer (declined, adjusted, a hire
   * that is taking too long) or the head did not answer in time: a
   * `resource_conflict` card through decision routing, raised as the head
   * — the head's manager decides first, then the CEO. Approved, the request
   * is granted as asked (the seat when a member was named; else the head is
   * told to fill it); rejected, the head's answer stands.
   */
  async escalate(orgId: string, id: string, why: string, actor: string, now = new Date()): Promise<{ row: OrgResourceRequest; note: string }> {
    const org = await this.org.get(orgId);
    const r = await this.requestRow(orgId, id);
    const p = await this.org.project(orgId, r.projectId);
    if (actor !== 'system') await this.requireOwnerOrAbove(org, actor, p.ownerAgentId, `${p.key}`);
    if (!['open', 'declined', 'adjusted', 'hiring'].includes(r.status)) throw new BadRequestException(`that request is ${r.status}`);
    if (r.status === 'open' && actor !== 'system' && r.answerBy && r.answerBy > now.toISOString()) throw new BadRequestException(`refused: the head has until ${r.answerBy.slice(0, 16).replace('T', ' ')} UTC to answer — talk to it first (org_message)`);
    const reason = (why ?? '').trim();
    if (!reason && actor !== 'system') throw new BadRequestException('say why the project needs it (why): the head\'s manager weighs your case against the head\'s');
    const headName = await this.nameOf(r.headAgentId);
    const pmName = await this.nameOf(r.pmAgentId);
    const answer = r.status === 'open' ? `no answer in ${programTunable(org, 'program.requestAnswerHours')}h` : r.status === 'hiring' ? `hiring to fill${r.decisionNote ? `: ${r.decisionNote}` : ''}` : `${r.status}${r.decisionNote ? `: ${r.decisionNote}` : ''}`;
    const a = await this.approvals.create(orgId, {
      kind: 'resource_conflict', requestedBy: r.pmAgentId ? `agent:${r.pmAgentId}` : actor,
      recommendation: (reason || `${headName} did not answer ${pmName}'s request in time.`).slice(0, 600),
      payload: {
        requestId: r.id, projectId: p.id, projectKey: p.key, title: p.title, pmAgentId: r.pmAgentId, pmName, headAgentId: r.headAgentId, headName,
        role: r.role, allocation: r.allocation, agentId: r.agentId ?? r.decidedAgentId, agentName: r.agentId ?? r.decidedAgentId ? await this.nameOf(r.agentId ?? r.decidedAgentId) : null,
        startDate: r.startDate, endDate: r.endDate, budgetUsd: r.budgetUsd, headAnswer: answer.slice(0, 300), prevStatus: r.status, routeAsAgentId: r.headAgentId,
      },
      card: { recommendedAction: 'approve' },
    });
    const out = await this.patchRequest(orgId, r.id, { status: 'escalated', approvalId: a.id });
    await this.audit.append(orgId, { actor, action: 'resource_escalate', refType: 'project', refId: p.id, payload: { requestId: r.id, key: p.key, role: r.role, allocation: r.allocation, approvalId: a.id, headAnswer: answer.slice(0, 200), auto: actor === 'system' } });
    const placed = await this.approvals.get(orgId, a.id).catch(() => a);
    const holder = placed.holder === 'ceo' ? 'the CEO' : this.decisions ? await this.decisions.nameOf(orgId, placed.holder).catch(() => 'the head\'s manager') : 'the head\'s manager';
    if (r.headAgentId) await this.agents.addEvent(r.headAgentId, { kind: 'info', title: `${p.key}'s resource request went to ${holder}`.slice(0, 200), body: `${pmName}'s case: ${reason || 'you did not answer in time'}. Your answer (${answer}) travels with it.`.slice(0, 600), origin: 'org', payload: JSON.stringify({ orgId, requestId: r.id, approvalId: a.id }) }).catch(() => undefined);
    return { row: out, note: `Escalated: card ${a.id.slice(0, 8)} is with ${holder} (the head's manager decides first, then the CEO). ${headName}'s answer travels with it.` };
  }

  /** The conflict card approved: grant as asked. */
  private async applyConflict(orgId: string, requestId: string, holder: string): Promise<Record<string, unknown>> {
    const r = await this.requestRow(orgId, requestId);
    const member = r.agentId ?? r.decidedAgentId;
    const by = holder.startsWith('agent:') || holder.startsWith('human:') ? holder : 'user';
    if (member) {
      const seat = await this.teams.grant(orgId, r.projectId, { agentId: member, role: r.role, allocation: r.allocation, why: `resource conflict granted for request ${r.id.slice(0, 8)}` }, by);
      await this.patchRequest(orgId, r.id, { status: 'approved', decidedAgentId: member, decidedAllocation: r.allocation, decisionNote: `${r.decisionNote ? `${r.decisionNote} — ` : ''}granted on escalation`, decidedBy: by.slice(0, 80), decidedAt: nowIso(), memberRowId: seat.id });
    } else {
      await this.patchRequest(orgId, r.id, { status: 'granted', decisionNote: `${r.decisionNote ? `${r.decisionNote} — ` : ''}granted on escalation: the head fills it`, decidedBy: by.slice(0, 80), decidedAt: nowIso() });
      if (r.headAgentId) await this.agents.addEvent(r.headAgentId, { kind: 'info', title: `Fill the granted resource request ${r.id.slice(0, 8)} (${r.role} at ${r.allocation}%)`, body: 'Your manager granted the Program Manager\'s request: name the member with org_resource_decide approve (or hire to fill it).', origin: 'org', payload: JSON.stringify({ orgId, requestId: r.id }) }).catch(() => undefined);
    }
    await this.audit.append(orgId, { actor: by, action: 'resource_decide', refType: 'project', refId: r.projectId, payload: { requestId: r.id, decision: member ? 'approved' : 'granted', role: r.role, agentId: member, allocation: r.allocation, onEscalation: true } });
    if (r.pmAgentId) await this.agents.addEvent(r.pmAgentId, { kind: 'info', title: `Resource conflict decided for you: ${r.role} at ${r.allocation}%`, body: member ? 'The seat is filled; assign the work.' : 'The head fills it next.', origin: 'org', payload: JSON.stringify({ orgId, requestId: r.id }) }).catch(() => undefined);
    return { requestId: r.id, status: member ? 'approved' : 'granted' };
  }

  /** The conflict card rejected or sent back: the head's answer stands. */
  private async upheld(orgId: string, requestId: string, prev: string, note: string): Promise<void> {
    const r = await this.requestRow(orgId, requestId);
    if (r.status !== 'escalated') return;
    const status = prev === 'open' ? 'declined' : prev;
    await this.patchRequest(orgId, r.id, { status, approvalId: null, decisionNote: `${r.decisionNote ? `${r.decisionNote} — ` : ''}upheld on escalation${note ? `: ${note}` : ''}`.slice(0, 600) });
    await this.audit.append(orgId, { actor: 'system', action: 'resource_decide', refType: 'project', refId: r.projectId, payload: { requestId: r.id, decision: status, upheld: true, note: note.slice(0, 300) } });
    if (r.pmAgentId) await this.agents.addEvent(r.pmAgentId, { kind: 'info', title: `The head's answer on ${r.role} stands`, body: `${note || 'No change.'} Re-plan the scope or the window, or ask another head.`.slice(0, 600), origin: 'org', payload: JSON.stringify({ orgId, requestId: r.id }) }).catch(() => undefined);
  }

  /** The PM takes a request back. */
  async withdraw(orgId: string, id: string, actor: string): Promise<{ note: string }> {
    const org = await this.org.get(orgId);
    const r = await this.requestRow(orgId, id);
    const p = await this.org.project(orgId, r.projectId);
    await this.requireOwnerOrAbove(org, actor, p.ownerAgentId, `${p.key}`);
    if (!['open', 'hiring', 'declined', 'adjusted'].includes(r.status)) throw new BadRequestException(`that request is ${r.status}`);
    await this.patchRequest(orgId, r.id, { status: 'withdrawn' });
    await this.audit.append(orgId, { actor, action: 'resource_withdraw', refType: 'project', refId: p.id, payload: { requestId: r.id, key: p.key } });
    return { note: `Request ${r.id.slice(0, 8)} withdrawn.` };
  }

  // ---- the tick: defaults, overdue answers, due reviews ----

  async tick(org: Organization, now: Date): Promise<DueMeeting[]> {
    if (org.status !== 'active') return [];
    const last = this.seededAt.get(org.id) ?? 0;
    if (now.getTime() - last >= SEED_EVERY_MS || last > now.getTime()) {
      this.seededAt.set(org.id, now.getTime());
      await this.seedAll(org, now).catch((err: unknown) => this.logger.warn(`program defaults: ${err instanceof Error ? err.message : err}`));
    }
    for (const r of (await this.requestRows(org.id)).filter((x) => x.status === 'open' && x.answerBy && x.answerBy <= now.toISOString())) {
      await this.escalate(org.id, r.id, '', 'system', now).catch((err: unknown) => this.logger.warn(`resource request escalation: ${err instanceof Error ? err.message : err}`));
    }
    return this.dueReviews(org, now);
  }

  /** Every active objective and project gets its default rhythm once. */
  async seedAll(org: Organization, now = new Date()): Promise<void> {
    const rows = await this.cadenceRows(org.id);
    const have = new Set(rows.map((r) => `${r.refId}:${r.kind}`));
    for (const g of (await this.org.goals(org.id)).filter((x) => x.kind === 'objective' && x.status === 'active')) if (!have.has(`${g.id}:goal_review`)) await this.ensureDefaults(org, 'goal', g.id, 'system', now);
    for (const p of (await this.org.projects(org.id)).filter((x) => x.kind === 'project' && !CLOSED_PROJECT.has(x.status) && x.status !== 'proposed')) if (!have.has(`${p.id}:milestone_review`)) await this.ensureDefaults(org, 'project', p.id, 'system', now);
  }

  /** The goal and milestone reviews due at `now` (the meeting runtime's tick). */
  async dueReviews(org: Organization, now: Date): Promise<DueMeeting[]> {
    const out: DueMeeting[] = [];
    const due = (await this.cadenceRows(org.id)).filter((c) => c.enabled === 1 && c.nextAt && c.nextAt <= now.toISOString());
    if (due.length === 0) return out;
    const names = new Map((await this.agents.list()).map((a) => [a.id, a.name]));
    const nm = (id: string | null | undefined) => (id ? names.get(id) ?? id.slice(0, 8) : 'nobody');
    const goals = await this.org.goals(org.id);
    const projects = await this.org.projects(org.id);
    const team = (await this.org.projectMembers(org.id)).filter((r) => r.status === 'active');
    const members = await this.org.members(org.id);
    const tolerance = tunable(org, 'intent.paceTolerance');
    for (const c of due) {
      await this.db.update(orgProgramCadences).set({ lastAt: now.toISOString(), nextAt: nextFire(c.cron, now)?.toISOString() ?? null }).where(eq(orgProgramCadences.id, c.id));
      const skip = async (reason: string) => { await this.audit.append(org.id, { actor: 'system', action: 'meeting_skipped', refType: c.refType, refId: c.refId, payload: { kind: c.kind, reason } }); };
      if (c.refType === 'goal') {
        const g = goals.find((x) => x.id === c.refId);
        if (!g || g.status !== 'active' || !g.ownerAgentId) { await skip('the goal is not active or has no owner'); continue; }
        const krs = goals.filter((x) => x.parentGoalId === g.id && x.kind === 'key_result' && x.status === 'active');
        const ids = new Set([g.id, ...krs.map((k) => k.id)]);
        const linked = projects.filter((p) => p.kind === 'project' && !CLOSED_PROJECT.has(p.status) && idList(p.goalIds).some((x) => ids.has(x)));
        if (krs.length === 0 && linked.length === 0) { await skip('no key result and no project to review'); continue; }
        const channelId = await this.goalChannel(org, g);
        if (!channelId) { await skip('no channel to hold it in'); continue; }
        const heads = new Set<string>();
        for (const r of team.filter((x) => linked.some((p) => p.id === x.projectId))) { const m = members.find((x) => x.agentId === r.agentId); if (m?.reportsToAgentId && m.reportsToAgentId !== org.chiefOfStaffAgentId) heads.add(m.reportsToAgentId); }
        const attendees = [g.ownerAgentId, ...krs.map((k) => k.ownerAgentId), ...linked.map((p) => p.ownerAgentId), ...heads].filter((x): x is string => Boolean(x) && members.some((m) => m.agentId === x && m.status === 'active'));
        out.push({
          kind: 'weekly_review', channelId, title: `Goal review: ${g.title}`.slice(0, 120), facilitatorAgentId: g.ownerAgentId, createdBy: 'program',
          attendees: [...new Set(attendees)].slice(0, 8).map((id) => ({ kind: 'agent' as const, id })),
          agenda: [
            `Goal review of "${g.title}" — run by its Program Manager, ${nm(g.ownerAgentId)}.`,
            ...krs.map((k) => { const pc = paceOf(k, now, tolerance); return `- KR "${k.title}": ${k.currentValue ?? k.startValue ?? '?'}/${k.targetValue ?? '?'}${k.unitLabel ? ` ${k.unitLabel}` : ''}, ${pc.pace === 'behind' ? 'BEHIND pace' : pc.pace === 'onPace' ? 'on pace' : 'pace unknown'}${k.atRisk ? ', AT RISK' : ''}; confidence ${k.confidence ?? '?'}; owner ${nm(k.ownerAgentId)}`; }),
            ...linked.map((p) => `- ${p.key} "${p.title}": ${p.health ? p.health.replace('_', ' ') : 'no update yet'}${p.healthAsk ? ` — ask: ${p.healthAsk}` : ''}; lead ${nm(p.ownerAgentId)}`),
            '- Resources: what each project still needs from the heads, and what they answered',
            `- Close: ${nm(g.ownerAgentId)} checks in each key result it owns (org_check_in) and posts each project's status (org_project_update: health, progress, risks, asks)`,
          ].join('\n'),
        });
      } else {
        const p = projects.find((x) => x.id === c.refId);
        if (!p || p.kind !== 'project' || CLOSED_PROJECT.has(p.status) || !p.ownerAgentId) { await skip('the project is closed or has no owner'); continue; }
        const open = (await this.tasks.list(org.id, { projectId: p.id })).filter((t) => !['done', 'cancelled'].includes(t.status));
        const ms = milestonesOf(p).filter((m) => !m.done);
        if (open.length === 0 && ms.length === 0) { await skip('no open task and no open milestone'); continue; }
        const channelId = p.channelId ?? await this.teams.ensureChannel(org.id, p).catch(() => null);
        if (!channelId) { await skip('no channel to hold it in'); continue; }
        const seats = team.filter((r) => r.projectId === p.id && r.agentId);
        const ap = p.appetiteDays || p.appetiteUsd ? `appetite ${p.appetiteDays ? `${p.appetiteDays}d` : ''}${p.appetiteDays && p.appetiteUsd ? ' / ' : ''}${p.appetiteUsd ? `$${p.appetiteUsd}` : ''}${p.breakerAt ? ' — BREAKER TRIPPED' : ''}` : 'no appetite set';
        out.push({
          kind: 'weekly_review', channelId, title: `${p.key} milestone review`, facilitatorAgentId: p.ownerAgentId, createdBy: 'program',
          attendees: [p.ownerAgentId, ...seats.map((r) => r.agentId!)].filter((x, i, a) => a.indexOf(x) === i).slice(0, 8).map((id) => ({ kind: 'agent' as const, id })),
          agenda: [
            `Milestone review of ${p.key} "${p.title}" — run by its Program Manager, ${nm(p.ownerAgentId)}; ${ap}; ${open.length} open task(s).`,
            ...ms.slice(0, 4).map((m) => `- Milestone "${m.name}"${m.date ? ` due ${m.date}` : ''}: on track, at risk or slipping — and why`),
            `- Team and allocations: ${seats.length ? seats.map((r) => `${nm(r.agentId)} ${r.allocation}%`).join(', ') : 'no team yet'} — what the project needs that it does not have (org_resource_request)`,
            `- Close: ${nm(p.ownerAgentId)} posts the status update (org_project_update: health, progress, risks, asks)`,
          ].join('\n'),
        });
      }
    }
    return out;
  }

  private async goalChannel(org: Organization, g: OrgGoal): Promise<string | null> {
    const units = this.units ? await this.units.units(org.id).catch(() => [] as OrgUnit[]) : [];
    const u = g.unitId ? units.find((x) => x.id === g.unitId) : undefined;
    if (u?.channelId) return u.channelId;
    const root = units.find((x) => x.parentUnitId === null);
    if (root?.channelId) return root.channelId;
    const ch = this.announcer?.channels;
    return ch ? (await ch.companyChannel(org.workspaceId).catch(() => null))?.id ?? null : null;
  }

  // ---- views ----

  async describeRequests(orgId: string, rows: OrgResourceRequest[], now = new Date()): Promise<RequestView[]> {
    const names = new Map((await this.agents.list()).map((a) => [a.id, a.name]));
    const projects = new Map((await this.org.projects(orgId)).map((p) => [p.id, p]));
    const units = this.units ? new Map((await this.units.units(orgId).catch(() => [] as OrgUnit[])).map((u) => [u.id, u.name])) : new Map<string, string>();
    const nm = (id: string | null) => (id ? names.get(id) ?? id.slice(0, 8) : null);
    return rows.map((r) => {
      const p = projects.get(r.projectId);
      return {
        id: r.id, projectId: r.projectId, projectKey: p?.key ?? null, projectTitle: p?.title ?? '', goalId: r.goalId,
        pmAgentId: r.pmAgentId, pmName: nm(r.pmAgentId) ?? 'nobody', headAgentId: r.headAgentId, headName: nm(r.headAgentId) ?? 'a head', unitName: r.unitId ? units.get(r.unitId) ?? null : null,
        role: r.role, skills: r.skills, agentId: r.agentId, agentName: nm(r.agentId), allocation: r.allocation,
        startDate: r.startDate, endDate: r.endDate, budgetUsd: r.budgetUsd, why: r.why,
        status: r.status, decidedAgentId: r.decidedAgentId, decidedAgentName: nm(r.decidedAgentId), decidedAllocation: r.decidedAllocation,
        decisionNote: r.decisionNote, decidedBy: r.decidedBy, decidedAt: r.decidedAt, approvalId: r.approvalId, memberRowId: r.memberRowId,
        answerBy: r.answerBy, overdue: r.status === 'open' && Boolean(r.answerBy && r.answerBy <= now.toISOString()), createdAt: r.createdAt,
      };
    });
  }

  /** The whole matrix: every active goal and project with its owner, rhythm,
   *  team and requests; every member with its line manager and its project
   *  seats; the health counts. */
  async matrix(orgId: string, now = new Date()): Promise<ProgramMatrix> {
    const org = await this.org.get(orgId);
    const members = await this.org.members(orgId);
    const names = new Map((await this.agents.list()).map((a) => [a.id, a.name]));
    const nm = (id: string | null | undefined) => (id ? names.get(id) ?? id.slice(0, 8) : 'nobody');
    const goals = (await this.org.goals(orgId)).filter((g) => (g.kind === 'objective' || g.kind === 'key_result') && g.status === 'active');
    const projects = (await this.org.projects(orgId)).filter((p) => p.kind === 'project' && !CLOSED_PROJECT.has(p.status));
    const seats = (await this.org.projectMembers(orgId)).filter((r) => LIVE_SEAT.has(r.status) && projects.some((p) => p.id === r.projectId));
    const cadenceRows = await this.cadenceRows(orgId);
    const reqRows = await this.requestRows(orgId);
    const requests = await this.describeRequests(orgId, reqRows, now);
    const units = this.units ? await this.units.units(orgId).catch(() => [] as OrgUnit[]) : [];
    const pms = members.filter((m) => m.status === 'active' && isProgramManagerTitle(m.title));
    const chiefActing = pms.length === 0;
    const seatView = (r: OrgProjectMember): SeatView => { const m = members.find((x) => x.agentId === r.agentId); return { agentId: r.agentId, name: r.agentId ? nm(r.agentId) : 'a person', role: r.role, allocation: r.allocation, status: r.status, headName: m?.reportsToAgentId ? nm(m.reportsToAgentId) : 'the CEO' }; };
    const items: ProgramItem[] = [];
    for (const g of goals.sort((a, b) => (a.kind === b.kind ? a.createdAt.localeCompare(b.createdAt) : a.kind === 'objective' ? -1 : 1))) {
      const krs = g.kind === 'objective' ? goals.filter((k) => k.parentGoalId === g.id && k.kind === 'key_result') : [];
      const ids = new Set([g.id, ...krs.map((k) => k.id)]);
      const linked = projects.filter((p) => idList(p.goalIds).some((x) => ids.has(x)));
      const cad = await this.cadencesOf(org, { refType: 'goal', goal: g, krs, projects: linked }, cadenceRows, now);
      items.push({
        refType: 'goal', id: g.id, key: null, kind: g.kind, title: g.title, status: g.status, lane: null, health: g.atRisk ? 'at_risk' : null,
        owner: this.ownerOf(org, members, names, g.ownerAgentId), cadences: cad,
        team: seats.filter((r) => linked.some((p) => p.id === r.projectId)).map(seatView),
        requests: requests.filter((q) => (q.goalId && ids.has(q.goalId)) || linked.some((p) => p.id === q.projectId)).filter((q) => OPEN_REQUEST.has(q.status) || q.status === 'declined'),
        links: linked.map((p) => ({ id: p.id, key: p.key, title: p.title })), stale: cad.some((c) => c.stale),
      });
    }
    for (const p of projects) {
      const cad = await this.cadencesOf(org, { refType: 'project', project: p }, cadenceRows, now);
      items.push({
        refType: 'project', id: p.id, key: p.key, kind: 'project', title: p.title, status: p.status, lane: p.lane, health: p.health || null,
        owner: this.ownerOf(org, members, names, p.ownerAgentId, p.leadHumanId), cadences: cad,
        team: seats.filter((r) => r.projectId === p.id).map(seatView),
        requests: requests.filter((q) => q.projectId === p.id && (OPEN_REQUEST.has(q.status) || q.status === 'declined')),
        links: idList(p.goalIds).map((id) => goals.find((g) => g.id === id)).filter((g): g is OrgGoal => Boolean(g)).map((g) => ({ id: g.id, key: null, title: g.title })),
        stale: cad.some((c) => c.stale && (c.kind !== 'sync' || seats.some((r) => r.projectId === p.id && r.status === 'active'))),
      });
    }
    const warn = programTunable(org, 'program.allocationWarnPct');
    const homeUnit = (agentId: string) => {
      const led = units.find((u) => u.leadAgentId === agentId && u.parentUnitId !== null);
      if (led) return led;
      let cur = members.find((m) => m.agentId === agentId)?.reportsToAgentId ?? null;
      for (let i = 0; cur && i < 10; i++) { const u = units.find((x) => x.leadAgentId === cur); if (u) return u; cur = members.find((m) => m.agentId === cur)?.reportsToAgentId ?? null; }
      return null;
    };
    const matrixMembers: MatrixMember[] = members.filter((m) => m.status === 'active' && m.agentId !== org.auditorAgentId).map((m) => {
      const mine = seats.filter((r) => r.agentId === m.agentId);
      const total = mine.reduce((s, r) => s + r.allocation, 0);
      return {
        agentId: m.agentId, name: nm(m.agentId), title: m.agentId === org.chiefOfStaffAgentId ? 'Chief of staff' : m.title,
        lineManager: m.agentId === org.chiefOfStaffAgentId ? 'the CEO' : m.reportsToAgentId ? nm(m.reportsToAgentId) : 'the CEO', unitName: homeUnit(m.agentId)?.name ?? null,
        assignments: mine.map((r) => { const p = projects.find((x) => x.id === r.projectId)!; return { projectId: p.id, key: p.key, title: p.title, role: r.role, allocation: r.allocation, status: r.status, pmName: nm(p.ownerAgentId) }; }),
        owns: items.filter((i) => i.owner.agentId === m.agentId && (i.refType === 'project' || i.kind === 'objective')).map((i) => ({ refType: i.refType, id: i.id, key: i.key, title: i.title })),
        total, stretched: total > warn, isPm: isProgramManagerTitle(m.title), isHead: isHeadMember(m, org, members.some((x) => x.reportsToAgentId === m.agentId && x.status !== 'terminated')),
      };
    });
    const outcomeItems = items.filter((i) => i.refType === 'project' || i.kind === 'objective');
    const open = requests.filter((q) => OPEN_REQUEST.has(q.status));
    return {
      pms: pms.map((m) => ({ agentId: m.agentId, name: nm(m.agentId), owns: outcomeItems.filter((i) => i.owner.agentId === m.agentId).length })),
      chiefActing, chiefName: nm(org.chiefOfStaffAgentId),
      items, members: matrixMembers, requests,
      health: {
        items: outcomeItems.length,
        unowned: outcomeItems.filter((i) => i.owner.role === 'none' || i.owner.role === 'inactive').length,
        acting: outcomeItems.filter((i) => i.owner.role === 'acting_chief').length,
        nonPm: outcomeItems.filter((i) => !chiefActing && (i.owner.role === 'head' || i.owner.role === 'member')).length,
        stretched: matrixMembers.filter((m) => m.stretched).length,
        staleCadences: outcomeItems.filter((i) => i.stale).length,
        openRequests: open.length, overdueRequests: open.filter((q) => q.overdue).length,
      },
      bounds: {
        syncMinDays: programTunable(org, 'program.syncMinDays'), syncMaxDays: programTunable(org, 'program.syncMaxDays'),
        reviewMinDays: programTunable(org, 'program.reviewMinDays'), reviewMaxDays: programTunable(org, 'program.reviewMaxDays'),
        allocationWarnPct: warn, requestAnswerHours: programTunable(org, 'program.requestAnswerHours'),
      },
    };
  }

  /** The matrix as a model reads it: what `agentId` owns (or, for the chief
   *  and a person, the company), each item's rhythm, team and requests. */
  async describeFor(orgId: string, agentId: string | null, now = new Date()): Promise<string> {
    const m = await this.matrix(orgId, now);
    const org = await this.org.get(orgId);
    const isChief = agentId === org.chiefOfStaffAgentId;
    const fmt = (iso: string | null) => (iso ? iso.slice(0, 16).replace('T', ' ') : '—');
    const itemLine = (i: ProgramItem) => [
      `- ${i.refType === 'project' ? i.key : `${i.kind.replace('_', ' ')} [${i.id.slice(0, 8)}]`} "${i.title}" — owner ${i.owner.name} (${i.owner.role.replace('_', ' ')})${i.health ? `; ${i.health.replace('_', ' ')}` : ''}${i.stale ? '; RHYTHM STALE' : ''}`,
      `  rhythm: ${i.cadences.map((c) => `${c.label} ${c.enabled ? `${c.cron ?? `every ${c.everyDays}d`}, next ${fmt(c.nextAt)}${c.stale ? ' (stale)' : ''}` : 'OFF'}`).join('; ') || 'none'}`,
      i.team.length ? `  team: ${i.team.map((t) => `${t.name} ${t.role || 'member'} ${t.allocation}%${t.status === 'pending' ? ' (pending)' : ''} [head ${t.headName}]`).join(', ')}` : '',
      i.requests.length ? `  requests: ${i.requests.map((q) => `${q.id.slice(0, 8)} ${q.role} ${q.allocation}% → ${q.headName}: ${q.status}${q.overdue ? ' (OVERDUE)' : ''}${q.decisionNote ? ` (${q.decisionNote.slice(0, 80)})` : ''}`).join('; ')}` : '',
    ].filter(Boolean).join('\n');
    const lines: string[] = [];
    lines.push(m.chiefActing ? `No Program Manager yet: the chief of staff (${m.chiefName}) is the ACTING PM for what it owns — propose a Program Manager (role:ops-pm) once two or more Now projects or objectives compete for its attention.` : `Program Managers: ${m.pms.map((p) => `${p.name} (${p.owns} item(s))`).join(', ')}.`);
    const mine = agentId && !isChief ? m.items.filter((i) => i.owner.agentId === agentId) : m.items.filter((i) => i.refType === 'project' || i.kind === 'objective');
    lines.push(agentId && !isChief ? `You own ${mine.length} goal(s)/project(s):` : `Goals and projects (${mine.length}):`);
    lines.push(...mine.slice(0, 20).map(itemLine));
    if (agentId) {
      const toDecide = m.requests.filter((q) => q.headAgentId === agentId && ['open', 'granted'].includes(q.status));
      if (toDecide.length) lines.push(`Resource requests waiting on you (org_resource_decide): ${toDecide.map((q) => `${q.id.slice(0, 8)} ${q.projectKey} ${q.role} ${q.allocation}%${q.agentName ? ` (${q.agentName})` : ''}${q.status === 'granted' ? ' — GRANTED on escalation: name the member' : ''}, answer by ${fmt(q.answerBy)}`).join('; ')}`);
      const me = m.members.find((x) => x.agentId === agentId);
      if (me?.assignments.length) lines.push(`Your seats: ${me.assignments.map((a) => `${a.key} ${a.role || 'member'} ${a.allocation}% (PM ${a.pmName})`).join(', ')} — ${me.total}% of your time; line manager ${me.lineManager}.`);
    }
    if (!agentId || isChief) {
      const h = m.health;
      lines.push(`Matrix health: ${h.unowned} without an owner, ${h.acting} the chief acts as PM on, ${h.nonPm} owned outside a PM, ${h.stretched} member(s) stretched past ${m.bounds.allocationWarnPct}%, ${h.staleCadences} with a stale rhythm, ${h.openRequests} open resource request(s) (${h.overdueRequests} overdue).`);
      const stretched = m.members.filter((x) => x.stretched);
      if (stretched.length) lines.push(`Stretched: ${stretched.map((x) => `${x.name} ${x.total}% (${x.assignments.map((a) => `${a.key} ${a.allocation}%`).join(', ')}; head ${x.lineManager})`).join('; ')}`);
    }
    lines.push(`Bounds: sync every ${m.bounds.syncMinDays}–${m.bounds.syncMaxDays} day(s), goal and milestone reviews every ${m.bounds.reviewMinDays}–${m.bounds.reviewMaxDays} day(s); a head answers a request within ${m.bounds.requestAnswerHours}h.`);
    return lines.join('\n');
  }

  // ---- signals and heartbeat ----

  async signals(org: Organization, now: Date): Promise<SignalInput[]> {
    const out: SignalInput[] = [];
    const m = await this.matrix(org.id, now);
    for (const i of m.items.filter((x) => (x.refType === 'project' || x.kind === 'objective') && (x.owner.role === 'none' || x.owner.role === 'inactive'))) {
      out.push({ kind: 'program_unowned', severity: 'warn', refType: i.refType, refId: i.id, title: `${i.refType === 'project' ? i.key : 'Objective'} "${i.title}" has no ${i.owner.role === 'inactive' ? 'active ' : ''}owner`, detail: `Assign it to a Program Manager (org_program_assign)${m.chiefActing ? ', or own it yourself as the acting PM until one is hired' : ''}.`, addressee: 'chief' });
    }
    const acting = m.items.filter((x) => (x.refType === 'project' || x.kind === 'objective') && x.owner.role === 'acting_chief');
    const nowProjects = m.items.filter((x) => x.refType === 'project' && x.lane === 'now').length;
    if (acting.length >= 2 && (m.chiefActing ? nowProjects >= 2 || acting.length >= 3 : true)) {
      out.push({ kind: 'program_acting', severity: 'info', refType: 'org', refId: `${org.id}:acting`, title: m.chiefActing ? `The chief acts as Program Manager for ${acting.length} goals/projects: no PM yet` : `The chief still owns ${acting.length} goals/projects a Program Manager should`, detail: m.chiefActing ? 'Propose a Program Manager hire (role:ops-pm, org_hire_agent) so outcomes have an owner who is not running the company.' : 'Hand them to the Program Managers (org_program_assign).', addressee: 'chief' });
    }
    for (const mm of m.members.filter((x) => x.stretched)) {
      const member = (await this.org.member(org.id, mm.agentId))!;
      const head = member.reportsToAgentId;
      const detail = `${mm.name} is allocated ${mm.total}% to project teams (${mm.assignments.map((a) => `${a.key} ${a.allocation}%`).join(', ')}), past ${m.bounds.allocationWarnPct}% (program.allocationWarnPct): little is left for its unit. The head and the PMs agree what gives (a smaller seat, a later window, or another member).`;
      out.push({ kind: 'member_stretched', severity: 'warn', refType: 'agent', refId: mm.agentId, title: `${mm.name} is stretched: ${mm.total}% on projects`, detail, addressee: head ? 'lead' : 'chief', addresseeId: head ?? undefined });
      for (const a of mm.assignments) {
        const p = m.items.find((x) => x.refType === 'project' && x.id === a.projectId);
        if (p?.owner.agentId && p.owner.agentId !== head) out.push({ kind: 'member_stretched', severity: 'warn', refType: 'agent', refId: `${mm.agentId}:${a.projectId}`, title: `${mm.name} (on ${a.key} at ${a.allocation}%) is stretched: ${mm.total}% on projects`, detail, addressee: 'owner', addresseeId: p.owner.agentId });
      }
    }
    for (const i of m.items.filter((x) => x.stale && x.owner.agentId && (x.refType === 'project' || x.kind === 'objective'))) {
      const which = i.cadences.filter((c) => c.stale).map((c) => `${c.label}${c.enabled ? ' (no output)' : ' (off)'}`).join(', ');
      out.push({ kind: 'cadence_stale', severity: 'info', refType: i.refType, refId: i.id, title: `${i.refType === 'project' ? i.key : 'Objective'} "${i.title}": stale rhythm — ${which}`, detail: 'Hold it and post the status (org_project_update / org_check_in), or set a rhythm the item can keep (org_program_cadence).', addressee: 'owner', addresseeId: i.owner.agentId! });
    }
    return out;
  }

  async heartbeatReasons(agentId: string, now: Date): Promise<string[]> {
    const out: string[] = [];
    for (const ms of (await this.org.membershipsOf(agentId)).filter((x) => x.status === 'active')) {
      const org = await this.org.get(ms.orgId).catch(() => null);
      if (!org || org.status !== 'active') continue;
      const reqs = await this.requestRows(org.id);
      const isChief = org.chiefOfStaffAgentId === agentId;
      // A head: requests waiting on it.
      for (const r of reqs.filter((x) => x.headAgentId === agentId && (x.status === 'open' || x.status === 'granted')).slice(0, 4)) {
        const p = await this.org.project(org.id, r.projectId).catch(() => null);
        out.push(`resource request ${r.id.slice(0, 8)} for ${p?.key ?? 'a project'}: ${r.role} at ${r.allocation}%${r.agentId ? ` (${await this.nameOf(r.agentId)})` : ''} from ${await this.nameOf(r.pmAgentId)} — ${r.status === 'granted' ? 'granted on escalation: name the member who fills it' : `approve, adjust, decline with the reason, or hire (org_resource_decide) by ${(r.answerBy ?? '').slice(0, 16).replace('T', ' ')} UTC`}`);
      }
      // A PM (or acting chief): answers to act on, items without a rhythm.
      const recent = now.getTime() - programTunable(org, 'program.requestAnswerHours') * 3_600_000;
      for (const r of reqs.filter((x) => x.pmAgentId === agentId && (x.status === 'declined' || x.status === 'adjusted') && Date.parse(x.decidedAt ?? x.updatedAt ?? x.createdAt) >= recent).slice(0, 3)) {
        const p = await this.org.project(org.id, r.projectId).catch(() => null);
        out.push(`${await this.nameOf(r.headAgentId)} ${r.status} your request ${r.id.slice(0, 8)} for ${p?.key ?? 'a project'} (${r.role} ${r.allocation}%)${r.decisionNote ? `: ${r.decisionNote.slice(0, 120)}` : ''} — re-plan, ask another head, or escalate (org_resource_escalate)`);
      }
      const rows = await this.cadenceRows(org.id);
      const owned = [
        ...(await this.org.goals(org.id)).filter((g) => g.kind === 'objective' && g.status === 'active' && g.ownerAgentId === agentId).map((g) => ({ id: g.id, label: `objective "${g.title}"`, kind: 'goal_review' })),
        ...(await this.org.projects(org.id)).filter((p) => p.kind === 'project' && p.status === 'active' && p.ownerAgentId === agentId).map((p) => ({ id: p.id, label: `${p.key}`, kind: 'milestone_review' })),
      ];
      const off = owned.filter((o) => rows.some((r) => r.refId === o.id && r.kind === o.kind && r.enabled === 0));
      if (off.length) out.push(`${off.length} item(s) you own have no review rhythm (${off.slice(0, 3).map((o) => o.label).join(', ')}): set one within the company's bounds (org_program_cadence)`);
      if (isChief) {
        const pms = await this.programManagers(org.id);
        const chiefOwned = owned.length;
        if (pms.length && chiefOwned) out.push(`you still own ${chiefOwned} goal(s)/project(s) the company's Program Managers should: hand them over (org_program_assign)`);
      }
    }
    return out;
  }

  private async nameOf(agentId: string | null | undefined): Promise<string> {
    if (!agentId) return 'nobody';
    return (await this.agents.get(agentId).catch(() => null))?.name ?? agentId.slice(0, 8);
  }
}
