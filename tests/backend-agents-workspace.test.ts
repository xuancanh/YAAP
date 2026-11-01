/** Workspace-owned agents (execution-plan item 26, docs/shared-agents.md
 *  "Workspace ownership"): every agent belongs to exactly one workspace and
 *  is never shared across them. Migration 0038's backfill rule, the list
 *  filter, the create default (service) and requirement (HTTP), org
 *  enrolment limited to the workspace, foreign agents refused by org and
 *  channel membership and by chat creation, hires landing in the org's
 *  workspace, the explicit move (and its refusal while enrolled), and loop
 *  sessions running in the agent's own workspace. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { ConfigService } from '@nestjs/config';
import { BadRequestException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { agentEvents } from '../server/src/database/schema';
import { runPgMigrations, backfillAgentWorkspaces } from '../server/src/database/migrator';
import { testDb, memStorage, ctxStub, skillsStub, mcpStub, ScriptedProvider, pgliteQueryable } from './helpers';
import { ChatsRepository } from '../server/src/chats/chats.repository';
import { ChatsService } from '../server/src/chats/chats.service';
import { TurnLoopService } from '../server/src/chats/turn-loop.service';
import { ChatLocks } from '../server/src/chats/chat-locks';
import { ToolsService } from '../server/src/chats/tools.service';
import { TriggerBus } from '../server/src/chats/trigger-bus';
import { LoopsService } from '../server/src/chats/loops.service';
import { DistillService } from '../server/src/chats/distill.service';
import { AgentMemoryService } from '../server/src/agents/agent-memory.service';
import { AgentsService } from '../server/src/agents/agents.service';
import { AgentsController } from '../server/src/agents/agents.controller';
import { WorkspacesService } from '../server/src/workspaces/workspaces.service';
import { OrgAuditService } from '../server/src/org/org-audit.service';
import { OrgService } from '../server/src/org/org.service';
import { OrgTasksService } from '../server/src/org/org-tasks.service';
import { OrgApprovalsService } from '../server/src/org/org-approvals.service';
import { OrgBriefService } from '../server/src/org/org-brief.service';
import { OrgRuntimeService } from '../server/src/org/org-runtime.service';
import { OrgModeService } from '../server/src/org/org-mode.service';
import { OrgAnnouncer } from '../server/src/org/org-announcer';
import { GroupChatService } from '../server/src/groupchat/groupchat.service';
import { WorkspaceEventBus } from '../server/src/groupchat/workspace-events';
import type { StorageService } from '../server/src/storage/storage.service';
import type { AiStreamEvent } from '../server/src/ai/ai-provider.interface';
import { setAddressLookup } from '../server/src/common/url-guard';

setAddressLookup(async () => [{ address: '93.184.216.34', family: 4 }]);

const silent = { log: () => {} };

/** Two workspaces, the org stack and a channel service, exactly as the org
 *  mode tests wire them; `ws` is the default (oldest) workspace. */
async function setup(rounds: AiStreamEvent[][] = []) {
  const db = await testDb();
  const { stub } = memStorage();
  const bus = new TriggerBus();
  const agents = new AgentsService(db, stub, bus);
  const workspaces = new WorkspacesService(db, stub);
  const repo = new ChatsRepository(db);
  const provider = new ScriptedProvider(rounds);
  const turns = new TurnLoopService(repo, new ChatLocks(), new ToolsService(stub), ctxStub(provider), skillsStub(), stub, mcpStub(), agents, workspaces);
  const config = { get: (k: string) => (k === 'companiesEnabled' ? true : k === 'loopsEnabled' ? false : undefined) } as unknown as ConfigService;
  const announced: Array<{ workspaceId: string; text: string }> = [];
  const announcer = new OrgAnnouncer({ announce: async (workspaceId, text) => { announced.push({ workspaceId, text }); } });
  const audit = new OrgAuditService(db);
  const org = new OrgService(db, agents, audit, bus);
  const tasks = new OrgTasksService(db, org, audit, bus);
  const approvals = new OrgApprovalsService(db, org, tasks, agents, audit, undefined, bus);
  const brief = new OrgBriefService(db, org, tasks, approvals, audit, agents, workspaces);
  const runtime = new OrgRuntimeService(db, org, tasks, approvals, audit, brief, turns, repo, agents, workspaces, config, announcer, bus);
  const mode = new OrgModeService(org, workspaces, agents, runtime, approvals, audit, announcer);
  const groupchat = new GroupChatService(db, workspaces, agents, stub, new WorkspaceEventBus(), config, undefined, bus, org, tasks, announcer);
  const ws = (await workspaces.list())[0];
  const ws2 = await workspaces.create({ name: 'Second' });
  return { db, stub: stub as unknown as StorageService, agents, workspaces, repo, turns, provider, bus, org, tasks, approvals, runtime, mode, groupchat, ws, ws2, announced };
}

// ---- 1. the migration backfill ----

test('0038 backfills every agent to its account default workspace, the org workspace winning for a member of exactly one org', async () => {
  const pg = new PGlite();
  const q = pgliteQueryable(pg);
  await runPgMigrations(q, silent);
  const at = (n: number) => `2026-01-0${n}T00:00:00.000Z`;
  // account "single": two workspaces (w1 oldest), one org in w2
  await q.query(`INSERT INTO workspaces ("id", "name", "createdAt") VALUES ('w1', 'Default', $1), ('w2', 'Studio', $2)`, [at(1), at(2)]);
  await q.query(`INSERT INTO organizations ("id", "workspaceId", "name", "createdAt") VALUES ('o2', 'w2', 'Studio Inc', $1)`, [at(3)]);
  await q.query(`INSERT INTO agents ("id", "name", "createdAt") VALUES ('free', 'Free', $1), ('seated', 'Seated', $1), ('fired', 'Fired', $1)`, [at(3)]);
  await q.query(`INSERT INTO org_members ("id", "orgId", "agentId", "joinedAt", "status") VALUES ('m1', 'o2', 'seated', $1, 'active'), ('m2', 'o2', 'fired', $1, 'terminated')`, [at(3)]);
  // another account with an agent but no workspace at all
  await q.query(`INSERT INTO agents ("id", "accountId", "name", "createdAt") VALUES ('orphan', 'acct-b', 'Orphan', $1)`, [at(3)]);
  assert.deepEqual(await q.query(`SELECT "workspaceId" FROM agents WHERE "id" = 'free'`).then((r) => r.rows), [{ workspaceId: '' }], 'the column defaults to empty');

  const touched = await backfillAgentWorkspaces(q);
  assert.equal(touched, 3, 'the three agents of the account with workspaces');
  const rows = (await q.query(`SELECT "id", "workspaceId" FROM agents ORDER BY "id"`)).rows as Array<{ id: string; workspaceId: string }>;
  assert.deepEqual(rows, [
    { id: 'fired', workspaceId: 'w1' }, // a terminated seat does not count: the default
    { id: 'free', workspaceId: 'w1' }, // no org: the account's oldest workspace
    { id: 'orphan', workspaceId: '' }, // no workspace in its account: left for later
    { id: 'seated', workspaceId: 'w2' }, // a member of exactly one org: that org's workspace
  ]);
  // idempotent: a second run touches nothing, and the migration is recorded once
  assert.equal(await backfillAgentWorkspaces(q), 0);
  await runPgMigrations(q, silent);
  assert.equal((await q.query(`SELECT "id" FROM __migrations WHERE "id" = '0038-agents-workspace'`)).rows.length, 1);
  assert.equal((await q.query(`SELECT 1 FROM pg_indexes WHERE tablename = 'agents' AND indexname = 'idx_agents_workspace'`)).rows.length, 1);
  await pg.close();
});

// ---- 2. list, create, the HTTP requirement ----

test('agents.list filters by workspace; create defaults to the default workspace in the service and requires one over HTTP', async () => {
  const s = await setup();
  const a = await s.agents.create({ name: 'A' }); // no workspace named: the default
  const b = await s.agents.create({ name: 'B', workspaceId: s.ws2.id });
  assert.equal(a.workspaceId, s.ws.id);
  assert.equal(b.workspaceId, s.ws2.id);
  assert.deepEqual((await s.agents.list({ workspaceId: s.ws.id })).map((x) => x.id), [a.id]);
  assert.deepEqual((await s.agents.list({ workspaceId: s.ws2.id })).map((x) => x.id), [b.id]);
  assert.equal((await s.agents.list()).length, 2, 'without a workspace, every agent of the account');
  await assert.rejects(s.agents.create({ name: 'C', workspaceId: 'nope' }), BadRequestException);

  const controller = new AgentsController(s.agents, s.stub, {} as never, {} as never, {} as never, {} as never);
  await assert.rejects(controller.create({ name: 'Over HTTP' } as never), BadRequestException);
  await assert.rejects(controller.create({ name: 'Over HTTP', workspaceId: '  ' } as never), BadRequestException);
  const c = await controller.create({ name: 'Over HTTP', workspaceId: s.ws2.id } as never);
  assert.equal(c.workspaceId, s.ws2.id);
  assert.deepEqual((await controller.list(s.ws2.id)).map((x) => x.name).sort(), ['B', 'Over HTTP']);
  assert.equal((await controller.list(undefined)).length, 3);
});

test('a brand-new account with no workspace yet: the service creates the default workspace the agent lands in', async () => {
  const db = await testDb();
  const { stub } = memStorage();
  const agents = new AgentsService(db, stub);
  const workspaces = new WorkspacesService(db, stub);
  const a = await agents.create({ name: 'First' });
  const all = await workspaces.list();
  assert.equal(all.length, 1, 'one default workspace, not two');
  assert.equal(a.workspaceId, all[0].id);
});

// ---- 3. organizations are their workspace's ----

test('enabling organization mode enrols only the workspace agents; addMember refuses an agent of another workspace', async () => {
  const s = await setup();
  const chief = await s.agents.create({ name: 'Chief', workspaceId: s.ws.id });
  const writer = await s.agents.create({ name: 'Writer', workspaceId: s.ws.id });
  const outsider = await s.agents.create({ name: 'Outsider', workspaceId: s.ws2.id });

  const st = await s.mode.setMode(s.ws.id, { mode: 'supervised', chiefOfStaffAgentId: chief.id });
  assert.deepEqual(st.enrolled, [writer.id], 'the outsider is not a candidate');
  assert.deepEqual(st.notEnrolled, []);
  assert.equal(await s.org.member(st.orgId!, outsider.id), null);

  await assert.rejects(s.org.addMember(st.orgId!, { agentId: outsider.id, reportsToAgentId: chief.id, scopes: [] }), (err: unknown) => err instanceof BadRequestException && /another workspace/.test(err.message));
  // a chief from another workspace cannot lead this one's company either
  await assert.rejects(s.mode.setMode(s.ws2.id, { mode: 'supervised', chiefOfStaffAgentId: chief.id }), BadRequestException);
});

test('a hire lands in the organization workspace', async () => {
  const s = await setup();
  const chief = await s.agents.create({ name: 'Chief', workspaceId: s.ws2.id });
  const st = await s.mode.setMode(s.ws2.id, { mode: 'supervised', chiefOfStaffAgentId: chief.id });
  const hired = await s.approvals.applyHire(st.orgId!, {
    packId: null, name: 'Analyst', title: 'Analyst', charter: 'You analyse.', reportsToAgentId: chief.id, requestedScopes: [], scopes: [],
  } as never, 'user', 'user');
  const agent = await s.agents.get(hired.agentId);
  assert.equal(agent.workspaceId, s.ws2.id);
  assert.deepEqual((await s.agents.list({ workspaceId: s.ws.id })).map((a) => a.id), [], 'nothing leaked into the default workspace');
  assert.ok(await s.org.member(st.orgId!, hired.agentId));
});

// ---- 4. channels are their workspace's ----

test('a channel refuses an agent of another workspace; "all agents" means the workspace agents', async () => {
  const s = await setup();
  const home = await s.agents.create({ name: 'Home', workspaceId: s.ws.id });
  const away = await s.agents.create({ name: 'Away', workspaceId: s.ws2.id });
  const c = await s.groupchat.create(s.ws.id, { name: 'Design' });
  await s.groupchat.addMember(c.id, { kind: 'agent', id: home.id });
  await assert.rejects(s.groupchat.addMember(c.id, { kind: 'agent', id: away.id }), (err: unknown) => err instanceof BadRequestException && /another workspace/.test(err.message));
  const all = await s.groupchat.ensureChannel(s.ws.id, 'everyone', 'Everyone', { allAgents: true });
  const members = (await s.groupchat.members(all.id)).filter((m) => m.memberKind === 'agent').map((m) => m.memberId);
  assert.deepEqual(members, [home.id]);
});

test('a chat session names an agent of its own workspace only', async () => {
  const s = await setup();
  const away = await s.agents.create({ name: 'Away', workspaceId: s.ws2.id });
  const chats = new ChatsService(s.repo, s.agents);
  await assert.rejects(chats.create({ workspaceId: s.ws.id, agentId: away.id, name: 'x' }), (err: unknown) => err instanceof BadRequestException && /another workspace/.test(err.message));
  const ok = await chats.create({ workspaceId: s.ws2.id, agentId: away.id, name: 'x' });
  assert.equal(ok.workspaceId, s.ws2.id);
});

// ---- 5. the explicit move ----

test('move changes the owner, takes the chats along, drops old channel seats, audits — and is refused while the agent sits in an organization', async () => {
  const s = await setup();
  const chief = await s.agents.create({ name: 'Chief', workspaceId: s.ws.id });
  const nomad = await s.agents.create({ name: 'Nomad', workspaceId: s.ws.id });
  const st = await s.mode.setMode(s.ws.id, { mode: 'supervised', chiefOfStaffAgentId: chief.id });
  assert.deepEqual(st.enrolled, [nomad.id]);
  await assert.rejects(s.agents.move(nomad.id, s.ws2.id), (err: unknown) => err instanceof BadRequestException && /member of/.test(err.message));
  assert.equal((await s.agents.get(nomad.id)).workspaceId, s.ws.id, 'unchanged after the refusal');

  await s.org.terminateMember(st.orgId!, nomad.id, 'user');
  const session = await s.repo.createSession({ workspaceId: s.ws.id, agentId: nomad.id, name: 'Notes' });
  const c = await s.groupchat.create(s.ws.id, { name: 'Design', agentIds: [nomad.id] });
  assert.ok(await s.groupchat.member(c.id, 'agent', nomad.id));

  const moved = await s.agents.move(nomad.id, s.ws2.id);
  assert.equal(moved.workspaceId, s.ws2.id);
  assert.equal((await s.repo.getSession(session.id))!.workspaceId, s.ws2.id, 'its chats move with it');
  assert.equal(await s.groupchat.member(c.id, 'agent', nomad.id), null, 'channel seats in the old workspace are dropped');
  assert.deepEqual((await s.agents.list({ workspaceId: s.ws.id })).map((a) => a.id), [chief.id]);
  const audit = (await s.db.select().from(agentEvents).where(eq(agentEvents.agentId, nomad.id))).filter((e) => e.kind === 'moved');
  assert.equal(audit.length, 1);
  assert.deepEqual(JSON.parse(audit[0].payload), { from: s.ws.id, to: s.ws2.id, actor: 'user' });
  assert.equal(audit[0].silent, 1, 'an audit row, not a notification');
  await assert.rejects(s.agents.move(nomad.id, 'nope'), BadRequestException);
  assert.equal((await s.agents.move(nomad.id, s.ws2.id)).workspaceId, s.ws2.id, 'a move to the current workspace is a no-op');
});

test('deleting a workspace re-homes its agents to the oldest remaining one', async () => {
  const s = await setup();
  const a = await s.agents.create({ name: 'A', workspaceId: s.ws2.id });
  await s.workspaces.remove(s.ws2.id);
  assert.equal((await s.agents.get(a.id)).workspaceId, s.ws.id);
});

// ---- 6. unattended work runs where the agent lives ----

test('a loop runs its session in the agent workspace, not the default one', async () => {
  const s = await setup([[{ type: 'answer', text: 'done' }, { type: 'done' }]]);
  const config = { get: (k: string) => (k === 'loopsEnabled' ? false : undefined) } as unknown as ConfigService;
  const memory = new AgentMemoryService(s.db, s.stub);
  const distill = new DistillService(s.repo, ctxStub(s.provider), s.agents, memory);
  const loops = new LoopsService(s.agents, s.workspaces, s.repo, s.turns, distill, config);
  const agent = await s.agents.create({ name: 'Watchdog', workspaceId: s.ws2.id, loops: [{ name: 'Nightly', cron: '0 2 * * *' }] });
  const status = await loops.runLoop(agent.id, agent.name, { name: 'Nightly', cron: '0 2 * * *', prompt: 'check' });
  assert.equal(status, 'ran');
  const inSecond = (await s.repo.listSessions(s.ws2.id)).find((x) => x.name === 'Loop · Nightly');
  assert.ok(inSecond, 'the loop session lives in the agent workspace');
  assert.equal(inSecond!.agentId, agent.id);
  assert.equal((await s.repo.listSessions(s.ws.id)).some((x) => x.name === 'Loop · Nightly'), false, 'nothing in the default workspace');
});
