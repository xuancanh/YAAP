/** The owner's feed (docs/owners-seat.md "Inbox and notifications"): one
 *  source for the Inbox and the bell. Each type comes from its source event
 *  (agent inbox events, the org audit log, the plugin audit log, tasks,
 *  follows, pending plugin updates); the counts agree between the feed, the
 *  top bar's status and the switcher; marking read and resolving behave;
 *  updates about one thing group; a workspace can turn update types off; a
 *  member sees only what is addressed to them. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { ConfigService } from '@nestjs/config';
import { ChatsRepository } from '../server/src/chats/chats.repository';
import { TurnLoopService, APPROVAL_TTL_MS } from '../server/src/chats/turn-loop.service';
import { ChatLocks } from '../server/src/chats/chat-locks';
import { ToolsService } from '../server/src/chats/tools.service';
import { TriggerBus } from '../server/src/chats/trigger-bus';
import { AgentsService } from '../server/src/agents/agents.service';
import { WorkspacesService } from '../server/src/workspaces/workspaces.service';
import { WorkspaceFs } from '../server/src/files/workspace-fs.service';
import { OrgAuditService } from '../server/src/org/org-audit.service';
import { OrgService } from '../server/src/org/org.service';
import { OrgTasksService } from '../server/src/org/org-tasks.service';
import { OrgApprovalsService } from '../server/src/org/org-approvals.service';
import { OrgBriefService } from '../server/src/org/org-brief.service';
import { OrgRuntimeService } from '../server/src/org/org-runtime.service';
import { OrgModeService } from '../server/src/org/org-mode.service';
import { OrgAnnouncer } from '../server/src/org/org-announcer';
import { PluginAuditService } from '../server/src/plugins/plugin-audit';
import { HomeService } from '../server/src/home/home.service';
import { FeedService } from '../server/src/home/feed.service';
import { TopBarService } from '../server/src/home/topbar.service';
import { classifyEvent, FEED_TYPES, type FeedLookup } from '../server/src/home/feed-registry';
import { clipWords, groupTitle, needPresentation, signalTitle } from '../server/src/home/feed-titles';
import { agentEvents, channels, follows, organizations, orgTasks, pluginInstalls, plugins } from '../server/src/database/schema';
import { runWithViewer } from '../server/src/accounts/account-context';
import { testDb, memStorage, ctxStub, skillsStub, mcpStub, ScriptedProvider } from './helpers';

async function setup() {
  const db = await testDb();
  const { stub } = memStorage();
  const bus = new TriggerBus();
  const agents = new AgentsService(db, stub, bus);
  const workspaces = new WorkspacesService(db, stub);
  const repo = new ChatsRepository(db);
  const turns = new TurnLoopService(repo, new ChatLocks(), new ToolsService(stub), ctxStub(new ScriptedProvider([])), skillsStub(), stub, mcpStub(), agents, workspaces);
  const config = { get: (k: string) => (k === 'companiesEnabled' ? true : k === 'loopsEnabled' ? false : undefined) } as unknown as ConfigService;
  const announcer = new OrgAnnouncer({ announce: async () => {} });
  const audit = new OrgAuditService(db);
  const org = new OrgService(db, agents, audit, bus);
  const tasks = new OrgTasksService(db, org, audit, bus);
  const approvals = new OrgApprovalsService(db, org, tasks, agents, audit, undefined, bus);
  const brief = new OrgBriefService(db, org, tasks, approvals, audit, agents, workspaces);
  const runtime = new OrgRuntimeService(db, org, tasks, approvals, audit, brief, turns, repo, agents, workspaces, config, announcer, bus);
  runtime.debounceMs = 60_000;
  const mode = new OrgModeService(org, workspaces, agents, runtime, approvals, audit, announcer);
  const fs = new WorkspaceFs(stub, db);
  const home = new HomeService(db, workspaces, agents, config, fs, undefined, undefined, undefined, org, tasks, approvals, audit, brief, undefined, undefined, undefined, undefined, undefined, undefined, undefined, runtime);
  const feed = new FeedService(db, home, workspaces);
  const topbar = new TopBarService(home, workspaces, feed);
  const pluginAudit = new PluginAuditService(db);
  const ws = (await workspaces.list())[0];
  const chief = await agents.create({ name: 'Chief', charter: 'You run the company.' });
  const writer = await agents.create({ name: 'Writer', charter: 'You write.' });
  const st = await mode.setMode(ws.id, { mode: 'supervised', chiefOfStaffAgentId: chief.id, monthlyUsd: 50 });
  const orgId = st.orgId!;
  const tune = (t: Record<string, number>) => db.update(organizations).set({ tunables: JSON.stringify(t) }).where(eq(organizations.id, orgId));
  return { db, agents, repo, audit, tasks, approvals, feed, topbar, pluginAudit, ws, chief, writer, orgId, tune };
}

const now = () => new Date().toISOString();

test('each source event becomes its type, with actor, company, context and a structured target', async () => {
  const s = await setup();
  await s.tune({ 'notify.groupAfter': 50 }); // see every row on its own here
  const task = await s.tasks.create(s.orgId, { title: 'Write the launch post' });
  const mineTask = await s.tasks.create(s.orgId, { title: 'Sign the contract' });
  const reviewTask = await s.tasks.create(s.orgId, { title: 'Pricing page' });
  await s.db.update(orgTasks).set({ assigneeHumanId: 'single', status: 'todo' }).where(eq(orgTasks.id, mineTask.id));
  await s.db.update(orgTasks).set({ reviewerHumanId: 'single', status: 'in_review', assigneeAgentId: s.writer.id }).where(eq(orgTasks.id, reviewTask.id));
  await s.db.insert(channels).values({ id: 'ch1', workspaceId: s.ws.id, slug: 'launch', name: 'launch', createdAt: now() });
  const session = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.writer.id, name: 'chat' });

  // agent inbox events
  await s.agents.addEvent(`task:${s.orgId}`, { kind: 'mention', title: `${task.key} · Writer mentioned you`, body: 'Can you check the intro?', payload: JSON.stringify({ taskId: task.id, mention: true, authorKind: 'agent', authorId: s.writer.id, link: 'http://x/#/old' }) });
  await s.agents.addEvent('channel:ch1', { kind: 'mention', title: '#launch · Writer mentioned you', payload: JSON.stringify({ channelId: 'ch1', messageId: 'm1', mention: true, authorKind: 'agent', authorId: s.writer.id }) });
  await s.agents.addEvent('channel:ch1', { kind: 'mention', title: '#launch · Chief', payload: JSON.stringify({ channelId: 'ch1', messageId: 'm2', mention: false }) });
  await s.agents.addEvent(`org:${s.orgId}`, { kind: 'meeting', title: 'Weekly sync starts in 10 min · Join', payload: JSON.stringify({ meetingId: 'mt1', action: 'join' }) });
  await s.agents.addEvent(s.chief.id, { kind: 'budget_warn', title: 'Acme: company envelope at 85%', payload: JSON.stringify({ scope: 'company', refId: s.orgId }) });
  await s.agents.addEvent(s.writer.id, { kind: 'info', title: 'Acted (trust level 1, you hear after): gmail_send', payload: JSON.stringify({ feed: 'agent_note' }) });
  await s.agents.addEvent(s.writer.id, { kind: 'trust_change', title: 'Trust raised for send email: level 1 → 2' });
  await s.agents.addEvent(s.writer.id, { kind: 'approval_request', title: 'Writer asks to run gmail_send with your connection', sessionId: session.id, payload: JSON.stringify({ callId: 'c1' }) });
  const stale = await s.agents.addEvent(s.writer.id, { kind: 'approval_request', title: 'An old request', sessionId: session.id, payload: JSON.stringify({ callId: 'c0' }) });
  await s.db.update(agentEvents).set({ createdAt: new Date(Date.now() - APPROVAL_TTL_MS - 60_000).toISOString() }).where(eq(agentEvents.id, stale.id));
  // noise that is not the owner's news
  await s.agents.addEvent(s.writer.id, { kind: 'info', title: 'App "Notes" wrote notes.md' });
  await s.agents.addEvent(s.writer.id, { kind: 'org_run', title: 'Worked on "Write the launch post" (progressed)' });
  await s.agents.addEvent(s.chief.id, { kind: 'decision', title: 'Decide: hire a designer', payload: JSON.stringify({ approvalId: 'x' }) });

  // the org audit log
  const a = (actor: string, action: string, refType: string, refId: string, payload: Record<string, unknown> = {}) => s.audit.append(s.orgId, { actor, action, refType, refId, payload });
  await a(`agent:${s.chief.id}`, 'member_add', 'agent', s.writer.id, { title: 'Content writer' });
  await a('user', 'member_add', 'agent', s.chief.id, {}); // you did it: not news
  await a('system', 'meeting_start', 'meeting', 'mt1', { attendees: 3 });
  await a(`agent:${s.chief.id}`, 'project_member_propose', 'project', 'p1', { key: 'WEB', agentId: s.writer.id, role: 'designer' });
  await a('system', 'project_breaker', 'project', 'p1', { key: 'WEB', spentUsd: 12, appetiteUsd: 10, daysUsed: 3, appetiteDays: 5 });
  await a('system', 'org_archive', 'org', s.orgId, { channelsArchived: 2 });
  await a('system', 'approval_default', 'approval', 'ap1', { kind: 'hire', decision: 'deny' });
  await a('system', 'approval_expired', 'approval', 'ap2', { kind: 'budget_change' });
  await a(`agent:${s.writer.id}`, 'run_end', 'run', 'r1', { taskId: task.id, status: 'failed' });
  await a(`agent:${s.writer.id}`, 'run_end', 'run', 'r2', { taskId: task.id, status: 'done' }); // a good run is not news
  await a('check', 'checks_failed', 'task', task.id, { detail: 'tests failed' });
  await a('system', 'blocked_owner_assigned', 'task', task.id, { agentId: s.chief.id });
  await a('system', 'goal_at_risk', 'goal', 'g1', { kind: 'objective', reasons: ['behind pace'] });
  // the plugin audit log, and an update waiting for review
  await s.pluginAudit.append(s.ws.id, { actor: 'system', action: 'plugin_version_recalled', refType: 'plugin', refId: 'acme.seo', payload: { version: '1.2.0', reason: 'leaks tokens' } });
  await s.db.insert(plugins).values({ id: 'pl1', pluginId: 'acme.seo', name: 'SEO helper', publisherId: 'acme', tier: 'community', createdAt: now() });
  await s.db.insert(pluginInstalls).values({ id: 'in1', workspaceId: s.ws.id, pluginId: 'acme.seo', versionId: 'v1', pendingVersionId: 'v2', pendingNote: JSON.stringify({ version: '1.3.0', diff: [{ path: 'network', detail: 'adds api.acme.com', widening: true }] }), createdAt: now(), updatedAt: now() });
  // a follow that needs you
  await s.db.insert(follows).values({ id: 'f1', workspaceId: s.ws.id, followerKind: 'user', followerId: 'single', targetKind: 'org_task', targetId: task.id, reason: 'manual', title: 'Write the launch post', link: '', createdAt: now(), lastSeenAt: now(), unseenCount: 2, lastActivity: 'moved to blocked', lastActorName: 'Writer', attentionAt: now(), attention: 'blocked: waits on legal' });

  const page = await s.feed.feed(s.ws.id);
  const byType = new Map<string, typeof page.items>();
  for (const i of page.items) byType.set(i.type, [...(byType.get(i.type) ?? []), i]);
  const count = (t: string) => byType.get(t)?.length ?? 0;
  assert.deepEqual(
    [...byType.keys()].sort(),
    ['agent_note', 'blocked', 'budget', 'channel_activity', 'company', 'connection_approval', 'decided_without_you', 'follow_attention', 'goal_at_risk', 'hire', 'meeting', 'mention', 'plugin', 'plugin_review', 'project', 'project_team', 'run_failed', 'task_assigned', 'task_review', 'trust'],
  );
  assert.equal(count('mention'), 2);
  assert.equal(count('meeting'), 2);
  assert.equal(count('run_failed'), 2, 'the failed run and the failed checks; the good run is not news');
  assert.equal(count('decided_without_you'), 2);
  assert.equal(count('hire'), 1, 'what you did yourself is not news');
  assert.equal(count('connection_approval'), 1, 'a request past its TTL has already been denied');
  assert.ok(!page.items.some((i) => /App "Notes"|Worked on|Decide: hire/.test(i.title)), 'working notes, routine runs and duplicated cards stay out');
  for (const i of page.items) assert.equal(i.section, FEED_TYPES[i.type].section);

  const taskMention = page.items.find((i) => i.type === 'mention' && i.target.kind === 'task')!;
  assert.equal(taskMention.title, `Writer mentioned you on ${task.key}`);
  assert.deepEqual(taskMention.target, { kind: 'task', taskId: task.id });
  assert.equal(taskMention.actor?.kind, 'agent');
  assert.equal(taskMention.actor?.id, s.writer.id);
  assert.ok(taskMention.actor?.emoji);
  assert.equal(taskMention.context.taskKey, task.key);
  assert.equal(taskMention.company, page.company);
  assert.ok(page.company, 'the company\'s name');
  const chMention = page.items.find((i) => i.type === 'mention' && i.target.kind === 'channel')!;
  assert.deepEqual(chMention.target, { kind: 'channel', channelId: 'ch1', slug: 'launch', messageId: 'm1' });
  assert.equal(chMention.title, 'Writer mentioned you in #launch');
  assert.equal(byType.get('channel_activity')![0].section, 'updates');
  assert.deepEqual(byType.get('hire')![0].target, { kind: 'agent', agentId: s.writer.id });
  assert.equal(byType.get('hire')![0].title, 'Chief hired Writer as Content writer');
  assert.equal(byType.get('project_team')![0].title, 'Chief proposed Writer for WEB as designer');
  assert.match(byType.get('project_team')![0].body, /waits on their head/);
  assert.equal(byType.get('budget')![0].title, 'The company budget is 85% used');
  assert.equal(byType.get('blocked')![0].title, `Chief was asked to unblock ${task.key}`);
  assert.equal(byType.get('follow_attention')![0].title, 'Write the launch post needs you');
  assert.match(byType.get('follow_attention')![0].body, /^Blocked: waits on legal\. Writer: moved to blocked$/);
  assert.equal(byType.get('task_review')![0].title, `Writer asks you to review ${reviewTask.key}`);
  assert.ok(!page.items.some((i) => / — /.test(i.title)), 'a title is one sentence; the detail is in the body');
  assert.equal(byType.get('project')![0].severity, 'high');
  assert.deepEqual(byType.get('plugin')![0].target, { kind: 'plugin', pluginId: 'acme.seo' });
  assert.match(byType.get('plugin')![0].title, /SEO helper 1.2.0 was recalled/);
  assert.match(byType.get('plugin_review')![0].body, /adds api.acme.com/);
  const conn = byType.get('connection_approval')![0];
  assert.deepEqual(conn.actions, ['allow', 'deny']);
  assert.equal(conn.actionable, true);
  assert.ok(conn.deadline && conn.expiresSoon);
  assert.deepEqual(conn.target, { kind: 'chat', sessionId: session.id });
  assert.deepEqual(byType.get('task_review')![0].actor?.name, 'Writer');
  assert.deepEqual(byType.get('follow_attention')![0].target, { kind: 'task', taskId: task.id });
  assert.deepEqual(byType.get('follow_attention')![0].ref?.follow, { targetKind: 'org_task', targetId: task.id });
  assert.ok(byType.get('meeting')!.every((m) => m.target.kind === 'meeting'));

  // Needs you leads, then the rest newest first; the counts cover every row
  const firstOther = page.items.findIndex((i) => i.section !== 'needs');
  assert.ok(page.items.slice(0, firstOther).every((i) => i.actionable));
  assert.ok(page.items.slice(firstOther).every((i) => !i.actionable));
  assert.equal(page.counts.needsYou, page.items.filter((i) => i.section === 'needs').length);
  assert.equal(page.counts.unread, page.items.filter((i) => !i.read).length);
  assert.equal(page.unread, page.counts.unread);
  assert.equal(page.counts.sections.mentions.total, 2);
});

test('the bell, the Inbox badge, the status strand and the switcher count the same feed', async () => {
  const s = await setup();
  await s.approvals.create(s.orgId, { kind: 'hire', payload: { name: 'Ana', title: 'Researcher' }, requestedBy: 'chief' });
  const t = await s.tasks.create(s.orgId, { title: 'Sign the contract' });
  await s.db.update(orgTasks).set({ assigneeHumanId: 'single', status: 'todo' }).where(eq(orgTasks.id, t.id));
  for (let i = 0; i < 3; i++) await s.agents.addEvent(s.writer.id, { kind: 'loop_error', title: `Loop "digest" failed (${i})` });
  await s.agents.addEvent(s.chief.id, { kind: 'agent_message', title: 'Launch slipped', body: 'Launch slipped a day.' });

  const page = await s.feed.feed(s.ws.id);
  const st = await s.topbar.status(s.ws.id);
  const bell = await s.topbar.notifications(s.ws.id);
  const row = (await s.topbar.workspaceRows()).find((r) => r.workspaceId === s.ws.id)!;
  assert.equal(page.counts.needsYou, 2, 'the card and your task');
  assert.equal(st.needsYou, page.counts.needsYou);
  assert.equal(row.needsYou, page.counts.needsYou);
  assert.equal(st.unread, page.unread);
  assert.equal(row.unread, page.unread);
  assert.deepEqual(bell.counts, page.counts);
  assert.deepEqual(bell.items.map((i) => i.id), page.items.map((i) => i.id));
  // three failed runs of one agent are one unread row
  assert.equal(page.unread, 2 + 1 + 1);
});

test('read marks: one row, a grouped row (every member), a section, everything; needs stay until resolved', async () => {
  const s = await setup();
  for (let i = 0; i < 3; i++) await s.agents.addEvent(s.writer.id, { kind: 'loop_error', title: `Loop "digest" failed (${i})` });
  await s.agents.addEvent(s.chief.id, { kind: 'agent_message', title: 'Launch slipped', body: 'Launch slipped a day.' });
  await s.agents.addEvent(s.writer.id, { kind: 'trust_change', title: 'Trust lowered' });
  const t = await s.tasks.create(s.orgId, { title: 'Sign the contract' });
  await s.db.update(orgTasks).set({ assigneeHumanId: 'single', status: 'todo' }).where(eq(orgTasks.id, t.id));

  let page = await s.feed.feed(s.ws.id);
  const group = page.items.find((i) => i.id.startsWith('group:'))!;
  assert.equal(group.id, `group:agent:${s.writer.id}:run_failed`);
  assert.equal(group.count, 3);
  assert.equal(group.title, 'Writer\'s runs failed 3 times');
  assert.match(group.body, /^Latest: Loop "digest" failed \(\d\)\.$/);
  assert.equal(page.unread, 4);

  // the grouped row: every member read
  await s.feed.markRead(s.ws.id, { ids: [group.id] });
  const events = await s.agents.listEvents(s.writer.id);
  assert.ok(events.filter((e) => e.kind === 'loop_error').every((e) => e.readAt));
  page = await s.feed.feed(s.ws.id);
  assert.equal(page.items.find((i) => i.id === group.id)!.read, true);
  assert.equal(page.unread, 3);

  // a section
  await s.feed.markRead(s.ws.id, { section: 'mentions' });
  page = await s.feed.feed(s.ws.id);
  assert.equal(page.counts.sections.mentions.unread, 0);
  assert.equal(page.counts.sections.updates.unread, 1, 'the other sections keep theirs');

  // a need read stays listed until it is resolved
  const need = page.items.find((i) => i.type === 'task_assigned')!;
  await s.feed.markRead(s.ws.id, { ids: [need.id, 'event:not-mine'] });
  page = await s.feed.feed(s.ws.id);
  assert.equal(page.items.find((i) => i.id === need.id)!.read, true);
  assert.equal(page.counts.needsYou, 1);
  await s.db.update(orgTasks).set({ status: 'done' }).where(eq(orgTasks.id, t.id));
  page = await s.feed.feed(s.ws.id);
  assert.equal(page.counts.needsYou, 0, 'resolved: it leaves Needs you');

  // everything
  const r = await s.feed.markRead(s.ws.id, { all: true });
  assert.equal(r.marked, 1);
  assert.equal((await s.feed.feed(s.ws.id)).unread, 0);
});

test('grouping and the per-workspace switches are tunables', async () => {
  const s = await setup();
  for (let i = 0; i < 3; i++) await s.agents.addEvent(s.writer.id, { kind: 'loop_error', title: `Loop failed (${i})` });
  await s.agents.addEvent(s.writer.id, { kind: 'trust_change', title: 'Trust lowered' });
  assert.equal((await s.feed.feed(s.ws.id)).items.filter((i) => i.type === 'run_failed').length, 1);
  await s.tune({ 'notify.groupAfter': 5 });
  assert.equal((await s.feed.feed(s.ws.id)).items.filter((i) => i.type === 'run_failed').length, 3, 'below the threshold: one row each');
  await s.tune({ 'notify.run_failed': 0 });
  const page = await s.feed.feed(s.ws.id);
  assert.equal(page.items.filter((i) => i.type === 'run_failed').length, 0, 'turned off');
  assert.equal(page.items.filter((i) => i.type === 'trust').length, 1);
  const types = await s.feed.types(s.ws.id);
  assert.equal(types.find((t) => t.type === 'run_failed')!.on, false);
  assert.equal(types.find((t) => t.type === 'trust')!.on, true);
  assert.ok(!types.some((t) => FEED_TYPES[t.type].section !== 'updates'), 'Needs you and mentions cannot be turned off');
});

test('a member sees what is addressed to them, never the owner\'s company updates', async () => {
  const s = await setup();
  await s.audit.append(s.orgId, { actor: `agent:${s.chief.id}`, action: 'member_add', refType: 'agent', refId: s.writer.id, payload: {} });
  await s.agents.addEvent(s.chief.id, { kind: 'agent_message', title: 'For the owner' });
  await s.agents.addEvent(`task:${s.orgId}`, { kind: 'mention', title: 'X-1 · Writer mentioned you', payload: JSON.stringify({ mention: true }), forMemberAccountId: 'mem-1' });
  const viewer = { memberAccountId: 'mem-1', role: 'member' as const, workspaceId: s.ws.id, displayName: 'Mia' };
  const page = await runWithViewer('single', viewer, () => s.feed.feed(s.ws.id));
  assert.deepEqual(page.items.map((i) => i.type), ['mention']);
  const owner = await s.feed.feed(s.ws.id);
  assert.deepEqual(owner.items.map((i) => i.type).sort(), ['hire', 'message']);
});

test('classification of an old event: the actor and target come from its text and link', () => {
  const look: FeedLookup = {
    agent: (id) => (id === 'a1' ? { kind: 'agent', id: 'a1', name: 'Ada', emoji: 'A', colors: '[]' } : null),
    agentNamed: (n) => (n === 'Ada' ? { kind: 'agent', id: 'a1', name: 'Ada' } : null),
    task: () => null, project: () => null, meeting: () => null, channel: () => null, threadChannel: () => null, plugin: () => null, chiefId: null,
  };
  const base = { id: 'e', agentId: 'follow:ws', kind: 'follow', title: 'Following · Launch plan', body: 'Ada: moved to blocked', payload: JSON.stringify({ link: 'http://x/#/ws/w/channel/a/m', from: 'Following' }), sessionId: null, createdAt: '', readAt: null };
  const c = classifyEvent(base, look)!;
  assert.equal(c.type, 'follow');
  assert.equal(c.actor?.id, 'a1');
  assert.equal(c.title, 'Ada updated Launch plan');
  assert.equal(c.body, 'moved to blocked');
  assert.deepEqual(c.target, { kind: 'link', hash: '#/ws/w/channel/a/m' });
  assert.equal(classifyEvent({ ...base, kind: 'info', payload: '' }, look), null, 'an untagged note is the agent\'s own');
  assert.equal(classifyEvent({ ...base, kind: 'loop_run' }, look), null);
});

test('Needs-you titles read as a sentence a person would write; the detail is in the body', async () => {
  const s = await setup();
  await s.approvals.create(s.orgId, { kind: 'hire', payload: { name: 'Content Marketer', title: 'Content Marketer', packName: 'Content Marketer', reportsToAgentId: s.chief.id, monthlyBudgetUsd: 20 }, requestedBy: `agent:${s.writer.id}` });
  const t = await s.tasks.create(s.orgId, { title: 'Landing page and qualified waitlist for IELTS candidates' });
  const reason = 'REJ-4 is built and unchanged since 17:54; what it waits on has moved from my manager to the owner. Two grants only the CEO can make: (1) a public static host for landing/index.html (one self-contained file, no build step, no server) and (2) a form backend.';
  await s.approvals.create(s.orgId, { kind: 'escalation', payload: { taskId: t.id, taskKey: t.key, title: t.title, reason }, requestedBy: `agent:${s.writer.id}` });
  const page = await s.feed.feed(s.ws.id);
  const hire = page.items.find((i) => i.need?.subkind === 'hire')!;
  assert.equal(hire.title, 'Writer wants to hire a Content Marketer');
  assert.equal(hire.need?.facts?.reportsTo, 'Chief', 'the facts name who it reports to');
  assert.equal(hire.need?.facts?.monthlyBudgetUsd, 20);
  assert.equal(hire.body, '', 'no reason and no charter: the pane lists the facts');
  const esc = page.items.find((i) => i.type === 'escalation')!;
  assert.equal(esc.title, `${t.key} is stuck waiting on you`);
  assert.equal(esc.body, reason, 'the whole reason, not cut mid-sentence');
  assert.equal(esc.context.taskTitle, t.title);
});

test('titles: signals, groups and clipping never cut a word', () => {
  assert.equal(signalTitle('burn_rate', 'Burn rate projects $282.36 by month-end against a $200.00 envelope (141%)'), 'Spending is on track to reach $282 against a $200 budget');
  assert.equal(signalTitle('stale_task', 'Stale: "Pricing page" has had no run in 26h'), 'No progress on "Pricing page" in 26 hours');
  assert.equal(signalTitle('other', 'As it was'), 'As it was');
  assert.equal(groupTitle(['run_failed', 'run_failed'], "Trạng Tí's runs", 5), "Trạng Tí's runs failed 5 times");
  assert.equal(groupTitle(['run_failed'], 'REJ-17', 2), 'Runs on REJ-17 failed 2 times');
  assert.equal(groupTitle(['channel_activity'], '#company', 2), '2 new messages in #company');
  assert.equal(groupTitle(['follow', 'run_failed'], 'ENG-12', 3), '3 updates on ENG-12');
  const long = 'what it waits on has moved from my manager to the owner and further along';
  const c = clipWords(long, 30);
  assert.ok(c.endsWith('…') && long.startsWith(c.slice(0, -1)) && long.charAt(c.length - 1) === ' ', `cut at a word boundary: ${c}`);
  const base = { kind: 'approval' as const, title: '', detail: '', task: undefined };
  assert.equal(needPresentation({ ...base, subkind: 'budget_raise', requestedBy: 'Chief', facts: { scope: 'company', monthlyUsd: 300 } }).title, 'Chief asks to raise the company budget to $300 a month');
  assert.equal(needPresentation({ ...base, subkind: 'hire', requestedBy: 'System', facts: { title: 'Engineer' } }).title, 'Hire an Engineer');
  assert.equal(needPresentation({ ...base, kind: 'signal', subkind: 'burn_rate', requestedBy: 'Assurance', title: 'Burn rate projects $10.00 by month-end against a $5.00 envelope (200%)' }).title, 'Spending is on track to reach $10 against a $5 budget');
  assert.equal(needPresentation({ ...base, kind: 'queued_action', subkind: 'gmail_send', requestedBy: 'Writer', title: 'Needs your approval: gmail_send' }).title, 'Writer wants to run gmail_send');
  // An improvement proposal reads as who proposes what, with the hypothesis as the body; an emergency change's review says so.
  const imp = needPresentation({ ...base, subkind: 'improvement', requestedBy: 'Cả Mẹo', facts: { key: 'IM-7', title: 'Add a fact-check step', hypothesis: 'A check stops wrong figures. More detail follows.' } });
  assert.deepEqual(imp, { title: 'Cả Mẹo proposes IM-7: Add a fact-check step', body: 'A check stops wrong figures.' });
  assert.equal(needPresentation({ ...base, subkind: 'improvement', requestedBy: 'System', facts: { key: 'IM-8', title: 'Raise retries', review: true } }).title, 'Review the emergency change IM-8: Raise retries');
  assert.equal(needPresentation({ ...base, subkind: 'some_new_kind', requestedBy: 'Chief', title: 'something new' }).title, 'Something new', 'an unknown kind keeps its own title');
});
