/** Follows (docs/follows.md): auto-follow on every trigger (threads, org
 *  tasks, kanban tasks), manual follow / unfollow that sticks against
 *  auto-follow, activity fanned out to everyone but the actor, people's
 *  inbox events, the heartbeat's "Following" section and its gated,
 *  debounced reason (never on top of a mention), the closed-task window,
 *  the tools (classed read, no approval) and workspace scoping. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import { runPgMigrations } from '../server/src/database/migrator';
import { agentEvents, follows, organizations } from '../server/src/database/schema';
import { testDb, memStorage, ctxStub, skillsStub, mcpStub, pgliteQueryable, ScriptedProvider } from './helpers';
import { ChatsRepository } from '../server/src/chats/chats.repository';
import { TurnLoopService, type TurnEvent } from '../server/src/chats/turn-loop.service';
import { ChatLocks } from '../server/src/chats/chat-locks';
import { ToolsService } from '../server/src/chats/tools.service';
import { TriggerBus } from '../server/src/chats/trigger-bus';
import { LoopsService } from '../server/src/chats/loops.service';
import { HeartbeatService } from '../server/src/chats/heartbeat.service';
import { DistillService } from '../server/src/chats/distill.service';
import { AgentMemoryService } from '../server/src/agents/agent-memory.service';
import { AgentsService } from '../server/src/agents/agents.service';
import { WorkspacesService } from '../server/src/workspaces/workspaces.service';
import type { StorageService } from '../server/src/storage/storage.service';
import { GroupChatService, GENERAL_SLUG } from '../server/src/groupchat/groupchat.service';
import { WorkspaceEventBus } from '../server/src/groupchat/workspace-events';
import { OrgAuditService } from '../server/src/org/org-audit.service';
import { OrgService } from '../server/src/org/org.service';
import { OrgTasksService } from '../server/src/org/org-tasks.service';
import { FollowsService, orgTaskLink, type Follower } from '../server/src/follows/follows.service';
import { FollowsTools, FOLLOW_TOOLS } from '../server/src/follows/follows.tools';
import { FollowsController } from '../server/src/follows/follows.controller';
import { FOLLOW_TUNABLES } from '../server/src/follows/follow-tunables';
import { classOf, unclassified } from '../server/src/actions/action-classes';
import { TUNABLES } from '../server/src/org/org-tunables';
import type { AiStreamEvent } from '../server/src/ai/ai-provider.interface';
import { setAddressLookup } from '../server/src/common/url-guard';

setAddressLookup(async () => [{ address: '93.184.216.34', family: 4 }]);

const answer: AiStreamEvent[] = [{ type: 'answer', text: 'Checked.' }, { type: 'done' }];

async function setup(rounds: AiStreamEvent[][] = [answer, answer, answer, answer]) {
  const db = await testDb();
  const { stub } = memStorage();
  const bus = new TriggerBus();
  const followsSvc = new FollowsService(db);
  const agents = new AgentsService(db, stub, bus, undefined, followsSvc);
  const workspaces = new WorkspacesService(db, stub);
  const repo = new ChatsRepository(db);
  const provider = new ScriptedProvider(rounds);
  const turns = new TurnLoopService(repo, new ChatLocks(), new ToolsService(stub), ctxStub(provider), skillsStub(), stub, mcpStub(), agents, workspaces);
  const tools = new FollowsTools(followsSvc, turns);
  tools.onModuleInit();
  const config = { get: (k: string) => (k === 'companiesEnabled' ? true : undefined) } as unknown as ConfigService;
  const groupchat = new GroupChatService(db, workspaces, agents, stub, new WorkspaceEventBus(), config, undefined, bus);
  groupchat.follows = followsSvc;
  const audit = new OrgAuditService(db);
  const org = new OrgService(db, agents, audit);
  const tasks = new OrgTasksService(db, org, audit, bus, undefined, agents, followsSvc);
  const distill = new DistillService(repo, ctxStub(provider), agents, new AgentMemoryService(db, stub as unknown as StorageService));
  const loops = new LoopsService(agents, workspaces, repo, turns, distill, config);
  const heartbeat = new HeartbeatService(db, agents, workspaces, loops, config, undefined, followsSvc);
  const ws = (await workspaces.list())[0];
  const general = await groupchat.bySlug(ws.id, GENERAL_SLUG);
  return { db, stub, agents, workspaces, repo, turns, provider, groupchat, org, tasks, heartbeat, follows: followsSvc, ws, general };
}
type S = Awaited<ReturnType<typeof setup>>;

const agent = (id: string): Follower => ({ kind: 'agent', id });
const USER: Follower = { kind: 'user', id: 'single' };

async function rowOf(s: S, who: Follower, targetId: string) {
  return (await s.db.select().from(follows).where(eq(follows.targetId, targetId))).find((r) => r.followerKind === who.kind && r.followerId === who.id);
}

async function company(s: S) {
  const o = await s.org.create({ workspaceId: s.ws.id, name: 'Acme', mission: 'Ship.', chief: { name: 'Chief', charter: 'You run Acme.' } });
  const writer = await s.agents.create({ name: 'Writer', workspaceId: s.ws.id });
  const editor = await s.agents.create({ name: 'Editor', workspaceId: s.ws.id });
  await s.org.addMember(o.id, { agentId: writer.id, reportsToAgentId: o.chiefOfStaffAgentId });
  await s.org.addMember(o.id, { agentId: editor.id, reportsToAgentId: o.chiefOfStaffAgentId });
  return { o, chief: o.chiefOfStaffAgentId!, writer, editor };
}

test('migration 0048 creates follows with its unique key and is idempotent', async () => {
  const pg = new PGlite();
  const q = pgliteQueryable(pg);
  await runPgMigrations(q, { log: () => {} });
  await runPgMigrations(q, { log: () => {} });
  const cols = (await q.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'follows'`)).rows.map((r) => (r as { column_name: string }).column_name);
  for (const c of ['workspaceId', 'followerKind', 'followerId', 'targetKind', 'targetId', 'reason', 'createdAt', 'mutedAt', 'lastSeenAt', 'accountId']) assert.ok(cols.includes(c), c);
  await q.query(`INSERT INTO follows ("id", "workspaceId", "followerKind", "followerId", "targetKind", "targetId", "createdAt") VALUES ('f1', 'w', 'agent', 'a', 'thread', 't', 'now')`);
  await assert.rejects(q.query(`INSERT INTO follows ("id", "workspaceId", "followerKind", "followerId", "targetKind", "targetId", "createdAt") VALUES ('f2', 'w', 'agent', 'a', 'thread', 't', 'now')`));
  assert.equal((await q.query(`SELECT "id" FROM __migrations WHERE "id" = '0048-follows'`)).rows.length, 1);
  await pg.close();
});

test('threads: the starter, repliers and mentioned agents follow; a reply reaches every follower but its author; people get one inbox event per target', async () => {
  const s = await setup();
  const scout = await s.agents.create({ name: 'Scout', workspaceId: s.ws.id });
  const atlas = await s.agents.create({ name: 'Atlas', workspaceId: s.ws.id });
  await s.groupchat.addMember(s.general.id, { kind: 'agent', id: scout.id });
  await s.groupchat.addMember(s.general.id, { kind: 'agent', id: atlas.id });
  // a top-level post without a mention follows nothing (no thread yet)
  const lone = await s.groupchat.post(s.general.id, { text: 'Morning all', authorKind: 'human' });
  assert.equal((await s.follows.followersOf('thread', lone.id)).length, 0);
  // a mention: the starter and the mentioned agent follow at once
  const root = await s.groupchat.post(s.general.id, { text: '@Scout can you look at the launch plan?', authorKind: 'human' });
  assert.equal((await rowOf(s, USER, root.id))?.reason, 'started');
  assert.equal((await rowOf(s, agent(scout.id), root.id))?.reason, 'mentioned');
  // Atlas replies: it follows as a commenter, the others count one new reply
  await s.groupchat.post(s.general.id, { text: 'I drafted one in shared/plan.md', threadRootId: root.id, authorKind: 'agent', authorId: atlas.id });
  const a1 = (await rowOf(s, agent(atlas.id), root.id))!;
  assert.equal(a1.reason, 'commented');
  assert.equal(a1.unseenCount, 0, 'the actor is never notified of its own reply');
  const sc1 = (await rowOf(s, agent(scout.id), root.id))!;
  assert.equal(sc1.unseenCount, 1);
  assert.equal(sc1.lastActorName, 'Atlas');
  assert.equal(sc1.attentionAt, null, 'a plain reply wakes nobody');
  assert.equal((await rowOf(s, USER, root.id))!.unseenCount, 1);
  // replying to a reply stays in the root's thread
  const reply = (await s.groupchat.messages(s.general.id, { thread: root.id })).messages.at(-1)!;
  await s.groupchat.post(s.general.id, { text: '@Scout please check the numbers', threadRootId: reply.id, authorKind: 'agent', authorId: atlas.id });
  const sc2 = (await rowOf(s, agent(scout.id), root.id))!;
  assert.equal(sc2.unseenCount, 2);
  assert.equal(sc2.attentionAt, null, 'the mention already wakes Scout: no follow wake on top');
  // the person: one follow event for the thread until they look again
  const evs = (await s.db.select().from(agentEvents)).filter((e) => e.kind === 'follow');
  assert.equal(evs.length, 1);
  assert.equal(evs[0].agentId, `follow:${s.ws.id}`);
  assert.match(evs[0].title, /Following · #general: @Scout can you look/);
  assert.match(JSON.parse(evs[0].payload).link, new RegExp(`#/ws/${s.ws.id}/channel/general/${root.id}`));
  // the person replies: they have seen it; the agents count it
  await s.groupchat.post(s.general.id, { text: 'Thanks both', threadRootId: root.id, authorKind: 'human' });
  assert.equal((await rowOf(s, USER, root.id))!.unseenCount, 0);
  assert.equal((await rowOf(s, agent(atlas.id), root.id))!.unseenCount, 1);
  // system lines are not activity
  await s.groupchat.postSystem(s.general.id, 'Task created', root.id);
  assert.equal((await rowOf(s, agent(atlas.id), root.id))!.unseenCount, 1);
});

test('org tasks: creator, assignee, reviewer, commenters and re-assignees follow; status changes need the followers; done closes', async () => {
  const s = await setup();
  const { o, chief, writer, editor } = await company(s);
  const t = await s.tasks.create(o.id, { title: 'Write the launch post', assigneeAgentId: writer.id, createdBy: `agent:${chief}` });
  assert.equal((await rowOf(s, agent(chief), t.id))?.reason, 'started');
  assert.equal((await rowOf(s, agent(writer.id), t.id))?.reason, 'assignee');
  // a task the user creates is followed by the user
  const u = await s.tasks.create(o.id, { title: 'Pick a date', createdBy: 'user' });
  assert.equal((await rowOf(s, USER, u.id))?.reason, 'started');
  // the owner comments: it follows (already does) and the chief hears of it
  await s.tasks.comment(o.id, t.id, { text: 'Outline is in shared/', fromAgentId: writer.id });
  const c1 = (await rowOf(s, agent(chief), t.id))!;
  assert.equal(c1.unseenCount, 1);
  assert.equal(c1.attentionAt, null);
  assert.equal((await rowOf(s, agent(writer.id), t.id))!.unseenCount, 0);
  // a comment naming a follower is directed at it — unless the org wake already covers it (the owner)
  await s.tasks.comment(o.id, t.id, { text: '@Chief is the tone right?', fromAgentId: editor.id });
  assert.equal((await rowOf(s, agent(editor.id), t.id))?.reason, 'commented');
  const c2 = (await rowOf(s, agent(chief), t.id))!;
  assert.ok(c2.attentionAt, 'a comment naming the chief needs it');
  assert.match(c2.attention, /Editor addressed you/);
  assert.equal((await rowOf(s, agent(writer.id), t.id))!.attentionAt, null, 'the owner is woken by the org comment wake, not a follow wake');
  // reassign: the new assignee follows
  const other = await s.agents.create({ name: 'Other', workspaceId: s.ws.id });
  await s.org.addMember(o.id, { agentId: other.id, reportsToAgentId: chief });
  await s.tasks.assign(o.id, t.id, other.id, `agent:${chief}`);
  assert.equal((await rowOf(s, agent(other.id), t.id))?.reason, 'assignee');
  // blocked by the owner: everyone else's attention
  await s.tasks.update(o.id, t.id, { status: 'blocked', blockers: ['waits on legal'] }, `agent:${other.id}`);
  const w = (await rowOf(s, agent(writer.id), t.id))!;
  assert.match(w.attention, /blocked: waits on legal/);
  assert.equal((await rowOf(s, agent(other.id), t.id))!.attentionAt, null, 'the actor itself is not told');
  // review: the reviewer follows; the reviewer's wake is the org's, not a follow wake
  await s.tasks.update(o.id, t.id, { status: 'in_progress' }, `agent:${other.id}`);
  await s.tasks.requestReview(o.id, t.id, { fromAgentId: other.id, note: 'ready' });
  const reviewed = await s.tasks.get(o.id, t.id);
  assert.ok(reviewed.reviewerAgentId);
  const rv = (await rowOf(s, agent(reviewed.reviewerAgentId!), t.id))!;
  assert.ok(['reviewer', 'started', 'commented', 'assignee'].includes(rv.reason));
  assert.doesNotMatch(rv.attention, /review requested/, 'the reviewer is woken by the org review wake, not a follow wake');
  const wr = (await rowOf(s, agent(writer.id), t.id))!;
  assert.match(wr.attention, /review requested/);
  // accepted → closed on every row
  await s.tasks.review(o.id, t.id, { verdict: 'accept', byAgentId: reviewed.reviewerAgentId! });
  assert.ok((await rowOf(s, agent(writer.id), t.id))!.closedAt);
  // reopened → open again, and it needs the followers
  await s.tasks.update(o.id, t.id, { status: 'todo' }, 'user');
  const re = (await rowOf(s, agent(writer.id), t.id))!;
  assert.equal(re.closedAt, null);
  assert.match(re.attention, /reopened/);
});

test('kanban tasks: the owning agent and its creator follow; status changes reach the other side', async () => {
  const s = await setup();
  const a = await s.agents.create({ name: 'Atlas', workspaceId: s.ws.id });
  const b = await s.agents.create({ name: 'Boreas', workspaceId: s.ws.id });
  const byUser = await s.agents.addTask(a.id, { title: 'Reply to the vendor', origin: 'user' });
  assert.equal((await rowOf(s, agent(a.id), byUser.id))?.reason, 'owner');
  assert.equal((await rowOf(s, USER, byUser.id))?.reason, 'started');
  const delegated = await s.agents.addTask(a.id, { title: 'Check the numbers', origin: 'agent', createdBy: agent(b.id) });
  assert.equal((await rowOf(s, agent(b.id), delegated.id))?.reason, 'started');
  const own = await s.agents.addTask(a.id, { title: 'Self-noted', origin: 'agent' });
  assert.equal((await s.follows.followersOf('agent_task', own.id)).length, 1, 'its own task: owner only');
  // the agent blocks its task: the user hears, the agent itself does not
  await s.agents.updateTaskByPrefix(a.id, byUser.id.slice(0, 8), { status: 'blocked', reason: 'no reply yet' });
  assert.equal((await rowOf(s, agent(a.id), byUser.id))!.unseenCount, 0);
  const mine = (await rowOf(s, USER, byUser.id))!;
  assert.equal(mine.unseenCount, 1);
  assert.match(mine.lastActivity, /moved to blocked: no reply yet/);
  // the user moves the delegated task to done: Boreas hears and it closes
  await s.agents.updateTask(a.id, delegated.id, { status: 'done' });
  const bo = (await rowOf(s, agent(b.id), delegated.id))!;
  assert.equal(bo.unseenCount, 1);
  assert.ok(bo.closedAt);
});

test('manual follow and unfollow: an unfollow sticks against auto-follow; following again lifts it', async () => {
  const s = await setup();
  const { o, chief, writer, editor } = await company(s);
  const t = await s.tasks.create(o.id, { title: 'Budget review', assigneeAgentId: writer.id, createdBy: `agent:${chief}` });
  const target = await s.follows.resolve(s.ws.id, 'task', t.id.slice(0, 8));
  assert.equal(target.kind, 'org_task');
  await s.follows.unfollow(target, agent(editor.id));
  // Editor comments: auto-follow must not resubscribe it
  await s.tasks.comment(o.id, t.id, { text: 'One question', fromAgentId: editor.id });
  const muted = (await rowOf(s, agent(editor.id), t.id))!;
  assert.ok(muted.mutedAt, 'still unfollowed');
  // and the writer unfollows its own assigned task: activity no longer counts for it
  await s.follows.unfollow(target, agent(writer.id));
  await s.tasks.comment(o.id, t.id, { text: 'Any update?', fromAgentId: chief });
  assert.equal((await rowOf(s, agent(writer.id), t.id))!.unseenCount, 0);
  assert.equal((await s.follows.followersOf('org_task', t.id)).some((r) => r.followerId === writer.id), false);
  // follow again: live, reason kept, counting resumes
  await s.follows.follow(target, agent(writer.id));
  await s.tasks.comment(o.id, t.id, { text: 'Still waiting', fromAgentId: chief });
  const back = (await rowOf(s, agent(writer.id), t.id))!;
  assert.equal(back.mutedAt, null);
  assert.equal(back.unseenCount, 1);
  // a manual follow of something never followed is reason manual
  const u = await s.tasks.create(o.id, { title: 'Unrelated', createdBy: 'user' });
  await s.follows.follow(await s.follows.resolve(s.ws.id, 'task', u.id), agent(editor.id));
  assert.equal((await rowOf(s, agent(editor.id), u.id))?.reason, 'manual');
});

test('heartbeat: a follow needing the agent opens a gated, debounced beat with the "Following" section, then is seen', async () => {
  const s = await setup();
  const { o, chief, writer } = await company(s);
  const t = await s.tasks.create(o.id, { title: 'Draft the brief', assigneeAgentId: writer.id, createdBy: `agent:${chief}` });
  // a plain comment: the chief's digest counts it, but nothing wakes it
  await s.tasks.comment(o.id, t.id, { text: 'Outline posted', fromAgentId: writer.id });
  assert.deepEqual(await s.follows.wakeReasons(chief), []);
  // blocked: a reason for the chief (and only once)
  await s.tasks.update(o.id, t.id, { status: 'blocked', blockers: ['needs the budget figure'] }, `agent:${writer.id}`);
  const now = new Date();
  const res = await s.heartbeat.beat(chief, now);
  assert.equal(res.status, 'ran');
  assert.ok(res.reasons.some((r) => /^Following task [A-Z][A-Z0-9]{1,5}-\d+ "Draft the brief": blocked: needs the budget figure \(Writer\)$/.test(r)), res.reasons.join(' | '));
  const prompt = s.provider.requests[0].messages.map((m) => m.content).join('\n');
  assert.match(prompt, /Following — new since your last beat/);
  assert.match(prompt, /task [A-Z][A-Z0-9]{1,5}-\d+ "Draft the brief": 2 updates, last from Writer — moved to blocked: needs the budget figure/);
  const seen = (await rowOf(s, agent(chief), t.id))!;
  assert.equal(seen.unseenCount, 0, 'the beat read it');
  assert.equal(seen.attentionAt, null);
  assert.ok(seen.wokeAt);
  // a new attention within the debounce window: no follow reason yet
  await s.tasks.update(o.id, t.id, { status: 'todo' }, `agent:${writer.id}`);
  await s.tasks.update(o.id, t.id, { status: 'blocked', blockers: ['still no figure'] }, `agent:${writer.id}`);
  const soon = new Date(now.getTime() + 5 * 60_000);
  assert.deepEqual(await s.follows.wakeReasons(chief, soon), [], 'debounced');
  // after the window it wakes again — the debounce is a tunable the org can move
  const later = new Date(now.getTime() + 31 * 60_000);
  assert.equal((await s.follows.wakeReasons(chief, later)).length, 1);
  await s.db.update(organizations).set({ tunables: JSON.stringify({ 'follow.wakeDebounceMinutes': 0 }) }).where(eq(organizations.id, o.id));
  await s.db.update(follows).set({ wokeAt: null }).where(eq(follows.followerId, chief));
  await s.tasks.update(o.id, t.id, { status: 'todo' }, `agent:${writer.id}`);
  await s.tasks.update(o.id, t.id, { status: 'blocked', blockers: ['and again'] }, `agent:${writer.id}`);
  assert.equal((await s.follows.wakeReasons(chief)).length, 1, 'debounce 0: every beat that finds one');
  assert.equal((await s.follows.wakeReasons(chief)).length, 0, 'but the same change never wakes twice');
});

test('no double wake: a thread mention wakes as today, and the follow adds no reason on top', async () => {
  const s = await setup();
  const scout = await s.agents.create({ name: 'Scout', workspaceId: s.ws.id });
  const atlas = await s.agents.create({ name: 'Atlas', workspaceId: s.ws.id });
  await s.groupchat.addMember(s.general.id, { kind: 'agent', id: scout.id });
  await s.groupchat.addMember(s.general.id, { kind: 'agent', id: atlas.id });
  const root = await s.groupchat.post(s.general.id, { text: 'Plan for Q3', authorKind: 'human' });
  await s.groupchat.post(s.general.id, { text: 'First thoughts', threadRootId: root.id, authorKind: 'agent', authorId: atlas.id });
  await s.groupchat.post(s.general.id, { text: '@Atlas what about pricing?', threadRootId: root.id, authorKind: 'agent', authorId: scout.id });
  assert.deepEqual(await s.follows.wakeReasons(atlas.id), [], 'the mention path wakes Atlas; the follow does not');
  const reasons = await s.heartbeat.reasonsFor(atlas.id, { now: new Date(), workspaceId: s.ws.id, tunables: { cron: '*/30 * * * *', dailyRunCap: 12, staleMinutes: 30 }, lastRunAt: null });
  assert.equal(reasons.filter((r) => /^Following /.test(r)).length, 0);
  assert.equal(reasons.filter((r) => /Unanswered mention/.test(r)).length, 1, 'exactly one reason: the mention');
});

test('closed targets stop reporting after the tunable window; the row is kept', async () => {
  const s = await setup();
  const a = await s.agents.create({ name: 'Atlas', workspaceId: s.ws.id });
  const t = await s.agents.addTask(a.id, { title: 'Ship it', origin: 'user' });
  await s.agents.updateTask(a.id, t.id, { status: 'done' });
  const row = (await rowOf(s, agent(a.id), t.id))!;
  assert.ok(row.closedAt);
  assert.equal(row.unseenCount, 1);
  assert.match((await s.follows.digest(a.id)).text, /board task [A-Z][A-Z0-9]{1,5}-\d+ "Ship it": 1 update, last from .* — moved to done \(closed\)/);
  const later = new Date(Date.now() + (FOLLOW_TUNABLES['follow.closedWindowHours'].default + 1) * 3_600_000);
  assert.equal((await s.follows.digest(a.id, later)).text, '', 'past the window: no context');
  assert.ok(await rowOf(s, agent(a.id), t.id), 'the row is kept');
});

test('tools: follow, unfollow and list_follows are classed read and run without approval in an Ask-mode chat', async () => {
  for (const spec of FOLLOW_TOOLS) assert.equal(classOf(spec.name), 'read', spec.name);
  assert.deepEqual(unclassified(FOLLOW_TOOLS.map((t) => t.name)), []);
  for (const k of Object.keys(FOLLOW_TUNABLES)) assert.ok(TUNABLES[k], `${k} is registered`);
  const call = (name: string, input: Record<string, unknown>): AiStreamEvent[] => [{ type: 'tool_call', id: `c-${name}`, name, input }, { type: 'done' }];
  const s = await setup();
  const scout = await s.agents.create({ name: 'Scout', workspaceId: s.ws.id });
  await s.groupchat.addMember(s.general.id, { kind: 'agent', id: scout.id });
  const root = await s.groupchat.post(s.general.id, { text: 'Hiring plan', authorKind: 'human' });
  const reply = await s.groupchat.post(s.general.id, { text: 'Two roles first', threadRootId: root.id, authorKind: 'human' });
  const rounds = [call('follow', { kind: 'thread', id: reply.id.slice(0, 8) }), answer, call('list_follows', {}), answer, call('unfollow', { kind: 'thread', id: root.id }), answer];
  const s2 = { ...s, provider: new ScriptedProvider(rounds) };
  const turns = new TurnLoopService(s.repo, new ChatLocks(), new ToolsService(s.stub), ctxStub(s2.provider), skillsStub(), s.stub, mcpStub(), s.agents, s.workspaces);
  new FollowsTools(s.follows, turns).onModuleInit();
  const session = await s.repo.createSession({ workspaceId: s.ws.id, agentId: scout.id, name: 'chat' });
  assert.equal(session.permissionMode, 'ask');
  const run = async (text: string) => { const out: TurnEvent[] = []; for await (const ev of turns.run(session.id, { text })) out.push(ev); return out; };
  let evs = await run('follow that thread');
  assert.equal(evs.some((e) => e.type === 'approval_required'), false, 'no approval asked');
  const r1 = evs.find((e) => e.type === 'tool_result') as Extract<TurnEvent, { type: 'tool_result' }>;
  assert.equal(r1.isError, false);
  assert.match(r1.output, /Following thread "#general: Hiring plan"/);
  assert.equal((await rowOf(s, agent(scout.id), root.id))?.reason, 'manual', 'a reply id resolves to its thread root');
  evs = await run('what do I follow?');
  assert.match((evs.find((e) => e.type === 'tool_result') as Extract<TurnEvent, { type: 'tool_result' }>).output, /Hiring plan.*\(manual\)/);
  evs = await run('unfollow it');
  assert.equal(evs.some((e) => e.type === 'approval_required'), false);
  assert.ok((await rowOf(s, agent(scout.id), root.id))!.mutedAt);
});

test('workspace scoping: ids resolve only inside the workspace; private channels only for members; lists are per workspace', async () => {
  const s = await setup();
  const other = await s.workspaces.create({ name: 'Other' });
  const there = await s.agents.create({ name: 'There', workspaceId: other.id });
  const scout = await s.agents.create({ name: 'Scout', workspaceId: s.ws.id });
  const root = await s.groupchat.post(s.general.id, { text: 'Secret roadmap', authorKind: 'human' });
  const task = await s.agents.addTask(scout.id, { title: 'Ours', origin: 'user' });
  await assert.rejects(s.follows.resolve(other.id, 'thread', root.id), /no message/);
  await assert.rejects(s.follows.resolve(other.id, 'task', task.id), /no task/);
  assert.equal((await s.follows.resolve(s.ws.id, 'task', task.id.slice(0, 8))).kind, 'agent_task');
  // a private channel's thread resolves for a member only
  const priv = await s.groupchat.create(s.ws.id, { name: 'leads', kind: 'private', agentIds: [] });
  const secret = await s.groupchat.post(priv.id, { text: 'Comp bands', authorKind: 'human' });
  await assert.rejects(s.follows.resolve(s.ws.id, 'thread', secret.id, scout.id), /no message/);
  await s.groupchat.addMember(priv.id, { kind: 'agent', id: scout.id });
  assert.equal((await s.follows.resolve(s.ws.id, 'thread', secret.id, scout.id)).id, secret.id);
  // the tool in the other workspace's session cannot reach this one
  const tools = new FollowsTools(s.follows);
  const session = await s.repo.createSession({ workspaceId: other.id, agentId: there.id, name: 'x' });
  await assert.rejects(tools.execute(session, 'follow', { kind: 'thread', id: root.id }), /no message/);
  assert.equal((await s.follows.list(agent(scout.id), other.id)).length, 0);
  assert.equal((await s.follows.list(agent(scout.id), s.ws.id)).length, 1, 'its own board task');
});

test('people: the controller follows, unfollows and marks seen as the caller, inside the caller\'s workspace only', async () => {
  const s = await setup();
  const ctl = new FollowsController(s.follows, s.db);
  const root = await s.groupchat.post(s.general.id, { text: 'Offsite ideas', authorKind: 'human' });
  let v = await ctl.view(s.ws.id, 'thread', root.id);
  assert.equal(v.following, false);
  v = await ctl.follow(s.ws.id, { targetKind: 'thread', targetId: root.id });
  assert.equal(v.following, true);
  assert.deepEqual(v.followers.map((f) => [f.followerKind, f.followerId, f.reason]), [['user', 'single', 'manual']]);
  const atlas = await s.agents.create({ name: 'Atlas', workspaceId: s.ws.id });
  await s.groupchat.addMember(s.general.id, { kind: 'agent', id: atlas.id });
  await s.groupchat.post(s.general.id, { text: 'A lake?', threadRootId: root.id, authorKind: 'agent', authorId: atlas.id });
  assert.equal((await rowOf(s, USER, root.id))!.unseenCount, 1);
  await ctl.seen(s.ws.id, { targetKind: 'thread', targetId: root.id });
  assert.equal((await rowOf(s, USER, root.id))!.unseenCount, 0);
  assert.equal((await ctl.mine(s.ws.id)).length, 1);
  v = await ctl.unfollow(s.ws.id, { targetKind: 'thread', targetId: root.id });
  assert.equal(v.following, false);
  assert.deepEqual(v.followers.map((f) => f.followerId), [atlas.id]);
  await assert.rejects(ctl.view('nope', 'thread', root.id), /workspace nope/);
});

test('task links: an org task follow links to the task itself (the board with its drawer); old board links are brought up to date', async () => {
  const s = await setup();
  const { o, writer } = await company(s);
  assert.equal(orgTaskLink('ws1', 'abc-123'), '#/ws/ws1/org/board?task=abc-123');
  const t = await s.tasks.create(o.id, { title: 'Ship the page', assigneeAgentId: writer.id, createdBy: 'user' });
  const mine = (await rowOf(s, USER, t.id))!;
  assert.equal(mine.link, `#/ws/${s.ws.id}/org/board?task=${t.id}`);
  // a row written before the deep link existed carries the bare board link
  await s.db.update(follows).set({ link: `#/ws/${s.ws.id}/org/board` }).where(eq(follows.id, mine.id));
  await s.tasks.comment(o.id, t.id, { text: 'Draft is up', fromAgentId: writer.id });
  assert.equal((await rowOf(s, USER, t.id))!.link, `#/ws/${s.ws.id}/org/board?task=${t.id}`);
  // the person's inbox event carries the task link
  const evs = (await s.db.select().from(agentEvents).where(eq(agentEvents.agentId, `follow:${s.ws.id}`))).filter((e) => e.kind === 'follow');
  assert.ok(evs.length >= 1);
  assert.equal(JSON.parse(evs.at(-1)!.payload).link, `#/ws/${s.ws.id}/org/board?task=${t.id}`);
});
