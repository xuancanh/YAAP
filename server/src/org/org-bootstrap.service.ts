/**
 * OrgBootstrapService — company onboarding in one call (execution plan item
 * 25; docs/group-chat.md §5 "Onboarding", docs/company-vision.md §1b).
 *
 * `POST /api/workspaces/:id/org/bootstrap` runs the whole setup of a company
 * for a workspace that has none yet, in order: the chief of staff (an
 * existing agent of the account, or a new template agent whose charter is
 * `defaultChiefCharter` with the mission and the operating profile baked
 * in), `OrgModeService.setMode` (the 1:1 organization, enrolment, `#company`),
 * the vision (`OrgIntentService.setVision`: title, paragraph, horizon,
 * standing rules), the operating profile (`OrgService.setProfile`: values
 * and culture), each tunable within its bound (`OrgService.setTunable`, the
 * fence enforced — and checked *before* anything is created, so a bad value
 * refuses the whole call instead of leaving half a company), the ritual
 * cadences ('default' leaves the item 19 defaults, 'light' disables the
 * standup and the retro on the root unit, 'none' disables every cadence),
 * the first hires (item 24's role catalog — `role:<id>`, a bare role id or
 * title — through the existing hire path, with market packs by id or name as
 * the fallback: approval cards in supervised mode, seated at once within caps
 * in autonomous mode, scopes met with the chief's holdings either way; an
 * unknown role is a note, never a failure) and, when
 * asked, the first planning session of the root unit (fire and forget:
 * `planning: 'queued'`).
 *
 * Nothing here is a hidden default: every value the chief will read comes
 * from the body, and what the body leaves out stays at the documented
 * tunable defaults the Settings card shows. Every step writes its own audit
 * row through the service it calls; the call ends with one `org_bootstrap`
 * row that lists what was done. A workspace that already has an
 * organization is refused with 400 and a clear message — change its mode
 * in Settings instead.
 */
import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { AgentsService } from '../agents/agents.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { OrgService, defaultChiefCharter } from './org.service';
import { OrgModeService, MAX_ORG_AGENT_CAP } from './org-mode.service';
import { OrgIntentService } from './org-intent.service';
import { OrgUnitsService } from './org-units.service';
import { OrgMeetingsService } from './org-meetings.service';
import { OrgApprovalsService } from './org-approvals.service';
import { OrgRuntimeService } from './org-runtime.service';
import { OrgAuditService } from './org-audit.service';
import { checkTunable } from './org-tunables';
import { OrgRolesService } from './org-roles.service';
import { roleById, roleRef, ROLE_PREFIX } from './roles/catalog';

export const CADENCE_MODES = ['default', 'light', 'none'] as const;
export type CadenceMode = (typeof CADENCE_MODES)[number];
/** 'light' keeps the weekly review and the board; these two go quiet. */
export const LIGHT_DISABLED_KINDS = ['standup', 'retro'];
export const MAX_FIRST_HIRES = 5;

export interface BootstrapInput {
  mode: 'supervised' | 'autonomous';
  chief: { agentId: string } | { create: { name: string; provider?: string; model?: string } };
  monthlyUsd: number;
  agentCap?: number;
  vision?: { title: string; description?: string; horizonDays?: number; dueAt?: string | null; rules?: string };
  profile?: { values?: string; culture?: string };
  tunables?: Record<string, number>;
  cadences?: CadenceMode;
  roles?: string[];
  planNow?: boolean;
}

export interface BootstrapHire { role: string; status: 'proposed' | 'hired' | 'skipped'; note: string; approvalId?: string; agentId?: string }

export interface BootstrapSummary {
  workspaceId: string;
  orgId: string;
  mode: 'supervised' | 'autonomous';
  chief: { agentId: string; name: string; created: boolean };
  enrolled: number;
  vision: { goalId: string; title: string; dueAt: string | null } | null;
  profile: { values: boolean; culture: boolean };
  tunables: Array<{ key: string; from: number; to: number }>;
  cadences: { mode: CadenceMode; disabled: number; total: number };
  hires: BootstrapHire[];
  planning: 'queued' | 'not_requested' | 'unavailable';
  notes: string[];
}

@Injectable()
export class OrgBootstrapService {
  constructor(
    private readonly org: OrgService,
    private readonly workspaces: WorkspacesService,
    private readonly agents: AgentsService,
    private readonly mode: OrgModeService,
    private readonly approvals: OrgApprovalsService,
    private readonly runtime: OrgRuntimeService,
    private readonly audit: OrgAuditService,
    @Optional() private readonly intent?: OrgIntentService,
    @Optional() private readonly units?: OrgUnitsService,
    @Optional() private readonly meetings?: OrgMeetingsService,
    @Optional() private readonly roles?: OrgRolesService,
  ) {}

  /** `role:<id>`, a bare role id or a role title → the catalog hire
   *  (`templateOrPack: 'role:<id>'`); else a market pack by id or name. */
  resolveRole(role: string): { templateOrPack: string; title?: string; label: string; kind: 'role' | 'pack' } | null {
    const catalog = roleRef(role) ?? (this.roles ? (() => { try { return this.roles!.get(role); } catch { return undefined; } })() : roleById(role));
    if (catalog && catalog.id !== 'chief-of-staff') return { templateOrPack: `${ROLE_PREFIX}${catalog.id}`, title: catalog.title, label: catalog.title, kind: 'role' };
    const pack = OrgApprovalsService.catalogItem(role);
    if (pack) return { templateOrPack: pack.id, title: pack.role || undefined, label: pack.name, kind: 'pack' };
    return null;
  }

  async bootstrap(workspaceId: string, input: BootstrapInput, actor = 'user'): Promise<BootstrapSummary> {
    const ws = await this.workspaces.get(workspaceId);
    if (await this.org.byWorkspace(workspaceId)) throw new BadRequestException(`workspace "${ws.name}" already has a company — change its mode, chief or caps in Settings → Workspace → Organization instead of onboarding again`);
    if (ws.orgMode !== 'off') throw new BadRequestException(`workspace "${ws.name}" is already in ${ws.orgMode} mode`);
    if (input.mode !== 'supervised' && input.mode !== 'autonomous') throw new BadRequestException('mode must be supervised or autonomous');
    if (!Number.isFinite(input.monthlyUsd) || input.monthlyUsd < 0) throw new BadRequestException('monthlyUsd must be a non-negative number');
    if (input.agentCap !== undefined && (!Number.isInteger(input.agentCap) || input.agentCap < 1 || input.agentCap > MAX_ORG_AGENT_CAP)) throw new BadRequestException(`agentCap must be an integer between 1 and ${MAX_ORG_AGENT_CAP}`);
    const cadenceMode: CadenceMode = input.cadences ?? 'default';
    if (!CADENCE_MODES.includes(cadenceMode)) throw new BadRequestException(`cadences must be one of ${CADENCE_MODES.join(', ')}`);
    if (input.vision && !(input.vision.title ?? '').trim()) throw new BadRequestException('the vision needs a title (one line)');
    if (input.vision?.horizonDays !== undefined && (!Number.isFinite(input.vision.horizonDays) || input.vision.horizonDays < 1 || input.vision.horizonDays > 3_650)) throw new BadRequestException('horizonDays must be between 1 and 3650');
    if (input.vision?.dueAt && !Number.isFinite(Date.parse(input.vision.dueAt))) throw new BadRequestException('vision.dueAt must be an ISO date');
    // The fence first: a tunable outside its bound refuses the call before anything exists.
    const tunables = Object.entries(input.tunables ?? {});
    for (const [key, value] of tunables) {
      const check = checkTunable(key, value);
      if (!check.ok) throw new BadRequestException(check.reason);
    }
    const roles = (input.roles ?? []).map((r) => String(r).trim()).filter(Boolean).slice(0, MAX_FIRST_HIRES);
    const notes: string[] = [];

    // 1. The chief of staff: one of this workspace's own agents, or a new one
    // created in it (agents are never shared across workspaces, item 26).
    const existing = await this.agents.list({ workspaceId });
    let chiefId: string;
    let created = false;
    if ('agentId' in input.chief && input.chief.agentId) {
      const wanted = input.chief.agentId;
      if (!existing.some((a) => a.id === wanted)) throw new BadRequestException(`chief.agentId ${wanted} is not an agent of this workspace`);
      chiefId = wanted;
    } else if ('create' in input.chief && input.chief.create) {
      const name = (input.chief.create.name ?? '').trim().slice(0, 60) || 'Chief of staff';
      const mission = (input.vision?.description ?? input.vision?.title ?? '').trim();
      const agent = await this.agents.create({
        name, role: 'Chief of staff', emoji: '🧭',
        charter: defaultChiefCharter(ws.name, mission, { values: input.profile?.values, culture: input.profile?.culture }),
        provider: input.chief.create.provider || undefined, model: input.chief.create.model || undefined,
        workspaceId,
      });
      chiefId = agent.id;
      created = true;
    } else {
      throw new BadRequestException('chief must be { agentId } or { create: { name } }');
    }

    // 2. The organization, the enrolment, #company.
    const st = await this.mode.setMode(workspaceId, { mode: input.mode, chiefOfStaffAgentId: chiefId, monthlyUsd: input.monthlyUsd, agentCap: input.agentCap }, actor);
    const orgId = st.orgId!;
    const chiefName = (await this.agents.list()).find((a) => a.id === chiefId)?.name ?? 'Chief of staff';

    // 3. The vision and the standing rules.
    let vision: BootstrapSummary['vision'] = null;
    if (input.vision) {
      if (!this.intent) notes.push('intent service unavailable: the vision was not written');
      else {
        const dueAt = input.vision.dueAt ?? (input.vision.horizonDays ? new Date(Date.now() + input.vision.horizonDays * 86_400_000).toISOString() : null);
        const r = await this.intent.setVision(orgId, { title: input.vision.title.trim(), description: input.vision.description ?? '', dueAt, rules: input.vision.rules }, actor);
        vision = { goalId: r.vision.id, title: r.vision.title, dueAt: r.vision.dueAt };
      }
    }

    // 4. The operating profile.
    const profile = { values: Boolean(input.profile?.values?.trim()), culture: Boolean(input.profile?.culture?.trim()) };
    if (profile.values || profile.culture) await this.org.setProfile(orgId, { values: input.profile?.values, culture: input.profile?.culture }, actor);
    // The organization row also carries the mission, which the catalog and the prompts read.
    if (input.vision?.description?.trim()) await this.org.update(orgId, { mission: input.vision.description.trim() }).catch(() => undefined);

    // 5. Tunables, within the fence.
    const tuned: BootstrapSummary['tunables'] = [];
    for (const [key, value] of tunables) tuned.push(await this.org.setTunable(orgId, key, value, { actor, why: 'chosen during company onboarding', decidedBy: actor }));

    // 6. Rituals.
    const cadences: BootstrapSummary['cadences'] = { mode: cadenceMode, disabled: 0, total: 0 };
    if (this.meetings) {
      await this.meetings.ensureCadenceDefaults(orgId);
      const rows = await this.meetings.cadences(orgId);
      cadences.total = rows.length;
      const root = this.units ? await this.units.rootUnit(orgId).catch(() => null) : null;
      const quiet = cadenceMode === 'none' ? rows : cadenceMode === 'light' ? rows.filter((c) => LIGHT_DISABLED_KINDS.includes(c.kind) && (!root || c.unitId === root.id)) : [];
      for (const c of quiet) { await this.meetings.updateCadence(orgId, c.id, { enabled: false }, actor); cadences.disabled++; }
    } else if (cadenceMode !== 'default') notes.push('meetings unavailable: cadences were left as they are');

    // 7. The first hires, through the one hire path.
    const hires: BootstrapHire[] = [];
    const agentCap = input.agentCap ?? ws.orgAgentCap ?? 12;
    for (const role of roles) {
      const resolved = this.resolveRole(role);
      if (!resolved) { hires.push({ role, status: 'skipped', note: 'not in the role catalog on this server (GET …/org/roles lists it)' }); continue; }
      const hire = { templateOrPack: resolved.templateOrPack, title: resolved.title, reportsToAgentId: chiefId, recommendation: 'first hire chosen during company onboarding', requestedBy: actor };
      try {
        if (input.mode === 'supervised') {
          const a = await this.approvals.proposeHire(orgId, hire);
          hires.push({ role, status: 'proposed', note: `approval card for ${resolved.label}`, approvalId: a.id });
        } else {
          const count = await this.org.liveMemberCount(orgId);
          if (count >= agentCap) { hires.push({ role, status: 'skipped', note: `the agent cap (${agentCap}) is reached` }); continue; }
          const payload = await this.approvals.prepareHire(orgId, hire);
          const r = await this.approvals.applyHire(orgId, payload, actor, actor);
          hires.push({ role, status: 'hired', note: `${r.name} seated under ${chiefName} with ${r.scopes.length} scope(s)${payload.outsideChiefHoldings.length ? `; dropped (outside the chief's holdings): ${payload.outsideChiefHoldings.join(', ')}` : ''}`, agentId: r.agentId });
        }
      } catch (err) {
        hires.push({ role, status: 'skipped', note: err instanceof Error ? err.message : String(err) });
      }
    }

    // 8. The first planning session, fire and forget.
    let planning: BootstrapSummary['planning'] = 'not_requested';
    if (input.planNow) {
      const root = this.units ? await this.units.rootUnit(orgId).catch(() => null) : null;
      if (root && vision) {
        planning = 'queued';
        void this.runtime.runPlanning(orgId, { unitId: root.id, trigger: 'manual', reasons: ['first planning session after company onboarding'] }).catch(() => undefined);
      } else {
        planning = 'unavailable';
        notes.push(vision ? 'units unavailable: planning was not queued' : 'no vision was written, so there is nothing to plan yet');
      }
    }

    const summary: BootstrapSummary = {
      workspaceId, orgId, mode: input.mode, chief: { agentId: chiefId, name: chiefName, created }, enrolled: st.enrolled?.length ?? 0,
      vision, profile, tunables: tuned, cadences, hires, planning, notes,
    };
    await this.audit.append(orgId, { actor, action: 'org_bootstrap', refType: 'org', refId: orgId, payload: {
      mode: input.mode, chief: summary.chief, vision: vision?.goalId ?? null, profile, tunables: tuned.map((t) => t.key), cadences, hires: hires.map((h) => ({ role: h.role, status: h.status })), planning, notes,
    } });
    return summary;
  }
}
