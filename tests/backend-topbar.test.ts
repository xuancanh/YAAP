/** The top bar (docs/home.md "Top bar"): `GET /api/workspaces/:id/status`
 *  is the company at a glance (run state, Needs you with the urgent ones,
 *  spend against the envelope, agents working and failing, the turns
 *  running now, the next meeting); `GET /api/topbar/workspaces` the
 *  switcher's rows; `GET /api/workspaces/:id/notifications` the bell —
 *  waiting cards merged with the inbox events addressed to you — and
 *  `POST …/notifications/read` its read marks (an event's own `readAt`; a
 *  card's in the per-person row). The live-turn registry tells the workspace
 *  stream when a turn starts and ends. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigService } from '@nestjs/config';
import { ChatsRepository } from '../server/src/chats/chats.repository';
import { TurnLoopService } from '../server/src/chats/turn-loop.service';
import { ChatLocks } from '../server/src/chats/chat-locks';
import { ToolsService } from '../server/src/chats/tools.service';
import { TriggerBus } from '../server/src/chats/trigger-bus';
import { LiveTurnRegistry, type LiveTurnChange } from '../server/src/chats/live-turns';
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
import type { OrgCapitalService } from '../server/src/org/org-capital.service';
import type { OrgMeetingsService } from '../server/src/org/org-meetings.service';
import { HomeService } from '../server/src/home/home.service';
import { TopBarService, hashOf, isUrgent, expiresSoon } from '../server/src/home/topbar.service';
import { TopBarController, TopBarWorkspacesController } from '../server/src/home/topbar.controller';
import { testDb, memStorage, ctxStub, skillsStub, mcpStub, ScriptedProvider } from './helpers';

async function setup(stubs: { capital?: OrgCapitalService; meetings?: OrgMeetingsService } = {}) {
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
  const home = new HomeService(
    db, workspaces, agents, config, fs, undefined, undefined, undefined,
    org, tasks, approvals, audit, brief, undefined, undefined, undefined, undefined, stubs.meetings, stubs.capital, undefined, runtime,
  );
  const topbar = new TopBarService(db, home, workspaces);
  const registry = new LiveTurnRegistry();
  topbar.registry = registry;
  const ws = (await workspaces.list())[0];
  const chief = await agents.create({ name: 'Chief', charter: 'You run the company.' });
  const writer = await agents.create({ name: 'Writer', charter: 'You write.' });
  return { db, agents, workspaces, repo, org, approvals, mode, home, topbar, registry, ws, chief, writer };
}

test('a plain workspace: no company chips, Needs you, failing agents, live runs; the bell merges cards and inbox events', async () => {
  const s = await setup();
  const ctl = new TopBarController(s.topbar);
  // a queued background action (a card), a failed turn (the writer is failing)
  await s.agents.addEvent(s.writer.id, { kind: 'action_pending', title: 'Send the newsletter', body: 'gmail_send to 120 people', payload: JSON.stringify({ tool: 'gmail_send', input: {} }) });
  const session = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.writer.id, name: 'chat' });
  const turn = await s.repo.createTurn(session.id, { text: 'hi' });
  await s.repo.updateTurn(turn.id, { status: 'error', error: 'model "gpt-9-ultra" not found (404)' });
  // a turn running now
  s.registry.begin({ sessionId: 'sess-live', turnId: 't-live', agentId: s.chief.id, workspaceId: s.ws.id, origin: 'loop', sessionName: 'Loop · heartbeat' });
  s.registry.tool('sess-live', 'fs_write', { path: 'reports/weekly.md' });
  s.registry.begin({ sessionId: 'elsewhere', turnId: 't2', agentId: s.chief.id, workspaceId: 'other-ws', origin: 'user', sessionName: 'x' });

  const st = await ctl.status(s.ws.id);
  assert.equal(st.company, null, 'no company: no run state, spend or meeting');
  assert.equal(st.spend, null);
  assert.equal(st.nextMeeting, null);
  assert.equal(st.needsYou, 1);
  assert.equal(st.urgent, 0);
  assert.equal(st.agents.total, 2);
  assert.equal(st.agents.failing, 1);
  assert.equal(st.agents.faces[0].id, s.writer.id, 'failing faces lead the stack');
  assert.equal(st.agents.faces[0].state, 'error');
  assert.equal(st.live.length, 1, 'only this workspace\'s turns');
  assert.equal(st.live[0].agentName, 'Chief');
  assert.equal(st.live[0].toolLabel, 'writing reports/weekly.md');
  assert.deepEqual(st.partial, []);

  // inbox events: a message (opens its chat), a follow (opens its link), a
  // failed loop run, a routine run (not news), a member's event (not mine)
  const dm = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.chief.id, name: 'Chief' });
  await s.agents.addEvent(s.chief.id, { kind: 'agent_message', title: 'Chief wrote to you', body: 'The launch slipped a day.', sessionId: dm.id, payload: JSON.stringify({ urgency: 'urgent' }) });
  await s.agents.addEvent(`follow:${s.ws.id}`, { kind: 'follow', title: 'Following · Pricing page', body: 'Writer: moved to blocked', payload: JSON.stringify({ link: 'http://localhost:5175/#/ws/x/org/board?task=t1', from: 'Following' }) });
  await s.agents.addEvent(s.writer.id, { kind: 'loop_error', title: 'Heartbeat failed', body: 'provider 500' });
  await s.agents.addEvent(s.writer.id, { kind: 'loop_run', title: 'Heartbeat', body: 'nothing new' });
  await s.agents.addEvent(s.writer.id, { kind: 'info', title: 'For someone else', forMemberAccountId: 'member-2' });
  await s.agents.addEvent('unrelated-agent', { kind: 'agent_message', title: 'Another workspace' });

  const page = await ctl.notifications(s.ws.id);
  assert.equal(page.items[0].kind, 'queued_action', 'waiting cards lead');
  assert.equal(page.items[0].waiting, true);
  assert.equal(page.items[0].target.to, 'need');
  const kinds = page.items.map((i) => i.kind);
  assert.deepEqual(kinds.slice(1).sort(), ['follow', 'message', 'run_failed']);
  const msg = page.items.find((i) => i.kind === 'message')!;
  assert.deepEqual(msg.target, { to: 'chat', sessionId: dm.id });
  assert.equal(msg.severity, 'high', 'an urgent message is high');
  assert.equal(msg.from, 'Chief');
  const follow = page.items.find((i) => i.kind === 'follow')!;
  assert.deepEqual(follow.target, { to: 'hash', hash: '#/ws/x/org/board?task=t1' });
  assert.equal(follow.from, 'Following');
  assert.equal(page.unread, 4);

  // mark one event and the card read: the card stays listed (it still waits)
  await ctl.read(s.ws.id, { ids: [msg.id, page.items[0].id, 'event:not-mine'] });
  const after = await ctl.notifications(s.ws.id);
  assert.equal(after.unread, 2);
  assert.equal(after.items.find((i) => i.id === page.items[0].id)!.read, true);
  assert.equal(after.items.find((i) => i.id === msg.id)!.read, true);
  assert.ok((await s.agents.listEvents(s.chief.id)).find((e) => e.kind === 'agent_message')!.readAt, 'the event\'s own read mark');

  // mark all read
  const r = await ctl.read(s.ws.id, { all: true });
  assert.equal(r.marked, 2);
  assert.equal((await ctl.notifications(s.ws.id)).unread, 0);
  // a card that arrives later is unread again
  await new Promise((res) => setTimeout(res, 5));
  await s.agents.addEvent(s.chief.id, { kind: 'action_pending', title: 'Pay the invoice', payload: JSON.stringify({ tool: 'pay', input: {} }) });
  assert.equal((await ctl.notifications(s.ws.id)).unread, 1);

  // the switcher's rows
  const rows = await new TopBarWorkspacesController(s.topbar).workspaces();
  const row = rows.find((x) => x.workspaceId === s.ws.id)!;
  assert.equal(row.company, null);
  assert.equal(row.needsYou, 2);
  assert.equal(row.unread, 1);
});

test('a company: run state, urgent cards, spend against the envelope, the next meeting within a day; pausing shows', async () => {
  const soon = new Date(Date.now() + 25 * 60_000).toISOString();
  const capital = { plans: async () => [], forecast: async () => ({ company: { projectedUsd: 31, state: 'stop' } }) } as unknown as OrgCapitalService;
  const meetings = {
    list: async () => [{ id: 'm1', title: 'Weekly review', kind: 'weekly_review', scheduledFor: soon }],
    cadences: async () => [], decisions: async () => [],
  } as unknown as OrgMeetingsService;
  const s = await setup({ capital, meetings });
  const st0 = await s.mode.setMode(s.ws.id, { mode: 'autonomous', chiefOfStaffAgentId: s.chief.id, monthlyUsd: 25 });
  const orgId = st0.orgId!;
  const card = await s.approvals.create(orgId, { kind: 'hire', payload: { name: 'Ana', title: 'Researcher' }, requestedBy: 'chief' });

  const st = await s.topbar.status(s.ws.id);
  assert.ok(st.company);
  assert.equal(st.company!.mode, 'autonomous');
  assert.equal(st.company!.status, 'active');
  assert.equal(st.needsYou, 1);
  assert.equal(st.spend!.monthCapUsd, 25);
  assert.equal(st.spend!.projectedUsd, 31);
  assert.equal(st.spend!.forecastState, 'stop');
  assert.deepEqual(st.nextMeeting, { id: 'meeting:m1', title: 'Weekly review', at: soon, meetingId: 'm1' });

  // the card's default applies within six hours: urgent, and expiring soon in the bell
  const page = await s.topbar.notifications(s.ws.id);
  const item = page.items.find((i) => i.id === `need:approval:${card.id}`)!;
  assert.equal(item.kind, 'decision');
  assert.equal(item.from, 'Chief');
  if (item.deadline && Date.parse(item.deadline) - Date.now() < 6 * 3_600_000) { assert.equal(item.expiresSoon, true); assert.equal(st.urgent, 1); }

  await s.mode.pause(s.ws.id);
  assert.equal((await s.topbar.status(s.ws.id)).company!.status, 'paused');
  const rows = await s.topbar.workspaceRows();
  assert.equal(rows.find((r) => r.workspaceId === s.ws.id)!.company!.status, 'paused');
});

test('the live-turn registry tells subscribers when a turn starts and ends in their workspace', () => {
  const reg = new LiveTurnRegistry();
  const heard: LiveTurnChange[] = [];
  const off = reg.subscribe('ws1', (ev) => heard.push(ev));
  reg.begin({ sessionId: 'a', turnId: 't', agentId: 'ag', workspaceId: 'ws1', origin: 'user', sessionName: 'chat' });
  reg.begin({ sessionId: 'b', turnId: 't', agentId: 'ag', workspaceId: 'ws2', origin: 'user', sessionName: 'chat' });
  reg.end('a');
  reg.end('a'); // a second end is a no-op
  off();
  reg.begin({ sessionId: 'c', turnId: 't', agentId: 'ag', workspaceId: 'ws1', origin: 'user', sessionName: 'chat' });
  assert.deepEqual(heard.map((e) => [e.type, e.sessionId, e.on, e.running]), [['turn_live', 'a', true, 1], ['turn_live', 'a', false, 0]]);
  assert.deepEqual(reg.inWorkspace('ws1').map((t) => t.sessionId), ['c']);
});

test('pure helpers: the hash of a link, expiring soon, urgent', () => {
  const now = new Date('2026-11-04T10:00:00Z');
  assert.equal(hashOf('http://x/#/ws/a/channel/general/m1'), '#/ws/a/channel/general/m1');
  assert.equal(hashOf('http://x/acme-1f2e3d/channels/general/m1'), '/acme-1f2e3d/channels/general/m1');
  assert.equal(hashOf('/acme-1f2e3d/tasks/ENG-12'), '/acme-1f2e3d/tasks/ENG-12');
  assert.equal(hashOf('http://x/'), '');
  assert.equal(hashOf('no hash'), '');
  assert.equal(hashOf(undefined), '');
  assert.equal(expiresSoon('2026-11-04T12:00:00Z', now), true);
  assert.equal(expiresSoon('2026-11-04T20:00:00Z', now), false);
  assert.equal(expiresSoon('2026-11-04T09:00:00Z', now), false, 'already past');
  assert.equal(isUrgent({ severity: 'critical', deadline: null }, now), true);
  assert.equal(isUrgent({ severity: 'normal', deadline: '2026-11-04T11:00:00Z' }, now), true);
  assert.equal(isUrgent({ severity: 'high', deadline: null }, now), false);
});
