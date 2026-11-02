/**
 * Group chat (docs/group-chat.md, execution-plan item 15): channels with
 * `#general` by default and backfilled, mention parsing, mentioned agents
 * waking into per-channel sessions with replies persisted under their run,
 * unprompted replies gated by the relevance check and every bound in §2, the
 * 3-round chain cap, approvals routed to the human author, membership-gated
 * channel tools, make-task linkage with status lines posting back, the
 * workspace event bus / SSE, FTS over channel messages, and `#slug text`
 * posting from Telegram.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { ConfigService } from '@nestjs/config';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import * as schema from '../server/src/database/schema';
import { agentEvents, agentTasks, channelMembers, channelMessages, channels, chatMessages, workspaces } from '../server/src/database/schema';
import { runPgMigrations } from '../server/src/database/migrator';
import type { DrizzleDb } from '../server/src/database/database.module';
import { scopeDb } from '../server/src/accounts/scoped-db';
import { testDb, memStorage, ctxStub, skillsStub, mcpStub, pgliteQueryable } from './helpers';
import { runWithViewer, type Viewer } from '../server/src/accounts/account-context';
import { ChatsRepository } from '../server/src/chats/chats.repository';
import { TurnLoopService } from '../server/src/chats/turn-loop.service';
import { ChatLocks } from '../server/src/chats/chat-locks';
import { ToolsService } from '../server/src/chats/tools.service';
import { TriggerBus } from '../server/src/chats/trigger-bus';
import { AgentsService } from '../server/src/agents/agents.service';
import { WorkspacesService } from '../server/src/workspaces/workspaces.service';
import { SettingsService } from '../server/src/settings/settings.module';
import { SearchService } from '../server/src/search/search.service';
import { TelegramService } from '../server/src/channels/telegram.service';
import type { SharedService } from '../server/src/shared/shared.service';
import { GroupChatService, GENERAL_SLUG, COMPANY_SLUG } from '../server/src/groupchat/groupchat.service';
import { OrgAuditService } from '../server/src/org/org-audit.service';
import { OrgService } from '../server/src/org/org.service';
import { OrgTasksService } from '../server/src/org/org-tasks.service';
import { OrgApprovalsService } from '../server/src/org/org-approvals.service';
import { OrgBriefService } from '../server/src/org/org-brief.service';
import { OrgRuntimeService } from '../server/src/org/org-runtime.service';
import { OrgModeService } from '../server/src/org/org-mode.service';
import { OrgAnnouncer } from '../server/src/org/org-announcer';
import { ChannelRuntimeService, PAUSED_LINE, BUDGET_LINE, UNPROMPTED_RATE_MS, agentRoundsSinceHuman, type RelevanceInput } from '../server/src/groupchat/channel-runtime.service';
import { GroupChatController } from '../server/src/groupchat/groupchat.controller';
import { WorkspaceEventBus, type WorkspaceEvent } from '../server/src/groupchat/workspace-events';
import { parseMentions, handleOf, slugify, unresolvedMentions } from '../server/src/groupchat/mentions';
import type { AiProvider, AiRequest, AiStreamEvent } from '../server/src/ai/ai-provider.interface';
import { setAddressLookup } from '../server/src/common/url-guard';

setAddressLookup(async () => [{ address: '93.184.216.34', family: 4 }]);

/** Which agent is replying, from the runtime's "(agent, you)" roster line. */
const whoAmI = (req: AiRequest): string => /([^,.;:]+?) \(agent, you\)/.exec(req.system ?? '')?.[1]?.trim() ?? 'agent';
const lastUser = (req: AiRequest): string => [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';

/** A provider whose reply is a function of who is asked and what was said;
 *  `plan` may return a tool call first and the answer on the next round. */
class ReplyProvider implements AiProvider {
  readonly name = 'scripted';
  readonly requests: AiRequest[] = [];
  constructor(private readonly plan: (me: string, text: string, round: number, req: AiRequest) => AiStreamEvent[], private readonly delay: (me: string) => number = () => 0) {}
  async *stream(req: AiRequest): AsyncGenerator<AiStreamEvent> {
    this.requests.push(req);
    const ms = this.delay(whoAmI(req));
    if (ms > 0) await new Promise((r) => setTimeout(r, ms));
    const round = req.messages.filter((m) => m.role === 'tool').length;
    for (const ev of this.plan(whoAmI(req), lastUser(req), round, req)) yield ev;
    yield { type: 'usage', inputTokens: 100, outputTokens: 50 };
    yield { type: 'done' };
  }
}

const say = (text: string): AiStreamEvent[] => [{ type: 'answer', text }];

/** A minimal SharedService: one member, "bob", so wakes can run as a member
 *  and names resolve — without standing up accounts mode. */
function sharedStub(workspaceId: string, owner: string): SharedService {
  return {
    hasMembers: async () => true,
    members: async () => [{ id: 'm1', workspaceId, memberAccountId: 'bob', role: 'member', displayName: 'Bob', email: 'bob@example.com', invitedBy: '', joinedAt: '', accountId: owner }],
    member: async (_ws: string, id: string) => (id === 'bob' ? { id: 'm1', workspaceId, memberAccountId: 'bob', role: 'member', displayName: 'Bob', email: 'bob@example.com', invitedBy: '', joinedAt: '', accountId: owner } : null),
    displayNames: async () => new Map([[owner, 'Alice'], ['bob', 'Bob']]),
    nameOf: async (_ws: string, actor: string) => (actor === 'bob' ? 'Bob' : 'Alice'),
    allowedSources: async () => new Set<string>(),
    mayFlow: async () => false,
    channels: async () => [],
  } as unknown as SharedService;
}

async function setup(plan: (me: string, text: string, round: number, req: AiRequest) => AiStreamEvent[] = () => say('ok'), opts: { shared?: boolean; db?: DrizzleDb; delay?: (me: string) => number } = {}) {
  const db = opts.db ?? await testDb();
  const { stub } = memStorage();
  const bus = new TriggerBus();
  const agents = new AgentsService(db, stub, bus);
  const workspaces = new WorkspacesService(db, stub);
  const repo = new ChatsRepository(db);
  const provider = new ReplyProvider(plan, opts.delay);
  const turns = new TurnLoopService(repo, new ChatLocks(), new ToolsService(stub), ctxStub(provider), skillsStub(), stub, mcpStub(), agents, workspaces);
  const events = new WorkspaceEventBus();
  const settings = new SettingsService(db);
  const config = { get: (k: string) => (k === 'publicAppUrl' ? 'https://app.example' : k === 'telegramBotToken' ? 'test-token' : undefined) } as unknown as ConfigService;
  // The hook must be registered before the default workspace is created.
  const pending: { shared?: SharedService } = {};
  const groupchat = new GroupChatService(db, workspaces, agents, stub, events, config, opts.shared ? sharedStub('', 'single') : undefined, bus);
  const ws = (await workspaces.list())[0];
  if (opts.shared) {
    // Rebuild with the workspace id known (the stub is id-agnostic anyway).
    pending.shared = sharedStub(ws.id, 'single');
  }
  const runtime = new ChannelRuntimeService(db, groupchat, turns, repo, agents, workspaces, events, undefined, settings, pending.shared);
  const log: WorkspaceEvent[] = [];
  events.subscribe(ws.id, (ev) => log.push(ev));
  const general = await groupchat.bySlug(ws.id, GENERAL_SLUG);
  return { db, stub, bus, agents, workspaces, repo, turns, provider, events, settings, config, groupchat, runtime, ws, general, log };
}

const texts = (rows: Array<{ text: string }>) => rows.map((r) => r.text);

// ---- 1. channels: #general, CRUD, backfill ----

test('every workspace gets #general with every agent and the owner; create/update/archive; #general is protected', async () => {
  const s = await setup();
  const scout = await s.agents.create({ name: 'Scout' });
  const list = await s.groupchat.list(s.ws.id);
  assert.equal(list.length, 1);
  assert.equal(list[0].slug, 'general');
  const members = await s.groupchat.members(s.general.id);
  assert.ok(members.some((m) => m.memberKind === 'human' && m.memberId === 'single' && m.role === 'owner'), 'the owner belongs to #general');
  // agents created later join #general when it is next listed? No: membership
  // is explicit — add Scout and check the roster names.
  await s.groupchat.addMember(s.general.id, { kind: 'agent', id: scout.id });
  assert.ok((await s.groupchat.members(s.general.id)).some((m) => m.memberKind === 'agent' && m.name === 'Scout'));

  // a second workspace gets its own #general through the create hook — with
  // its own agents only: Scout belongs to the first workspace (item 26)
  const ws2 = await s.workspaces.create({ name: 'Side project' });
  assert.equal((await s.groupchat.list(ws2.id))[0].slug, 'general');
  assert.equal((await s.groupchat.members((await s.groupchat.bySlug(ws2.id, 'general')).id)).some((m) => m.memberKind === 'agent' && m.memberId === scout.id), false, 'allAgents on create means the workspace agents');

  const launch = await s.groupchat.create(s.ws.id, { name: 'Product Launch', topic: 'Q1 launch', agentIds: [scout.id] });
  assert.equal(launch.slug, 'product-launch');
  assert.equal(launch.folder, 'channels/product-launch');
  await assert.rejects(s.groupchat.create(s.ws.id, { name: 'product launch' }), /already exists/);
  await assert.rejects(s.groupchat.create(s.ws.id, { name: 'x', slug: 'Bad Slug!' }), BadRequestException);
  const updated = await s.groupchat.update(launch.id, { topic: 'Q1 launch — ship by March', dailyTokenBudget: 5000 });
  assert.equal(updated.dailyTokenBudget, 5000);
  await assert.rejects(s.groupchat.update(launch.id, { dailyTokenBudget: -1 }), BadRequestException);
  await s.groupchat.archive(launch.id);
  assert.equal((await s.groupchat.list(s.ws.id)).some((c) => c.slug === 'product-launch'), false);
  assert.equal((await s.groupchat.list(s.ws.id, { archived: true }))[0].slug, 'product-launch');
  await assert.rejects(s.groupchat.post(launch.id, { text: 'hi', authorKind: 'human' }), /archived/);
  await assert.rejects(s.groupchat.archive(s.general.id), /#general cannot be archived/);
  await assert.rejects(s.groupchat.removeMember(s.general.id, 'human', 'single'), /everyone belongs/);
  // a private channel is invisible to non-members (404, not 403)
  const secret = await s.groupchat.create(s.ws.id, { name: 'Secret', kind: 'private' });
  const stranger: Viewer = { memberAccountId: 'carol', role: 'member', workspaceId: s.ws.id, displayName: 'Carol' };
  await assert.rejects(runWithViewer('single', stranger, () => s.groupchat.open(s.ws.id, 'secret')), /channel #secret/);
  assert.equal((await runWithViewer('single', stranger, () => s.groupchat.list(s.ws.id))).some((c) => c.id === secret.id), false);
  assert.ok((await s.groupchat.list(s.ws.id)).some((c) => c.id === secret.id), 'the creator sees it');
  // the events bus saw the channel changes
  assert.ok(s.log.some((e) => e.type === 'channel_update'));
});

test('migration 0029 backfills #general into workspaces that predate it, idempotently', async () => {
  const pg = new PGlite();
  const q = pgliteQueryable(pg);
  await runPgMigrations(q, { log: () => {} });
  const db = scopeDb(drizzle(pg, { schema }) as unknown as DrizzleDb);
  // a workspace made without the service hook (an older install)
  await db.insert(workspaces).values({ id: 'w-old', name: 'Old', color: '#fff', memory: '', profile: '', profilePending: '[]', profilePrivate: '{}', quietHours: '', spendBudgetTokens: 0, spendMonth: '', spendTokens: 0, createdAt: new Date().toISOString() });
  assert.equal((await db.select().from(channels)).length, 0);
  // replay the migration: the INSERT … WHERE NOT EXISTS fills the gap once
  await q.query(`DELETE FROM __migrations WHERE "id" = '0029-group-chat'`);
  await runPgMigrations(q, { log: () => {} });
  const rows = await db.select().from(channels);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].workspaceId, 'w-old');
  assert.equal(rows[0].slug, 'general');
  assert.equal(rows[0].accountId, 'single');
  await q.query(`DELETE FROM __migrations WHERE "id" = '0029-group-chat'`);
  await runPgMigrations(q, { log: () => {} });
  assert.equal((await db.select().from(channels)).length, 1, 'no duplicate on replay');
  // the lazy path adds the owner as a member on first list
  const { stub } = memStorage();
  const gc = new GroupChatService(db, new WorkspacesService(db, stub), new AgentsService(db, stub), stub, new WorkspaceEventBus());
  const listed = await gc.list('w-old');
  assert.equal(listed.length, 1);
});

// ---- 2. mentions ----

test('mention parsing resolves @handles, first names and email aliases against members, once each, never authority', () => {
  const members = [
    { kind: 'agent' as const, id: 'a1', name: 'Scout' },
    { kind: 'agent' as const, id: 'a2', name: 'Research Lead' },
    { kind: 'agent' as const, id: 'a3', name: 'Research Writer' },
    { kind: 'human' as const, id: 'h1', name: 'Bob Jones', aliases: ['bob.jones'] },
  ];
  assert.deepEqual(parseMentions('hey @scout can you and @research-lead look? cc @bob.jones, @Scout again', members),
    [{ kind: 'agent', id: 'a1' }, { kind: 'agent', id: 'a2' }, { kind: 'human', id: 'h1' }]);
  assert.deepEqual(parseMentions('@research is ambiguous, @bob is not', members), [{ kind: 'human', id: 'h1' }]);
  assert.deepEqual(parseMentions('mail me at a@b.com — not a mention; @nobody neither', members), []);
  assert.deepEqual(parseMentions('(@Research-Writer!) and @ResearchLead', members), [{ kind: 'agent', id: 'a3' }, { kind: 'agent', id: 'a2' }]);
  assert.equal(handleOf('Zoë  Q. Álvarez'), 'zoe-q-alvarez');
  assert.equal(slugify('  Product  Launch!! '), 'product-launch');
});

test('mention parsing resolves multi-word display names as agents write them, in any script and markdown, longest name first', () => {
  // The dev-DB failure: two agents share a first word, so `@Tutor Lead`
  // (the form agents write) resolved to nobody and woke nobody.
  const team = [
    { kind: 'agent' as const, id: 'lead', name: 'Tutor Lead' },
    { kind: 'agent' as const, id: 'eng', name: 'Tutor Engineer' },
    { kind: 'agent' as const, id: 'cos', name: 'Chief of staff' },
    { kind: 'agent' as const, id: 'alpha', name: 'Unit Test Alpha' },
    { kind: 'agent' as const, id: 'writer', name: 'Unit Test Writer' },
  ];
  const ids = (text: string, members: Array<{ kind: 'agent' | 'human'; id: string; name: string }> = team) => parseMentions(text, members).map((m) => m.id);
  assert.deepEqual(ids('Done.\n\n@Tutor Engineer: the bar now holds'), ['eng']);
  assert.deepEqual(ids('**`14e8fb19` — the executor exists. `@Tutor Lead`**'), ['lead']);
  assert.deepEqual(ids('`@Chief of staff` you then, and @Unit Test Alpha, that comment'), ['cos', 'alpha']);
  assert.deepEqual(ids("@Unit Test Alpha's 06:03 note"), ['alpha']);
  assert.deepEqual(ids('cc @TUTOR ENGINEER, @tutor-lead and @chief-of-staff.'), ['eng', 'lead', 'cos']);
  assert.deepEqual(ids('@**Tutor Lead** and [@Unit Test Writer](#x) and _@Tutor Engineer_'), ['lead', 'writer', 'eng']);
  assert.deepEqual(ids('@tutor alone is still ambiguous'), []);
  assert.deepEqual(ids('mail tutor@Tutor Lead.com is an address, not a mention'), []);
  assert.deepEqual(ids('```\n@Tutor Lead in a code sample\n```\nnobody'), [], 'fenced code mentions nobody');
  // a name that prefixes another: the longest wins, the short one still works alone
  const pre = [{ kind: 'agent' as const, id: 't', name: 'Tutor' }, { kind: 'agent' as const, id: 'tl', name: 'Tutor Lead' }];
  assert.deepEqual(ids('@Tutor Lead go', pre), ['tl']);
  assert.deepEqual(ids('@Tutor, go', pre), ['t']);
  assert.deepEqual(ids('@Tutoring is not a member', pre), []);
  // names in other scripts and with emoji
  const intl = [
    { kind: 'agent' as const, id: 'duc', name: 'Đức Anh' },
    { kind: 'agent' as const, id: 'ming', name: '小明' },
    { kind: 'agent' as const, id: 'robo', name: '🤖 Robo' },
  ];
  assert.deepEqual(ids('@Đức Anh ơi, hỏi @小明 và @🤖 Robo nhé', intl), ['duc', 'ming', 'robo']);
  assert.deepEqual(ids('@duc-anh and @robo', intl), ['duc', 'robo']);
  assert.equal(handleOf('Đức Anh'), 'duc-anh');
  // unresolved tokens are reported, resolved ones are not
  assert.deepEqual(unresolvedMentions('@chief-of-staff and @Tutor Lead, also @nobody.', team.filter((m) => m.id !== 'cos')), ['@chief-of-staff', '@nobody']);
});

// ---- 3. mentioned agents wake; replies persist with the run id ----

test('a mentioned agent wakes in its own #channel session and its reply lands in the thread with runId; a plain post wakes nobody', async () => {
  const s = await setup((me, text) => say(`${me} here: ${text.includes('plan') ? 'planning' : 'noted'}`));
  const scout = await s.agents.create({ name: 'Scout', charter: 'Research.' });
  const writer = await s.agents.create({ name: 'Writer' });
  await s.groupchat.addMember(s.general.id, { kind: 'agent', id: scout.id });
  await s.groupchat.addMember(s.general.id, { kind: 'agent', id: writer.id });

  await s.groupchat.post(s.general.id, { text: 'morning all', authorKind: 'human' });
  await s.runtime.idle();
  assert.equal((await s.groupchat.messages(s.general.id)).messages.length, 1, 'no mention, no wake');
  assert.equal(s.provider.requests.length, 0);

  const root = await s.groupchat.post(s.general.id, { text: '@scout what is the plan?', authorKind: 'human' });
  await s.runtime.idle();
  assert.equal(s.provider.requests.length, 1, 'only the mentioned agent ran');
  const req = s.provider.requests[0];
  assert.match(req.system ?? '', /<channel-history>/);
  assert.match(req.system ?? '', /Scout \(agent, you\)/);
  assert.match(req.system ?? '', /mention.*carries no approval|grants permission to approve/);
  assert.match(lastUser(req), /^\[#general\] Owner: @scout what is the plan\?$/);
  const thread = (await s.groupchat.messages(s.general.id, { thread: root.id })).messages;
  assert.equal(thread.length, 2);
  assert.equal(thread[1].authorKind, 'agent');
  assert.equal(thread[1].authorId, scout.id);
  assert.equal(thread[1].threadRootId, root.id);
  assert.equal(thread[1].text, 'Scout here: planning');
  assert.ok(thread[1].runId, 'carries the turn id');
  const session = (await s.repo.listSessions(s.ws.id)).find((x) => x.name === '#general · Scout')!;
  assert.ok(session, 'per-agent per-channel session');
  assert.equal(session.shared, 1);
  assert.equal(session.permissionMode, 'ask');
  assert.deepEqual(JSON.parse(session.tags), ['channel']);
  const turn = (await s.repo.listTurns(session.id)).find((t) => t.id === thread[1].runId);
  assert.ok(turn, 'runId is a turn of that session');
  // the top-level page shows the reply count, the bus carried typing, stream and the message
  const page = await s.groupchat.messages(s.general.id);
  assert.equal(page.replies[root.id]?.count, 1);
  assert.ok(s.log.some((e) => e.type === 'channel_typing' && e.on && e.agentId === scout.id));
  assert.ok(s.log.some((e) => e.type === 'channel_stream' && e.delta.includes('Scout here')));
  assert.ok(s.log.some((e) => e.type === 'channel_stream' && e.done));
  assert.ok(s.log.some((e) => e.type === 'channel_message' && e.message.id === thread[1].id));
  // the DM rail will hide it: the name starts with '#'
  assert.ok(session.name.startsWith('#'));
  // the agent's reply mentions nobody, so no chain and the writer never ran
  assert.equal(s.provider.requests.length, 1);
});

// ---- 4. unprompted replies: relevance seam + every bound ----

test('unprompted replies: relevance check decides, bounded by rate, two per message, mentioned-agent replying, unprompted source and budget', async () => {
  const s = await setup((me) => say(`${me} chimes in`));
  const a = await s.agents.create({ name: 'Alpha', charter: 'Alpha things' });
  const b = await s.agents.create({ name: 'Beta' });
  const c = await s.agents.create({ name: 'Gamma' });
  for (const ag of [a, b, c]) await s.groupchat.addMember(s.general.id, { kind: 'agent', id: ag.id, unprompted: true });
  const asked: RelevanceInput[] = [];
  let verdict = true;
  s.runtime.relevanceFn = async (input) => { asked.push(input); return { reply: verdict, reason: 'test' }; };
  let clock = Date.now();
  s.runtime.now = () => clock;

  // relevance says no → silence, but every candidate was asked exactly once
  verdict = false;
  await s.groupchat.post(s.general.id, { text: 'anyone?', authorKind: 'human' });
  await s.runtime.idle();
  assert.equal(asked.length, 3);
  assert.equal(asked[0].channel.slug, 'general');
  assert.equal(asked[0].message.text, 'anyone?');
  assert.equal(s.provider.requests.length, 0);

  // relevance says yes → at most TWO unprompted repliers per message, flagged unprompted
  verdict = true;
  asked.length = 0;
  const m2 = await s.groupchat.post(s.general.id, { text: 'thoughts on pricing?', authorKind: 'human' });
  await s.runtime.idle();
  assert.equal(asked.length, 2, 'the third candidate is never even asked');
  assert.equal(s.provider.requests.length, 2);
  const replies = (await s.groupchat.messages(s.general.id, { thread: m2.id })).messages.slice(1);
  assert.equal(replies.length, 2);
  assert.ok(replies.every((r) => r.unprompted === 1));
  // …and those replies, being unprompted, woke nobody further
  assert.equal(asked.length, 2);

  // rate: within 2 minutes the two repliers are out; only Gamma may speak
  asked.length = 0; s.provider.requests.length = 0;
  await s.groupchat.post(s.general.id, { text: 'and shipping?', authorKind: 'human' });
  await s.runtime.idle();
  assert.deepEqual(asked.map((x) => x.agentName), ['Gamma']);
  assert.equal(s.provider.requests.length, 1);

  // after the window everyone is eligible again
  clock += UNPROMPTED_RATE_MS + 1;
  asked.length = 0; s.provider.requests.length = 0;
  await s.groupchat.post(s.general.id, { text: 'and support?', authorKind: 'human' });
  await s.runtime.idle();
  assert.equal(asked.length, 2);

  // a mention: the mentioned agent replies; nobody unprompted is asked for that message
  clock += UNPROMPTED_RATE_MS + 1;
  asked.length = 0; s.provider.requests.length = 0;
  const m5 = await s.groupchat.post(s.general.id, { text: '@alpha own this please', authorKind: 'human' });
  await s.runtime.idle();
  assert.equal(asked.length, 0, 'none while a mentioned agent replies in the thread');
  assert.equal(s.provider.requests.length, 1);
  assert.equal((await s.groupchat.messages(s.general.id, { thread: m5.id })).messages[1].unprompted, 0);

  // budget: once the channel's daily tokens are spent nobody unprompted is asked
  clock += UNPROMPTED_RATE_MS + 1;
  asked.length = 0; s.provider.requests.length = 0;
  await s.groupchat.update(s.general.id, { dailyTokenBudget: 1 });
  const general = await s.groupchat.get(s.general.id);
  assert.equal(await s.runtime.budgetSpent(general), true);
  await s.groupchat.post(s.general.id, { text: 'budget check', authorKind: 'human' });
  await s.runtime.idle();
  assert.equal(asked.length, 0);
  assert.equal(s.provider.requests.length, 0);
  // and a mention under a spent budget posts the budget line instead of waking
  const m7 = await s.groupchat.post(s.general.id, { text: '@beta are you there?', authorKind: 'human' });
  await s.runtime.idle();
  assert.equal(s.provider.requests.length, 0);
  assert.deepEqual(texts((await s.groupchat.messages(s.general.id, { thread: m7.id })).messages.slice(1)), [BUDGET_LINE]);
  // the workspace default applies when the channel's own budget is 0
  await s.groupchat.update(s.general.id, { dailyTokenBudget: 0 });
  await s.settings.put({ channelDailyTokenBudget: '0' });
  assert.equal(await s.runtime.budgetSpent(await s.groupchat.get(s.general.id)), false, '0 = unlimited');
  await s.settings.put({ channelDailyTokenBudget: '10' });
  assert.equal(await s.runtime.budgetSpent(await s.groupchat.get(s.general.id)), true);
});

// ---- 5. chains ----

test('agent-to-agent chains stop after three rounds per thread with the paused line; a human message resets the count', async () => {
  const s = await setup((me) => say(me === 'Ping' ? 'your turn @pong' : 'back to you @ping'));
  const ping = await s.agents.create({ name: 'Ping' });
  const pong = await s.agents.create({ name: 'Pong' });
  await s.groupchat.addMember(s.general.id, { kind: 'agent', id: ping.id });
  await s.groupchat.addMember(s.general.id, { kind: 'agent', id: pong.id });
  const root = await s.groupchat.post(s.general.id, { text: '@ping start', authorKind: 'human' });
  await s.runtime.idle();
  const thread = (await s.groupchat.messages(s.general.id, { thread: root.id })).messages;
  const agentRows = thread.filter((m) => m.authorKind === 'agent');
  assert.equal(agentRows.length, 3, 'exactly three agent rounds');
  assert.deepEqual(agentRows.map((m) => m.authorId), [ping.id, pong.id, ping.id]);
  assert.equal(thread.at(-1)!.authorKind, 'system');
  assert.equal(thread.at(-1)!.text, PAUSED_LINE);
  assert.equal(s.provider.requests.length, 3);
  assert.equal(agentRoundsSinceHuman(thread), 3);
  // a person speaking in the thread restarts the budget of rounds
  await s.groupchat.post(s.general.id, { text: 'carry on @pong', threadRootId: root.id, authorKind: 'human' });
  await s.runtime.idle();
  assert.equal(s.provider.requests.length, 6);
  const again = (await s.groupchat.messages(s.general.id, { thread: root.id })).messages;
  assert.equal(again.filter((m) => m.text === PAUSED_LINE).length, 2);
  // a reply to a reply stays in the root's thread
  assert.ok(again.every((m) => m.id === root.id || m.threadRootId === root.id));
});

test('an agent reply that tags another agent by display name ("@Tutor Lead") wakes it, and the woken agent knows an agent tagged it', async () => {
  // dev DB: Tutor Engineer's "`@Tutor Lead`" was stored with mentions [] —
  // both names start with "Tutor" — and Tutor Lead never replied.
  const s = await setup((me) => say(me === 'Tutor Engineer' ? 'Harness is green. `@Tutor Lead` — your scenarios next.' : `${me}: on it`));
  const eng = await s.agents.create({ name: 'Tutor Engineer' });
  const lead = await s.agents.create({ name: 'Tutor Lead' });
  await s.groupchat.addMember(s.general.id, { kind: 'agent', id: eng.id });
  await s.groupchat.addMember(s.general.id, { kind: 'agent', id: lead.id });
  const root = await s.groupchat.post(s.general.id, { text: '@Tutor Engineer status?', authorKind: 'human' });
  assert.deepEqual(JSON.parse(root.mentions), [{ kind: 'agent', id: eng.id }]);
  await s.runtime.idle();
  const thread = (await s.groupchat.messages(s.general.id, { thread: root.id })).messages;
  assert.deepEqual(thread.filter((m) => m.authorKind === 'agent').map((m) => m.authorId), [eng.id, lead.id], 'the tagged agent replied in the thread');
  assert.deepEqual(JSON.parse(thread[1].mentions), [{ kind: 'agent', id: lead.id }]);
  const leadReq = s.provider.requests.find((r) => whoAmI(r) === 'Tutor Lead')!;
  assert.match(lastUser(leadReq), /^\[#general, in a thread\] Tutor Engineer: Harness is green/);
  assert.match(leadReq.system ?? '', /Tutor Engineer, another agent in this channel, mentioned you/);
  assert.match(leadReq.system ?? '', /Owner: @Tutor Engineer status\?/, 'the history carries the thread that led here');
  assert.match(leadReq.system ?? '', /@tutor-engineer/, 'the roster tells the agent how to tag members');
  // live events say which thread each reply lands in: the first was tagged
  // at top level, the second inside the thread — both land under the root
  const streams = s.log.filter((e): e is Extract<WorkspaceEvent, { type: 'channel_stream' }> => e.type === 'channel_stream');
  assert.ok(streams.some((e) => e.agentId === eng.id && e.threadRootId === null && e.replyRootId === root.id));
  assert.ok(streams.some((e) => e.agentId === lead.id && e.threadRootId === root.id && e.replyRootId === root.id));
});

test('a tag inside a channel_post (outside any wake) wakes the agent the same way; the tool result says who was woken and which tags named nobody', async () => {
  const s = await setup((me) => say(`${me}: reviewed`));
  const eng = await s.agents.create({ name: 'Tutor Engineer' });
  const lead = await s.agents.create({ name: 'Tutor Lead' });
  await s.agents.create({ name: 'Chief of staff' }); // not a member of #general
  await s.groupchat.addMember(s.general.id, { kind: 'agent', id: eng.id });
  await s.groupchat.addMember(s.general.id, { kind: 'agent', id: lead.id });
  const session = await s.repo.createSession({ workspaceId: s.ws.id, agentId: eng.id, name: 'heartbeat' });
  const out = await s.runtime.execute(session, 'channel_post', { channel: 'general', text: '**Executor landed.** @Tutor Lead please review; @chief-of-staff FYI' });
  assert.match(out, /Posted to #general/);
  assert.match(out, /Woke Tutor Lead/);
  assert.match(out, /@chief-of-staff.*not a member of #general.*nobody was woken/);
  await s.runtime.idle();
  const top = (await s.groupchat.messages(s.general.id)).messages;
  assert.equal(top.length, 1);
  const thread = (await s.groupchat.messages(s.general.id, { thread: top[0].id })).messages;
  assert.equal(thread.length, 2);
  assert.equal(thread[1].authorId, lead.id, 'the tagged agent replied under the post');
  assert.equal(thread[1].text, 'Tutor Lead: reviewed');
  // a self-tag is not a wake, and is said so
  const self = await s.runtime.execute(session, 'channel_post', { channel: 'general', text: 'note to @Tutor Engineer (me)' });
  assert.doesNotMatch(self, /Woke/);
  await s.runtime.idle();
  assert.equal(s.provider.requests.length, 1);
});

test('an agent tagged while it is still replying is queued and answers after, instead of being dropped', async () => {
  // Alpha and Beta are tagged together; Alpha answers first and tags Beta,
  // whose first turn is still running.
  const s = await setup((me, text) => say(me === 'Alpha' ? 'over to you @beta' : `beta saw: ${text.slice(0, 80)}`), { delay: (me) => (me === 'Beta' ? 120 : 0) });
  const alpha = await s.agents.create({ name: 'Alpha' });
  const beta = await s.agents.create({ name: 'Beta' });
  await s.groupchat.addMember(s.general.id, { kind: 'agent', id: alpha.id });
  await s.groupchat.addMember(s.general.id, { kind: 'agent', id: beta.id });
  const root = await s.groupchat.post(s.general.id, { text: '@alpha @beta kick off', authorKind: 'human' });
  await s.runtime.idle();
  const thread = (await s.groupchat.messages(s.general.id, { thread: root.id })).messages;
  assert.equal(thread.filter((m) => m.authorKind === 'system' && /still replying/.test(m.text)).length, 0, 'no drop');
  const betaRows = thread.filter((m) => m.authorId === beta.id);
  assert.equal(betaRows.length, 2, 'Beta answered both the person and Alpha');
  assert.match(betaRows[0].text, /Owner: @alpha @beta kick off/);
  assert.match(betaRows[1].text, /Alpha: over to you @beta/);
});

test('a stale membership of an agent from another workspace is not a mention target', async () => {
  const s = await setup();
  const scout = await s.agents.create({ name: 'Research Scout' });
  await s.groupchat.addMember(s.general.id, { kind: 'agent', id: scout.id });
  const ws2 = await s.workspaces.create({ name: 'Elsewhere' });
  const other = await s.agents.create({ name: 'Research Writer', workspaceId: ws2.id });
  await s.db.insert(channelMembers).values({ accountId: 'single', id: 'stale-1', channelId: s.general.id, memberKind: 'agent', memberId: other.id, role: 'member', notify: 'mentions', unprompted: 0, joinedAt: new Date().toISOString() });
  const m = await s.groupchat.post(s.general.id, { text: '@research and @Research Writer', authorKind: 'human' });
  assert.deepEqual(JSON.parse(m.mentions), [{ kind: 'agent', id: scout.id }], 'only this workspace\'s agents resolve; "@research" is not made ambiguous by the stale row');
});

// ---- 6. approvals route to the human author ----

test('an Ask approval inside a channel wake is addressed to the human who posted — in the channel stream and their inbox — and the turn ran as them', async () => {
  const s = await setup((me, text, round) => (round === 0 && text.includes('write')
    ? [{ type: 'tool_call', id: 'c1', name: 'http_request', input: { url: 'https://example.com/hook', method: 'POST', body: 'hi' } }]
    : say('done')), { shared: true });
  const scout = await s.agents.create({ name: 'Scout' });
  await s.groupchat.addMember(s.general.id, { kind: 'agent', id: scout.id });
  const bob: Viewer = { memberAccountId: 'bob', role: 'member', workspaceId: s.ws.id, displayName: 'Bob' };
  // the wake pauses on the approval; deny it from the approval event
  s.events.subscribe(s.ws.id, (ev) => {
    if (ev.type === 'channel_approval') {
      assert.equal(ev.forActor, 'bob', 'addressed to the poster');
      assert.equal(ev.forName, 'Bob');
      assert.equal(ev.tool, 'http_request');
      // anybody else cannot see it as theirs; Bob answers
      assert.equal(s.turns.resolveApproval(ev.sessionId, ev.callId, 'deny', 'bob'), true);
    }
  });
  const root = await runWithViewer('single', bob, () => s.groupchat.post(s.general.id, { text: '@scout write the notes', authorKind: 'human' }));
  assert.equal(root.authorId, 'bob');
  await s.runtime.idle();
  const approval = s.log.find((e) => e.type === 'channel_approval');
  assert.ok(approval, 'the channel saw the approval');
  const inbox = (await s.db.select().from(agentEvents)).find((e) => e.kind === 'approval_request' || e.kind === 'approval_expired');
  assert.ok(inbox, 'and so did Bob\'s inbox');
  assert.equal(inbox!.forMemberAccountId, 'bob');
  assert.match(inbox!.title, /Scout asks to run http_request in #general/);
  const thread = (await s.groupchat.messages(s.general.id, { thread: root.id })).messages;
  assert.ok(thread.some((m) => m.authorKind === 'system' && /waiting for Bob's approval to run http_request/.test(m.text)));
  assert.equal(thread.at(-1)!.text, 'done');
  // the channel session's user message is attributed to Bob: the turn ran as him
  const session = (await s.repo.listSessions(s.ws.id)).find((x) => x.name === '#general · Scout')!;
  const userMsg = (await s.db.select().from(chatMessages).where(eq(chatMessages.sessionId, session.id))).find((m) => m.role === 'user')!;
  assert.equal(userMsg.authorAccountId, 'bob');
  assert.match(userMsg.content, /^\[#general\] Bob: @scout write the notes$/);
  // the mention of a human notifies that human with a deep link, addressed to them only
  await runWithViewer('single', bob, () => s.groupchat.post(s.general.id, { text: 'cc @alice', authorKind: 'human' }));
  const mention = (await s.db.select().from(agentEvents)).find((e) => e.kind === 'mention')!;
  assert.ok(mention);
  assert.equal(mention.forMemberAccountId, '', 'the owner\'s copy is her own account event');
  assert.equal(mention.channel, 1);
  const payload = JSON.parse(mention.payload) as { link: string; from: string };
  assert.match(payload.link, new RegExp(`^https://app.example/#/ws/${s.ws.id}/channel/general/[\\w-]+$`));
  assert.equal(payload.from, '#general');
  assert.match(mention.title, /#general · Bob mentioned you/);
});

// ---- 7. channel tools ----

test('channel tools: channel_post is refused outside membership; channel_read, channel_list and channel_make_task work for members', async () => {
  const s = await setup();
  const scout = await s.agents.create({ name: 'Scout' });
  const outsider = await s.agents.create({ name: 'Outsider' });
  await s.groupchat.addMember(s.general.id, { kind: 'agent', id: scout.id });
  const launch = await s.groupchat.create(s.ws.id, { name: 'Launch', agentIds: [scout.id] });
  const sessionOf = async (agentId: string) => s.repo.createSession({ workspaceId: s.ws.id, agentId, name: 'DM' });
  const scoutSession = await sessionOf(scout.id);
  const outsiderSession = await sessionOf(outsider.id);
  assert.ok((await s.runtime.specsFor(scoutSession)).map((t) => t.name).includes('channel_post'));
  assert.equal(s.runtime.owns('channel_post'), true);
  assert.equal(s.runtime.isReadOnly('channel_post'), true, 'posting where you already are is read-only class');
  assert.equal(s.runtime.isReadOnly('channel_make_task'), false);

  await assert.rejects(s.runtime.execute(outsiderSession, 'channel_post', { channel: 'general', text: 'let me in' }), /not a member of #general/);
  await assert.rejects(s.runtime.execute(scoutSession, 'channel_post', { text: 'no channel' }), /channel is required/);
  assert.equal((await s.groupchat.messages(s.general.id)).messages.length, 0);
  const out = await s.runtime.execute(scoutSession, 'channel_post', { channel: '#launch', text: 'kickoff notes posted' });
  assert.match(out, /Posted to #launch/);
  const posted = (await s.groupchat.messages(launch.id)).messages[0];
  assert.equal(posted.authorKind, 'agent');
  assert.equal(posted.authorId, scout.id);
  assert.match(await s.runtime.execute(scoutSession, 'channel_list', {}), /#general[\s\S]*#launch|#launch[\s\S]*#general/);
  assert.match(await s.runtime.execute(outsiderSession, 'channel_list', {}), /not a member of any channel/);
  const read = await s.runtime.execute(scoutSession, 'channel_read', { channel: 'launch' });
  assert.match(read, /<channel-history channel="launch">/);
  assert.match(read, /Scout \(agent\): kickoff notes posted/);
  await assert.rejects(s.runtime.execute(outsiderSession, 'channel_read', { channel: 'launch' }), /not a member/);
  // the context an agent gets outside a wake lists its channels
  assert.match((await s.runtime.contextFor(scoutSession)) ?? '', /#general.*#launch|#launch.*#general/);
  assert.equal(await s.runtime.contextFor(outsiderSession), null);
  // make a task from its own message by id prefix
  const made = await s.runtime.execute(scoutSession, 'channel_make_task', { messageId: posted.id.slice(0, 8), channel: 'launch', title: 'Write kickoff doc' });
  assert.match(made, /Task \[[\w-]{8}\] "Write kickoff doc" created on the kanban/);
  const task = (await s.agents.listTasks(scout.id))[0];
  assert.equal(task.channelId, launch.id);
  assert.equal(task.messageId, posted.id);
});

// ---- 8. make task + status lines ----

test('make-task links message ↔ task both ways, posts a system line, and status changes post back into the thread', async () => {
  const s = await setup();
  const scout = await s.agents.create({ name: 'Scout' });
  await s.groupchat.addMember(s.general.id, { kind: 'agent', id: scout.id });
  const root = await s.groupchat.post(s.general.id, { text: 'We need the Q1 deck by Friday', authorKind: 'human' });
  const res = await s.groupchat.makeTask(s.general.id, root.id, { assigneeAgentId: 'Scout', by: { kind: 'human', id: 'single' } });
  assert.equal(res.kind, 'agent');
  assert.equal(res.task.title, 'We need the Q1 deck by Friday');
  const row = (await s.db.select().from(agentTasks).where(eq(agentTasks.id, res.task.id)))[0];
  assert.equal(row.agentId, scout.id);
  assert.equal(row.channelId, s.general.id);
  assert.equal(row.messageId, root.id);
  assert.equal((await s.groupchat.message(root.id)).taskId, res.task.id);
  let thread = (await s.groupchat.messages(s.general.id, { thread: root.id })).messages;
  assert.equal(thread.length, 2);
  assert.match(thread[1].text, /^Task \[[\w-]{8}\] "We need the Q1 deck by Friday" created for Scout on the kanban · todo$/);
  assert.ok(s.log.some((e) => e.type === 'task_update' && e.taskId === res.task.id && e.status === 'todo'));
  // the agent moves it: the thread hears about it
  await s.agents.updateTask(scout.id, res.task.id, { status: 'doing' });
  await new Promise((r) => setTimeout(r, 30));
  thread = (await s.groupchat.messages(s.general.id, { thread: root.id })).messages;
  assert.match(thread.at(-1)!.text, /^Task \[[\w-]{8}\] "We need the Q1 deck by Friday" → doing$/);
  await s.agents.updateTask(scout.id, res.task.id, { title: 'renamed only' });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal((await s.groupchat.messages(s.general.id, { thread: root.id })).messages.length, 3, 'a title change posts nothing');
  assert.ok(s.log.some((e) => e.type === 'task_update' && e.status === 'doing'));
  // an unknown assignee is refused; a message from another channel too
  await assert.rejects(s.groupchat.makeTask(s.general.id, root.id, { assigneeAgentId: 'Nobody', by: { kind: 'human', id: 'single' } }), /assignee must be an agent member/);
  const other = await s.groupchat.create(s.ws.id, { name: 'Other' });
  await assert.rejects(s.groupchat.makeTask(other.id, root.id, { by: { kind: 'human', id: 'single' } }), /message/);
  // an agent that is not a member cannot make tasks here
  const outsider = await s.agents.create({ name: 'Outsider' });
  await assert.rejects(s.groupchat.makeTask(s.general.id, root.id, { by: { kind: 'agent', id: outsider.id } }), ForbiddenException);
});

// ---- 9. reads, SSE, search ----

test('unread counts follow the read cursor; the SSE route writes bus events as data: lines and unsubscribes on close', async () => {
  const s = await setup();
  const scout = await s.agents.create({ name: 'Scout' });
  await s.groupchat.addMember(s.general.id, { kind: 'agent', id: scout.id });
  const bob: Viewer = { memberAccountId: 'bob', role: 'member', workspaceId: s.ws.id, displayName: 'Bob' };
  await s.groupchat.post(s.general.id, { text: 'one', authorKind: 'human' });
  await s.groupchat.post(s.general.id, { text: 'two', authorKind: 'agent', authorId: scout.id });
  await s.groupchat.postSystem(s.general.id, 'system noise');
  assert.equal((await s.groupchat.list(s.ws.id))[0].unread, 1, 'own messages and system lines do not count');
  const forBob = await runWithViewer('single', bob, () => s.groupchat.list(s.ws.id));
  assert.equal(forBob[0].unread, 2);
  await runWithViewer('single', bob, () => s.groupchat.markRead(s.general.id));
  assert.equal((await runWithViewer('single', bob, () => s.groupchat.list(s.ws.id)))[0].unread, 0);
  assert.equal((await s.groupchat.list(s.ws.id))[0].unread, 1, 'cursors are per person');

  // the controller's SSE stream
  const controller = new GroupChatController(s.groupchat, s.runtime, s.events, s.workspaces);
  const written: string[] = [];
  const handlers: Record<string, () => void> = {};
  const res = {
    writableEnded: false,
    writeHead: () => undefined,
    write: (chunk: string) => { written.push(chunk); return true; },
    end: () => { (res as { writableEnded: boolean }).writableEnded = true; },
    on: (ev: string, fn: () => void) => { handlers[ev] = fn; },
  };
  await controller.events_(s.ws.id, res as never);
  assert.match(written[0], /"type":"hello"/);
  await s.groupchat.post(s.general.id, { text: 'three', authorKind: 'human' });
  const msgEv = written.find((w) => w.includes('"type":"channel_message"') && w.includes('"text":"three"'));
  assert.ok(msgEv, 'the post reached the stream');
  assert.ok(msgEv!.startsWith('data: ') && msgEv!.endsWith('\n\n'));
  handlers.close();
  const n = written.length;
  await s.groupchat.post(s.general.id, { text: 'four', authorKind: 'human' });
  assert.equal(written.length, n, 'unsubscribed on close');
  assert.equal(res.writableEnded, true);
  // the controller's channel view carries members, spend and org mode
  const view = await controller.get(s.ws.id, 'general');
  assert.equal(view.orgMode, false);
  assert.ok(Array.isArray(view.members));
  assert.equal(typeof view.spentToday, 'number');
});

test('workspace search finds channel messages through the FTS index, private channels only for members', async () => {
  const s = await setup();
  const search = new SearchService(s.db, s.stub);
  await s.groupchat.post(s.general.id, { text: 'The quarterly roadmap review is on Thursday', authorKind: 'human' });
  const secret = await s.groupchat.create(s.ws.id, { name: 'Secret', kind: 'private' });
  await s.groupchat.post(secret.id, { text: 'roadmap secrets inside', authorKind: 'human' });
  const res = await search.search(s.ws.id, 'roadmap');
  assert.equal(res.channelMessages.length, 2, 'the owner belongs to both');
  const hit = res.channelMessages.find((m) => m.slug === 'general')!;
  assert.match(hit.snippet, /roadmap/);
  assert.equal(hit.authorKind, 'human');
  const bob: Viewer = { memberAccountId: 'bob', role: 'member', workspaceId: s.ws.id, displayName: 'Bob' };
  const forBob = await runWithViewer('single', bob, () => search.search(s.ws.id, 'roadmap'));
  assert.deepEqual(forBob.channelMessages.map((m) => m.slug), ['general']);
  assert.deepEqual((await search.search(s.ws.id, 'nonexistentword')).channelMessages, []);
});

// ---- 10. Telegram ----

test('a paired Telegram chat posts into a channel with `#slug text`; unknown channels are told so', async () => {
  const s = await setup((me) => say(`${me} saw it`));
  const scout = await s.agents.create({ name: 'Scout' });
  await s.groupchat.addMember(s.general.id, { kind: 'agent', id: scout.id });
  const sent: Array<{ chat_id: number; text: string }> = [];
  const tg = new TelegramService(s.config, s.settings, s.agents, s.workspaces, s.repo, s.turns, undefined, undefined, s.groupchat);
  tg.fetchFn = (async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).endsWith('sendMessage')) sent.push(JSON.parse(String(init?.body)) as { chat_id: number; text: string });
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
  }) as typeof fetch;
  const { code } = tg.mintPairCode();
  await tg.handleUpdate({ update_id: 1, message: { chat: { id: 7 }, text: `/pair ${code}` } });
  await tg.handleUpdate({ update_id: 2, message: { chat: { id: 7 }, text: '#general hello from the road @scout' } });
  assert.match(sent.at(-1)!.text, /Posted to #general/);
  await s.runtime.idle();
  const msgs = (await s.groupchat.messages(s.general.id)).messages;
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].authorKind, 'human');
  assert.equal(msgs[0].text, 'hello from the road @scout');
  assert.equal((await s.groupchat.messages(s.general.id, { thread: msgs[0].id })).messages[1].text, 'Scout saw it', 'the mention woke Scout');
  await tg.handleUpdate({ update_id: 3, message: { chat: { id: 7 }, text: '#nope hello' } });
  assert.match(sent.at(-1)!.text, /Could not post to #nope/);
  // a mention event renders with the channel deep link in the sweep
  await s.groupchat.post(s.general.id, { text: 'ping @owner', authorKind: 'agent', authorId: scout.id });
  const ev = (await s.db.select().from(agentEvents)).find((e) => e.kind === 'mention');
  assert.ok(ev, 'the owner (handle "owner") was mentioned');
  const delivered = await tg.deliverSweep();
  assert.ok(delivered >= 1);
  assert.match(sent.at(-1)!.text, /#general · Scout mentioned you/);
  assert.match(sent.at(-1)!.text, /https:\/\/app\.example\/#\/ws\/[\w-]+\/channel\/general\/[\w-]+/);
  // sanity: the channel row carries the folder the files tab lists
  assert.deepEqual(await s.groupchat.files(s.general.id), []);
  assert.equal((await s.db.select().from(channelMessages)).every((m) => m.accountId === 'single'), true);
});

// ---- 11. organization mode announces into #company (item 16 ↔ 15) ----

test('enabling organization mode and an autonomous action announce into #company, which the group chat creates on first use', async () => {
  const db = await testDb();
  const { stub } = memStorage();
  const bus = new TriggerBus();
  const agents = new AgentsService(db, stub, bus);
  const workspaces = new WorkspacesService(db, stub);
  const repo = new ChatsRepository(db);
  const provider = new ReplyProvider(() => say('ok'));
  const turns = new TurnLoopService(repo, new ChatLocks(), new ToolsService(stub), ctxStub(provider), skillsStub(), stub, mcpStub(), agents, workspaces);
  const config = { get: (k: string) => (k === 'companiesEnabled' ? true : k === 'loopsEnabled' ? false : undefined) } as unknown as ConfigService;
  const announcer = new OrgAnnouncer(); // nothing bound yet: the org module alone
  assert.equal(announcer.bound, false);
  const audit = new OrgAuditService(db);
  const org = new OrgService(db, agents, audit, bus);
  const tasks = new OrgTasksService(db, org, audit, bus);
  const approvals = new OrgApprovalsService(db, org, tasks, agents, audit, undefined, bus);
  const brief = new OrgBriefService(db, org, tasks, approvals, audit, agents, workspaces);
  const runtime = new OrgRuntimeService(db, org, tasks, approvals, audit, brief, turns, repo, agents, workspaces, config, announcer, bus);
  const mode = new OrgModeService(org, workspaces, agents, runtime, approvals, audit, announcer);
  // the group chat binds itself into the seam (what GroupChatModule does at boot)
  const groupchat = new GroupChatService(db, workspaces, agents, stub, new WorkspaceEventBus(), config, undefined, bus, org, tasks, announcer);
  assert.equal(announcer.bound, true);
  const ws = (await workspaces.list())[0];
  const chief = await agents.create({ name: 'Chief', charter: 'You run the company.' });
  await agents.create({ name: 'Writer' });
  assert.equal((await groupchat.list(ws.id)).some((c) => c.slug === COMPANY_SLUG), false, 'no #company before org mode');

  await mode.setMode(ws.id, { mode: 'autonomous', chiefOfStaffAgentId: chief.id, monthlyUsd: 20, agentCap: 5 });
  const company = await groupchat.bySlug(ws.id, COMPANY_SLUG);
  assert.equal(company.slug, 'company');
  const members = await groupchat.members(company.id);
  assert.ok(members.some((m) => m.memberKind === 'agent' && m.memberId === chief.id), 'every agent is in #company');
  assert.ok(members.some((m) => m.memberKind === 'human' && m.memberId === 'single'), 'and the owner');
  let msgs = (await groupchat.messages(company.id)).messages;
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].authorKind, 'system');
  assert.match(msgs[0].text, /^Organization mode is on \(autonomous\)\. Chief is chief of staff/);

  // an autonomous structural action lands there too
  const session = await repo.createSession({ workspaceId: ws.id, agentId: chief.id, name: 'chief chat' });
  await runtime.execute(session, 'org_hire_agent', { templateOrPack: 'Marketer', title: 'Growth', why: 'Launch posts have no owner.' });
  msgs = (await groupchat.messages(company.id)).messages;
  assert.equal(msgs.length, 2);
  assert.match(msgs[1].text, /^Hired: Marketer as Growth/);
  // make-task now routes to the organisation board, linked both ways
  const general = await groupchat.bySlug(ws.id, GENERAL_SLUG);
  await groupchat.addMember(general.id, { kind: 'agent', id: chief.id });
  const root = await groupchat.post(general.id, { text: 'Draft the launch plan', authorKind: 'human' });
  const made = await groupchat.makeTask(general.id, root.id, { assigneeAgentId: chief.id, by: { kind: 'human', id: 'single' } });
  assert.equal(made.kind, 'org');
  const orgTask = await tasks.get((await org.byWorkspace(ws.id))!.id, made.task.id);
  assert.equal(orgTask.channelId, general.id);
  assert.equal(orgTask.messageId, root.id);
  assert.equal(orgTask.assigneeAgentId, chief.id);
  // switching mode off announces, again into the same channel
  await mode.setMode(ws.id, { mode: 'off' });
  msgs = (await groupchat.messages(company.id)).messages;
  assert.match(msgs.at(-1)!.text, /Organization mode is off/);
  assert.equal((await db.select().from(channels)).filter((c) => c.slug === 'company').length, 1, 'created once');
});
