/**
 * Shared agents (docs/shared-agents.md, execution-plan item 8; phase D of
 * docs/autonomous-company.md): invitations and roles, a member acting inside
 * the owner's account, connection selection by initiator, approvals routed
 * to the connection's owner, lesson audiences and flow rules, attribution in
 * shared sessions, channel turns that belong to a member, and humans in an
 * organisation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException, ForbiddenException, NotFoundException, type ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import { agentEvents, chatSessions, connections, orgAudit, workspaceMembers } from '../server/src/database/schema';
import { testDb, memStorage, ctxStub, skillsStub, mcpStub, ScriptedProvider } from './helpers';
import { accountContextMiddleware, actorId, bindAccount, currentAccountId, currentViewer, runWithAccount, runWithViewer, type Viewer } from '../server/src/accounts/account-context';
import { unscoped } from '../server/src/accounts/scoped-db';
import { AccountsService } from '../server/src/accounts/accounts.service';
import { SharedService } from '../server/src/shared/shared.service';
import { WorkspaceAccessGuard, checkRole, isOwnerOnlyRoute } from '../server/src/shared/workspace-access.guard';
import { ConnectionsService } from '../server/src/connections/connections.service';
import { AgentsService } from '../server/src/agents/agents.service';
import { AgentMemoryService, privateAudience, visibleTo } from '../server/src/agents/agent-memory.service';
import { AgentTypesService } from '../server/src/agent-types/agent-types.service';
import { WorkspacesService } from '../server/src/workspaces/workspaces.service';
import { SettingsService } from '../server/src/settings/settings.module';
import { ChatsRepository } from '../server/src/chats/chats.repository';
import { ChatsService } from '../server/src/chats/chats.service';
import { TurnLoopService, type TurnEvent } from '../server/src/chats/turn-loop.service';
import { TurnContextService } from '../server/src/chats/turn-context.service';
import { ChatLocks } from '../server/src/chats/chat-locks';
import { ToolsService } from '../server/src/chats/tools.service';
import { audienceForSession } from '../server/src/chats/distill.service';
import { AgentApprovalsController } from '../server/src/chats/agent-approvals.controller';
import { TelegramService } from '../server/src/channels/telegram.service';
import { TriggerBus } from '../server/src/chats/trigger-bus';
import { OrgAuditService } from '../server/src/org/org-audit.service';
import { OrgService, mayDecide } from '../server/src/org/org.service';
import { OrgTasksService } from '../server/src/org/org-tasks.service';
import { OrgApprovalsService } from '../server/src/org/org-approvals.service';
import { OrgBriefService } from '../server/src/org/org-brief.service';
import { OrgRuntimeService } from '../server/src/org/org-runtime.service';
import { OrgController } from '../server/src/org/org.controller';
import { AiProviderFactory } from '../server/src/ai/providers.factory';
import type { AiStreamEvent } from '../server/src/ai/ai-provider.interface';
import type { StorageService } from '../server/src/storage/storage.service';
import type { OutboundEmail } from '../server/src/channels/email-sender';
import { seal } from '../server/src/common/secretbox';
import { setAddressLookup } from '../server/src/common/url-guard';

setAddressLookup(async () => [{ address: '93.184.216.34', family: 4 }]);

const cfg = (values: Record<string, unknown>): ConfigService => ({ get: (k: string) => values[k] }) as unknown as ConfigService;
const accountsCfg = (extra: Record<string, unknown> = {}) => cfg({
  authMode: 'accounts', accountsDefaultPlan: 'free', emailSendProvider: 'off',
  publicBaseUrl: 'https://api.example', publicAppUrl: 'https://app.example', emailDomain: 'agents.example',
  hostedPlanUsd: 15, platformKeys: {}, adminEmails: '', companiesEnabled: true, loopsEnabled: false, maxToolRounds: 24, ...extra,
});

const linkToken = (mail: OutboundEmail) => new URL(/https:\/\/\S+/.exec(mail.text)![0]).searchParams.get('token')!;

/** Run `fn` inside a request-shaped context, the way bootstrap's middleware does. */
const inRequest = <T>(fn: () => Promise<T>): Promise<T> =>
  new Promise((resolve, reject) => { accountContextMiddleware({} as never, {} as never, () => { fn().then(resolve, reject); }); });

const drain = async (gen: AsyncGenerator<TurnEvent>) => { for await (const ev of gen) void ev; };
const ctxOf = (req: object): ExecutionContext => ({ switchToHttp: () => ({ getRequest: () => req }) }) as unknown as ExecutionContext;

/** Two accounts, Alice (owner) and Bob (invited as member), a shared workspace. */
async function world(opts: { bobRole?: 'member' | 'viewer' } = {}) {
  const db = await testDb();
  const { stub } = memStorage();
  const storage = stub as unknown as StorageService;
  const accounts = new AccountsService(db, accountsCfg());
  const sent: OutboundEmail[] = [];
  accounts.sender = { name: 'fake', send: async (m) => { sent.push(m); } };
  const signUp = async (email: string) => {
    await accounts.requestLink(email);
    return (await accounts.consumeLink(linkToken(sent[sent.length - 1]))).accountId;
  };
  const alice = await signUp('alice@example.com');
  const bob = await signUp('bob@example.com');
  const carol = await signUp('carol@example.com');
  const shared = new SharedService(db, accountsCfg(), accounts);
  shared.sender = { name: 'fake', send: async (m) => { sent.push(m); } };
  const workspaces = new WorkspacesService(db, storage);
  const agents = new AgentsService(db, storage, new TriggerBus(), accounts);
  const repo = new ChatsRepository(db);
  const connections = new ConnectionsService(db, cfg({ googleClientId: 'id', googleClientSecret: 'secret', publicBaseUrl: 'http://localhost:8790' }));
  const memory = new AgentMemoryService(db, storage);

  const ws = await runWithAccount(alice, async () => (await workspaces.list())[0]);
  const { sent: mailed } = await runWithAccount(alice, () => shared.invite(ws.id, { email: 'bob@example.com', role: opts.bobRole ?? 'member' }));
  assert.equal(mailed, true);
  const token = linkToken(sent[sent.length - 1]);
  assert.match(sent[sent.length - 1].subject, /alice invited you/);
  const bobRow = (await accounts.get(bob))!;
  await runWithAccount(bob, () => shared.acceptInvite(token, bobRow));
  const bobViewer: Viewer = { memberAccountId: bob, role: opts.bobRole ?? 'member', workspaceId: ws.id, displayName: 'bob' };
  return { db, storage, accounts, shared, workspaces, agents, repo, connections, memory, alice, bob, carol, ws, bobViewer, sent, signUp };
}

/** A google connection row in `accountId` with the given scopes. */
async function connectionIn(db: Awaited<ReturnType<typeof testDb>>, accountId: string, id: string, email: string, write = false) {
  const scopes = ['https://www.googleapis.com/auth/calendar.readonly', ...(write ? ['https://www.googleapis.com/auth/calendar.events'] : [])];
  await unscoped(db).insert(connections).values({
    accountId, id, provider: 'google', accountEmail: email, scopes: JSON.stringify(scopes),
    accessToken: seal('tok'), refreshToken: seal('ref'), expiresAt: new Date(Date.now() + 3_600_000).toISOString(), createdAt: new Date().toISOString(),
  });
}

const jsonResponse = (body: unknown, status = 200): Response => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response);

// ---- 1. invitations and roles ----

test('invite/accept: a member joins the owner\'s workspace; the wrong address, a used token and single mode are refused', async () => {
  const w = await world();
  const members = await runWithAccount(w.alice, () => w.shared.members(w.ws.id));
  assert.equal(members.length, 1);
  assert.equal(members[0].memberAccountId, w.bob);
  assert.equal(members[0].role, 'member');
  assert.equal(members[0].email, 'bob@example.com');
  // the membership row belongs to Alice's account, not Bob's
  const rows = await unscoped(w.db).select().from(workspaceMembers);
  assert.equal(rows[0].accountId, w.alice);
  // Bob sees it in "shared with me"; Carol does not
  const forBob = await w.shared.sharedWithMe(w.bob);
  assert.equal(forBob.length, 1);
  assert.equal(forBob[0].ownerAccountId, w.alice);
  assert.equal(forBob[0].ownerName, 'alice');
  assert.deepEqual(await w.shared.sharedWithMe(w.carol), []);

  // a second invite to Carol can only be accepted by Carol
  await runWithAccount(w.alice, () => w.shared.invite(w.ws.id, { email: 'carol@example.com', role: 'viewer' }));
  const token = linkToken(w.sent[w.sent.length - 1]);
  await assert.rejects(runWithAccount(w.bob, async () => w.shared.acceptInvite(token!, (await w.accounts.get(w.bob))!)), ForbiddenException);
  await runWithAccount(w.carol, async () => w.shared.acceptInvite(token!, (await w.accounts.get(w.carol))!));
  await assert.rejects(runWithAccount(w.carol, async () => w.shared.acceptInvite(token!, (await w.accounts.get(w.carol))!)), /invalid, used or has expired/);
  assert.equal((await runWithAccount(w.alice, () => w.shared.members(w.ws.id))).length, 2);
  // pending list is empty once accepted; the owner cannot invite themself or an owner role
  assert.deepEqual(await runWithAccount(w.alice, () => w.shared.invites(w.ws.id)), []);
  await assert.rejects(runWithAccount(w.alice, () => w.shared.invite(w.ws.id, { email: 'alice@example.com' })), /your own address/);
  await assert.rejects(runWithAccount(w.alice, () => w.shared.invite(w.ws.id, { email: 'dan@example.com', role: 'owner' as never })), /member or viewer/);

  // single mode: no second account exists, so the feature says so
  const single = new SharedService(w.db, cfg({ authMode: 'single', emailSendProvider: 'off' }), new AccountsService(w.db, cfg({ authMode: 'single' })));
  await assert.rejects(single.invite(w.ws.id, { email: 'x@example.com' }), BadRequestException);
  assert.deepEqual(await single.sharedWithMe('single'), []);
});

test('roles: viewer is read-only (403 on any write); member is refused the owner\'s settings surface; owner passes', () => {
  assert.throws(() => checkRole('viewer', 'POST', '/api/chats/s1/turns'), ForbiddenException);
  assert.doesNotThrow(() => checkRole('viewer', 'GET', '/api/chats/s1/transcript'));
  assert.doesNotThrow(() => checkRole('member', 'POST', '/api/chats/s1/turns'));
  assert.doesNotThrow(() => checkRole('member', 'POST', '/api/agents/a1/tasks'));
  assert.doesNotThrow(() => checkRole('member', 'POST', '/api/workspaces/w1/files'));
  assert.doesNotThrow(() => checkRole('member', 'POST', '/api/workspaces/w1/member-grants'));
  assert.throws(() => checkRole('member', 'PATCH', '/api/workspaces/w1'), ForbiddenException);
  assert.throws(() => checkRole('member', 'POST', '/api/workspaces/w1/invites'), ForbiddenException);
  assert.throws(() => checkRole('member', 'POST', '/api/workspaces/w1/flow-rules'), ForbiddenException);
  assert.throws(() => checkRole('member', 'PATCH', '/api/agents/a1'), ForbiddenException);
  assert.throws(() => checkRole('member', 'POST', '/api/connections/c1/grants'), ForbiddenException);
  assert.throws(() => checkRole('member', 'PUT', '/api/settings'), ForbiddenException);
  assert.throws(() => checkRole('member', 'PATCH', '/api/agents/a1/lessons/l1'), ForbiddenException);
  assert.throws(() => checkRole('member', 'POST', '/api/orgs/o1/members'), ForbiddenException);
  assert.doesNotThrow(() => checkRole('member', 'POST', '/api/orgs/o1/approvals/a1/decide'));
  assert.doesNotThrow(() => checkRole('owner', 'DELETE', '/api/workspaces/w1'));
  assert.equal(isOwnerOnlyRoute('GET', '/api/workspaces/w1/members'), false);
});

test('the access guard: a member\'s request runs under the owner\'s account with a viewer; a stranger gets 403; a stale header is ignored', async () => {
  const w = await world();
  const guard = new WorkspaceAccessGuard(w.shared);
  // Bob, inside a request bound to his own account, naming Alice's workspace
  await inRequest(async () => {
    bindAccount(w.bob);
    const req = { method: 'POST', path: '/api/chats/s1/turns', headers: { 'x-yaam-workspace': w.ws.id }, accountId: w.bob, userId: w.bob };
    assert.equal(await guard.canActivate(ctxOf(req)), true);
    assert.equal(currentAccountId(), w.alice, 'queries now resolve in the owner\'s account');
    assert.equal(actorId(), w.bob, 'but the actor is still Bob');
    assert.equal(currentViewer()?.role, 'member');
    assert.equal((req as { accountId: string }).accountId, w.alice);
  });
  // Bob trying a settings write is refused before anything is rebound
  await inRequest(async () => {
    bindAccount(w.bob);
    const req = { method: 'PATCH', path: `/api/workspaces/${w.ws.id}`, headers: { 'x-yaam-workspace': w.ws.id }, accountId: w.bob, userId: w.bob };
    await assert.rejects(guard.canActivate(ctxOf(req)), ForbiddenException);
    assert.equal(currentAccountId(), w.bob);
  });
  // Carol is nobody here
  await inRequest(async () => {
    bindAccount(w.carol);
    await assert.rejects(guard.canActivate(ctxOf({ method: 'GET', path: '/api/chats', headers: { 'x-yaam-workspace': w.ws.id }, accountId: w.carol, userId: w.carol })), ForbiddenException);
  });
  // Alice in her own workspace: nothing changes, no viewer
  await inRequest(async () => {
    bindAccount(w.alice);
    assert.equal(await guard.canActivate(ctxOf({ method: 'DELETE', path: `/api/workspaces/${w.ws.id}`, headers: { 'x-yaam-workspace': w.ws.id }, accountId: w.alice, userId: w.alice })), true);
    assert.equal(currentViewer(), undefined);
  });
  // an unknown workspace id is a stale client, not a breach
  await inRequest(async () => {
    bindAccount(w.bob);
    assert.equal(await guard.canActivate(ctxOf({ method: 'GET', path: '/api/chats', headers: { 'x-yaam-workspace': 'nope' }, accountId: w.bob, userId: w.bob })), true);
    assert.equal(currentAccountId(), w.bob);
  });
});

test('a member\'s work lands in the owner\'s account and nothing leaks into their own; private sessions stay theirs', async () => {
  const w = await world();
  const agent = await runWithAccount(w.alice, () => w.agents.create({ name: 'Scout' }));
  const chats = new ChatsService(w.repo, w.agents);
  const bobSession = await runWithViewer(w.alice, w.bobViewer, () => chats.create({ workspaceId: w.ws.id, agentId: agent.id, name: 'Bob plans' }));
  assert.equal(bobSession.accountId, w.alice);
  assert.equal(bobSession.initiatedBy, w.bob);
  assert.equal(bobSession.shared, 0);
  const bobsOwn = await unscoped(w.db).select().from(chatSessions).where(eq(chatSessions.accountId, w.bob));
  assert.equal(bobsOwn.length, 0, 'Bob\'s own account has no rows from this');
  const aliceSession = await runWithAccount(w.alice, () => chats.create({ workspaceId: w.ws.id, agentId: agent.id, name: 'Alice private' }));
  // Bob lists only his own and shared sessions; Alice (owner) sees all
  assert.deepEqual((await runWithViewer(w.alice, w.bobViewer, () => chats.list(w.ws.id))).map((s) => s.name), ['Bob plans']);
  await assert.rejects(runWithViewer(w.alice, w.bobViewer, () => chats.get(aliceSession.id)), NotFoundException);
  assert.equal((await runWithAccount(w.alice, () => chats.list(w.ws.id))).length, 2);
  // Alice shares hers; Bob can now read it, but only the creator or owner may flip it
  await runWithAccount(w.alice, () => chats.setShared(aliceSession.id, true));
  assert.equal((await runWithViewer(w.alice, w.bobViewer, () => chats.list(w.ws.id))).length, 2);
  await assert.rejects(runWithViewer(w.alice, w.bobViewer, () => chats.setShared(aliceSession.id, false)), ForbiddenException);
  await runWithViewer(w.alice, w.bobViewer, () => chats.setShared(bobSession.id, true));
  // a user message Bob writes carries his authorship
  const m = await runWithViewer(w.alice, w.bobViewer, () => w.repo.appendMessage({ sessionId: bobSession.id, turnId: 't', role: 'user', content: 'hi' }));
  assert.equal(m.authorAccountId, w.bob);
});

// ---- 2. connections: selection by initiator, routed approvals ----

test('connection selection: the initiator\'s own grant wins, else the agent\'s default; a member cannot grant a connection that is not theirs', async () => {
  const w = await world();
  const agent = await runWithAccount(w.alice, () => w.agents.create({ name: 'Scout' }));
  await connectionIn(w.db, w.alice, 'conn-alice', 'alice@gmail.example', true);
  await connectionIn(w.db, w.bob, 'conn-bob', 'bob@gmail.example');
  await runWithAccount(w.alice, () => w.connections.setGrant('conn-alice', agent.id, 'calendar', 'write'));
  // Bob grants his own connection to the agent, from inside Alice's workspace
  await runWithViewer(w.alice, w.bobViewer, () => w.connections.setGrant('conn-bob', agent.id, 'calendar', 'read', { memberAccountId: w.bob }));
  // …but cannot grant Alice's
  await assert.rejects(runWithViewer(w.alice, w.bobViewer, () => w.connections.setGrant('conn-alice', agent.id, 'calendar', 'read', { memberAccountId: w.bob })), NotFoundException);
  await runWithAccount(w.alice, async () => {
    assert.equal(await w.connections.resolveConnectionOwner(agent.id, 'gcal_upcoming', w.bob), w.bob, 'Bob\'s turn reads Bob\'s calendar');
    assert.equal(await w.connections.resolveConnectionOwner(agent.id, 'gcal_upcoming', w.alice), '', 'Alice\'s turn reads the default (hers)');
    assert.equal(await w.connections.resolveConnectionOwner(agent.id, 'gcal_upcoming', w.carol), '', 'a member without a grant falls back to the default');
    // Bob holds a calendar grant, so calendar tools run on *his* connection
    // in his turns — and his grant is read-only, so the write tool is not
    // offered to him at all: the owner's write grant never fills in for him.
    assert.equal(await w.connections.resolveConnectionOwner(agent.id, 'gcal_create_event', w.bob), w.bob);
    const specsBob = (await w.connections.toolSpecs(agent.id, w.bob)).map((t) => t.name);
    assert.ok(specsBob.includes('gcal_upcoming') && !specsBob.includes('gcal_create_event'));
    const specsAlice = (await w.connections.toolSpecs(agent.id, w.alice)).map((t) => t.name);
    assert.ok(specsAlice.includes('gcal_create_event'));
    const grants = await w.connections.memberGrants();
    assert.equal(grants.length, 1);
    assert.equal(grants[0].memberAccountId, w.bob);
    assert.equal(grants[0].accountEmail, 'bob@gmail.example');
  });
  // Bob's connection fetches run on Bob's token
  w.connections.fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer tok');
    return jsonResponse({ items: [] });
  }) as typeof fetch;
  const out = await runWithViewer(w.alice, w.bobViewer, () => w.connections.execute(agent.id, 'gcal_upcoming', { days: 1 }, { initiator: w.bob }));
  assert.match(out, /No events|events/i);
});

test('approval routing: a mutating call on another member\'s connection pauses for that member alone; others cannot see or answer it; the content comes back wrapped', async () => {
  const w = await world();
  const agent = await runWithAccount(w.alice, () => w.agents.create({ name: 'Scout' }));
  await connectionIn(w.db, w.alice, 'conn-alice', 'alice@gmail.example', true);
  await runWithAccount(w.alice, () => w.connections.setGrant('conn-alice', agent.id, 'calendar', 'write'));
  w.connections.fetchImpl = (async () => jsonResponse({ id: 'ev1', summary: 'Dinner', start: { dateTime: '2026-11-02T19:00:00Z' }, end: { dateTime: '2026-11-02T20:00:00Z' } })) as typeof fetch;
  const call: AiStreamEvent[] = [{ type: 'tool_call', id: 'c1', name: 'gcal_create_event', input: { title: 'Dinner', start: '2026-11-02T19:00:00Z' } }, { type: 'done' }];
  const provider = new ScriptedProvider([call, [{ type: 'answer', text: 'Booked.' }, { type: 'done' }]]);
  const turns = new TurnLoopService(w.repo, new ChatLocks(), new ToolsService(w.storage), ctxStub(provider), skillsStub(), w.storage, mcpStub(), w.agents, w.workspaces,
    w.connections, undefined, undefined, undefined, undefined, undefined, w.accounts, w.shared);
  // Bob starts a shared session in Alice's workspace and asks for an event
  const session = await runWithViewer(w.alice, w.bobViewer, () => w.repo.createSession({ workspaceId: w.ws.id, agentId: agent.id, name: 'Plans', shared: 1 }));
  const events: TurnEvent[] = [];
  const run = runWithViewer(w.alice, w.bobViewer, async () => {
    for await (const ev of turns.run(session.id, { text: 'book dinner' })) {
      events.push(ev);
      if (ev.type === 'approval_required') {
        assert.equal(ev.routedTo?.memberAccountId, w.alice, 'routed to the connection\'s owner');
        assert.equal(ev.routedTo?.name, 'alice');
        // the group (Bob) cannot answer it
        assert.equal(turns.resolveApproval(session.id, ev.callId, 'allow-once', w.bob), false);
        // the inbox: hidden from Bob, visible to Alice
        const forBob = await runWithViewer(w.alice, w.bobViewer, () => w.agents.listEvents(agent.id));
        assert.equal(forBob.filter((e) => e.kind === 'approval_request').length, 0);
        const forAlice = await runWithAccount(w.alice, () => w.agents.listEvents(agent.id));
        const req = forAlice.find((e) => e.kind === 'approval_request')!;
        assert.ok(req, 'Alice has the request');
        assert.equal(req.forMemberAccountId, w.alice);
        assert.match(req.title, /bob asks to run gcal_create_event/);
        // Bob's inbox badge does not count it either
        assert.deepEqual(await runWithViewer(w.alice, w.bobViewer, () => w.agents.unreadEventCounts()), {});
        // Alice decides from her inbox
        const controller = new AgentApprovalsController(w.agents, turns);
        await assert.rejects(runWithViewer(w.alice, w.bobViewer, () => controller.decide(agent.id, req.id, { decision: 'allow' })), NotFoundException);
        const res = await runWithAccount(w.alice, () => controller.decide(agent.id, req.id, { decision: 'allow' }));
        assert.equal(res.resolved, true);
      }
    }
  });
  await run;
  const result = events.find((e) => e.type === 'tool_result') as Extract<TurnEvent, { type: 'tool_result' }>;
  assert.equal(result.isError, false);
  assert.match(result.output, /^<connection-content owner="alice" audience="private">/, 'Alice\'s calendar content is tagged private in Bob\'s session');
  const turn = (await runWithAccount(w.alice, () => w.repo.listTurns(session.id)))[0];
  const records = JSON.parse(turn.toolCalls) as Array<{ usedConnectionOf?: string; approved: string }>;
  assert.equal(records[0].usedConnectionOf, w.alice);
  assert.equal(records[0].approved, 'allow-once');
  const ev = (await unscoped(w.db).select().from(agentEvents)).find((e) => e.forMemberAccountId === w.alice)!;
  assert.equal(ev.kind, 'approval_granted');
  // the owner's own sweep carries an approval addressed to her; a member-addressed one would not
  const deliverable = await runWithAccount(w.alice, () => w.agents.undeliveredEvents());
  assert.ok(deliverable.some((e) => e.id === ev.id));
});

test('approval routing: unanswered within the TTL the call is denied, and a late decision reports it expired', async () => {
  const w = await world();
  const agent = await runWithAccount(w.alice, () => w.agents.create({ name: 'Scout' }));
  await connectionIn(w.db, w.alice, 'conn-alice', 'alice@gmail.example', true);
  await runWithAccount(w.alice, () => w.connections.setGrant('conn-alice', agent.id, 'calendar', 'write'));
  const provider = new ScriptedProvider([[{ type: 'tool_call', id: 'c1', name: 'gcal_create_event', input: { title: 'x', start: '2026-11-02' } }, { type: 'done' }], [{ type: 'answer', text: 'ok' }, { type: 'done' }]]);
  const turns = new TurnLoopService(w.repo, new ChatLocks(), new ToolsService(w.storage), ctxStub(provider), skillsStub(), w.storage, mcpStub(), w.agents, w.workspaces,
    w.connections, undefined, undefined, undefined, undefined, undefined, w.accounts, w.shared);
  turns.approvalTtlMs = 30;
  const session = await runWithViewer(w.alice, w.bobViewer, () => w.repo.createSession({ workspaceId: w.ws.id, agentId: agent.id, name: 'Plans', shared: 1 }));
  const events: TurnEvent[] = [];
  await runWithViewer(w.alice, w.bobViewer, async () => { for await (const ev of turns.run(session.id, { text: 'book' })) events.push(ev); });
  const result = events.find((e) => e.type === 'tool_result') as Extract<TurnEvent, { type: 'tool_result' }>;
  assert.equal(result.isError, true);
  assert.match(result.output, /did not approve/);
  const ev = (await unscoped(w.db).select().from(agentEvents)).find((e) => e.forMemberAccountId === w.alice)!;
  assert.equal(ev.kind, 'approval_denied');
  // a decide after the fact finds nothing to resolve
  await runWithAccount(w.alice, () => w.agents.patchEvent(ev.id, { kind: 'approval_request' })); // simulate a stale inbox view
  const controller = new AgentApprovalsController(w.agents, turns);
  const res = await runWithAccount(w.alice, () => controller.decide(agent.id, ev.id, { decision: 'allow' }));
  assert.equal(res.resolved, false);
  assert.equal((await runWithAccount(w.alice, () => w.agents.getEvent(agent.id, ev.id))).kind, 'approval_expired');
});

// ---- 3. memory: audiences and flow rules ----

test('lesson audiences: the system context injects shared lessons and the initiator\'s own; a flow rule opens another member\'s', async () => {
  const w = await world();
  const agent = await runWithAccount(w.alice, () => w.agents.create({ name: 'Scout' }));
  await runWithAccount(w.alice, async () => {
    await w.memory.record(agent.id, 'Everyone likes short replies.', { source: 'chat' });
    await w.memory.record(agent.id, 'Bob flies from Zurich on Mondays.', { source: 'chat', audience: privateAudience(w.bob) });
    await w.memory.record(agent.id, 'Alice keeps Fridays free.', { source: 'chat', audience: privateAudience(w.alice) });
  });
  assert.equal(visibleTo('shared', 'x'), true);
  assert.equal(visibleTo(privateAudience('b'), 'a'), false);
  assert.equal(visibleTo(privateAudience('b'), 'a', new Set(['b'])), true);
  const factory = { resolve: () => new ScriptedProvider([]), defaultBaseUrl: () => undefined } as unknown as AiProviderFactory;
  const context = new TurnContextService(factory, new AgentTypesService(w.db), w.agents, w.memory, w.workspaces, cfg({ maxToolRounds: 24 }), undefined, w.shared);
  const bobSession = await runWithViewer(w.alice, w.bobViewer, () => w.repo.createSession({ workspaceId: w.ws.id, agentId: agent.id, name: 'b' }));
  const aliceSession = await runWithAccount(w.alice, () => w.repo.createSession({ workspaceId: w.ws.id, agentId: agent.id, name: 'a' }));
  const forBob = (await runWithViewer(w.alice, w.bobViewer, () => context.build(bobSession))).system;
  assert.match(forBob, /short replies/);
  assert.match(forBob, /Zurich/);
  assert.doesNotMatch(forBob, /Fridays free/, 'Alice\'s private lesson never reaches Bob by default');
  const forAlice = (await runWithAccount(w.alice, () => context.build(aliceSession))).system;
  assert.match(forAlice, /Fridays free/);
  assert.doesNotMatch(forAlice, /Zurich/, 'the owner does not see a member\'s private lesson either');
  assert.match(forBob, /private to bob/);
  // the owner opens Bob's lessons to Alice explicitly
  await runWithAccount(w.alice, () => w.shared.addFlowRule(w.ws.id, { fromMember: w.bob, toMember: w.alice, kind: 'lessons' }));
  assert.match((await runWithAccount(w.alice, () => context.build(aliceSession))).system, /Zurich/);
  // a '*' allow with a specific deny
  await runWithAccount(w.alice, async () => {
    await w.shared.addFlowRule(w.ws.id, { fromMember: w.alice, toMember: '*', kind: 'lessons' });
    await w.shared.addFlowRule(w.ws.id, { fromMember: w.alice, toMember: w.bob, kind: 'lessons', effect: 'deny' });
    assert.equal((await w.shared.allowedSources(w.ws.id, w.bob, 'lessons')).has(w.alice), false);
    assert.equal((await w.shared.allowedSources(w.ws.id, w.carol, 'lessons')).has(w.alice), true);
  });
  // the Memory tab flip: owner widens a private lesson to shared
  const bobLesson = (await runWithAccount(w.alice, () => w.memory.list(agent.id))).find((r) => r.text.includes('Zurich'))!;
  await runWithAccount(w.alice, () => w.memory.update(agent.id, bobLesson.id, { audience: 'shared' }));
  assert.match((await runWithAccount(w.alice, () => w.memory.digest(agent.id, { actor: w.carol }))), /Zurich/);
  // the private profile section rides along the same way
  await runWithAccount(w.alice, async () => {
    await w.workspaces.addProfileProposal(w.ws.id, { entry: 'Bob is vegetarian.', audience: privateAudience(w.bob) });
    const pending = JSON.parse((await w.workspaces.get(w.ws.id)).profilePending) as Array<{ id: string }>;
    await assert.rejects(runWithViewer(w.alice, { ...w.bobViewer, memberAccountId: w.carol }, () => w.workspaces.resolveProfileProposal(w.ws.id, pending[0].id, true)), ForbiddenException);
    await runWithViewer(w.alice, w.bobViewer, () => w.workspaces.resolveProfileProposal(w.ws.id, pending[0].id, true));
    const ws = await w.workspaces.get(w.ws.id);
    assert.equal(ws.profile, '');
    assert.match(w.workspaces.profileFor(ws, w.bob), /vegetarian/);
    assert.equal(w.workspaces.profileFor(ws, w.alice), '');
  });
});

test('distillation audience: connection content makes the lesson its owner\'s; a private session makes it the initiator\'s; no members means shared', () => {
  const owner = 'alice';
  assert.equal(audienceForSession({ initiatedBy: 'bob', shared: 1 }, [], { hasMembers: false, ownerActor: owner }), 'shared');
  assert.equal(audienceForSession({ initiatedBy: 'bob', shared: 1 }, [], { hasMembers: true, ownerActor: owner }), 'shared');
  assert.equal(audienceForSession({ initiatedBy: 'bob', shared: 0 }, [], { hasMembers: true, ownerActor: owner }), privateAudience('bob'));
  assert.equal(audienceForSession({ initiatedBy: '', shared: 0 }, [], { hasMembers: true, ownerActor: owner }), privateAudience('alice'));
  assert.equal(audienceForSession({ initiatedBy: 'bob', shared: 1 }, ['alice'], { hasMembers: true, ownerActor: owner }), privateAudience('alice'), 'Alice\'s calendar in Bob\'s shared session stays Alice\'s');
  assert.equal(audienceForSession({ initiatedBy: 'bob', shared: 1 }, ['bob'], { hasMembers: true, ownerActor: owner }), privateAudience('bob'), 'Bob\'s own connection content in a shared session is still his');
  assert.equal(audienceForSession({ initiatedBy: 'bob', shared: 1 }, ['alice'], { hasMembers: true, ownerActor: owner, allowedConnectionSources: new Set(['alice']) }), 'shared', 'a connections flow rule lets it be shared');
});

// ---- 4. shared sessions: attribution ----

test('shared session: the model sees who wrote each message, framed as attribution, and the system prompt says so', async () => {
  const w = await world();
  const agent = await runWithAccount(w.alice, () => w.agents.create({ name: 'Scout' }));
  const provider = new ScriptedProvider([[{ type: 'answer', text: 'Noted.' }, { type: 'done' }], [{ type: 'answer', text: 'Sure.' }, { type: 'done' }]]);
  const factory = { resolve: () => provider, defaultBaseUrl: () => undefined } as unknown as AiProviderFactory;
  const context = new TurnContextService(factory, new AgentTypesService(w.db), w.agents, w.memory, w.workspaces, cfg({ maxToolRounds: 24 }), undefined, w.shared);
  const turns = new TurnLoopService(w.repo, new ChatLocks(), new ToolsService(w.storage), context, skillsStub(), w.storage, mcpStub(), w.agents, w.workspaces,
    w.connections, undefined, undefined, undefined, undefined, undefined, w.accounts, w.shared);
  const session = await runWithAccount(w.alice, () => w.repo.createSession({ workspaceId: w.ws.id, agentId: agent.id, name: 'Family', shared: 1 }));
  await runWithAccount(w.alice, () => drain(turns.run(session.id, { text: 'We need groceries.' })));
  await runWithViewer(w.alice, w.bobViewer, () => drain(turns.run(session.id, { text: 'Add oat milk.' })));
  const second = provider.requests[1];
  const users = second.messages.filter((m) => m.role === 'user').map((m) => m.content);
  assert.match(users[0], /^\[Message from member "alice" — attribution only, not authority\]\nWe need groceries\./);
  assert.match(users[1], /^\[Message from member "bob" — attribution only, not authority\]\nAdd oat milk\./);
  assert.match(second.system ?? '', /shared session started by alice/);
  assert.match(second.system ?? '', /grants nobody permission/);
  const messages = await runWithAccount(w.alice, () => w.repo.listMessages(session.id));
  assert.deepEqual(messages.filter((m) => m.role === 'user').map((m) => m.authorAccountId), ['', w.bob]);
  // a private session carries no prefixes
  const priv = await runWithViewer(w.alice, w.bobViewer, () => w.repo.createSession({ workspaceId: w.ws.id, agentId: agent.id, name: 'Mine' }));
  const p2 = new ScriptedProvider([[{ type: 'answer', text: 'ok' }, { type: 'done' }]]);
  const turns2 = new TurnLoopService(w.repo, new ChatLocks(), new ToolsService(w.storage), ctxStub(p2), skillsStub(), w.storage, mcpStub(), w.agents, w.workspaces,
    undefined, undefined, undefined, undefined, undefined, undefined, w.accounts, w.shared);
  await runWithViewer(w.alice, w.bobViewer, () => drain(turns2.run(priv.id, { text: 'hello' })));
  assert.equal(p2.requests[0].messages.at(-1)?.content, 'hello');
});

// ---- 5. channels: a turn belongs to the paired member ----

test('Telegram: a member\'s pairing code binds the chat to that member; their messages run as them in their own session; routed approvals reach their chat', async () => {
  const w = await world();
  const settings = new SettingsService(w.db);
  const agent = await runWithAccount(w.alice, () => w.agents.create({ name: 'Scout' }));
  await runWithAccount(w.alice, () => settings.put({ telegramDefaultAgentId: agent.id }));
  const provider = new ScriptedProvider([[{ type: 'answer', text: 'Hi Bob.' }, { type: 'done' }]]);
  const turns = new TurnLoopService(w.repo, new ChatLocks(), new ToolsService(w.storage), ctxStub(provider), skillsStub(), w.storage, mcpStub(), w.agents, w.workspaces,
    undefined, undefined, undefined, undefined, undefined, undefined, w.accounts, w.shared);
  const sentTg: Array<{ chat_id: number; text: string }> = [];
  const tg = new TelegramService(cfg({ telegramBotToken: 't', publicAppUrl: 'https://app.example' }), settings, w.agents, w.workspaces, w.repo, turns, w.accounts, w.shared);
  tg.fetchFn = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { chat_id: number; text: string };
    sentTg.push(body);
    return jsonResponse({ ok: true, result: [] });
  }) as typeof fetch;
  const msg = (chatId: number, text: string) => ({ update_id: 1, message: { chat: { id: chatId }, text } });
  // Bob mints a code while acting in Alice's workspace
  const { code, member } = await runWithViewer(w.alice, w.bobViewer, async () => tg.mintPairCode());
  assert.equal(member, true);
  await tg.handleUpdate(msg(777, `/pair ${code}`));
  assert.match(sentTg.at(-1)!.text, /Paired as bob/);
  const channels = await runWithAccount(w.alice, () => w.shared.channels(w.ws.id, w.bob));
  assert.equal(channels[0].address, '777');
  // the owner's settings never learned this chat id
  assert.equal((await runWithAccount(w.alice, () => settings.all())).telegramChatId, undefined);
  // Bob's message runs as Bob
  await tg.handleUpdate(msg(777, 'hello'));
  assert.equal(sentTg.at(-1)!.text, 'Hi Bob.');
  const sessions = await runWithAccount(w.alice, () => w.repo.listSessions(w.ws.id));
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].name, 'Telegram · Scout · bob');
  assert.equal(sessions[0].initiatedBy, w.bob);
  assert.equal(sessions[0].accountId, w.alice);
  // an approval addressed to Bob is pushed to Bob's chat by the sweep, not to the owner (who has no chat paired)
  await runWithAccount(w.alice, () => w.agents.addEvent(agent.id, { kind: 'approval_request', title: 'alice asks to run gcal_create_event with your connection', sessionId: sessions[0].id, forMemberAccountId: w.bob, channel: true }));
  const delivered = await tg.deliverSweep();
  assert.equal(delivered, 1);
  assert.equal(sentTg.at(-1)!.chat_id, 777);
  assert.match(sentTg.at(-1)!.text, /Allow or deny from your inbox/);
  // Bob's own push sweep (in his account) would see the same event
  const addressed = await w.shared.addressedEvents(w.bob, 'pushDeliveredAt');
  assert.equal(addressed.length, 1);
});

// ---- 6. the company with more than one human (phase D) ----

test('org humans: a board member approves a hire but not a scope widen; an observer decides nothing; the audit row and the approval name the human', async () => {
  const w = await world();
  const bus = new TriggerBus();
  const audit = new OrgAuditService(w.db);
  const org = new OrgService(w.db, w.agents, audit);
  const tasks = new OrgTasksService(w.db, org, audit, bus);
  const approvals = new OrgApprovalsService(w.db, org, tasks, w.agents, audit, undefined, bus);
  const brief = new OrgBriefService(w.db, org, tasks, approvals, audit, w.agents, w.workspaces);
  const provider = new ScriptedProvider([]);
  const turns = new TurnLoopService(w.repo, new ChatLocks(), new ToolsService(w.storage), ctxStub(provider), skillsStub(), w.storage, mcpStub(), w.agents, w.workspaces);
  const runtime = new OrgRuntimeService(w.db, org, tasks, approvals, audit, brief, turns, w.repo, w.agents, w.workspaces, accountsCfg(), bus);
  const controller = new OrgController(org, tasks, approvals, audit, brief, runtime, accountsCfg());
  const carolViewer: Viewer = { memberAccountId: w.carol, role: 'member', workspaceId: w.ws.id, displayName: 'carol' };

  const o = await runWithAccount(w.alice, () => org.create({ workspaceId: w.ws.id, name: 'Acme', mission: 'Ship.', chief: { name: 'Chief', charter: 'You run Acme.' } }));
  await runWithAccount(w.alice, async () => {
    await controller.setHuman(o.id, { memberAccountId: w.bob, role: 'board' });
    await controller.setHuman(o.id, { memberAccountId: w.carol, role: 'observer' });
    assert.equal(await org.humanRole(o.id, w.alice), 'ceo');
    assert.equal(await org.humanRole(o.id, w.bob), 'board');
    assert.equal(await org.humanRole(o.id, 'stranger'), null);
  });
  assert.equal(mayDecide('board', 'hire'), true);
  assert.equal(mayDecide('board', 'scope_widen'), false);
  assert.equal(mayDecide('observer', 'hire'), false);

  const hire = await runWithAccount(w.alice, () => approvals.proposeHire(o.id, { templateOrPack: 'Writer', charter: 'You write.', requestedBy: 'chief', scopes: ['tool:fs_read'] }));
  const widen = await runWithAccount(w.alice, () => approvals.create(o.id, { kind: 'scope_widen', payload: { agentId: o.chiefOfStaffAgentId, scopes: ['tool:fs_read', 'tool:run_code'] }, requestedBy: 'chief' }));
  // the observer may read the humans list but decide nothing
  const seen = await runWithViewer(w.alice, carolViewer, () => controller.humans(o.id));
  assert.equal(seen.me.role, 'observer');
  await assert.rejects(runWithViewer(w.alice, carolViewer, () => controller.decide(o.id, hire.id, { decision: 'approve' })), ForbiddenException);
  // the board member may hire, not widen
  await assert.rejects(runWithViewer(w.alice, w.bobViewer, () => controller.decide(o.id, widen.id, { decision: 'approve' })), /CEO's/);
  const { approval, result } = await runWithViewer(w.alice, w.bobViewer, () => controller.decide(o.id, hire.id, { decision: 'approve', note: 'go' }));
  assert.equal(approval.status, 'approved');
  assert.equal(approval.decidedBy, w.bob);
  assert.ok(result?.agentId);
  const rows = await unscoped(w.db).select().from(orgAudit).where(eq(orgAudit.orgId, o.id));
  const decided = rows.find((r) => r.action === 'approval_approved')!;
  assert.equal(decided.actor, `human:${w.bob}`);
  assert.equal((JSON.parse(decided.payload) as { decidedBy: string }).decidedBy, w.bob);
  // the CEO decides as 'user' with her own id recorded
  const r2 = await runWithAccount(w.alice, () => controller.decide(o.id, widen.id, { decision: 'reject' }));
  assert.equal(r2.approval.decidedBy, w.alice);
  // the brief goes to the CEO and, as an addressed copy, to the board
  const composed = await runWithAccount(w.alice, () => brief.compose(o.id, { deliver: true }));
  assert.ok(composed.text.includes('Acme'));
  const briefs = (await unscoped(w.db).select().from(agentEvents)).filter((e) => e.kind === 'brief');
  assert.deepEqual(briefs.map((e) => e.forMemberAccountId).sort(), ['', w.bob].sort());
  assert.equal((await runWithAccount(w.alice, () => audit.verify(o.id))).ok, true);
});

test('an approval addressed to the owner (empty addressee, as channel turns store it) can be answered by the owner; a stale one expires instead of 404', async () => {
  const w = await world();
  const turns = { resolveApproval: () => false } as unknown as ConstructorParameters<typeof AgentApprovalsController>[1];
  const agent = await runWithAccount(w.alice, () => w.agents.create({ name: 'Scout' }));
  const ev = await runWithAccount(w.alice, () => w.agents.addEvent(agent.id, { kind: 'approval_request', title: 'Scout asks to run fs_write in #company', sessionId: 'sess-gone', payload: JSON.stringify({ callId: 'call-1' }), forMemberAccountId: '' }));
  const controller = new AgentApprovalsController(w.agents, turns);
  const res = await runWithAccount(w.alice, () => controller.decide(agent.id, ev.id, { decision: 'allow' }));
  assert.equal(res.resolved, false, 'the turn that asked is gone');
  assert.equal((await runWithAccount(w.alice, () => w.agents.getEvent(agent.id, ev.id))).kind, 'approval_expired');
});
