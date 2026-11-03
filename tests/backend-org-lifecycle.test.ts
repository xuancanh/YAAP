/** Archive, restore and permanently delete a company (docs/owners-seat.md
 *  "Archive or delete the company"): archive stops everything and hides the
 *  company while keeping every row readable, its agents become plain agents,
 *  restore puts the mode and the paused state back; delete works only from
 *  the archived state with the name typed back, honours the agents / files /
 *  channels choices, empties every org table for that org only, records the
 *  final entry on the workspace's audit chain, is idempotent, and a new
 *  company can be started afterwards. Owner only. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { getTableColumns, getTableName, is, sql } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import * as schema from '../server/src/database/schema';
import { testDb, memStorage, ctxStub, skillsStub, mcpStub, ScriptedProvider } from './helpers';
import { ChatsRepository } from '../server/src/chats/chats.repository';
import { TurnLoopService } from '../server/src/chats/turn-loop.service';
import { ChatLocks } from '../server/src/chats/chat-locks';
import { ToolsService } from '../server/src/chats/tools.service';
import { TriggerBus } from '../server/src/chats/trigger-bus';
import { AgentsService } from '../server/src/agents/agents.service';
import { WorkspacesService } from '../server/src/workspaces/workspaces.service';
import { GroupChatService } from '../server/src/groupchat/groupchat.service';
import { WorkspaceEventBus } from '../server/src/groupchat/workspace-events';
import { WorkspaceFs } from '../server/src/files/workspace-fs.service';
import { PluginAuditService } from '../server/src/plugins/plugin-audit';
import { OrgAuditService } from '../server/src/org/org-audit.service';
import { OrgService } from '../server/src/org/org.service';
import { OrgTasksService } from '../server/src/org/org-tasks.service';
import { OrgApprovalsService } from '../server/src/org/org-approvals.service';
import { OrgBriefService } from '../server/src/org/org-brief.service';
import { OrgRuntimeService } from '../server/src/org/org-runtime.service';
import { OrgModeService } from '../server/src/org/org-mode.service';
import { OrgAnnouncer } from '../server/src/org/org-announcer';
import { OrgUnitsService } from '../server/src/org/org-units.service';
import { OrgController } from '../server/src/org/org.controller';
import { WorkspaceOrgController } from '../server/src/org/workspace-org.controller';
import { OrgBootstrapService } from '../server/src/org/org-bootstrap.service';
import { OrgLifecycleService, ORG_TABLE_PLAN } from '../server/src/org/org-lifecycle.service';
import { ArchivedOrgGuard } from '../server/src/org/archived-org.guard';
import { isOwnerOnlyRoute } from '../server/src/shared/workspace-access.guard';
import { runWithViewer, currentAccountId } from '../server/src/accounts/account-context';
import { setAddressLookup } from '../server/src/common/url-guard';
import type { ExecutionContext } from '@nestjs/common';

setAddressLookup(async () => [{ address: '93.184.216.34', family: 4 }]);

async function setup() {
  const db = await testDb();
  const { stub } = memStorage();
  const bus = new TriggerBus();
  const agents = new AgentsService(db, stub, bus);
  const workspaces = new WorkspacesService(db, stub);
  const repo = new ChatsRepository(db);
  const turns = new TurnLoopService(repo, new ChatLocks(), new ToolsService(stub), ctxStub(new ScriptedProvider([])), skillsStub(), stub, mcpStub(), agents, workspaces);
  const config = { get: (k: string) => (k === 'companiesEnabled' ? true : k === 'loopsEnabled' ? false : undefined) } as unknown as ConfigService;
  const announcer = new OrgAnnouncer();
  const audit = new OrgAuditService(db);
  const org = new OrgService(db, agents, audit, bus);
  const units = new OrgUnitsService(db, org, agents, audit, announcer);
  const tasks = new OrgTasksService(db, org, audit, bus, units);
  const approvals = new OrgApprovalsService(db, org, tasks, agents, audit, undefined, bus);
  const brief = new OrgBriefService(db, org, tasks, approvals, audit, agents, workspaces);
  const runtime = new OrgRuntimeService(db, org, tasks, approvals, audit, brief, turns, repo, agents, workspaces, config, announcer, bus, undefined, undefined, undefined, undefined, undefined, units);
  runtime.debounceMs = 60_000;
  const mode = new OrgModeService(org, workspaces, agents, runtime, approvals, audit, announcer);
  const orgs = new OrgController(org, tasks, approvals, audit, brief, runtime, config, units);
  const groupchat = new GroupChatService(db, workspaces, agents, stub, new WorkspaceEventBus(), config, undefined, bus, org, tasks, announcer);
  const fs = new WorkspaceFs(stub, db);
  const wsAudit = new PluginAuditService(db);
  const lifecycle = new OrgLifecycleService(db, org, workspaces, agents, runtime, audit, announcer, fs, wsAudit);
  const controller = new WorkspaceOrgController(mode, orgs, config, undefined, undefined, undefined, undefined, undefined, org, undefined, lifecycle);
  const bootstrap = new OrgBootstrapService(org, workspaces, agents, mode, approvals, runtime, audit);
  const ws = (await workspaces.list())[0];
  const chief = await agents.create({ name: 'Chief', charter: 'You run the company.', workspaceId: ws.id });
  const writer = await agents.create({ name: 'Writer', charter: 'You write.', workspaceId: ws.id });
  const editor = await agents.create({ name: 'Editor', charter: 'You edit.', workspaceId: ws.id });
  return { db, stub, agents, workspaces, repo, bus, audit, org, units, tasks, approvals, runtime, mode, orgs, controller, groupchat, fs, wsAudit, lifecycle, bootstrap, ws, chief, writer, editor, announcer };
}
type S = Awaited<ReturnType<typeof setup>>;

/** A company with a sub-unit (Writer leads Editor, so `#writer…` exists), a task, a goal and /org/ files. */
async function company(s: S, modeName: 'supervised' | 'autonomous' = 'supervised') {
  const st = await s.mode.setMode(s.ws.id, { mode: modeName, chiefOfStaffAgentId: s.chief.id, monthlyUsd: 30 });
  const orgId = st.orgId!;
  await s.org.updateMember(orgId, s.editor.id, { reportsToAgentId: s.writer.id });
  const task = await s.tasks.create(orgId, { title: 'Draft the launch post', assigneeAgentId: s.writer.id });
  const goal = await s.org.addGoal(orgId, { title: 'Ship v1', kind: 'objective' } as Parameters<OrgService['addGoal']>[1]);
  const fsActor = { kind: 'system' as const, id: 'system', name: 'system' };
  await s.fs.write(s.ws.id, 'org/README.md', Buffer.from('# The company'), { by: fsActor });
  await s.fs.write(s.ws.id, 'org/goals/ship.md', Buffer.from('ship it'), { by: fsActor });
  return { orgId, task, goal };
}

const count = async (s: S, table: string, orgId: string) => Number(((await s.db.execute(sql`SELECT COUNT(*)::int AS n FROM ${sql.identifier(table)} WHERE "orgId" = ${orgId}`)).rows[0] as { n: number }).n);

test('archive stops everything, hides the company and keeps every row; restore puts the mode and the active state back', async () => {
  const s = await setup();
  const { orgId, task } = await company(s, 'autonomous');
  const unitChannels = (await s.units.units(orgId)).filter((u) => u.parentUnitId !== null && u.channelId).map((u) => u.channelId!);
  assert.equal(unitChannels.length, 1, 'Writer leads a unit with its own channel');
  assert.ok(s.runtime.pendingWakeKeys().length > 0, 'the task queued a wake');
  const before = { tasks: await count(s, 'org_tasks', orgId), members: await count(s, 'org_members', orgId), goals: await count(s, 'org_goals', orgId), audit: await count(s, 'org_audit', orgId) };

  const res = await s.controller.archive(s.ws.id);
  assert.equal(res.archived.id, orgId);
  assert.equal(res.archived.restoreStatus, 'active'); assert.equal(res.archived.restoreMode, 'autonomous');
  // stopped: no queued wakes, runs refused, no tool access, no membership
  assert.deepEqual(s.runtime.pendingWakeKeys(), [], 'queued wakes dropped');
  assert.equal(await s.runtime.runTask(orgId, task.id, s.writer.id, 'manual'), 'skipped:paused');
  assert.deepEqual(await s.org.membershipsOf(s.writer.id), [], 'the seat is suspended: Writer is a plain agent');
  const session = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.writer.id, name: 'chat' });
  await assert.rejects(s.runtime.execute(session, 'org_read_board', {}));
  // no rituals or ticks: the brief hour passes without a brief, nothing expires
  const o0 = await s.org.get(orgId);
  const at = new Date(); at.setHours(o0.briefHour, 0, 0, 0);
  await s.runtime.tick(at);
  assert.equal((await s.org.get(orgId)).lastBriefAt, null, 'no brief for an archived company');
  // hidden: the workspace has no company; Home/Inbox/Company resolve none
  const st = await s.controller.status(s.ws.id);
  assert.equal(st.mode, 'off'); assert.equal(st.orgId, null); assert.equal(st.org, null);
  assert.equal(st.archived.length, 1); assert.equal(st.archived[0].name, o0.name);
  assert.equal(await s.org.byWorkspace(s.ws.id), null);
  await assert.rejects(s.controller.goals(s.ws.id), /no organization yet/);
  // unit channels read-only; #company kept open
  for (const id of unitChannels) assert.ok((await s.groupchat.get(id)).archivedAt, 'unit channel archived');
  assert.equal((await s.groupchat.bySlug(s.ws.id, 'company')).archivedAt, null);
  // intact and readable
  assert.equal(await count(s, 'org_tasks', orgId), before.tasks);
  assert.equal(await count(s, 'org_members', orgId), before.members);
  assert.equal(await count(s, 'org_goals', orgId), before.goals);
  assert.ok(await count(s, 'org_audit', orgId) > before.audit, 'the archive is on the org chain');
  const detail = await s.controller.archivedDetail(s.ws.id, orgId);
  assert.equal(detail.members.length, 3); assert.ok(detail.goals.some((g) => g.title === 'Ship v1'));
  assert.equal(detail.counts.org_tasks, 1); assert.equal(detail.canRestore, true);
  assert.ok(detail.audit.some((a) => a.action === 'org_archive'));
  // writes through /api/orgs/:id are refused while archived
  const guard = new ArchivedOrgGuard(s.org);
  const ctx = (method: string) => ({ switchToHttp: () => ({ getRequest: () => ({ method, params: { id: orgId } }) }) }) as unknown as ExecutionContext;
  assert.equal(await guard.canActivate(ctx('GET')), true);
  await assert.rejects(guard.canActivate(ctx('POST')), /archived and read-only/);
  // archiving twice: nothing to archive
  await assert.rejects(s.controller.archive(s.ws.id), /no company to archive/);

  const back = await s.controller.restore(s.ws.id, {});
  assert.deepEqual(back.restored, { orgId, status: 'active', mode: 'autonomous' });
  const ws = await s.workspaces.get(s.ws.id);
  assert.equal(ws.orgMode, 'autonomous'); assert.equal(ws.chiefOfStaffAgentId, s.chief.id);
  assert.equal((await s.org.get(orgId)).status, 'active');
  assert.equal((await s.org.membershipsOf(s.writer.id)).length, 1, 'the seat is back');
  assert.match(await s.runtime.execute(session, 'org_read_board', {}), /Draft the launch post/);
  for (const id of unitChannels) assert.equal((await s.groupchat.get(id)).archivedAt, null, 'unit channel reopened');
  assert.equal((await s.controller.status(s.ws.id)).archived.length, 0);
  assert.ok((await s.audit.list(orgId, { action: 'org_restore' })).length === 1);
});

test('a paused company comes back paused; restore is refused while a new company is live', async () => {
  const s = await setup();
  const { orgId } = await company(s);
  await s.mode.pause(s.ws.id);
  await s.controller.archive(s.ws.id);
  // a new company starts in the same workspace through onboarding
  const boot = await s.bootstrap.bootstrap(s.ws.id, { mode: 'supervised', chief: { agentId: s.editor.id }, monthlyUsd: 5 });
  assert.ok(boot);
  const live = (await s.org.byWorkspace(s.ws.id))!;
  assert.notEqual(live.id, orgId);
  await assert.rejects(s.controller.restore(s.ws.id, { orgId }), /already has a company/);
  // archive the new one, restore the old one: paused stays paused
  await s.controller.archive(s.ws.id);
  assert.equal((await s.controller.status(s.ws.id)).archived.length, 2);
  const back = await s.controller.restore(s.ws.id, { orgId });
  assert.equal(back.restored.status, 'paused'); assert.equal(back.restored.mode, 'supervised');
  assert.equal((await s.org.get(orgId)).status, 'paused');
  assert.equal((await s.workspaces.get(s.ws.id)).orgMode, 'supervised');
});

test('delete: only from archived, the name typed back; keeps agents as plain agents, moves /org/ under /archive/, archives channels', async () => {
  const s = await setup();
  const { orgId } = await company(s);
  const name = (await s.org.get(orgId)).name;
  const personal = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.writer.id, name: 'personal chat' });
  await assert.rejects(s.controller.remove(s.ws.id, { confirmName: name }), /no archived company/);
  await assert.rejects(s.lifecycle.remove(s.ws.id, { orgId, confirmName: name }), /not archived/);
  await s.controller.archive(s.ws.id);
  await assert.rejects(s.controller.remove(s.ws.id, { confirmName: 'nope' }), /type the company's name exactly/);
  const unitChannels = (await s.units.units(orgId, { archived: true })).filter((u) => u.parentUnitId !== null && u.channelId).map((u) => u.channelId!);

  const report = await s.controller.remove(s.ws.id, { confirmName: ` ${name} ` });
  assert.equal(report.ok, true); assert.equal(report.orgId, orgId);
  assert.deepEqual(report.agents.deleted, []); assert.deepEqual([...report.agents.kept].sort(), ['Chief', 'Editor', 'Writer']);
  for (const a of [s.chief, s.writer, s.editor]) assert.ok(await s.agents.get(a.id), 'kept as a plain agent');
  assert.equal(report.files.moved, 2);
  assert.match(report.files.to!, /^\/archive\/org-.+-\d{4}-\d{2}-\d{2}\/$/);
  const dest = report.files.to!.slice(1, -1);
  assert.deepEqual((await s.fs.list(s.ws.id, dest)).map((f) => f.path.slice(dest.length + 1)).sort(), ['README.md', 'goals/ship.md']);
  assert.equal((await s.fs.list(s.ws.id, 'org')).length, 0);
  assert.equal(report.channels.archived, unitChannels.length);
  for (const id of unitChannels) assert.ok((await s.groupchat.get(id)).archivedAt, 'channel kept, archived');
  assert.ok(await s.repo.getSession(personal.id), 'personal chats untouched');
  assert.equal((await s.org.list(s.ws.id)).length, 0, 'the organization row is gone');
  for (const { table } of ORG_TABLE_PLAN) assert.equal(await count(s, table, orgId), 0, `${table} emptied`);
  // the final entry is on the workspace's audit chain
  const wsChain = await s.wsAudit.list(s.ws.id);
  const final = wsChain.find((r) => r.action === 'org_deleted')!;
  assert.ok(final); assert.equal(final.refId, orgId); assert.equal(JSON.parse(final.payload).name, name);
  assert.equal((await s.wsAudit.verify(s.ws.id)).ok, true);
  // idempotent
  const again = await s.controller.remove(s.ws.id, { orgId, confirmName: name });
  assert.equal(again.alreadyDeleted, true);
  // a new company can be started afterwards
  assert.equal((await s.workspaces.get(s.ws.id)).orgMode, 'off');
  await s.bootstrap.bootstrap(s.ws.id, { mode: 'supervised', chief: { agentId: s.chief.id }, monthlyUsd: 5 });
  const fresh = (await s.org.byWorkspace(s.ws.id))!;
  assert.ok(fresh && fresh.id !== orgId);
  assert.equal((await s.org.members(fresh.id)).length, 3, 'the kept agents join the new company');
});

test('delete with agents and files deleted and channels deleted; the other workspace and its company are untouched', async () => {
  const s = await setup();
  const { orgId } = await company(s);
  const other = await s.workspaces.create({ name: 'Other' });
  const oChief = await s.agents.create({ name: 'Other chief', charter: 'x', workspaceId: other.id });
  const oSt = await s.mode.setMode(other.id, { mode: 'supervised', chiefOfStaffAgentId: oChief.id });
  const otherOrg = oSt.orgId!;
  await s.tasks.create(otherOrg, { title: 'Other task', assigneeAgentId: oChief.id });
  await s.fs.write(other.id, 'org/README.md', Buffer.from('other'), { by: { kind: 'system', id: 'system', name: 'system' } });
  const name = (await s.org.get(orgId)).name;
  await s.controller.archive(s.ws.id);
  const unitChannels = (await s.units.units(orgId, { archived: true })).filter((u) => u.parentUnitId !== null && u.channelId).map((u) => u.channelId!);
  const otherBefore: Record<string, number> = {};
  for (const t of await s.lifecycle.orgIdTables()) otherBefore[t] = await count(s, t, otherOrg);

  const report = await s.controller.remove(s.ws.id, { confirmName: name, agents: 'delete', files: 'delete', channels: 'delete' });
  assert.deepEqual([...report.agents.deleted].sort(), ['Chief', 'Editor', 'Writer']);
  for (const a of [s.chief, s.writer, s.editor]) await assert.rejects(s.agents.get(a.id));
  assert.equal(report.files.deleted, 2);
  assert.equal((await s.fs.list(s.ws.id, 'org')).length, 0);
  assert.equal((await s.fs.list(s.ws.id, 'archive')).length, 0, 'nothing moved');
  assert.equal(report.channels.deleted, unitChannels.length);
  for (const id of unitChannels) await assert.rejects(s.groupchat.get(id));
  assert.ok(await s.groupchat.bySlug(s.ws.id, 'company'), '#company stays');
  // the other workspace: its agent, company, rows and files
  assert.ok(await s.agents.get(oChief.id));
  assert.equal((await s.org.byWorkspace(other.id))!.id, otherOrg);
  for (const t of await s.lifecycle.orgIdTables()) assert.equal(await count(s, t, otherOrg), otherBefore[t], `${t} of the other company untouched`);
  assert.equal((await s.fs.list(other.id, 'org')).length, 1);
});

test('every table with an orgId column is covered by the delete plan, and every one is emptied for that org only', async () => {
  const s = await setup();
  const planned = new Set(ORG_TABLE_PLAN.map((p) => p.table));
  // the database's tables (migrations) and the schema's (schema.ts) — both directions
  const dbTables = await s.lifecycle.orgIdTables();
  for (const t of dbTables) assert.ok(planned.has(t), `table ${t} has an orgId column but is not in ORG_TABLE_PLAN (server/src/org/org-lifecycle.service.ts)`);
  const schemaTables = Object.values(schema).filter((v) => is(v, PgTable) && 'orgId' in getTableColumns(v as PgTable)).map((v) => getTableName(v as PgTable));
  for (const t of schemaTables) assert.ok(planned.has(t), `schema table ${t} has an orgId column but is not in ORG_TABLE_PLAN`);
  for (const t of planned) assert.ok(dbTables.includes(t), `ORG_TABLE_PLAN names ${t}, which has no orgId column`);

  // one synthesized row per table for two orgs; delete one; the other's rows stay
  const a = await company(s);
  const other = await s.workspaces.create({ name: 'Other' });
  const oChief = await s.agents.create({ name: 'Other chief', charter: 'x', workspaceId: other.id });
  const otherOrg = (await s.mode.setMode(other.id, { mode: 'supervised', chiefOfStaffAgentId: oChief.id })).orgId!;
  const cols = (await s.db.execute(sql`SELECT table_name AS t, column_name AS c, data_type AS d, is_nullable AS n, column_default AS def FROM information_schema.columns WHERE table_schema = current_schema()`)).rows as Array<{ t: string; c: string; d: string; n: string; def: string | null }>;
  const synth = async (table: string, orgId: string) => {
    const need = cols.filter((c) => c.t === table && c.n === 'NO' && c.def === null && c.c !== 'orgId');
    const names = ['orgId', ...need.map((c) => c.c)];
    const values = [orgId, ...need.map((c) => (c.c === 'accountId' ? currentAccountId() : /int|real|double|numeric/.test(c.d) ? 0 : randomUUID()))];
    await s.db.execute(sql`INSERT INTO ${sql.identifier(table)} (${sql.join(names.map((n) => sql.identifier(n)), sql`, `)}) VALUES (${sql.join(values.map((v) => sql`${v}`), sql`, `)})`);
  };
  for (const t of dbTables) { await synth(t, a.orgId); await synth(t, otherOrg); }
  const otherBefore: Record<string, number> = {};
  for (const t of dbTables) otherBefore[t] = await count(s, t, otherOrg);
  const name = (await s.org.get(a.orgId)).name;
  await s.controller.archive(s.ws.id);
  const report = await s.controller.remove(s.ws.id, { confirmName: name });
  for (const t of dbTables) {
    assert.equal(await count(s, t, a.orgId), 0, `${t}: no row left for the deleted org`);
    assert.equal(await count(s, t, otherOrg), otherBefore[t], `${t}: the other org's rows stay`);
  }
  assert.ok((report.rows['registry_installs (detached)'] ?? 0) >= 1, 'shared rows are detached, not deleted');
});

test('owner only: members and viewers cannot archive, restore or delete; the routes are owner-only', async () => {
  const s = await setup();
  await company(s);
  const as = (role: 'member' | 'viewer') => <T>(fn: () => Promise<T>) => runWithViewer(currentAccountId(), { memberAccountId: 'someone', role, workspaceId: s.ws.id, displayName: 'M' }, fn);
  await assert.rejects(as('member')(() => s.controller.archive(s.ws.id)), /only the workspace owner/);
  await s.controller.archive(s.ws.id);
  await assert.rejects(as('member')(() => s.controller.restore(s.ws.id, {})), /only the workspace owner/);
  await assert.rejects(as('viewer')(() => s.controller.remove(s.ws.id, { confirmName: 'x' })), /only the workspace owner/);
  assert.equal(isOwnerOnlyRoute('POST', `/api/workspaces/${s.ws.id}/org/archive`), true);
  assert.equal(isOwnerOnlyRoute('POST', `/api/workspaces/${s.ws.id}/org/restore`), true);
  assert.equal(isOwnerOnlyRoute('DELETE', `/api/workspaces/${s.ws.id}/org`), true);
  assert.equal(isOwnerOnlyRoute('GET', `/api/workspaces/${s.ws.id}/org/archived`), false);
  // the legacy partial delete is gone
  assert.throws(() => s.orgs.remove('x'), /archive the company first/);
});

test('an interrupted delete can be retried: it redoes only what is left', async () => {
  const s = await setup();
  const { orgId } = await company(s);
  const name = (await s.org.get(orgId)).name;
  await s.controller.archive(s.ws.id);
  // the first attempt dies inside the transaction (a table that refuses the delete)
  await s.db.execute(sql`CREATE OR REPLACE FUNCTION refuse_delete() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'disk on fire'; END $$ LANGUAGE plpgsql`);
  await s.db.execute(sql`CREATE TRIGGER refuse BEFORE DELETE ON org_audit FOR EACH ROW EXECUTE FUNCTION refuse_delete()`);
  await assert.rejects(s.controller.remove(s.ws.id, { confirmName: name }), /DELETE FROM "org_audit"/);
  const org = await s.org.get(orgId);
  assert.equal(org.status, 'archived', 'still archived');
  assert.ok(JSON.parse(org.archiveState).deleting, 'the attempt is recorded');
  assert.ok(await count(s, 'org_tasks', orgId) > 0, 'the transaction rolled back: rows intact');
  await assert.rejects(s.controller.restore(s.ws.id, {}), /being deleted/);
  await s.db.execute(sql`DROP TRIGGER refuse ON org_audit`);
  const report = await s.controller.remove(s.ws.id, { confirmName: name });
  assert.equal(report.ok, true);
  assert.equal(report.files.skipped, 'no files under /org/', 'the files moved on the first attempt');
  assert.equal(await count(s, 'org_tasks', orgId), 0);
});
