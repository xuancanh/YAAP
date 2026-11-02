/** Intent (docs/company-vision.md §1b–§2, execution-plan item 18): one
 *  active vision per org, revised in place; key results with metric, target,
 *  owner and due date, scoped to the lead's unit; check-ins with history;
 *  model-free pace and at-risk rules (behind pace, two confidence drops,
 *  overdue, missing owner, an objective with two at-risk key results); the
 *  why chain with a broken flag; the cascade (an objective handed to a unit
 *  queues that unit's planning session, a vision queues the root's); the
 *  at-risk wake once per goal per day; the brief's Key results section; the
 *  tunables with bounds and the operating profile reaching the planning
 *  prompt; the API. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import { organizations, orgGoals } from '../server/src/database/schema';
import { testDb, memStorage, ctxStub, skillsStub, mcpStub, ScriptedProvider } from './helpers';
import { AiStreamEvent } from '../server/src/ai/ai-provider.interface';
import { ChatsRepository } from '../server/src/chats/chats.repository';
import { TurnLoopService } from '../server/src/chats/turn-loop.service';
import { ChatLocks } from '../server/src/chats/chat-locks';
import { ToolsService } from '../server/src/chats/tools.service';
import { TriggerBus } from '../server/src/chats/trigger-bus';
import { AgentsService } from '../server/src/agents/agents.service';
import { WorkspacesService } from '../server/src/workspaces/workspaces.service';
import { GroupChatService, COMPANY_SLUG } from '../server/src/groupchat/groupchat.service';
import { WorkspaceEventBus } from '../server/src/groupchat/workspace-events';
import { OrgAuditService } from '../server/src/org/org-audit.service';
import { OrgService } from '../server/src/org/org.service';
import { OrgTasksService } from '../server/src/org/org-tasks.service';
import { OrgApprovalsService } from '../server/src/org/org-approvals.service';
import { OrgBriefService } from '../server/src/org/org-brief.service';
import { OrgRuntimeService } from '../server/src/org/org-runtime.service';
import { OrgModeService } from '../server/src/org/org-mode.service';
import { OrgAnnouncer } from '../server/src/org/org-announcer';
import { OrgUnitsService } from '../server/src/org/org-units.service';
import { OrgIntentService, paceOf, measuredProgress } from '../server/src/org/org-intent.service';
import { TUNABLES, checkTunable, tunable, registerTunables } from '../server/src/org/org-tunables';
import { OrgController } from '../server/src/org/org.controller';
import { WorkspaceOrgController } from '../server/src/org/workspace-org.controller';
import { setAddressLookup } from '../server/src/common/url-guard';

setAddressLookup(async () => [{ address: '93.184.216.34', family: 4 }]);

const DAY = 24 * 60 * 60_000;
const iso = (offsetDays: number, from = Date.now()) => new Date(from + offsetDays * DAY).toISOString();

/** The org stack of backend-org-units.test.ts plus OrgIntentService; the
 *  group chat is bound so #company lines can be read. */
async function setup(rounds: AiStreamEvent[][] = []) {
  const db = await testDb();
  const { stub } = memStorage();
  const bus = new TriggerBus();
  const agents = new AgentsService(db, stub, bus);
  const workspaces = new WorkspacesService(db, stub);
  const repo = new ChatsRepository(db);
  const provider = new ScriptedProvider(rounds);
  const turns = new TurnLoopService(repo, new ChatLocks(), new ToolsService(stub), ctxStub(provider), skillsStub(), stub, mcpStub(), agents, workspaces);
  const config = { get: (k: string) => (k === 'companiesEnabled' ? true : k === 'loopsEnabled' ? false : undefined) } as unknown as ConfigService;
  const announcer = new OrgAnnouncer();
  const audit = new OrgAuditService(db);
  const org = new OrgService(db, agents, audit, bus);
  const units = new OrgUnitsService(db, org, agents, audit, announcer);
  const intent = new OrgIntentService(db, org, units, agents, audit, bus);
  const tasks = new OrgTasksService(db, org, audit, bus, units);
  const approvals = new OrgApprovalsService(db, org, tasks, agents, audit, undefined, bus);
  const brief = new OrgBriefService(db, org, tasks, approvals, audit, agents, workspaces, undefined, undefined, intent);
  const runtime = new OrgRuntimeService(db, org, tasks, approvals, audit, brief, turns, repo, agents, workspaces, config, announcer, bus, undefined, undefined, undefined, undefined, undefined, units, undefined, undefined, intent);
  runtime.debounceMs = 15;
  runtime.planningDebounceMs = 15;
  runtime.planningCooldownMs = 60_000;
  const mode = new OrgModeService(org, workspaces, agents, runtime, approvals, audit, announcer);
  const orgs = new OrgController(org, tasks, approvals, audit, brief, runtime, config, units, undefined, undefined, undefined, intent);
  const controller = new WorkspaceOrgController(mode, orgs, config);
  const groupchat = new GroupChatService(db, workspaces, agents, stub, new WorkspaceEventBus(), config, undefined, bus, org, tasks, announcer);
  const ws = (await workspaces.list())[0];
  const chief = await agents.create({ name: 'Chief', charter: 'You run the company.' });
  const writer = await agents.create({ name: 'Writer', charter: 'You write.' });
  const editor = await agents.create({ name: 'Editor', charter: 'You edit.' });
  return { db, agents, workspaces, repo, provider, bus, audit, org, units, intent, tasks, approvals, brief, runtime, mode, orgs, controller, groupchat, ws, chief, writer, editor };
}
type S = Awaited<ReturnType<typeof setup>>;

async function enable(s: S, modeName: 'supervised' | 'autonomous' = 'autonomous') {
  const st = await s.mode.setMode(s.ws.id, { mode: modeName, chiefOfStaffAgentId: s.chief.id, monthlyUsd: 50, agentCap: 10 });
  return st.orgId!;
}

/** Writer leads a unit (Alpha reports to it); returns the unit and Alpha. */
async function writerUnit(s: S, orgId: string) {
  const alpha = await s.agents.create({ name: 'Alpha' });
  await s.org.addMember(orgId, { agentId: alpha.id, reportsToAgentId: s.writer.id, scopes: [] });
  return { unit: (await s.units.ledBy(orgId, s.writer.id))!, alpha };
}

/** Pretend a goal was created `days` ago (pace and overdue rules read createdAt). */
const backdate = (s: S, goalId: string, days: number) => s.db.update(orgGoals).set({ createdAt: iso(-days) }).where(eq(orgGoals.id, goalId));

// ---- 1. the vision ----

test('one active vision per org: setVision creates it in the root unit with rules and horizon, a second vision is refused, a revision keeps the id, and each queues root planning', async () => {
  const s = await setup();
  const orgId = await enable(s);
  const root = await s.units.rootUnit(orgId);
  const { vision, org } = await s.intent.setVision(orgId, { title: 'A weekly newsletter 5,000 people open', description: 'Ship every Friday.', dueAt: iso(90), rules: 'Never send without a human read.', monthlyUsd: 80 });
  assert.equal(vision.kind, 'vision'); assert.equal(vision.unitId, root.id); assert.equal(vision.dueAt?.slice(0, 10), iso(90).slice(0, 10));
  assert.equal(org.rules, 'Never send without a human read.');
  assert.equal(org.monthlyBudgetUsd, 80, 'the vision carries the budget');
  assert.deepEqual(s.runtime.pendingPlanningUnits(), [root.id], 'a vision queues the root planning session');
  await assert.rejects(s.org.addGoal(orgId, { title: 'Another vision', kind: 'vision' }), /already has an active vision/);
  await assert.rejects(s.units.addGoal(orgId, { title: 'Another vision', kind: 'vision' }), /already has an active vision/);
  const again = await s.intent.setVision(orgId, { title: 'A newsletter 10,000 people open' });
  assert.equal(again.vision.id, vision.id, 'revised in place');
  assert.equal(again.vision.title, 'A newsletter 10,000 people open');
  assert.equal(again.vision.description, 'Ship every Friday.', 'untouched fields stay');
  assert.equal((await s.intent.vision(orgId))!.id, vision.id);
  const actions = (await s.audit.list(orgId, { limit: 50 })).map((r) => r.action);
  assert.ok(actions.includes('vision_set') && actions.includes('vision_revise'));
  // the API: GET/PUT vision (the owner is the CEO)
  assert.equal((await s.controller.vision(s.ws.id)).vision!.id, vision.id);
  assert.equal((await s.controller.vision(s.ws.id)).rules, 'Never send without a human read.');
  const viaApi = await s.controller.setVision(s.ws.id, { title: 'Via the API' });
  assert.equal(viaApi.vision.id, vision.id);
  // an abandoned vision makes room for a new one
  await s.org.updateGoal(orgId, vision.id, { status: 'abandoned' });
  const fresh = await s.intent.setVision(orgId, { title: 'Start over' });
  assert.notEqual(fresh.vision.id, vision.id);
});

// ---- 2. key results, scoped ----

test('org_set_key_result: a lead sets one under a visible objective for itself or a report; an outsider as owner is refused; a plain member has no such tool; the chief sets anywhere', async () => {
  const s = await setup();
  const orgId = await enable(s);
  const { unit, alpha } = await writerUnit(s, orgId);
  const objective = await s.units.addGoal(orgId, { title: 'Grow the list' });
  const writerSession = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.writer.id, name: 'writer chat' });
  const editorSession = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.editor.id, name: 'editor chat' });
  const chiefSession = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.chief.id, name: 'chief chat' });
  const specs = (await s.runtime.specsFor(writerSession)).map((t) => t.name);
  for (const t of ['org_set_key_result', 'org_check_in', 'org_why', 'org_intent']) assert.ok(specs.includes(t), `lead has ${t}`);
  assert.ok(!specs.includes('org_strategy_memo') && !specs.includes('org_tune'), 'not the chief\'s');
  const memberSpecs = (await s.runtime.specsFor(editorSession)).map((t) => t.name);
  assert.ok(!memberSpecs.includes('org_set_key_result'));
  assert.ok(memberSpecs.includes('org_check_in') && memberSpecs.includes('org_why'), 'members check in and ask why');
  const out = await s.runtime.execute(writerSession, 'org_set_key_result', { title: 'Subscribers', objectiveId: objective.id.slice(0, 8), metric: 'subscribers', targetValue: 5000, startValue: 1200, unitLabel: 'people', dueAt: iso(60), owner: 'Alpha', checkInCadenceDays: 3 });
  assert.match(out, /Key result \[[0-9a-f]{8}\] "Subscribers" set under \[[0-9a-f]{8}\] "Grow the list": subscribers 1200 → 5000 people by \d{4}-\d{2}-\d{2}, owner Alpha, check-in every 3 day\(s\)/);
  const kr = (await s.org.goals(orgId)).find((g) => g.kind === 'key_result')!;
  assert.equal(kr.parentGoalId, objective.id); assert.equal(kr.ownerAgentId, alpha.id); assert.equal(kr.unitId, unit.id); assert.equal(kr.checkInCadenceDays, 3);
  assert.equal(kr.confidence, null, 'never checked in'); assert.equal(kr.currentValue, null);
  await assert.rejects(s.runtime.execute(writerSession, 'org_set_key_result', { title: 'x', objectiveId: objective.id, targetValue: 1, dueAt: iso(10), owner: 'Editor' }), /outside your unit/);
  await assert.rejects(s.runtime.execute(editorSession, 'org_set_key_result', { title: 'x', objectiveId: objective.id, targetValue: 1, dueAt: iso(10), owner: 'Editor' }), /chief of staff and unit leads/);
  await assert.rejects(s.runtime.execute(writerSession, 'org_set_key_result', { title: 'x', objectiveId: kr.id, targetValue: 1, dueAt: iso(10), owner: 'Alpha' }), /not under another key result/);
  await assert.rejects(s.runtime.execute(writerSession, 'org_set_key_result', { title: 'x', objectiveId: objective.id, targetValue: 1, dueAt: 'soon', owner: 'Alpha' }), /ISO date/);
  assert.match(await s.runtime.execute(chiefSession, 'org_set_key_result', { title: 'Open rate', objectiveId: objective.id, metric: 'open rate', targetValue: 45, startValue: 30, unitLabel: '%', dueAt: iso(60), owner: 'Editor' }), /owner Editor, check-in every 7 day\(s\)/);
  // the default cadence is the org's tunable
  await s.org.setTunable(orgId, 'intent.checkInCadenceDays', 14);
  const kr3 = await s.intent.setKeyResult(orgId, { title: 'Replies', objectiveId: objective.id, targetValue: 10, dueAt: iso(30), ownerAgentId: s.editor.id });
  assert.equal(kr3.checkInCadenceDays, 14);
  assert.equal(s.runtime.isReadOnly('org_intent'), true); assert.equal(s.runtime.isReadOnly('org_why'), true);
  assert.equal(s.runtime.isReadOnly('org_check_in'), false); assert.equal(s.runtime.owns('org_set_key_result'), true);
});

// ---- 3. check-ins ----

test('check-ins update the key result and keep a history; the owner, its manager and the chief may check in, nobody else; the API lists them', async () => {
  const s = await setup();
  const orgId = await enable(s);
  const { alpha } = await writerUnit(s, orgId);
  const objective = await s.units.addGoal(orgId, { title: 'Grow the list' });
  const kr = await s.intent.setKeyResult(orgId, { title: 'Subscribers', objectiveId: objective.id, metric: 'subscribers', targetValue: 5000, startValue: 1000, dueAt: iso(60), ownerAgentId: alpha.id });
  const alphaSession = await s.repo.createSession({ workspaceId: s.ws.id, agentId: alpha.id, name: 'alpha chat' });
  const writerSession = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.writer.id, name: 'writer chat' });
  const editorSession = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.editor.id, name: 'editor chat' });
  // the owner's one key result is the default goalId
  const out = await s.runtime.execute(alphaSession, 'org_check_in', { currentValue: 2000, confidence: 0.8, note: 'Launch post landed.' });
  assert.match(out, /Check-in recorded on \[[0-9a-f]{8}\] "Subscribers": subscribers 2000 of 5000, confidence 80%; pace: onPace/);
  let g = await s.org.goal(orgId, kr.id);
  assert.equal(g.currentValue, 2000); assert.equal(g.confidence, 0.8); assert.ok(g.lastCheckInAt);
  // the manager; a confidence-only check-in keeps the value
  assert.match(await s.runtime.execute(writerSession, 'org_check_in', { goalId: kr.id.slice(0, 8), confidence: 0.6 }), /2000 of 5000, confidence 60%/);
  g = await s.org.goal(orgId, kr.id);
  assert.equal(g.currentValue, 2000); assert.equal(g.confidence, 0.6);
  await assert.rejects(s.runtime.execute(editorSession, 'org_check_in', { goalId: kr.id, currentValue: 1 }), /only the owner \(Alpha\), its manager or the chief of staff/);
  await assert.rejects(s.runtime.execute(editorSession, 'org_check_in', { currentValue: 1 }), /you own no key result/);
  await assert.rejects(s.runtime.execute(alphaSession, 'org_check_in', { goalId: kr.id, confidence: 1.5 }), /0–1/);
  await assert.rejects(s.runtime.execute(alphaSession, 'org_check_in', { goalId: kr.id }), /needs currentValue and\/or confidence/);
  await assert.rejects(s.intent.checkIn(orgId, objective.id, { currentValue: 1 }), /for key results/);
  // the API: the CEO checks in; history in order
  await s.controller.checkIn(s.ws.id, kr.id, { currentValue: 2600, confidence: 0.7, note: 'Steady.' });
  const history = await s.controller.checkIns(s.ws.id, kr.id);
  assert.equal(history.length, 3);
  assert.deepEqual(history.map((c) => c.confidence), [0.8, 0.6, 0.7]);
  assert.deepEqual(history.map((c) => c.actor), [`agent:${alpha.id}`, `agent:${s.writer.id}`, 'user']);
  assert.equal(history[0].note, 'Launch post landed.');
  assert.equal((await s.audit.list(orgId, { action: 'goal_checkin' })).length, 3);
  // the tree shows measured progress and pace
  const tree = await s.intent.intentTree(orgId);
  const node = tree[0].children[0];
  assert.equal(node.kind, 'key_result'); assert.equal(node.measured, 0.4); assert.equal(node.progress, 0.4); assert.equal(node.pace, 'onPace'); assert.equal(node.ownerName, 'Alpha');
  assert.equal(tree[0].progress, 0.4, 'the objective blends its (measured) children');
  assert.match(await s.runtime.execute(alphaSession, 'org_intent', {}), /key result \[[0-9a-f]{8}\] \(active\) Subscribers — 40%, owner Alpha, due \d{4}-\d{2}-\d{2} subscribers: 2600 → 5000; pace onPace, confidence 70%/);
  // the gated heartbeat (item 21): a due check-in and an open task are reasons; the profile and vision are context
  assert.deepEqual(await s.runtime.heartbeatReasons(alpha.id, new Date()), [], 'checked in today, no open task');
  await s.tasks.create(orgId, { title: 'Collect sources', assigneeAgentId: alpha.id });
  const reasons = await s.runtime.heartbeatReasons(alpha.id, new Date(Date.now() + 8 * DAY));
  assert.equal(reasons.length, 2);
  assert.match(reasons[0], /task [A-Z][A-Z0-9]{1,5}-\d+ "Collect sources" is todo/);
  assert.match(reasons[1], /key result \[[0-9a-f]{8}\] "Subscribers" is due a check-in \(org_check_in; cadence 7 day\(s\)\)/);
  await s.org.setProfile(orgId, { values: 'Honest numbers.' });
  await s.intent.setVision(orgId, { title: 'A newsletter people open' });
  assert.match((await s.runtime.heartbeatContext(alpha.id)) ?? '', /vision: A newsletter people open\. Operating profile — values: Honest numbers\./);
  assert.equal(await s.runtime.heartbeatContext(s.chief.id) !== null, true);
});

// ---- 4. pace ----

test('paceOf: linear expectation between createdAt/startValue and dueAt/targetValue vs the measured value; behind beyond the tolerance; unknown without a check-in, target or due date; achieved is on pace', async () => {
  const base = { status: 'active', startValue: 0, targetValue: 100, createdAt: iso(-10), dueAt: iso(10) };
  const now = new Date();
  assert.equal(measuredProgress({ startValue: 1000, targetValue: 5000, currentValue: 2000 }), 0.25);
  assert.equal(measuredProgress({ startValue: null, targetValue: 10, currentValue: 12 }), 1, 'clamped');
  assert.equal(measuredProgress({ startValue: 5, targetValue: 5, currentValue: 5 }), 1, 'a zero span is met at the target');
  const half = paceOf({ ...base, currentValue: 50 }, now);
  assert.equal(half.pace, 'onPace'); assert.ok(Math.abs(half.expected! - 0.5) < 0.01); assert.equal(half.measured, 0.5);
  assert.equal(paceOf({ ...base, currentValue: 36 }, now).pace, 'onPace', 'within 15 points');
  assert.equal(paceOf({ ...base, currentValue: 20 }, now).pace, 'behind');
  assert.equal(paceOf({ ...base, currentValue: 20 }, now, 0.4).pace, 'onPace', 'a wider tolerance (the org tunable)');
  assert.equal(paceOf({ ...base, currentValue: null }, now).pace, 'unknown', 'never checked in');
  assert.equal(paceOf({ ...base, currentValue: 20, dueAt: null }, now).pace, 'unknown');
  assert.equal(paceOf({ ...base, currentValue: 20, targetValue: null }, now).pace, 'unknown');
  assert.equal(paceOf({ ...base, currentValue: 20, dueAt: iso(-1) }, now).expected, 1, 'past due expects everything');
  assert.equal(paceOf({ ...base, currentValue: 0, status: 'achieved' }, now).pace, 'onPace');
});

// ---- 5. at risk ----

test('assessRisk flags a key result behind pace, overdue for check-in, without an active owner, or with confidence falling twice; an objective with two at-risk key results; transitions are audited and the thresholds are the org\'s tunables', async () => {
  const s = await setup();
  const orgId = await enable(s);
  const { alpha } = await writerUnit(s, orgId);
  const o1 = await s.units.addGoal(orgId, { title: 'Grow the list' });
  const o2 = await s.units.addGoal(orgId, { title: 'Quality' });
  const mk = (title: string, parent: string, owner: string | null, extra: { dueAt?: string; cadence?: number } = {}) =>
    s.intent.setKeyResult(orgId, { title, objectiveId: parent, metric: 'n', targetValue: 100, startValue: 0, dueAt: extra.dueAt ?? iso(10), ownerAgentId: owner, checkInCadenceDays: extra.cadence });
  const behind = await mk('Behind', o1.id, alpha.id); await backdate(s, behind.id, 10);
  await s.intent.checkIn(orgId, behind.id, { currentValue: 20, confidence: 0.9 });
  const fine = await mk('Fine', o1.id, alpha.id); await backdate(s, fine.id, 10);
  await s.intent.checkIn(orgId, fine.id, { currentValue: 55, confidence: 0.9 });
  const overdue = await mk('Overdue', o2.id, alpha.id, { dueAt: iso(100), cadence: 7 }); await backdate(s, overdue.id, 20);
  const dropping = await mk('Dropping', o2.id, alpha.id, { dueAt: iso(100) });
  for (const c of [0.9, 0.7, 0.5]) await s.intent.checkIn(orgId, dropping.id, { currentValue: 50, confidence: c });
  const orphan = await mk('Orphan', o2.id, null, { dueAt: iso(100) });
  const paused = await mk('Paused owner', o2.id, s.editor.id, { dueAt: iso(100) });
  await s.intent.checkIn(orgId, paused.id, { currentValue: 50, confidence: 0.9 });
  await s.org.setMemberStatus(orgId, s.editor.id, 'paused');

  const r = await s.intent.assessRisk(orgId);
  const v = (id: string) => r.keyResults.find((k) => k.goal.id === id)!;
  assert.equal(v(behind.id).atRisk, true); assert.match(v(behind.id).reasons[0], /behind pace: 20% done where 50% was expected/);
  assert.equal(v(fine.id).atRisk, false);
  assert.equal(v(overdue.id).atRisk, true); assert.match(v(overdue.id).reasons[0], /check-in overdue: never, cadence 7 day\(s\)/);
  assert.equal(v(dropping.id).atRisk, true); assert.match(v(dropping.id).reasons[0], /confidence fell 2 time\(s\) in a row \(90% → 70% → 50%\)/);
  assert.equal(v(orphan.id).atRisk, true); assert.deepEqual(v(orphan.id).reasons, ['no owner']);
  assert.equal(v(paused.id).atRisk, true); assert.deepEqual(v(paused.id).reasons, ['owner is paused']);
  const obj = (id: string) => r.objectives.find((k) => k.goal.id === id)!;
  assert.equal(obj(o1.id).atRisk, false, 'one at-risk key result is not enough');
  assert.equal(obj(o2.id).atRisk, true); assert.match(obj(o2.id).reasons[0], /4 key results at risk/);
  assert.equal(r.visionAtRisk, false);
  assert.equal(r.newlyAtRisk.length, 6, 'five key results and the objective');
  // written to the rows and audited
  assert.equal((await s.org.goal(orgId, behind.id)).atRisk, 1);
  assert.match((await s.org.goal(orgId, o2.id)).atRiskReason, /key results at risk/);
  assert.equal((await s.audit.list(orgId, { action: 'goal_at_risk' })).length, 6);
  // a second pass changes nothing; a recovery clears and audits
  assert.equal((await s.intent.assessRisk(orgId)).newlyAtRisk.length, 0);
  await s.intent.checkIn(orgId, behind.id, { currentValue: 60, confidence: 0.9 });
  assert.equal((await s.intent.assessRisk(orgId)).keyResults.find((k) => k.goal.id === behind.id)!.atRisk, false);
  assert.equal((await s.org.goal(orgId, behind.id)).atRisk, 0);
  assert.equal((await s.audit.list(orgId, { action: 'goal_risk_cleared' })).length, 1);
  // tunables: three drops needed → Dropping recovers; a 3-cadence overdue → Overdue recovers (20 days < 21)
  await s.org.setTunable(orgId, 'intent.confidenceDrops', 3);
  await s.org.setTunable(orgId, 'intent.overdueCadences', 3);
  const r2 = await s.intent.assessRisk(orgId);
  assert.equal(r2.keyResults.find((k) => k.goal.id === dropping.id)!.atRisk, false);
  assert.equal(r2.keyResults.find((k) => k.goal.id === overdue.id)!.atRisk, false);
  assert.equal(r2.objectives.find((k) => k.goal.id === o2.id)!.atRisk, true, 'orphan + paused owner still make two');
  await s.org.setTunable(orgId, 'intent.objectiveRiskCount', 3);
  assert.equal((await s.intent.assessRisk(orgId)).objectives.find((k) => k.goal.id === o2.id)!.atRisk, false);
});

// ---- 6. the why chain ----

test('whyChain walks task → key result → objective → vision; an abandoned goal or a cancelled task breaks it; an unlinked task says so; org_why reads it', async () => {
  const s = await setup();
  const orgId = await enable(s);
  const { alpha } = await writerUnit(s, orgId);
  const { vision } = await s.intent.setVision(orgId, { title: 'A newsletter people open' });
  const objective = await s.units.addGoal(orgId, { title: 'Grow the list', parentGoalId: vision.id });
  const kr = await s.intent.setKeyResult(orgId, { title: 'Subscribers', objectiveId: objective.id, targetValue: 5000, dueAt: iso(60), ownerAgentId: alpha.id });
  const project = await s.org.addProject(orgId, { title: 'Launch campaign', goalId: kr.id });
  const task = await s.tasks.create(orgId, { title: 'Write the launch post', projectId: project.id, assigneeAgentId: alpha.id });
  const w = await s.intent.whyChain(orgId, { taskId: task.id });
  assert.deepEqual(w.chain.map((l) => `${l.kind}:${l.title}`), ['task:Write the launch post', 'key_result:Subscribers', 'objective:Grow the list', 'vision:A newsletter people open']);
  assert.equal(w.broken, false); assert.equal(w.linked, true);
  const fromGoal = await s.intent.whyChain(orgId, { goalId: kr.id });
  assert.equal(fromGoal.chain.length, 3); assert.equal(fromGoal.chain[0].kind, 'key_result');
  const alphaSession = await s.repo.createSession({ workspaceId: s.ws.id, agentId: alpha.id, name: 'alpha chat' });
  assert.match(await s.runtime.execute(alphaSession, 'org_why', { taskId: task.id.slice(0, 8) }), /^task \[[0-9a-f]{8}\] "Write the launch post" → key result \[[0-9a-f]{8}\] "Subscribers" → objective \[[0-9a-f]{8}\] "Grow the list" → vision \[[0-9a-f]{8}\] "A newsletter people open"$/);
  // broken: the objective is abandoned
  await s.org.updateGoal(orgId, objective.id, { status: 'abandoned' });
  const b = await s.intent.whyChain(orgId, { taskId: task.id });
  assert.equal(b.broken, true); assert.equal(b.brokenAt, objective.id);
  assert.match(await s.runtime.execute(alphaSession, 'org_why', { taskId: task.id }), /BROKEN: a link was abandoned or cancelled/);
  assert.match(await s.runtime.execute(alphaSession, 'org_why', { goalId: kr.id.slice(0, 8) }), /"Grow the list" \(abandoned\)/);
  // unlinked
  const loose = await s.tasks.create(orgId, { title: 'Loose end', assigneeAgentId: alpha.id });
  const u = await s.intent.whyChain(orgId, { taskId: loose.id });
  assert.equal(u.linked, false); assert.equal(u.chain.length, 1);
  assert.match(await s.runtime.execute(alphaSession, 'org_why', { taskId: loose.id }), /not linked to any goal/);
  // the API
  assert.equal((await s.controller.why(s.ws.id, task.id)).brokenAt, objective.id);
  await assert.rejects(s.intent.whyChain(orgId, {}), /taskId or goalId/);
});

// ---- 7. the cascade ----

test('the cascade: an objective handed to a unit (org_set_goal unit=…, or PATCH unitId) queues that unit\'s planning session, debounced and with a cooldown; the lead runs it with its tools; audit, inbox and the unit channel record it', async () => {
  const planRound: AiStreamEvent[] = [{ type: 'tool_call', id: 'p1', name: 'org_set_key_result', input: { title: 'Three drafts a week', objectiveId: '', metric: 'drafts', targetValue: 12, dueAt: iso(30), owner: 'Alpha' } }, { type: 'done' }];
  const s = await setup([planRound, [{ type: 'answer', text: 'Planned: one key result.' }, { type: 'done' }]]);
  const orgId = await enable(s);
  const { unit, alpha } = await writerUnit(s, orgId);
  const root = await s.units.rootUnit(orgId);
  const chiefSession = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.chief.id, name: 'chief chat' });
  // an objective for the company queues nothing …
  await s.runtime.execute(chiefSession, 'org_set_goal', { title: 'Company-wide' });
  assert.deepEqual(s.runtime.pendingPlanningUnits(), []);
  // … one handed to Writer's unit queues Writer's planning
  const out = await s.runtime.execute(chiefSession, 'org_set_goal', { title: 'Three issues drafted', unit: 'writer' });
  assert.match(out, /set for Writer's team/);
  const objective = (await s.org.goals(orgId)).find((g) => g.title === 'Three issues drafted')!;
  assert.equal(objective.unitId, unit.id);
  assert.deepEqual(s.runtime.pendingPlanningUnits(), [unit.id]);
  // a second reason coalesces
  await s.org.updateGoal(orgId, (await s.org.goals(orgId)).find((g) => g.title === 'Company-wide')!.id, { unitId: unit.id });
  assert.deepEqual(s.runtime.pendingPlanningUnits(), [unit.id], 'one pending run per unit');
  planRound[0] = { ...planRound[0], input: { ...(planRound[0] as { input: Record<string, unknown> }).input, objectiveId: objective.id.slice(0, 8) } } as AiStreamEvent;
  await s.runtime.flushPlannings();
  assert.deepEqual(s.runtime.pendingPlanningUnits(), []);
  // the run: Writer's planning session, the prompt carries the objectives and the unit
  assert.equal(s.provider.requests.length, 2, 'the tool round and the answer');
  // (the turn loop extends the same messages array with the tool result, so pick the user turn)
  const prompt = String(s.provider.requests[0].messages.find((m) => m.role === 'user')!.content);
  assert.match(prompt, /You were woken as the lead of Writer's team \(#writer\)/);
  assert.match(prompt, /trigger: objective assigned/);
  assert.match(prompt, /## Objectives handed to this unit[\s\S]*Three issues drafted[\s\S]*Company-wide/);
  assert.match(prompt, /Members: Alpha \(member, active\)/);
  assert.match(prompt, /about 3 key results/);
  const session = (await s.repo.listSessions(s.ws.id)).find((x) => x.name.startsWith('Org · ') && x.name.includes('Planning'))!;
  assert.equal(session.agentId, s.writer.id);
  assert.match(session.name, /Planning · Writer's team$/);
  // the tool worked from the planning context: the key result exists, owned by Alpha, in the unit
  const kr = (await s.org.goals(orgId)).find((g) => g.kind === 'key_result')!;
  assert.equal(kr.parentGoalId, objective.id); assert.equal(kr.ownerAgentId, alpha.id); assert.equal(kr.unitId, unit.id);
  // audit, inbox, the unit channel line, spend
  const actions = (await s.audit.list(orgId, { limit: 100 })).map((r) => r.action);
  assert.ok(actions.includes('planning_start') && actions.includes('planning_end') && actions.includes('spend_reserve'));
  const end = (await s.audit.list(orgId, { action: 'planning_end' }))[0];
  assert.equal(end.refId, unit.id);
  assert.deepEqual(JSON.parse(end.payload).trigger, 'objective_assigned');
  assert.equal(JSON.parse(end.payload).acted, true);
  const ev = (await s.agents.listEvents(s.writer.id, 20)).find((e) => e.kind === 'org_run')!;
  assert.match(ev.title, /^Planned Writer's team \(objective assigned, acted\)/);
  assert.match((await s.groupchat.messages(unit.channelId!)).messages.at(-1)!.text, /^Planning session \(objective assigned\) by Writer: key results and tasks updated/);
  // cooldown: another objective within the window is skipped and audited
  await s.runtime.execute(chiefSession, 'org_set_goal', { title: 'Yet another', unit: 'writer' });
  assert.equal(await s.runtime.flushPlanning(unit.id), 'skipped:cooldown');
  assert.equal((await s.audit.list(orgId, { action: 'planning_skipped' })).length, 1);
  // the CEO's manual run ignores the cooldown and works in supervised mode too; the root is the default
  await s.mode.setMode(s.ws.id, { mode: 'supervised' });
  assert.equal((await s.controller.plan(s.ws.id, { reason: 'quarter start' })).result, 'ran');
  assert.equal((await s.audit.list(orgId, { action: 'planning_start' })).at(0)!.refId, root.id);
  // a paused org drops queued runs; depth and archived units are refused
  s.runtime.queuePlanning(orgId, unit.id, 'manual', 'x');
  await s.runtime.pause(orgId);
  assert.deepEqual(s.runtime.pendingPlanningUnits(), []);
  assert.equal(await s.runtime.runPlanning(orgId, { unitId: unit.id, trigger: 'manual' }), 'skipped:paused');
});

test('the chief\'s root planning: the vision, the rules, the operating profile, the catalog and the tunables reach the prompt; org_strategy_memo stores the memo, posts to #company and GET …/strategy returns it', async () => {
  const memoRound: AiStreamEvent[] = [{ type: 'tool_call', id: 'm1', name: 'org_strategy_memo', input: { text: 'Two objectives: grow the list (Writer) and keep quality (Editor). The envelope buys ~40 drafts. Risk: no designer. Question: paid promotion?' } }, { type: 'done' }];
  const s = await setup([memoRound, [{ type: 'done' }]]);
  const orgId = await enable(s);
  await writerUnit(s, orgId);
  await s.controller.setProfile(s.ws.id, { values: 'Quality over speed; never spam.', culture: 'Terse, written, async; one meeting a week at most.' });
  assert.equal((await s.controller.profile(s.ws.id)).culture, 'Terse, written, async; one meeting a week at most.');
  await s.org.setTunable(orgId, 'planning.objectivesPerVision', 2);
  await s.intent.setVision(orgId, { title: 'A newsletter 5,000 people open', description: 'Every Friday.', dueAt: iso(90), rules: 'No sending without a human read.' });
  await s.runtime.flushPlannings();
  const prompt = String(s.provider.requests[0].messages.find((m) => m.role === 'user')!.content);
  assert.match(prompt, /You were woken as the chief of staff of ".*" for a planning session \(trigger: vision\)/);
  assert.match(prompt, /## Vision\n\n\[[0-9a-f]{8}\] A newsletter 5,000 people open \(horizon \d{4}-\d{2}-\d{2}\)\nEvery Friday\./);
  assert.match(prompt, /## Rules that must never be broken[\s\S]*No sending without a human read\./);
  assert.match(prompt, /## Operating profile \(plan in its spirit\)\n\nValues: Quality over speed; never spam\.\nCulture: Terse, written, async; one meeting a week at most\./);
  assert.match(prompt, /## Roles you can hire from the catalog/);
  assert.match(prompt, /up to 2 company objectives/, 'the tunable shapes the guidance');
  assert.match(prompt, /org_tune them within bounds/);
  assert.match(prompt, /Finish with org_strategy_memo/);
  // the system context of the planning run carried the profile too
  const system = String(s.provider.requests[0].system ?? '');
  assert.match(system, /# Planning session/);
  assert.match(system, /Operating profile — values: Quality over speed; never spam\.; culture: Terse, written, async/);
  // the memo
  const st = await s.controller.strategy(s.ws.id);
  assert.match(st.memo, /^Two objectives: grow the list/); assert.ok(st.at);
  const company = await s.groupchat.bySlug(s.ws.id, COMPANY_SLUG);
  assert.match((await s.groupchat.messages(company.id)).messages.at(-1)!.text, /^Strategy memo from Chief: Two objectives/);
  assert.equal((await s.audit.list(orgId, { action: 'strategy_memo' })).length, 1);
  const chiefSession = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.chief.id, name: 'chief chat' });
  assert.match(await s.runtime.execute(chiefSession, 'org_intent', {}), /^Latest strategy memo \(\d{4}-\d{2}-\d{2}\): Two objectives[\s\S]*Tunables \(value, bound\): intent\.paceTolerance=0\.15 \[0\.02–0\.5\]/);
  const writerSession = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.writer.id, name: 'writer chat' });
  await assert.rejects(s.runtime.execute(writerSession, 'org_strategy_memo', { text: 'x' }), /chief-of-staff tool/);
  // the charter seed names the profile
  assert.match((await s.agents.get(s.chief.id)).charter, /You run the company/);
});

// ---- 8. the at-risk wake ----

test('the minute tick\'s risk sweep wakes the unit lead\'s planning (trigger at_risk) once per goal per day, raises a board event for an objective at risk, and the brief gets a Key results section with the decision line', async () => {
  const s = await setup();
  const orgId = await enable(s);
  const { unit, alpha } = await writerUnit(s, orgId);
  const root = await s.units.rootUnit(orgId);
  const o1 = await s.units.addGoal(orgId, { title: 'Grow the list', unitId: unit.id });
  const o2 = await s.units.addGoal(orgId, { title: 'Quality' });
  await s.runtime.flushPlannings(); // drain the cascade's queue from handing o1 to the unit
  const kr = async (title: string, parent: string, owner: string | null, unitId?: string) => {
    const g = await s.intent.setKeyResult(orgId, { title, objectiveId: parent, metric: 'n', targetValue: 100, startValue: 0, dueAt: iso(10), ownerAgentId: owner, unitId });
    await backdate(s, g.id, 10);
    return g;
  };
  const a = await kr('A', o1.id, alpha.id); await s.intent.checkIn(orgId, a.id, { currentValue: 10, confidence: 0.5 });
  const b = await kr('B', o1.id, alpha.id); await s.intent.checkIn(orgId, b.id, { currentValue: 10, confidence: 0.5 });
  await kr('C', o2.id, null, root.id);
  await kr('D', o2.id, null, root.id);
  const fine = await kr('Fine', o2.id, s.editor.id, root.id); await s.intent.checkIn(orgId, fine.id, { currentValue: 60, confidence: 0.9 });
  await s.runtime.flushPlannings();
  // the sweep (what tickAccount runs per org)
  const now = new Date();
  const r = await s.intent.sweepRisk(orgId, now);
  assert.equal(r.visionAtRisk, true, 'two objectives at risk');
  assert.deepEqual(s.runtime.pendingPlanningUnits().sort(), [root.id, unit.id].sort(), 'each at-risk unit has one queued planning run');
  assert.deepEqual(s.runtime.pendingReviewOrgs(), [orgId], 'an objective at risk is a board event for the chief');
  assert.equal((await s.audit.list(orgId, { action: 'goal_at_risk_wake' })).length, 6, 'four key results and two objectives');
  // same day: nothing more
  await s.intent.sweepRisk(orgId, new Date(now.getTime() + 60_000));
  assert.equal((await s.audit.list(orgId, { action: 'goal_at_risk_wake' })).length, 6);
  // next day: woken again
  await s.intent.sweepRisk(orgId, new Date(now.getTime() + DAY + 60_000));
  assert.equal((await s.audit.list(orgId, { action: 'goal_at_risk_wake' })).length, 12);
  const pending = s.runtime.pendingPlanningUnits();
  assert.equal(pending.length, 2);
  // the brief
  const brief = await s.brief.compose(orgId, { deliver: false, now });
  assert.match(brief.text, /## Key results\n- 5 active: 1 on pace, 2 behind, 2 not yet measurable; 4 at risk\./);
  assert.match(brief.text, /⚠ A \(Alpha, due \d{4}-\d{2}-\d{2}\) — behind pace: 10% done where \d+% was expected/, 'the reason is the latest assessment\'s (a day later)');
  assert.match(brief.text, /⚠ C \(nobody, due \d{4}-\d{2}-\d{2}\) — no owner/);
  assert.match(brief.text, /■ objective at risk: Grow the list — 2 key results at risk/);
  assert.match(brief.text, /\*\*Decision:\*\* 2 objectives are at risk — the vision is\. Cut scope, add budget, or accept the slip/);
  // and the planning run it queued carries the at-risk trigger (the earlier cascade run is inside the cooldown, so lift it)
  s.runtime.planningCooldownMs = 0;
  await s.runtime.flushPlannings();
  const starts = await s.audit.list(orgId, { action: 'planning_start' });
  assert.ok(starts.some((x) => JSON.parse(x.payload).trigger === 'at_risk' && x.refId === unit.id));
  assert.match(JSON.parse(starts.find((x) => x.refId === unit.id)!.payload).reasons[0], /key result "A" at risk: behind pace/);
});

// ---- 9. tunables ----

test('tunables: defaults with bounds; a stored value outside the bound is clamped on read; setting outside the bound is refused with the fence; org_tune applies at once in autonomous mode and is an approval card in supervised mode; every change is a decision-shaped audit row', async () => {
  assert.equal(checkTunable('intent.paceTolerance', 0.3).ok, true);
  assert.match((checkTunable('intent.paceTolerance', 0.9) as { reason: string }).reason, /must stay within 0\.02–0\.5 \(the safety floor; default 0\.15\)/);
  assert.match((checkTunable('nope', 1) as { reason: string }).reason, /unknown tunable "nope"/);
  assert.match((checkTunable('intent.confidenceDrops', 'x') as { reason: string }).reason, /needs a number/);
  registerTunables({ 'intent.paceTolerance': { default: 0.99, min: 0, max: 1, area: 'intent', description: 'ignored' }, 'rituals.standupHour': { default: 9, min: 0, max: 23, area: 'rituals', description: 'another item\'s key' } });
  assert.equal(TUNABLES['intent.paceTolerance'].default, 0.15, 'an existing key keeps its first definition');
  assert.equal(TUNABLES['rituals.standupHour'].default, 9);
  assert.equal(tunable({ tunables: '{"intent.paceTolerance": 5}' }, 'intent.paceTolerance'), 0.5, 'clamped on read');
  assert.equal(tunable({ tunables: 'not json' }, 'intent.paceTolerance'), 0.15);
  assert.equal(tunable(null, 'planning.debounceSeconds'), 120);

  const s = await setup();
  const orgId = await enable(s, 'supervised');
  const r = await s.org.setTunable(orgId, 'intent.paceTolerance', 0.3, { why: 'research moves slowly' });
  assert.deepEqual(r, { key: 'intent.paceTolerance', from: 0.15, to: 0.3 });
  assert.equal(tunable(await s.org.get(orgId), 'intent.paceTolerance'), 0.3);
  await assert.rejects(s.org.setTunable(orgId, 'intent.paceTolerance', 0.9), /must stay within 0\.02–0\.5/);
  await assert.rejects(s.controller.setTunable(s.ws.id, { key: 'planning.cooldownSeconds', value: -1 }), /must stay within 0–86400/);
  const row = (await s.audit.list(orgId, { action: 'tunable_set' }))[0];
  const p = JSON.parse(row.payload);
  assert.equal(p.decision, 'set intent.paceTolerance 0.15 → 0.3'); assert.equal(p.rationale, 'research moves slowly'); assert.equal(p.alternatives, 'keep 0.15'); assert.deepEqual(p.bound, { min: 0.02, max: 0.5, default: 0.15 });
  const listed = await s.controller.tunables(s.ws.id);
  assert.equal(listed.find((t) => t.key === 'intent.paceTolerance')!.value, 0.3);
  assert.equal(listed.find((t) => t.key === 'intent.confidenceDrops')!.stored, null);
  // the chief in supervised mode: an approval card; approving applies it
  const chiefSession = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.chief.id, name: 'chief chat' });
  await assert.rejects(s.runtime.execute(chiefSession, 'org_tune', { key: 'intent.confidenceDrops', value: 9, why: 'x' }), /refused: intent\.confidenceDrops must stay within 1–5/);
  await assert.rejects(s.runtime.execute(chiefSession, 'org_tune', { key: 'intent.confidenceDrops', value: 3 }), /why is required/);
  const out = await s.runtime.execute(chiefSession, 'org_tune', { key: 'intent.confidenceDrops', value: 3, why: 'owners are honest here; two dips are noise' });
  assert.match(out, /Tuning proposed \(approval [0-9a-f]{8}\): intent\.confidenceDrops 2 → 3/);
  const card = (await s.approvals.pending(orgId)).find((a) => a.kind === 'tune')!;
  assert.equal(tunable(await s.org.get(orgId), 'intent.confidenceDrops'), 2, 'nothing changes until approved');
  await s.approvals.decide(orgId, card.id, 'approve', '', 'user');
  assert.equal(tunable(await s.org.get(orgId), 'intent.confidenceDrops'), 3);
  // autonomous: at once, audited as a decision, announced
  await s.mode.setMode(s.ws.id, { mode: 'autonomous' });
  assert.match(await s.runtime.execute(chiefSession, 'org_tune', { key: 'planning.cooldownSeconds', value: 600, why: 'launch week: replan often' }), /planning\.cooldownSeconds set to 600 \(was 1800; bound 0–86400\)\. Audited as a decision/);
  assert.equal(tunable(await s.org.get(orgId), 'planning.cooldownSeconds'), 600);
  const company = await s.groupchat.bySlug(s.ws.id, COMPANY_SLUG);
  assert.match((await s.groupchat.messages(company.id)).messages.at(-1)!.text, /^Tuned planning\.cooldownSeconds: 1800 → 600 — launch week/);
  const writerSession = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.writer.id, name: 'writer chat' });
  await assert.rejects(s.runtime.execute(writerSession, 'org_tune', { key: 'planning.cooldownSeconds', value: 1, why: 'x' }), /chief-of-staff tool/);
  // the stored JSON is one column other items share
  const raw = (await s.db.select().from(organizations).where(eq(organizations.id, orgId)))[0].tunables;
  assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ['intent.confidenceDrops', 'intent.paceTolerance', 'planning.cooldownSeconds']);
});

// ---- 10. the API surface ----

test('the API: POST goals accepts kind and key-result fields; GET intent returns the annotated tree per unit; the vision, profile and tunables are the CEO\'s to write', async () => {
  const s = await setup();
  const orgId = await enable(s);
  const { unit, alpha } = await writerUnit(s, orgId);
  const vision = await s.controller.setVision(s.ws.id, { title: 'V' });
  const objective = await s.controller.addGoal(s.ws.id, { title: 'O', parentGoalId: vision.vision.id, unitId: unit.id });
  assert.equal(objective.kind, 'objective');
  const kr = await s.controller.addGoal(s.ws.id, { title: 'K', kind: 'key_result', parentGoalId: objective.id, metric: 'n', targetValue: 10, startValue: 0, dueAt: iso(10), ownerAgentId: alpha.id, checkInCadenceDays: 2 });
  assert.equal(kr.kind, 'key_result'); assert.equal(kr.targetValue, 10); assert.equal(kr.checkInCadenceDays, 2); assert.equal(kr.unitId, unit.id);
  await s.controller.checkIn(s.ws.id, kr.id, { currentValue: 5, confidence: 0.9 });
  const tree = await s.controller.intentTree(s.ws.id);
  assert.equal(tree[0].kind, 'vision'); assert.equal(tree[0].children[0].children[0].measured, 0.5);
  const mine = await s.controller.intentTree(s.ws.id, unit.id);
  assert.equal(mine[0].title, 'O', 'the unit tree starts at the first goal inside the unit');
  assert.equal(mine[0].children[0].pace, 'onPace');
  assert.equal(mine[0].children[0].ownerName, 'Alpha');
  await assert.rejects(s.controller.addGoal(s.ws.id, { title: 'bad', kind: 'nope' as never }), /goal kind must be one of/);
  assert.equal((await s.controller.strategy(s.ws.id)).memo, '');
  assert.deepEqual(s.runtime.pendingPlanningUnits().sort(), [unit.id, (await s.units.rootUnit(orgId)).id].sort(), 'the vision and the handed objective each queued planning');
});
