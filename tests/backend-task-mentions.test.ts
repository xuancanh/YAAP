/** Mentions in org task comments and briefs (docs/work-tracking.md
 *  "Mentions"): the channel resolver reused unchanged, a tagged agent woken
 *  for the task with its context (and following it), a tagged person given
 *  an inbox event with the deep link (and following it), tags of someone who
 *  cannot see the task refused, no double wake / notification for followers
 *  who are also tagged, the agent ping-pong cap, the tool's `notify` arg and
 *  brief mentions. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import { ChatsRepository } from '../server/src/chats/chats.repository';
import { TurnLoopService } from '../server/src/chats/turn-loop.service';
import { ChatLocks } from '../server/src/chats/chat-locks';
import { ToolsService } from '../server/src/chats/tools.service';
import { TriggerBus, type OrgWakeEvent } from '../server/src/chats/trigger-bus';
import { AgentsService } from '../server/src/agents/agents.service';
import { WorkspacesService } from '../server/src/workspaces/workspaces.service';
import { agentEvents, follows } from '../server/src/database/schema';
import { runPgMigrations } from '../server/src/database/migrator';
import { OrgAuditService } from '../server/src/org/org-audit.service';
import { OrgService } from '../server/src/org/org.service';
import { OrgTasksService } from '../server/src/org/org-tasks.service';
import { OrgApprovalsService } from '../server/src/org/org-approvals.service';
import { OrgBriefService } from '../server/src/org/org-brief.service';
import { OrgRuntimeService } from '../server/src/org/org-runtime.service';
import { OrgAnnouncer } from '../server/src/org/org-announcer';
import { OrgController } from '../server/src/org/org.controller';
import { TaskMentionsService } from '../server/src/org/task-mentions.service';
import { FollowsService } from '../server/src/follows/follows.service';
import { mentionSpans, parseMentions, type MentionableMember } from '../server/src/groupchat/mentions';
import type { SharedService } from '../server/src/shared/shared.service';
import { BUILTIN_SKILLS } from '../server/src/skills/builtin-skills';
import { testDb, memStorage, ctxStub, skillsStub, mcpStub, pgliteQueryable, ScriptedProvider } from './helpers';
import type { AiStreamEvent } from '../server/src/ai/ai-provider.interface';
import { setAddressLookup } from '../server/src/common/url-guard';

setAddressLookup(async () => [{ address: '93.184.216.34', family: 4 }]);

const answer: AiStreamEvent[] = [{ type: 'answer', text: 'Noted.' }, { type: 'done' }];

/** Two people besides the agents: the owner (single) and a member, Bob. */
function sharedStub(): SharedService {
  const names = new Map([['single', 'Ada Owner'], ['m-bob', 'Bob Member']]);
  return {
    displayNames: async () => names,
    members: async () => [{ memberAccountId: 'm-bob', displayName: 'Bob Member', email: 'bob@example.com', role: 'member' }],
    nameOf: async (_w: string, id: string) => names.get(id) ?? id.slice(0, 8),
  } as unknown as SharedService;
}

async function setup(rounds: AiStreamEvent[][] = []) {
  const db = await testDb();
  const { stub } = memStorage();
  const bus = new TriggerBus();
  const followsSvc = new FollowsService(db);
  const agents = new AgentsService(db, stub, bus, undefined, followsSvc);
  const workspaces = new WorkspacesService(db, stub);
  const repo = new ChatsRepository(db);
  const provider = new ScriptedProvider(rounds);
  const turns = new TurnLoopService(repo, new ChatLocks(), new ToolsService(stub), ctxStub(provider), skillsStub(), stub, mcpStub(), agents, workspaces);
  const config = { get: (k: string) => (k === 'companiesEnabled' ? true : k === 'loopsEnabled' ? false : undefined) } as unknown as ConfigService;
  const audit = new OrgAuditService(db);
  const org = new OrgService(db, agents, audit);
  const tasks = new OrgTasksService(db, org, audit, bus, undefined, agents, followsSvc);
  const mentions = new TaskMentionsService(db, org, agents, sharedStub(), bus, followsSvc, config, tasks);
  mentions.onModuleInit();
  const approvals = new OrgApprovalsService(db, org, tasks, agents, audit, undefined, bus);
  const brief = new OrgBriefService(db, org, tasks, approvals, audit, agents, workspaces);
  const runtime = new OrgRuntimeService(db, org, tasks, approvals, audit, brief, turns, repo, agents, workspaces, config, new OrgAnnouncer(), bus);
  runtime.debounceMs = 5;
  const controller = new OrgController(org, tasks, approvals, audit, brief, runtime, config, undefined, undefined, undefined, undefined, undefined, undefined, undefined, mentions);
  const wakes: OrgWakeEvent[] = [];
  bus.onOrgWake((ev) => wakes.push(ev));
  const ws = (await workspaces.list())[0];
  const o = await org.create({ workspaceId: ws.id, name: 'Acme', mission: 'Ship.', chief: { name: 'Chief', charter: 'You run Acme.' } });
  const writer = await agents.create({ name: 'Writer', workspaceId: ws.id });
  const editor = await agents.create({ name: 'Editor in Chief', workspaceId: ws.id });
  await org.addMember(o.id, { agentId: writer.id, reportsToAgentId: o.chiefOfStaffAgentId });
  await org.addMember(o.id, { agentId: editor.id, reportsToAgentId: o.chiefOfStaffAgentId });
  return { db, agents, workspaces, repo, provider, bus, org, tasks, mentions, runtime, controller, follows: followsSvc, wakes, ws, o, chief: o.chiefOfStaffAgentId!, writer, editor };
}
type S = Awaited<ReturnType<typeof setup>>;

const mentionWakes = (s: S) => s.wakes.filter((w) => w.reason === 'mention');
async function followRow(s: S, kind: 'agent' | 'user', id: string, taskId: string) {
  return (await s.db.select().from(follows).where(eq(follows.targetId, taskId))).find((r) => r.followerKind === kind && r.followerId === id);
}
async function eventsOf(s: S, kind: string) {
  return (await s.db.select().from(agentEvents)).filter((e) => e.kind === kind);
}

test('migration 0090 adds mentions and fromUserId to org_messages and is idempotent', async () => {
  const pg = new PGlite();
  const q = pgliteQueryable(pg);
  await runPgMigrations(q, { log: () => {} });
  await runPgMigrations(q, { log: () => {} });
  const cols = (await q.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'org_messages'`)).rows.map((r) => (r as { column_name: string }).column_name);
  assert.ok(cols.includes('mentions') && cols.includes('fromUserId'));
  await pg.close();
});

test('the shared resolver: a task resolves exactly as a channel does (longest name, any script, markdown, handles, aliases)', async () => {
  const pool: MentionableMember[] = [
    { kind: 'agent', id: 't', name: 'Tutor' }, { kind: 'agent', id: 'tl', name: 'Tutor Lead' }, { kind: 'agent', id: 'd', name: 'Đức Anh' },
    { kind: 'human', id: 'h', name: 'Bob Member', aliases: ['bob'] },
  ];
  // the channel behaviour, unchanged
  assert.deepEqual(parseMentions('@Tutor Lead and **@Đức Anh**, cc @bob — not me@x.io', pool).map((m) => m.id), ['tl', 'd', 'h']);
  assert.deepEqual(parseMentions('```\n@Tutor Lead\n```\n@Tutor', pool).map((m) => m.id), ['t'], 'a tag inside a code fence names nobody');
  // the task pool runs through the same spans
  const s = await setup();
  const t = await s.tasks.create(s.o.id, { title: 'Numbers', assigneeAgentId: s.writer.id });
  const pool2 = await s.mentions.mentionables(s.o.id);
  const text = '@Editor in Chief please check, and **@Bob Member** decides; @writer owns it';
  const viaChannel = mentionSpans(text, pool2).flatMap((x) => x.members.map((m) => m.id));
  const viaTask = (await s.mentions.resolve(s.o.id, t, text, { strict: true, authorAgentId: null, authorUserId: 'single' })).map((m) => m.id);
  assert.deepEqual(viaTask, viaChannel);
  assert.deepEqual(viaTask, [s.editor.id, 'm-bob', s.writer.id]);
  // the autocomplete list: members and people, never an outsider
  const outsider = await s.agents.create({ name: 'Outsider', workspaceId: s.ws.id });
  const names = (await s.controller.mentionables(s.o.id)).map((c) => c.name);
  for (const n of ['Chief', 'Writer', 'Editor in Chief', 'Ada Owner', 'Bob Member']) assert.ok(names.includes(n), n);
  assert.ok(!names.includes(outsider.name));
});

test('a tagged agent is woken for the task with its context, answers via org_task_comment without claiming it, and follows the task', async () => {
  const s = await setup([
    [{ type: 'tool_call', id: 'c1', name: 'org_task_comment', input: { text: 'Numbers check out.' } }, { type: 'done' }],
    answer,
  ]);
  const t = await s.tasks.create(s.o.id, { title: 'Q3 numbers', brief: { outcome: 'The Q3 sheet', done_when: 'Totals reconcile' }, assigneeAgentId: s.writer.id, status: 'in_progress' });
  s.wakes.length = 0;
  const c = await s.controller.comment(s.o.id, t.id, { text: '@Editor in Chief can you check the Q3 totals?' });
  assert.deepEqual(JSON.parse(c.mentions), [{ kind: 'agent', id: s.editor.id }], 'resolved mentions are stored on the comment');
  assert.equal(c.fromUserId, 'single');
  assert.deepEqual(mentionWakes(s).map((w) => w.agentId), [s.editor.id]);
  assert.ok(s.wakes.some((w) => w.reason === 'comment' && w.agentId === s.writer.id), 'the owner is woken by the comment as before');
  assert.equal((await followRow(s, 'agent', s.editor.id, t.id))?.reason, 'mentioned');
  // run only the editor's wake
  const r = await s.runtime.runTask(s.o.id, t.id, s.editor.id, 'mention');
  assert.equal(r, 'ran');
  const req = s.provider.requests[0];
  const user = [...req.messages].reverse().find((m) => m.role === 'user')!.content;
  assert.match(user, new RegExp(`MENTIONED on task ${t.key} "Q3 numbers" \\(status: in_progress, owner: Writer\\)`));
  assert.match(user, /by the CEO \(user\): "@Editor in Chief can you check the Q3 totals\?"/);
  assert.match(user, /Task timeline \(newest last\)/);
  assert.match(req.system ?? "", /You were tagged \(@mentioned\) on this task; you are not its owner/);
  assert.match(req.system ?? "", /Done when: Totals reconcile/);
  const tool = req.tools!.find((x) => x.name === 'org_task_comment')!;
  assert.match(tool.description, /never to broadcast/);
  assert.ok((tool.inputSchema as { properties: Record<string, unknown> }).properties.notify, 'the notify arg');
  const after = await s.tasks.get(s.o.id, t.id);
  assert.equal(after.assigneeAgentId, s.writer.id);
  assert.equal(after.claimedBy, null, 'a tagged member never claims the task');
  assert.equal(after.noProgressCount, 0);
  const comments = await s.tasks.messages(s.o.id, { taskId: t.id });
  assert.ok(comments.some((x) => x.fromAgentId === s.editor.id && x.text === 'Numbers check out.'));
  const runs = await s.tasks.runs(s.o.id, { taskId: t.id });
  assert.equal(runs.find((x) => x.agentId === s.editor.id)?.wakeReason, 'mention');
  // its reply wakes the owner (a comment on somebody else's task), nobody else
  assert.ok(s.wakes.some((w) => w.reason === 'comment' && w.agentId === s.writer.id));
});

test('a tagged person gets one addressed inbox event with the task deep link and follows the task', async () => {
  const s = await setup();
  const t = await s.tasks.create(s.o.id, { title: 'Pricing page', assigneeAgentId: s.writer.id, createdBy: `agent:${s.chief}` });
  const c = await s.tasks.comment(s.o.id, t.id, { text: '@Bob Member and @Ada Owner: which plan names do we ship?', fromAgentId: s.writer.id, strictMentions: true });
  assert.deepEqual(c.delivery?.notified.sort(), ['m-bob', 'single']);
  const ev = await eventsOf(s, 'mention');
  assert.equal(ev.length, 2);
  const bob = ev.find((e) => e.forMemberAccountId === 'm-bob')!;
  const owner = ev.find((e) => e.forMemberAccountId === '')!;
  assert.ok(bob && owner, 'the member\'s event is addressed to them; the owner\'s is the account\'s own');
  assert.equal(bob.title, `${t.key} · Writer mentioned you`);
  const payload = JSON.parse(bob.payload) as { link: string; taskId: string };
  assert.match(payload.link, new RegExp(`#/ws/${s.ws.id}/org/board\\?task=${t.id}$`));
  assert.equal(payload.taskId, t.id);
  assert.equal(bob.channel, 1, 'pushed through the person\'s pairings (under quiet hours)');
  assert.equal((await followRow(s, 'user', 'm-bob', t.id))?.reason, 'mentioned');
  const row = (await followRow(s, 'user', 'm-bob', t.id))!;
  assert.match(row.attention, /Writer addressed you/, 'the Following row shows it needs them');
  assert.equal((await eventsOf(s, 'follow')).length, 0, 'no second (follow) event for the same comment');
});

test('tagging someone who cannot see the task is refused with the reason, not dropped', async () => {
  const s = await setup();
  const t = await s.tasks.create(s.o.id, { title: 'Launch', assigneeAgentId: s.writer.id });
  await s.agents.create({ name: 'Outsider', workspaceId: s.ws.id });
  await assert.rejects(s.controller.comment(s.o.id, t.id, { text: '@Outsider take a look' }), new RegExp(`Outsider is not a member of Acme, so they cannot see ${t.key}`));
  const gone = await s.agents.create({ name: 'Gone', workspaceId: s.ws.id });
  await s.org.addMember(s.o.id, { agentId: gone.id, reportsToAgentId: s.chief });
  await s.org.terminateMember(s.o.id, gone.id);
  await assert.rejects(s.controller.comment(s.o.id, t.id, { text: 'cc @Gone' }), /Gone was let go from Acme/);
  await assert.rejects(s.controller.comment(s.o.id, t.id, { text: 'see this', notify: ['Nobody Here'] }), /notify names nobody.*Nobody Here/);
  assert.equal((await s.tasks.messages(s.o.id, { taskId: t.id })).length, 0, 'a refused comment is not stored');
  // an internal (non-strict) line leaves the invisible tag out instead
  const c = await s.tasks.comment(s.o.id, t.id, { text: 'note for @Outsider', fromAgentId: s.writer.id });
  assert.deepEqual(JSON.parse(c.mentions), []);
  // an agent from another workspace is nobody here at all
  const other = await s.agents.create({ name: 'Elsewhere', workspaceId: (await s.workspaces.create({ name: 'Other' })).id });
  assert.ok(!(await s.mentions.mentionables(s.o.id)).some((m) => m.id === other.id));
});

test('no double notify: a follower who is also tagged is woken / notified once', async () => {
  const s = await setup();
  const t = await s.tasks.create(s.o.id, { title: 'Release notes', assigneeAgentId: s.writer.id, status: 'in_progress' });
  await s.follows.follow({ kind: 'org_task', id: t.id, workspaceId: s.ws.id, title: t.title }, { kind: 'agent', id: s.editor.id });
  s.wakes.length = 0;
  await s.tasks.comment(s.o.id, t.id, { text: '@Editor in Chief over to you for a read', fromAgentId: s.writer.id });
  assert.equal(mentionWakes(s).length, 1);
  const row = (await followRow(s, 'agent', s.editor.id, t.id))!;
  assert.equal(row.unseenCount, 1, 'it still counts as activity');
  assert.equal(row.attentionAt, null, 'no follow attention on top of the mention wake');
  assert.deepEqual(await s.follows.wakeReasons(s.editor.id), [], 'the heartbeat does not wake it again');
  // the owner (a follower) tagged by somebody else: the comment wake is the one wake
  s.wakes.length = 0;
  await s.tasks.comment(s.o.id, t.id, { text: '@Writer the date moved', fromAgentId: s.editor.id });
  assert.equal(s.wakes.filter((w) => w.agentId === s.writer.id).length, 1);
  assert.equal(mentionWakes(s).length, 0);
  // the owner person follows the task (created it), looked at it, and is tagged: one mention event, no follow event
  await s.follows.markSeenFor({ kind: 'user', id: 'single' }, 'org_task', t.id);
  const followEvents = (await eventsOf(s, 'follow')).length;
  await s.tasks.comment(s.o.id, t.id, { text: '@Ada Owner sign-off please', fromAgentId: s.writer.id });
  assert.equal((await eventsOf(s, 'mention')).length, 1);
  assert.equal((await eventsOf(s, 'follow')).length, followEvents, 'no follow event on top of the mention');
  // an untagged comment after that is ordinary follow news again
  await s.follows.markSeenFor({ kind: 'user', id: 'single' }, 'org_task', t.id);
  await s.tasks.comment(s.o.id, t.id, { text: 'Signed off below.', fromAgentId: s.writer.id });
  assert.equal((await eventsOf(s, 'follow')).length, followEvents + 1);
});

test('the ping-pong cap: agents tagging each other stop waking after work.mentionChainCap rounds until a person comments', async () => {
  const s = await setup();
  const t = await s.tasks.create(s.o.id, { title: 'Spec', assigneeAgentId: s.chief, status: 'in_progress' });
  s.wakes.length = 0;
  const pair = [s.writer, s.editor];
  const delivered = [];
  for (let i = 0; i < 4; i++) {
    const from = pair[i % 2]; const to = pair[(i + 1) % 2];
    delivered.push((await s.tasks.comment(s.o.id, t.id, { text: `@${to.name} your turn (${i})`, fromAgentId: from.id })).delivery!);
  }
  assert.deepEqual(delivered.map((d) => d.capped), [false, false, false, true]);
  assert.equal(mentionWakes(s).length, 3, 'three rounds wake; the fourth does not');
  assert.match(delivered[3].notWoken[0].why, /reached its cap/);
  // capped: the follow fan-out does not wake it either
  assert.deepEqual(await s.follows.wakeReasons(s.writer.id), []);
  // a person's comment resets the chain
  await s.controller.comment(s.o.id, t.id, { text: 'Keep going, both of you.' });
  const again = (await s.tasks.comment(s.o.id, t.id, { text: '@Writer one more', fromAgentId: s.editor.id })).delivery!;
  assert.equal(again.capped, false);
  assert.equal(mentionWakes(s).length, 4);
  // a person tagging agents never counts toward the cap
  for (let i = 0; i < 5; i++) await s.controller.comment(s.o.id, t.id, { text: `@Writer ping ${i}` });
  assert.equal(mentionWakes(s).length, 9);
});

test('gates: a closed task, a paused company or a paused member records the tag without waking', async () => {
  const s = await setup();
  const t = await s.tasks.create(s.o.id, { title: 'Old', assigneeAgentId: s.writer.id });
  await s.tasks.update(s.o.id, t.id, { status: 'done' });
  s.wakes.length = 0;
  const closed = (await s.tasks.comment(s.o.id, t.id, { text: '@Editor in Chief fyi', fromAgentId: s.writer.id })).delivery!;
  assert.match(closed.notWoken[0].why, /is done/);
  const t2 = await s.tasks.create(s.o.id, { title: 'New', assigneeAgentId: s.writer.id });
  await s.org.setMemberStatus(s.o.id, s.editor.id, 'paused');
  const paused = (await s.tasks.comment(s.o.id, t2.id, { text: '@Editor in Chief fyi', fromAgentId: s.writer.id })).delivery!;
  assert.match(paused.notWoken[0].why, /member is paused/);
  await s.org.setMemberStatus(s.o.id, s.editor.id, 'active');
  await s.runtime.pause(s.o.id);
  const off = (await s.tasks.comment(s.o.id, t2.id, { text: '@Editor in Chief fyi', fromAgentId: s.writer.id })).delivery!;
  assert.match(off.notWoken[0].why, /company is paused/);
  assert.equal(mentionWakes(s).length, 0);
});

test('org_task_comment: @mentions and the notify arg tag members; the result says who was woken; refusals come back as the tool error', async () => {
  const s = await setup();
  const t = await s.tasks.create(s.o.id, { title: 'Blog post', assigneeAgentId: s.writer.id, status: 'in_progress' });
  const session = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.writer.id, name: 'w' });
  s.wakes.length = 0;
  const out = await s.runtime.execute(session, 'org_task_comment', { taskId: t.key, text: 'Draft is in shared/post.md.', notify: ['Editor in Chief', 'bob'] });
  assert.match(out, /woke Editor in Chief for it/);
  assert.match(out, /notified 1 person/);
  assert.deepEqual(mentionWakes(s).map((w) => w.agentId), [s.editor.id]);
  await s.agents.create({ name: 'Outsider', workspaceId: s.ws.id });
  await assert.rejects(s.runtime.execute(session, 'org_task_comment', { taskId: t.key, text: '@Outsider look' }), /refused: Outsider is not a member of Acme/);
  // the skill documents tagging
  const workflow = BUILTIN_SKILLS.find((b) => b.name === 'org-member-workflow')!.instructions;
  assert.match(workflow, /Tag the person who must act, never to broadcast/);
});

test('brief mentions: a tag new in a brief (on create or edit) wakes / notifies like a comment, once', async () => {
  const s = await setup();
  s.wakes.length = 0;
  const t = await s.tasks.create(s.o.id, { title: 'Survey', brief: { outcome: 'Results', context: 'Ask @Editor in Chief for the panel list' }, assigneeAgentId: s.writer.id, createdBy: `agent:${s.chief}` });
  assert.deepEqual(mentionWakes(s).map((w) => w.agentId), [s.editor.id]);
  await s.tasks.update(s.o.id, t.id, { brief: { constraints: 'Bob decides the budget — @Bob Member' } }, `agent:${s.chief}`);
  assert.equal(mentionWakes(s).length, 1, 'the editor, already tagged, is not woken again');
  const ev = await eventsOf(s, 'mention');
  assert.equal(ev.length, 1);
  assert.match(ev[0].title, /mentioned you in the brief/);
});
