/**
 * OrgService — organisations, membership, goals, projects, budgets and
 * grants (docs/autonomous-company.md §4.1). Policy lives here as code, not
 * in charters: depth ≤ maxDepth (hard ceiling 3), direct reports ≤
 * maxDirectReports (default 5), no cycles, scopes that only narrow without
 * an approval, terminated members' reports moving up one level, and the
 * org-level kill switch (`status = paused`).
 *
 * Agents stay global: an org member is a pointer to an agent plus the role
 * it plays *here*. Deleting the org leaves the agents.
 */
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { PROJECT_LANES, PROJECT_STATUSES, normalizeDay, parseIdList, parseProjectBrief, type Milestone, type ProjectBrief, type ProjectKind } from './work-model';
import { organizations, orgMembers, orgGoals, orgProjects, orgProjectMembers, orgBudgets, orgGrants, orgHumans, orgAllocations, workspaces } from '../database/schema';
import { TriggerBus } from '../chats/trigger-bus';
import { newId, nowIso } from '../common/ids.util';
import { currentAccountId } from '../accounts/account-context';
import { AgentsService } from '../agents/agents.service';
import { OrgAuditService } from './org-audit.service';
import { isNarrowing, parseScopes, scopeKind, widenedScopes } from './scopes';
import { checkTunable, parseTunables, tunable, TUNABLES } from './org-tunables';
import { mergeRouting, parseRouting, type ModelTier, type OrgRouting } from './org-routing';
// The chief's operating-system keys register on the shared registry at import (docs/chief-of-staff.md).
import './chief-tunables';
import { roleById, roleCharter } from './roles/catalog';
import { checkBoundary, type BoundaryDecision, type SelfChange } from './boundary';
import { PROFESSION_PACKS } from '../market/profession-packs.generated';
import { AUTHORED_PACKS } from '../market/authored-packs.generated';

export type Organization = typeof organizations.$inferSelect;
export type OrgMember = typeof orgMembers.$inferSelect;
export type OrgGoal = typeof orgGoals.$inferSelect;
export type OrgProject = typeof orgProjects.$inferSelect;
export type OrgProjectMember = typeof orgProjectMembers.$inferSelect;

/** The fields a project is created with (docs/work-tracking.md). */
export interface ProjectCreate {
  title: string; goalId?: string | null; goalIds?: string[]; ownerAgentId?: string | null; leadHumanId?: string | null; unitId?: string | null;
  kind?: ProjectKind; brief?: Partial<ProjectBrief> | string; startDate?: string | null; targetDate?: string | null; milestones?: unknown;
  appetiteDays?: number | null; appetiteUsd?: number | null; lane?: string; status?: string; rank?: number; updateCadenceDays?: number | null;
}
export interface ProjectPatch extends Partial<Omit<ProjectCreate, 'title' | 'kind'>> {
  title?: string; health?: string; healthReason?: string; healthAsk?: string; healthAt?: string | null; hill?: number | null; breakerAt?: string | null; appetiteWarnedAt?: string | null;
}

/** Validate the plain fields of a project create or patch; throws a 400 with the reason. */
function projectFields(input: Partial<ProjectCreate>): { status?: string; lane?: string; startDate?: string | null; targetDate?: string | null; milestones?: Milestone[]; appetiteDays?: number; appetiteUsd?: number; updateCadenceDays?: number | null } {
  const out: ReturnType<typeof projectFields> = {};
  const day = (v: unknown, what: string) => { try { return normalizeDay(v); } catch (err) { throw new BadRequestException(`${what}: ${(err as Error).message}`); } };
  if (input.status !== undefined) { if (!(PROJECT_STATUSES as readonly string[]).includes(input.status)) throw new BadRequestException(`project status must be one of ${PROJECT_STATUSES.join(', ')}`); out.status = input.status; }
  if (input.lane !== undefined) { if (!(PROJECT_LANES as readonly string[]).includes(input.lane)) throw new BadRequestException(`lane must be one of ${PROJECT_LANES.join(', ')}`); out.lane = input.lane; }
  if (input.startDate !== undefined) out.startDate = day(input.startDate, 'startDate');
  if (input.targetDate !== undefined) out.targetDate = day(input.targetDate, 'targetDate');
  if (out.startDate && out.targetDate && out.targetDate < out.startDate) throw new BadRequestException('targetDate is before startDate');
  if (input.milestones !== undefined) {
    const raw = Array.isArray(input.milestones) ? input.milestones : [];
    out.milestones = raw.slice(0, 30).map((m, i) => {
      const x = (m ?? {}) as Record<string, unknown>;
      const name = String(x.name ?? '').trim().slice(0, 120);
      if (!name) throw new BadRequestException('a milestone needs a name');
      return { id: String(x.id ?? `m${i + 1}`), name, date: day(x.date, `milestone "${name}"`), done: Boolean(x.done), ...(x.done ? { doneAt: String(x.doneAt ?? nowIso()) } : {}) };
    });
  }
  if (input.appetiteDays !== undefined && input.appetiteDays !== null) { const n = Math.round(Number(input.appetiteDays)); if (!Number.isFinite(n) || n < 0 || n > 3_650) throw new BadRequestException('appetiteDays is 0–3650'); out.appetiteDays = n; }
  if (input.appetiteUsd !== undefined && input.appetiteUsd !== null) { const n = Number(input.appetiteUsd); if (!Number.isFinite(n) || n < 0) throw new BadRequestException('appetiteUsd must be ≥ 0'); out.appetiteUsd = Math.round(n * 100) / 100; }
  if (input.updateCadenceDays !== undefined) { if (input.updateCadenceDays === null) out.updateCadenceDays = null; else { const n = Math.round(Number(input.updateCadenceDays)); if (!Number.isFinite(n) || n < 1 || n > 30) throw new BadRequestException('updateCadenceDays is 1–30'); out.updateCadenceDays = n; } }
  return out;
}
export type OrgBudget = typeof orgBudgets.$inferSelect;
export type OrgHuman = typeof orgHumans.$inferSelect;
export type OrgAllocation = typeof orgAllocations.$inferSelect;
/** Intent (docs/company-vision.md §2): what a goal row is. */
export type GoalKind = 'vision' | 'objective' | 'key_result';
export const GOAL_KINDS: readonly GoalKind[] = ['vision', 'objective', 'key_result'];
/** The key-result fields a goal may carry (OrgIntentService sets them). */
export interface GoalIntentFields {
  kind?: GoalKind; metric?: string; targetValue?: number | null; startValue?: number | null; currentValue?: number | null;
  unitLabel?: string; dueAt?: string | null; confidence?: number | null; checkInCadenceDays?: number; lastCheckInAt?: string | null;
}
/** Humans in an organisation (docs/autonomous-company.md phase D). An
 *  `employee` (docs/company-vision.md §4 hybrid staff, item 24) reports to a
 *  member, sits on its unit's chart and channel, and can own a task. */
export type HumanRole = 'ceo' | 'board' | 'observer' | 'employee';
export const HUMAN_ROLES: readonly HumanRole[] = ['ceo', 'board', 'observer', 'employee'];
/** Approval kinds a board member may decide; everything else is the CEO's. */
export const BOARD_DECIDES = new Set<string>(['hire', 'budget_raise', 'strategy']);

/** Whether a human role may decide an approval of `kind`. */
export function mayDecide(role: HumanRole | null, kind: string): boolean {
  if (role === 'ceo') return true;
  if (role === 'board') return BOARD_DECIDES.has(kind);
  return false;
}

export const MAX_DEPTH_CEILING = 3;
export const DEFAULT_MAX_DIRECT_REPORTS = 5;

/** The chief of staff's default holdings when the user creates it without
 *  naming scopes: the bounded, non-outward tool set. Anything outward
 *  (mail send, calendar write, code, browser) is a user grant. */
export const DEFAULT_CHIEF_SCOPES = ['tool:fs_read', 'tool:fs_write', 'tool:web_search', 'tool:web_fetch'];

export const charterHashOf = (charter: string): string => createHash('sha256').update(charter ?? '').digest('hex');

/** Runs after the reports-to tree changed (docs/group-chat.md §7: units
 *  follow the chart). Awaited, so a caller sees units in place on return. */
export type StructureChangeHook = (orgId: string) => Promise<void>;
/** Runs after a goal was created or changed (docs/company-vision.md §2: the
 *  cascade listens for an objective handed to a unit). `before` is null on
 *  creation. Awaited; a throwing hook never breaks the change. */
export type GoalChangeHook = (goal: OrgGoal, before: OrgGoal | null) => Promise<void> | void;

/** The self-modification boundary (docs/boundary.md, item 31): the decision
 *  for one self-change by one actor, with its side effects (a `never` by an
 *  agent is a finding and an incident). OrgBoundaryService binds it. */
export type BoundaryPort = (orgId: string, change: SelfChange, actor: string) => Promise<BoundaryDecision>;

@Injectable()
export class OrgService {
  private readonly structureHooks: StructureChangeHook[] = [];
  private readonly goalHooks: GoalChangeHook[] = [];
  private boundary?: BoundaryPort;

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly agents: AgentsService,
    private readonly audit: OrgAuditService,
    @Optional() private readonly bus?: TriggerBus,
  ) {}

  /** OrgBoundaryService binds the boundary here (docs/boundary.md). */
  bindBoundary(fn: BoundaryPort | undefined): void { this.boundary = fn; }

  /** The boundary's decision for a self-change (pure fallback when unbound). */
  async boundaryDecide(orgId: string, change: SelfChange, actor: string): Promise<BoundaryDecision> {
    if (this.boundary) return this.boundary(orgId, change, actor);
    return checkBoundary(change, actor);
  }

  /** The low-level fence every self-change writer calls: anything but
   *  `proceed` is refused here. Tool paths decide first (and turn `card` or
   *  `experiment` into a proposal), so an agent only reaches a writer with a
   *  change the boundary lets it make alone; humans pass. */
  async gate(orgId: string, change: SelfChange, actor: string): Promise<void> {
    const d = await this.boundaryDecide(orgId, change, actor);
    if (d.outcome === 'proceed') return;
    throw new BadRequestException(d.outcome === 'refuse' || d.outcome === 'experiment' ? d.reason : `refused: ${d.reason} — propose it; the CEO decides`);
  }

  /** OrgUnitsService registers here; a throwing hook never breaks the change. */
  onStructureChange(hook: StructureChangeHook): () => void {
    this.structureHooks.push(hook);
    return () => { const i = this.structureHooks.indexOf(hook); if (i >= 0) this.structureHooks.splice(i, 1); };
  }

  private async structureChanged(orgId: string): Promise<void> {
    for (const h of this.structureHooks) { try { await h(orgId); } catch { /* the hook logs its own failures */ } }
  }

  /** OrgIntentService registers here (the cascade, docs/company-vision.md §2). */
  onGoalChange(hook: GoalChangeHook): () => void {
    this.goalHooks.push(hook);
    return () => { const i = this.goalHooks.indexOf(hook); if (i >= 0) this.goalHooks.splice(i, 1); };
  }

  private async goalChanged(goal: OrgGoal, before: OrgGoal | null): Promise<void> {
    for (const h of this.goalHooks) { try { await h(goal, before); } catch { /* the hook logs its own failures */ } }
  }

  // ---- humans (phase D) ----

  /** The humans of an org besides the owner. The workspace owner is the CEO
   *  by default whether or not a row exists for them. */
  humans(orgId: string): Promise<OrgHuman[]> {
    return this.db.select().from(orgHumans).where(eq(orgHumans.orgId, orgId));
  }

  /** The role `actor` (an account id) holds here: the owner is CEO unless a
   *  row names them otherwise; others need a row; null = no standing. */
  async humanRole(orgId: string, actor: string): Promise<HumanRole | null> {
    const rows = await this.humans(orgId);
    const own = rows.find((h) => h.memberAccountId === actor);
    if (own) return own.role as HumanRole;
    return actor === currentAccountId() ? 'ceo' : null;
  }

  async setHuman(orgId: string, input: { memberAccountId: string; role: HumanRole; reportsToAgentId?: string | null; title?: string }, actor = 'user'): Promise<OrgHuman> {
    const org = await this.get(orgId);
    if (!HUMAN_ROLES.includes(input.role)) throw new BadRequestException(`role must be one of ${HUMAN_ROLES.join(', ')}`);
    if (!input.memberAccountId) throw new BadRequestException('memberAccountId is required');
    // An employee reports to a live member (the chief by default); other roles report to nobody.
    let reportsTo: string | null = null;
    if (input.role === 'employee') {
      reportsTo = input.reportsToAgentId ?? org.chiefOfStaffAgentId;
      if (!reportsTo) throw new BadRequestException('an employee reports to a member; name reportsToAgentId');
      const manager = await this.member(orgId, reportsTo);
      if (!manager || manager.status === 'terminated') throw new BadRequestException('reportsToAgentId must be an active member of this organization');
    }
    const title = (input.title ?? '').slice(0, 80);
    const existing = (await this.humans(orgId)).find((h) => h.memberAccountId === input.memberAccountId);
    let row: OrgHuman;
    if (existing) {
      await this.db.update(orgHumans).set({ role: input.role, reportsToAgentId: reportsTo, title: title || existing.title }).where(eq(orgHumans.id, existing.id));
      row = { ...existing, role: input.role, reportsToAgentId: reportsTo, title: title || existing.title };
    } else {
      row = { accountId: currentAccountId(), id: newId(), orgId, memberAccountId: input.memberAccountId, role: input.role, reportsToAgentId: reportsTo, title, createdAt: nowIso() };
      await this.db.insert(orgHumans).values(row);
    }
    await this.audit.append(orgId, { actor, action: 'human_set', refType: 'human', refId: input.memberAccountId, payload: { role: input.role, reportsToAgentId: reportsTo, title: title || undefined } });
    // Employees sit on the chart: the units follow (docs/group-chat.md §7).
    if (input.role === 'employee' || existing?.role === 'employee') await this.structureChanged(orgId);
    return row;
  }

  /** The employee row of `memberAccountId`, or null (item 24). */
  async employee(orgId: string, memberAccountId: string): Promise<OrgHuman | null> {
    return (await this.humans(orgId)).find((h) => h.memberAccountId === memberAccountId && h.role === 'employee') ?? null;
  }

  async removeHuman(orgId: string, memberAccountId: string, actor = 'user'): Promise<{ ok: true }> {
    const was = (await this.humans(orgId)).find((h) => h.memberAccountId === memberAccountId);
    await this.db.delete(orgHumans).where(and(eq(orgHumans.orgId, orgId), eq(orgHumans.memberAccountId, memberAccountId)));
    await this.audit.append(orgId, { actor, action: 'human_removed', refType: 'human', refId: memberAccountId });
    if (was?.role === 'employee') await this.structureChanged(orgId);
    return { ok: true };
  }

  // ---- organisations ----

  list(workspaceId?: string): Promise<Organization[]> {
    return workspaceId
      ? this.db.select().from(organizations).where(eq(organizations.workspaceId, workspaceId))
      : this.db.select().from(organizations);
  }

  async get(id: string): Promise<Organization> {
    const row = (await this.db.select().from(organizations).where(eq(organizations.id, id)).limit(1)).at(0);
    if (!row) throw new NotFoundException(`organization ${id}`);
    return row;
  }

  /** The workspace's one live organization (docs/group-chat.md §5: the
   *  workspace is the company; `organizations.workspaceId` is unique among
   *  non-archived rows), or null when organization mode was never enabled. */
  async byWorkspace(workspaceId: string): Promise<Organization | null> {
    const rows = await this.db.select().from(organizations).where(eq(organizations.workspaceId, workspaceId));
    return rows.filter((o) => o.status !== 'archived').sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))[0] ?? null;
  }

  /** Create an org. The chief of staff is either an existing agent or a new
   *  one created from `chief` (name, charter, provider/model); it joins at
   *  depth 1 with `scopes` (default DEFAULT_CHIEF_SCOPES) and its charter
   *  hash is recorded so later drift is visible. */
  async create(input: {
    workspaceId: string; name: string; mission?: string; ceoUserNote?: string;
    chiefOfStaffAgentId?: string;
    chief?: { name: string; charter?: string; packId?: string; provider?: string; model?: string; emoji?: string; role?: string };
    chiefScopes?: string[]; monthlyBudgetUsd?: number; briefHour?: number;
  }): Promise<Organization> {
    const name = (input.name ?? '').trim().slice(0, 80);
    if (!name) throw new BadRequestException('organization name is required');
    let chiefId = input.chiefOfStaffAgentId ?? null;
    if (!chiefId && input.chief) {
      const pack = input.chief.packId ? [...AUTHORED_PACKS, ...PROFESSION_PACKS].find((p) => p.id === input.chief?.packId) : undefined;
      const base = defaultChiefCharter(name, input.mission ?? '');
      const created = await this.agents.create({
        name: input.chief.name, workspaceId: input.workspaceId, charter: input.chief.charter ?? (pack ? `${pack.charter}\n\n${base}` : base),
        provider: input.chief.provider, model: input.chief.model, emoji: input.chief.emoji ?? '🧭', role: input.chief.role ?? 'Chief of staff',
      });
      chiefId = created.id;
    }
    if (!chiefId) throw new BadRequestException('an organization needs a chief of staff: pass chiefOfStaffAgentId or chief');
    const chiefAgent = await this.agents.get(chiefId);
    if (chiefAgent.workspaceId && chiefAgent.workspaceId !== input.workspaceId) throw new BadRequestException(`${chiefAgent.name} belongs to another workspace; agents are not shared across workspaces`);
    const existing = await this.byWorkspace(input.workspaceId);
    if (existing) throw new ConflictException(`workspace already has an organization (${existing.name}); the workspace is the company — change its mode instead`);
    const row: Organization = {
      id: newId(), accountId: currentAccountId(), workspaceId: input.workspaceId, name,
      mission: (input.mission ?? '').slice(0, 4_000), ceoUserNote: (input.ceoUserNote ?? '').slice(0, 4_000),
      chiefOfStaffAgentId: chiefId, status: 'active',
      monthlyBudgetUsd: Math.max(0, input.monthlyBudgetUsd ?? 0),
      maxDepth: MAX_DEPTH_CEILING, maxDirectReports: DEFAULT_MAX_DIRECT_REPORTS,
      briefHour: clampHour(input.briefHour ?? 8), lastBriefAt: null, lastBrief: '',
      auditorAgentId: null, auditCadenceDays: 7, auditUsdCap: 2,
      rules: '', strategyMemo: '', strategyMemoAt: null, values: '', culture: '', tunables: '{}', routing: '{}', frozenClasses: '[]', archivedAt: null, archivedBy: '', archiveState: '{}',
      createdAt: nowIso(),
    };
    await this.db.insert(organizations).values(row);
    await this.audit.append(row.id, { actor: 'user', action: 'org_create', refType: 'org', refId: row.id, payload: { name, chiefOfStaffAgentId: chiefId } });
    await this.addMember(row.id, { agentId: chiefId, title: 'Chief of staff', reportsToAgentId: null, scopes: input.chiefScopes ?? DEFAULT_CHIEF_SCOPES, actor: 'user' });
    if (row.monthlyBudgetUsd > 0) await this.setBudget(row.id, { scope: 'company', refId: row.id, monthlyUsd: row.monthlyBudgetUsd, actor: 'user' });
    // The workspace mirrors its organization: a legacy POST /api/orgs lands
    // the workspace in supervised mode (today's behaviour) unless a mode is set.
    const ws = (await this.db.select().from(workspaces).where(eq(workspaces.id, input.workspaceId)).limit(1)).at(0);
    if (ws) {
      await this.db.update(workspaces).set({ orgMode: ws.orgMode === 'off' ? 'supervised' : ws.orgMode, chiefOfStaffAgentId: chiefId, orgMonthlyUsd: row.monthlyBudgetUsd }).where(eq(workspaces.id, ws.id));
    }
    return row;
  }

  /** Make `agentId` the chief of staff. The new chief and the old one swap
   *  places in the tree (the shape, and so depth and fan-out, is preserved);
   *  an agent that is not yet a member joins under the old chief first. */
  async replaceChief(orgId: string, agentId: string, actor = 'user'): Promise<Organization> {
    const org = await this.get(orgId);
    if (org.chiefOfStaffAgentId === agentId) return org;
    const oldId = org.chiefOfStaffAgentId;
    await this.agents.get(agentId);
    let next = await this.member(orgId, agentId);
    if (next && next.status === 'terminated') throw new BadRequestException('a terminated member cannot become chief of staff');
    if (!next) next = await this.addMember(orgId, { agentId, title: 'Chief of staff', reportsToAgentId: oldId, scopes: DEFAULT_CHIEF_SCOPES, actor });
    const all = await this.members(orgId);
    const old = oldId ? all.find((m) => m.agentId === oldId) : undefined;
    const parentOfNext = next.reportsToAgentId;
    for (const m of all) {
      if (m.agentId === agentId) continue;
      if (m.agentId === oldId) continue;
      if (m.reportsToAgentId === oldId) await this.db.update(orgMembers).set({ reportsToAgentId: agentId }).where(eq(orgMembers.id, m.id));
      else if (m.reportsToAgentId === agentId) await this.db.update(orgMembers).set({ reportsToAgentId: oldId }).where(eq(orgMembers.id, m.id));
    }
    await this.db.update(orgMembers).set({ reportsToAgentId: null, depth: 1, title: 'Chief of staff' }).where(eq(orgMembers.id, next.id));
    if (old) await this.db.update(orgMembers).set({ reportsToAgentId: parentOfNext === oldId ? agentId : parentOfNext, title: old.title === 'Chief of staff' ? '' : old.title }).where(eq(orgMembers.id, old.id));
    await this.db.update(organizations).set({ chiefOfStaffAgentId: agentId }).where(eq(organizations.id, orgId));
    await this.db.update(workspaces).set({ chiefOfStaffAgentId: agentId }).where(eq(workspaces.id, org.workspaceId));
    await this.recomputeDepths(orgId);
    await this.audit.append(orgId, { actor, action: 'chief_replace', refType: 'agent', refId: agentId, payload: { previous: oldId } });
    await this.structureChanged(orgId);
    return this.get(orgId);
  }

  /** Members that count toward the agent cap: everyone not terminated. */
  async liveMemberCount(orgId: string): Promise<number> {
    return (await this.members(orgId)).filter((m) => m.status !== 'terminated').length;
  }

  /** Sum of the agent and project envelopes (the allocations the chief
   *  hands out of the company envelope). */
  async allocatedUsd(orgId: string, except?: { scope: string; refId: string }): Promise<number> {
    return (await this.budgets(orgId))
      .filter((b) => b.scope !== 'company' && !(except && b.scope === except.scope && b.refId === except.refId))
      .reduce((sum, b) => sum + b.monthlyUsd, 0);
  }

  async update(id: string, patch: Partial<Pick<Organization, 'name' | 'mission' | 'ceoUserNote' | 'briefHour' | 'maxDirectReports' | 'monthlyBudgetUsd' | 'auditorAgentId' | 'auditCadenceDays' | 'auditUsdCap'>>, actor = 'user'): Promise<Organization> {
    await this.get(id);
    // The boundary (docs/boundary.md): audit settings are never an agent's; caps only proposed.
    if (patch.auditorAgentId !== undefined || patch.auditCadenceDays !== undefined || patch.auditUsdCap !== undefined) await this.gate(id, { kind: 'audit_settings', summary: 'change the auditor seat, cadence or cap' }, actor);
    if (patch.maxDirectReports !== undefined) await this.gate(id, { kind: 'caps', key: 'maxDirectReports', summary: `fan-out cap → ${patch.maxDirectReports}` }, actor);
    if (patch.monthlyBudgetUsd !== undefined) await this.gate(id, { kind: 'budget', withinEnvelope: false, key: 'company', summary: `company envelope → $${Number(patch.monthlyBudgetUsd).toFixed(2)}` }, actor);
    const set: Record<string, unknown> = {};
    // Assurance (docs/company-vision.md §5.3): the auditor is a member; cadence and cap inside their bounds.
    if (patch.auditorAgentId !== undefined) {
      if (patch.auditorAgentId) {
        const m = await this.member(id, patch.auditorAgentId);
        if (!m || m.status === 'terminated') throw new BadRequestException('the auditor must be a member of this organization');
      }
      set.auditorAgentId = patch.auditorAgentId || null;
    }
    if (patch.auditCadenceDays !== undefined) set.auditCadenceDays = Math.min(90, Math.max(1, Math.floor(patch.auditCadenceDays)));
    if (patch.auditUsdCap !== undefined) set.auditUsdCap = Math.min(50, Math.max(0.1, patch.auditUsdCap));
    if (patch.name !== undefined) { const n = patch.name.trim().slice(0, 80); if (!n) throw new BadRequestException('name cannot be empty'); set.name = n; }
    if (patch.mission !== undefined) set.mission = patch.mission.slice(0, 4_000);
    if (patch.ceoUserNote !== undefined) set.ceoUserNote = patch.ceoUserNote.slice(0, 4_000);
    if (patch.briefHour !== undefined) set.briefHour = clampHour(patch.briefHour);
    if (patch.maxDirectReports !== undefined) set.maxDirectReports = Math.min(DEFAULT_MAX_DIRECT_REPORTS, Math.max(1, Math.floor(patch.maxDirectReports)));
    if (patch.monthlyBudgetUsd !== undefined) {
      set.monthlyBudgetUsd = Math.max(0, patch.monthlyBudgetUsd);
      await this.setBudget(id, { scope: 'company', refId: id, monthlyUsd: Math.max(0, patch.monthlyBudgetUsd), actor });
    }
    if (Object.keys(set).length > 0) {
      await this.db.update(organizations).set(set).where(eq(organizations.id, id));
      await this.audit.append(id, { actor, action: 'org_update', refType: 'org', refId: id, payload: set });
    }
    return this.get(id);
  }

  // ---- the operating profile and the tunables (docs/company-vision.md §1b) ----

  /** Values and culture in the CEO's words; every planning prompt reads them. */
  async setProfile(orgId: string, patch: { values?: string; culture?: string }, actor = 'user'): Promise<Organization> {
    await this.get(orgId);
    const set: Record<string, unknown> = {};
    if (patch.values !== undefined) set.values = patch.values.slice(0, 8_000);
    if (patch.culture !== undefined) set.culture = patch.culture.slice(0, 8_000);
    if (Object.keys(set).length > 0) {
      await this.db.update(organizations).set(set).where(eq(organizations.id, orgId));
      await this.audit.append(orgId, { actor, action: 'profile_set', refType: 'org', refId: orgId, payload: { fields: Object.keys(set), decision: `profile ${Object.keys(set).join(' and ')} revised`, rationale: 'CEO-written operating profile' } });
    }
    return this.get(orgId);
  }

  /** Set one tunable within its bound; refused with the fence otherwise. The
   *  audit row is decision-shaped (what changed, from what, why, who). */
  async setTunable(orgId: string, key: string, value: unknown, opts: { actor?: string; why?: string; decidedBy?: string } = {}): Promise<{ key: string; from: number; to: number }> {
    const org = await this.get(orgId);
    const check = checkTunable(key, value);
    if (!check.ok) throw new BadRequestException(check.reason);
    await this.gate(orgId, { kind: 'tunable', key, summary: `set ${key} → ${check.value}` }, opts.actor ?? 'user');
    const from = tunable(org, key);
    const all = parseTunables(org.tunables);
    all[key] = check.value;
    await this.db.update(organizations).set({ tunables: JSON.stringify(all) }).where(eq(organizations.id, orgId));
    await this.audit.append(orgId, { actor: opts.actor ?? 'user', action: 'tunable_set', refType: 'org', refId: orgId, payload: {
      key, from, to: check.value, bound: { min: TUNABLES[key].min, max: TUNABLES[key].max, default: TUNABLES[key].default },
      decision: `set ${key} ${from} → ${check.value}`, alternatives: `keep ${from}`, rationale: (opts.why ?? '').slice(0, 600), decidedBy: opts.decidedBy ?? opts.actor ?? 'user',
    } });
    return { key, from, to: check.value };
  }

  // ---- capital (docs/company-vision.md §7, item 23): routing and allocations ----

  /** The org's routing map (class → tier, pinned tier models), parsed. */
  async routing(orgId: string): Promise<OrgRouting> { return parseRouting((await this.get(orgId)).routing); }

  /** Merge a routing patch (the CEO through PUT …/routing, the chief through
   *  org_set_routing or an approved `routing` card). Decision-shaped audit row. */
  async setRouting(orgId: string, patch: { classes?: Record<string, unknown>; models?: Record<string, unknown> }, opts: { actor?: string; why?: string; decidedBy?: string } = {}): Promise<OrgRouting> {
    const org = await this.get(orgId);
    await this.gate(orgId, { kind: 'routing', key: Object.keys(patch.classes ?? {}).join(',') || 'models', summary: 'change model routing' }, opts.actor ?? 'user');
    const from = parseRouting(org.routing);
    let next: OrgRouting;
    try { next = mergeRouting(from, patch); } catch (err) { throw new BadRequestException(err instanceof Error ? err.message : String(err)); }
    await this.db.update(organizations).set({ routing: JSON.stringify(next) }).where(eq(organizations.id, orgId));
    const changed = [...Object.keys(patch.classes ?? {}).map((c) => `${c}: ${from.classes[c] ?? 'agent model'} → ${next.classes[c] ?? 'agent model'}`), ...Object.keys(patch.models ?? {}).map((t) => `${t} model: ${from.models[t as ModelTier] ?? 'default'} → ${next.models[t as ModelTier] ?? 'default'}`)];
    await this.audit.append(orgId, { actor: opts.actor ?? 'user', action: 'routing_set', refType: 'org', refId: orgId, payload: {
      from, to: next, decision: `route ${changed.join('; ')}`.slice(0, 600), alternatives: 'keep the current routing', rationale: (opts.why ?? '').slice(0, 600), decidedBy: opts.decidedBy ?? opts.actor ?? 'user',
    } });
    return next;
  }

  allocations(orgId: string): Promise<OrgAllocation[]> { return this.db.select().from(orgAllocations).where(eq(orgAllocations.orgId, orgId)); }

  /** Upsert what an envelope buys: USD per month to an objective with the
   *  rationale (which key results). One row per (org, objective). */
  async setAllocation(orgId: string, input: { goalId: string; monthlyUsd: number; rationale?: string; scope?: string; refId?: string; actor?: string }): Promise<OrgAllocation> {
    const goal = await this.goal(orgId, input.goalId);
    if (goal.kind === 'key_result') throw new BadRequestException('allocations go to objectives (or the vision), not to key results');
    const monthlyUsd = Math.max(0, Number(input.monthlyUsd) || 0);
    const existing = (await this.allocations(orgId)).find((a) => a.goalId === goal.id);
    const rationale = (input.rationale ?? existing?.rationale ?? '').slice(0, 1_000);
    if (existing) {
      await this.db.update(orgAllocations).set({ monthlyUsd, rationale, unitId: goal.unitId, scope: input.scope ?? existing.scope, refId: input.refId ?? existing.refId }).where(eq(orgAllocations.id, existing.id));
    } else {
      await this.db.insert(orgAllocations).values({ id: newId(), accountId: currentAccountId(), orgId, goalId: goal.id, unitId: goal.unitId, scope: input.scope ?? '', refId: input.refId ?? '', monthlyUsd, rationale, createdBy: input.actor ?? 'user', createdAt: nowIso() });
    }
    await this.audit.append(orgId, { actor: input.actor ?? 'user', action: 'allocation_set', refType: 'goal', refId: goal.id, payload: { monthlyUsd, from: existing?.monthlyUsd ?? 0, buys: rationale.slice(0, 300), scope: input.scope ?? existing?.scope ?? '', refId: input.refId ?? existing?.refId ?? '' } });
    return (await this.allocations(orgId)).find((a) => a.goalId === goal.id)!;
  }

  /** The kill switch (§4.6): set only through the API. Runtime stops wakes
   *  and aborts in-flight runs when it sees the status flip. */
  async setStatus(id: string, status: 'active' | 'paused', actor = 'user'): Promise<Organization> {
    await this.get(id);
    await this.gate(id, { kind: 'kill_switch', summary: status === 'paused' ? 'pause the organization' : 'resume the organization' }, actor);
    await this.db.update(organizations).set({ status }).where(eq(organizations.id, id));
    await this.audit.append(id, { actor, action: status === 'paused' ? 'org_pause' : 'org_resume', refType: 'org', refId: id });
    return this.get(id);
  }


  async isActive(id: string): Promise<boolean> {
    const org = (await this.db.select().from(organizations).where(eq(organizations.id, id)).limit(1)).at(0);
    return org?.status === 'active';
  }

  // ---- members ----

  members(orgId: string): Promise<OrgMember[]> {
    return this.db.select().from(orgMembers).where(eq(orgMembers.orgId, orgId));
  }

  async member(orgId: string, agentId: string): Promise<OrgMember | null> {
    return (await this.db.select().from(orgMembers).where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.agentId, agentId))).limit(1)).at(0) ?? null;
  }

  /** Orgs an agent belongs to (active or paused membership). A seat in an
   *  archived company is suspended, not deleted: it is left out here, so
   *  the agent is a plain agent (no org tools, prompts or heartbeat work)
   *  until the company is restored (docs/owners-seat.md "Archive or delete
   *  the company"). */
  async membershipsOf(agentId: string): Promise<OrgMember[]> {
    const rows = await this.db.select({ m: orgMembers, status: organizations.status }).from(orgMembers)
      .leftJoin(organizations, eq(organizations.id, orgMembers.orgId))
      .where(eq(orgMembers.agentId, agentId));
    return rows.filter((r) => r.status !== 'archived').map((r) => r.m);
  }

  async isChief(orgId: string, agentId: string): Promise<boolean> {
    const org = await this.get(orgId);
    return org.chiefOfStaffAgentId === agentId;
  }

  /** Add an existing agent to the org under `reportsToAgentId` (null only
   *  for the chief). Enforces depth, fan-out, uniqueness and no cycles;
   *  records the charter hash; mirrors scopes into org_grants. */
  async addMember(orgId: string, input: { agentId: string; title?: string; reportsToAgentId: string | null; scopes?: string[]; actor?: string; grantedBy?: string }): Promise<OrgMember> {
    const org = await this.get(orgId);
    const agent = await this.agents.get(input.agentId);
    // An organization is its workspace's: only the workspace's own agents sit in it.
    if (agent.workspaceId && agent.workspaceId !== org.workspaceId) throw new BadRequestException(`${agent.name} belongs to another workspace; agents are not shared across workspaces`);
    if (await this.member(orgId, input.agentId)) throw new ConflictException(`${agent.name} is already a member of ${org.name}`);
    let depth = 1;
    if (input.reportsToAgentId) {
      const manager = await this.member(orgId, input.reportsToAgentId);
      if (!manager || manager.status === 'terminated') throw new BadRequestException('reportsToAgentId must be an active member of this organization');
      depth = manager.depth + 1;
      if (depth > Math.min(org.maxDepth, MAX_DEPTH_CEILING)) throw new BadRequestException(`depth limit (${Math.min(org.maxDepth, MAX_DEPTH_CEILING)}) reached under ${manager.title || manager.agentId}`);
      const reports = (await this.members(orgId)).filter((m) => m.reportsToAgentId === input.reportsToAgentId && m.status !== 'terminated');
      if (reports.length >= org.maxDirectReports) throw new BadRequestException(`fan-out limit (${org.maxDirectReports} direct reports) reached`);
    } else if (org.chiefOfStaffAgentId !== input.agentId) {
      throw new BadRequestException('only the chief of staff reports to nobody; name a reportsToAgentId');
    }
    const scopes = parseScopes(input.scopes ?? []);
    const row: OrgMember = {
      id: newId(), accountId: currentAccountId(), orgId, agentId: input.agentId,
      title: (input.title ?? agent.role ?? '').slice(0, 80),
      reportsToAgentId: input.reportsToAgentId, depth, sponsor: 'user', reportsToHumanId: null,
      scopes: JSON.stringify(scopes), status: 'active',
      charterHash: charterHashOf(agent.charter), joinedAt: nowIso(), isHead: 0,
    };
    await this.db.insert(orgMembers).values(row);
    await this.writeGrants(orgId, input.agentId, scopes, input.grantedBy ?? input.actor ?? 'user');
    await this.audit.append(orgId, { actor: input.actor ?? 'user', action: 'member_add', refType: 'agent', refId: input.agentId, payload: { title: row.title, reportsToAgentId: input.reportsToAgentId, depth, scopes, charterHash: row.charterHash } });
    await this.structureChanged(orgId);
    return row;
  }

  async updateMember(orgId: string, agentId: string, patch: { title?: string; reportsToAgentId?: string | null; reportsToHumanId?: string | null }, actor = 'user', boundary: { withinUnit?: boolean } = {}): Promise<OrgMember> {
    const m = await this.member(orgId, agentId);
    if (!m) throw new NotFoundException(`member ${agentId}`);
    await this.gate(orgId, { kind: 'reorg', key: agentId, withinUnit: boundary.withinUnit, summary: 'change a reporting line or title' }, actor);
    const set: Record<string, unknown> = {};
    if (patch.title !== undefined) set.title = patch.title.slice(0, 80);
    // A person as the member's manager for decisions (docs/owners-seat.md §7): one of the org's humans with standing.
    if (patch.reportsToHumanId !== undefined) {
      if (patch.reportsToHumanId === null || patch.reportsToHumanId === '') set.reportsToHumanId = null;
      else {
        const role = await this.humanRole(orgId, patch.reportsToHumanId);
        if (!role || role === 'observer') throw new BadRequestException('reportsToHumanId must be a person of this organization with standing (CEO, board or employee)');
        set.reportsToHumanId = patch.reportsToHumanId;
      }
    }
    if (patch.reportsToAgentId !== undefined) {
      const org = await this.get(orgId);
      if (patch.reportsToAgentId === null) {
        if (org.chiefOfStaffAgentId !== agentId) throw new BadRequestException('only the chief of staff reports to nobody');
        set.reportsToAgentId = null; set.depth = 1;
      } else {
        if (patch.reportsToAgentId === agentId) throw new BadRequestException('a member cannot report to itself');
        const manager = await this.member(orgId, patch.reportsToAgentId);
        if (!manager || manager.status === 'terminated') throw new BadRequestException('new manager must be an active member');
        // no cycles: walk up from the new manager
        const all = await this.members(orgId);
        let cur: OrgMember | undefined = manager;
        while (cur) { if (cur.agentId === agentId) throw new BadRequestException('that reporting line would form a cycle'); cur = all.find((x) => x.agentId === cur!.reportsToAgentId); }
        const depth = manager.depth + 1;
        const subtreeDepth = this.subtreeHeight(all, agentId);
        if (depth + subtreeDepth > Math.min(org.maxDepth, MAX_DEPTH_CEILING)) throw new BadRequestException(`depth limit (${Math.min(org.maxDepth, MAX_DEPTH_CEILING)}) would be exceeded`);
        const reports = all.filter((x) => x.reportsToAgentId === patch.reportsToAgentId && x.status !== 'terminated' && x.agentId !== agentId);
        if (reports.length >= org.maxDirectReports) throw new BadRequestException(`fan-out limit (${org.maxDirectReports}) reached`);
        set.reportsToAgentId = patch.reportsToAgentId; set.depth = depth;
      }
    }
    if (Object.keys(set).length > 0) {
      await this.db.update(orgMembers).set(set).where(eq(orgMembers.id, m.id));
      if (set.depth !== undefined) await this.recomputeDepths(orgId);
      await this.audit.append(orgId, { actor, action: 'member_update', refType: 'agent', refId: agentId, payload: set });
      if (set.reportsToAgentId !== undefined) await this.structureChanged(orgId);
    }
    return (await this.member(orgId, agentId))!;
  }

  /** Height of the subtree below `agentId` (0 = leaf). */
  private subtreeHeight(all: OrgMember[], agentId: string): number {
    const kids = all.filter((m) => m.reportsToAgentId === agentId && m.status !== 'terminated');
    return kids.length === 0 ? 0 : 1 + Math.max(...kids.map((k) => this.subtreeHeight(all, k.agentId)));
  }

  private async recomputeDepths(orgId: string): Promise<void> {
    const all = await this.members(orgId);
    const depthOf = (m: OrgMember, guard = 0): number => {
      if (!m.reportsToAgentId || guard > 10) return 1;
      const p = all.find((x) => x.agentId === m.reportsToAgentId);
      return p ? depthOf(p, guard + 1) + 1 : 1;
    };
    for (const m of all) {
      const d = depthOf(m);
      if (d !== m.depth) await this.db.update(orgMembers).set({ depth: d }).where(eq(orgMembers.id, m.id));
    }
  }

  /** Pause / resume one member. Pausing cascades to the subtree's wakes
   *  (the runtime checks member status before every run). */
  async setMemberStatus(orgId: string, agentId: string, status: 'active' | 'paused', actor = 'user'): Promise<OrgMember> {
    const m = await this.member(orgId, agentId);
    if (!m) throw new NotFoundException(`member ${agentId}`);
    if (m.status === 'terminated') throw new BadRequestException('member is terminated');
    await this.db.update(orgMembers).set({ status }).where(eq(orgMembers.id, m.id));
    await this.audit.append(orgId, { actor, action: status === 'paused' ? 'member_pause' : 'member_resume', refType: 'agent', refId: agentId });
    return (await this.member(orgId, agentId))!;
  }

  /** Terminate: the member's reports move up one level (Paperclip's rule);
   *  the chief cannot be terminated (replace it through update instead). */
  /** Mark a member a function head, or take it back (the `make_head` /
   *  `unmake_head` reorg ops, a hire into a head role). A head staffs its own
   *  unit; the structure hooks re-sync the units so a head leads one. */
  async setHead(orgId: string, agentId: string, on: boolean, actor = 'user'): Promise<OrgMember> {
    const m = await this.member(orgId, agentId);
    if (!m) throw new NotFoundException(`member ${agentId}`);
    const org = await this.get(orgId);
    if (on && org.chiefOfStaffAgentId === agentId) throw new BadRequestException('the chief of staff is not a function head');
    if (on && org.auditorAgentId === agentId) throw new BadRequestException('the auditor is independent: never a function head');
    if ((m.isHead === 1) === on) return m;
    await this.db.update(orgMembers).set({ isHead: on ? 1 : 0 }).where(eq(orgMembers.id, m.id));
    await this.audit.append(orgId, { actor, action: on ? 'member_make_head' : 'member_unmake_head', refType: 'agent', refId: agentId, payload: { title: m.title } });
    await this.structureChanged(orgId);
    return { ...m, isHead: on ? 1 : 0 };
  }

  // ---- project teams (docs/work-tracking.md "Project teams") ----

  /** A project's team rows (every status unless filtered). */
  projectMembers(orgId: string, projectId?: string): Promise<OrgProjectMember[]> {
    return this.db.select().from(orgProjectMembers).where(projectId ? and(eq(orgProjectMembers.orgId, orgId), eq(orgProjectMembers.projectId, projectId)) : eq(orgProjectMembers.orgId, orgId));
  }

  async projectMember(orgId: string, id: string): Promise<OrgProjectMember> {
    const r = (await this.db.select().from(orgProjectMembers).where(and(eq(orgProjectMembers.orgId, orgId), eq(orgProjectMembers.id, id))).limit(1)).at(0);
    if (!r) throw new NotFoundException(`project member ${id}`);
    return r;
  }

  async addProjectMember(orgId: string, input: { projectId: string; agentId?: string | null; humanId?: string | null; role?: string; allocation: number; status: 'active' | 'pending'; approvalId?: string | null; addedBy: string }): Promise<OrgProjectMember> {
    const row: OrgProjectMember = {
      accountId: currentAccountId(), id: newId(), orgId, projectId: input.projectId, agentId: input.agentId ?? null, humanId: input.agentId ? null : input.humanId ?? null,
      role: (input.role ?? '').slice(0, 80), allocation: Math.max(0, Math.min(100, Math.round(input.allocation))), status: input.status, approvalId: input.approvalId ?? null,
      addedBy: input.addedBy.slice(0, 80), joinedAt: nowIso(), leftAt: null,
    };
    await this.db.insert(orgProjectMembers).values(row);
    return row;
  }

  /** The project's channel and standup fields (OrgProjectTeamsService). */
  async updateProjectRitual(orgId: string, projectId: string, patch: Partial<Pick<OrgProject, 'channelId' | 'standupCron' | 'standupNextAt' | 'standupLastAt'>>): Promise<OrgProject> {
    await this.db.update(orgProjects).set(patch).where(and(eq(orgProjects.orgId, orgId), eq(orgProjects.id, projectId)));
    return this.project(orgId, projectId);
  }

  async updateProjectMember(orgId: string, id: string, patch: Partial<Pick<OrgProjectMember, 'role' | 'allocation' | 'status' | 'approvalId' | 'leftAt'>>): Promise<OrgProjectMember> {
    await this.db.update(orgProjectMembers).set(patch).where(and(eq(orgProjectMembers.orgId, orgId), eq(orgProjectMembers.id, id)));
    return this.projectMember(orgId, id);
  }

  async terminateMember(orgId: string, agentId: string, actor = 'user'): Promise<{ ok: true }> {
    const org = await this.get(orgId);
    if (org.chiefOfStaffAgentId === agentId) throw new BadRequestException('the chief of staff cannot be terminated; pause the organization or pick a new chief');
    const m = await this.member(orgId, agentId);
    if (!m) throw new NotFoundException(`member ${agentId}`);
    const all = await this.members(orgId);
    await this.gate(orgId, { kind: 'terminate', key: agentId, withinUnit: !all.some((x) => x.reportsToAgentId === agentId && x.status !== 'terminated'), summary: 'terminate a member' }, actor);
    for (const r of all.filter((x) => x.reportsToAgentId === agentId)) {
      await this.db.update(orgMembers).set({ reportsToAgentId: m.reportsToAgentId }).where(eq(orgMembers.id, r.id));
    }
    await this.db.update(orgMembers).set({ status: 'terminated', scopes: '[]' }).where(eq(orgMembers.id, m.id));
    await this.db.delete(orgGrants).where(and(eq(orgGrants.orgId, orgId), eq(orgGrants.agentId, agentId)));
    await this.recomputeDepths(orgId);
    await this.audit.append(orgId, { actor, action: 'member_terminate', refType: 'agent', refId: agentId, payload: { reportsMovedTo: m.reportsToAgentId } });
    await this.structureChanged(orgId);
    return { ok: true };
  }

  // ---- scopes (the meet rule) ----

  scopesOf(m: OrgMember | null | undefined): string[] {
    if (!m) return [];
    try { return parseScopes(m.scopes); } catch { return []; }
  }

  /** Set a member's scopes. Narrowing (next ⊆ current) applies at once;
   *  widening is refused here — the caller (chief tool) turns it into a
   *  `scope_widen` approval, and the approval path calls `applyScopes`. The
   *  user path may widen directly (`force`). */
  async setScopes(orgId: string, agentId: string, next: string[], opts: { actor: string; force?: boolean; grantedBy?: string }): Promise<{ applied: boolean; widened: string[]; scopes: string[] }> {
    const m = await this.member(orgId, agentId);
    if (!m) throw new NotFoundException(`member ${agentId}`);
    const current = this.scopesOf(m);
    const wanted = parseScopes(next);
    const widened = widenedScopes(current, wanted);
    if (!opts.force && !isNarrowing(current, wanted)) return { applied: false, widened, scopes: current };
    await this.gate(orgId, { kind: widened.length ? 'scope_widen' : 'scope_narrow', key: agentId, summary: widened.length ? `widen +${widened.join(', ')}` : 'narrow scopes' }, opts.actor);
    await this.applyScopes(orgId, agentId, wanted, opts.actor, opts.grantedBy ?? opts.actor);
    return { applied: true, widened, scopes: wanted };
  }

  async applyScopes(orgId: string, agentId: string, scopes: string[], actor: string, grantedBy: string): Promise<void> {
    const m = await this.member(orgId, agentId);
    if (!m) throw new NotFoundException(`member ${agentId}`);
    const before = this.scopesOf(m);
    await this.db.update(orgMembers).set({ scopes: JSON.stringify(scopes) }).where(eq(orgMembers.id, m.id));
    await this.writeGrants(orgId, agentId, scopes, grantedBy);
    await this.audit.append(orgId, { actor, action: isNarrowing(before, scopes) ? 'scope_narrow' : 'scope_widen', refType: 'agent', refId: agentId, payload: { before, after: scopes, grantedBy } });
  }

  private async writeGrants(orgId: string, agentId: string, scopes: string[], grantedBy: string): Promise<void> {
    await this.db.delete(orgGrants).where(and(eq(orgGrants.orgId, orgId), eq(orgGrants.agentId, agentId)));
    if (scopes.length === 0) return;
    await this.db.insert(orgGrants).values(scopes.map((value) => ({
      id: newId(), accountId: currentAccountId(), orgId, agentId, kind: scopeKind(value), value, grantedBy, createdAt: nowIso(),
    })));
  }

  grants(orgId: string) {
    return this.db.select().from(orgGrants).where(eq(orgGrants.orgId, orgId));
  }

  // ---- charter integrity (§4.6) ----

  /** Re-hash every member's live charter against the recorded hash. A
   *  mismatch is drift: the charter changed outside the org path. Returns
   *  the drifted members and audits each once (until re-approved). */
  async checkCharters(orgId: string): Promise<Array<{ agentId: string; name: string; recorded: string; live: string }>> {
    const drifted: Array<{ agentId: string; name: string; recorded: string; live: string }> = [];
    for (const m of (await this.members(orgId)).filter((x) => x.status !== 'terminated')) {
      const agent = await this.agents.get(m.agentId).catch(() => null);
      if (!agent) continue;
      const live = charterHashOf(agent.charter);
      if (live === m.charterHash) continue;
      drifted.push({ agentId: m.agentId, name: agent.name, recorded: m.charterHash, live });
      const recent = await this.audit.list(orgId, { action: 'charter_drift', refId: m.agentId, limit: 1 });
      const already = recent[0] && (JSON.parse(recent[0].payload) as { live?: string }).live === live;
      if (!already) await this.audit.append(orgId, { actor: 'system', action: 'charter_drift', refType: 'agent', refId: m.agentId, payload: { recorded: m.charterHash, live } });
    }
    return drifted;
  }

  /** The user accepts the live charter as the approved one. */
  async acceptCharter(orgId: string, agentId: string, actor = 'user'): Promise<OrgMember> {
    const m = await this.member(orgId, agentId);
    if (!m) throw new NotFoundException(`member ${agentId}`);
    await this.gate(orgId, { kind: 'charter', key: agentId, summary: 'accept a charter' }, actor);
    const agent = await this.agents.get(agentId);
    const hash = charterHashOf(agent.charter);
    await this.db.update(orgMembers).set({ charterHash: hash }).where(eq(orgMembers.id, m.id));
    await this.audit.append(orgId, { actor, action: 'charter_accept', refType: 'agent', refId: agentId, payload: { hash } });
    return (await this.member(orgId, agentId))!;
  }

  // ---- goals and projects ----

  async goals(orgId: string, opts: { unitId?: string | null } = {}): Promise<OrgGoal[]> {
    const rows = await this.db.select().from(orgGoals).where(eq(orgGoals.orgId, orgId));
    return opts.unitId ? rows.filter((g) => g.unitId === opts.unitId) : rows;
  }

  async goal(orgId: string, id: string): Promise<OrgGoal> {
    const g = (await this.db.select().from(orgGoals).where(and(eq(orgGoals.orgId, orgId), eq(orgGoals.id, id))).limit(1)).at(0);
    if (!g) throw new NotFoundException(`goal ${id}`);
    return g;
  }

  /** Add a goal. `unitId`/`parentGoalId` (docs/group-chat.md §7) are stored
   *  as given; OrgUnitsService.addGoal is the path that defaults the unit and
   *  checks the parent is visible from it. */
  async addGoal(orgId: string, input: { title: string; description?: string; ownerAgentId?: string | null; status?: string; unitId?: string | null; parentGoalId?: string | null } & GoalIntentFields, actor = 'user'): Promise<OrgGoal> {
    const org = await this.get(orgId);
    const title = (input.title ?? '').trim().slice(0, 200);
    if (!title) throw new BadRequestException('goal title is required');
    if (input.parentGoalId) await this.goal(orgId, input.parentGoalId);
    const kind = input.kind ?? 'objective';
    if (!GOAL_KINDS.includes(kind)) throw new BadRequestException(`goal kind must be one of ${GOAL_KINDS.join(', ')}`);
    // One active vision per organization (docs/company-vision.md §2): OrgIntentService.setVision revises it in place.
    if (kind === 'vision' && (input.status ?? 'active') === 'active' && (await this.goals(orgId)).some((g) => g.kind === 'vision' && g.status === 'active')) throw new ConflictException('the organization already has an active vision; revise it (PUT …/org/vision) instead of adding a second');
    const row: OrgGoal = {
      id: newId(), accountId: currentAccountId(), orgId, title, description: (input.description ?? '').slice(0, 4_000), status: input.status ?? 'active', ownerAgentId: input.ownerAgentId ?? null, unitId: input.unitId ?? null, parentGoalId: input.parentGoalId ?? null,
      kind, metric: (input.metric ?? '').slice(0, 200), targetValue: input.targetValue ?? null, currentValue: input.currentValue ?? null, startValue: input.startValue ?? null, unitLabel: (input.unitLabel ?? '').slice(0, 40),
      dueAt: input.dueAt ?? null, confidence: clampConfidence(input.confidence), atRisk: 0, atRiskReason: '', lastCheckInAt: input.lastCheckInAt ?? null, checkInCadenceDays: clampCadence(input.checkInCadenceDays ?? tunable(org, 'intent.checkInCadenceDays')),
      metricSourceId: null, lastMeasuredAt: null,
      valuePerUnit: null, valueOnAchieve: null, valueNote: '',
      createdAt: nowIso(),
    };
    await this.db.insert(orgGoals).values(row);
    await this.audit.append(orgId, { actor, action: 'goal_create', refType: 'goal', refId: row.id, payload: { title, kind, unitId: row.unitId, parentGoalId: row.parentGoalId, metric: row.metric || undefined, targetValue: row.targetValue ?? undefined, dueAt: row.dueAt ?? undefined } });
    if (actor === 'user' || actor.startsWith('human:')) this.bus?.emitOrgBoard({ orgId, kind: 'goal', refId: row.id, detail: `new ${kind.replace('_', ' ')} "${title}"` });
    await this.goalChanged(row, null);
    return row;
  }

  async updateGoal(orgId: string, id: string, patch: Partial<Pick<OrgGoal, 'title' | 'description' | 'status' | 'ownerAgentId' | 'unitId' | 'parentGoalId'>> & GoalIntentFields & Partial<Pick<OrgGoal, 'atRisk' | 'atRiskReason'>>, actor = 'user'): Promise<OrgGoal> {
    const before = await this.goal(orgId, id);
    const set: Record<string, unknown> = {};
    if (patch.kind !== undefined) {
      if (!GOAL_KINDS.includes(patch.kind)) throw new BadRequestException(`goal kind must be one of ${GOAL_KINDS.join(', ')}`);
      if (patch.kind === 'vision' && before.kind !== 'vision' && (await this.goals(orgId)).some((g) => g.kind === 'vision' && g.status === 'active' && g.id !== id)) throw new ConflictException('the organization already has an active vision');
      set.kind = patch.kind;
    }
    if (patch.metric !== undefined) set.metric = patch.metric.slice(0, 200);
    if (patch.targetValue !== undefined) set.targetValue = patch.targetValue;
    if (patch.startValue !== undefined) set.startValue = patch.startValue;
    // Sensing (docs/sensing.md §2): a key result bound to a metric source
    // takes its value only from that source's samples (OrgSensingService
    // writes it directly), never from an edit.
    if (patch.currentValue !== undefined && before.metricSourceId && patch.currentValue !== before.currentValue) throw new BadRequestException('this key result is measured by a metric source; its current value comes only from the source\'s samples');
    if (patch.currentValue !== undefined) set.currentValue = patch.currentValue;
    if (patch.unitLabel !== undefined) set.unitLabel = patch.unitLabel.slice(0, 40);
    if (patch.dueAt !== undefined) set.dueAt = patch.dueAt;
    if (patch.confidence !== undefined) set.confidence = clampConfidence(patch.confidence);
    if (patch.checkInCadenceDays !== undefined) set.checkInCadenceDays = clampCadence(patch.checkInCadenceDays);
    if (patch.lastCheckInAt !== undefined) set.lastCheckInAt = patch.lastCheckInAt;
    if (patch.atRisk !== undefined) set.atRisk = patch.atRisk ? 1 : 0;
    if (patch.atRiskReason !== undefined) set.atRiskReason = patch.atRiskReason.slice(0, 600);
    if (patch.unitId !== undefined) set.unitId = patch.unitId;
    if (patch.parentGoalId !== undefined) {
      if (patch.parentGoalId === id) throw new BadRequestException('a goal cannot be its own parent');
      if (patch.parentGoalId) {
        // no cycles: walk up from the proposed parent
        const all = await this.goals(orgId);
        let cur: OrgGoal | undefined = all.find((g) => g.id === patch.parentGoalId);
        if (!cur) throw new NotFoundException(`goal ${patch.parentGoalId}`);
        for (let i = 0; cur && i < 20; i++) { if (cur.id === id) throw new BadRequestException('that parent would form a cycle'); cur = cur.parentGoalId ? all.find((g) => g.id === cur!.parentGoalId) : undefined; }
      }
      set.parentGoalId = patch.parentGoalId;
    }
    if (patch.title !== undefined) set.title = patch.title.trim().slice(0, 200);
    if (patch.description !== undefined) set.description = patch.description.slice(0, 4_000);
    if (patch.status !== undefined) {
      if (!['draft', 'active', 'achieved', 'abandoned'].includes(patch.status)) throw new BadRequestException('goal status must be draft|active|achieved|abandoned');
      set.status = patch.status;
    }
    if (patch.ownerAgentId !== undefined) set.ownerAgentId = patch.ownerAgentId;
    if (Object.keys(set).length > 0) {
      await this.db.update(orgGoals).set(set).where(eq(orgGoals.id, id));
      await this.audit.append(orgId, { actor, action: 'goal_update', refType: 'goal', refId: id, payload: set });
    }
    const after = await this.goal(orgId, id);
    if (Object.keys(set).length > 0) await this.goalChanged(after, before);
    return after;
  }

  projects(orgId: string): Promise<OrgProject[]> { return this.db.select().from(orgProjects).where(eq(orgProjects.orgId, orgId)); }

  async project(orgId: string, id: string): Promise<OrgProject> {
    const p = (await this.db.select().from(orgProjects).where(and(eq(orgProjects.orgId, orgId), eq(orgProjects.id, id))).limit(1)).at(0);
    if (!p) throw new NotFoundException(`project ${id}`);
    return p;
  }

  /** Insert a project row (docs/work-tracking.md). Persistence and field
   *  validation only: OrgProjectsService adds the gating (who may move a
   *  project to Now), the system projects and the health stream. */
  async addProject(orgId: string, input: ProjectCreate, actor = 'user'): Promise<OrgProject> {
    await this.get(orgId);
    const title = (input.title ?? '').trim().slice(0, 200);
    if (!title) throw new BadRequestException('project title is required');
    const goalIds = [...new Set([...(input.goalIds ?? []), ...(input.goalId ? [input.goalId] : [])].map(String).filter(Boolean))].slice(0, 10);
    for (const g of goalIds) await this.goal(orgId, g);
    const fields = projectFields(input);
    const existing = await this.projects(orgId);
    const n = existing.reduce((m, p) => Math.max(m, Number(/^P-(\d+)$/.exec(p.key ?? '')?.[1] ?? 0)), 0);
    const now = nowIso();
    const row: OrgProject = {
      id: newId(), accountId: currentAccountId(), orgId, key: `P-${n + 1}`, goalId: goalIds[0] ?? null, goalIds: JSON.stringify(goalIds), title,
      status: fields.status ?? 'active', ownerAgentId: input.ownerAgentId ?? null, leadHumanId: input.ownerAgentId ? null : input.leadHumanId ?? null,
      unitId: input.unitId ?? null, kind: input.kind ?? 'project', brief: JSON.stringify(parseProjectBrief(input.brief ?? {})),
      startDate: fields.startDate ?? null, targetDate: fields.targetDate ?? null, milestones: JSON.stringify(fields.milestones ?? []),
      appetiteDays: fields.appetiteDays ?? 0, appetiteUsd: fields.appetiteUsd ?? 0, lane: fields.lane ?? (input.status === undefined || input.status === 'active' ? 'now' : 'later'),
      rank: input.rank ?? existing.length, health: '', healthReason: '', healthAsk: '', healthAt: null, hill: null,
      updateCadenceDays: fields.updateCadenceDays ?? null, breakerAt: null, appetiteWarnedAt: null, channelId: null, standupCron: '', standupNextAt: null, standupLastAt: null, createdBy: actor, createdAt: now, updatedAt: now,
    };
    await this.db.insert(orgProjects).values(row);
    await this.audit.append(orgId, { actor, action: 'project_create', refType: 'project', refId: row.id, payload: { key: row.key, title, goalId: row.goalId, goalIds, kind: row.kind, lane: row.lane, status: row.status, ownerAgentId: row.ownerAgentId, leadHumanId: row.leadHumanId, unitId: row.unitId } });
    return row;
  }

  async updateProject(orgId: string, id: string, patch: ProjectPatch, actor = 'user'): Promise<OrgProject> {
    const before = await this.project(orgId, id);
    const set: Record<string, unknown> = {};
    if (patch.title !== undefined) { const t = patch.title.trim().slice(0, 200); if (!t) throw new BadRequestException('title cannot be empty'); set.title = t; }
    const f = projectFields(patch);
    for (const k of ['status', 'lane', 'startDate', 'targetDate', 'appetiteDays', 'appetiteUsd', 'updateCadenceDays'] as const) if (f[k] !== undefined) set[k] = f[k];
    if (f.milestones !== undefined) set.milestones = JSON.stringify(f.milestones);
    if (patch.brief !== undefined) set.brief = JSON.stringify({ ...parseProjectBrief(before.brief), ...Object.fromEntries(Object.entries(parseProjectBrief(patch.brief)).filter(([, v]) => v !== '')) });
    if (patch.goalIds !== undefined || patch.goalId !== undefined) {
      const ids = [...new Set([...(patch.goalIds ?? (patch.goalId === undefined ? parseIdList(before.goalIds) : [])), ...(patch.goalId ? [patch.goalId] : [])].map(String).filter(Boolean))].slice(0, 10);
      for (const g of ids) await this.goal(orgId, g);
      set.goalIds = JSON.stringify(ids); set.goalId = ids[0] ?? null;
    }
    if (patch.ownerAgentId !== undefined) { set.ownerAgentId = patch.ownerAgentId; if (patch.ownerAgentId) set.leadHumanId = null; }
    if (patch.leadHumanId !== undefined) { set.leadHumanId = patch.leadHumanId; if (patch.leadHumanId) set.ownerAgentId = null; }
    if (patch.unitId !== undefined) set.unitId = patch.unitId;
    if (patch.rank !== undefined) set.rank = Math.round(Number(patch.rank) || 0);
    if (patch.health !== undefined) set.health = patch.health;
    if (patch.healthReason !== undefined) set.healthReason = patch.healthReason.slice(0, 600);
    if (patch.healthAsk !== undefined) set.healthAsk = patch.healthAsk.slice(0, 600);
    if (patch.healthAt !== undefined) set.healthAt = patch.healthAt;
    if (patch.hill !== undefined) set.hill = patch.hill === null ? null : Math.min(1, Math.max(0, Number(patch.hill)));
    if (patch.breakerAt !== undefined) set.breakerAt = patch.breakerAt;
    if (patch.appetiteWarnedAt !== undefined) set.appetiteWarnedAt = patch.appetiteWarnedAt;
    if (Object.keys(set).length > 0) {
      set.updatedAt = nowIso();
      await this.db.update(orgProjects).set(set).where(eq(orgProjects.id, id));
      const { updatedAt: _u, ...logged } = set; void _u;
      await this.audit.append(orgId, { actor, action: 'project_update', refType: 'project', refId: id, payload: logged });
    }
    return this.project(orgId, id);
  }

  // ---- budgets (envelopes; reservation/settlement lives in the runtime) ----

  budgets(orgId: string): Promise<OrgBudget[]> { return this.db.select().from(orgBudgets).where(eq(orgBudgets.orgId, orgId)); }

  async budget(orgId: string, scope: string, refId: string): Promise<OrgBudget | null> {
    return (await this.db.select().from(orgBudgets).where(and(eq(orgBudgets.orgId, orgId), eq(orgBudgets.scope, scope), eq(orgBudgets.refId, refId))).limit(1)).at(0) ?? null;
  }

  async setBudget(orgId: string, input: { scope: 'company' | 'agent' | 'project'; refId: string; monthlyUsd: number; actor?: string }): Promise<OrgBudget> {
    if (!['company', 'agent', 'project'].includes(input.scope)) throw new BadRequestException('budget scope must be company|agent|project');
    const monthlyUsd = Math.max(0, Number(input.monthlyUsd) || 0);
    const existing = await this.budget(orgId, input.scope, input.refId);
    // A raise of the company envelope is money beyond the envelope (propose); an allocation inside it is the chief's.
    const raise = !existing || monthlyUsd > existing.monthlyUsd;
    await this.gate(orgId, { kind: 'budget', key: input.scope, withinEnvelope: !(input.scope === 'company' && raise), summary: `${input.scope} envelope → $${monthlyUsd.toFixed(2)}` }, input.actor ?? 'user');
    if (existing) {
      await this.db.update(orgBudgets).set({ monthlyUsd }).where(eq(orgBudgets.id, existing.id));
    } else {
      await this.db.insert(orgBudgets).values({ id: newId(), accountId: currentAccountId(), orgId, scope: input.scope, refId: input.refId, monthlyUsd, reservedUsd: 0, spentUsd: 0, month: nowIso().slice(0, 7), warnedAt: null });
    }
    if (input.scope === 'company') await this.db.update(organizations).set({ monthlyBudgetUsd: monthlyUsd }).where(eq(organizations.id, orgId));
    await this.audit.append(orgId, { actor: input.actor ?? 'user', action: 'budget_set', refType: input.scope, refId: input.refId, payload: { monthlyUsd } });
    return (await this.budget(orgId, input.scope, input.refId))!;
  }
}

function clampHour(h: number): number {
  return Math.min(23, Math.max(0, Math.floor(Number(h) || 0)));
}

/** Confidence is 0–1; null means "never checked in". */
export function clampConfidence(c: number | null | undefined): number | null {
  if (c === null || c === undefined || !Number.isFinite(Number(c))) return null;
  return Math.min(1, Math.max(0, Number(c)));
}

function clampCadence(d: number | undefined): number {
  return Math.min(90, Math.max(1, Math.floor(Number(d) || 7)));
}

/** The chief's charter: the catalog role's (the mandate, the archetype dial,
 *  the authority tiers and the failures it guards against —
 *  docs/chief-of-staff.md), then this company's mission and profile, then
 *  the mechanics of the intent cascade and the board. */
export function defaultChiefCharter(orgName: string, mission: string, profile: { values?: string; culture?: string } = {}): string {
  const role = roleById('chief-of-staff');
  return [
    role ? roleCharter(role, orgName) : `You are the chief of staff of ${orgName}, an organisation of agents run by one human CEO (the user).`,
    mission ? `Mission: ${mission}` : '',
    profile.values ? `What the company values: ${profile.values}` : '',
    profile.culture ? `How the company works (its culture): ${profile.culture}` : '',
    'The company adapts to its operating profile — the CEO\'s values, culture, vision and goals — and you read it before planning, meeting or tuning anything; /org/operating-system.md records what was derived from it. Thresholds and cadences are tunables with bounds (org_tune); the bounds, the caps and the approvals are the safety floor and are not yours to move.',
    'Your job is decomposition and routing, not doing everything yourself: turn goals into projects and well-briefed tasks (outcome, context, constraints, done_when), assign them to the right member or function manager, review results against the done_when rubric, and keep the CEO informed with a short daily brief.',
    'Intent flows down as a cascade: the CEO writes a vision; in a planning session you turn it into objectives, each with two or three measurable key results (metric, target, due date, owner) and first tasks, and hand each objective to a unit whose lead plans its own key results and tasks. Owners check in current value and confidence weekly; a key result that falls behind pace wakes its unit lead, an objective with two at-risk key results wakes you, and you end each planning session with a one-paragraph strategy memo.',
    'Hiring, widening anyone\'s scope, reorganising, raising budgets and external actions follow the company\'s mode and the boundary (approval cards in supervised mode, caps in autonomous mode). Narrowing a scope, pausing a member, assigning and reviewing are yours. Keep the roster small (2–5 specialists) and stop a task rather than loop on it.',
  ].filter(Boolean).join('\n\n');
}
