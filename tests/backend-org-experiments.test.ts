/** Experiments, the prediction ledger and reconciliation (docs/experiments.md,
 *  execution-plan item 30): proposals need a measured metric and a window in
 *  bounds; supervised experiments wait for an `experiment` card, autonomous
 *  tunable experiments start at once with a baseline snapshotted from the
 *  samples; the model-free verdict keeps a clear improvement, reverts harm
 *  automatically (the tunable restored), extends an inconclusive result once
 *  and then reverts; the daily revert-rule check stops early with a minor
 *  incident; concurrency per unit; structural experiments held for the veto
 *  window and changed through cards; decision-log rows and brief lines incl.
 *  "unmeasured change"; forecasts resolved from runs, samples and measured
 *  effects, calibration with a minimum count through the registry and into
 *  the trust ledger's promotion; overclaim and claim_mismatch from ground
 *  truth; the auditor's sample carries the gaps; the routes. */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import { orgDecisions, orgGoals, orgMetricSamples, orgTasks } from '../server/src/database/schema';
import { testDb, memStorage, mcpStub } from './helpers';
import { newId } from '../server/src/common/ids.util';
import { workspaceFileKey } from '../server/src/storage/storage.keys';
import { runWithViewer, type Viewer } from '../server/src/accounts/account-context';
import { ChatsRepository } from '../server/src/chats/chats.repository';
import { TurnLoopService } from '../server/src/chats/turn-loop.service';
import type { TurnContextService } from '../server/src/chats/turn-context.service';
import { ChatLocks } from '../server/src/chats/chat-locks';
import { ToolsService } from '../server/src/chats/tools.service';
import { TriggerBus } from '../server/src/chats/trigger-bus';
import { AgentsService } from '../server/src/agents/agents.service';
import { AgentMemoryService } from '../server/src/agents/agent-memory.service';
import { WorkspacesService } from '../server/src/workspaces/workspaces.service';
import { SkillsService } from '../server/src/skills/skills.service';
import { ConnectionsService } from '../server/src/connections/connections.service';
import type { AiProvider, AiRequest, AiStreamEvent } from '../server/src/ai/ai-provider.interface';
import { OrgAuditService } from '../server/src/org/org-audit.service';
import { OrgService } from '../server/src/org/org.service';
import { OrgTasksService } from '../server/src/org/org-tasks.service';
import { OrgApprovalsService } from '../server/src/org/org-approvals.service';
import { OrgBriefService } from '../server/src/org/org-brief.service';
import { OrgRuntimeService, type RunCtx } from '../server/src/org/org-runtime.service';
import { OrgModeService } from '../server/src/org/org-mode.service';
import { OrgAnnouncer } from '../server/src/org/org-announcer';
import { OrgUnitsService } from '../server/src/org/org-units.service';
import { OrgIntentService } from '../server/src/org/org-intent.service';
import { OrgSignalsService } from '../server/src/org/org-signals.service';
import { OrgSloService } from '../server/src/org/org-slo.service';
import { OrgMeetingsService } from '../server/src/org/org-meetings.service';
import { OrgPlaybooksService } from '../server/src/org/org-playbooks.service';
import { OrgKnowledgeService } from '../server/src/org/org-knowledge.service';
import { OrgMemoryService } from '../server/src/org/org-memory.service';
import { OrgCapitalService } from '../server/src/org/org-capital.service';
import { OrgAuditorService } from '../server/src/org/org-auditor.service';
import { OrgIncidentsService } from '../server/src/org/org-incidents.service';
import { OrgSensingService } from '../server/src/org/org-sensing.service';
import { OrgExperimentsService, statsOf, tripsRevertRule, verdictOf } from '../server/src/org/org-experiments.service';
import { OrgPredictionsService, brier, nae } from '../server/src/org/org-predictions.service';
import { OrgReconciliationService, claimedNumber, deriveCheck } from '../server/src/org/org-reconciliation.service';
import { ExperimentsController } from '../server/src/org/experiments.controller';
import { calibrationOf } from '../server/src/org/calibration-registry';
import { EXPERIMENT_TUNABLES } from '../server/src/org/experiment-tunables';
import { TUNABLES, tunable } from '../server/src/org/org-tunables';
import { TrustService } from '../server/src/actions/trust.service';
import '../server/src/actions/actions-tunables';

const DAY = 86_400_000;
const T = Date.parse('2026-11-02T12:00:00.000Z');
const at = (days: number) => new Date(T + days * DAY);
const iso = (days: number) => at(days).toISOString();

type Plan = (req: AiRequest, toolRound: number) => AiStreamEvent[];
const say = (text: string): AiStreamEvent[] => [{ type: 'answer', text }];
const call = (name: string, input: Record<string, unknown>): AiStreamEvent[] => [{ type: 'tool_call', id: `c-${Math.random().toString(36).slice(2, 8)}`, name, input }];
class PlanProvider implements AiProvider {
  readonly requests: AiRequest[] = [];
  constructor(readonly name: string, public plan: Plan) {}
  async *stream(req: AiRequest): AsyncGenerator<AiStreamEvent> {
    this.requests.push(req);
    const toolRound = req.messages.filter((m) => m.role === 'tool').length;
    for (const ev of this.plan(req, toolRound)) yield ev;
    yield { type: 'usage', inputTokens: 100, outputTokens: 50 };
    yield { type: 'done' };
  }
}

const runtimes: OrgRuntimeService[] = [];
after(() => { for (const r of runtimes) r.onModuleDestroy(); });

async function setup(plan: Plan = () => say('ok')) {
  const db = await testDb();
  const { stub, map } = memStorage();
  const bus = new TriggerBus();
  const agents = new AgentsService(db, stub, bus);
  const workspaces = new WorkspacesService(db, stub);
  const repo = new ChatsRepository(db);
  const config = { get: (k: string) => (k === 'companiesEnabled' ? true : k === 'loopsEnabled' ? false : undefined) } as unknown as ConfigService;
  const provider = new PlanProvider('anthropic', plan);
  const context = { build: async () => ({ provider, model: 'test-model', system: '', maxToolRounds: 24 }) } as unknown as TurnContextService;
  const skillsSvc = new SkillsService(db);
  const connections = new ConnectionsService(db, config);
  const turns = new TurnLoopService(repo, new ChatLocks(), new ToolsService(stub), context, skillsSvc, stub, mcpStub(), agents, workspaces, connections);
  const announcer = new OrgAnnouncer();
  const audit = new OrgAuditService(db);
  const org = new OrgService(db, agents, audit, bus);
  const units = new OrgUnitsService(db, org, agents, audit, announcer);
  const intent = new OrgIntentService(db, org, units, agents, audit, bus);
  const tasks = new OrgTasksService(db, org, audit, bus, units);
  const approvals = new OrgApprovalsService(db, org, tasks, agents, audit, skillsSvc, bus);
  const signals = new OrgSignalsService(db, org, tasks, audit, agents, workspaces, bus, units);
  const slo = new OrgSloService(db, org, tasks, approvals, audit, workspaces, signals);
  const meetings = new OrgMeetingsService(db, org, units, tasks, audit, agents, workspaces, approvals);
  const capital = new OrgCapitalService(db, org, tasks, audit, agents, workspaces, intent, units, signals);
  const brief = new OrgBriefService(db, org, tasks, approvals, audit, agents, workspaces, signals, slo, intent, meetings, capital);
  const runtime = new OrgRuntimeService(db, org, tasks, approvals, audit, brief, turns, repo, agents, workspaces, config, announcer, bus, undefined, undefined, undefined, undefined, undefined, units, signals, slo, intent, undefined, capital);
  runtime.debounceMs = 600_000;
  runtime.planningDebounceMs = 600_000;
  runtimes.push(runtime);
  const agentMemory = new AgentMemoryService(db, stub);
  const playbooks = new OrgPlaybooksService(db, org, tasks, audit, agents, skillsSvc, announcer);
  const knowledge = new OrgKnowledgeService(db, org, tasks, audit, agents, workspaces, repo, turns, runtime);
  const memory = new OrgMemoryService(db, org, tasks, audit, agents, meetings, approvals, runtime, turns, playbooks, knowledge, config, units, signals, undefined, agentMemory, bus);
  const auditor = new OrgAuditorService(db, org, tasks, audit, agents, workspaces, repo, turns, runtime, announcer, signals, config);
  const sensing = new OrgSensingService(db, org, audit, tasks, approvals, agents, config, turns, runtime, units, signals, connections, stub, undefined);
  const incidents = new OrgIncidentsService(db, org, tasks, audit, agents, workspaces, runtime, turns, repo, config, signals, memory, brief, announcer, bus, auditor, connections, undefined, sensing);
  const predictions = new OrgPredictionsService(db, org, audit, tasks, agents, config, turns, runtime, intent, units, brief);
  const experiments = new OrgExperimentsService(db, org, audit, approvals, agents, workspaces, config, turns, runtime, units, meetings, playbooks, capital, incidents, brief, predictions, undefined, announcer);
  const reconciliation = new OrgReconciliationService(db, org, audit, tasks, config, signals, sensing, incidents, brief, auditor);
  const mode = new OrgModeService(org, workspaces, agents, runtime, approvals, audit, announcer);
  const controller = new ExperimentsController(mode, experiments, predictions, config, reconciliation);
  experiments.now = () => new Date(T);
  const ws = (await workspaces.list())[0];
  const chief = await agents.create({ name: 'Chief', charter: 'You run the company.' });
  const writer = await agents.create({ name: 'Writer', charter: 'You write the newsletter.' });
  const editor = await agents.create({ name: 'Editor', charter: 'You edit drafts.' });
  return { db, map, agents, workspaces, repo, provider, bus, audit, org, units, intent, tasks, approvals, signals, meetings, capital, brief, runtime, memory, auditor, sensing, incidents, predictions, experiments, reconciliation, mode, controller, ws, chief, writer, editor };
}
type S = Awaited<ReturnType<typeof setup>>;

async function enable(s: S, modeName: 'supervised' | 'autonomous' = 'autonomous') {
  const st = await s.mode.setMode(s.ws.id, { mode: modeName, chiefOfStaffAgentId: s.chief.id, monthlyUsd: 50, agentCap: 10 });
  const orgId = st.orgId!;
  await s.org.updateMember(orgId, s.writer.id, { title: 'Writer' });
  await s.org.updateMember(orgId, s.editor.id, { title: 'Editor' });
  return orgId;
}

/** A live, CEO-made source (manual_attested: never polled) and a sample seeder; agents never write samples. */
async function source(s: S, orgId: string, name = 'Open rate') {
  const { source: src } = await s.sensing.create(orgId, { name, kind: 'manual_attested', unit: '%' }, 'user');
  return src;
}
async function seed(s: S, sourceId: string, values: number[], fromDay: number, stepDays = 1) {
  for (const [i, value] of values.entries()) {
    const observedAt = iso(fromDay + i * stepDays);
    await s.db.insert(orgMetricSamples).values({ accountId: 'single', id: newId(), sourceId, value, observedAt, fetchedAt: observedAt, provenance: JSON.stringify({ kind: 'manual_attested', by: 'user', note: 'seeded' }), createdAt: observedAt });
  }
}
const BASELINE = [98, 102, 100, 99, 101, 100, 100];
const session = (s: S, agentId: string, name = 'chat') => s.repo.createSession({ workspaceId: s.ws.id, agentId, name });
const inbox = async (s: S, agentId: string, kind?: string) => (await s.agents.listEvents(agentId, 200)).filter((e) => !kind || e.kind === kind);

async function tunableExperiment(s: S, orgId: string, srcId: string, extra: Record<string, unknown> = {}) {
  return s.experiments.propose(orgId, { title: 'Looser pace tolerance', hypothesis: 'Fewer false at-risk wakes raise the open rate', changeKind: 'tunable', change: { key: 'intent.paceTolerance', value: 0.2 }, metric: srcId, direction: 'up', expectedEffect: 0.05, windowDays: 14, ...extra }, 'chief');
}

// ---- 1. the arithmetic ----

test('model-free arithmetic: stats, the noise-guarded verdict, the revert rule, Brier and normalized error, claimed numbers and derived checks', () => {
  const b = statsOf(BASELINE);
  assert.equal(b.n, 7); assert.equal(b.mean, 100); assert.ok(b.sd > 1 && b.sd < 1.5);
  assert.equal(verdictOf({ baseline: b, window: statsOf([110, 111, 109, 110, 110]), direction: 'up', minSamples: 5, noiseFloor: 1 }).verdict, 'improved');
  assert.equal(verdictOf({ baseline: b, window: statsOf([110, 111, 109, 110, 110]), direction: 'down', minSamples: 5, noiseFloor: 1 }).verdict, 'worse');
  assert.equal(verdictOf({ baseline: b, window: statsOf([100.5, 101, 99.5, 100, 100]), direction: 'up', minSamples: 5, noiseFloor: 1 }).verdict, 'inconclusive', 'inside the noise floor');
  assert.equal(verdictOf({ baseline: b, window: statsOf([150, 150]), direction: 'up', minSamples: 5, noiseFloor: 1 }).verdict, 'inconclusive', 'too few samples');
  assert.equal(verdictOf({ baseline: b, window: statsOf([110, 111, 109, 110, 110]), direction: 'up', minSamples: 5, noiseFloor: 1 }).relative, 0.1);
  assert.equal(tripsRevertRule({ worseBy: 0.1, relative: true }, b, statsOf([80, 82]), 'up'), true);
  assert.equal(tripsRevertRule({ worseBy: 0.1, relative: true }, b, statsOf([95, 96]), 'up'), false);
  assert.equal(tripsRevertRule({ worseBy: 5, relative: false }, b, statsOf([107, 108]), 'down'), true);
  assert.equal(brier(0.8, 1), 0.04); assert.equal(brier(0.8, 0), 0.64);
  assert.equal(nae(2, 2), 0); assert.equal(nae(2, 4), 0.5); assert.equal(nae(0, 0), 0); assert.equal(nae(-1, 3), 1);
  assert.deepEqual(claimedNumber('Subscribers at 450 this week', ['Subscribers']), { value: 450, percent: false });
  assert.deepEqual(claimedNumber('good week; subscribers: 80%!', ['Subscribers']), { value: 80, percent: true });
  assert.equal(claimedNumber('no numbers here', ['Subscribers']), null);
  assert.deepEqual(deriveCheck('Mailing list at least 120 subscribers', [{ id: 's1', name: 'Mailing list' }]), { kind: 'metric_at_least', sourceId: 's1', value: 120 });
  assert.deepEqual(deriveCheck('The report is saved as reports/q3.md', []), { kind: 'file_exists', path: 'reports/q3.md' });
  assert.equal(deriveCheck('The CEO likes it', [{ id: 's1', name: 'Mailing list' }]), null);
});

// ---- 2. proposals ----

test('propose validation: a measured metric (not a self-reported key result), a window inside the tunable bound, a change inside its own bound; only the chief and leads propose', async () => {
  const s = await setup();
  const orgId = await enable(s);
  const src = await source(s, orgId);
  const base = { title: 'X', hypothesis: 'Y moves Z', changeKind: 'tunable', change: { key: 'intent.paceTolerance', value: 0.2 }, direction: 'up', expectedEffect: 0.1 };
  await assert.rejects(s.experiments.propose(orgId, base, 'chief'), /measured metric/);
  const objective = await s.units.addGoal(orgId, { title: 'Grow' });
  const kr = await s.intent.setKeyResult(orgId, { title: 'Subscribers', objectiveId: objective.id, targetValue: 100, dueAt: iso(10), ownerAgentId: s.writer.id });
  await assert.rejects(s.experiments.propose(orgId, { ...base, keyResult: kr.id }, 'chief'), /self-reported/);
  await assert.rejects(s.experiments.propose(orgId, { ...base, metric: src.id, windowDays: 2 }, 'chief'), /within 3–90/);
  await assert.rejects(s.experiments.propose(orgId, { ...base, metric: src.id, windowDays: 120 }, 'chief'), /within 3–90/);
  await assert.rejects(s.experiments.propose(orgId, { ...base, metric: src.id, change: { key: 'intent.paceTolerance', value: 0.9 } }, 'chief'), /must stay within/);
  await assert.rejects(s.experiments.propose(orgId, { ...base, metric: src.id, change: { key: 'experiments.noiseFloor', value: 0.5 } }, 'chief'), /experiment rules/);
  await assert.rejects(s.experiments.propose(orgId, { ...base, metric: src.id, changeKind: 'structure', change: { changes: [{ op: 'terminate', agent: 'Writer' }] } }, 'chief'), /terminate cannot be reverted/);
  await assert.rejects(s.experiments.propose(orgId, { ...base, metric: src.id, direction: 'sideways' }, 'chief'), /direction/);
  // a key result bound to a source qualifies
  await s.intent.bindSource(orgId, kr.id, src.id);
  const viaKr = await s.experiments.propose(orgId, { ...base, keyResult: kr.id }, 'chief');
  assert.equal(viaKr.metricSourceId, src.id);
  assert.equal(viaKr.windowDays, EXPERIMENT_TUNABLES['experiments.windowDays'].default);
  // `other` may go unmeasured
  const other = await s.experiments.propose(orgId, { ...base, changeKind: 'other', change: { description: 'Try a Tuesday send' } }, 'chief');
  assert.equal(other.metricSourceId, null);
  // tools: the writer (no reports) is offered only the read tool and refused the proposal
  const ws = await session(s, s.writer.id);
  assert.deepEqual((await s.experiments.specsFor(ws)).map((t) => t.name), ['org_experiments']);
  await assert.rejects(s.experiments.execute(ws, 'org_propose_experiment', base), /chief of staff and unit leads/);
  assert.match(await s.experiments.execute(ws, 'org_experiments', {}), /Looser|"X"/);
});

// ---- 3. governance ----

test('supervised: the chief\'s proposal is an `experiment` card; approving it snapshots the baseline and applies the change; rejecting abandons', async () => {
  const s = await setup();
  const orgId = await enable(s, 'supervised');
  const src = await source(s, orgId);
  await seed(s, src.id, BASELINE, -7);
  const chat = await session(s, s.chief.id);
  const out = await s.experiments.execute(chat, 'org_propose_experiment', { title: 'Looser pace', hypothesis: 'Fewer false alarms', changeKind: 'tunable', change: { key: 'intent.paceTolerance', value: 0.2 }, metric: 'Open rate', direction: 'up', expectedEffect: 0.05, windowDays: 14 });
  assert.match(out, /approval/);
  const card = (await s.approvals.pending(orgId)).find((a) => a.kind === 'experiment')!;
  assert.ok(card, 'an experiment card');
  assert.equal(tunable(await s.org.get(orgId), 'intent.paceTolerance'), 0.15, 'nothing changes before the CEO decides');
  await s.approvals.decide(orgId, card.id, 'approve', '', 'user');
  const [row] = await s.experiments.list(orgId);
  assert.equal(row.status, 'running');
  assert.equal(row.approvalId, card.id);
  assert.equal(tunable(await s.org.get(orgId), 'intent.paceTolerance'), 0.2);
  const b = JSON.parse(row.baseline);
  assert.equal(b.n, 7); assert.equal(b.mean, 100);
  // a second one, rejected
  await s.experiments.execute(chat, 'org_propose_experiment', { title: 'Cheaper triage', hypothesis: 'h', changeKind: 'routing', change: { class: 'triage', tier: 'cheap' }, metric: 'Open rate', direction: 'up', expectedEffect: 0.05 });
  const card2 = (await s.approvals.pending(orgId)).find((a) => a.kind === 'experiment')!;
  await s.approvals.decide(orgId, card2.id, 'reject', 'not now', 'user');
  assert.equal((await s.experiments.list(orgId)).find((r) => r.title === 'Cheaper triage')!.status, 'abandoned');
});

test('autonomous: a tunable experiment starts at once through the tool — baseline from the previous window, the change applied by setTunable as `experiment`, the revert recipe recorded, the forecast in the ledger', async () => {
  const s = await setup();
  const orgId = await enable(s);
  const src = await source(s, orgId);
  await seed(s, src.id, [50, 51], -30); // outside the window: not in the baseline
  await seed(s, src.id, BASELINE, -7);
  const out = await s.experiments.execute(await session(s, s.chief.id), 'org_propose_experiment', { title: 'Looser pace', hypothesis: 'Fewer false alarms', changeKind: 'tunable', change: { key: 'intent.paceTolerance', value: 0.2 }, metric: src.id.slice(0, 8), direction: 'up', expectedEffect: 0.05, windowDays: 14 });
  assert.match(out, /started: baseline 100 over 7 sample/);
  const [row] = await s.experiments.list(orgId);
  assert.equal(row.status, 'running');
  assert.equal(row.startedAt, iso(0)); assert.equal(row.endsAt, iso(14));
  assert.deepEqual(JSON.parse(row.change).revert, { key: 'intent.paceTolerance', value: 0.15, wasDefault: true });
  assert.equal(tunable(await s.org.get(orgId), 'intent.paceTolerance'), 0.2);
  assert.ok((await s.audit.list(orgId, { action: 'tunable_set' })).some((r) => r.actor === 'experiment'), 'applied on the tunables\' own path');
  assert.ok((await s.audit.list(orgId, { action: 'experiment_start' })).length === 1);
  assert.ok((await inbox(s, s.chief.id, 'org_experiment')).some((e) => /Experiment started/.test(e.title)));
  const [forecast] = await s.predictions.list(orgId, { subjectKind: 'experiment' });
  assert.equal(forecast.agentId, s.chief.id);
  assert.deepEqual(JSON.parse(forecast.forecast), { kind: 'number', value: 0.05, unit: 'relative' });
  // a baseline too thin is refused (and the proposal abandoned)
  const thin = await source(s, orgId, 'Clicks');
  await seed(s, thin.id, [1, 2], -3);
  await s.org.setTunable(orgId, 'experiments.concurrentPerUnit', 2);
  await assert.rejects(s.experiments.execute(await session(s, s.chief.id, 'c2'), 'org_propose_experiment', { title: 'Thin', hypothesis: 'h', changeKind: 'routing', change: { class: 'triage', tier: 'cheap' }, metric: 'Clicks', direction: 'up', expectedEffect: 0.1, windowDays: 14 }), /2 sample\(s\).*at least 5/);
});

// ---- 4. verdicts ----

test('keep on a clear improvement: the verdict at endsAt keeps the change, writes the decision log with the numbers, tells the chief and scores the proposer\'s forecast', async () => {
  const s = await setup();
  const orgId = await enable(s);
  const src = await source(s, orgId);
  await seed(s, src.id, BASELINE, -7);
  const row = await tunableExperiment(s, orgId, src.id);
  await s.experiments.start(orgId, row.id, 'chief');
  await seed(s, src.id, [110, 111, 109, 110, 110, 110], 1, 2);
  assert.deepEqual(await s.experiments.sweep(orgId, at(13.5)), [], 'nothing is due before endsAt (and the daily check passes)');
  const [r] = await s.experiments.sweep(orgId, at(14.5));
  assert.equal(r.status, 'kept'); assert.equal(r.verdict, 'improved');
  const kept = await s.experiments.get(orgId, row.id);
  const res = JSON.parse(kept.result);
  assert.equal(res.delta, 10); assert.equal(res.relative, 0.1); assert.equal(res.met, true);
  assert.equal(tunable(await s.org.get(orgId), 'intent.paceTolerance'), 0.2, 'kept: the change stays');
  const decision = (await s.db.select().from(orgDecisions).where(eq(orgDecisions.orgId, orgId))).find((d) => d.refType === 'experiment')!;
  assert.equal(kept.decisionId, decision.id);
  assert.match(decision.title, /Experiment kept/);
  assert.match(decision.rationale, /Hypothesis: Fewer false at-risk wakes.*baseline 100 \(n=7.*→ 110 \(n=6\); delta \+10 \(\+10%\)/);
  assert.ok((await inbox(s, s.chief.id, 'org_experiment')).some((e) => /Experiment kept/.test(e.title)));
  const [f] = await s.predictions.list(orgId, { subjectKind: 'experiment', subjectId: row.id });
  assert.equal(f.status, 'resolved');
  assert.equal(f.score, 0.5, 'forecast +5 %, measured +10 %: normalized error 0.5');
});

test('revert on harm: a clear worsening at endsAt reverts automatically — the tunable is restored on its own path — and the decision log says so', async () => {
  const s = await setup();
  const orgId = await enable(s);
  const src = await source(s, orgId);
  await seed(s, src.id, BASELINE, -7);
  const row = await tunableExperiment(s, orgId, src.id, { revertRule: { worseBy: 50, relative: false } });
  await s.experiments.start(orgId, row.id, 'chief');
  await seed(s, src.id, [95, 94, 96, 95, 95], 1, 2);
  const [r] = await s.experiments.sweep(orgId, at(15));
  assert.equal(r.status, 'reverted'); assert.equal(r.verdict, 'worse');
  assert.equal(tunable(await s.org.get(orgId), 'intent.paceTolerance'), 0.15, 'restored');
  const rows = (await s.audit.list(orgId, { action: 'tunable_set' })).filter((x) => x.actor === 'experiment');
  assert.equal(rows.length, 2, 'applied and reverted through setTunable');
  assert.ok((await s.db.select().from(orgDecisions).where(eq(orgDecisions.orgId, orgId))).some((d) => /Experiment reverted/.test(d.title)));
});

test('inconclusive → extended once by its window → reverted when still inconclusive', async () => {
  const s = await setup();
  const orgId = await enable(s);
  const src = await source(s, orgId);
  await seed(s, src.id, BASELINE, -7);
  const row = await tunableExperiment(s, orgId, src.id);
  await s.experiments.start(orgId, row.id, 'chief');
  await seed(s, src.id, [100, 101, 99, 100, 100], 1, 2);
  const [first] = await s.experiments.sweep(orgId, at(14.5));
  assert.equal(first.status, 'extended');
  const ext = await s.experiments.get(orgId, row.id);
  assert.equal(ext.extensions, 1); assert.equal(ext.endsAt, iso(28));
  assert.equal(tunable(await s.org.get(orgId), 'intent.paceTolerance'), 0.2, 'still applied while extended');
  await seed(s, src.id, [100, 100, 100], 15, 3);
  const [second] = await s.experiments.sweep(orgId, at(29));
  assert.equal(second.status, 'reverted'); assert.equal(second.verdict, 'inconclusive');
  assert.match(JSON.parse((await s.experiments.get(orgId, row.id)).result).note, /inconclusive after 1 extension/);
  assert.equal(tunable(await s.org.get(orgId), 'intent.paceTolerance'), 0.15);
});

test('early stop: the daily check trips the revert rule mid-window — reverted at once and a minor experiment_harm incident about the proposer', async () => {
  const s = await setup();
  const orgId = await enable(s);
  const src = await source(s, orgId);
  await seed(s, src.id, BASELINE, -7);
  const row = await tunableExperiment(s, orgId, src.id);
  await s.experiments.start(orgId, row.id, 'chief');
  await seed(s, src.id, [80, 82], 0.5, 0.5);
  assert.deepEqual(await s.experiments.sweep(orgId, at(0.9)), [], 'not checked again within a day');
  const [r] = await s.experiments.sweep(orgId, at(1.5));
  assert.equal(r.status, 'reverted'); assert.equal(r.verdict, 'harm');
  assert.equal(tunable(await s.org.get(orgId), 'intent.paceTolerance'), 0.15);
  await s.incidents.idle();
  const inc = (await s.incidents.list(orgId)).find((i) => i.kind === 'experiment_harm')!;
  assert.ok(inc, 'an incident');
  assert.equal(inc.severity, 'minor');
  assert.equal(inc.refType, 'experiment'); assert.equal(inc.refId, row.id);
  assert.equal(inc.agentId, s.chief.id);
});

test('concurrency: one running experiment per unit by default (their effects would confound); the tunable raises it within its bound', async () => {
  const s = await setup();
  const orgId = await enable(s);
  const src = await source(s, orgId);
  await seed(s, src.id, BASELINE, -7);
  const a = await tunableExperiment(s, orgId, src.id);
  await s.experiments.start(orgId, a.id, 'chief');
  const b = await s.experiments.propose(orgId, { title: 'Cheaper triage', hypothesis: 'h', changeKind: 'routing', change: { class: 'triage', tier: 'cheap' }, metric: src.id, direction: 'up', expectedEffect: 0.05 }, 'chief');
  await assert.rejects(s.experiments.start(orgId, b.id, 'chief'), /already run in this unit \(experiments.concurrentPerUnit = 1\)/);
  await assert.rejects(s.org.setTunable(orgId, 'experiments.concurrentPerUnit', 9), /within 1–5/);
  await s.org.setTunable(orgId, 'experiments.concurrentPerUnit', 2);
  const started = await s.experiments.start(orgId, b.id, 'chief');
  assert.equal(started.status, 'running');
  assert.equal((await s.org.routing(orgId)).classes.triage, 'cheap');
  // and the CEO's revert restores the routing
  await s.controller.revert(s.ws.id, b.id);
  assert.equal((await s.org.routing(orgId)).classes.triage, undefined);
});

test('structural (charter) experiment in autonomous mode: held in a plan for the veto window, then its change goes to the CEO as a charter_change card; measuring starts on approval; a revert is the inverse card', async () => {
  const s = await setup();
  const orgId = await enable(s);
  const src = await source(s, orgId);
  await seed(s, src.id, BASELINE, -7);
  const out = await s.experiments.execute(await session(s, s.chief.id), 'org_propose_experiment', { title: 'Writer cites sources', hypothesis: 'Cited issues get opened more', changeKind: 'charter', change: { agent: 'Writer', text: 'Cite a source for every claim.' }, metric: 'Open rate', direction: 'up', expectedEffect: 0.05 });
  assert.match(out, /held in plan/);
  const [plan] = await s.capital.plans(orgId, { status: 'pending' });
  assert.match(plan.summary, /experiment/);
  assert.equal((await s.experiments.list(orgId))[0].status, 'proposed');
  await s.capital.applyNow(orgId, plan.id, 'user');
  const row = (await s.experiments.list(orgId))[0];
  assert.ok(row.changeApprovalId, 'the change card');
  const card = await s.approvals.get(orgId, row.changeApprovalId!);
  assert.equal(card.kind, 'charter_change');
  assert.equal(row.status, 'proposed', 'not measuring until the card is approved');
  await s.approvals.decide(orgId, card.id, 'approve', '', 'user');
  const running = await s.experiments.get(orgId, row.id);
  assert.equal(running.status, 'running');
  assert.match((await s.agents.get(s.writer.id)).charter, /Cite a source/);
  const reverted = await s.experiments.conclude(orgId, row.id, { force: 'revert', actor: 'user' });
  const revertCard = await s.approvals.get(orgId, JSON.parse(reverted.result).revertApprovalId);
  assert.equal(revertCard.kind, 'charter_change');
  assert.equal(JSON.parse(revertCard.payload).after, 'You write the newsletter.', 'the inverse card restores the old charter');
});

// ---- 5. the brief ----

test('brief: an Experiments section with the running reading, the verdicts since the last brief, and an "unmeasured change" for a direct tune by the chief', async () => {
  const s = await setup();
  const orgId = await enable(s);
  const src = await source(s, orgId);
  await seed(s, src.id, BASELINE, -7);
  const a = await tunableExperiment(s, orgId, src.id);
  await s.experiments.start(orgId, a.id, 'chief');
  await seed(s, src.id, [104, 105], 1);
  const text = (await s.brief.compose(orgId, { deliver: false, now: at(3) })).text;
  assert.match(text, /## Experiments \(1 running\)/);
  assert.match(text, /▶ Looser pace tolerance \(tunable\) — day 3 of 14; 104.5 so far \(n=2\) vs baseline 100; expects \+5%/);
  // a direct tune by the chief (audit rows carry the real clock)
  await s.org.setTunable(orgId, 'intent.confidenceDrops', 3, { actor: 'chief', why: 'feels right' });
  const now = (await s.brief.compose(orgId, { deliver: false, now: new Date(Date.now() + 60_000) })).text;
  assert.match(now, /⚠ unmeasured change: tune intent.confidenceDrops 2 → 3 \(the chief\)/);
  assert.doesNotMatch(now, /unmeasured change: tune intent.paceTolerance/, 'the experiment\'s own change is measured');
  await seed(s, src.id, [110, 110, 110, 110], 5, 2);
  await s.experiments.sweep(orgId, at(15));
  assert.match((await s.brief.compose(orgId, { deliver: false, now: at(15.2) })).text, /✓ kept: Looser pace tolerance — improved, delta \+/);
});

// ---- 6. predictions ----

test('predictions: a task duration forecast (asked for in the first run\'s context) resolves by the actual runs to done; supersede and validation', async () => {
  const s = await setup();
  const orgId = await enable(s);
  const t = await s.tasks.create(orgId, { title: 'Write issue 12', brief: { outcome: 'A draft', done_when: 'Saved' }, assigneeAgentId: s.writer.id });
  const chat = await session(s, s.writer.id, 'task run');
  const ctx: RunCtx = { orgId, taskId: t.id, agentId: s.writer.id, runId: 'r1', sessionId: chat.id, isChief: false, reviewer: false, progress: false, calls: new Map(), loopDetected: false };
  (s.runtime as unknown as { running: Map<string, RunCtx> }).running.set(chat.id, ctx);
  assert.match((await s.predictions.contextFor(chat))!, /org_forecast_outcome .*duration_runs/);
  await assert.rejects(s.predictions.execute(chat, 'org_forecast_outcome', { subject: { kind: 'task' }, question: 'runs', forecast: { kind: 'probability', value: 1.4 } }), /0–1/);
  await s.predictions.execute(chat, 'org_forecast_outcome', { subject: { kind: 'task' }, question: 'runs to done', forecast: { kind: 'duration_runs', value: 4 } });
  await s.predictions.execute(chat, 'org_forecast_outcome', { subject: { kind: 'task' }, question: 'runs to done', forecast: { kind: 'duration_runs', value: 2 } });
  assert.equal(await s.predictions.contextFor(chat), null, 'asked once');
  const mine = await s.predictions.list(orgId, { agentId: s.writer.id });
  assert.deepEqual(mine.map((p) => p.status).sort(), ['open', 'void'], 'the newer forecast supersedes');
  for (let i = 0; i < 2; i++) { const r = await s.tasks.startRun(orgId, { taskId: t.id, agentId: s.writer.id, wakeReason: 'assignment' }); await s.tasks.endRun(r.id, { status: 'done', outcome: 'progressed' }); }
  assert.deepEqual(await s.predictions.sweep(orgId), { resolved: 0, voided: 0 }, 'open until the task is done');
  await s.db.update(orgTasks).set({ status: 'done' }).where(eq(orgTasks.id, t.id));
  assert.deepEqual(await s.predictions.sweep(orgId), { resolved: 1, voided: 0 });
  const [p] = await s.predictions.list(orgId, { agentId: s.writer.id, status: 'resolved' });
  assert.equal(p.score, 0);
  assert.equal(JSON.parse(p.outcome).value, 2);
});

test('predictions: an owner\'s check-in confidence on a sourced key result is a probability forecast, scored with the Brier score from the source\'s sample at the due date', async () => {
  const s = await setup();
  const orgId = await enable(s);
  const src = await source(s, orgId, 'Subscribers');
  const objective = await s.units.addGoal(orgId, { title: 'Grow' });
  const dueAt = new Date(Date.now() + 2 * DAY).toISOString();
  const kr = await s.intent.setKeyResult(orgId, { title: 'Reach 100 subscribers', objectiveId: objective.id, targetValue: 100, dueAt, ownerAgentId: s.writer.id });
  await s.intent.checkIn(orgId, kr.id, { confidence: 0.6 }, `agent:${s.writer.id}`);
  assert.equal((await s.predictions.list(orgId)).length, 0, 'a self-reported key result cannot be scored: no forecast');
  await s.intent.bindSource(orgId, kr.id, src.id);
  await s.intent.checkIn(orgId, kr.id, { confidence: 0.8, note: 'on track' }, `agent:${s.writer.id}`);
  const [p] = await s.predictions.list(orgId);
  assert.equal(p.origin, 'checkin'); assert.equal(p.subjectKind, 'key_result'); assert.equal(p.resolvesAt, new Date(dueAt).toISOString());
  await s.sensing.attest(orgId, src.id, { value: 120, note: 'export' }, 'user');
  assert.deepEqual(await s.predictions.sweep(orgId, new Date(Date.now() + DAY)), { resolved: 0, voided: 0 }, 'not before the due date');
  await s.predictions.sweep(orgId, new Date(Date.now() + 3 * DAY));
  const done = (await s.predictions.list(orgId))[0];
  assert.equal(done.status, 'resolved');
  assert.equal(done.score, 0.04, '(0.8 − 1)²');
  assert.equal(JSON.parse(done.outcome).measured, 120);
});

test('calibration: null below the minimum count, then 1 − mean loss of the last N; served through the registry; the trust ledger holds promotion below trust.calibrationBar and does not block without a score', async () => {
  const s = await setup();
  const orgId = await enable(s);
  const forecastNever = async (n: number) => {
    for (let i = 0; i < n; i++) {
      const t = await s.tasks.create(orgId, { title: `Task ${i}`, assigneeAgentId: s.writer.id });
      await s.predictions.record(orgId, { agentId: s.writer.id, subjectKind: 'task', subjectId: t.id, question: 'done by yesterday', forecast: { kind: 'probability', value: 0.9 }, resolvesAt: new Date(Date.now() - DAY).toISOString() });
    }
    await s.predictions.sweep(orgId);
  };
  await forecastNever(4);
  assert.equal((await s.predictions.calibration(orgId, s.writer.id)).calibration, null, '4 < calibrationMinCount (5)');
  assert.equal(await calibrationOf(s.ws.id, s.writer.id), null);
  await forecastNever(1);
  const c = await s.predictions.calibration(orgId, s.writer.id);
  assert.equal(c.resolved, 5); assert.equal(c.brier, 0.81); assert.equal(c.calibration, 0.19); assert.equal(c.biasLabel, 'over');
  assert.equal(await calibrationOf(s.ws.id, s.writer.id), 0.19, 'the registry serves the ledger');
  const report = await s.controller.calibration(s.ws.id);
  assert.equal(report.find((r) => r.agentId === s.writer.id)!.calibration, 0.19);
  assert.match((await s.brief.compose(orgId, { deliver: false })).text, /## Calibration\n- Writer 19% \(5, over-forecasts\)\. Discount the estimates of Writer\./);
  // the trust ledger (item 28): ten clean outcomes promote only a calibrated member
  const trust = new TrustService(s.db);
  for (let i = 0; i < 10; i++) await trust.record(s.ws.id, s.writer.id, 'external_reversible', 'success', { refType: 'test', refId: `w${i}` });
  assert.equal((await trust.row(s.ws.id, s.writer.id, 'external_reversible')).level, 1, 'below the calibration bar: held');
  for (let i = 0; i < 10; i++) await trust.record(s.ws.id, s.editor.id, 'external_reversible', 'success', { refType: 'test', refId: `e${i}` });
  assert.equal((await trust.row(s.ws.id, s.editor.id, 'external_reversible')).level, 2, 'no forecasts, no score: not blocked');
  await s.org.setTunable(orgId, 'trust.calibrationBar', 0.1);
  await trust.record(s.ws.id, s.writer.id, 'external_reversible', 'success', { refType: 'test', refId: 'w10' });
  assert.equal((await trust.row(s.ws.id, s.writer.id, 'external_reversible')).level, 2, 'over the (lowered) bar: promoted');
});

// ---- 7. reconciliation ----

test('reconciliation: high confidence on two check-ins while the source puts the key result behind pace is an overclaim signal; a claimed number in the note that the source contradicts is a gap', async () => {
  const s = await setup();
  const orgId = await enable(s);
  const src = await source(s, orgId, 'Subscribers');
  const objective = await s.units.addGoal(orgId, { title: 'Grow' });
  const kr = await s.intent.setKeyResult(orgId, { title: 'Subscribers', objectiveId: objective.id, metric: 'subscribers', targetValue: 100, dueAt: new Date(Date.now() + 10 * DAY).toISOString(), ownerAgentId: s.writer.id });
  await s.db.update(orgGoals).set({ createdAt: new Date(Date.now() - 10 * DAY).toISOString() }).where(eq(orgGoals.id, kr.id));
  await s.intent.bindSource(orgId, kr.id, src.id);
  await s.sensing.attest(orgId, src.id, { value: 10, observedAt: new Date(Date.now() - 60_000).toISOString(), note: 'export' }, 'user');
  await s.intent.checkIn(orgId, kr.id, { confidence: 0.9, note: 'fine' }, `agent:${s.writer.id}`);
  assert.equal((await s.reconciliation.sweep(orgId)).gaps.filter((g) => g.kind === 'overclaim').length, 0, 'one check-in is not a trend');
  await s.intent.checkIn(orgId, kr.id, { confidence: 0.85, note: 'Subscribers at 60 now' }, `agent:${s.writer.id}`);
  const r = await s.reconciliation.sweep(orgId);
  const over = r.gaps.find((g) => g.kind === 'overclaim')!;
  assert.ok(over, 'overclaim');
  assert.match(over.detail, /0\.9 → 0\.85.*10% \(pace 50%\)/);
  const claimed = r.gaps.find((g) => g.kind === 'claimed_number')!;
  assert.equal(claimed.claimed, 60); assert.equal(claimed.measured, 10);
  const sig = (await s.signals.list(orgId, { kind: 'overclaim' }))[0];
  assert.equal(sig.refId, kr.id); assert.equal(sig.addresseeId, s.chief.id);
  assert.deepEqual((await s.controller.reconciliationLatest(s.ws.id)).gaps.map((g) => g.kind).sort(), ['claimed_number', 'overclaim']);
  assert.equal((await s.reconciliation.sweep(orgId)).checked.brief, true, 'the brief\'s numbers agree with the ledger: no report_drift');
  assert.equal((await s.signals.list(orgId, { kind: 'report_drift' })).length, 0);
});

test('reconciliation: a task accepted by review whose done_when names a file runs the derived check once; a failure is a claim_mismatch signal and a minor incident; the auditor\'s sample carries the gaps', async () => {
  const s = await setup((req, toolRound) => (/Organisation audit/.test(req.system ?? '') && toolRound === 0 ? call('org_audit_close', { summary: 'ok' }) : say('done')));
  const orgId = await enable(s);
  const t = await s.tasks.create(orgId, { title: 'Q3 report', brief: { outcome: 'A report', done_when: 'The report is saved as reports/q3.md' }, assigneeAgentId: s.writer.id, reviewerAgentId: s.editor.id });
  const ok = await s.tasks.create(orgId, { title: 'Q2 report', brief: { outcome: 'A report', done_when: 'Saved as reports/q2.md' }, assigneeAgentId: s.writer.id });
  s.map.set(workspaceFileKey(s.ws.id, 'reports/q2.md'), Buffer.from('# Q2'));
  await s.tasks.review(orgId, t.id, { verdict: 'accept', byAgentId: s.editor.id });
  await s.tasks.review(orgId, ok.id, { verdict: 'accept', byAgentId: s.editor.id });
  const r = await s.reconciliation.sweep(orgId);
  const gap = r.gaps.find((g) => g.kind === 'claim_mismatch')!;
  assert.equal(gap.refId, t.id);
  assert.match(gap.detail, /reports\/q3\.md does not exist/);
  assert.ok(!r.gaps.some((g) => g.refId === ok.id), 'the file that exists passes');
  await s.incidents.idle();
  const inc = (await s.incidents.list(orgId)).find((i) => i.kind === 'claim_mismatch')!;
  assert.equal(inc.severity, 'minor'); assert.equal(inc.agentId, s.writer.id);
  assert.equal((await s.signals.list(orgId, { kind: 'claim_mismatch' }))[0].refId, t.id);
  // the auditor's run context includes the latest sweep's gaps
  const auditorAgent = await s.agents.create({ name: 'Auditor', charter: 'You audit.' });
  await s.org.addMember(orgId, { agentId: auditorAgent.id, title: 'Auditor', reportsToAgentId: s.chief.id });
  await s.org.update(orgId, { auditorAgentId: auditorAgent.id });
  assert.equal(await s.auditor.runAudit(orgId, 'manual'), 'ran');
  const seen = s.provider.requests.map((q) => `${q.system ?? ''}\n${q.messages.map((m) => m.content).join('\n')}`).join('\n');
  assert.match(seen, /Reconciliation gaps — claimed versus measured/);
  assert.match(seen, /\[claim_mismatch\] task:/);
  assert.equal((await s.reconciliation.sweep(orgId)).checked.tasks, 0, 'each task is reconciled once');
});

// ---- 8. routes and tunables ----

test('routes: the CEO proposes, starts, stops, keeps; other humans are refused writes; predictions and calibration read; tunables are bounded and registered', async () => {
  const s = await setup();
  const orgId = await enable(s);
  const src = await source(s, orgId);
  await seed(s, src.id, BASELINE, -7);
  const created = await s.controller.create(s.ws.id, { title: 'Weekly cadence', hypothesis: 'A weekly review keeps the rate up', changeKind: 'tunable', change: { key: 'intent.paceTolerance', value: 0.25 }, metric: 'Open rate', direction: 'up', expectedEffect: 0.1 });
  assert.equal(created.status, 'proposed');
  assert.equal(created.proposedBy, 'user');
  const as = (id: string): Viewer => ({ memberAccountId: id, role: 'member', workspaceId: s.ws.id, displayName: id });
  await assert.rejects(runWithViewer('single', as('olga'), () => s.controller.start(s.ws.id, created.id)), /by the CEO/);
  const started = await s.controller.start(s.ws.id, created.id);
  assert.equal(started.status, 'running');
  assert.equal((started.baseline as { n: number }).n, 7);
  const got = await s.controller.get(s.ws.id, created.id.slice(0, 8));
  assert.equal(got.id, created.id);
  assert.equal((await s.controller.list(s.ws.id, 'running')).length, 1);
  const kept = await s.controller.keep(s.ws.id, created.id);
  assert.equal(kept.status, 'kept');
  assert.match((kept.result as { note: string }).note, /decided by the CEO/);
  const second = await s.controller.create(s.ws.id, { title: 'Cheaper triage', hypothesis: 'h', changeKind: 'routing', change: { class: 'triage', tier: 'cheap' }, metric: 'Open rate', direction: 'up', expectedEffect: 0.1 });
  assert.equal((await s.controller.stop(s.ws.id, second.id, {})).status, 'abandoned');
  assert.deepEqual(await s.controller.listPredictions(s.ws.id, undefined, 'open'), []);
  for (const key of Object.keys(EXPERIMENT_TUNABLES)) assert.ok(TUNABLES[key], key);
  assert.deepEqual([EXPERIMENT_TUNABLES['experiments.minSamples'].min, EXPERIMENT_TUNABLES['experiments.minSamples'].max], [2, 100]);
  assert.deepEqual([EXPERIMENT_TUNABLES['experiments.noiseFloor'].default, EXPERIMENT_TUNABLES['predictions.calibrationWindow'].default, EXPERIMENT_TUNABLES['reconciliation.overclaimConfidence'].max], [1, 20, 0.95]);
  await assert.rejects(s.org.setTunable(orgId, 'experiments.maxExtensions', 4), /within 0–3/);
});
