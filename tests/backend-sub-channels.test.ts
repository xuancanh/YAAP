/**
 * Sub-channels (docs/group-chat.md §9): temporary child channels for
 * discussions and meetings. The model and migration 0082; create, close and
 * reopen by people (the HTTP surface) and by agents (channel_start_discussion
 * / channel_close_discussion, rate-limited); the parent's link card updated in
 * place; membership and visibility inherited from the parent; the rail's
 * listing (open subs listed, closed ones counted as past); read-only once
 * closed; follows and the one close notification; the idle sweep; and the
 * runtime's answer to an agent ping-pong in a channel thread (suggest, or
 * move into a discussion where the wake rules and the chain cap still hold).
 * Meetings running in a sub-channel are in backend-org-meetings.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { ConfigService } from '@nestjs/config';
import { and, eq } from 'drizzle-orm';
import * as schema from '../server/src/database/schema';
import { agentEvents, channels, follows } from '../server/src/database/schema';
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
import type { SharedService } from '../server/src/shared/shared.service';
import { FollowsService } from '../server/src/follows/follows.service';
import { GroupChatService, GENERAL_SLUG } from '../server/src/groupchat/groupchat.service';
import { ChannelRuntimeService, PAUSED_LINE, SUGGEST_LINE_PREFIX, discussionTitle } from '../server/src/groupchat/channel-runtime.service';
import { GroupChatController } from '../server/src/groupchat/groupchat.controller';
import { WorkspaceEventBus, type WorkspaceEvent } from '../server/src/groupchat/workspace-events';
import { DISCUSSION_TUNABLES, deriveDiscussionTunables } from '../server/src/groupchat/discussion-tunables';
import { runsFreely } from '../server/src/actions/action-classes';
import { deriveOperatingSystem, planValue } from '../server/src/org/chief-os';
import type { AiProvider, AiRequest, AiStreamEvent } from '../server/src/ai/ai-provider.interface';

const whoAmI = (req: AiRequest): string => /([^,.;:]+?) \(agent, you\)/.exec(req.system ?? '')?.[1]?.trim() ?? 'agent';
const lastUser = (req: AiRequest): string => [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';

class ReplyProvider implements AiProvider {
  readonly name = 'scripted';
  readonly requests: AiRequest[] = [];
  constructor(private readonly plan: (me: string, text: string, req: AiRequest) => AiStreamEvent[]) {}
  async *stream(req: AiRequest): AsyncGenerator<AiStreamEvent> {
    this.requests.push(req);
    for (const ev of this.plan(whoAmI(req), lastUser(req), req)) yield ev;
    yield { type: 'usage', inputTokens: 100, outputTokens: 50 };
    yield { type: 'done' };
  }
}
const say = (text: string): AiStreamEvent[] => [{ type: 'answer', text }];

/** One member, Bob, besides the owner (Alice). */
function sharedStub(workspaceId: string, owner: string): SharedService {
  const bob = { id: 'm1', workspaceId, memberAccountId: 'bob', role: 'member', displayName: 'Bob', email: 'bob@example.com', invitedBy: '', joinedAt: '', accountId: owner };
  return {
    hasMembers: async () => true,
    members: async () => [bob],
    member: async (_ws: string, id: string) => (id === 'bob' ? bob : null),
    displayNames: async () => new Map([[owner, 'Alice'], ['bob', 'Bob']]),
    nameOf: async (_ws: string, actor: string) => (actor === 'bob' ? 'Bob' : 'Alice'),
    allowedSources: async () => new Set<string>(),
    mayFlow: async () => false,
    channels: async () => [],
  } as unknown as SharedService;
}

async function setup(plan: (me: string, text: string, req: AiRequest) => AiStreamEvent[] = () => say('ok')) {
  const db = await testDb();
  const { stub } = memStorage();
  const bus = new TriggerBus();
  const agents = new AgentsService(db, stub, bus);
  const workspaces = new WorkspacesService(db, stub);
  const repo = new ChatsRepository(db);
  const provider = new ReplyProvider(plan);
  const turns = new TurnLoopService(repo, new ChatLocks(), new ToolsService(stub), ctxStub(provider), skillsStub(), stub, mcpStub(), agents, workspaces);
  const events = new WorkspaceEventBus();
  const settings = new SettingsService(db);
  const config = { get: (k: string) => (k === 'publicAppUrl' ? 'https://app.example' : undefined) } as unknown as ConfigService;
  const shared = sharedStub('', 'single');
  const followsSvc = new FollowsService(db);
  const groupchat = new GroupChatService(db, workspaces, agents, stub, events, config, shared, bus, undefined, undefined, undefined, undefined, followsSvc);
  const ws = (await workspaces.list())[0];
  const runtime = new ChannelRuntimeService(db, groupchat, turns, repo, agents, workspaces, events, undefined, settings, shared);
  const controller = new GroupChatController(groupchat, runtime, events, workspaces);
  const log: WorkspaceEvent[] = [];
  events.subscribe(ws.id, (ev) => log.push(ev));
  const general = await groupchat.bySlug(ws.id, GENERAL_SLUG);
  const scout = await agents.create({ name: 'Scout' });
  const writer = await agents.create({ name: 'Writer' });
  await groupchat.addMember(general.id, { kind: 'agent', id: scout.id });
  await groupchat.addMember(general.id, { kind: 'agent', id: writer.id });
  await groupchat.addMember(general.id, { kind: 'human', id: 'bob' });
  return { db, agents, workspaces, repo, turns, provider, events, groupchat, runtime, controller, ws, general, log, scout, writer, follows: followsSvc };
}
type S = Awaited<ReturnType<typeof setup>>;

const bob: Viewer = { memberAccountId: 'bob', role: 'member', workspaceId: '', displayName: 'Bob' };
const ownerReq = { accountId: 'single' } as never;
const asBob = <T>(s: S, fn: () => Promise<T>) => runWithViewer('single', { ...bob, workspaceId: s.ws.id }, fn);
const top = async (s: S, channelId: string) => (await s.groupchat.messages(channelId)).messages;

// ---- 1. model and migration ----

test('migration 0082 adds the sub-channel columns idempotently; existing channels are ordinary open channels; old thread meetings keep no parent', async () => {
  const pg = new PGlite();
  const q = pgliteQueryable(pg);
  await runPgMigrations(q, { log: () => {} });
  const db = scopeDb(drizzle(pg, { schema }) as unknown as DrizzleDb);
  const { stub } = memStorage();
  const gc = new GroupChatService(db, new WorkspacesService(db, stub), new AgentsService(db, stub), stub, new WorkspaceEventBus());
  await db.insert(schema.workspaces).values({ id: 'w1', name: 'W', color: '#fff', memory: '', profile: '', profilePending: '[]', profilePrivate: '{}', quietHours: '', spendBudgetTokens: 0, spendMonth: '', spendTokens: 0, createdAt: new Date().toISOString() });
  const general = await gc.ensureGeneral('w1');
  assert.equal(general.channelKind, 'channel'); assert.equal(general.status, 'open'); assert.equal(general.parentChannelId, null); assert.equal(general.purpose, '');
  // replaying the migration changes nothing
  await q.query(`DELETE FROM __migrations WHERE "id" = '0082-sub-channels'`);
  await runPgMigrations(q, { log: () => {} });
  const row = (await db.select().from(channels).where(eq(channels.id, general.id)))[0];
  assert.equal(row.channelKind, 'channel'); assert.equal(row.linkMessageId, null);
  const cols = (await q.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'org_meetings' AND column_name = 'parentChannelId'`)).rows;
  assert.equal(cols.length, 1);
});

// ---- 2. people: start, link card, inheritance, close, reopen ----

test('a person starts a discussion: the parent\'s members and visibility, a folder under the parent\'s, ONE link card updated in place; closed it is read-only, folds into Past discussions and reopens', async () => {
  const s = await setup();
  const before = (await top(s, s.general.id)).length;
  const sub = await s.controller.startSub(s.ws.id, GENERAL_SLUG, { title: 'Launch copy review', reason: 'Too long for a thread' }, ownerReq);
  assert.equal(sub.channelKind, 'sub'); assert.equal(sub.parentChannelId, s.general.id); assert.equal(sub.purpose, 'discussion'); assert.equal(sub.status, 'open');
  assert.equal(sub.slug, 'discuss-launch-copy-review'); assert.equal(sub.name, 'Launch copy review');
  assert.equal(sub.folder, 'channels/general/sub/discuss-launch-copy-review');
  assert.equal(sub.kind, 'public', 'a public parent → a public discussion');
  const members = await s.groupchat.members(sub.id);
  assert.deepEqual(members.map((m) => `${m.memberKind}:${m.memberId}`).sort(), (await s.groupchat.members(s.general.id)).map((m) => `${m.memberKind}:${m.memberId}`).sort(), 'the parent\'s members by default');
  assert.equal(members.find((m) => m.memberId === 'single')!.role, 'owner', 'the starter owns it');
  // the parent got exactly one message: the link card
  const after = await top(s, s.general.id);
  assert.equal(after.length, before + 1);
  const card = after.at(-1)!;
  assert.equal(card.id, sub.linkMessageId); assert.equal(card.authorKind, 'system');
  assert.match(card.text, /^🗣 Discussion: Launch copy review · 4 members · live · #discuss-launch-copy-review$/);
  assert.deepEqual(JSON.parse(card.attachments), [{ path: `subchannel/${sub.id}`, kind: 'subchannel' }]);
  // the sub-channel opens with why it exists
  assert.match((await top(s, sub.id))[0].text, /^Alice started this discussion from #general: Too long for a thread/);
  // the rail: open subs are listed beside their parent
  const list = await s.groupchat.list(s.ws.id);
  assert.ok(list.some((c) => c.id === sub.id && c.parentChannelId === s.general.id));
  assert.equal(list.find((c) => c.id === s.general.id)!.pastSubs, 0);
  const detail = await s.controller.get(s.ws.id, sub.slug);
  assert.equal(detail.parent!.slug, GENERAL_SLUG);
  assert.equal((await s.controller.get(s.ws.id, GENERAL_SLUG)).subs.length, 1);
  // activity: posts land in the sub-channel; the card is rewritten in place, not reposted
  await s.groupchat.post(sub.id, { text: 'First draft attached', authorKind: 'human' });
  await s.groupchat.subs.refreshCard(sub.id);
  const cardNow = (await top(s, s.general.id)).find((m) => m.id === card.id)!;
  assert.match(cardNow.text, /· live · 1 message · #discuss/);
  assert.ok(cardNow.editedAt, 'edited in place');
  assert.equal((await top(s, s.general.id)).length, before + 1, 'still one message in the parent');
  assert.ok(s.log.some((e) => e.type === 'channel_message' && e.channelId === s.general.id && e.message.id === card.id && /1 message/.test(e.message.text)), 'the parent\'s viewers saw the card change');
  // close: a member who did not start it may not; the starter (the owner) may
  await assert.rejects(asBob(s, () => s.controller.closeSub(s.ws.id, sub.slug, { outcome: 'nope' }, { accountId: 'single', viewer: { memberAccountId: 'bob' } } as never)), /only the person who started it/);
  const closed = await s.controller.closeSub(s.ws.id, sub.slug, { outcome: 'Ship the short version' }, ownerReq);
  assert.equal(closed.status, 'closed'); assert.equal(closed.outcome, 'Ship the short version'); assert.equal(closed.closedBy, 'human:single');
  assert.match((await top(s, s.general.id)).find((m) => m.id === card.id)!.text, /^🗣 Discussion: Launch copy review · 4 members · closed — Ship the short version · #discuss-launch-copy-review$/);
  // read-only for people and agents
  await assert.rejects(s.groupchat.post(sub.id, { text: 'one more thing', authorKind: 'human' }), /closed and read-only/);
  await assert.rejects(s.groupchat.post(sub.id, { text: 'agent too', authorKind: 'agent', authorId: s.scout.id }), /closed and read-only/);
  // folded out of the rail into the parent's past list
  const list2 = await s.groupchat.list(s.ws.id);
  assert.equal(list2.some((c) => c.id === sub.id), false);
  assert.equal(list2.find((c) => c.id === s.general.id)!.pastSubs, 1);
  assert.deepEqual((await s.controller.subs(s.ws.id, GENERAL_SLUG, 'closed')).map((x) => x.slug), ['discuss-launch-copy-review']);
  assert.equal((await s.controller.subs(s.ws.id, GENERAL_SLUG)).length, 0);
  // still readable
  assert.ok((await s.controller.messages(s.ws.id, sub.slug)).messages.length >= 2);
  // reopen: people only
  await assert.rejects(s.groupchat.subs.reopen(sub.id, `agent:${s.scout.id}`), /only a person reopens/);
  const reopened = await s.controller.reopenSub(s.ws.id, sub.slug, ownerReq);
  assert.equal(reopened.status, 'open');
  await s.groupchat.post(sub.id, { text: 'back again', authorKind: 'human' });
  assert.match((await top(s, s.general.id)).find((m) => m.id === card.id)!.text, /· live ·/);
  // one level only
  await assert.rejects(s.groupchat.subs.start(sub.id, { title: 'Nested', createdBy: 'human:single' }), /cannot hold discussions of its own/);
});

test('visibility and membership follow the parent: a private channel\'s discussion is private, members are a subset of the parent\'s, non-members cannot see it; archiving the parent closes its discussions', async () => {
  const s = await setup();
  const secret = await s.groupchat.create(s.ws.id, { name: 'Secret', kind: 'private', agentIds: [s.scout.id] });
  const sub = await s.groupchat.subs.start(secret.id, { title: 'Hush', createdBy: 'human:single', members: [{ kind: 'agent', id: s.scout.id }] });
  assert.equal(sub.kind, 'private');
  assert.deepEqual((await s.groupchat.members(sub.id)).map((m) => m.memberId).sort(), ['single', s.scout.id].sort(), 'the chosen subset plus the starter');
  await assert.rejects(s.groupchat.subs.start(secret.id, { title: 'Leak', createdBy: 'human:single', members: [{ kind: 'agent', id: s.writer.id }] }), /must be a member of #secret/);
  await assert.rejects(s.groupchat.subs.start(secret.id, { title: 'Leak', createdBy: 'human:single', members: [{ kind: 'human', id: 'bob' }] }), /only its members/);
  // Bob is no member: neither the channel nor its discussion exists for him
  await assert.rejects(asBob(s, () => s.groupchat.open(s.ws.id, sub.slug)), /channel #/);
  assert.equal((await asBob(s, () => s.groupchat.list(s.ws.id))).some((c) => c.id === sub.id), false);
  // archiving the parent closes the discussion
  await s.groupchat.archive(secret.id);
  assert.equal((await s.groupchat.get(sub.id)).status, 'closed');
});

// ---- 3. agents: the tools, the caps ----

test('agents start and close discussions with channel_start_discussion / channel_close_discussion: free internal, members from the parent by name, rate-limited per agent per day, closed only by their starter', async () => {
  const s = await setup();
  assert.equal(runsFreely('channel_start_discussion'), true);
  assert.equal(runsFreely('channel_close_discussion'), true);
  const session = await s.runtime.channelSession(s.scout, s.general);
  const names = (await s.runtime.specsFor(session)).map((t) => t.name);
  assert.ok(names.includes('channel_start_discussion') && names.includes('channel_close_discussion'));
  assert.equal(s.runtime.isReadOnly('channel_start_discussion'), false);
  await assert.rejects(s.runtime.execute(session, 'channel_start_discussion', { channel: 'general', title: 'X' }), /reason is required/);
  await assert.rejects(s.runtime.execute(session, 'channel_start_discussion', { channel: 'general', title: 'X', reason: 'y', members: ['Nobody'] }), /not members of #general: Nobody/);
  const root = await s.groupchat.post(s.general.id, { text: 'How should we price the launch?', authorKind: 'human' });
  const out = await s.runtime.execute(session, 'channel_start_discussion', { channel: 'general', title: 'Pricing', reason: 'needs a few rounds', members: ['Writer'], thread: root.id.slice(0, 8) });
  assert.match(out, /Started the discussion "Pricing" as #discuss-pricing with 2 members/);
  const sub = await s.groupchat.bySlug(s.ws.id, 'discuss-pricing');
  assert.equal(sub.createdBy, `agent:${s.scout.id}`); assert.equal(sub.originMessageId, root.id);
  assert.deepEqual((await s.groupchat.members(sub.id)).map((m) => m.memberId).sort(), [s.scout.id, s.writer.id].sort());
  assert.match((await s.groupchat.messages(s.general.id, { thread: root.id })).messages.at(-1)!.text, /Continued in the discussion "Pricing" \(#discuss-pricing\)/);
  // inside it, the agent's prompt knows where it is
  const subSession = await s.runtime.channelSession(s.scout, sub);
  await s.groupchat.post(sub.id, { text: '@scout go', authorKind: 'human' });
  await s.runtime.idle();
  assert.ok(s.provider.requests.some((r) => /a discussion sub-channel #discuss-pricing of #general/.test(r.system ?? '') && /channel_close_discussion/.test(r.system ?? '')));
  // nobody but its starter (or a person) closes it
  const writerSession = await s.runtime.channelSession(s.writer, s.general);
  await assert.rejects(s.runtime.execute(writerSession, 'channel_close_discussion', { channel: sub.slug, outcome: 'done' }), /only the agent that started/);
  assert.match(await s.runtime.execute(subSession, 'channel_close_discussion', { channel: sub.slug, outcome: 'Price at $9' }), /Closed "Pricing"/);
  assert.equal((await s.groupchat.get(sub.id)).outcome, 'Price at $9');
  await assert.rejects(s.runtime.execute(session, 'channel_start_discussion', { channel: sub.slug, title: 'Nested', reason: 'x' }), /already a discussion/);
  // the daily cap (discussion.agentDailyCap, default 3)
  assert.equal(DISCUSSION_TUNABLES['discussion.agentDailyCap'].default, 3);
  await s.runtime.execute(session, 'channel_start_discussion', { channel: 'general', title: 'Two', reason: 'x' });
  await s.runtime.execute(session, 'channel_start_discussion', { channel: 'general', title: 'Three', reason: 'x' });
  await assert.rejects(s.runtime.execute(session, 'channel_start_discussion', { channel: 'general', title: 'Four', reason: 'x' }), /discussion\.agentDailyCap is 3/);
  // people are not limited by it
  assert.ok(await s.groupchat.subs.start(s.general.id, { title: 'Four', createdBy: 'human:single' }));
});

// ---- 4. follows: participants follow; the close is told once ----

test('participants follow the discussion; activity counts for them; closing it reaches each person once with the outcome', async () => {
  const s = await setup();
  const sub = await s.groupchat.subs.start(s.general.id, { title: 'Roadmap', createdBy: 'human:single' });
  const rows = await s.db.select().from(follows).where(and(eq(follows.targetKind, 'channel'), eq(follows.targetId, sub.id)));
  assert.ok(rows.some((r) => r.followerKind === 'user' && r.followerId === 'bob' && r.reason === 'participant'));
  assert.ok(rows.some((r) => r.followerKind === 'agent' && r.followerId === s.scout.id));
  assert.ok(rows.some((r) => r.followerId === 'single' && r.reason === 'started'));
  await s.groupchat.post(sub.id, { text: 'Q1 first', authorKind: 'human' });
  await s.groupchat.post(sub.id, { text: 'then Q2', authorKind: 'human' });
  const bobRow = (await s.db.select().from(follows).where(and(eq(follows.targetId, sub.id), eq(follows.followerId, 'bob'))))[0];
  assert.equal(bobRow.unseenCount, 2);
  const bobEvents = async () => (await s.db.select().from(agentEvents).where(and(eq(agentEvents.kind, 'follow'), eq(agentEvents.forMemberAccountId, 'bob'))));
  assert.equal((await bobEvents()).length, 1, 'one event until Bob looks');
  await s.follows.markSeenFor({ kind: 'user', id: 'bob' }, 'channel', sub.id);
  await s.groupchat.subs.close(sub.id, { by: 'human:single', outcome: 'Q1 then Q2' });
  const events = await bobEvents();
  assert.equal(events.length, 2, 'the close is told once');
  assert.match(events.at(-1)!.body, /closed: Q1 then Q2/);
  assert.match(JSON.parse(events.at(-1)!.payload).link, new RegExp(`#/ws/${s.ws.id}/channel/${sub.slug}`));
  assert.ok((await s.db.select().from(follows).where(eq(follows.targetId, sub.id))).every((r) => r.closedAt), 'every follow knows it closed');
});

// ---- 5. the idle sweep ----

test('an idle discussion closes itself after discussion.autoCloseHours; a fresh one stays open', async () => {
  const s = await setup();
  const old = await s.groupchat.subs.start(s.general.id, { title: 'Stale', createdBy: 'human:single' });
  const fresh = await s.groupchat.subs.start(s.general.id, { title: 'Fresh', createdBy: 'human:single' });
  await s.db.update(channels).set({ lastActivityAt: new Date(Date.now() - 25 * 3_600_000).toISOString() }).where(eq(channels.id, old.id));
  const closed = await s.groupchat.subs.sweep(new Date());
  assert.deepEqual(closed, [old.slug]);
  const o = await s.groupchat.get(old.id);
  assert.equal(o.status, 'closed'); assert.equal(o.closedBy, 'system'); assert.match(o.outcome, /closed after 24 h without a message/);
  assert.equal((await s.groupchat.get(fresh.id)).status, 'open');
  await s.runtime.sweepSubs(new Date()); // the timer's entry point never throws
});

// ---- 6. agent ping-pong in a channel thread ----

test('agents ping-ponging in a channel thread: by default the runtime suggests a discussion once (the chain cap still pauses); with autoMoveMode 2 it moves the conversation into a discussion and the cap applies there', async () => {
  // default: suggest
  const s = await setup((me) => say(me === 'Ping' ? 'your turn @pong' : 'back to you @ping'));
  const ping = await s.agents.create({ name: 'Ping' });
  const pong = await s.agents.create({ name: 'Pong' });
  await s.groupchat.addMember(s.general.id, { kind: 'agent', id: ping.id });
  await s.groupchat.addMember(s.general.id, { kind: 'agent', id: pong.id });
  const root = await s.groupchat.post(s.general.id, { text: '@ping start the plan', authorKind: 'human' });
  await s.runtime.idle();
  const thread = (await s.groupchat.messages(s.general.id, { thread: root.id })).messages;
  assert.equal(thread.filter((m) => m.authorKind === 'agent').length, 3);
  assert.equal(thread.filter((m) => m.text.startsWith(SUGGEST_LINE_PREFIX)).length, 1, 'suggested once');
  assert.equal(thread.at(-1)!.text, PAUSED_LINE);
  assert.equal((await s.groupchat.list(s.ws.id)).some((c) => c.channelKind === 'sub'), false, 'nothing was moved');

  // move: the third agent reply opens a discussion and continues there
  const s2 = await setup((me) => say(me === 'Ping' ? 'your turn @pong' : 'back to you @ping'));
  const ping2 = await s2.agents.create({ name: 'Ping' });
  const pong2 = await s2.agents.create({ name: 'Pong' });
  await s2.groupchat.addMember(s2.general.id, { kind: 'agent', id: ping2.id });
  await s2.groupchat.addMember(s2.general.id, { kind: 'agent', id: pong2.id });
  const real = s2.groupchat.subs.tunable.bind(s2.groupchat.subs);
  s2.groupchat.subs.tunable = async (ws, key) => (key === 'discussion.autoMoveMode' ? 2 : real(ws, key));
  const root2 = await s2.groupchat.post(s2.general.id, { text: '@ping start the plan', authorKind: 'human' });
  await s2.runtime.idle();
  const sub = (await s2.groupchat.list(s2.ws.id)).find((c) => c.channelKind === 'sub')!;
  assert.ok(sub, 'a discussion was opened');
  assert.equal(sub.originMessageId, root2.id); assert.equal(sub.createdBy, 'system');
  assert.equal(sub.name, 'start the plan', 'titled from the thread\'s root');
  const subMembers = (await s2.groupchat.members(sub.id)).map((m) => m.memberId);
  assert.ok(subMembers.includes(ping2.id) && subMembers.includes(pong2.id) && subMembers.includes('single') && !subMembers.includes(s2.scout.id), 'the thread\'s agents and the channel\'s people');
  const parentThread = (await s2.groupchat.messages(s2.general.id, { thread: root2.id })).messages;
  assert.equal(parentThread.filter((m) => m.authorKind === 'agent').length, 3, 'the parent thread stops at the move');
  assert.match(parentThread.at(-1)!.text, /Continued in the discussion "start the plan"/);
  assert.ok(!parentThread.some((m) => m.text === PAUSED_LINE));
  // in the discussion: the carried message, the woken agent, and the chain cap again
  const inSub = await s2.groupchat.stream(sub.id);
  const agentPosts = inSub.filter((m) => m.authorKind === 'agent');
  assert.equal(agentPosts[0].authorId, ping2.id, 'the third reply was carried over as its author');
  assert.ok(agentPosts.length >= 2, 'the mention woke Pong in the discussion');
  assert.ok(inSub.some((m) => m.text === PAUSED_LINE), 'the loop cap holds inside the discussion');
  assert.equal(inSub.filter((m) => m.authorKind === 'agent').length <= 4, true);
  // the parent got the link card at the top level
  assert.ok((await top(s2, s2.general.id)).some((m) => m.id === sub.linkMessageId));
});

// ---- 7. tunables shaped by the profile ----

test('the discussion tunables register on the shared registry and the operating profile shapes them', () => {
  assert.equal(DISCUSSION_TUNABLES['discussion.autoMoveMode'].default, 1, 'conservative: suggest, do not move');
  assert.equal(DISCUSSION_TUNABLES['discussion.autoCloseHours'].default, 24);
  const fast = deriveDiscussionTunables({ stage: 'growth', cultureType: 'adhocracy', speed: true, rigor: false, writing: false });
  assert.equal(fast.find((t) => t.key === 'discussion.autoCloseHours')!.value, 12);
  assert.equal(fast.find((t) => t.key === 'discussion.autoMoveMode')!.value, 2);
  assert.equal(planValue(deriveOperatingSystem({ values: 'compliance, careful process, approval' }), 'discussion.autoCloseHours'), 72);
  assert.equal(discussionTitle('**@Ping** start the plan for Q3 launch\nmore'), 'start the plan for Q3 launch');
});
