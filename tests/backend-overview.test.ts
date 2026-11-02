/** The overviews (docs/mission-control.md): `GET /api/agents/:id/overview`
 *  (an agent's Dashboard tab) and `GET /api/workspaces/:id/org/mission-control`
 *  (the org chart's mission control), both on the per-agent status Home uses
 *  (server/src/home/agent-status.ts) — working, blocked with what it waits on,
 *  erroring, idle, a live turn; the team; spend and WIP; and scoping. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { ChatsRepository } from '../server/src/chats/chats.repository';
import { TurnLoopService } from '../server/src/chats/turn-loop.service';
import { ChatLocks } from '../server/src/chats/chat-locks';
import { ToolsService } from '../server/src/chats/tools.service';
import { TriggerBus } from '../server/src/chats/trigger-bus';
import { LiveTurnRegistry, describeToolCall } from '../server/src/chats/live-turns';
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
import type { OrgIntentService } from '../server/src/org/org-intent.service';
import { TrustService } from '../server/src/actions/trust.service';
import { UsageService } from '../server/src/usage/usage.module';
import { SettingsService } from '../server/src/settings/settings.module';
import { HomeService } from '../server/src/home/home.service';
import { OverviewService } from '../server/src/home/overview.service';
import { AgentOverviewController, MissionControlController } from '../server/src/home/overview.controller';
import { blockerOf, deriveState, fixHint, primaryError, sortTeam } from '../server/src/home/agent-status';
import { orgUnits } from '../server/src/database/schema';
import { testDb, memStorage, ctxStub, skillsStub, mcpStub, ScriptedProvider } from './helpers';

async function setup(opts: { intent?: OrgIntentService } = {}) {
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
  const usage = new UsageService(db, new SettingsService(db));
  const trust = new TrustService(db, agents);
  const overview = new OverviewService(db, workspaces, agents, config, fs, usage, undefined, undefined, undefined, trust, org, tasks, approvals, opts.intent, runtime);
  const live = new LiveTurnRegistry();
  overview.live = live;
  const home = new HomeService(db, workspaces, agents, config, fs, undefined, undefined, undefined, org, tasks, approvals, audit, brief, undefined, undefined, undefined, undefined, undefined, undefined, undefined, runtime);
  const ws = (await workspaces.list())[0];
  const chief = await agents.create({ name: 'Chief', charter: 'You run the company.' });
  const writer = await agents.create({ name: 'Writer', charter: 'You write.' });
  return { db, agents, workspaces, repo, org, tasks, approvals, mode, fs, overview, live, home, ws, chief, writer };
}

/** A company: the chief, a writer (a head) and an editor reporting to the writer. */
async function company(s: Awaited<ReturnType<typeof setup>>) {
  const st = await s.mode.setMode(s.ws.id, { mode: 'supervised', chiefOfStaffAgentId: s.chief.id, monthlyUsd: 50 });
  const orgId = st.orgId!;
  const editor = await s.agents.create({ name: 'Editor', charter: 'You edit.', workspaceId: s.ws.id });
  await s.org.addMember(orgId, { agentId: editor.id, title: 'Editor', reportsToAgentId: s.writer.id });
  // Units (OrgUnitsService, not wired here): the company, and the writer's unit.
  const at = new Date().toISOString();
  await s.db.delete(orgUnits);
  await s.db.insert(orgUnits).values([
    { accountId: 'single', id: 'u-root', orgId, leadAgentId: s.chief.id, parentUnitId: null, name: 'Acme', slug: 'company', channelId: null, archivedAt: null, createdAt: at },
    { accountId: 'single', id: 'u-writing', orgId, leadAgentId: s.writer.id, parentUnitId: 'u-root', name: 'Writing', slug: 'writing', channelId: null, archivedAt: null, createdAt: at },
  ]);
  return { orgId, editor };
}

test('an agent working on a task: the Now card with its outcome and last comment, the queue, a CEO escalation waiting on you, the team and WIP', async () => {
  let owner = '';
  const kr = () => ({ id: 'k1', kind: 'key_result', title: '1,000 subscribers', status: 'active', ownerAgentId: owner, progress: 0.3, confidence: 0.4, atRisk: 0, atRiskReason: '', pace: 'behind', currentValue: 300, targetValue: 1000, unitLabel: 'subs', dueAt: null, children: [] });
  const s = await setup({
    intent: { intentTree: async () => [{ id: 'o1', kind: 'objective', title: 'Ship the newsletter', status: 'active', ownerAgentId: 'someone-else', progress: 0.4, confidence: 0.8, atRisk: 0, atRiskReason: '', pace: 'onPace', children: [kr()] }] } as unknown as OrgIntentService,
  });
  owner = s.writer.id;
  const { orgId, editor } = await company(s);
  const now = await s.tasks.create(orgId, { title: 'Draft three newsletter issues', assigneeAgentId: s.writer.id, brief: { outcome: 'Three drafts in drafts/', context: '', constraints: '', done_when: 'Editor accepts all three' } });
  await s.tasks.update(orgId, now.id, { status: 'in_progress' }, 'system');
  await s.tasks.comment(orgId, now.id, { text: 'First draft is up', fromAgentId: s.writer.id });
  const next = await s.tasks.create(orgId, { title: 'Plan the December issue', assigneeAgentId: s.writer.id, status: 'todo' });
  const stuck = await s.tasks.create(orgId, { title: 'Pricing page copy', assigneeAgentId: s.writer.id, status: 'todo' });
  await s.tasks.escalate(orgId, stuck.id, 'Need the final price from you', s.writer.id);
  await s.fs.write(s.ws.id, 'drafts/issue-1.md', Buffer.from('# One'), { by: { kind: 'agent', id: s.writer.id, name: 'Writer' } });

  const o = await new AgentOverviewController(s.overview).get(s.writer.id);
  assert.deepEqual(o.partial, []);
  assert.equal(o.workspaceId, s.ws.id);
  assert.equal(o.inCompany, true);
  assert.equal(o.status.state, 'working');
  assert.equal(o.status.doing, 'Draft three newsletter issues');
  assert.equal(o.status.waitingOnYou, 1);
  assert.equal(o.now?.id, now.id);
  assert.equal(o.now?.outcome, 'Three drafts in drafts/');
  assert.equal(o.now?.doneWhen, 'Editor accepts all three');
  assert.equal(o.now?.lastComment?.text, 'First draft is up');
  assert.equal(o.now?.lastComment?.from, 'Writer');
  assert.equal(o.blocked.length, 1);
  assert.equal(o.blocked[0].id, stuck.id);
  assert.equal(o.blocked[0].blocker.waitsOn.kind, 'ceo');
  assert.equal(o.blocked[0].blocker.reason, 'Need the final price from you');
  assert.deepEqual(o.queue.map((t) => t.id), [next.id]);
  assert.equal(o.files[0].path, 'drafts/issue-1.md');
  assert.deepEqual(o.goals.map((g) => [g.id, g.rag, g.currentValue]), [['k1', 'amber', 300]], 'the key results it owns, not the objective above');
  assert.equal(o.health.wip?.open, 3);
  assert.ok((o.health.wip?.limit ?? 0) > 0);
  assert.equal(o.health.trust.length, 5, 'one row per action class');
  assert.equal(o.health.spend.d30Usd, 0);
  assert.equal(o.health.spend.series.length, 30, 'the sparkline: one point a day');
  assert.equal(o.health.spend.monthCapUsd, null, 'no agent envelope set');
  assert.equal(o.cause, null, 'nothing is failing');
  // what waits on you: the escalation of its blocked task, with the card to decide
  const esc = o.needsYou.find((n) => n.kind === 'escalation');
  assert.equal(esc?.taskId, stuck.id);
  assert.equal(esc?.title, 'Escalated: Pricing page copy');
  assert.equal(esc?.detail, 'Need the final price from you');
  assert.ok(esc?.approvalId);
  // the team: the writer manages the editor and reports to the chief
  assert.equal(o.agent.hasReports, true);
  assert.equal(o.team.manager?.id, s.chief.id);
  assert.deepEqual(o.team.reports.map((r) => r.id), [editor.id]);
  assert.equal(o.team.unit?.name, 'Writing', 'a member with reports leads a unit');
  assert.ok(o.recent.some((r) => r.kind === 'decision' && /Commented on "Draft three newsletter issues"/.test(r.title)));

  // a queued background action lands in "needs you", with its event to act on
  await s.agents.addEvent(s.writer.id, { kind: 'action_pending', title: 'Writer wants to run fs_write', body: 'drafts/issue-2.md', sessionId: 'sess-x' });
  const o2 = await s.overview.agent(s.writer.id);
  const act = o2.needsYou.find((n) => n.kind === 'action');
  assert.equal(act?.title, 'Writer wants to run fs_write');
  assert.equal(act?.sessionId, 'sess-x');
  assert.ok(act?.eventId);
  assert.equal(o2.needsYou.length, 2);

  const c = await s.overview.agent(s.chief.id);
  assert.equal(c.agent.isChief, true);
  assert.equal(c.team.manager, null);
  assert.deepEqual(c.team.reports.map((r) => r.id), [s.writer.id]);
  assert.equal(c.status.state, 'idle');
});

test('blocked on a teammate, erroring and idle with a live turn: one derivation, the same on Home', async () => {
  const s = await setup();
  const { orgId, editor } = await company(s);
  const t = await s.tasks.create(orgId, { title: 'Edit the launch post', assigneeAgentId: editor.id, status: 'todo' });
  await s.tasks.escalateTo(orgId, t.id, { toAgentId: s.writer.id, toName: 'Writer', reason: 'Which tone do we use?', actor: `agent:${editor.id}`, fromAgentId: editor.id });
  // the chief's last turn failed: the provider rejected the model
  const session = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.chief.id, name: 'chat' });
  const turn = await s.repo.createTurn(session.id, { text: 'hi' });
  await s.repo.updateTurn(turn.id, { status: 'error', error: 'provider rejected model claude-opus-4-5' });

  const e = await s.overview.agent(editor.id);
  assert.equal(e.status.state, 'blocked');
  assert.equal(e.blocked[0].blocker.waitsOn.kind, 'agent');
  assert.equal(e.blocked[0].blocker.waitsOn.id, s.writer.id);
  assert.equal(e.blocked[0].blocker.reason, 'Which tone do we use?');
  assert.match(e.status.doing, /^Blocked on "Edit the launch post": Which tone do we use\?/);
  assert.equal(e.status.waitingOnYou, 0);
  assert.equal(e.team.manager?.id, s.writer.id);

  const c = await s.overview.agent(s.chief.id);
  assert.equal(c.status.state, 'error');
  assert.match(c.health.errors[0].message, /rejected model claude-opus-4-5/);
  assert.equal(c.cause?.kind, 'turn');
  assert.equal(c.cause?.sessionId, session.id, 'the cause links to the failing run');
  assert.equal(c.cause?.fix?.tab, 'Settings:General', 'pick another model');

  // the writer got an "Escalation:" task: it is queued (todo), not in progress
  const w0 = await s.overview.agent(s.writer.id);
  assert.equal(w0.status.state, 'idle');
  assert.ok(w0.queue.some((q) => q.title.startsWith('Escalation:')));

  const home = await s.home.home(s.ws.id);
  for (const tile of home.team) {
    const o = await s.overview.agent(tile.id);
    assert.equal(o.status.state, tile.state, `${tile.name}: Home and the overview agree`);
  }

  // mission control: totals, the waiting chain, nodes in the hierarchy
  const mc = await new MissionControlController(s.overview).get(s.ws.id);
  assert.deepEqual(mc.partial, []);
  assert.equal(mc.nodes.length, 3);
  assert.equal(mc.totals.error, 1);
  assert.equal(mc.totals.blocked, 1);
  assert.equal(mc.company.chiefAgentId, s.chief.id);
  assert.equal(mc.nodes.find((n) => n.agentId === editor.id)!.reportsToAgentId, s.writer.id);
  assert.deepEqual(mc.edges, [{ from: editor.id, to: s.writer.id, taskId: t.id, title: 'Edit the launch post' }]);
  assert.ok(mc.units.some((u) => u.leadAgentId === s.writer.id));
  assert.equal(mc.nodes.find((n) => n.agentId === s.writer.id)!.leadsUnitId, mc.units.find((u) => u.leadAgentId === s.writer.id)!.id);
  assert.equal(mc.totals.monthCapUsd, 50);
});

test('erroring: a failed turn with no message of its own takes the loop error\'s cause, links its run and says how to fix it', async () => {
  const s = await setup();
  await company(s);
  const session = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.writer.id, name: 'Loop · heartbeat' });
  const turn = await s.repo.createTurn(session.id, { text: 'beat' });
  await s.repo.updateTurn(turn.id, { status: 'error', error: null });
  await s.agents.addEvent(s.writer.id, { kind: 'loop_error', title: 'Loop "heartbeat" failed', body: 'tool round limit (24) reached', sessionId: session.id });
  await s.agents.markEventsRead(s.writer.id); // read in the inbox: it still explains the turn
  const o = await s.overview.agent(s.writer.id);
  assert.equal(o.status.state, 'error');
  assert.equal(o.cause?.message, 'tool round limit (24) reached');
  assert.equal(o.cause?.sessionId, session.id);
  assert.match(o.cause?.fix?.text ?? '', /all 24 tool rounds/);
  assert.equal(o.health.errors.length, 1, 'the loop error is the turn\'s reason, not a second error');
  const home = await s.home.home(s.ws.id);
  assert.equal(home.team.find((t) => t.id === s.writer.id)?.errors[0].message, 'tool round limit (24) reached', 'Home says the same');
});

test('a live turn makes an idle agent working, with the current tool call', async () => {
  const s = await setup();
  await company(s);
  assert.equal((await s.overview.agent(s.chief.id)).status.state, 'idle');
  s.live.begin({ sessionId: 'sess1', turnId: 't1', agentId: s.chief.id, workspaceId: s.ws.id, origin: 'loop', sessionName: 'Loop · heartbeat' });
  s.live.tool('sess1', 'fs_write', { path: 'org/sales/reports/2026-W45.md', content: 'x' });
  const o = await s.overview.agent(s.chief.id);
  assert.equal(o.status.state, 'working');
  assert.equal(o.status.live?.toolLabel, 'writing org/sales/reports/2026-W45.md');
  assert.equal(o.status.live?.calls, 1);
  const mc = await s.overview.missionControl(s.ws.id);
  assert.equal(mc.nodes.find((n) => n.agentId === s.chief.id)!.liveLabel, 'writing org/sales/reports/2026-W45.md');
  s.live.end('sess1');
  assert.equal((await s.overview.agent(s.chief.id)).status.state, 'idle');
});

test('scoping: no company, no mission control; another workspace is its own; an agent without a company still has an overview', async () => {
  const s = await setup();
  await assert.rejects(() => s.overview.missionControl(s.ws.id), NotFoundException);
  const other = await s.workspaces.create({ name: 'Side project' });
  const solo = await s.agents.create({ name: 'Solo', charter: 'Alone.', workspaceId: other.id });
  const task = await s.agents.addTask(solo.id, { title: 'Write the README' });
  await s.agents.updateTask(solo.id, task.id, { status: 'doing' });
  const o = await s.overview.agent(solo.id);
  assert.equal(o.workspaceId, other.id);
  assert.equal(o.inCompany, false);
  assert.equal(o.status.state, 'working');
  assert.equal(o.now?.source, 'agent');
  assert.equal(o.now?.title, 'Write the README');
  assert.equal(o.health.wip, null);
  assert.deepEqual(o.team.reports, []);
  await assert.rejects(() => s.overview.agent('missing-agent'), NotFoundException);
  await assert.rejects(() => s.overview.missionControl('missing-ws'));
});

test('pure helpers: what a blocker waits on, the state precedence, the team order, a tool call in words', () => {
  const tasksById = new Map([
    ['aaaaaaaa-1111', { id: 'aaaaaaaa-1111', title: 'Get the logo', status: 'in_progress', assigneeAgentId: 'designer' }],
    ['bbbbbbbb-2222', { id: 'bbbbbbbb-2222', title: 'Unowned', status: 'todo', assigneeAgentId: null }],
  ]);
  const names = new Map([['designer', 'Designer'], ['chief', 'Chief']]);
  const t = (blockers: string[], dependsOn: string[] = []) => ({ id: 'x', blockers: JSON.stringify(blockers), dependsOn: JSON.stringify(dependsOn), updatedAt: '2026-11-01T00:00:00Z' });
  assert.deepEqual(blockerOf(t(['escalated: need a budget']), { tasksById, names }).waitsOn, { kind: 'ceo', id: null, name: 'You', taskId: null });
  const toChief = blockerOf(t(['old line', 'escalated to Chief: pick a tone']), { tasksById, names });
  assert.equal(toChief.waitsOn.id, 'chief'); assert.equal(toChief.reason, 'pick a tone');
  const dep = blockerOf(t(['aaaaaaaa']), { tasksById, names });
  assert.equal(dep.waitsOn.kind, 'agent'); assert.equal(dep.waitsOn.id, 'designer'); assert.equal(dep.waitsOn.taskId, 'aaaaaaaa-1111');
  assert.equal(blockerOf(t([], ['bbbbbbbb-2222']), { tasksById, names }).waitsOn.kind, 'task');
  assert.equal(blockerOf(t(['legal review']), { tasksById, names }).waitsOn.kind, 'unknown');
  assert.equal(blockerOf(t([]), { tasksById, names }).reason, '', 'no reason recorded: empty, the page asks');

  assert.match(fixHint({ kind: 'loop', message: 'Loop "x" failed: tool round limit (24) reached' })?.text ?? '', /24 tool rounds/);
  assert.equal(fixHint({ kind: 'turn', message: 'provider rejected model claude-opus-4-5' })?.tab, 'Settings:General');
  assert.equal(fixHint({ kind: 'loop', message: 'Budget reached (8000 tokens). Raise the loop budget or clear its conversation.' })?.tab, 'Work:Schedule');
  assert.ok(fixHint({ kind: 'breaker', message: 'No progress after 3 runs on "x"' }));
  assert.equal(fixHint({ kind: 'turn', message: 'something odd' }), null);
  assert.equal(primaryError([
    { kind: 'provider' as const, message: 'anthropic is degraded', at: '3' },
    { kind: 'turn' as const, message: 'The last turn failed and recorded no reason', at: '2' },
    { kind: 'loop' as const, message: 'tool round limit (24) reached', at: '1' },
  ])?.kind, 'loop', 'the one that says what to do');
  assert.equal(primaryError([]), null);
  assert.equal(blockerOf(t(['legal review']), { tasksById, names, escalatedToCeo: true }).waitsOn.kind, 'ceo');

  const err = [{ kind: 'turn' as const, message: 'x', at: '' }];
  assert.equal(deriveState({ errors: err, paused: true, blocked: true, doing: 'x', live: true }), 'error');
  assert.equal(deriveState({ errors: [{ kind: 'provider', message: 'x', at: '' }], paused: false, blocked: false, doing: '', live: false }), 'idle', 'a degraded provider alone is not red');
  assert.equal(deriveState({ errors: [], paused: true, blocked: true, doing: 'x', live: false }), 'paused');
  assert.equal(deriveState({ errors: [], paused: false, blocked: true, doing: 'x', live: true }), 'blocked');
  assert.equal(deriveState({ errors: [], paused: false, blocked: false, doing: '', live: true }), 'working');
  assert.equal(deriveState({ errors: [], paused: false, blocked: false, doing: '', live: false }), 'idle');

  const team = sortTeam([
    { name: 'B', state: 'idle' as const, isChief: false }, { name: 'A', state: 'working' as const, isChief: false },
    { name: 'C', state: 'error' as const, isChief: false }, { name: 'Z', state: 'idle' as const, isChief: true },
  ]);
  assert.deepEqual(team.map((x) => x.name), ['Z', 'C', 'A', 'B']);

  assert.equal(describeToolCall('fs_write', { path: 'a/b.md' }), 'writing a/b.md');
  assert.equal(describeToolCall('fs_read', { path: 'a/b.md' }), 'reading a/b.md');
  assert.equal(describeToolCall('org_task_update', { status: 'in_review' }), 'updating a task to in review');
  assert.equal(describeToolCall('web_search', { query: 'pricing' }), 'searching the web for "pricing"');
  assert.equal(describeToolCall('something_else', {}), 'using something else');
});
