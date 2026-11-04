/**
 * OrgBlueprintsService — companies as products (docs/company-vision.md §9,
 * docs/blueprints.md, execution-plan item 24).
 *
 * `export(orgId)` renders the live company as a COMPANY.json v1: its roles
 * (title, charter, reporting line, scopes, model tier, envelope), the
 * operating profile, the vision, the tunables the CEO or chief set, the
 * workspace playbooks as SKILL.md text, the budget split, the cadences and
 * routing when later items store them (probed, never assumed). Nothing of the
 * company's *history* travels: no messages, tasks, lessons, files, tokens,
 * connections or grants — the export reads none of those tables.
 *
 * `importPlan` is the dry run: what an import would create, after the strict
 * `validateBlueprint` gate — the chief and its scopes, each hire with its
 * scopes after the meet rule, the budget and allocations within the envelope,
 * the tunables within their bounds, the playbooks, and what is skipped and
 * why. `import` executes exactly that plan: the chief agent, the organization
 * through OrgModeService (supervised | autonomous), the profile, the vision,
 * the tunables, the playbooks as skill drafts, and the staffing — one
 * `blueprint` approval card for the whole plan in supervised mode, direct
 * hires through the same `applyHire` in autonomous mode. Import never runs
 * code, never creates a connection or a grant, never copies memory.
 *
 * A company imported from a registry item is remembered in
 * `org_blueprint_imports`; `sweepOutcomes` records the two measured
 * milestones a blueprint is rated by — the first key result achieved and the
 * first thirty days under the envelope — as anonymous counters on the item,
 * only when the `shareBlueprintOutcomes` setting is on.
 */
import { BadRequestException, ConflictException, Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { orgBlueprintImports, organizations } from '../database/schema';
import { newId, nowIso } from '../common/ids.util';
import { currentAccountId } from '../accounts/account-context';
import { AgentsService } from '../agents/agents.service';
import { SkillsService } from '../skills/skills.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { SettingsService } from '../settings/settings.module';
import { RegistryService, type OutcomeKind } from '../registry/registry.service';
import { renderSkillMd } from '../portability/skill-md';
import { OrgService, DEFAULT_CHIEF_SCOPES, type Organization } from './org.service';
import { OrgModeService } from './org-mode.service';
import { OrgIntentService } from './org-intent.service';
import { OrgApprovalsService, type HirePayload, type OrgApproval } from './org-approvals.service';
import { OrgUnitsService } from './org-units.service';
import { OrgAuditService } from './org-audit.service';
import { checkTunable, parseTunables, TUNABLES } from './org-tunables';
import { meetScopes } from './scopes';
import { ROLES, roleById, roleCharter, tierOfModel } from './roles/catalog';
import { BLUEPRINT_FORMAT, BlueprintError, hireOrder, rootRole, unitNamesOf, unitsOf, validateBlueprint, type Blueprint, type BlueprintProject, type BlueprintRole, type BlueprintUnit } from './blueprints/format';
import { OrgProjectsService } from './org-projects.service';
import { OrgProjectTeamsService } from './org-project-teams.service';
import { OrgProgramService } from './org-program.service';
import { parseProjectBrief } from './work-model';

export type BlueprintImportRow = typeof orgBlueprintImports.$inferSelect;
export type ImportMode = 'supervised' | 'autonomous';

export interface PlannedHire {
  title: string; roleId?: string; reportsTo: string; requestedScopes: string[];
  /** After the meet with the chief's scopes. */
  scopes: string[]; dropped: string[]; modelTier: string; model: string; monthlyUsd: number;
}

export interface ImportPlan {
  ok: boolean;
  name: string;
  mode: ImportMode;
  chief: { title: string; roleId?: string; scopes: string[]; dropped: string[]; modelTier: string; model: string };
  hires: PlannedHire[];
  units: BlueprintUnit[];
  budget: { monthlyUsd: number; allocations: Record<string, number>; allocated: number };
  tunables: Array<{ key: string; value: number; applied: number; note?: string }>;
  profile: { values: boolean; culture: boolean; rules: boolean };
  vision: { title: string; horizonDays: number } | null;
  playbooks: Array<{ name: string }>;
  /** The rituals the blueprint lists, for the chief to set (`list`: unit title or 'root', meeting kind, cron). */
  cadences: { count: number; applied: boolean; note: string; list: NonNullable<Blueprint['cadences']> };
  recommendedCards: string[];
  recommendedConnections: string[];
  /** Roadmap items with their leads and cross-functional teams, created after the staffing (in Next: the CEO bets Now). */
  projects: Array<{ title: string; lead: string; team: Array<{ title: string; role: string; allocation: number }>; cadence: string | null; krs: string[] }>;
  /** The whole staffing plan as one approval card (supervised) or direct hires (autonomous). */
  approval: 'blueprint' | 'none';
  notes: string[];
}

export interface ImportResult {
  orgId: string;
  importId: string;
  mode: ImportMode;
  chiefAgentId: string;
  /** Agents created now (autonomous) — supervised mode creates none until the card is approved. */
  hired: Array<{ agentId: string; title: string }>;
  /** Projects created now (autonomous, or no hires) — supervised mode creates them when the card is approved. */
  projects: Array<{ projectId: string; key: string | null; title: string }>;
  approvalId: string | null;
  playbooks: Array<{ skillId: string; name: string }>;
  notes: string[];
}

/** The `blueprint` approval's payload: the staffing plan, parents first. */
interface BlueprintApprovalPayload {
  importId: string; name: string;
  hires: Array<HirePayload & { reportsToTitle: string }>;
  /** Roadmap items to create once the hires exist (blueprint v1 `projects`). */
  projects?: BlueprintProject[];
  /** Department names by lead title (lower case), applied once the hires exist. */
  unitNames?: Record<string, string>;
}

const OUTCOME_SWEEP_MS = 60 * 60_000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60_000;

@Injectable()
export class OrgBlueprintsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OrgBlueprintsService.name);
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly org: OrgService,
    private readonly mode: OrgModeService,
    private readonly intent: OrgIntentService,
    private readonly approvals: OrgApprovalsService,
    private readonly units: OrgUnitsService,
    private readonly agents: AgentsService,
    private readonly skills: SkillsService,
    private readonly workspaces: WorkspacesService,
    private readonly audit: OrgAuditService,
    @Optional() private readonly settings?: SettingsService,
    @Optional() private readonly registry?: RegistryService,
    @Optional() private readonly projects?: OrgProjectsService,
    @Optional() private readonly teams?: OrgProjectTeamsService,
    @Optional() private readonly program?: OrgProgramService,
  ) {
    this.approvals.onApply('blueprint', (orgId, payload, approval) => this.applyStaffing(orgId, payload as unknown as BlueprintApprovalPayload, approval));
  }

  onModuleInit(): void { this.timer = setInterval(() => { void this.sweepOutcomes(new Date()).catch((err) => this.logger.warn(`outcome sweep failed: ${err instanceof Error ? err.message : err}`)); }, OUTCOME_SWEEP_MS); }
  onModuleDestroy(): void { clearInterval(this.timer); }

  // ---- export ----

  async export(orgId: string): Promise<Blueprint> {
    const org = await this.org.get(orgId);
    const members = (await this.org.members(orgId)).filter((m) => m.status !== 'terminated');
    const agents = new Map((await this.agents.list()).map((a) => [a.id, a]));
    const budgets = await this.org.budgets(orgId);
    // Titles are the blueprint's identifiers: unique, falling back to the agent's name.
    const titles = new Map<string, string>();
    const used = new Set<string>();
    for (const m of members) {
      const base = (m.title || agents.get(m.agentId)?.name || 'Member').trim().slice(0, 70);
      let t = base; for (let n = 2; used.has(t.toLowerCase()); n++) t = `${base} ${n}`;
      used.add(t.toLowerCase()); titles.set(m.agentId, t);
    }
    const roles: BlueprintRole[] = members
      .sort((a, b) => a.depth - b.depth || (a.joinedAt < b.joinedAt ? -1 : 1))
      .map((m) => {
        const a = agents.get(m.agentId);
        // The catalog role a member was hired from: its charter is the role's template filled in, or its title names the role.
        const role = ROLES.find((r) => roleCharter(r, org.name) === (a?.charter ?? '')) ?? roleById(m.title);
        return {
          ...(role ? { roleId: role.id } : {}),
          title: titles.get(m.agentId)!,
          charter: (a?.charter ?? '').slice(0, 20_000),
          reportsTo: m.agentId === org.chiefOfStaffAgentId || !m.reportsToAgentId ? null : titles.get(m.reportsToAgentId) ?? null,
          scopes: this.org.scopesOf(m),
          modelTier: tierOfModel(a?.model),
          monthlyUsd: budgets.find((b) => b.scope === 'agent' && b.refId === m.agentId)?.monthlyUsd ?? 0,
        };
      });
    // Exactly one root: a member whose manager was terminated reports to the chief in the export.
    const chiefTitle = org.chiefOfStaffAgentId ? titles.get(org.chiefOfStaffAgentId) ?? null : null;
    for (const r of roles) if (r.reportsTo === null && r.title !== chiefTitle && chiefTitle) r.reportsTo = chiefTitle;
    const vision = await this.intent.vision(orgId);
    const horizonDays = vision?.dueAt ? Math.max(1, Math.round((Date.parse(vision.dueAt) - Date.parse(vision.createdAt)) / 86_400_000)) : 90;
    const playbooks = (await this.skills.list(org.workspaceId)).filter((s) => !s.agentId && s.draft !== 1 && s.enabled !== 0 && s.workspaceId === org.workspaceId)
      .slice(0, 20).map((s) => ({ name: s.name, skillMd: renderSkillMd({ name: s.name, description: s.description, instructions: s.instructions, createdAt: s.createdAt }) }));
    const allocations: Record<string, number> = {};
    for (const r of roles) if (r.monthlyUsd > 0) allocations[r.title] = r.monthlyUsd;
    const bp: Blueprint = {
      format: BLUEPRINT_FORMAT, name: org.name, description: org.mission,
      profile: { values: org.values, culture: org.culture, rules: org.rules },
      ...(vision ? { vision: { title: vision.title, description: vision.description, horizonDays } } : {}),
      roles, units: await this.exportUnits(orgId, roles, titles),
      tunables: parseTunables(org.tunables), playbooks,
      budget: { monthlyUsd: org.monthlyBudgetUsd, ...(Object.keys(allocations).length ? { allocations } : {}) },
      origin: { exportedFrom: 'yaap', at: nowIso(), sourceOrgId: createHash('sha256').update(orgId).digest('hex').slice(0, 16) },
    };
    const cadences = await this.probeCadences(org, titles);
    if (cadences.length) bp.cadences = cadences;
    const routing = await this.probeRouting(org);
    if (routing) bp.routing = routing;
    const cards = await this.probeCards(org);
    if (cards.length) bp.cards = cards;
    const projects = await this.exportProjects(orgId, titles);
    if (projects.length) bp.projects = projects;
    return validateBlueprint(bp);
  }

  /** The unit tree by lead title, each department with its own name (the root is the company: no name). */
  private async exportUnits(orgId: string, roles: BlueprintRole[], titles: Map<string, string>): Promise<BlueprintUnit[]> {
    const live = (await this.units.units(orgId).catch(() => [])).filter((u) => u.parentUnitId !== null);
    const agentOf = new Map([...titles].map(([agentId, title]) => [title.toLowerCase(), agentId]));
    return unitsOf({ roles } as Blueprint).map((u) => {
      const name = u.parent ? live.find((x) => x.leadAgentId === agentOf.get(u.title.toLowerCase()))?.name : undefined;
      return { ...u, ...(name ? { name: name.slice(0, 60) } : {}) };
    });
  }

  /** Open projects with their lead and team, by role title (blueprint v1 `projects`). */
  private async exportProjects(orgId: string, titles: Map<string, string>): Promise<BlueprintProject[]> {
    const out: BlueprintProject[] = [];
    const load = new Map<string, number>();
    const rows = await this.org.projectMembers(orgId).catch(() => []);
    for (const p of (await this.org.projects(orgId)).filter((x) => x.kind === 'project' && x.status !== 'done' && x.status !== 'cancelled').slice(0, 10)) {
      const lead = p.ownerAgentId ? titles.get(p.ownerAgentId) : undefined;
      if (!lead) continue;
      const team: BlueprintProject['team'] = [];
      for (const r of rows.filter((x) => x.projectId === p.id && x.status === 'active' && x.agentId).slice(0, 8)) {
        const t = titles.get(r.agentId!);
        if (!t || team.some((m) => m.title === t)) continue;
        const used = load.get(t) ?? 0;
        if (used + r.allocation > 100) continue;
        load.set(t, used + r.allocation);
        team.push({ title: t, role: r.role, allocation: Math.max(1, r.allocation) });
      }
      const b = parseProjectBrief(p.brief);
      const review = this.program ? (await this.program.cadenceRows(orgId, 'project', p.id).catch(() => [])).find((c) => c.kind === 'milestone_review' && c.enabled === 1)?.cron : undefined;
      out.push({ title: p.title, brief: { problem: b.problem, hypothesis: b.hypothesis, done_when: b.done_when, mvp: b.mvp }, lead, team, ...(p.standupCron ? { cadence: p.standupCron } : {}), ...(review ? { review } : {}), ...(p.appetiteDays ? { appetiteDays: p.appetiteDays } : {}), ...(p.appetiteUsd ? { appetiteUsd: p.appetiteUsd } : {}) });
    }
    return out;
  }

  /** Rituals (item 19) store cadences in `org_cadences` when merged; read them
   *  defensively — the table, or any column, may not exist here. */
  private async probeCadences(org: Organization, titles: Map<string, string>): Promise<Blueprint['cadences'] & unknown[]> {
    try {
      if (!(await this.tableExists('org_cadences'))) return [];
      const res = await this.db.execute(sql`SELECT * FROM org_cadences WHERE "orgId" = ${org.id}`);
      const rows = ((res as { rows?: unknown[] }).rows ?? (Array.isArray(res) ? res : [])) as Array<Record<string, unknown>>;
      const units = await this.units.units(org.id);
      const out: NonNullable<Blueprint['cadences']> = [];
      for (const r of rows.slice(0, 20)) {
        const kind = typeof r.kind === 'string' ? r.kind : '';
        const cron = typeof r.cron === 'string' ? r.cron : '';
        if (r.enabled === 0 || !/^[a-z_]+$/.test(kind) || cron.trim().split(/\s+/).length !== 5) continue;
        const unit = units.find((u) => u.id === r.unitId);
        out.push({ unitTitle: unit && unit.parentUnitId !== null ? titles.get(unit.leadAgentId) ?? 'root' : 'root', kind, cron });
      }
      // Deterministic: the root's first, then by unit title and kind.
      return out.sort((a, b) => (a.unitTitle === 'root' ? -1 : b.unitTitle === 'root' ? 1 : a.unitTitle.localeCompare(b.unitTitle)) || a.kind.localeCompare(b.kind));
    } catch { return []; }
  }

  /** Routing by task class (item 23) when `organizations.routing` exists. */
  private async probeRouting(org: Organization): Promise<Record<string, string> | null> {
    try {
      const col = await this.db.execute(sql`SELECT 1 FROM information_schema.columns WHERE table_name = 'organizations' AND column_name = 'routing'`);
      if (((col as { rows?: unknown[] }).rows ?? []).length === 0) return null;
      const res = await this.db.execute(sql`SELECT "routing" FROM organizations WHERE "id" = ${org.id}`);
      const raw = (((res as { rows?: unknown[] }).rows ?? [])[0] as { routing?: unknown } | undefined)?.routing;
      const parsed = typeof raw === 'string' ? JSON.parse(raw) as Record<string, unknown> : raw;
      if (!parsed || typeof parsed !== 'object') return null;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) if (typeof v === 'string' && ['cheap', 'standard', 'strong'].includes(v)) out[k] = v;
      return Object.keys(out).length ? out : null;
    } catch { return null; }
  }

  /** Connection cards the company's members hold grants on — recommended, never granted, by an import. */
  private async probeCards(org: Organization): Promise<string[]> {
    try {
      if (!(await this.tableExists('connection_grants'))) return [];
      const members = (await this.org.members(org.id)).filter((m) => m.status !== 'terminated').map((m) => m.agentId);
      if (members.length === 0) return [];
      const res = await this.db.execute(sql`SELECT DISTINCT "service" FROM connection_grants WHERE "agentId" IN (${sql.join(members.map((m) => sql`${m}`), sql`, `)})`);
      const rows = ((res as { rows?: unknown[] }).rows ?? []) as Array<{ service?: unknown }>;
      return rows.map((r) => (typeof r.service === 'string' ? r.service : '')).filter((s) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(s)).sort().slice(0, 40);
    } catch { return []; }
  }

  private async tableExists(name: string): Promise<boolean> {
    const res = await this.db.execute(sql`SELECT 1 FROM information_schema.tables WHERE table_name = ${name}`);
    return (((res as { rows?: unknown[] }).rows ?? (Array.isArray(res) ? res : [])) as unknown[]).length > 0;
  }

  // ---- import: the dry run ----

  /** Parse and validate a blueprint from any source; BadRequest on refusal. */
  parse(raw: unknown): Blueprint {
    try { return validateBlueprint(raw); } catch (err) {
      if (err instanceof BlueprintError) throw new BadRequestException(err.message);
      throw err;
    }
  }

  async importPlan(workspaceId: string, raw: unknown, opts: { mode?: ImportMode; monthlyUsd?: number } = {}): Promise<ImportPlan> {
    const bp = this.parse(raw);
    const ws = await this.workspaces.get(workspaceId);
    const mode: ImportMode = opts.mode ?? 'supervised';
    if (mode !== 'supervised' && mode !== 'autonomous') throw new BadRequestException('mode must be supervised or autonomous');
    const notes: string[] = [];
    const existing = await this.org.byWorkspace(workspaceId);
    if (existing) notes.push(`refused: workspace "${ws.name}" already has an organization (${existing.name}); import into an empty workspace`);
    const root = rootRole(bp);
    // Models (docs/agent-types.md "Which model"): each tier resolves on the
    // agent type the hires will run on (the workspace's default type), never
    // on a vendor name the type may not serve.
    const tierModel = new Map<string, string>();
    for (const tier of new Set([root.modelTier, ...bp.roles.map((r) => r.modelTier)])) {
      tierModel.set(tier, (await this.agents.resolveModelFor({ modelTier: tier })).model);
    }
    // Scopes: connection scopes never import (a connection is a grant the CEO
    // makes); everything else the chief gets as requested, and each report
    // meets the chief's holdings.
    const importable = (scopes: string[]) => scopes.filter((s) => !s.startsWith('connection:'));
    const chiefScopes = importable(root.scopes.length ? root.scopes : DEFAULT_CHIEF_SCOPES);
    const recommendedConnections = [...new Set(bp.roles.flatMap((r) => r.scopes.filter((s) => s.startsWith('connection:')).map((s) => s.split(':')[1])))].sort();
    const monthlyUsd = Math.max(0, opts.monthlyUsd ?? bp.budget.monthlyUsd);
    const allocations: Record<string, number> = {};
    let allocated = 0;
    const hires: PlannedHire[] = hireOrder(bp).map((r) => {
      const requested = importable(r.scopes);
      const scopes = meetScopes(chiefScopes, requested);
      const want = bp.budget.allocations?.[r.title] ?? r.monthlyUsd;
      let usd = Math.max(0, want);
      if (usd > 0 && allocated + usd > monthlyUsd) { notes.push(`allocation for "${r.title}" cut from $${usd.toFixed(2)} to fit the $${monthlyUsd.toFixed(2)} envelope`); usd = Math.max(0, monthlyUsd - allocated); }
      allocated += usd;
      if (usd > 0) allocations[r.title] = usd;
      return { title: r.title, ...(r.roleId ? { roleId: r.roleId } : {}), reportsTo: r.reportsTo!, requestedScopes: r.scopes, scopes, dropped: r.scopes.filter((s) => !scopes.includes(s)), modelTier: r.modelTier, model: tierModel.get(r.modelTier) ?? '', monthlyUsd: usd };
    });
    const cap = ws.orgAgentCap;
    if (bp.roles.length > cap) notes.push(`${bp.roles.length} roles exceed the workspace agent cap of ${cap}; the import raises the cap to ${bp.roles.length}`);
    const tunables = Object.entries(bp.tunables).map(([key, value]) => {
      const def = TUNABLES[key];
      if (!def) return { key, value, applied: value, note: 'skipped: unknown tunable on this server' };
      const check = checkTunable(key, value);
      if (check.ok) return { key, value, applied: check.value };
      const clamped = Math.min(def.max, Math.max(def.min, value));
      return { key, value, applied: clamped, note: `clamped to the bound ${def.min}–${def.max}` };
    });
    const cadencesTable = await this.tableExists('org_cadences').catch(() => false);
    const cadences = { count: bp.cadences?.length ?? 0, applied: false, note: bp.cadences?.length ? (cadencesTable ? 'rituals are installed; cadences are listed for the chief to set (not written by the import)' : 'skipped: rituals (item 19) are not installed on this server') : 'none', list: bp.cadences ?? [] };
    if (bp.playbooks.length) notes.push(`${bp.playbooks.length} playbook(s) install as skill drafts; approve them on the Skills page`);
    if (bp.projects?.length) notes.push(`${bp.projects.length} project(s) are created in Next with their leads and cross-functional teams once the hires exist; moving one to Now is your bet`);
    notes.push('nothing else is created: no connections, grants, memory, lessons, tokens or files');
    return {
      ok: !existing,
      name: bp.name, mode,
      chief: { title: root.title, ...(root.roleId ? { roleId: root.roleId } : {}), scopes: chiefScopes, dropped: root.scopes.filter((s) => !chiefScopes.includes(s)), modelTier: root.modelTier, model: tierModel.get(root.modelTier) ?? '' },
      hires, units: unitsOf(bp),
      budget: { monthlyUsd, allocations, allocated },
      tunables,
      profile: { values: !!bp.profile.values, culture: !!bp.profile.culture, rules: !!bp.profile.rules },
      vision: bp.vision ? { title: bp.vision.title, horizonDays: bp.vision.horizonDays } : null,
      playbooks: bp.playbooks.map((p) => ({ name: p.name })),
      cadences, recommendedCards: bp.cards ?? [], recommendedConnections,
      projects: (bp.projects ?? []).map((p) => ({ title: p.title, lead: p.lead, team: p.team, cadence: p.cadence ?? null, krs: p.krs ?? [] })),
      approval: mode === 'supervised' && hires.length > 0 ? 'blueprint' : 'none',
      notes,
    };
  }

  // ---- import: execute the plan ----

  async import(workspaceId: string, raw: unknown, opts: { mode: ImportMode; monthlyUsd?: number; itemId?: string }, actor = 'user'): Promise<ImportResult> {
    const bp = this.parse(raw);
    const plan = await this.importPlan(workspaceId, bp, opts);
    if (!plan.ok) throw new ConflictException(plan.notes.find((n) => n.startsWith('refused')) ?? 'import refused');
    const ws = await this.workspaces.get(workspaceId);
    const root = rootRole(bp);
    const notes = [...plan.notes];
    // 1. The chief: a fresh agent with the root role's charter — nothing inherited.
    const taken = new Set((await this.agents.list()).map((a) => a.name));
    const uniqueName = (base: string) => { let n = base; for (let i = 2; taken.has(n); i++) n = `${base} ${i}`; taken.add(n); return n; };
    // The chief belongs to the target workspace (item 26); role hires follow through applyHire → org.workspaceId.
    const chief = await this.agents.create({ name: uniqueName(root.title), workspaceId, charter: root.charter || `You are the chief of staff of ${bp.name}.`, role: root.title, model: plan.chief.model || undefined, modelTier: root.modelTier, modelFallback: true, emoji: '🧭', loops: [] });
    // 2. The organization, in the chosen mode (no enrolment of other agents: the org is the blueprint's).
    const org = await this.org.create({ workspaceId, name: bp.name, mission: bp.description, chiefOfStaffAgentId: chief.id, chiefScopes: plan.chief.scopes, monthlyBudgetUsd: plan.budget.monthlyUsd });
    await this.mode.setMode(workspaceId, { mode: opts.mode, chiefOfStaffAgentId: chief.id, monthlyUsd: plan.budget.monthlyUsd, ...(bp.roles.length > ws.orgAgentCap ? { agentCap: bp.roles.length } : {}) }, actor);
    // 3. Profile, rules, vision, tunables.
    if (bp.profile.values || bp.profile.culture) await this.org.setProfile(org.id, { values: bp.profile.values, culture: bp.profile.culture }, actor);
    if (bp.profile.rules) await this.db.update(organizations).set({ rules: bp.profile.rules }).where(eq(organizations.id, org.id));
    if (bp.vision) await this.intent.setVision(org.id, { title: bp.vision.title, description: bp.vision.description, dueAt: new Date(Date.now() + bp.vision.horizonDays * 86_400_000).toISOString(), ...(bp.profile.rules ? { rules: bp.profile.rules } : {}) }, actor);
    for (const t of plan.tunables) {
      if (t.note?.startsWith('skipped')) continue;
      await this.org.setTunable(org.id, t.key, t.applied, { actor, why: `blueprint "${bp.name}"${t.note ? ` (${t.note})` : ''}`, decidedBy: actor }).catch((err: unknown) => notes.push(`tunable ${t.key} not applied: ${err instanceof Error ? err.message : String(err)}`));
    }
    // 4. Playbooks as drafts (the SKILL.md scan runs again on each).
    const playbooks: ImportResult['playbooks'] = [];
    for (const p of bp.playbooks) {
      try {
        const { skill } = await this.skills.importSkillMd({ content: p.skillMd, workspaceId, proposedBy: `blueprint: ${bp.name}` });
        playbooks.push({ skillId: skill.id, name: skill.name });
      } catch (err) { notes.push(`playbook "${p.name}" skipped: ${err instanceof Error ? err.message : String(err)}`); }
    }
    // 5. Staffing: the hire payloads, parents first; one card or direct hires.
    const importId = newId();
    const payloads: BlueprintApprovalPayload['hires'] = plan.hires.map((h) => {
      const r = bp.roles.find((x) => x.title === h.title)!;
      return {
        packId: null, ...(h.roleId ? { roleId: h.roleId } : {}), modelTier: h.modelTier, name: h.title, title: h.title, charter: r.charter || (h.roleId && roleById(h.roleId) ? roleById(h.roleId)!.charter.replaceAll('{company}', bp.name) : `You are the ${h.title} of ${bp.name}.`),
        reportsToAgentId: '', reportsToTitle: h.reportsTo, requestedScopes: h.scopes, scopes: h.scopes, outsideChiefHoldings: h.dropped,
        model: h.model || undefined, monthlyBudgetUsd: h.monthlyUsd || undefined,
      };
    });
    const unitNames = unitNamesOf(bp);
    let approvalId: string | null = null;
    let hired: ImportResult['hired'] = [];
    let projectsMade: ImportResult['projects'] = [];
    if (payloads.length > 0) {
      if (opts.mode === 'supervised') {
        const a = await this.approvals.create(org.id, { kind: 'blueprint', payload: { importId, name: bp.name, hires: payloads, ...(bp.projects?.length ? { projects: bp.projects } : {}), ...(Object.keys(unitNames).length ? { unitNames } : {}) } as unknown as Record<string, unknown>, requestedBy: actor, recommendation: `Staff "${bp.name}" from its blueprint: ${payloads.map((p) => p.title).join(', ')}.` });
        approvalId = a.id;
        notes.push(`${payloads.length} hire(s) wait on one approval card (${a.id.slice(0, 8)}); no agent exists until it is approved`);
      } else {
        const res = await this.applyStaffing(org.id, { importId, name: bp.name, hires: payloads, ...(bp.projects?.length ? { projects: bp.projects } : {}), ...(Object.keys(unitNames).length ? { unitNames } : {}) }, null);
        hired = res.hired as ImportResult['hired'];
        projectsMade = res.projects as ImportResult['projects'];
        for (const f of res.failed as string[]) notes.push(`hire failed: ${f}`);
      }
    } else if (bp.projects?.length) {
      const byTitle = new Map<string, string>([[root.title.toLowerCase(), chief.id]]);
      const made = await this.createProjects(org.id, bp.projects, byTitle);
      projectsMade = made.projects;
      notes.push(...made.notes);
    }
    const row: BlueprintImportRow = {
      accountId: currentAccountId(), id: importId, orgId: org.id, workspaceId, itemId: opts.itemId ?? '', name: bp.name, mode: opts.mode,
      monthlyUsd: plan.budget.monthlyUsd, approvalId, firstKeyResultAt: null, envelopeAt: null, importedAt: nowIso(),
    };
    await this.db.insert(orgBlueprintImports).values(row);
    await this.audit.append(org.id, { actor, action: 'blueprint_import', refType: 'org', refId: org.id, payload: { name: bp.name, mode: opts.mode, roles: bp.roles.length, hires: payloads.length, approvalId, playbooks: playbooks.length, itemId: opts.itemId ?? '', origin: bp.origin.sourceOrgId } });
    return { orgId: org.id, importId, mode: opts.mode, chiefAgentId: chief.id, hired, projects: projectsMade, approvalId, playbooks, notes };
  }

  /** The `blueprint` approval's applier: hires in order through `applyHire`,
   *  resolving each `reportsToTitle` to the agent created before it (the
   *  chief for the root's reports). Re-meets scopes at apply time like any hire. */
  private async applyStaffing(orgId: string, payload: BlueprintApprovalPayload, approval: OrgApproval | null): Promise<Record<string, unknown>> {
    const org = await this.org.get(orgId);
    const rootTitle = org.chiefOfStaffAgentId ? (await this.org.member(orgId, org.chiefOfStaffAgentId))?.title ?? '' : '';
    const byTitle = new Map<string, string>();
    if (org.chiefOfStaffAgentId) byTitle.set(rootTitle.toLowerCase(), org.chiefOfStaffAgentId);
    const hired: Array<{ agentId: string; title: string }> = [];
    const failed: string[] = [];
    const by = approval ? `approval:${approval.id}` : 'user';
    for (const h of Array.isArray(payload.hires) ? payload.hires : []) {
      const reportsTo = byTitle.get(String(h.reportsToTitle ?? '').toLowerCase()) ?? org.chiefOfStaffAgentId;
      if (!reportsTo) { failed.push(`${h.title}: no manager`); continue; }
      try {
        const r = await this.approvals.applyHire(orgId, { ...h, reportsToAgentId: reportsTo }, 'user', by);
        byTitle.set(String(h.title).toLowerCase(), r.agentId);
        hired.push({ agentId: r.agentId, title: String(h.title) });
      } catch (err) { failed.push(`${h.title}: ${err instanceof Error ? err.message : String(err)}`); }
    }
    const made = Array.isArray(payload.projects) && payload.projects.length ? await this.createProjects(orgId, payload.projects, byTitle) : { projects: [], notes: [] };
    // Department names (docs/group-chat.md §7): the units exist once their heads are hired.
    for (const [title, name] of Object.entries(payload.unitNames && typeof payload.unitNames === 'object' ? payload.unitNames : {})) {
      const agentId = byTitle.get(title.toLowerCase());
      const unit = agentId ? await this.units.ledBy(orgId, agentId).catch(() => null) : null;
      if (!unit || unit.parentUnitId === null) { made.notes.push(`department "${String(name)}" not named: ${agentId ? 'its head leads no unit yet' : 'its head was not hired'}`); continue; }
      await this.units.rename(orgId, unit.id, String(name), 'blueprint').catch((err: unknown) => made.notes.push(`department "${String(name)}" not named: ${err instanceof Error ? err.message : String(err)}`));
    }
    return { hired, failed: [...failed, ...made.notes], projects: made.projects };
  }

  /**
   * The blueprint's roadmap items, once their people exist: each project in
   * Next (shaped when its brief and appetite are filled — the CEO bets Now)
   * with its lead, its cross-functional team at their allocations (the
   * import is the CEO's act, so allocations apply without cards), its
   * channel and its standup. Key results are listed in the brief for the
   * chief to set.
   */
  private async createProjects(orgId: string, list: BlueprintProject[], byTitle: Map<string, string>): Promise<{ projects: ImportResult['projects']; notes: string[] }> {
    const projects: ImportResult['projects'] = [];
    const notes: string[] = [];
    if (!this.projects) return { projects, notes: list.length ? ['projects skipped: work tracking is not available on this server'] : [] };
    for (const p of list) {
      const lead = byTitle.get(p.lead.toLowerCase()) ?? null;
      try {
        const brief = { ...p.brief, hypothesis: [p.brief.hypothesis, p.krs?.length ? `Key results to set: ${p.krs.join('; ')}.` : ''].filter(Boolean).join(' ') };
        const shaped = Boolean(brief.problem && brief.done_when && ((p.appetiteDays ?? 0) > 0 || (p.appetiteUsd ?? 0) > 0));
        const r = await this.projects.create(orgId, { title: p.title, goalIds: [], ownerAgentId: lead, brief, appetiteDays: p.appetiteDays ?? 0, appetiteUsd: p.appetiteUsd ?? 0, lane: 'next', status: shaped ? 'shaped' : 'proposed' }, 'user');
        projects.push({ projectId: r.project.id, key: r.project.key, title: r.project.title });
        for (const m of p.team) {
          const agentId = byTitle.get(m.title.toLowerCase());
          if (!agentId || !this.teams) { notes.push(`${r.project.key}: ${m.title} not added (${agentId ? 'project teams are not available' : 'the role was not hired'})`); continue; }
          await this.teams.propose(orgId, r.project.id, { agentId, role: m.role, allocation: m.allocation, why: 'blueprint' }, 'user').catch((err: unknown) => notes.push(`${r.project.key}: ${m.title} not added: ${err instanceof Error ? err.message : String(err)}`));
        }
        if (p.cadence && this.teams) await this.teams.setStandup(orgId, r.project.id, p.cadence, 'user').catch((err: unknown) => notes.push(`${r.project.key}: standup not set: ${err instanceof Error ? err.message : String(err)}`));
        if (p.review && this.program) await this.program.setCadence(orgId, r.project.id, 'milestone_review', p.review, 'user').catch((err: unknown) => notes.push(`${r.project.key}: milestone review not set: ${err instanceof Error ? err.message : String(err)}`));
      } catch (err) { notes.push(`project "${p.title}" skipped: ${err instanceof Error ? err.message : String(err)}`); }
    }
    return { projects, notes };
  }

  // ---- outcomes (docs/blueprints.md §4) ----

  imports(orgId: string): Promise<BlueprintImportRow[]> {
    return this.db.select().from(orgBlueprintImports).where(eq(orgBlueprintImports.orgId, orgId));
  }

  async sharingOutcomes(): Promise<boolean> {
    return ((await this.settings?.all())?.shareBlueprintOutcomes ?? 'off') === 'on';
  }

  /** Record the measured milestones of imported companies: the first key
   *  result achieved, and thirty days after import with company spend under
   *  the envelope. Each lands once per import; the registry hears of it only
   *  when sharing is on (the row's timestamp is set either way, so turning
   *  sharing on later never back-reports). */
  async sweepOutcomes(now: Date = new Date()): Promise<Array<{ importId: string; kind: OutcomeKind; shared: boolean }>> {
    const rows = await this.db.select().from(orgBlueprintImports);
    const share = await this.sharingOutcomes();
    const out: Array<{ importId: string; kind: OutcomeKind; shared: boolean }> = [];
    for (const r of rows) {
      const record = async (kind: OutcomeKind, col: 'firstKeyResultAt' | 'envelopeAt') => {
        await this.db.update(orgBlueprintImports).set({ [col]: now.toISOString() }).where(eq(orgBlueprintImports.id, r.id));
        let shared = false;
        if (share && r.itemId && this.registry) { await this.registry.recordOutcome(r.itemId, kind).then(() => { shared = true; }).catch(() => undefined); }
        await this.audit.append(r.orgId, { actor: 'system', action: 'blueprint_outcome', refType: 'org', refId: r.orgId, payload: { kind, itemId: r.itemId || undefined, shared } }).catch(() => undefined);
        out.push({ importId: r.id, kind, shared });
      };
      if (!r.firstKeyResultAt) {
        const goals = await this.org.goals(r.orgId).catch(() => []);
        if (goals.some((g) => g.kind === 'key_result' && g.status === 'achieved')) await record('first_key_result', 'firstKeyResultAt');
      }
      if (!r.envelopeAt && now.getTime() - Date.parse(r.importedAt) >= THIRTY_DAYS_MS) {
        const budget = await this.org.budget(r.orgId, 'company', r.orgId).catch(() => null);
        const under = !budget || budget.monthlyUsd <= 0 || budget.spentUsd <= budget.monthlyUsd;
        if (under) await record('thirty_days_in_envelope', 'envelopeAt');
        else await this.db.update(orgBlueprintImports).set({ envelopeAt: `missed:${now.toISOString()}` }).where(eq(orgBlueprintImports.id, r.id));
      }
    }
    return out;
  }
}
