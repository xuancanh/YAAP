/**
 * Tenancy and accounts (docs/accounts.md, execution-plan item 7): every table
 * carries accountId; two accounts never see each other's rows; the magic-link
 * flow, its rate limit, plan caps (402), the hosted ceiling, and background
 * sweeps that run under the owning account.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { HttpException, NotFoundException, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import * as schema from '../server/src/database/schema';
import { runPgMigrations } from '../server/src/database/migrator';
import { pgliteQueryable, testDb, memStorage, ctxStub, skillsStub, mcpStub, ScriptedProvider } from './helpers';
import { SINGLE_ACCOUNT, accountContextMiddleware, currentAccountId, runWithAccount } from '../server/src/accounts/account-context';
import { UNSCOPED_TABLES, unscoped } from '../server/src/accounts/scoped-db';
import { AccountsService, LINK_LIMIT_PER_EMAIL, PlanLimitException } from '../server/src/accounts/accounts.service';
import { SessionAuthStrategy } from '../server/src/accounts/session-auth.strategy';
import { signSuiteJwt, SuiteJwtStrategy, verifySuiteJwt } from '../server/src/accounts/suite-jwt.strategy';
import { AuthGuard } from '../server/src/common/auth.guard';
import { TokenAuthStrategy } from '../server/src/common/token-auth.strategy';
import { AgentsService } from '../server/src/agents/agents.service';
import { AgentMemoryService } from '../server/src/agents/agent-memory.service';
import { AgentTypesService } from '../server/src/agent-types/agent-types.service';
import { WorkspacesService } from '../server/src/workspaces/workspaces.service';
import { SkillsService } from '../server/src/skills/skills.service';
import { SettingsService } from '../server/src/settings/settings.module';
import { ChatsRepository } from '../server/src/chats/chats.repository';
import { TurnLoopService } from '../server/src/chats/turn-loop.service';
import { TurnContextService } from '../server/src/chats/turn-context.service';
import { ChatLocks } from '../server/src/chats/chat-locks';
import { ToolsService } from '../server/src/chats/tools.service';
import { LoopsService } from '../server/src/chats/loops.service';
import { DistillService } from '../server/src/chats/distill.service';
import { AiProviderFactory } from '../server/src/ai/providers.factory';
import type { StorageService } from '../server/src/storage/storage.service';
import type { OutboundEmail } from '../server/src/channels/email-sender';
import type { AiStreamEvent } from '../server/src/ai/ai-provider.interface';

const ADOPT = 'add `...accountScoped(),` (from server/src/accounts/account-context.ts) to its pgTable columns in server/src/database/schema.ts; the migrator\'s ensureAccountColumns() adds the DB column and index on boot, nothing else is needed';

const cfg = (values: Record<string, unknown>): ConfigService =>
  ({ get: (k: string) => values[k] }) as unknown as ConfigService;

const accountsCfg = (extra: Record<string, unknown> = {}) => cfg({
  authMode: 'accounts', accountsDefaultPlan: 'free', emailSendProvider: 'off',
  publicBaseUrl: 'https://api.example', publicAppUrl: 'https://app.example', emailDomain: 'agents.example',
  hostedPlanUsd: 15, platformKeys: {}, adminEmails: 'root@example.com', ...extra,
});

function fakeSender(accounts: AccountsService) {
  const sent: OutboundEmail[] = [];
  accounts.sender = { name: 'fake', send: async (m) => { sent.push(m); } };
  return sent;
}

const linkToken = (mail: OutboundEmail) => new URL(/https:\/\/\S+/.exec(mail.text)![0]).searchParams.get('token')!;

/** Sign a fresh account in and return its id. */
async function signUp(accounts: AccountsService, sent: OutboundEmail[], email: string): Promise<string> {
  await accounts.requestLink(email);
  const { accountId } = await accounts.consumeLink(linkToken(sent[sent.length - 1]));
  return accountId;
}

// ---- 1. schema reflection ----

test('every Drizzle table carries accountId (the one-line adoption rule)', () => {
  const tables = Object.entries(schema).filter((e): e is [string, PgTable] => is(e[1], PgTable));
  assert.ok(tables.length >= 20, 'schema exports its tables');
  for (const [exportName, table] of tables) {
    const name = getTableName(table);
    if (name === 'accounts') continue; // its id *is* the account
    const col = getTableColumns(table).accountId;
    assert.ok(col, `table "${name}" (schema export \`${exportName}\`) has no accountId column — ${ADOPT}`);
    assert.equal(col.name, 'accountId', `table "${name}": the column must be named accountId — ${ADOPT}`);
    if (!UNSCOPED_TABLES.has(name)) {
      assert.equal(col.notNull, true, `table "${name}": accountId must be NOT NULL — ${ADOPT}`);
      assert.equal(col.default, SINGLE_ACCOUNT, `table "${name}": accountId must default to '${SINGLE_ACCOUNT}' so pre-tenancy rows backfill — ${ADOPT}`);
    }
  }
});

test('after migrations every database table has the accountId column, an index on it, and the single account exists', async () => {
  const pg = new PGlite();
  const q = pgliteQueryable(pg);
  await runPgMigrations(q, { log: () => {} });
  const tables = (await q.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`)).rows as Array<{ table_name: string }>;
  for (const { table_name } of tables) {
    if (table_name === '__migrations' || table_name === 'accounts') continue;
    const col = await q.query(`SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = 'accountId'`, [table_name]);
    assert.equal(col.rows.length, 1, `database table "${table_name}" lacks "accountId" — ensureAccountColumns() should have added it; check it runs after your migration`);
    const idx = await q.query(`SELECT 1 FROM pg_indexes WHERE tablename = $1 AND indexdef ILIKE '%"accountId"%'`, [table_name]);
    assert.ok(idx.rows.length >= 1, `database table "${table_name}" has no index on accountId`);
  }
  const single = await q.query(`SELECT "plan", "status" FROM accounts WHERE "id" = $1`, [SINGLE_ACCOUNT]);
  assert.deepEqual(single.rows, [{ plan: 'byo', status: 'active' }]);
  // a table created by a later migration on another branch is fenced on the next boot
  await q.query(`CREATE TABLE org_widgets ("id" TEXT PRIMARY KEY, "createdAt" TEXT NOT NULL)`);
  await runPgMigrations(q, { log: () => {} });
  const fenced = await q.query(`SELECT column_default FROM information_schema.columns WHERE table_name = 'org_widgets' AND column_name = 'accountId'`);
  assert.equal(fenced.rows.length, 1, 'the boot sweep adds accountId to tables it has never seen');
  await pg.close();
});

// ---- 2. isolation ----

test('two accounts are isolated across workspaces, agents, chats, skills, connections, mcp servers, events, lessons, settings and usage', async () => {
  const db = await testDb();
  const { stub } = memStorage();
  const storage = stub as unknown as StorageService;
  const accounts = new AccountsService(db, accountsCfg());
  const sent = fakeSender(accounts);
  const workspaces = new WorkspacesService(db, storage);
  const agents = new AgentsService(db, storage, undefined, accounts);
  const repo = new ChatsRepository(db);
  const skills = new SkillsService(db, accounts);
  const settings = new SettingsService(db);
  const memory = new AgentMemoryService(db, storage);
  const types = new AgentTypesService(db);

  const a = await signUp(accounts, sent, 'alice@example.com');
  const b = await signUp(accounts, sent, 'bob@example.com');
  assert.notEqual(a, b);

  // Alice builds a world
  const mine = await runWithAccount(a, async () => {
    const ws = (await workspaces.list())[0];
    const agent = await agents.create({ name: 'Scout' });
    const session = await repo.createSession({ workspaceId: ws.id, agentId: agent.id, name: 'Plans' });
    await repo.appendMessage({ sessionId: session.id, turnId: 't', role: 'user', content: 'hello' });
    const skill = await skills.create({ name: 'alice-only', instructions: 'x' });
    const type = await types.create({ name: 'Claude', provider: 'anthropic', model: 'claude-sonnet-4-5', apiKey: 'sk-alice' });
    await db.insert(schema.connections).values({ id: 'conn-a', provider: 'google', accountEmail: 'alice@gmail.com', scopes: '[]', accessToken: '', refreshToken: '', expiresAt: '', createdAt: 'now' });
    await db.insert(schema.mcpServers).values({ id: 'mcp-a', name: 'tools', url: 'https://mcp.example', createdAt: 'now' });
    await agents.addEvent(agent.id, { kind: 'info', title: 'alice event' });
    await memory.record(agent.id, 'Alice prefers mornings.', { source: 'chat' });
    await settings.put({ theme: 'alice-dark', telegramChatId: '111' });
    await accounts.recordUsage({ model: 'claude-sonnet-4-5', tokensIn: 1000, tokensOut: 1000, hosted: false });
    return { ws, agent, session, skill, type };
  });

  // Bob sees none of it, and cannot reach it by id
  await runWithAccount(b, async () => {
    const ws = await workspaces.list();
    assert.equal(ws.length, 1);
    assert.notEqual(ws[0].id, mine.ws.id, 'Bob gets his own default workspace');
    assert.deepEqual(await agents.list(), []);
    await assert.rejects(agents.get(mine.agent.id), NotFoundException);
    assert.deepEqual(await repo.listSessions(mine.ws.id), []);
    assert.equal(await repo.getSession(mine.session.id), undefined);
    assert.deepEqual(await repo.listMessages(mine.session.id), []);
    assert.equal((await skills.list()).some((s) => s.name === 'alice-only'), false);
    assert.ok((await skills.list()).some((s) => s.builtin === 1), 'Bob has his own seeded built-ins');
    await assert.rejects(skills.get(mine.skill.id), NotFoundException);
    assert.deepEqual(await types.list(), []);
    assert.equal(await types.resolve(mine.type.id), undefined);
    assert.deepEqual(await db.select().from(schema.connections), []);
    assert.deepEqual(await db.select().from(schema.mcpServers), []);
    assert.deepEqual(await agents.listEvents(mine.agent.id), []);
    assert.deepEqual(await agents.unreadEventCounts(), {});
    assert.deepEqual(await memory.list(mine.agent.id), []);
    assert.deepEqual(await settings.all(), {});
    assert.equal((await accounts.usageThisMonth()).tokensIn, 0);
    // writes by id against Alice's rows change nothing
    await assert.rejects(agents.update(mine.agent.id, { name: 'hijacked' }), NotFoundException);
    await repo.updateSession(mine.session.id, { name: 'hijacked' });
    await repo.deleteSession(mine.session.id);
    await types.remove(mine.type.id);
  });

  // Alice's world is intact and hers alone
  await runWithAccount(a, async () => {
    assert.equal((await agents.get(mine.agent.id)).name, 'Scout');
    assert.equal((await repo.getSession(mine.session.id))?.name, 'Plans');
    assert.equal((await repo.listMessages(mine.session.id)).length, 1);
    assert.equal((await types.list()).length, 1);
    assert.equal((await settings.all()).theme, 'alice-dark');
    assert.equal((await memory.list(mine.agent.id)).length, 1);
    assert.equal((await accounts.usageThisMonth()).tokensIn, 1000);
    // the cross-account resolvers find Alice by her paired chat and her agent
    assert.equal(await accounts.findAccountIdBySetting('telegramChatId', '111'), a);
    assert.equal(await accounts.accountOfAgent(mine.agent.id), a);
  });
  // raw rows carry the owner
  const rows = await unscoped(db).select({ accountId: schema.agents.accountId }).from(schema.agents);
  assert.deepEqual(rows, [{ accountId: a }]);
  // the single account (no context) sees nothing of either
  assert.deepEqual(await agents.list(), []);
  assert.equal(currentAccountId(), SINGLE_ACCOUNT);
});

// ---- 3. magic link, sessions, rate limit ----

test('magic link: request → mail → callback mints a session; links are one-use and expire; logout revokes', async () => {
  const db = await testDb();
  const accounts = new AccountsService(db, accountsCfg());
  const sent = fakeSender(accounts);
  const now = new Date('2026-11-01T10:00:00Z');

  const res = await accounts.requestLink('  Carol@Example.com ', { ip: '10.0.0.1' }, now);
  assert.deepEqual(res, { ok: true, sent: true });
  assert.equal(sent[0].to, 'carol@example.com');
  assert.equal(sent[0].from.address, 'login@agents.example');
  assert.match(sent[0].text, /https:\/\/api\.example\/api\/auth\/callback\?token=/);
  const pending = await accounts.findByEmail('carol@example.com');
  assert.equal(pending?.status, 'pending');
  assert.equal(pending?.plan, 'free');

  const token = linkToken(sent[0]);
  const session = await accounts.consumeLink(token, 'Mozilla/5.0', now);
  assert.equal(session.accountId, pending!.id);
  assert.equal((await accounts.get(pending!.id))?.status, 'active');
  await assert.rejects(accounts.consumeLink(token, '', now), UnauthorizedException, 'one use only');

  const who = await accounts.resolveSession(session.sessionToken, now);
  assert.equal(who?.email, 'carol@example.com');
  assert.equal(await accounts.resolveSession('nope', now), null);
  assert.equal(await accounts.resolveSession(session.sessionToken, new Date(now.getTime() + 31 * 86_400_000)), null, 'sessions expire after 30 days');

  // expiry of the link itself
  await accounts.requestLink('carol@example.com', {}, now);
  await assert.rejects(accounts.consumeLink(linkToken(sent[1]), '', new Date(now.getTime() + 16 * 60_000)), UnauthorizedException);

  await accounts.revokeSession(session.sessionToken);
  assert.equal(await accounts.resolveSession(session.sessionToken, now), null);

  await assert.rejects(accounts.requestLink('not-an-email', {}, now), (e: HttpException) => e.getStatus() === 400);
  // single mode has no sign-in
  await assert.rejects(new AccountsService(db, cfg({ authMode: 'single' })).requestLink('x@example.com'), (e: HttpException) => e.getStatus() === 403);
});

test('link requests are rate-limited per address (429) and the mail says nothing about whether the account exists', async () => {
  const db = await testDb();
  const accounts = new AccountsService(db, accountsCfg());
  const sent = fakeSender(accounts);
  const now = new Date('2026-11-01T10:00:00Z');
  for (let i = 0; i < LINK_LIMIT_PER_EMAIL; i++) await accounts.requestLink('dan@example.com', {}, now);
  await assert.rejects(accounts.requestLink('dan@example.com', {}, now), (e: HttpException) => e.getStatus() === 429);
  // the window slides
  await accounts.requestLink('dan@example.com', {}, new Date(now.getTime() + 16 * 60_000));
  assert.equal(sent.length, LINK_LIMIT_PER_EMAIL + 1);
  assert.equal(sent[0].subject, sent[LINK_LIMIT_PER_EMAIL].subject);
});

test('EMAIL_SEND_PROVIDER=off: the link is logged, not mailed, and the response says so', async () => {
  const db = await testDb();
  const accounts = new AccountsService(db, accountsCfg());
  assert.equal(accounts.sender.name, 'off');
  assert.deepEqual(await accounts.requestLink('eve@example.com'), { ok: true, sent: false });
});

// ---- 4. guard + strategies ----

const ctxOf = (req: object): ExecutionContext => ({ switchToHttp: () => ({ getRequest: () => req }) }) as unknown as ExecutionContext;

/** Run `fn` inside a request-shaped context, the way bootstrap's middleware does. */
const inRequest = <T>(fn: () => Promise<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    accountContextMiddleware({} as never, {} as never, () => { fn().then(resolve, reject); });
  });

test('SessionAuthStrategy: the cookie names the account and the guard binds it as the query scope', async () => {
  const db = await testDb();
  const accounts = new AccountsService(db, accountsCfg());
  const sent = fakeSender(accounts);
  const id = await signUp(accounts, sent, 'fay@example.com');
  const { sessionToken } = await accounts.consumeLink(linkToken((await accounts.requestLink('fay@example.com'), sent[sent.length - 1])));
  const guard = new AuthGuard(new SessionAuthStrategy(accounts, accountsCfg({ apiToken: 'ops' })));

  const req = { method: 'GET', path: '/api/agents', headers: { cookie: `theme=dark; yaam_session=${encodeURIComponent(sessionToken)}` } } as Record<string, unknown>;
  const scoped = await inRequest(async () => {
    assert.equal(await guard.canActivate(ctxOf(req)), true);
    return currentAccountId();
  });
  assert.equal(req.userId, id);
  assert.equal(req.accountId, id);
  assert.equal(scoped, id, 'the request context is bound to the account');

  await assert.rejects(guard.canActivate(ctxOf({ method: 'GET', path: '/api/agents', headers: {} })) as Promise<boolean>, UnauthorizedException);
  // the operator bearer still works, in the single account
  const ops = { method: 'GET', path: '/api/agents', headers: { authorization: 'Bearer ops' } } as Record<string, unknown>;
  await guard.canActivate(ctxOf(ops));
  assert.equal(ops.accountId, SINGLE_ACCOUNT);
  // the sign-in routes are public for every strategy
  for (const [method, path] of [['POST', '/api/auth/request-link'], ['GET', '/api/auth/callback'], ['GET', '/api/auth/me'], ['POST', '/api/auth/logout']]) {
    assert.equal(await guard.canActivate(ctxOf({ method, path, headers: {} })), true, `${method} ${path}`);
    assert.equal(new AuthGuard(new TokenAuthStrategy(cfg({ apiToken: 'x' }))).canActivate(ctxOf({ method, path, headers: {} })), true);
  }
});

test('the single-user strategy binds the single account', async () => {
  const guard = new AuthGuard(new TokenAuthStrategy(cfg({ apiToken: '' })));
  const req = { method: 'GET', path: '/api/agents', headers: {} } as Record<string, unknown>;
  const scoped = await inRequest(async () => { guard.canActivate(ctxOf(req)); return currentAccountId(); });
  assert.equal(req.accountId, SINGLE_ACCOUNT);
  assert.equal(scoped, SINGLE_ACCOUNT);
});

test('SuiteJwtStrategy (experimental): verifies HS256, rejects forgeries and expiry, creates the account on first sight', async () => {
  const db = await testDb();
  const accounts = new AccountsService(db, accountsCfg());
  const strategy = new SuiteJwtStrategy(accounts, accountsCfg({ suiteAccountsUrl: 'https://accounts.example', suiteAccountsSecret: 's3cret' }));
  const exp = Math.floor(Date.now() / 1000) + 600;
  const good = signSuiteJwt({ sub: 'acct-77', email: 'gus@example.com', exp }, 's3cret');
  assert.equal(verifySuiteJwt(good, 's3cret').sub, 'acct-77');
  assert.throws(() => verifySuiteJwt(good, 'other'), UnauthorizedException);
  assert.throws(() => verifySuiteJwt(signSuiteJwt({ sub: 'x', email: 'x@y.zz', exp: exp - 1200 }, 's3cret'), 's3cret'), UnauthorizedException);
  assert.throws(() => verifySuiteJwt(good.replace(/\.[^.]+$/, '.AAAA'), 's3cret'), UnauthorizedException);

  const id = await strategy.authenticate({ headers: { authorization: `Bearer ${good}` } } as never);
  assert.equal(id, 'acct-77');
  assert.equal((await accounts.get('acct-77'))?.email, 'gus@example.com');
  await assert.rejects(strategy.authenticate({ headers: {} } as never), UnauthorizedException);
});

// ---- 5. plans ----

test('plan caps: free = 3 agents and 3 enabled loops (402 with the reason); byo and hosted uncapped', async () => {
  const db = await testDb();
  const { stub } = memStorage();
  const accounts = new AccountsService(db, accountsCfg());
  const sent = fakeSender(accounts);
  const agents = new AgentsService(db, stub as unknown as StorageService, undefined, accounts);
  const id = await signUp(accounts, sent, 'hal@example.com');

  await runWithAccount(id, async () => {
    for (const n of ['a', 'b', 'c']) await agents.create({ name: n });
    await assert.rejects(agents.create({ name: 'd' }), (e: PlanLimitException) => e.getStatus() === 402 && /3 agents/.test(e.message));
    const [first] = await agents.list();
    const loops = (n: number, enabled = true) => JSON.stringify(Array.from({ length: n }, (_, i) => ({ name: `l${i}`, cron: '0 9 * * *', enabled })));
    await agents.update(first.id, { loops: loops(3) });
    await assert.rejects(agents.update(first.id, { loops: loops(4) }), (e: PlanLimitException) => e.getStatus() === 402 && /3 enabled loops/.test(e.message));
    const second = (await agents.list())[1];
    await assert.rejects(agents.update(second.id, { loops: loops(1) }), PlanLimitException, 'the cap spans every agent');
    await agents.update(first.id, { loops: loops(4, false) }); // paused loops do not count
    await agents.update(second.id, { loops: loops(1) });
  });

  await accounts.setPlan(id, 'byo', 'root@example.com');
  await runWithAccount(id, async () => {
    await agents.create({ name: 'd' });
    assert.equal((await agents.list()).length, 4);
  });
  await assert.rejects(accounts.setPlan(id, 'gold', 'root@example.com'), (e: HttpException) => e.getStatus() === 400);
  assert.equal(accounts.isAdmin({ id, email: 'hal@example.com' }), false);
  assert.equal(accounts.isAdmin({ id: 'r', email: 'ROOT@example.com' }), true);
  assert.equal(new AccountsService(db, cfg({ authMode: 'single' })).isAdmin({ id: SINGLE_ACCOUNT, email: '' }), true, 'single mode: the user is the admin');
});

test('keys and ceilings: own key always; free/byo without a key → 402; hosted spends the platform key until the monthly ceiling, then hard-stops', async () => {
  const db = await testDb();
  const accounts = new AccountsService(db, accountsCfg({ hostedPlanUsd: 1, platformKeys: { anthropic: 'sk-platform' } }));
  const sent = fakeSender(accounts);
  const id = await signUp(accounts, sent, 'ivy@example.com');

  await runWithAccount(id, async () => {
    assert.deepEqual(await accounts.resolveProviderKey('anthropic', 'sk-own'), { apiKey: 'sk-own', hosted: false });
    assert.deepEqual(await accounts.resolveProviderKey('echo', null), { hosted: false });
    await assert.rejects(accounts.resolveProviderKey('anthropic', null), (e: PlanLimitException) => e.getStatus() === 402 && /own keys/.test(e.message));
  });
  await accounts.setPlan(id, 'hosted', 'root@example.com');
  await runWithAccount(id, async () => {
    assert.deepEqual(await accounts.resolveProviderKey('anthropic', null), { apiKey: 'sk-platform', hosted: true });
    await assert.rejects(accounts.resolveProviderKey('openai', null), (e: PlanLimitException) => e.getStatus() === 402 && /no platform key for openai/.test(e.message));
    // $1 ceiling: 200k output tokens of Sonnet is $3 — over
    await accounts.recordUsage({ model: 'claude-sonnet-4-5', tokensIn: 0, tokensOut: 200_000, hosted: true });
    const usage = await accounts.usageThisMonth();
    assert.ok(usage.hostedUsd > 1 && usage.usd === usage.hostedUsd, `priced from the list table: ${usage.hostedUsd}`);
    await assert.rejects(accounts.resolveProviderKey('anthropic', null), (e: PlanLimitException) => e.getStatus() === 402 && /ceiling reached/.test(e.message));
    assert.deepEqual(await accounts.resolveProviderKey('anthropic', 'sk-own'), { apiKey: 'sk-own', hosted: false }, 'own keys are never metered against the ceiling');
    const summary = await accounts.summary();
    assert.equal(summary.plan, 'hosted');
    assert.equal(summary.limits.hostedUsd, 1);
    assert.deepEqual(summary.platformProviders, ['anthropic']);
    const headers = await accounts.usageHeaders();
    assert.equal(headers['X-Yaam-Plan'], 'hosted');
    assert.equal(headers['X-Yaam-Ceiling-Usd'], '1.00');
  });
});

test('the turn loop refuses a turn the plan does not allow before any row is written, and rolls settled turns into the month', async () => {
  const db = await testDb();
  const { stub } = memStorage();
  const storage = stub as unknown as StorageService;
  const accounts = new AccountsService(db, accountsCfg({ hostedPlanUsd: 15, platformKeys: { anthropic: 'sk-platform' } }));
  const sent = fakeSender(accounts);
  const id = await signUp(accounts, sent, 'jo@example.com');
  const agents = new AgentsService(db, storage, undefined, accounts);
  const workspaces = new WorkspacesService(db, storage);
  const repo = new ChatsRepository(db);
  const types = new AgentTypesService(db);
  const memory = new AgentMemoryService(db, storage);
  const provider = new ScriptedProvider([[{ type: 'answer', text: 'hi' }, { type: 'usage', inputTokens: 1000, outputTokens: 500 } as AiStreamEvent, { type: 'done' }]]);
  const factory = { resolve: () => provider, defaultBaseUrl: () => undefined } as unknown as AiProviderFactory;
  const context = new TurnContextService(factory, types, agents, memory, workspaces, cfg({ maxToolRounds: 24 }), accounts);
  // positional optionals: connections, compaction, runner, review, browser, computer, then accounts
  const turns = new TurnLoopService(repo, new ChatLocks(), new ToolsService(storage), context, skillsStub(), storage, mcpStub(), agents, workspaces, undefined, undefined, undefined, undefined, undefined, undefined, accounts);

  await runWithAccount(id, async () => {
    const ws = (await workspaces.list())[0];
    const type = await types.create({ name: 'Claude', provider: 'anthropic', model: 'claude-sonnet-4-5' }); // no key
    const session = await repo.createSession({ workspaceId: ws.id, agentTypeId: type.id });
    await assert.rejects((async () => { for await (const _ of turns.run(session.id, { text: 'hello' })) void _; })(), (e: PlanLimitException) => e.getStatus() === 402);
    assert.deepEqual(await repo.listTurns(session.id), [], 'nothing written for a refused turn');

    await accounts.setPlan(id, 'hosted', 'root@example.com');
    const events: string[] = [];
    for await (const ev of turns.run(session.id, { text: 'hello' })) events.push(ev.type);
    assert.ok(events.includes('answer'));
    assert.equal(provider.requests[0].apiKey, 'sk-platform', 'the hosted plan ran on the platform key');
    const usage = await accounts.usageThisMonth();
    assert.equal(usage.tokensIn, 1000);
    assert.equal(usage.turns, 1);
    assert.ok(usage.hostedUsd > 0 && usage.hostedUsd === usage.usd, 'metered as hosted');
  });
});

// ---- 6. background work ----

test('the loop tick runs once per active account, each under its own context', async () => {
  const db = await testDb();
  const { stub } = memStorage();
  const storage = stub as unknown as StorageService;
  const accounts = new AccountsService(db, accountsCfg({ accountsDefaultPlan: 'byo' }));
  const sent = fakeSender(accounts);
  const agents = new AgentsService(db, storage, undefined, accounts);
  const workspaces = new WorkspacesService(db, storage);
  const repo = new ChatsRepository(db);
  const provider = new ScriptedProvider([[{ type: 'answer', text: 'ok' }, { type: 'done' }], [{ type: 'answer', text: 'ok' }, { type: 'done' }]]);
  const turns = new TurnLoopService(repo, new ChatLocks(), new ToolsService(storage), ctxStub(provider), skillsStub(), storage, mcpStub(), agents, workspaces);
  const memory = new AgentMemoryService(db, storage);
  const distill = new DistillService(repo, ctxStub(provider), agents, memory);
  const loops = new LoopsService(agents, workspaces, repo, turns, distill, cfg({ loopsEnabled: false }), undefined, undefined, accounts);

  const a = await signUp(accounts, sent, 'kim@example.com');
  const b = await signUp(accounts, sent, 'lee@example.com');
  const seen = new Map<string, string>();
  for (const [id, name] of [[a, 'Kim bot'], [b, 'Lee bot']] as const) {
    await runWithAccount(id, async () => {
      await workspaces.list();
      const agent = await agents.create({ name, loops: [{ name: 'Nightly', cron: '0 2 * * *' }] });
      seen.set(id, agent.id);
    });
  }
  assert.deepEqual(await agents.list(), [], 'no agents in the single account');

  await loops.tick(new Date(2026, 6, 16, 2, 0));
  await new Promise((r) => setTimeout(r, 80)); // runLoop is fire-and-forget

  for (const id of [a, b]) {
    await runWithAccount(id, async () => {
      const ws = (await workspaces.list())[0];
      const sessions = await repo.listSessions(ws.id);
      assert.equal(sessions.length, 1, `one loop session for ${id}`);
      assert.equal(sessions[0].agentId, seen.get(id));
      assert.equal(sessions[0].accountId, id);
      const events = await agents.listEvents(seen.get(id)!);
      assert.equal(events.length, 1);
      assert.equal(events[0].kind, 'loop_run');
    });
  }
  const rows = await unscoped(db).select({ accountId: schema.chatSessions.accountId }).from(schema.chatSessions);
  assert.deepEqual(rows.map((r) => r.accountId).sort(), [a, b].sort(), 'every loop session belongs to the account whose agent ran');
});
