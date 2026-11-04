/**
 * OrgLifecycleService — archive, restore and permanently delete a company
 * (docs/owners-seat.md "Archive or delete the company").
 *
 * **Archive** (reversible, the default): the owner stops the company the
 * way the kill switch does — queued wakes, reviews, planning passes and
 * re-wakes dropped, in-flight runs aborted — and marks the organization
 * `archived` with when and who. An archived org is invisible to every
 * surface that resolves "the workspace's company" (`OrgService.byWorkspace`
 * skips it), so Company, Inbox and Home fall back to the non-company views;
 * every tick skips it (no rituals, meetings, briefs, sweeps, approval
 * expiry); its members' seats are suspended (`OrgService.membershipsOf`
 * leaves archived orgs out), so the agents stay in the workspace as plain
 * agents; its unit channels are archived (read-only). Nothing is deleted:
 * the rows stay readable through `archivedDetail` and `/api/orgs/:id`.
 * `archiveState` remembers what restore puts back — the org's status
 * (a paused company comes back paused), the workspace's mode, chief and
 * envelope, and the channels the archive closed.
 *
 * **Delete permanently**: only from the archived state, with the company's
 * name typed back. Side effects first, each idempotent (channels archived,
 * kept or deleted; `/org/` files moved under `/archive/org-<slug>-<day>/` or
 * deleted — never when the workspace has a new live company, whose files
 * they now are; member agents kept as plain agents or deleted), then one
 * transaction that removes every org-scoped row (ORG_TABLE_PLAN, children
 * first, plus a sweep of any other table with an `orgId` column), detaches
 * the few shared rows that only point at the org, and drops the
 * organization row last. The org's own audit chain goes with it; the
 * workspace's audit chain (`plugin_audit`) gets the final `org_deleted`
 * entry. A retry after an interruption finds the org still archived and
 * redoes only what is left; a retry after success answers `alreadyDeleted`.
 */
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { organizations, orgDecisions, orgUnits, workspaces } from '../database/schema';
import { currentViewer } from '../accounts/account-context';
import { nowIso } from '../common/ids.util';
import { AgentsService } from '../agents/agents.service';
import { WorkspacesService, type OrgMode } from '../workspaces/workspaces.service';
import { WorkspaceFs, type FsActor } from '../files/workspace-fs.service';
import { PluginAuditService } from '../plugins/plugin-audit';
import { OrgService, type Organization } from './org.service';
import { OrgRuntimeService } from './org-runtime.service';
import { OrgAuditService } from './org-audit.service';
import { OrgAnnouncer } from './org-announcer';

/** Every table with an `orgId` column, in delete order (children first; no
 *  foreign keys are declared, the order keeps a half-run delete readable).
 *  `detach` rows are shared records that only point at the org (a registry
 *  install, an action-log entry): their `orgId` is cleared, the row stays.
 *  The coverage test fails when a table with an `orgId` column is missing
 *  here — add new org tables to this list. */
export const ORG_TABLE_PLAN: ReadonlyArray<{ table: string; mode: 'delete' | 'detach' }> = [
  { table: 'task_transitions', mode: 'delete' },
  { table: 'org_task_checks', mode: 'delete' },
  { table: 'org_runs', mode: 'delete' },
  { table: 'org_messages', mode: 'delete' },
  { table: 'org_resource_requests', mode: 'delete' },
  { table: 'org_program_cadences', mode: 'delete' },
  { table: 'org_project_members', mode: 'delete' },
  { table: 'org_project_updates', mode: 'delete' },
  { table: 'org_checkins', mode: 'delete' },
  { table: 'org_value_events', mode: 'delete' },
  { table: 'org_predictions', mode: 'delete' },
  { table: 'org_eval_runs', mode: 'delete' },
  { table: 'org_eval_cases', mode: 'delete' },
  { table: 'org_experiments', mode: 'delete' },
  { table: 'org_delegations', mode: 'delete' },
  { table: 'org_signals', mode: 'delete' },
  { table: 'org_slo_samples', mode: 'delete' },
  { table: 'org_audits', mode: 'delete' },
  { table: 'org_incidents', mode: 'delete' },
  { table: 'org_decisions', mode: 'delete' },
  { table: 'org_meetings', mode: 'delete' },
  { table: 'org_cadences', mode: 'delete' },
  { table: 'org_playbooks', mode: 'delete' },
  { table: 'org_tasks', mode: 'delete' },
  { table: 'org_projects', mode: 'delete' },
  { table: 'org_allocations', mode: 'delete' },
  { table: 'org_plans', mode: 'delete' },
  { table: 'org_budgets', mode: 'delete' },
  { table: 'org_grants', mode: 'delete' },
  { table: 'org_approvals', mode: 'delete' },
  { table: 'org_metric_sources', mode: 'delete' },
  { table: 'org_blueprint_imports', mode: 'delete' },
  { table: 'org_humans', mode: 'delete' },
  { table: 'org_goals', mode: 'delete' },
  { table: 'org_members', mode: 'delete' },
  { table: 'org_units', mode: 'delete' },
  { table: 'org_audit', mode: 'delete' },
  { table: 'registry_installs', mode: 'detach' },
  { table: 'action_log', mode: 'detach' },
];

/** Rows that belong to the org without an `orgId` column, removed (or
 *  unlinked) before the org tables they hang off. Each statement is plain
 *  SQL over `$org` (the org id); the tables they read exist on every
 *  migrated database. */
const INDIRECT: ReadonlyArray<{ key: string; sql: (orgId: string) => ReturnType<typeof sql> }> = [
  // Metric readings hang off the org's metric sources (their sealed secrets go with the sources).
  { key: 'org_metric_samples', sql: (o) => sql`DELETE FROM org_metric_samples WHERE "sourceId" IN (SELECT "id" FROM org_metric_sources WHERE "orgId" = ${o}) RETURNING 1` },
  // Follows of org tasks (docs/follows.md).
  { key: 'follows', sql: (o) => sql`DELETE FROM follows WHERE "targetKind" = 'org_task' AND "targetId" IN (SELECT "id" FROM org_tasks WHERE "orgId" = ${o}) RETURNING 1` },
  // Task key counters of the org's boards (units, or the org before it had units).
  { key: 'task_key_counters', sql: (o) => sql`DELETE FROM task_key_counters WHERE ("ownerKind" = 'org' AND "ownerId" = ${o}) OR ("ownerKind" = 'unit' AND "ownerId" IN (SELECT "id" FROM org_units WHERE "orgId" = ${o})) RETURNING 1` },
  // Plugin bindings scoped to one of the org's units or projects (docs/plugins.md §4.2).
  { key: 'interface_bindings', sql: (o) => sql`DELETE FROM interface_bindings WHERE ("scopeKind" = 'unit' AND "scopeRef" IN (SELECT "id" FROM org_units WHERE "orgId" = ${o})) OR ("scopeKind" = 'project' AND "scopeRef" IN (SELECT "id" FROM org_projects WHERE "orgId" = ${o})) RETURNING 1` },
  // Chats and channel messages linked to an org task keep their content, lose the link.
  { key: 'chat_sessions (unlinked)', sql: (o) => sql`UPDATE chat_sessions SET "taskKind" = NULL, "taskId" = NULL WHERE "taskKind" = 'org' AND "taskId" IN (SELECT "id" FROM org_tasks WHERE "orgId" = ${o}) RETURNING 1` },
  { key: 'channel_messages (unlinked)', sql: (o) => sql`UPDATE channel_messages SET "taskId" = NULL WHERE "taskId" IN (SELECT "id" FROM org_tasks WHERE "orgId" = ${o}) RETURNING 1` },
];

export type AgentsChoice = 'keep' | 'delete';
export type FilesChoice = 'keep' | 'delete';
export type ChannelsChoice = 'archive' | 'keep' | 'delete';

export interface DeleteOptions {
  orgId?: string;
  confirmName: string;
  agents?: AgentsChoice;
  files?: FilesChoice;
  channels?: ChannelsChoice;
}

interface ArchiveState {
  status?: 'active' | 'paused';
  mode?: OrgMode;
  chiefOfStaffAgentId?: string | null;
  monthlyUsd?: number;
  /** Unit channels the archive closed (restore reopens exactly these). */
  channels?: string[];
  deleting?: { startedAt: string; by: string; agents: AgentsChoice; files: FilesChoice; channels: ChannelsChoice };
}

export interface ArchivedOrgSummary {
  id: string; name: string; mission: string; archivedAt: string | null; archivedBy: string;
  /** The status restore puts back. */
  restoreStatus: 'active' | 'paused'; restoreMode: OrgMode;
  members: number; deleting: boolean;
}

export interface DeleteReport {
  ok: true;
  orgId: string;
  name: string;
  alreadyDeleted?: boolean;
  /** Rows removed (or unlinked) per table. */
  rows: Record<string, number>;
  agents: { choice: AgentsChoice; deleted: string[]; kept: string[] };
  files: { choice: FilesChoice; moved?: number; to?: string; deleted?: number; skipped?: string };
  channels: { choice: ChannelsChoice; archived: number; reopened: number; deleted: number };
}

const SYSTEM_FS: FsActor = { kind: 'system', id: 'system', name: 'system' };

function parseState(raw: string | null | undefined): ArchiveState {
  try { const v = JSON.parse(raw || '{}') as unknown; return v && typeof v === 'object' ? v as ArchiveState : {}; } catch { return {}; }
}

/** `acme-corp` from "Acme Corp" — for the archive folder name. */
export function orgSlug(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'company';
}

@Injectable()
export class OrgLifecycleService {
  private readonly logger = new Logger(OrgLifecycleService.name);

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly org: OrgService,
    private readonly workspaces: WorkspacesService,
    private readonly agents: AgentsService,
    private readonly runtime: OrgRuntimeService,
    private readonly audit: OrgAuditService,
    private readonly announcer: OrgAnnouncer,
    @Optional() private readonly fs?: WorkspaceFs,
    /** The workspace's audit chain: the final `org_deleted` entry outlives the org's own chain. */
    @Optional() private readonly workspaceAudit?: PluginAuditService,
  ) {}

  /** Archive, restore and delete are the owner's: a shared workspace's
   *  members and viewers cannot (the route table refuses them too). */
  private assertOwner(): void {
    const v = currentViewer();
    if (v && v.role !== 'owner') throw new ForbiddenException('only the workspace owner can archive, restore or delete the company');
  }

  private async archivedOrgs(workspaceId: string): Promise<Organization[]> {
    return (await this.db.select().from(organizations).where(and(eq(organizations.workspaceId, workspaceId), eq(organizations.status, 'archived'))).orderBy(desc(organizations.archivedAt)));
  }

  private async archivedOrg(workspaceId: string, orgId?: string): Promise<Organization> {
    const all = await this.archivedOrgs(workspaceId);
    const org = orgId ? all.find((o) => o.id === orgId) : all[0];
    if (!org) {
      if (orgId) {
        const live = (await this.db.select().from(organizations).where(and(eq(organizations.id, orgId), eq(organizations.workspaceId, workspaceId))).limit(1)).at(0);
        if (live) throw new BadRequestException(`"${live.name}" is not archived — archive it first`);
      }
      throw new NotFoundException('this workspace has no archived company');
    }
    return org;
  }

  /** The archived companies of a workspace, newest first. */
  async listArchived(workspaceId: string): Promise<ArchivedOrgSummary[]> {
    const out: ArchivedOrgSummary[] = [];
    for (const o of await this.archivedOrgs(workspaceId)) {
      const st = parseState(o.archiveState);
      const members = (await this.org.members(o.id)).filter((m) => m.status !== 'terminated').length;
      out.push({
        id: o.id, name: o.name, mission: o.mission, archivedAt: o.archivedAt, archivedBy: o.archivedBy,
        restoreStatus: st.status === 'paused' ? 'paused' : 'active', restoreMode: st.mode ?? 'supervised',
        members, deleting: Boolean(st.deleting),
      });
    }
    return out;
  }

  /** Row counts of every org table for one org (the delete dialog's "what is removed"). */
  async counts(orgId: string): Promise<Record<string, number>> {
    const present = new Set(await this.orgIdTables());
    const out: Record<string, number> = {};
    for (const { table, mode } of ORG_TABLE_PLAN) {
      if (mode !== 'delete' || !present.has(table)) continue;
      const r = await this.db.execute(sql`SELECT COUNT(*)::int AS n FROM ${sql.identifier(table)} WHERE "orgId" = ${orgId}`);
      const n = Number((r.rows[0] as { n?: number } | undefined)?.n ?? 0);
      if (n > 0) out[table] = n;
    }
    return out;
  }

  /** The read-only "Archived company" view: who was in it, what it was
   *  working on, what it decided, and how much there is. */
  async archivedDetail(workspaceId: string, orgId: string) {
    const o = await this.archivedOrg(workspaceId, orgId);
    const st = parseState(o.archiveState);
    const agentRows = new Map((await this.agents.list({ workspaceId })).map((a) => [a.id, a]));
    const members = (await this.org.members(o.id)).map((m) => ({
      agentId: m.agentId, title: m.title, status: m.status, reportsToAgentId: m.reportsToAgentId, depth: m.depth,
      name: agentRows.get(m.agentId)?.name ?? null, emoji: agentRows.get(m.agentId)?.emoji ?? null, exists: agentRows.has(m.agentId),
    }));
    const goals = (await this.org.goals(o.id)).map((g) => ({ id: g.id, title: g.title, kind: g.kind, status: g.status }));
    const projects = (await this.org.projects(o.id)).map((p) => ({ id: p.id, title: p.title, status: p.status }));
    const units = (await this.db.select().from(orgUnits).where(eq(orgUnits.orgId, o.id))).map((u) => ({ id: u.id, name: u.name, slug: u.slug, leadAgentId: u.leadAgentId, parentUnitId: u.parentUnitId, channelId: u.channelId }));
    const decisions = (await this.db.select().from(orgDecisions).where(eq(orgDecisions.orgId, o.id)).orderBy(desc(orgDecisions.createdAt)).limit(20))
      .map((d) => ({ id: d.id, title: d.title, decision: d.decision, decidedBy: d.decidedBy, createdAt: d.createdAt }));
    const audit = (await this.audit.list(o.id, { limit: 20 })).map((r) => ({ seq: r.seq, actor: r.actor, action: r.action, createdAt: r.createdAt }));
    const files = this.fs ? (await this.fs.list(workspaceId, 'org').catch(() => [])).length : 0;
    const live = await this.org.byWorkspace(workspaceId);
    return {
      org: {
        id: o.id, name: o.name, mission: o.mission, values: o.values, culture: o.culture, rules: o.rules,
        chiefOfStaffAgentId: o.chiefOfStaffAgentId, monthlyBudgetUsd: o.monthlyBudgetUsd, createdAt: o.createdAt,
        archivedAt: o.archivedAt, archivedBy: o.archivedBy,
        restoreStatus: st.status === 'paused' ? 'paused' : 'active', restoreMode: st.mode ?? 'supervised',
        deleting: Boolean(st.deleting),
      },
      members, goals, projects, units, decisions, audit,
      counts: await this.counts(o.id),
      /** Files under /org/ (they are the live company's when one exists). */
      orgFiles: files,
      liveCompany: live ? { id: live.id, name: live.name } : null,
      /** Restore needs the workspace without a live company. */
      canRestore: !live,
    };
  }

  // ---- archive ----

  async archive(workspaceId: string, actor = 'user'): Promise<ArchivedOrgSummary> {
    this.assertOwner();
    const ws = await this.workspaces.get(workspaceId);
    const org = await this.org.byWorkspace(workspaceId);
    if (!org) throw new NotFoundException('this workspace has no company to archive');
    // Stop everything first, as the kill switch does (no status change yet: one write below).
    await this.runtime.stopAll(org.id);
    // Unit channels go read-only (not #company: the workspace keeps it for a next company).
    const closed: string[] = [];
    const ch = this.announcer.channels;
    if (ch) {
      for (const u of await this.db.select().from(orgUnits).where(eq(orgUnits.orgId, org.id))) {
        if (!u.channelId || u.parentUnitId === null || u.archivedAt) continue;
        try { await ch.updateChannel(u.channelId, { archived: true }); closed.push(u.channelId); } catch { /* a missing channel stays missing */ }
      }
    }
    await this.announcer.announce(workspaceId, `The company "${org.name}" is archived: its board, rituals, meetings and wakes are stopped and its panes are hidden. Nothing was deleted — the owner can restore it from Settings → Workspace → Organization.`);
    const state: ArchiveState = {
      status: org.status === 'paused' ? 'paused' : 'active', mode: ws.orgMode as OrgMode,
      chiefOfStaffAgentId: ws.chiefOfStaffAgentId ?? org.chiefOfStaffAgentId, monthlyUsd: ws.orgMonthlyUsd, channels: closed,
    };
    const at = nowIso();
    await this.db.update(organizations).set({ status: 'archived', archivedAt: at, archivedBy: actor, archiveState: JSON.stringify(state) }).where(eq(organizations.id, org.id));
    await this.workspaces.setOrgFields(workspaceId, { orgMode: 'off', chiefOfStaffAgentId: null });
    await this.audit.append(org.id, { actor, action: 'org_archive', refType: 'org', refId: org.id, payload: { previousStatus: state.status, previousMode: state.mode, channelsArchived: closed.length } });
    return (await this.listArchived(workspaceId)).find((o) => o.id === org.id)!;
  }

  // ---- restore ----

  async restore(workspaceId: string, orgId?: string, actor = 'user'): Promise<{ orgId: string; status: 'active' | 'paused'; mode: OrgMode }> {
    this.assertOwner();
    await this.workspaces.get(workspaceId);
    const org = await this.archivedOrg(workspaceId, orgId);
    const st = parseState(org.archiveState);
    if (st.deleting) throw new ConflictException(`"${org.name}" is being deleted — finish the delete instead`);
    const live = await this.org.byWorkspace(workspaceId);
    if (live) throw new ConflictException(`this workspace already has a company ("${live.name}") — archive it before restoring "${org.name}"`);
    const status: 'active' | 'paused' = st.status === 'paused' ? 'paused' : 'active';
    const mode: OrgMode = st.mode ?? 'supervised';
    await this.db.update(organizations).set({ status, archivedAt: null, archivedBy: '', archiveState: '{}' }).where(eq(organizations.id, org.id));
    await this.workspaces.setOrgFields(workspaceId, { orgMode: mode, chiefOfStaffAgentId: org.chiefOfStaffAgentId, orgMonthlyUsd: org.monthlyBudgetUsd });
    const ch = this.announcer.channels;
    let reopened = 0;
    if (ch) for (const id of st.channels ?? []) { try { await ch.updateChannel(id, { archived: false }); reopened++; } catch { /* deleted meanwhile */ } }
    await this.audit.append(org.id, { actor, action: 'org_restore', refType: 'org', refId: org.id, payload: { status, mode, channelsReopened: reopened } });
    await this.announcer.announce(workspaceId, `The company "${org.name}" is restored (${mode}${status === 'paused' ? ', still paused' : ''}).`);
    return { orgId: org.id, status, mode };
  }

  // ---- delete permanently ----

  async remove(workspaceId: string, input: DeleteOptions, actor = 'user'): Promise<DeleteReport> {
    this.assertOwner();
    await this.workspaces.get(workspaceId);
    const agentsChoice: AgentsChoice = input.agents ?? 'keep';
    const filesChoice: FilesChoice = input.files ?? 'keep';
    const channelsChoice: ChannelsChoice = input.channels ?? 'archive';
    if (!['keep', 'delete'].includes(agentsChoice)) throw new BadRequestException('agents must be keep or delete');
    if (!['keep', 'delete'].includes(filesChoice)) throw new BadRequestException('files must be keep or delete');
    if (!['archive', 'keep', 'delete'].includes(channelsChoice)) throw new BadRequestException('channels must be archive, keep or delete');
    // Idempotent: a retry after success finds nothing to do.
    if (input.orgId) {
      const any = (await this.db.select().from(organizations).where(eq(organizations.id, input.orgId)).limit(1)).at(0);
      if (!any) return { ok: true, orgId: input.orgId, name: '', alreadyDeleted: true, rows: {}, agents: { choice: agentsChoice, deleted: [], kept: [] }, files: { choice: filesChoice }, channels: { choice: channelsChoice, archived: 0, reopened: 0, deleted: 0 } };
      if (any.workspaceId !== workspaceId) throw new NotFoundException('this workspace has no such company');
    }
    const org = await this.archivedOrg(workspaceId, input.orgId);
    if ((input.confirmName ?? '').trim() !== org.name.trim()) throw new BadRequestException(`type the company's name exactly ("${org.name}") to delete it`);
    const st = parseState(org.archiveState);
    st.deleting = { startedAt: st.deleting?.startedAt ?? nowIso(), by: actor, agents: agentsChoice, files: filesChoice, channels: channelsChoice };
    await this.db.update(organizations).set({ archiveState: JSON.stringify(st) }).where(eq(organizations.id, org.id));

    const live = await this.org.byWorkspace(workspaceId);
    const report: DeleteReport = {
      ok: true, orgId: org.id, name: org.name, rows: {},
      agents: { choice: agentsChoice, deleted: [], kept: [] },
      files: { choice: filesChoice },
      channels: { choice: channelsChoice, archived: 0, reopened: 0, deleted: 0 },
    };

    // 1. Channels of the org's units (never #general or #company).
    const ch = this.announcer.channels;
    const unitRows = await this.db.select().from(orgUnits).where(eq(orgUnits.orgId, org.id));
    const channelIds = [...new Set(unitRows.filter((u) => u.channelId && u.parentUnitId !== null).map((u) => u.channelId as string))];
    const company = ch ? await ch.companyChannel(workspaceId).catch(() => null) : null;
    if (ch) {
      for (const id of channelIds) {
        if (id === company?.id) continue;
        try {
          if (channelsChoice === 'delete' && ch.deleteChannel) { await ch.deleteChannel(id); report.channels.deleted++; }
          else if (channelsChoice === 'keep') { await ch.updateChannel(id, { archived: false }); report.channels.reopened++; }
          else { await ch.updateChannel(id, { archived: true }); report.channels.archived++; }
        } catch { /* a channel deleted meanwhile */ }
      }
    }

    // 2. /org/ files — only while they are still this company's.
    if (live) report.files.skipped = `/org/ belongs to the live company "${live.name}" now; left untouched`;
    else if (!this.fs) report.files.skipped = 'no file store';
    else {
      const files = await this.fs.list(workspaceId, 'org').catch(() => []);
      if (files.length === 0) report.files.skipped = 'no files under /org/';
      else if (filesChoice === 'keep') {
        const base = `archive/org-${orgSlug(org.name)}-${(org.archivedAt ?? nowIso()).slice(0, 10)}`;
        let to = base;
        for (let n = 2; (await this.fs.list(workspaceId, to).catch(() => [])).length > 0; n++) to = `${base}-${n}`;
        report.files.moved = (await this.fs.move(workspaceId, 'org', to, { by: SYSTEM_FS })).moved;
        report.files.to = `/${to}/`;
      } else {
        let n = 0;
        for (const f of files) { await this.fs.delete(workspaceId, f.path, { by: SYSTEM_FS }).catch(() => undefined); n++; }
        report.files.deleted = n;
      }
    }

    // 3. The member agents: plain agents (kept), or deleted.
    const memberIds = (await this.org.members(org.id)).filter((m) => m.status !== 'terminated').map((m) => m.agentId);
    for (const agentId of memberIds) {
      const agent = await this.agents.get(agentId).catch(() => null);
      if (!agent) continue;
      const seatedElsewhere = (await this.org.membershipsOf(agentId)).some((m) => m.orgId !== org.id && m.status !== 'terminated');
      if (agentsChoice === 'delete' && !seatedElsewhere) { await this.agents.remove(agentId); report.agents.deleted.push(agent.name); }
      else report.agents.kept.push(agent.name);
    }

    // 4. Every org-scoped row, in one transaction; the organization row last.
    const tables = await this.orgIdTables();
    const present = new Set(tables);
    const planned = new Set(ORG_TABLE_PLAN.map((p) => p.table));
    await this.db.transaction(async (tx) => {
      const run = async (key: string, q: ReturnType<typeof sql>) => {
        const n = (await tx.execute(q)).rows.length;
        if (n > 0) report.rows[key] = (report.rows[key] ?? 0) + n;
      };
      for (const i of INDIRECT) await run(i.key, i.sql(org.id));
      for (const p of ORG_TABLE_PLAN) {
        if (!present.has(p.table)) continue;
        await run(p.mode === 'detach' ? `${p.table} (detached)` : p.table, p.mode === 'detach'
          ? sql`UPDATE ${sql.identifier(p.table)} SET "orgId" = NULL WHERE "orgId" = ${org.id} RETURNING 1`
          : sql`DELETE FROM ${sql.identifier(p.table)} WHERE "orgId" = ${org.id} RETURNING 1`);
      }
      // A table another branch added with an `orgId` column and no plan entry yet: its rows still go.
      for (const t of tables) if (!planned.has(t)) await run(t, sql`DELETE FROM ${sql.identifier(t)} WHERE "orgId" = ${org.id} RETURNING 1`);
      await run('organizations', sql`DELETE FROM organizations WHERE "id" = ${org.id} RETURNING 1`);
      if (!live) await tx.update(workspaces).set({ orgMode: 'off', chiefOfStaffAgentId: null }).where(eq(workspaces.id, workspaceId));
    });

    // 5. The final entry, on the workspace's chain (the org's own went with it).
    await this.workspaceAudit?.append(workspaceId, {
      actor, action: 'org_deleted', refType: 'org', refId: org.id,
      payload: { name: org.name, archivedAt: org.archivedAt, rows: report.rows, agents: report.agents, files: report.files, channels: report.channels },
    }).catch((err) => this.logger.warn(`workspace audit of org delete failed: ${err instanceof Error ? err.message : err}`));
    return report;
  }

  /** Tables of this database with an `orgId` column (besides `organizations`, which has `id`). */
  async orgIdTables(): Promise<string[]> {
    const r = await this.db.execute(sql`SELECT table_name AS t FROM information_schema.columns WHERE column_name = 'orgId' AND table_schema = current_schema() ORDER BY table_name`);
    return (r.rows as Array<{ t: string }>).map((x) => x.t);
  }
}
