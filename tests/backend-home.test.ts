/** Home (docs/home.md): `GET /api/workspaces/:id/home` composes what the owner
 *  needs from the services that own it — the Needs-you cards (org decision
 *  cards with their defaults, held actions not already carried by a card,
 *  plans in their veto window, incidents, queued background actions), the
 *  recap since the last visit (and the visit record itself), goals at risk
 *  first, team status with errors surfaced loudly, activity, spend, coming up
 *  and recent artifacts — for a company and for a plain workspace. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigService } from '@nestjs/config';
import { ChatsRepository } from '../server/src/chats/chats.repository';
import { TurnLoopService } from '../server/src/chats/turn-loop.service';
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
import { OrgController } from '../server/src/org/org.controller';
import { OrgModeService } from '../server/src/org/org-mode.service';
import { OrgAnnouncer } from '../server/src/org/org-announcer';
import type { OrgIntentService } from '../server/src/org/org-intent.service';
import type { OrgCapitalService } from '../server/src/org/org-capital.service';
import type { OrgMeetingsService } from '../server/src/org/org-meetings.service';
import { collapseRoutine, describeRun, mergeUpcoming, routineTitle } from '../server/src/home/home-activity';
import { orgUnits } from '../server/src/database/schema';
import type { ActionsService } from '../server/src/actions/actions.service';
import type { ProviderHealthService } from '../server/src/ai/provider-health';
import { HomeService, SESSION_GAP_MS, nextCronFire, ragOf, rankNeeds } from '../server/src/home/home.service';
import { HomeController } from '../server/src/home/home.controller';
import type { HomeNeed } from '../server/src/home/home.types';
import { SettingsService } from '../server/src/settings/settings.module';
import { testDb, memStorage, ctxStub, skillsStub, mcpStub, ScriptedProvider } from './helpers';

type Stubs = { intent?: OrgIntentService; capital?: OrgCapitalService; actions?: ActionsService; health?: ProviderHealthService; meetings?: OrgMeetingsService };

async function setup(stubs: Stubs = {}) {
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
  const orgs = new OrgController(org, tasks, approvals, audit, brief, runtime, config);
  const mode = new OrgModeService(org, workspaces, agents, runtime, approvals, audit, announcer);
  const fs = new WorkspaceFs(stub, db);
  const home = new HomeService(
    db, workspaces, agents, config, fs, stubs.actions, undefined, stubs.health,
    org, tasks, approvals, audit, brief, stubs.intent, undefined, undefined, undefined, stubs.meetings, stubs.capital, undefined, runtime,
  );
  const ws = (await workspaces.list())[0];
  const chief = await agents.create({ name: 'Chief', charter: 'You run the company.' });
  const writer = await agents.create({ name: 'Writer', charter: 'You write.' });
  return { db, agents, workspaces, repo, org, tasks, approvals, audit, brief, runtime, orgs, mode, fs, home, ws, chief, writer, config };
}

test('a plain workspace: queued actions need you, a rejected model is loud on the team grid, recent files and tasks recap', async () => {
  const s = await setup();
  // a background action the writer queued for approval
  await s.agents.addEvent(s.writer.id, { kind: 'action_pending', title: 'Send the newsletter', body: 'gmail_send to 120 people', payload: JSON.stringify({ tool: 'gmail_send', input: {} }) });
  // the writer's last turn failed: the provider rejected the model name
  const session = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.writer.id, name: 'chat' });
  const turn = await s.repo.createTurn(session.id, { text: 'hi' });
  await s.repo.updateTurn(turn.id, { status: 'error', error: 'model "gpt-9-ultra" not found (404)' });
  // a finished task and a written file
  const task = await s.agents.addTask(s.chief.id, { title: 'Draft the plan' });
  await s.agents.updateTask(s.chief.id, task.id, { status: 'done' });
  await s.fs.write(s.ws.id, 'reports/weekly.md', Buffer.from('# Weekly'), { by: { kind: 'agent', id: s.writer.id, name: 'Writer' } });

  const h = await new HomeController(s.home).get(s.ws.id);
  assert.equal(h.company, null, 'no company: the simpler Home');
  assert.equal(h.firstVisit, true);
  assert.deepEqual(h.partial, []);
  assert.equal(h.needs.length, 1);
  const need = h.needs[0];
  assert.equal(need.kind, 'queued_action'); assert.equal(need.subkind, 'gmail_send'); assert.equal(need.requestedBy, 'Writer');
  assert.deepEqual(need.actions, ['approve', 'dismiss']);
  assert.equal(need.ref.agentId, s.writer.id); assert.ok(need.ref.eventId);
  assert.equal(h.headline.needsYou, 1);

  const writer = h.team.find((a) => a.id === s.writer.id)!;
  assert.equal(writer.state, 'error');
  assert.match(writer.errors[0].message, /gpt-9-ultra.*not found/);
  assert.equal(writer.errors[0].kind, 'turn');
  assert.equal(h.team[0].state, 'error', 'failing agents sort first');
  assert.equal(h.team.find((a) => a.id === s.chief.id)!.state, 'idle');

  assert.equal(h.recap.tasksDone, 1);
  assert.equal(h.recap.artifactsChanged, 1);
  assert.equal(h.artifacts[0].path, 'reports/weekly.md');
  assert.equal(h.artifacts[0].updatedBy.name, 'Writer');
  assert.ok(h.activity.some((a) => a.kind === 'file' && /Created reports\/weekly\.md/.test(a.title)));
  assert.ok(h.activity.some((a) => a.kind === 'task' && /Done: ([A-Z][A-Z0-9]{1,5}-\d+ )?Draft the plan/.test(a.title)));
  assert.deepEqual(h.goals, []);

  // a later successful turn clears the error
  const ok = await s.repo.createTurn(session.id, { text: 'again' });
  await s.repo.updateTurn(ok.id, { status: 'done' });
  const again = await s.home.home(s.ws.id, { since: h.since });
  assert.equal(again.team.find((a) => a.id === s.writer.id)!.errors.length, 0);
});

test('the visit: first visit looks back a day, a visit within the session gap keeps the window, a later one starts from the last', async () => {
  const s = await setup();
  const t0 = new Date('2026-11-02T08:00:00Z');
  const first = await s.home.touchVisit(s.ws.id, t0);
  assert.equal(first.firstVisit, true);
  assert.equal(first.since, new Date(t0.getTime() - 24 * 3_600_000).toISOString());
  const t1 = new Date(t0.getTime() + 5 * 60_000);
  assert.equal((await s.home.touchVisit(s.ws.id, t1)).since, first.since, 'same session');
  const t2 = new Date(t1.getTime() + SESSION_GAP_MS + 60_000);
  const later = await s.home.touchVisit(s.ws.id, t2);
  assert.equal(later.since, t1.toISOString(), 'since the last time you were here');
  assert.equal(later.firstVisit, false);
  // ?since= refreshes do not touch the record
  await s.home.home(s.ws.id, { since: t0.toISOString(), now: new Date(t2.getTime() + 2 * SESSION_GAP_MS) });
  assert.equal((await s.home.touchVisit(s.ws.id, new Date(t2.getTime() + 60_000))).since, t1.toISOString());
  // the visit row is bookkeeping, never a setting the SPA sees
  assert.ok(!Object.keys(await new SettingsService(s.db).all()).some((k) => k.startsWith('home.')));
});

test('a company: decision cards with defaults, escalations first, held actions deduped against their card, plans to veto, goals at risk first', async () => {
  const plan = { id: 'plan1', orgId: '', trigger: 'daily', summary: 'Hire a researcher and open two tasks', actions: JSON.stringify([{}, {}]), estimateUsd: 1.5, status: 'pending', vetoWindowMinutes: 30, result: '[]', createdAt: new Date().toISOString(), applyAt: new Date(Date.now() + 20 * 60_000).toISOString(), appliedAt: null, decidedBy: '', accountId: 'single' };
  const kr = (id: string, atRisk: number, confidence: number | null) => ({ id, kind: 'key_result', title: `KR ${id}`, status: 'active', currentValue: 2, targetValue: 10, unitLabel: 'subs', progress: 0.2, confidence, atRisk, atRiskReason: atRisk ? 'behind pace' : '', pace: atRisk ? 'behind' : 'onPace', dueAt: null, children: [] });
  const intent = { intentTree: async () => [{
    id: 'v', kind: 'vision', title: 'Vision', status: 'active', children: [
      { id: 'o1', kind: 'objective', title: 'Ship the newsletter', status: 'active', progress: 0.8, confidence: 0.9, atRisk: 0, atRiskReason: '', pace: 'onPace', ownerName: 'Writer', dueAt: null, children: [kr('k1', 0, 0.9)] },
      { id: 'o2', kind: 'objective', title: 'Grow subscribers', status: 'active', progress: 0.1, confidence: 0.3, atRisk: 0, atRiskReason: '', pace: 'unknown', ownerName: 'Chief', dueAt: null, children: [kr('k2', 1, 0.3)] },
    ],
  }] } as unknown as OrgIntentService;
  const capital = { plans: async () => [plan], forecast: async () => ({ company: { projectedUsd: 18, state: 'warn' } }) } as unknown as OrgCapitalService;
  let held: Array<Record<string, unknown>> = [];
  const actions = { list: async (_ws: string, q: { status?: string }) => (q.status === 'held' ? held : []) } as unknown as ActionsService;
  const s = await setup({ intent, capital, actions });
  const st = await s.mode.setMode(s.ws.id, { mode: 'supervised', chiefOfStaffAgentId: s.chief.id, monthlyUsd: 20 });
  const orgId = st.orgId!;
  const hire = await s.approvals.create(orgId, { kind: 'hire', payload: { name: 'Ana', title: 'Researcher' }, requestedBy: 'chief', recommendation: 'We need research capacity.', card: { recommendedAction: 'approve', confidence: 0.7 } as never });
  const esc = await s.approvals.create(orgId, { kind: 'escalation', payload: { title: 'Pricing page', reason: 'Two leads disagree' }, requestedBy: s.writer.id });
  const twoKey = await s.approvals.create(orgId, { kind: 'two_key', payload: { tool: 'gmail_send', class: 'external_send', summary: 'to 120', actionId: 'act-carded' }, requestedBy: s.writer.id });
  held = [
    { id: 'act-carded', class: 'external_send', tool: 'gmail_send', status: 'held', keys: JSON.stringify({ approvalId: twoKey.id }), note: '', input: '{}', agentId: s.writer.id, sessionId: 's', createdAt: new Date().toISOString() },
    { id: 'act-bare', class: 'money', tool: 'pay_invoice', status: 'held', keys: JSON.stringify({ why: 'money needs your key' }), note: '', input: '{}', agentId: s.writer.id, sessionId: 's', createdAt: new Date().toISOString() },
  ];

  const h = await s.home.home(s.ws.id);
  assert.ok(h.company);
  assert.equal(h.company!.mode, 'supervised'); assert.equal(h.company!.status, 'active');
  assert.equal(h.company!.chiefName, 'Chief'); assert.equal(h.company!.memberCount, 2);

  const byId = new Map(h.needs.map((n) => [n.id, n]));
  const hireCard = byId.get(`approval:${hire.id}`)!;
  assert.equal(hireCard.kind, 'approval'); assert.equal(hireCard.title, 'Ana as Researcher');
  assert.equal(hireCard.requestedBy, 'Chief'); assert.equal(hireCard.recommendation, 'We need research capacity.');
  assert.equal(hireCard.defaultAction, 'deny', 'a hire spends money: deny by default (docs/owners-seat.md §1)');
  assert.ok(hireCard.deadline, 'every card carries its deadline');
  assert.deepEqual(hireCard.actions, ['approve', 'reject']);
  assert.equal(byId.get(`approval:${esc.id}`)!.kind, 'escalation');
  assert.equal(byId.get(`approval:${esc.id}`)!.severity, 'high');
  assert.equal(byId.get(`approval:${twoKey.id}`)!.kind, 'held_action');
  assert.ok(!byId.has('action:act-carded'), 'a held action carried by its two-key card is listed once');
  assert.equal(byId.get('action:act-bare')!.kind, 'held_action');
  assert.equal(byId.get('plan:plan1')!.defaultAction, 'apply');
  assert.deepEqual(byId.get('plan:plan1')!.actions, ['veto', 'apply_now']);
  assert.equal(h.headline.needsYou, 5);
  assert.notEqual(h.needs.at(-1)!.severity, 'high', 'high-severity cards lead');
  assert.equal(h.needs.findIndex((n) => n.severity === 'normal') > h.needs.findLastIndex((n) => n.severity === 'high'), true);

  assert.deepEqual(h.goals.map((g) => g.id), ['o2', 'o1'], 'at-risk objectives first');
  assert.equal(h.goals[0].rag, 'red'); assert.equal(h.goals[0].atRiskReason, 'behind pace');
  assert.equal(h.goals[1].rag, 'green');
  assert.equal(h.goals[0].keyResults[0].title, 'KR k2');

  assert.equal(h.spend.monthCapUsd, 20); assert.equal(h.spend.projectedUsd, 18); assert.equal(h.spend.forecastState, 'warn');
  assert.ok(h.upcoming.some((u) => u.kind === 'plan'));
  assert.ok(h.upcoming.some((u) => u.kind === 'decision' && u.ref?.id === hire.id));
  assert.equal(h.team[0].isChief, true, 'the chief of staff leads the team grid');
  assert.ok(h.recap.people.some((p) => p.kind === 'hire' && /Writer joined/.test(p.title)));

  // the kill switch shows on Home; a paused company pauses every member card
  await s.mode.pause(s.ws.id);
  const paused = await s.home.home(s.ws.id, { since: h.since });
  assert.equal(paused.company!.status, 'paused');
  assert.ok(paused.team.every((a) => a.state === 'paused' || a.state === 'error'));

  // an approval decided elsewhere leaves the list
  await s.approvals.decide(orgId, hire.id, 'reject', '', 'user');
  assert.ok(!(await s.home.home(s.ws.id, { since: h.since })).needs.some((n) => n.id === `approval:${hire.id}`));
});

test('a failing source marks its section partial and the rest still renders; no-progress breaker trips are loud', async () => {
  const intent = { intentTree: async () => { throw new Error('boom'); } } as unknown as OrgIntentService;
  const s = await setup({ intent });
  const st = await s.mode.setMode(s.ws.id, { mode: 'autonomous', chiefOfStaffAgentId: s.chief.id });
  const t = await s.tasks.create(st.orgId!, { title: 'Write launch post', assigneeAgentId: s.writer.id });
  await s.tasks.update(st.orgId!, t.id, { noProgressCount: 3, status: 'in_progress' }, 'system');
  const h = await s.home.home(s.ws.id);
  assert.deepEqual(h.partial, ['goals']);
  assert.equal(h.company!.mode, 'autonomous');
  const w = h.team.find((a) => a.id === s.writer.id)!;
  assert.equal(w.state, 'error');
  assert.equal(w.errors[0].kind, 'breaker');
  assert.match(w.errors[0].message, /No progress after 3 runs on "Write launch post"/);
  assert.equal(w.doing, 'Write launch post');
  assert.equal(w.taskId, t.id);
});

test('pure helpers: RAG, ranking and the next cron fire', () => {
  assert.equal(ragOf({ atRisk: 1, confidence: 0.9 }), 'red');
  assert.equal(ragOf({ atRisk: 0, pace: 'behind', confidence: 0.9 }), 'amber');
  assert.equal(ragOf({ atRisk: 0, confidence: 0.2 }), 'grey', 'a low confidence number alone is not amber (docs/work-tracking.md)');
  assert.equal(ragOf({ atRisk: 0, pace: 'onPace', confidence: null }), 'green');
  assert.equal(ragOf({ atRisk: 0, pace: 'unknown', confidence: null }), 'grey');
  const n = (id: string, severity: HomeNeed['severity'], deadline: string | null, createdAt = '2026-01-01') => ({ id, severity, deadline, createdAt }) as HomeNeed;
  assert.deepEqual(rankNeeds([n('a', 'normal', null), n('b', 'normal', '2026-02-01'), n('c', 'critical', null), n('d', 'high', '2026-03-01')]).map((x) => x.id), ['c', 'd', 'b', 'a']);
  const from = new Date(2026, 10, 2, 8, 30);
  const next = nextCronFire('0 9 * * *', from)!;
  assert.equal(next.getHours(), 9); assert.equal(next.getMinutes(), 0); assert.equal(next.getDate(), 2);
  assert.equal(nextCronFire('not a cron', from), null);
});

test('activity: routine heartbeat runs collapse into one line per agent per day; a run that did something stands alone, described by what it did', async () => {
  const s = await setup();
  const st = await s.mode.setMode(s.ws.id, { mode: 'autonomous', chiefOfStaffAgentId: s.chief.id });
  const t = await s.tasks.create(st.orgId!, { title: 'Write launch post', assigneeAgentId: s.writer.id });
  const session = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.writer.id, name: 'Loop · heartbeat' });
  const beat = async (calls: Array<{ tool: string; input: Record<string, unknown>; isError?: boolean }>, answer: string) => {
    const turn = await s.repo.createTurn(session.id, { text: 'Scheduled loop firing: "heartbeat".' });
    await s.repo.updateTurn(turn.id, { status: 'done', toolCalls: JSON.stringify(calls) });
    await s.agents.addEvent(s.writer.id, { kind: 'loop_run', title: 'Loop "heartbeat" ran', body: answer, sessionId: session.id, origin: 'loop', payload: JSON.stringify({ turnId: turn.id }) });
  };
  await beat([{ tool: 'list_tasks', input: {} }, { tool: 'channel_read', input: { channel: 'general' } }], 'Nothing changed.');
  await beat([{ tool: 'org_read_board', input: {} }, { tool: 'fs_append', input: { path: 'JOURNAL.md', content: 'checked' } }, { tool: 'update_task', input: { id: 'k1', note: 'still waiting' } }], 'Still blocked.');
  await beat([], 'Nothing to do.');
  await beat([{ tool: 'org_task_update', input: { taskId: t.id.slice(0, 8), status: 'blocked', note: 'waits on legal' } }, { tool: 'channel_post', input: { channel: 'company', text: 'blocked' } }, { tool: 'fs_write', input: { path: 'drafts/launch.md', content: 'x' } }, { tool: 'gmail_send', input: {}, isError: true }], 'Blocked on legal.');
  const h = await s.home.home(s.ws.id);
  const runs = h.activity.filter((a) => a.kind === 'agent');
  assert.equal(runs.length, 2, 'one summary line and one notable run');
  const summary = runs.find((a) => a.runs)!;
  assert.equal(summary.title, 'Writer · 3 heartbeat checks, nothing new');
  assert.equal(summary.runs!.count, 3);
  assert.equal(summary.runs!.items.length, 3);
  assert.deepEqual(summary.runs!.loops, ['heartbeat']);
  assert.deepEqual(summary.ref, { type: 'agent', id: s.writer.id });
  const notable = runs.find((a) => a.loop)!;
  assert.equal(notable.title, `Heartbeat: moved task ${t.id.slice(0, 8)} to blocked, posted in #company, wrote launch.md`);
  assert.deepEqual(notable.ref, { type: 'task', id: t.id }, 'the run links the task it changed');
  assert.equal(notable.actor, 'Writer');
  assert.ok(!h.activity.some((a) => a.title === 'Loop "heartbeat" ran'), 'no raw routine rows');
});

test('coming up: a ritual every unit holds at the same time is one row naming the units; cadences carry their cron', async () => {
  const s = await setup();
  const st = await s.mode.setMode(s.ws.id, { mode: 'autonomous', chiefOfStaffAgentId: s.chief.id });
  const orgId = st.orgId!;
  const now = new Date();
  const at = new Date(now.getTime() + 2 * 86_400_000).toISOString();
  const later = new Date(now.getTime() + 2 * 86_400_000 + 30 * 60_000).toISOString();
  const unit = (id: string, name: string, parent: string | null) => ({ accountId: 'single', id, orgId, leadAgentId: `lead-${id}`, parentUnitId: parent, name, slug: id, channelId: null, archivedAt: null, createdAt: now.toISOString() });
  await s.db.delete(orgUnits);
  await s.db.insert(orgUnits).values([unit('root', 'Acme', null), unit('eng', 'Engineering', 'root'), unit('sales', 'Sales', 'root')]);
  const cad = (id: string, unitId: string, kind: string, cron: string, nextRunAt: string) => ({ id, orgId, unitId, kind, cron, enabled: 1, nextRunAt, lastRunAt: null, createdAt: now.toISOString() });
  const meetings = {
    list: async () => [],
    cadences: async () => [
      cad('c1', 'eng', 'weekly_review', '0 16 * * 5', at), cad('c2', 'sales', 'weekly_review', '0 16 * * 5', at),
      cad('c3', 'eng', 'retro', '30 16 * * 5', later), cad('c4', 'sales', 'retro', '30 16 * * 5', later), cad('c5', 'root', 'retro', '30 16 * * 5', later),
    ],
    decisions: async () => [],
  } as unknown as OrgMeetingsService;
  const home = new HomeService(
    s.db, s.workspaces, s.agents, s.config, s.fs, undefined, undefined, undefined,
    s.org, s.tasks, s.approvals, s.audit, s.brief, undefined, undefined, undefined, undefined, meetings, undefined, undefined, s.runtime,
  );
  const h = await home.home(s.ws.id);
  const rituals = h.upcoming.filter((u) => u.kind === 'ritual');
  assert.equal(rituals.length, 2, 'one row per ritual and time');
  const review = rituals.find((u) => u.title === 'Weekly review')!;
  assert.deepEqual(review.units, ['Engineering', 'Sales']);
  assert.equal(review.detail, 'Engineering, Sales');
  assert.equal(review.cron, '0 16 * * 5');
  assert.deepEqual(rituals.find((u) => u.title === 'Retro')!.units, ['Engineering', 'Sales', 'Company']);
  assert.ok(!h.upcoming.some((u) => /\* \*/.test(u.detail)), 'no raw cron in the detail');
});

test('pure helpers: what a run did, routine collapsing per agent and day, merging the same thing at the same time', () => {
  assert.deepEqual(describeRun([{ tool: 'fs_read', input: { path: 'a.md' } }, { tool: 'fs_append', input: { path: '/agents/w/LESSONS.md' } }, { tool: 'update_dashboard', input: {} }]), { notable: false, phrases: [], taskId: null });
  assert.equal(describeRun([{ tool: 'org_escalate', input: { taskId: 'abcd1234' } }]).taskId, 'abcd1234');
  assert.deepEqual(describeRun([{ tool: 'fs_edit', input: { path: 'a/x.md' } }, { tool: 'fs_edit', input: { path: 'b/y.md' } }, { tool: 'add_task', input: {} }]).phrases, ['created a task', 'changed 2 files']);
  assert.equal(describeRun([{ tool: 'channel_post', input: { channel: 'general' }, isError: true }]).notable, false, 'a failed call did nothing');
  assert.equal(routineTitle('Ada', ['heartbeat'], 1), 'Ada · 1 heartbeat check, nothing new');
  assert.equal(routineTitle('Ada', ['digest'], 2), 'Ada · 2 "digest" runs, nothing new');
  assert.equal(routineTitle('Ada', ['digest', 'heartbeat'], 4), 'Ada · 4 loop runs, nothing new');
  const run = (agentId: string, at: string) => ({ agentId, agentName: agentId, loop: 'heartbeat', run: { id: `${agentId}${at}`, at, title: '', detail: '' } });
  const rows = collapseRoutine([run('a', '2026-11-02T09:00:00Z'), run('a', '2026-11-02T10:00:00Z'), run('a', '2026-11-01T10:00:00Z'), run('b', '2026-11-02T09:30:00Z')]);
  assert.equal(rows.length, 3);
  const a2 = rows.find((r) => r.id === 'routine:a:2026-11-02')!;
  assert.equal(a2.at, '2026-11-02T10:00:00Z');
  assert.equal(a2.runs!.from, '2026-11-02T09:00:00Z');
  const up = (id: string, title: string, at: string, units?: string[]) => ({ id, at, kind: 'ritual' as const, title, detail: units?.join(', ') ?? '', ref: null, units });
  const merged = mergeUpcoming([up('1', 'Retro', 'T1', ['Sales']), up('2', 'Retro', 'T1', ['Engineering']), up('3', 'Retro', 'T2', ['Sales']), up('4', 'Standup', 'T1', ['Sales'])]);
  assert.deepEqual(merged.map((m) => [m.id, m.detail]), [['1', 'Sales, Engineering'], ['3', 'Sales'], ['4', 'Sales']]);
});
