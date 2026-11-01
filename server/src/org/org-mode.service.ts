/**
 * OrgModeService — the workspace is the company (docs/group-chat.md §5,
 * execution plan item 16).
 *
 * `workspaces.orgMode` ∈ off | supervised | autonomous. Enabling creates the
 * workspace's one `organizations` row (1:1), seats every agent of the
 * workspace as a member — the chief at the root, the others reporting to it
 * (overflow beyond the fan-out cap goes one level down, never past depth 3)
 * — announces `#company`, and writes audit. `off` pauses the runtime (the
 * kill switch) and hides the panes but keeps every row. Switching between
 * supervised and autonomous changes only how the chief's structural tools
 * behave (OrgRuntimeService): approvals, or immediate execution within caps.
 */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AgentsService } from '../agents/agents.service';
import { WorkspacesService, ORG_MODES, type OrgMode } from '../workspaces/workspaces.service';
import { OrgService, type Organization, MAX_DEPTH_CEILING } from './org.service';
import { OrgRuntimeService } from './org-runtime.service';
import { OrgAuditService } from './org-audit.service';
import { OrgApprovalsService } from './org-approvals.service';
import { OrgAnnouncer } from './org-announcer';

export const MAX_ORG_AGENT_CAP = 50;

export interface OrgModeInput {
  mode: OrgMode;
  chiefOfStaffAgentId?: string;
  monthlyUsd?: number;
  agentCap?: number;
}

export interface OrgModeStatus {
  workspaceId: string;
  mode: OrgMode;
  chiefOfStaffAgentId: string | null;
  orgMonthlyUsd: number;
  orgAgentCap: number;
  orgId: string | null;
  orgStatus: string | null;
  pendingApprovals: number;
}

/** What autonomous mode may do on its own, in one place so the UI, the
 *  tool descriptions and the docs quote the same numbers. */
export const AUTONOMY_CAPS = {
  maxDepth: MAX_DEPTH_CEILING,
  maxDirectReports: 5,
  defaultAgentCap: 12,
  rules: [
    'reporting depth ≤ 3 (you → chief → lead → specialist)',
    'at most 5 direct reports per member',
    'members ≤ the agent cap',
    'allocated agent and project envelopes sum to at most the company envelope',
    'a report\'s scopes never exceed the chief\'s own holdings (the meet rule)',
    'no connection, memory or lesson inheritance by a hired agent',
  ],
} as const;

@Injectable()
export class OrgModeService {
  constructor(
    private readonly org: OrgService,
    private readonly workspaces: WorkspacesService,
    private readonly agents: AgentsService,
    private readonly runtime: OrgRuntimeService,
    private readonly approvals: OrgApprovalsService,
    private readonly audit: OrgAuditService,
    private readonly announcer: OrgAnnouncer,
  ) {}

  async status(workspaceId: string): Promise<OrgModeStatus> {
    const ws = await this.workspaces.get(workspaceId);
    const org = await this.org.byWorkspace(workspaceId);
    const pending = org ? (await this.approvals.pending(org.id)).length : 0;
    return {
      workspaceId, mode: ws.orgMode as OrgMode, chiefOfStaffAgentId: ws.chiefOfStaffAgentId, orgMonthlyUsd: ws.orgMonthlyUsd, orgAgentCap: ws.orgAgentCap,
      orgId: org?.id ?? null, orgStatus: org?.status ?? null, pendingApprovals: pending,
    };
  }

  /** The workspace's org id or 404 — the resolver behind every
   *  `/api/workspaces/:id/org/...` alias. */
  async orgIdOf(workspaceId: string): Promise<string> {
    const org = await this.org.byWorkspace(workspaceId);
    if (!org) throw new NotFoundException('this workspace has no organization yet — enable organization mode first');
    return org.id;
  }

  async setMode(workspaceId: string, input: OrgModeInput, actor = 'user'): Promise<OrgModeStatus & { enrolled?: string[]; notEnrolled?: Array<{ agentId: string; reason: string }> }> {
    const ws = await this.workspaces.get(workspaceId);
    if (!ORG_MODES.includes(input.mode)) throw new BadRequestException(`mode must be one of ${ORG_MODES.join(', ')}`);
    if (input.agentCap !== undefined && (!Number.isInteger(input.agentCap) || input.agentCap < 1 || input.agentCap > MAX_ORG_AGENT_CAP)) throw new BadRequestException(`agentCap must be an integer between 1 and ${MAX_ORG_AGENT_CAP}`);
    if (input.monthlyUsd !== undefined && (!Number.isFinite(input.monthlyUsd) || input.monthlyUsd < 0)) throw new BadRequestException('monthlyUsd must be a non-negative number');
    const previous = ws.orgMode as OrgMode;
    let org = await this.org.byWorkspace(workspaceId);
    let enrolled: string[] | undefined;
    let notEnrolled: Array<{ agentId: string; reason: string }> | undefined;

    if (input.mode === 'off') {
      if (org && org.status === 'active') await this.runtime.pause(org.id, actor);
      await this.workspaces.setOrgFields(workspaceId, { orgMode: 'off', ...(input.agentCap !== undefined ? { orgAgentCap: input.agentCap } : {}), ...(input.monthlyUsd !== undefined ? { orgMonthlyUsd: input.monthlyUsd } : {}) });
      if (org) {
        await this.audit.append(org.id, { actor, action: 'org_mode', refType: 'org', refId: org.id, payload: { mode: 'off', previous } });
        if (previous !== 'off') await this.announcer.announce(workspaceId, `Organization mode is off: the company is paused and its panes are hidden. Nothing was deleted.`);
      }
      return this.status(workspaceId);
    }

    // Enabling or changing a live mode. Only this workspace's agents are
    // candidates: agents belong to one workspace (execution-plan item 26).
    const agents = await this.agents.list({ workspaceId });
    let chiefId = input.chiefOfStaffAgentId ?? org?.chiefOfStaffAgentId ?? ws.chiefOfStaffAgentId ?? null;
    if (chiefId && !agents.some((a) => a.id === chiefId)) throw new BadRequestException(`chiefOfStaffAgentId ${chiefId} is not an agent of this workspace`);
    if (!org) {
      if (!chiefId) chiefId = agents[0]?.id ?? null;
      org = await this.org.create({
        workspaceId, name: ws.name, chiefOfStaffAgentId: chiefId ?? undefined,
        chief: chiefId ? undefined : { name: 'Chief of staff' },
        monthlyBudgetUsd: input.monthlyUsd ?? ws.orgMonthlyUsd,
      });
      chiefId = org.chiefOfStaffAgentId;
      const seated = await this.enrol(org, agents.map((a) => a.id));
      enrolled = seated.enrolled; notEnrolled = seated.notEnrolled;
    } else {
      if (chiefId && chiefId !== org.chiefOfStaffAgentId) org = await this.org.replaceChief(org.id, chiefId, actor);
      if (input.monthlyUsd !== undefined && input.monthlyUsd !== org.monthlyBudgetUsd) org = await this.org.update(org.id, { monthlyBudgetUsd: input.monthlyUsd });
      if (org.status !== 'active') org = await this.runtime.resume(org.id, actor);
    }
    await this.workspaces.setOrgFields(workspaceId, {
      orgMode: input.mode, chiefOfStaffAgentId: org.chiefOfStaffAgentId,
      orgMonthlyUsd: org.monthlyBudgetUsd,
      ...(input.agentCap !== undefined ? { orgAgentCap: input.agentCap } : {}),
    });
    await this.audit.append(org.id, { actor, action: 'org_mode', refType: 'org', refId: org.id, payload: { mode: input.mode, previous, chiefOfStaffAgentId: org.chiefOfStaffAgentId, monthlyUsd: org.monthlyBudgetUsd, agentCap: input.agentCap ?? ws.orgAgentCap, enrolled: enrolled?.length } });
    if (previous !== input.mode || enrolled) {
      const chiefName = agents.find((a) => a.id === org!.chiefOfStaffAgentId)?.name ?? 'the chief of staff';
      const line = enrolled
        ? `Organization mode is on (${input.mode}). ${chiefName} is chief of staff; ${enrolled?.length ?? 0} agent(s) joined the company.${input.mode === 'autonomous' ? ' The chief hires, reorganizes and allocates within caps on its own; every action is audited here.' : ' Structural changes need your approval.'}`
        : `Organization mode changed: ${previous} → ${input.mode}.${input.mode === 'autonomous' ? ' The chief now acts within caps without approvals.' : ' Structural changes need approval again.'}`;
      await this.announcer.announce(workspaceId, line);
    }
    return { ...(await this.status(workspaceId)), enrolled, notEnrolled };
  }

  /** Seat every workspace agent that is not yet a member: under the chief
   *  while fan-out allows, then under the first seated reports (depth 3 at
   *  most). Anything that still does not fit is reported, not forced. */
  private async enrol(org: Organization, agentIds: string[]): Promise<{ enrolled: string[]; notEnrolled: Array<{ agentId: string; reason: string }> }> {
    const enrolled: string[] = [];
    const notEnrolled: Array<{ agentId: string; reason: string }> = [];
    for (const agentId of agentIds) {
      if (agentId === org.chiefOfStaffAgentId) continue;
      if (await this.org.member(org.id, agentId)) continue;
      const members = (await this.org.members(org.id)).filter((m) => m.status !== 'terminated');
      // candidates: managers with headroom, shallowest first, chief first
      const hosts = members
        .filter((m) => m.depth < MAX_DEPTH_CEILING && members.filter((r) => r.reportsToAgentId === m.agentId).length < org.maxDirectReports)
        .sort((a, b) => a.depth - b.depth || (a.joinedAt < b.joinedAt ? -1 : 1));
      const host = hosts[0];
      if (!host) { notEnrolled.push({ agentId, reason: `no seat left within depth ${MAX_DEPTH_CEILING} and ${org.maxDirectReports} direct reports` }); continue; }
      try {
        await this.org.addMember(org.id, { agentId, reportsToAgentId: host.agentId, scopes: [], actor: 'user' });
        enrolled.push(agentId);
      } catch (err) {
        notEnrolled.push({ agentId, reason: err instanceof Error ? err.message : String(err) });
      }
    }
    return { enrolled, notEnrolled };
  }

  /** The kill switch, workspace-scoped: `POST /api/workspaces/:id/org/pause`. */
  async pause(workspaceId: string, actor = 'user'): Promise<OrgModeStatus> {
    const orgId = await this.orgIdOf(workspaceId);
    await this.runtime.pause(orgId, actor);
    await this.announcer.announce(workspaceId, 'The company is paused (kill switch): queued wakes dropped, in-flight runs aborted.');
    return this.status(workspaceId);
  }

  async resume(workspaceId: string, actor = 'user'): Promise<OrgModeStatus> {
    const ws = await this.workspaces.get(workspaceId);
    if (ws.orgMode === 'off') throw new BadRequestException('organization mode is off — set it to supervised or autonomous first');
    const orgId = await this.orgIdOf(workspaceId);
    await this.runtime.resume(orgId, actor);
    await this.announcer.announce(workspaceId, 'The company resumed.');
    return this.status(workspaceId);
  }
}
