/** Assurance (docs/company-vision.md §5, execution-plan item 20): model-free
 *  signals that fire once a day, route to owner / lead / chief / CEO and
 *  resolve when the condition clears; per-org tunable thresholds inside
 *  bounds; company SLOs computed from runs, tasks and approvals; the pulse
 *  score and its formula; an SLO breach as a signal; the auditor's sampled,
 *  budget-capped, different-family run whose findings become signals and
 *  whose report reaches #company; the brief's Signals / Pulse / Audit
 *  sections; the tools and the API. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigService } from '@nestjs/config';
import { eq, sql } from 'drizzle-orm';
import { agentTypes, orgApprovals, orgRuns, orgSignals, orgTasks } from '../server/src/database/schema';
import { testDb, memStorage, ctxStub, skillsStub, mcpStub, ScriptedProvider } from './helpers';
import type { AiStreamEvent } from '../server/src/ai/ai-provider.interface';
import { ChatsRepository } from '../server/src/chats/chats.repository';
import { TurnLoopService } from '../server/src/chats/turn-loop.service';
import { ChatLocks } from '../server/src/chats/chat-locks';
import { ToolsService } from '../server/src/chats/tools.service';
import { TriggerBus, type OrgBoardEvent } from '../server/src/chats/trigger-bus';
import { AgentsService } from '../server/src/agents/agents.service';
import { WorkspacesService } from '../server/src/workspaces/workspaces.service';
import { OrgAuditService } from '../server/src/org/org-audit.service';
import { OrgService } from '../server/src/org/org.service';
import { OrgTasksService } from '../server/src/org/org-tasks.service';
import { OrgApprovalsService } from '../server/src/org/org-approvals.service';
import { OrgBriefService } from '../server/src/org/org-brief.service';
import { OrgRuntimeService } from '../server/src/org/org-runtime.service';
import { OrgModeService } from '../server/src/org/org-mode.service';
import { OrgAnnouncer } from '../server/src/org/org-announcer';
import { OrgUnitsService } from '../server/src/org/org-units.service';
import { OrgSignalsService, thresholdsOf } from '../server/src/org/org-signals.service';
import { OrgSloService, pulseScore, breachesOf, classOf, median, DEFAULT_SLO_TARGETS, DEFAULT_PULSE_WEIGHTS } from '../server/src/org/org-slo.service';
import { OrgAuditorService, driftsFromCharter } from '../server/src/org/org-auditor.service';
import { ASSURANCE_TUNABLES, assuranceTunable, mergeTunables } from '../server/src/org/org-assurance-tunables';
import { OrgController } from '../server/src/org/org.controller';
import { WorkspaceOrgController } from '../server/src/org/workspace-org.controller';
import { setAddressLookup } from '../server/src/common/url-guard';

setAddressLookup(async () => [{ address: '93.184.216.34', family: 4 }]);

const HOUR = 3_600_000;
const ago = (hours: number) => new Date(Date.now() - hours * HOUR).toISOString();

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
  const announced: string[] = [];
  const announcer = new OrgAnnouncer({ announce: async (_ws, text) => { announced.push(text); } });
  const audit = new OrgAuditService(db);
  const org = new OrgService(db, agents, audit, bus);
  const units = new OrgUnitsService(db, org, agents, audit, announcer);
  const tasks = new OrgTasksService(db, org, audit, bus, units);
  const approvals = new OrgApprovalsService(db, org, tasks, agents, audit, undefined, bus);
  const signals = new OrgSignalsService(db, org, tasks, audit, agents, workspaces, bus, units);
  const slo = new OrgSloService(db, org, tasks, approvals, audit, workspaces, signals);
  const brief = new OrgBriefService(db, org, tasks, approvals, audit, agents, workspaces, signals, slo);
  const runtime = new OrgRuntimeService(db, org, tasks, approvals, audit, brief, turns, repo, agents, workspaces, config, announcer, bus, undefined, undefined, undefined, undefined, undefined, units, signals, slo);
  runtime.debounceMs = 15;
  const auditor = new OrgAuditorService(db, org, tasks, audit, agents, workspaces, repo, turns, runtime, announcer, signals, config);
  const mode = new OrgModeService(org, workspaces, agents, runtime, approvals, audit, announcer);
  const orgs = new OrgController(org, tasks, approvals, audit, brief, runtime, config, units, signals, slo, auditor);
  const controller = new WorkspaceOrgController(mode, orgs, config);
  const boardEvents: OrgBoardEvent[] = [];
  bus.onOrgBoard((ev) => boardEvents.push(ev));
  const ws = (await workspaces.list())[0];
  const chief = await agents.create({ name: 'Chief', charter: 'You run the company.', provider: 'anthropic', model: 'claude-sonnet-4-5' });
  const writer = await agents.create({ name: 'Writer', charter: 'You write newsletter issues and drafts.', provider: 'anthropic', model: 'claude-sonnet-4-5' });
  const editor = await agents.create({ name: 'Editor', charter: 'You edit drafts and check facts.', provider: 'anthropic', model: 'claude-sonnet-4-5' });
  const st = await mode.setMode(ws.id, { mode: 'autonomous', chiefOfStaffAgentId: chief.id, monthlyUsd: 50, agentCap: 10 });
  const orgId = st.orgId!;
  return { db, agents, workspaces, repo, turns, provider, bus, audit, org, units, tasks, approvals, signals, slo, brief, runtime, auditor, mode, orgs, controller, ws, chief, writer, editor, orgId, announced, boardEvents };
}
type S = Awaited<ReturnType<typeof setup>>;

const inbox = async (s: S, agentId: string, kind?: string) => (await s.agents.listEvents(agentId, 200)).filter((e) => !kind || e.kind === kind);
const openSignals = async (s: S, kind?: string) => (await s.signals.list(s.orgId, { kind })).filter((x) => x.status !== 'resolved');

// ---- 1. stale task: once per day, owner inbox, auto-resolve ----

test('a stale task fires one signal per day addressed to its owner (inbox event) and resolves itself when the task runs again', async () => {
  const s = await setup();
  const t = await s.tasks.create(s.orgId, { title: 'Draft issue 12', brief: { outcome: 'A draft', done_when: 'Saved' }, assigneeAgentId: s.writer.id });
  await s.db.update(orgTasks).set({ status: 'in_progress', lastRunAt: ago(30), updatedAt: ago(30) }).where(eq(orgTasks.id, t.id));
  const first = await s.signals.sweep(s.orgId);
  assert.equal(first.opened >= 1, true);
  const stale = await openSignals(s, 'stale_task');
  assert.equal(stale.length, 1);
  assert.equal(stale[0].addresseeKind, 'owner');
  assert.equal(stale[0].addresseeId, s.writer.id);
  assert.equal(stale[0].refId, t.id);
  assert.equal(stale[0].severity, 'warn');
  // a second sweep the same day neither duplicates nor re-routes
  const second = await s.signals.sweep(s.orgId);
  assert.equal(second.opened, 0);
  assert.equal((await openSignals(s, 'stale_task')).length, 1);
  const events = await inbox(s, s.writer.id, 'org_signal');
  assert.equal(events.length, 1, 'the owner is told once');
  assert.match(events[0].title, /Stale/);
  assert.match(events[0].body, /org_ack_signal/);
  // the chief was not woken for an owner-addressed signal
  assert.equal(s.boardEvents.filter((e) => e.kind === 'signal').length, 0);
  // the condition clears → resolved by the sweep, audited
  await s.db.update(orgTasks).set({ lastRunAt: ago(1) }).where(eq(orgTasks.id, t.id));
  const third = await s.signals.sweep(s.orgId);
  assert.equal(third.resolved, 1);
  const row = (await s.signals.list(s.orgId, { kind: 'stale_task' }))[0];
  assert.equal(row.status, 'resolved');
  assert.ok(row.resolvedAt);
  const actions = (await s.audit.list(s.orgId, { limit: 100 })).map((r) => r.action);
  assert.ok(actions.includes('signal_open') && actions.includes('signal_resolve'));
  assert.equal((await s.audit.verify(s.orgId)).ok, true);
});

// ---- 2. chief-addressed signals: board event + inbox; CEO-addressed: pushed + brief ----

test('blocked-unowned and unowned-goal signals reach the chief as an OrgBoard event (the review reason) and an inbox line; charter drift and a critical burn rate reach the CEO', async () => {
  const s = await setup();
  const t = await s.tasks.create(s.orgId, { title: 'Nobody owns me', brief: { outcome: 'x', done_when: 'y' } });
  await s.db.update(orgTasks).set({ status: 'blocked', blockers: JSON.stringify(['waiting for a key']) }).where(eq(orgTasks.id, t.id));
  const g = await s.org.addGoal(s.orgId, { title: 'Grow the list' });
  // unowned goal: units are on, so the goal needs an owner (it has a unit by default)
  assert.equal(g.ownerAgentId, null);
  // charter drift: the writer's charter changes outside the org path
  await s.agents.update(s.writer.id, { charter: 'You now do taxes.' });
  // burn rate: $40 spent on day N of the month against a $50 envelope projects far past 120%
  await s.db.insert(orgRuns).values({ id: 'r-burn', accountId: 'single', orgId: s.orgId, taskId: t.id, agentId: s.writer.id, sessionId: null, wakeReason: 'manual', status: 'done', outcome: 'done', tokensIn: 0, tokensOut: 0, usd: 40, reservedUsd: 0, startedAt: new Date().toISOString(), endedAt: new Date().toISOString() });
  await s.signals.sweep(s.orgId);
  const kinds = new Set((await openSignals(s)).map((x) => x.kind));
  assert.ok(kinds.has('blocked_unowned'), 'blocked_unowned');
  assert.ok(kinds.has('goal_unowned'), 'goal_unowned');
  assert.ok(kinds.has('charter_drift'), 'charter_drift');
  assert.ok(kinds.has('burn_rate'), 'burn_rate');
  const blocked = (await openSignals(s, 'blocked_unowned'))[0];
  assert.equal(blocked.addresseeKind, 'chief');
  assert.equal(blocked.addresseeId, s.chief.id);
  const signalEvents = s.boardEvents.filter((e) => e.kind === 'signal');
  assert.ok(signalEvents.some((e) => e.refId === t.id && /blocked_unowned/.test(e.detail)), 'the chief review is queued with the signal as reason');
  assert.deepEqual(s.runtime.pendingReviewOrgs(), [s.orgId]);
  const chiefInbox = await inbox(s, s.chief.id, 'org_signal');
  assert.ok(chiefInbox.some((e) => /Blocked and unowned/.test(e.title)));
  const drift = (await openSignals(s, 'charter_drift'))[0];
  assert.equal(drift.addresseeKind, 'ceo');
  const burn = (await openSignals(s, 'burn_rate'))[0];
  assert.equal(burn.severity, 'critical');
  assert.equal(burn.addresseeKind, 'ceo');
  // CEO-addressed lines are pushed to the paired channels (channel flag) and appear in the brief
  const pushed = chiefInbox.filter((e) => e.channel === 1);
  assert.ok(pushed.some((e) => /Burn rate/.test(e.title)) && pushed.some((e) => /Charter of Writer/.test(e.title)));
  const b = await s.brief.compose(s.orgId, { deliver: false });
  assert.match(b.text, /## Signals \(\d+ open: \d+ critical/);
  assert.match(b.text, /\[critical\] Burn rate .* → you/);
  // a critical signal lowers the pulse
  const p = await s.slo.pulse(s.orgId);
  assert.ok(p.today.openCriticalSignals >= 1);
  assert.ok(p.score < 100);
});

// ---- 3. lead-addressed: overloaded member → the unit lead ----

test('an overloaded member is signalled to its unit lead; unit_no_goal goes to the lead; thin_unit and duplicate_title to the chief; the auditor and chief are never "idle"', async () => {
  const s = await setup();
  // Writer leads a unit of one (Editor) → thin_unit; Editor gets 6 open tasks → overloaded, addressed to Writer
  await s.org.updateMember(s.orgId, s.editor.id, { reportsToAgentId: s.writer.id });
  for (let i = 0; i < 6; i++) await s.tasks.create(s.orgId, { title: `Edit ${i}`, brief: { outcome: 'x', done_when: 'y' }, assigneeAgentId: s.editor.id });
  await s.org.updateMember(s.orgId, s.writer.id, { title: 'Specialist' });
  await s.org.updateMember(s.orgId, s.editor.id, { title: 'specialist' });
  await s.signals.sweep(s.orgId);
  const over = (await openSignals(s, 'overloaded_member'))[0];
  assert.ok(over, 'overloaded_member fired');
  assert.equal(over.refId, s.editor.id);
  assert.equal(over.addresseeKind, 'lead');
  assert.equal(over.addresseeId, s.writer.id);
  const writerUnit = (await s.units.isLead(s.orgId, s.writer.id))!;
  assert.equal(over.unitId, writerUnit.id, 'the signal sits on the lead\'s unit');
  assert.ok((await inbox(s, s.writer.id, 'org_signal')).some((e) => /6 open tasks/.test(e.title)));
  const noGoal = (await openSignals(s, 'unit_no_goal')).find((x) => x.refId === writerUnit.id)!;
  assert.equal(noGoal.addresseeId, s.writer.id);
  const thin = (await openSignals(s, 'thin_unit'))[0];
  assert.equal(thin.refId, s.writer.id);
  assert.equal(thin.addresseeKind, 'chief');
  const dup = (await openSignals(s, 'duplicate_title'))[0];
  assert.match(dup.title, /share the title "specialist"/);
  // idle: nobody has run in 7 days but everyone joined just now — joinedAt guards the first week
  assert.equal((await openSignals(s, 'idle_member')).length, 0);
  // the lead sees its unit's signals through the tool; a plain member only its own; the chief all
  const chiefSession = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.chief.id, name: 'c' });
  const writerSession = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.writer.id, name: 'w' });
  const editorSession = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.editor.id, name: 'e' });
  const forWriter = await s.runtime.execute(writerSession, 'org_signals', {});
  assert.match(forWriter, /overloaded_member/);
  assert.doesNotMatch(forWriter, /duplicate_title/, 'a chief-addressed signal outside the unit is not the lead\'s');
  assert.equal(await s.runtime.execute(editorSession, 'org_signals', {}), 'No open signals for you.');
  assert.match(await s.runtime.execute(chiefSession, 'org_signals', { severity: 'info' }), /thin_unit/);
  // ack: the addressee may, a stranger may not, the chief always
  await assert.rejects(s.runtime.execute(editorSession, 'org_ack_signal', { id: over.id.slice(0, 8) }), /addressed to you/);
  assert.match(await s.runtime.execute(writerSession, 'org_ack_signal', { id: over.id.slice(0, 8), note: 'sequencing them' }), /acknowledged/);
  assert.equal((await s.signals.get(s.orgId, over.id)).status, 'acked');
  assert.match(await s.runtime.execute(chiefSession, 'org_ack_signal', { id: thin.id }), /acknowledged/);
  // acked stays until the condition clears; a stale-free sweep leaves it; clearing resolves it
  await s.signals.sweep(s.orgId);
  assert.equal((await s.signals.get(s.orgId, over.id)).status, 'acked');
  for (const t of (await s.tasks.list(s.orgId)).filter((x) => x.assigneeAgentId === s.editor.id).slice(0, 3)) await s.tasks.update(s.orgId, t.id, { status: 'cancelled' });
  await s.signals.sweep(s.orgId);
  assert.equal((await s.signals.get(s.orgId, over.id)).status, 'resolved');
});

// ---- 4. tunables: thresholds change behaviour, bounds hold ----

test('thresholds are per-org tunables with defaults and bounds (§1b): raising signals.staleTaskHours silences the stale signal, an out-of-bounds value is refused, bad JSON falls back to the default', async () => {
  const s = await setup();
  const t = await s.tasks.create(s.orgId, { title: 'Slow research', brief: { outcome: 'x', done_when: 'y' }, assigneeAgentId: s.writer.id });
  await s.db.update(orgTasks).set({ status: 'in_progress', lastRunAt: ago(30), updatedAt: ago(30) }).where(eq(orgTasks.id, t.id));
  const org = await s.org.get(s.orgId);
  assert.equal(thresholdsOf(org).staleTaskHours, 24, 'default');
  assert.equal(assuranceTunable({ tunables: 'not json' }, 'signals.staleTaskHours'), 24);
  assert.equal(assuranceTunable({ tunables: JSON.stringify({ 'signals.staleTaskHours': 99_999 }) }, 'signals.staleTaskHours'), ASSURANCE_TUNABLES['signals.staleTaskHours'].max, 'clamped to the bound');
  // a research company tolerates two days without a run
  await s.slo.setTargets(s.orgId, { 'signals.staleTaskHours': 72 }, 'user');
  assert.equal(thresholdsOf(await s.org.get(s.orgId)).staleTaskHours, 72);
  await s.signals.sweep(s.orgId);
  assert.equal((await openSignals(s, 'stale_task')).length, 0, 'no stale signal at 30h when the threshold is 72h');
  await s.slo.setTargets(s.orgId, { 'signals.staleTaskHours': 12 });
  await s.signals.sweep(s.orgId);
  assert.equal((await openSignals(s, 'stale_task')).length, 1, 'tightening fires it');
  // bounds are the safety floor
  await assert.rejects(s.slo.setTargets(s.orgId, { 'signals.staleTaskHours': 0 }), /between 1 and 720/);
  await assert.rejects(s.slo.setTargets(s.orgId, { cycleTimeHours: -5 }), /between/);
  assert.throws(() => mergeTunables({}, { 'pulse.criticalPenalty': 'five' }), /must be a number/);
  // null removes an override; unknown keys (another module's) pass through
  const merged = mergeTunables({ 'signals.staleTaskHours': 12, 'rituals.standupHour': 9 }, { 'signals.staleTaskHours': null });
  assert.deepEqual(merged, { 'rituals.standupHour': 9 });
  // the audit log carries the change
  assert.ok((await s.audit.list(s.orgId, { action: 'slo_targets' })).length >= 2);
});

// ---- 5. SLO computation on seeded data ----

test('SLOs are computed from seeded tasks, runs and approvals: median cycle time (overall and per class), first-review acceptance, cost per accepted task, decision latency, goals owned, spend vs envelope', async () => {
  const s = await setup();
  const seed = async (title: string, hours: number, rounds: number, constraints = '') => {
    const t = await s.tasks.create(s.orgId, { title, brief: { outcome: 'x', done_when: 'y', constraints }, assigneeAgentId: s.writer.id });
    await s.db.update(orgTasks).set({ status: 'done', createdAt: ago(hours + 1), updatedAt: ago(1), reviewRounds: rounds }).where(eq(orgTasks.id, t.id));
    return t;
  };
  const a = await seed('Research competitors', 10, 0);
  await seed('Write issue 12', 30, 1);
  await seed('Triage inbox', 50, 0, 'class: triage');
  await seed('Old one', 500, 0); // accepted long ago: outside the 7-day window? no — updatedAt is 1h ago; createdAt 500h ago → cycle 500h
  // an in-progress task does not count
  await s.tasks.create(s.orgId, { title: 'Still open', brief: { outcome: 'x', done_when: 'y' }, assigneeAgentId: s.writer.id });
  for (const [i, usd] of [1, 2, 3].entries()) await s.db.insert(orgRuns).values({ id: `r-${i}`, accountId: 'single', orgId: s.orgId, taskId: a.id, agentId: s.writer.id, sessionId: null, wakeReason: 'manual', status: 'done', outcome: 'done', tokensIn: 0, tokensOut: 0, usd, reservedUsd: 0, startedAt: ago(2), endedAt: ago(2) });
  // two decisions: waited 6h and 30h
  for (const [i, wait] of [6, 30].entries()) await s.db.insert(orgApprovals).values({ id: `ap-${i}`, accountId: 'single', orgId: s.orgId, kind: 'hire', payload: '{}', requestedBy: 'chief', recommendation: '', status: 'approved', decidedAt: ago(1), decidedBy: '', decisionNote: '', expiresAt: null, createdAt: ago(1 + wait) });
  const root = await s.units.rootUnit(s.orgId);
  await s.org.addGoal(s.orgId, { title: 'Owned', ownerAgentId: s.writer.id, unitId: root.id });
  await s.org.addGoal(s.orgId, { title: 'Owner but no unit', ownerAgentId: s.writer.id });
  await s.org.addGoal(s.orgId, { title: 'Unowned', unitId: root.id });
  await s.org.addGoal(s.orgId, { title: 'Nothing' });
  const m = await s.slo.compute(s.orgId);
  assert.equal(m.acceptedTasks, 4);
  assert.equal(m.cycleTimeHours, median([10, 30, 50, 500]), 'median of the four accepted cycles (40h)');
  assert.equal(m.cycleTimeHours, 40);
  assert.equal(m.cycleTimeByClass.triage, 50);
  assert.equal(m.cycleTimeByClass.research, 10);
  assert.equal(m.cycleTimeByClass.synthesis, 30);
  assert.equal(m.firstReviewAcceptancePct, 75, '3 of 4 passed first review');
  assert.equal(m.costPerAcceptedTaskUsd, 1.5, '$6 over 4 accepted');
  assert.equal(m.decisionLatencyHours, 18, 'median of 6h and 30h');
  assert.equal(m.decisions, 2);
  assert.equal(m.goalsOwnedPct, 25, 'one of four goals has both an owner and a unit');
  assert.equal(m.goalsAtRiskPct, 0, 'four active goals, none flagged by the intent sweep (item 18)');
  assert.equal(m.spendVsEnvelopePct, 12, '$6 of $50');
  assert.equal(classOf({ title: 'Check the sources', brief: '{}' }), 'review');
  assert.equal(classOf({ title: 'Anything', brief: JSON.stringify({ constraints: 'type: outreach' }) }), 'outreach');
  // the daily sample is stored once per day and upserted
  await s.slo.sample(s.orgId);
  await s.slo.sample(s.orgId);
  assert.equal((await s.slo.samples(s.orgId)).length, 1);
  const p = await s.slo.pulse(s.orgId);
  assert.equal(p.series.length, 30);
  assert.equal(p.series.at(-1)!.day, m.dayKey);
  assert.equal(p.series[0].score, null, 'no sample 29 days ago');
});

// ---- 6. pulse score: formula, bounds, tunable weights ----

test('the pulse score follows the documented formula, stays in 0..100, treats missing data as on target, and its weights are tunable', () => {
  const t = DEFAULT_SLO_TARGETS;
  const w = DEFAULT_PULSE_WEIGHTS;
  const perfect = { cycleTimeHours: 48, firstReviewAcceptancePct: 70, decisionLatencyHours: 24, spendVsEnvelopePct: 100, goalsOwnedPct: 100, openCriticalSignals: 0 };
  assert.equal(pulseScore(perfect, t, w), 100);
  assert.equal(pulseScore({ cycleTimeHours: null, firstReviewAcceptancePct: null, decisionLatencyHours: null, spendVsEnvelopePct: null, goalsOwnedPct: null, openCriticalSignals: 0 }, t, w), 100, 'no data is not a failure');
  // cycle at 2× target is worth 0 of its 25
  assert.equal(pulseScore({ ...perfect, cycleTimeHours: 96 }, t, w), 75);
  assert.equal(pulseScore({ ...perfect, cycleTimeHours: 72 }, t, w), 88, 'halfway: 25·0.5 = 12.5 lost, rounded');
  assert.equal(pulseScore({ ...perfect, firstReviewAcceptancePct: 35 }, t, w), 88);
  assert.equal(pulseScore({ ...perfect, decisionLatencyHours: 48 }, t, w), 75);
  // health: spend 120% costs half of the 25, no owned goals the other half
  assert.equal(pulseScore({ ...perfect, spendVsEnvelopePct: 120 }, t, w), 88);
  assert.equal(pulseScore({ ...perfect, spendVsEnvelopePct: 120, goalsOwnedPct: 0 }, t, w), 75);
  // criticals: 5 each, floored at 0
  assert.equal(pulseScore({ ...perfect, openCriticalSignals: 3 }, t, w), 85);
  assert.equal(pulseScore({ ...perfect, cycleTimeHours: 1_000, firstReviewAcceptancePct: 0, decisionLatencyHours: 1_000, spendVsEnvelopePct: 500, goalsOwnedPct: 0, openCriticalSignals: 50 }, t, w), 0);
  // what this CEO cares about: all weight on cycle time → acceptance stops mattering; weights normalise to 100
  assert.equal(pulseScore({ ...perfect, firstReviewAcceptancePct: 0 }, t, { ...w, acceptance: 0, cycle: 50 }), 100);
  assert.equal(pulseScore({ ...perfect, cycleTimeHours: 96 }, t, { cycle: 1, acceptance: 1, latency: 1, health: 1, criticalPenalty: 5 }), 75);
  assert.equal(pulseScore({ ...perfect, openCriticalSignals: 1 }, t, { ...w, criticalPenalty: 0 }), 100);
  // breaches
  assert.deepEqual(breachesOf({ ...perfect, dayKey: '', windowDays: 7, cycleTimeByClass: {}, costPerAcceptedTaskUsd: null, goalsAtRiskPct: null, acceptedTasks: 0, runs: 0, decisions: 0 }, t), []);
  assert.equal(breachesOf({ ...perfect, cycleTimeHours: 49, firstReviewAcceptancePct: 69, decisionLatencyHours: 25, dayKey: '', windowDays: 7, cycleTimeByClass: {}, costPerAcceptedTaskUsd: null, goalsAtRiskPct: null, acceptedTasks: 0, runs: 0, decisions: 0 }, t).length, 3);
});

// ---- 7. breach → signal, targets are org settings, API ----

test('an SLO breach opens an slo_breach signal for the chief once, resolves when the target is met again, and targets are read and set through the API', async () => {
  const s = await setup();
  const t = await s.tasks.create(s.orgId, { title: 'Slow one', brief: { outcome: 'x', done_when: 'y' }, assigneeAgentId: s.writer.id });
  await s.db.update(orgTasks).set({ status: 'done', createdAt: ago(100), updatedAt: ago(1), reviewRounds: 2 }).where(eq(orgTasks.id, t.id));
  const r = await s.slo.sample(s.orgId);
  assert.deepEqual(r.breaches.map((b) => b.metric).sort(), ['cycleTimeHours', 'firstReviewAcceptancePct']);
  await s.slo.sample(s.orgId);
  const breaches = await openSignals(s, 'slo_breach');
  assert.equal(breaches.length, 2, 'one signal per metric, not per sample');
  assert.ok(breaches.every((b) => b.addresseeKind === 'chief' && b.severity === 'warn'));
  assert.ok(s.boardEvents.some((e) => e.kind === 'signal' && /slo_breach/.test(e.detail)));
  // the API: GET returns targets, weights, tunables and bounds; PATCH relaxes the cycle target for this research-paced company
  const before = await s.controller.slo(s.ws.id);
  assert.equal(before.targets.cycleTimeHours, 48);
  assert.equal(before.bounds['slo.cycleTimeHours'].max, 2_160);
  const after = await s.controller.setSlo(s.ws.id, { cycleTimeHours: 200, tunables: { 'pulse.weightHealth': 10 } });
  assert.equal(after.cycleTimeHours, 200);
  assert.equal(after.tunables['pulse.weightHealth'], 10);
  assert.equal((await s.slo.weights(s.orgId)).health, 10);
  const again = await s.slo.sample(s.orgId);
  assert.deepEqual(again.breaches.map((b) => b.metric), ['firstReviewAcceptancePct']);
  const cycleSignal = (await s.signals.list(s.orgId, { kind: 'slo_breach' })).find((x) => x.refId === 'cycleTimeHours')!;
  assert.equal(cycleSignal.status, 'resolved', 'the healed breach resolved its signal');
  assert.equal((await openSignals(s, 'slo_breach')).length, 1);
  const pulse = await s.controller.pulse(s.ws.id);
  assert.ok(pulse.score >= 0 && pulse.score <= 100);
  assert.equal(pulse.worst[0].metric, 'firstReviewAcceptancePct');
  // signals API filters
  const list = await s.controller.signals(s.ws.id, 'open', 'warn');
  assert.ok(list.length >= 1 && list.every((x) => x.status === 'open' && x.severity === 'warn'));
  const acked = await s.controller.ackSignal(s.ws.id, list[0].id, { note: 'known' });
  assert.equal(acked.status, 'acked');
  assert.equal((await s.controller.resolveSignal(s.ws.id, list[0].id)).status, 'resolved');
});

// ---- 8. the auditor: different family, sampling, findings → signals, #company, record ----

test('the auditor samples accepted tasks and scope/spend rows, runs read-only on a different model family, records findings as signals (critical → CEO), posts the report to #company and the record to org_audits', async () => {
  const findingRound: AiStreamEvent[] = [
    { type: 'tool_call', id: 'a1', name: 'org_audit_query', input: { action: 'scope_widen' } },
    { type: 'tool_call', id: 'a2', name: 'org_create_task', input: { title: 'sneaky', outcome: 'x', done_when: 'y' } },
    { type: 'tool_call', id: 'a3', name: 'org_audit_finding', input: { severity: 'critical', kind: 'done_when_unmet', refType: 'task', refId: 'TASKID', title: 'Issue 12 accepted without the saved file', detail: 'The final comment says "almost there".' } },
    { type: 'tool_call', id: 'a4', name: 'org_audit_finding', input: { severity: 'warn', kind: 'unjustified_scope', refType: 'agent', refId: 'WRITER', title: 'Writer widened to web_search with no task named', detail: 'Reason was generic.' } },
    { type: 'tool_call', id: 'a5', name: 'org_audit_close', input: { summary: 'One accepted task lacks evidence; one widening lacks a reason.' } },
    { type: 'usage', inputTokens: 1_000, outputTokens: 200 },
    { type: 'done' },
  ];
  const s = await setup([findingRound, [{ type: 'answer', text: 'Audit closed.' }, { type: 'done' }]]);
  // an auditor on another family than the (anthropic) workers
  const auditorAgent = await s.agents.create({ name: 'Auditor', charter: 'You audit.', provider: 'openai', model: 'gpt-5-mini' });
  await s.org.addMember(s.orgId, { agentId: auditorAgent.id, title: 'Auditor', reportsToAgentId: s.chief.id, scopes: ['tool:fs_read'] });
  await s.org.update(s.orgId, { auditorAgentId: auditorAgent.id, auditCadenceDays: 3, auditUsdCap: 1.5 });
  // material: an accepted task with a final comment, a scope widening, spend
  const t = await s.tasks.create(s.orgId, { title: 'Write issue 12', brief: { outcome: 'A draft', done_when: 'Saved as shared/issue-12.md' }, assigneeAgentId: s.writer.id });
  await s.tasks.comment(s.orgId, t.id, { text: 'Almost there, saving now.', fromAgentId: s.writer.id, wake: false });
  await s.db.update(orgTasks).set({ status: 'done' }).where(eq(orgTasks.id, t.id));
  await s.org.setScopes(s.orgId, s.writer.id, ['tool:fs_read', 'tool:fs_write', 'tool:web_search'], { actor: 'chief', force: true });
  findingRound[2] = { ...findingRound[2], input: { ...(findingRound[2] as { input: Record<string, unknown> }).input, refId: t.id } } as AiStreamEvent;
  findingRound[3] = { ...findingRound[3], input: { ...(findingRound[3] as { input: Record<string, unknown> }).input, refId: s.writer.id } } as AiStreamEvent;
  assert.equal(await s.auditor.due(await s.org.get(s.orgId)), true, 'never audited → due');
  const pick = await s.auditor.pickModel(await s.org.get(s.orgId), auditorAgent.id);
  assert.equal(pick.single, false);
  assert.equal(pick.majority, 'anthropic:claude-sonnet');
  assert.equal(pick.auditor, 'openai:gpt-5-mini');

  const result = await s.auditor.runAudit(s.orgId, 'manual');
  assert.equal(result, 'ran');
  // the record
  const [run] = await s.auditor.list(s.orgId);
  assert.equal(run.status, 'done');
  assert.equal(run.trigger, 'manual');
  assert.equal(run.singleModel, 0);
  assert.equal(run.auditorAgentId, auditorAgent.id);
  const sampled = JSON.parse(run.sampled) as { tasks: number; auditRows: number };
  assert.equal(sampled.tasks, 1);
  assert.ok(sampled.auditRows >= 1, 'the scope widening was sampled');
  const findings = JSON.parse(run.findings) as Array<{ severity: string; refId: string }>;
  assert.equal(findings.length, 2);
  assert.equal(run.summary, 'One accepted task lacks evidence; one widening lacks a reason.');
  assert.ok(run.usd > 0, 'usage was priced and recorded');
  // the session, its context and the read-only guard
  const sess = (await s.repo.listSessions(s.ws.id)).find((x) => x.name === 'Org · ' + s.ws.name + ' · Audit')!;
  assert.ok(sess, 'the audit session exists');
  const req = s.provider.requests[0];
  assert.match(req.system ?? '', /Organisation audit/);
  assert.match(req.system ?? '', /Operating profile/);
  assert.match(req.system ?? '', /Write issue 12/);
  assert.match(req.system ?? '', /Almost there/);
  assert.match(req.system ?? '', /scope_widen/);
  assert.deepEqual((req.tools ?? []).map((x) => x.name).sort(), ['fs_list', 'fs_read', 'fs_search', 'org_audit_close', 'org_audit_finding', 'org_audit_query', 'org_intent', 'org_pulse', 'org_read_board', 'org_read_goal', 'org_signals'], 'read-only: its own set plus the shared files and the intent tree');
  const turns = await s.repo.listTurns(sess.id);
  const records = JSON.parse(turns[0].toolCalls) as Array<{ tool: string; isError: boolean; result: string }>;
  const sneaky = records.find((r) => r.tool === 'org_create_task')!;
  assert.equal(sneaky.isError, true);
  assert.match(sneaky.result, /read-only/);
  assert.ok(!records.some((r) => r.tool === 'fs_write'), 'the model was never offered fs_write');
  assert.equal((await s.tasks.list(s.orgId)).some((x) => x.title === 'sneaky'), false, 'nothing was created');
  // findings → signals: critical to the CEO, warn to the chief
  const found = await openSignals(s, 'audit_finding');
  assert.equal(found.length, 2);
  const critical = found.find((x) => x.severity === 'critical')!;
  assert.equal(critical.addresseeKind, 'ceo');
  assert.match(critical.title, /Audit: Issue 12/);
  assert.equal(found.find((x) => x.severity === 'warn')!.addresseeKind, 'chief');
  // #company, inboxes, audit chain
  assert.ok(s.announced.some((a) => /^Audit of .* by Auditor: sampled 1 accepted task/.test(a) && /2 finding\(s\) \(1 critical, 1 warn, 0 info\)/.test(a)), s.announced.join('\n'));
  assert.ok((await inbox(s, s.chief.id, 'org_audit')).length === 1 && (await inbox(s, auditorAgent.id, 'org_audit')).length === 1);
  const actions = (await s.audit.list(s.orgId, { limit: 200 })).map((r) => r.action);
  assert.ok(actions.includes('audit_start') && actions.includes('audit_end') && actions.includes('spend_reserve') && actions.includes('spend_commit'));
  assert.equal((await s.audit.verify(s.orgId)).ok, true);
  // cadence: just ran → not due; the brief carries the Audit section
  assert.equal(await s.auditor.due(await s.org.get(s.orgId)), false);
  const b = await s.brief.compose(s.orgId, { deliver: false });
  assert.match(b.text, /## Audit\n- .* by Auditor: 2 finding\(s\)/);
  assert.match(b.text, /critical: Issue 12 accepted/);
  assert.match(b.text, /## Pulse: \d+\/100/);
});

// ---- 9. single-model flag, USD cap, cadence tick ----

test('an auditor on the workers\' family with no other provider available is flagged single-model; the USD cap bounds the reservation and an exhausted envelope refuses the run; the cadence tick runs it when due', async () => {
  const s = await setup([[{ type: 'tool_call', id: 'c', name: 'org_audit_close', input: { summary: 'All fine.' } }, { type: 'done' }], [{ type: 'answer', text: 'Done.' }, { type: 'done' }], [{ type: 'answer', text: 'Done again.' }, { type: 'done' }]]);
  const auditorAgent = await s.agents.create({ name: 'Auditor', charter: 'You audit.', provider: 'anthropic', model: 'claude-sonnet-4-5' });
  await s.org.addMember(s.orgId, { agentId: auditorAgent.id, title: 'Auditor', reportsToAgentId: s.chief.id });
  await s.org.update(s.orgId, { auditorAgentId: auditorAgent.id, auditUsdCap: 0.5 });
  // the auditor must be a member; cadence and cap are bounded
  await assert.rejects(s.org.update(s.orgId, { auditorAgentId: 'nobody' }), /must be a member/);
  assert.equal((await s.org.update(s.orgId, { auditCadenceDays: 400 })).auditCadenceDays, 90);
  assert.equal((await s.org.update(s.orgId, { auditCadenceDays: 1 })).auditCadenceDays, 1);
  const pick = await s.auditor.pickModel(await s.org.get(s.orgId), auditorAgent.id);
  assert.equal(pick.single, true, 'same family, no enabled agent type elsewhere');
  // an enabled agent type on another provider lifts the flag and pins the session to it
  await s.db.insert(agentTypes).values({ id: 'at-openai', accountId: 'single', name: 'OpenAI', provider: 'openai-compatible', model: 'gpt-5', models: '[]', baseUrl: 'https://api.openai.com/v1', apiKey: null, persona: '', enabled: 1, createdAt: new Date().toISOString() });
  const pick2 = await s.auditor.pickModel(await s.org.get(s.orgId), auditorAgent.id);
  assert.equal(pick2.single, false);
  assert.equal(pick2.agentTypeId, 'at-openai');
  await s.db.delete(agentTypes).where(eq(agentTypes.id, 'at-openai'));
  // the cap: the reservation is min(cap, estimate) — a $0.2 company envelope cannot hold it → refused and recorded
  await s.org.setBudget(s.orgId, { scope: 'company', refId: s.orgId, monthlyUsd: 0.2 });
  assert.equal(await s.auditor.runAudit(s.orgId, 'manual'), 'budget_stop');
  let [run] = await s.auditor.list(s.orgId);
  assert.equal(run.status, 'budget_stop');
  assert.match(run.summary, /company envelope exhausted/);
  assert.ok((await s.audit.list(s.orgId, { action: 'audit_refused' })).length === 1);
  assert.equal(s.provider.requests.length, 0, 'no model call was made');
  // a refused run counts for the cadence (no retry storm): not due for a day
  assert.equal(await s.auditor.due(await s.org.get(s.orgId)), false);
  // with room for the cap the run proceeds and the report says single-model
  await s.org.setBudget(s.orgId, { scope: 'company', refId: s.orgId, monthlyUsd: 0.6 });
  assert.equal(await s.auditor.runAudit(s.orgId, 'manual'), 'ran');
  [run] = await s.auditor.list(s.orgId);
  assert.equal(run.status, 'done');
  assert.equal(run.singleModel, 1);
  assert.equal(run.summary, 'All fine.');
  assert.ok(s.announced.some((a) => /single-model audit/.test(a)));
  assert.match((await s.brief.compose(s.orgId, { deliver: false })).text, /\(single-model audit\)/);
  const reserve = (await s.audit.list(s.orgId, { action: 'audit_start' }))[0];
  assert.equal((JSON.parse(reserve.payload) as { estimateUsd: number }).estimateUsd <= 0.5, true, 'the estimate is clamped to the cap');
  assert.equal((JSON.parse(reserve.payload) as { singleModel: boolean }).singleModel, true);
  // cadence: back-date the last run and tick → it runs again
  await s.db.execute(sql`UPDATE org_audits SET "startedAt" = ${ago(50)}`);
  assert.equal(await s.auditor.due(await s.org.get(s.orgId)), true);
  await s.auditor.tick(new Date());
  const runs = await s.auditor.list(s.orgId);
  assert.equal(runs.length, 3);
  assert.equal(runs[0].trigger, 'cadence');
});

// ---- 10. the Auditor pack hire, the API trigger, no auditor ----

test('hiring from the Auditor pack seats the auditor with read-only scopes and fills the empty auditor seat; POST audit/run without an auditor is a skip; a plain member cannot read the pulse', async () => {
  const s = await setup([[{ type: 'answer', text: 'ok' }, { type: 'done' }]]);
  assert.equal((await s.controller.runAudit(s.ws.id)).result, 'skipped:no_auditor');
  const chiefSession = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.chief.id, name: 'c' });
  const out = await s.runtime.execute(chiefSession, 'org_hire_agent', { templateOrPack: 'Auditor', title: 'Auditor', scopes: ['tool:fs_read', 'tool:org_audit_query', 'tool:org_read_board', 'tool:org_read_goal', 'tool:fs_write'], why: 'Independent assurance.' });
  assert.match(out, /Hired Auditor/);
  const hired = (await s.agents.list()).find((a) => a.name === 'Auditor')!;
  assert.match(hired.charter, /independent assurance role/);
  const org = await s.org.get(s.orgId);
  assert.equal(org.auditorAgentId, hired.id, 'the empty seat is filled by the pack hire');
  const m = (await s.org.member(s.orgId, hired.id))!;
  assert.deepEqual(JSON.parse(m.scopes), ['tool:fs_read', 'tool:fs_write'], 'the meet rule: only scopes the chief holds (org_* tools are offered by role, not by scope)');
  // the auditor's own session may query the audit log and read the pulse; the writer may not
  const auditorSession = await s.repo.createSession({ workspaceId: s.ws.id, agentId: hired.id, name: 'a' });
  assert.match(await s.runtime.execute(auditorSession, 'org_pulse', {}), /^Pulse \d+\/100/);
  assert.doesNotMatch(await s.runtime.execute(auditorSession, 'org_audit_query', { action: 'auto_hire' }), /No audit rows/);
  const writerSession = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.writer.id, name: 'w' });
  await assert.rejects(s.runtime.execute(writerSession, 'org_pulse', {}), /chief of staff, unit leads and the auditor/);
  await assert.rejects(s.runtime.execute(writerSession, 'org_audit_query', {}), /chief of staff and the auditor/);
  // the chief reads the pulse too, and it names the two SLOs with targets
  assert.match(await s.runtime.execute(chiefSession, 'org_pulse', {}), /cycle time: .*target ≤ 48h/);
  // the API trigger runs it (one scripted answer round, no findings)
  assert.equal((await s.controller.runAudit(s.ws.id)).result, 'ran');
  assert.equal((await s.controller.audits(s.ws.id)).length, 1);
  assert.equal((await s.controller.detail(s.ws.id)).auditorAgentId, hired.id);
  const patched = await s.controller.update(s.ws.id, { auditCadenceDays: 14, auditUsdCap: 3 });
  assert.equal(patched.auditCadenceDays, 14);
  assert.equal(patched.auditUsdCap, 3);
});

// ---- 11. the tick wires signals and the SLO sample; drift heuristic ----

test('the runtime tick sweeps signals and samples SLOs every five minutes for active orgs only; the charter-drift heuristic needs two titles and no shared vocabulary', async () => {
  const s = await setup();
  const t = await s.tasks.create(s.orgId, { title: 'Draft', brief: { outcome: 'x', done_when: 'y' }, assigneeAgentId: s.writer.id });
  await s.db.update(orgTasks).set({ status: 'in_progress', lastRunAt: ago(40), updatedAt: ago(40) }).where(eq(orgTasks.id, t.id));
  // the same hour as now (so the clock stays within an hour of the seeded timestamps), at a given minute
  const at = (minute: number) => { const d = new Date(); d.setMinutes(minute, 0, 0); return d; };
  await s.runtime.tick(at(7));
  assert.equal((await openSignals(s)).length, 0, 'minute 7 is not a sweep minute');
  await s.runtime.tick(at(10));
  assert.equal((await openSignals(s, 'stale_task')).length, 1);
  assert.equal((await s.slo.samples(s.orgId)).length, 1, 'the SLO sample landed with the sweep');
  // a paused org is left alone
  await s.runtime.pause(s.orgId);
  await s.db.delete(orgSignals).where(eq(orgSignals.orgId, s.orgId));
  await s.runtime.tick(at(15));
  assert.equal((await openSignals(s)).length, 0);
  // drift heuristic
  assert.equal(driftsFromCharter('You write newsletter issues and drafts.', ['Draft issue 12', 'Write the intro']), false);
  assert.equal(driftsFromCharter('You write newsletter issues and drafts.', ['File quarterly taxes', 'Reconcile invoices']), true);
  assert.equal(driftsFromCharter('You write newsletter issues and drafts.', ['File quarterly taxes']), false, 'one title is not a pattern');
});
