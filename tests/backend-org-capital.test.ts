/** Capital and the CEO seat (docs/company-vision.md §7–§8, execution-plan
 *  item 23): the task class (set or derived by the one shared heuristic) and
 *  the model-free cost roll-up task → key result → objective → vision with
 *  the overspend flag against a tunable margin; allocations per objective
 *  that say what an envelope buys, in the planning prompt and on the budget
 *  card; model routing by class with the CEO's pin winning, as a tool in both
 *  modes and through the API; the burn forecast, its `burn_forecast` signal
 *  and the brief's projection line; the plan preview with a veto window in
 *  autonomous mode (collected, applied on the tick in order through the tool
 *  paths, vetoed, applied now, window 0, stop at first refusal) and the dry
 *  run that applies nothing; the replay of a day with the chain check. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import { orgAudit, orgPlans, orgRuns } from '../server/src/database/schema';
import { testDb, memStorage, ctxStub, skillsStub, mcpStub, ScriptedProvider } from './helpers';
import type { AiStreamEvent } from '../server/src/ai/ai-provider.interface';
import { ChatsRepository } from '../server/src/chats/chats.repository';
import { TurnLoopService } from '../server/src/chats/turn-loop.service';
import { ChatLocks } from '../server/src/chats/chat-locks';
import { ToolsService } from '../server/src/chats/tools.service';
import { TriggerBus } from '../server/src/chats/trigger-bus';
import { AgentsService } from '../server/src/agents/agents.service';
import { WorkspacesService } from '../server/src/workspaces/workspaces.service';
import { OrgAuditService } from '../server/src/org/org-audit.service';
import { OrgService } from '../server/src/org/org.service';
import { OrgTasksService, deriveTaskClass, TASK_CLASSES } from '../server/src/org/org-tasks.service';
import { OrgApprovalsService, summarize } from '../server/src/org/org-approvals.service';
import { OrgBriefService } from '../server/src/org/org-brief.service';
import { OrgRuntimeService } from '../server/src/org/org-runtime.service';
import { OrgModeService } from '../server/src/org/org-mode.service';
import { OrgAnnouncer } from '../server/src/org/org-announcer';
import { OrgUnitsService } from '../server/src/org/org-units.service';
import { OrgIntentService } from '../server/src/org/org-intent.service';
import { OrgSignalsService } from '../server/src/org/org-signals.service';
import { OrgSloService, classOf } from '../server/src/org/org-slo.service';
import { OrgCapitalService, parseActions } from '../server/src/org/org-capital.service';
import { parseRouting, resolveRoute, mergeRouting, tierModel } from '../server/src/org/org-routing';
import { TUNABLES, tunable } from '../server/src/org/org-tunables';
import { OrgController } from '../server/src/org/org.controller';
import { WorkspaceOrgController } from '../server/src/org/workspace-org.controller';
import { setAddressLookup } from '../server/src/common/url-guard';

setAddressLookup(async () => [{ address: '93.184.216.34', family: 4 }]);

const DAY = 24 * 60 * 60_000;
const iso = (offsetDays: number, from = Date.now()) => new Date(from + offsetDays * DAY).toISOString();

/** The org stack of backend-org-intent.test.ts plus signals, SLOs and OrgCapitalService. */
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
  const intent = new OrgIntentService(db, org, units, agents, audit, bus);
  const tasks = new OrgTasksService(db, org, audit, bus, units);
  const approvals = new OrgApprovalsService(db, org, tasks, agents, audit, undefined, bus);
  const signals = new OrgSignalsService(db, org, tasks, audit, agents, workspaces, bus, units);
  const slo = new OrgSloService(db, org, tasks, approvals, audit, workspaces, signals);
  const capital = new OrgCapitalService(db, org, tasks, audit, agents, workspaces, intent, units, signals);
  const brief = new OrgBriefService(db, org, tasks, approvals, audit, agents, workspaces, signals, slo, intent, undefined, capital);
  const runtime = new OrgRuntimeService(db, org, tasks, approvals, audit, brief, turns, repo, agents, workspaces, config, announcer, bus, undefined, undefined, undefined, undefined, undefined, units, signals, slo, intent, undefined, capital);
  runtime.debounceMs = 15;
  runtime.planningDebounceMs = 15;
  runtime.planningCooldownMs = 60_000;
  const mode = new OrgModeService(org, workspaces, agents, runtime, approvals, audit, announcer);
  const orgs = new OrgController(org, tasks, approvals, audit, brief, runtime, config, units, signals, slo, undefined, intent, capital);
  const controller = new WorkspaceOrgController(mode, orgs, config);
  const ws = (await workspaces.list())[0];
  const chief = await agents.create({ name: 'Chief', charter: 'You run the company.' });
  const writer = await agents.create({ name: 'Writer', charter: 'You write.' });
  const editor = await agents.create({ name: 'Editor', charter: 'You edit.', model: 'claude-sonnet-4-5' });
  return { db, agents, workspaces, repo, provider, bus, audit, org, units, intent, tasks, approvals, signals, slo, capital, brief, runtime, mode, orgs, controller, ws, chief, writer, editor, announced };
}
type S = Awaited<ReturnType<typeof setup>>;

async function enable(s: S, modeName: 'supervised' | 'autonomous' = 'autonomous', monthlyUsd = 50) {
  const st = await s.mode.setMode(s.ws.id, { mode: modeName, chiefOfStaffAgentId: s.chief.id, monthlyUsd, agentCap: 10 });
  const orgId = st.orgId!;
  // setMode enrols every agent of the workspace under the chief; give them titles.
  await s.org.updateMember(orgId, s.writer.id, { title: 'Writer' });
  await s.org.updateMember(orgId, s.editor.id, { title: 'Editor' });
  return orgId;
}

/** A finished run with a cost, started `hoursAgo` hours before `now`. */
async function seedRun(s: S, orgId: string, taskId: string, agentId: string, usd: number, hoursAgo = 1, now = new Date()) {
  const run = await s.tasks.startRun(orgId, { taskId, agentId, wakeReason: 'manual' });
  await s.tasks.endRun(run.id, { status: 'done', outcome: 'done', tokensIn: 1000, tokensOut: 200, usd });
  const at = new Date(now.getTime() - hoursAgo * 3_600_000).toISOString();
  await s.db.update(orgRuns).set({ startedAt: at, endedAt: at }).where(eq(orgRuns.id, run.id));
  return run;
}

/** Vision → objective (with a KR) → project → tasks, for the roll-up tests. */
async function intentFixture(s: S, orgId: string) {
  const { vision } = await s.intent.setVision(orgId, { title: 'A newsletter 5,000 people open', dueAt: iso(90) });
  await s.runtime.flushPlannings();
  const grow = await s.units.addGoal(orgId, { title: 'Grow the list', parentGoalId: vision.id, ownerAgentId: s.writer.id });
  const quality = await s.units.addGoal(orgId, { title: 'Keep quality', parentGoalId: vision.id, ownerAgentId: s.editor.id });
  const kr = await s.intent.setKeyResult(orgId, { title: 'Subscribers', objectiveId: grow.id, metric: 'subscribers', startValue: 0, targetValue: 1000, dueAt: iso(60), ownerAgentId: s.writer.id });
  const growProject = await s.org.addProject(orgId, { title: 'List growth', goalId: kr.id });
  const qualityProject = await s.org.addProject(orgId, { title: 'Editing', goalId: quality.id });
  return { vision, grow, quality, kr, growProject, qualityProject };
}

// ---- 1. task class and the cost roll-up ----

test('task class: set by the creator or derived by the one shared heuristic (classOf reads the stored column); costByGoal rolls spend up task → key result → objective → vision, by class and by agent, with unlinked spend apart', async () => {
  assert.deepEqual([...TASK_CLASSES], ['triage', 'research', 'synthesis', 'review', 'ops', 'general']);
  assert.equal(deriveTaskClass({ title: 'Research competitor pricing', brief: '{}' }), 'research');
  assert.equal(deriveTaskClass({ title: 'Deploy the newsletter sender', brief: '{}' }), 'ops');
  assert.equal(deriveTaskClass({ title: 'Anything', brief: JSON.stringify({ constraints: 'class: outreach' }) }), 'outreach');
  assert.equal(deriveTaskClass({ title: 'Do the thing', brief: '{}' }), 'general');
  const s = await setup();
  const orgId = await enable(s);
  const f = await intentFixture(s, orgId);
  const research = await s.tasks.create(orgId, { title: 'Find 20 newsletters to swap with', brief: { outcome: 'A list', done_when: 'Saved' }, projectId: f.growProject.id, assigneeAgentId: s.writer.id });
  assert.equal(research.class, 'research', 'derived at creation');
  const draft = await s.tasks.create(orgId, { title: 'Issue 12', brief: { outcome: 'A draft', done_when: 'Saved' }, projectId: f.growProject.id, assigneeAgentId: s.writer.id, class: 'synthesis' });
  assert.equal(draft.class, 'synthesis', 'set by the creator wins');
  await assert.rejects(s.tasks.create(orgId, { title: 'x', class: 'Not A Class!' }), /lowercase slug/);
  const check = await s.tasks.create(orgId, { title: 'Check facts in issue 12', projectId: f.qualityProject.id, assigneeAgentId: s.editor.id });
  assert.equal(check.class, 'review');
  const loose = await s.tasks.create(orgId, { title: 'Tidy the drive', assigneeAgentId: s.editor.id });
  assert.equal(classOf(research), 'research');
  assert.equal(classOf({ title: 'Check the sources', brief: '{}' }), 'review', 'bare objects still classify');
  const reclassified = await s.tasks.update(orgId, loose.id, { class: 'ops' });
  assert.equal(reclassified.class, 'ops');
  s.runtime.cancelWakesFor(orgId, s.writer.id); s.runtime.cancelWakesFor(orgId, s.editor.id);
  await seedRun(s, orgId, research.id, s.writer.id, 3);
  await seedRun(s, orgId, draft.id, s.writer.id, 5);
  await seedRun(s, orgId, check.id, s.editor.id, 2);
  await seedRun(s, orgId, loose.id, s.editor.id, 1);
  const c = await s.capital.costByGoal(orgId, { period: 'month' });
  assert.equal(c.totalUsd, 11); assert.equal(c.attributedUsd, 10); assert.equal(c.unlinkedUsd, 1);
  assert.equal(c.vision!.spentUsd, 10, 'the vision carries everything attributed');
  const grow = c.objectives.find((o) => o.goalId === f.grow.id)!;
  const quality = c.objectives.find((o) => o.goalId === f.quality.id)!;
  assert.equal(grow.spentUsd, 8, 'through the key result\'s project'); assert.equal(grow.runs, 2); assert.equal(grow.shareOfSpend, 0.8);
  assert.deepEqual(grow.byClass, { research: 3, synthesis: 5 });
  assert.equal(quality.spentUsd, 2); assert.deepEqual(quality.byClass, { review: 2 });
  assert.deepEqual(c.byClass, { research: 3, synthesis: 5, review: 2, ops: 1 });
  assert.deepEqual(c.byAgent.map((a) => [a.name, a.usd]), [['Writer', 8], ['Editor', 3]]);
  assert.equal(grow.envelopeSource, 'company'); assert.equal(grow.envelopeUsd, 50); assert.equal(grow.envelopePct, 0.16);
  assert.deepEqual(grow.keyResults, { total: 1, achieved: 0, measuredPct: 0 });
  // the API and the tool
  const viaApi = await s.controller.costs(s.ws.id, 'all');
  assert.equal(viaApi.period, 'all'); assert.equal(viaApi.totalUsd, 11);
  const chiefSession = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.chief.id, name: 'chief chat' });
  const text = await s.runtime.execute(chiefSession, 'org_costs', {});
  assert.match(text, /^Spend this month: \$11\.00 \(\$10\.00 attributed to objectives, \$1\.00 unlinked\) of a \$50\.00 company envelope\./);
  assert.match(text, /- Grow the list: \$8\.00 \(16% of the company \$50\.00 envelope\) for 0% of 1 key result\(s\) measured/);
  assert.match(text, /By class: synthesis \$5\.00, research \$3\.00, review \$2\.00, ops \$1\.00\./);
  const editorSession = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.editor.id, name: 'editor chat' });
  await assert.rejects(s.runtime.execute(editorSession, 'org_costs', {}), /chief of staff and unit leads/);
  // the spend tree and the pulse show USD by class too
  assert.deepEqual((await s.runtime.spendTree(orgId)).byClass, { research: 3, synthesis: 5, review: 2, ops: 1 });
  assert.deepEqual((await s.slo.compute(orgId)).spendByClassUsd, { research: 3, synthesis: 5, review: 2, ops: 1 });
  assert.match(await s.runtime.execute(chiefSession, 'org_pulse', {}), /spend by class \(7d\): synthesis \$5\.00, research \$3\.00/);
});

// ---- 2. the overspend flag ----

test('an objective whose share of its envelope exceeds its measured progress by more than capital.overspendMargin is flagged — in costByGoal, the org_costs text and the brief\'s "Cost per outcome" section; the margin is a tunable with a bound', async () => {
  assert.deepEqual([TUNABLES['capital.overspendMargin'].default, TUNABLES['capital.overspendMargin'].min, TUNABLES['capital.overspendMargin'].max], [0.2, 0, 1]);
  const s = await setup();
  const orgId = await enable(s);
  const f = await intentFixture(s, orgId);
  await s.org.setAllocation(orgId, { goalId: f.grow.id, monthlyUsd: 10, rationale: 'the first 1,000 subscribers' });
  await s.intent.checkIn(orgId, f.kr.id, { currentValue: 200, confidence: 0.8 }); // 20 % measured
  const t = await s.tasks.create(orgId, { title: 'Draft issue 12', projectId: f.growProject.id, assigneeAgentId: s.writer.id, class: 'synthesis' });
  s.runtime.cancelWakesFor(orgId, s.writer.id);
  await seedRun(s, orgId, t.id, s.writer.id, 4); // 40 % of its $10 allocation
  let grow = (await s.capital.costByGoal(orgId)).objectives.find((o) => o.goalId === f.grow.id)!;
  assert.equal(grow.envelopeSource, 'allocation'); assert.equal(grow.envelopePct, 0.4); assert.equal(grow.progress, 0.2);
  assert.deepEqual(grow.allocation, { monthlyUsd: 10, buys: 'the first 1,000 subscribers' });
  assert.equal(grow.overspend, false, '40 − 20 = 20 points is at the default margin, not over it');
  await s.org.setTunable(orgId, 'capital.overspendMargin', 0.1, { why: 'tight month' });
  grow = (await s.capital.costByGoal(orgId)).objectives.find((o) => o.goalId === f.grow.id)!;
  assert.equal(grow.overspend, true);
  await assert.rejects(s.org.setTunable(orgId, 'capital.overspendMargin', 2), /must stay within 0–1/);
  const chiefSession = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.chief.id, name: 'chief chat' });
  assert.match(await s.runtime.execute(chiefSession, 'org_costs', {}), /Grow the list: \$4\.00 \(40% of its \$10\.00 envelope\) for 20% of 1 key result\(s\) measured — buys: the first 1,000 subscribers ⚠ spend ahead of progress/);
  const b = await s.brief.compose(orgId, { deliver: false });
  assert.match(b.text, /## Cost per outcome\n- Grow the list: \$4\.00 \(40% of its \$10\.00 envelope\) for 20% of 1 key result\(s\) measured[^\n]*⚠ spend ahead of progress\n- Keep quality: \$0\.00/);
  assert.match(b.text, /\*\*Decision:\*\* 1 objective\(s\) consume their envelope faster than they deliver \(margin 10 points\)/);
  // all time vs this month: a run from last month counts only in `all`
  const old = await seedRun(s, orgId, t.id, s.writer.id, 7);
  await s.db.update(orgRuns).set({ startedAt: iso(-40), endedAt: iso(-40) }).where(eq(orgRuns.id, old.id));
  assert.equal((await s.capital.costByGoal(orgId, { period: 'month' })).totalUsd, 4);
  assert.equal((await s.capital.costByGoal(orgId, { period: 'all' })).totalUsd, 11);
});

// ---- 3. allocations by expected value ----

test('org_allocate_budget with objectiveId and buys writes an allocation row (autonomous: at once; supervised: on the card, whose summary names what it buys and which objectives a change affects); the planning prompt lists allocations per objective and asks the chief to allocate per objective', async () => {
  const memoRound: AiStreamEvent[] = [{ type: 'tool_call', id: 'm1', name: 'org_strategy_memo', input: { text: 'Grow: $20 buys 1,000 subscribers.' } }, { type: 'done' }];
  const s = await setup([memoRound, [{ type: 'done' }]]);
  const orgId = await enable(s);
  const f = await intentFixture(s, orgId);
  const t = await s.tasks.create(orgId, { title: 'Draft issue 12', projectId: f.growProject.id, assigneeAgentId: s.writer.id });
  s.runtime.cancelWakesFor(orgId, s.writer.id);
  const chiefSession = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.chief.id, name: 'chief chat' });
  const out = await s.runtime.execute(chiefSession, 'org_allocate_budget', { scope: 'agent', agent: 'Writer', monthlyUsd: 20, objectiveId: f.grow.id.slice(0, 8), buys: 'the first 1,000 subscribers', why: 'the list is the vision' });
  assert.match(out, /agent envelope of Writer set to \$20\.00\/month .* — funds \[[0-9a-f]{8}\] "Grow the list": the first 1,000 subscribers\. Audited/);
  const rows = await s.org.allocations(orgId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].goalId, f.grow.id); assert.equal(rows[0].monthlyUsd, 20); assert.equal(rows[0].rationale, 'the first 1,000 subscribers'); assert.equal(rows[0].scope, 'agent'); assert.equal(rows[0].refId, s.writer.id);
  assert.equal((await s.org.budget(orgId, 'agent', s.writer.id))!.monthlyUsd, 20);
  await assert.rejects(s.runtime.execute(chiefSession, 'org_allocate_budget', { scope: 'agent', agent: 'Writer', monthlyUsd: 25, objectiveId: f.kr.id, why: 'x' }), /is a key result; objectiveId names the objective/);
  assert.ok((await s.audit.list(orgId, { action: 'allocation_set' })).length === 1);
  // the CEO's API
  const viaApi = await s.controller.setAllocation(s.ws.id, { goalId: f.quality.id, monthlyUsd: 5, buys: 'two fact checks a week' });
  assert.equal(viaApi.rationale, 'two fact checks a week');
  assert.equal((await s.controller.allocations(s.ws.id)).length, 2);
  // the planning prompt: allocations per objective, what they buy, the ask (the vision's own session ran first; this one is manual)
  s.runtime.planningCooldownMs = 0;
  assert.equal(await s.runtime.runPlanning(orgId, { unitId: (await s.units.rootUnit(orgId)).id, trigger: 'manual', reasons: ['test'] }), 'ran');
  const prompt = String([...s.provider.requests.at(-1)!.messages].reverse().find((m) => m.role === 'user')!.content);
  assert.match(prompt, /## Allocations by objective\n\n- \[[0-9a-f]{8}\] Grow the list: \$20\.00\/month — buys: the first 1,000 subscribers/);
  assert.match(prompt, /- \[[0-9a-f]{8}\] Keep quality: \$5\.00\/month — buys: two fact checks a week/);
  assert.match(prompt, /Allocate the envelope per objective: each org_allocate_budget names the objectiveId it funds and, in buys, which key results that money buys/);
  assert.match(prompt, /what each envelope buys \(per objective\)/);
  assert.match(prompt, /## Preview\n\nStructural actions you take here .* applies after a 30-minute veto window/);
  // supervised: the card carries objective, buys and the affected objectives; approving writes the allocation
  await s.mode.setMode(s.ws.id, { mode: 'supervised' });
  const card = await s.runtime.execute(chiefSession, 'org_allocate_budget', { scope: 'agent', agent: 'Writer', monthlyUsd: 30, objectiveId: f.grow.id, buys: 'swaps with 20 newsletters', why: 'growth' });
  assert.match(card, /Budget raise proposed \(approval [0-9a-f]{8}\): agent \$20\.00 → \$30\.00\/month — funds \[[0-9a-f]{8}\] "Grow the list": swaps with 20 newsletters; objectives affected: Grow the list\./);
  const a = (await s.approvals.pending(orgId)).find((x) => x.kind === 'budget_raise')!;
  const payload = JSON.parse(a.payload) as Record<string, unknown>;
  assert.equal(summarize('budget_raise', payload), 'agent cap → $30.00/month — affects: Grow the list — buys: swaps with 20 newsletters');
  assert.equal(summarize('budget_raise', { scope: 'company', monthlyUsd: 25 }), 'company cap → $25.00/month', 'the old shape is unchanged');
  assert.deepEqual(await s.capital.affectedObjectives(orgId, 'project', f.growProject.id), ['Grow the list'], 'a project envelope affects its goal chain');
  void t;
  await s.approvals.decide(orgId, a.id, 'approve', '', 'user');
  assert.equal((await s.org.allocations(orgId)).find((x) => x.goalId === f.grow.id)!.monthlyUsd, 30);
  assert.equal((await s.org.allocations(orgId)).find((x) => x.goalId === f.grow.id)!.rationale, 'swaps with 20 newsletters');
});

// ---- 4. model routing by task class ----

test('routing: the run picks its model from the task class through the org\'s routing when the agent has no model pinned by the CEO; the pin wins; tiers resolve through cheapestModelFor / the strong table / a pinned tier model; the API reads and writes it', async () => {
  assert.deepEqual(parseRouting('not json'), { classes: {}, models: {} });
  assert.deepEqual(parseRouting('{"classes":{"research":"cheap","Bad Class":"strong","review":"nope"},"models":{"strong":"my-strong","x":"y"}}'), { classes: { research: 'cheap' }, models: { strong: 'my-strong' } });
  const r = mergeRouting({ classes: {}, models: {} }, { classes: { research: 'cheap', review: 'strong' }, models: { cheap: 'tiny-1' } });
  assert.equal(tierModel(r, 'cheap', 'anthropic', 'default-model'), 'tiny-1', 'a pinned tier model wins');
  assert.equal(tierModel({ classes: {}, models: {} }, 'cheap', 'anthropic', 'default-model'), 'claude-haiku-5-5', 'cheap = cheapestModelFor');
  assert.equal(tierModel({ classes: {}, models: {} }, 'strong', 'anthropic', 'default-model'), 'claude-opus-4-5');
  assert.equal(tierModel({ classes: {}, models: {} }, 'standard', 'anthropic', 'default-model'), 'default-model');
  assert.equal(tierModel({ classes: {}, models: {} }, 'strong', 'unknown-provider', 'default-model'), 'default-model');
  assert.equal(resolveRoute(r, 'synthesis', { provider: 'anthropic', model: '' }, 'd'), null, 'no entry → the session\'s own model');
  assert.throws(() => mergeRouting(r, { classes: { research: 'huge' } }), /tier for research must be one of cheap, standard, strong/);
  assert.deepEqual(mergeRouting(r, { classes: { research: null }, models: { cheap: null } }), { classes: { review: 'strong' }, models: {} });

  const s = await setup([[{ type: 'done' }], [{ type: 'done' }], [{ type: 'done' }]]);
  const orgId = await enable(s);
  const routing = await s.controller.setRouting(s.ws.id, { classes: { research: 'cheap', review: 'strong' }, why: 'research is volume work' });
  assert.deepEqual(routing, { classes: { research: 'cheap', review: 'strong' }, models: {} });
  assert.deepEqual(await s.controller.routing(s.ws.id), routing);
  const decision = JSON.parse((await s.audit.list(orgId, { action: 'routing_set' }))[0].payload);
  assert.equal(decision.decision, 'route research: agent model → cheap; review: agent model → strong'); assert.equal(decision.rationale, 'research is volume work');
  // Writer has no pin → research runs on the cheap tier
  const research = await s.tasks.create(orgId, { title: 'Research swaps', projectId: null, assigneeAgentId: s.writer.id, class: 'research' });
  s.runtime.cancelWakesFor(orgId, s.writer.id);
  assert.equal(await s.runtime.runTask(orgId, research.id, s.writer.id, 'manual'), 'ran');
  const sessions = await s.repo.listSessions(s.ws.id);
  assert.equal(sessions.find((x) => x.agentId === s.writer.id && x.name.endsWith('Research swaps'))!.model, 'claude-haiku-5-5', 'the per-task session carries the routed model');
  const start = JSON.parse((await s.audit.list(orgId, { action: 'run_start' }))[0].payload);
  assert.deepEqual([start.class, start.routed, start.model, start.pinned], ['research', 'cheap', 'claude-haiku-5-5', false]);
  // Editor's model is pinned by the CEO → the pin wins over the review route
  const review = await s.tasks.create(orgId, { title: 'Review issue 12', assigneeAgentId: s.editor.id, class: 'review' });
  s.runtime.cancelWakesFor(orgId, s.editor.id);
  assert.equal(await s.runtime.runTask(orgId, review.id, s.editor.id, 'manual'), 'ran');
  assert.equal((await s.repo.listSessions(s.ws.id)).find((x) => x.agentId === s.editor.id && x.name.endsWith('Review issue 12'))!.model ?? '', '', 'nothing routed onto the session: the agent\'s pin applies');
  const start2 = JSON.parse((await s.audit.list(orgId, { action: 'run_start' }))[0].payload);
  assert.deepEqual([start2.class, start2.routed, start2.model, start2.pinned], ['review', null, 'claude-sonnet-4-5', true]);
  // an unrouted class on an unpinned agent leaves the session model empty (the agent type's default)
  const general = await s.tasks.create(orgId, { title: 'Tidy up', assigneeAgentId: s.writer.id });
  s.runtime.cancelWakesFor(orgId, s.writer.id);
  assert.equal(await s.runtime.runTask(orgId, general.id, s.writer.id, 'manual'), 'ran');
  assert.equal((await s.repo.listSessions(s.ws.id)).find((x) => x.agentId === s.writer.id && x.name.endsWith('Tidy up'))!.model ?? '', '');
  await assert.rejects(s.controller.setRouting(s.ws.id, { classes: { research: 'enormous' } }), /tier for research must be one of/);
});

test('org_set_routing: autonomous applies at once (decision-shaped audit row, auto_routing, inbox line, #company); supervised creates a `routing` approval card whose approval applies it; a member has no such tool', async () => {
  const s = await setup();
  const orgId = await enable(s, 'supervised');
  const chiefSession = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.chief.id, name: 'chief chat' });
  await assert.rejects(s.runtime.execute(chiefSession, 'org_set_routing', { class: 'triage', tier: 'cheap' }), /why is required/);
  await assert.rejects(s.runtime.execute(chiefSession, 'org_set_routing', { class: 'triage', tier: 'medium', why: 'x' }), /tier must be one of cheap, standard, strong/);
  await assert.rejects(s.runtime.execute(chiefSession, 'org_set_routing', { class: 'Tri age', tier: 'cheap', why: 'x' }), /class must be a lowercase slug/);
  const proposed = await s.runtime.execute(chiefSession, 'org_set_routing', { class: 'triage', tier: 'cheap', why: 'sorting mail needs no frontier model' });
  assert.match(proposed, /Routing change proposed \(approval [0-9a-f]{8}\): triage → cheap\. The current routing stays/);
  assert.deepEqual((await s.org.routing(orgId)).classes, {}, 'nothing changes until approved');
  const card = (await s.approvals.pending(orgId)).find((a) => a.kind === 'routing')!;
  assert.equal(summarize('routing', JSON.parse(card.payload)), 'route triage → cheap');
  assert.match((await s.brief.compose(orgId, { deliver: false })).text, /1\. \[routing\] route triage → cheap — chief: sorting mail needs no frontier model/);
  await s.approvals.decide(orgId, card.id, 'approve', '', 'user');
  assert.deepEqual((await s.org.routing(orgId)).classes, { triage: 'cheap' });
  // autonomous
  await s.mode.setMode(s.ws.id, { mode: 'autonomous' });
  const out = await s.runtime.execute(chiefSession, 'org_set_routing', { class: 'review', tier: 'strong', why: 'reviews gate quality' });
  assert.match(out, /review tasks now run on the strong tier \(e\.g\. claude-opus-4-5; was the agent's own model\); a CEO pin on an agent's model still wins\. Routing: triage → cheap, review → strong\. Audited as a decision/);
  assert.deepEqual((await s.org.routing(orgId)).classes, { triage: 'cheap', review: 'strong' });
  const actions = (await s.audit.list(orgId, { limit: 50 })).map((r) => r.action);
  assert.ok(actions.includes('auto_routing') && actions.filter((a) => a === 'routing_set').length === 2);
  assert.match(s.announced.at(-1)!, /^Routing changed: review: agent model → strong — reviews gate quality/);
  assert.ok((await s.agents.listEvents(s.chief.id)).some((e) => /Autonomous routing: review/.test(e.title)));
  const writerSession = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.writer.id, name: 'writer chat' });
  await assert.rejects(s.runtime.execute(writerSession, 'org_set_routing', { class: 'review', tier: 'cheap', why: 'x' }), /chief-of-staff tool/);
  assert.ok(!(await s.runtime.specsFor(writerSession)).some((t) => t.name === 'org_set_routing'));
  assert.ok((await s.runtime.specsFor(chiefSession)).some((t) => t.name === 'org_set_routing'));
});

// ---- 5. forecasts ----

test('forecast: burn over the trailing window projects month-end spend per envelope with onTrack | warn | stop against the burn thresholds; the projection drives a burn_forecast signal (chief; critical → CEO) that resolves when it falls back; the brief gains the projection line; org_forecast reads it', async () => {
  const s = await setup();
  const orgId = await enable(s, 'autonomous', 50);
  const f = await intentFixture(s, orgId);
  await s.org.setAllocation(orgId, { goalId: f.grow.id, monthlyUsd: 10, rationale: 'subscribers' });
  await s.org.setBudget(orgId, { scope: 'agent', refId: s.writer.id, monthlyUsd: 20 });
  const t = await s.tasks.create(orgId, { title: 'Draft', projectId: f.growProject.id, assigneeAgentId: s.writer.id, class: 'synthesis' });
  s.runtime.cancelWakesFor(orgId, s.writer.id);
  // mid-month, 10 days in, 20 days left; window 7 days.
  const now = new Date(Date.UTC(2026, 10, 10, 12, 0, 0));
  await seedRun(s, orgId, t.id, s.writer.id, 7, 24, now);  // yesterday: $7 → $1/day over 7 days
  const f1 = await s.capital.forecast(orgId, now);
  assert.deepEqual([f1.month, f1.day, f1.daysInMonth, f1.windowDays, f1.warnPct, f1.criticalPct], ['2026-11', 10, 30, 7, 100, 120]);
  assert.deepEqual([f1.company.spentUsd, f1.company.dailyBurnUsd, f1.company.projectedUsd, f1.company.projectedPct, f1.company.state], [7, 1, 27, 54, 'onTrack']);
  const writer = f1.agents.find((a) => a.refId === s.writer.id)!;
  assert.deepEqual([writer.capUsd, writer.projectedUsd, writer.projectedPct, writer.state], [20, 27, 135, 'stop'], 'the agent envelope is the one in trouble');
  const grow = f1.objectives.find((o) => o.refId === f.grow.id)!;
  assert.deepEqual([grow.capUsd, grow.projectedUsd, grow.state], [10, 27, 'stop'], 'the objective\'s allocation projects past');
  assert.equal(f1.agents.find((a) => a.refId === s.editor.id)!.state, 'onTrack', 'no cap, no spend: on track');
  assert.equal((await s.capital.sweepForecast(orgId, now)).company.state, 'onTrack');
  assert.equal((await s.signals.list(orgId, { kind: 'burn_forecast' })).length, 0, 'the company projection is inside the envelope: no signal');
  // warn: $44 spent in the window → $44 + (44/7)·20 ≈ $169 → stop; make it warn with a shorter window and a later day
  await s.org.setTunable(orgId, 'capital.forecastWindowDays', 1, { why: 'test' });
  const late = new Date(Date.UTC(2026, 10, 28, 12, 0, 0)); // 2 days left
  await seedRun(s, orgId, t.id, s.writer.id, 45, 6, late);   // today: $45 → burn 45/day… but only 2 days left: 52 + 90 = too much
  const f2 = await s.capital.forecast(orgId, late);
  assert.equal(f2.company.spentUsd, 52);
  assert.equal(f2.company.state, 'stop', `${f2.company.projectedPct}%`);
  const swept = await s.capital.sweepForecast(orgId, late);
  assert.equal(swept.company.state, 'stop');
  const sig = (await s.signals.list(orgId, { kind: 'burn_forecast' })).filter((x) => x.status !== 'resolved');
  assert.equal(sig.length, 1);
  assert.equal(sig[0].severity, 'critical'); assert.equal(sig[0].addresseeKind, 'ceo'); assert.equal(sig[0].refId, `${orgId}:2026-11`);
  assert.match(sig[0].title, /^Forecast: \$[\d.]+ by month-end against a \$50\.00 envelope \(\d+%\)/);
  assert.match(sig[0].detail, /route classes to cheaper tiers \(org_set_routing\)/);
  assert.ok((await s.agents.listEvents(s.chief.id)).some((e) => e.kind === 'org_signal' && /Forecast/.test(e.title)), 'pushed to the CEO through the chief\'s inbox');
  // the brief's Spend section carries the projection line
  const b = await s.brief.compose(orgId, { deliver: false, now: late });
  assert.match(b.text, /## Spend\n[\s\S]*- Projection: \$[\d.]+ by month-end at \$[\d.]+\/day \(trailing 1d\) — \d+% of the envelope, ■ projected to stop\./);
  assert.match(b.text, / {2}- ■ agent Writer: \$[\d.]+ projected of \$20\.00/);
  // the tool
  const chiefSession = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.chief.id, name: 'chief chat' });
  assert.match(await s.runtime.execute(chiefSession, 'org_forecast', {}), /^Forecast for \d{4}-\d{2} \(day \d+ of \d+; trailing 1-day burn; warn ≥ 100%, stop ≥ 120%\)\.\nCompany — /);
  // the projection falls back (runs gone) → the signal resolves itself
  await s.db.delete(orgRuns).where(eq(orgRuns.orgId, orgId));
  await s.capital.sweepForecast(orgId, late);
  assert.equal((await s.signals.list(orgId, { kind: 'burn_forecast' }))[0].status, 'resolved');
  // the ordinary signal sweep does not touch burn_forecast rows (it is not one of its kinds)
  await s.signals.sweep(orgId, late);
  assert.equal((await s.signals.list(orgId, { kind: 'burn_forecast' })).length, 1);
  const viaApi = await s.controller.forecast(s.ws.id);
  assert.equal(viaApi.company.capUsd, 50);
});

// ---- 6. plan preview with a veto window ----

const hireRound: AiStreamEvent[] = [{ type: 'tool_call', id: 'h1', name: 'org_hire_agent', input: { templateOrPack: 'Analyst', title: 'Numbers', charter: 'You count.', monthlyBudgetUsd: 5, why: 'nobody measures' } }, { type: 'done' }];
const tuneRound: AiStreamEvent[] = [{ type: 'tool_call', id: 't1', name: 'org_tune', input: { key: 'intent.paceTolerance', value: 0.3, why: 'research moves slowly' } }, { type: 'done' }];
const assignRound: AiStreamEvent[] = [{ type: 'tool_call', id: 'a1', name: 'org_assign', input: { taskId: '', agent: 'Writer' } }, { type: 'done' }];
const answer: AiStreamEvent[] = [{ type: 'answer', text: 'Done.' }, { type: 'done' }];

test('autonomous chief review: structural actions are collected into a pending plan (nothing hired, nothing tuned), the CEO gets one event "Plan ready: N actions, est. $X, applies at HH:MM unless you veto"; non-structural actions apply at once; on applyAt the actions apply in order through the tool paths, audited; supervised mode is unchanged (approval cards)', async () => {
  const s = await setup([hireRound, tuneRound, assignRound, answer]);
  const orgId = await enable(s);
  const backlog = await s.tasks.create(orgId, { title: 'Unowned work' });
  s.provider['rounds'][2] = [{ type: 'tool_call', id: 'a1', name: 'org_assign', input: { taskId: backlog.id.slice(0, 8), agent: 'Writer' } }, { type: 'done' }];
  const membersBefore = await s.org.liveMemberCount(orgId);
  assert.equal(await s.runtime.runChiefReview(orgId, ['board: test'], 'manual'), 'ran');
  s.runtime.cancelWakesFor(orgId, s.writer.id);
  const plans = await s.capital.plans(orgId);
  assert.equal(plans.length, 1);
  const plan = plans[0];
  assert.equal(plan.status, 'pending'); assert.equal(plan.trigger, 'manual'); assert.equal(plan.vetoWindowMinutes, 30); assert.equal(plan.estimateUsd, 5);
  const actions = parseActions(plan.actions);
  assert.deepEqual(actions.map((a) => a.tool), ['org_hire_agent', 'org_tune']);
  assert.match(actions[0].summary, /^Analyst as Numbers, reporting to Chief, \$5\.00\/month — nobody measures$/);
  assert.equal(actions[1].input.key, 'intent.paceTolerance');
  assert.match(plan.summary, /^hire: Analyst as Numbers.*; tune: tune intent\.paceTolerance 0\.15 → 0\.3 — research moves slowly$/);
  assert.ok(plan.applyAt && Date.parse(plan.applyAt) - Date.parse(plan.createdAt) === 30 * 60_000);
  assert.equal(await s.org.liveMemberCount(orgId), membersBefore, 'nothing hired yet');
  assert.equal(tunable(await s.org.get(orgId), 'intent.paceTolerance'), 0.15, 'nothing tuned yet');
  assert.equal((await s.tasks.get(orgId, backlog.id)).assigneeAgentId, s.writer.id, 'the assignment applied at once');
  // the tool results told the model
  const toolResults = s.provider.requests.flatMap((r) => r.messages.filter((m) => m.role === 'tool').map((m) => String(m.content)));
  assert.ok(toolResults.some((t) => /^Recorded for the plan preview \(not yet applied\): Analyst as Numbers/.test(t)));
  assert.match(String(s.provider.requests[0].messages.find((m) => m.role === 'user')!.content), /collected into one plan the CEO sees as a diff with a cost estimate; it applies after a 30-minute veto window/);
  assert.match(s.provider.requests[0].system, /Preview: structural actions in this review are collected into a plan/);
  // the CEO's event
  const ev = (await s.agents.listEvents(s.chief.id)).find((e) => e.kind === 'org_plan')!;
  assert.match(ev.title, /^Plan ready: 2 action\(s\), est\. \$5\.00, applies at \d{2}:\d{2} unless you veto$/);
  assert.match(ev.body, /veto: POST …\/org\/plans\/.*\/veto/i);
  assert.equal(JSON.parse(ev.payload).planId, plan.id);
  const audited = (await s.audit.list(orgId, { action: 'plan_created' }))[0];
  assert.equal(JSON.parse(audited.payload).actions, 2);
  assert.equal(JSON.parse((await s.audit.list(orgId, { action: 'chief_review_end' }))[0].payload).planId, plan.id);
  // the window has not closed: the tick applies nothing
  assert.equal(await s.capital.applyDue(orgId, new Date()), 0);
  assert.equal((await s.capital.plan(orgId, plan.id)).status, 'pending');
  // the window closes: applied in order through the same paths, each audited
  await s.db.update(orgPlans).set({ applyAt: iso(-1 / 24) }).where(eq(orgPlans.id, plan.id));
  assert.equal(await s.capital.applyDue(orgId, new Date()), 1);
  const applied = await s.controller.planGet(s.ws.id, plan.id);
  assert.equal(applied.status, 'applied'); assert.equal(applied.decidedBy, 'system'); assert.ok(applied.appliedAt);
  const result = JSON.parse(applied.result) as Array<{ tool: string; ok: boolean; output: string }>;
  assert.deepEqual(result.map((r) => [r.tool, r.ok]), [['org_hire_agent', true], ['org_tune', true]]);
  assert.match(result[0].output, /^Hired Analyst \(Numbers\) at depth 2/);
  assert.equal(await s.org.liveMemberCount(orgId), membersBefore + 1);
  assert.equal(tunable(await s.org.get(orgId), 'intent.paceTolerance'), 0.3);
  const acts = (await s.audit.list(orgId, { limit: 100 })).map((r) => r.action);
  assert.equal(acts.filter((a) => a === 'plan_action_applied').length, 2);
  assert.ok(acts.includes('plan_applied') && acts.includes('auto_hire') && acts.includes('tunable_set'));
  assert.ok((await s.agents.listEvents(s.chief.id)).some((e) => e.kind === 'org_plan' && /^Plan applied: 2 of 2 action\(s\)$/.test(e.title)));
  assert.ok(s.announced.some((a) => /^Hired: Analyst as Numbers/.test(a)));
  assert.equal((await s.audit.verify(orgId)).ok, true);
  assert.equal((await s.controller.plans(s.ws.id, 'pending')).length, 0);
  assert.equal((await s.controller.plans(s.ws.id)).length, 1);
  // supervised mode: no plan, an approval card as before
  const s2 = await setup([hireRound, answer]);
  const orgId2 = await enable(s2, 'supervised');
  await s2.runtime.runPlanning(orgId2, { unitId: (await s2.units.rootUnit(orgId2)).id, trigger: 'manual', reasons: ['test'] });
  assert.equal((await s2.capital.plans(orgId2)).length, 0);
  assert.equal((await s2.approvals.pending(orgId2)).filter((a) => a.kind === 'hire').length, 1);
});

test('the CEO vetoes: the plan is vetoed, nothing applies on the tick, apply-now is refused; apply-now on a pending plan applies it at once; a plan is expired, not applied, when the company is paused at apply time', async () => {
  const s = await setup([hireRound, answer, hireRound, answer, hireRound, answer]);
  const orgId = await enable(s);
  const before = await s.org.liveMemberCount(orgId);
  await s.runtime.runChiefReview(orgId, ['test'], 'manual');
  const [p1] = await s.capital.plans(orgId);
  const vetoed = await s.controller.vetoPlan(s.ws.id, p1.id, { note: 'no new seats this month' });
  assert.equal(vetoed.status, 'vetoed'); assert.equal(vetoed.decidedBy, 'user');
  await s.db.update(orgPlans).set({ applyAt: iso(-1 / 24) }).where(eq(orgPlans.id, p1.id));
  assert.equal(await s.capital.applyDue(orgId, new Date()), 0);
  assert.equal(await s.org.liveMemberCount(orgId), before, 'a vetoed plan never applies');
  await assert.rejects(s.controller.applyPlan(s.ws.id, p1.id), /plan is vetoed/);
  await assert.rejects(s.controller.vetoPlan(s.ws.id, p1.id, {}), /plan is vetoed/);
  assert.equal(JSON.parse((await s.audit.list(orgId, { action: 'plan_vetoed' }))[0].payload).note, 'no new seats this month');
  assert.ok((await s.agents.listEvents(s.chief.id)).some((e) => /^CEO vetoed the plan \(1 action\(s\)\)$/.test(e.title)));
  // apply-now
  s.runtime.reviewCooldownMs = 0;
  await s.runtime.runChiefReview(orgId, ['test 2'], 'manual');
  const p2 = (await s.capital.plans(orgId, { status: 'pending' }))[0];
  const applied = await s.controller.applyPlan(s.ws.id, p2.id);
  assert.equal(applied.status, 'applied'); assert.equal(applied.decidedBy, 'user');
  assert.equal(await s.org.liveMemberCount(orgId), before + 1);
  // paused at apply time → expired
  await s.runtime.runChiefReview(orgId, ['test 3'], 'manual');
  const p3 = (await s.capital.plans(orgId, { status: 'pending' }))[0];
  await s.runtime.pause(orgId);
  await s.db.update(orgPlans).set({ applyAt: iso(-1 / 24) }).where(eq(orgPlans.id, p3.id));
  await s.capital.applyDue(orgId, new Date());
  assert.equal((await s.capital.plan(orgId, p3.id)).status, 'expired');
  assert.equal(await s.org.liveMemberCount(orgId), before + 1);
});

test('capital.vetoWindowMinutes = 0 applies the plan at once (bounds 0–1440); at apply time the actions still go through the caps — the first refusal stops the rest, and the plan records where it stopped', async () => {
  assert.deepEqual([TUNABLES['capital.vetoWindowMinutes'].default, TUNABLES['capital.vetoWindowMinutes'].min, TUNABLES['capital.vetoWindowMinutes'].max], [30, 0, 1_440]);
  const s = await setup([hireRound, tuneRound, answer, hireRound, tuneRound, answer]);
  const orgId = await enable(s);
  await assert.rejects(s.org.setTunable(orgId, 'capital.vetoWindowMinutes', 2_000), /must stay within 0–1440/);
  await s.org.setTunable(orgId, 'capital.vetoWindowMinutes', 0, { why: 'the CEO trusts the chief' });
  const before = await s.org.liveMemberCount(orgId);
  await s.runtime.runChiefReview(orgId, ['test'], 'manual');
  const [p1] = await s.capital.plans(orgId);
  assert.equal(p1.status, 'applied'); assert.equal(p1.vetoWindowMinutes, 0); assert.equal(p1.decidedBy, 'system');
  assert.equal(await s.org.liveMemberCount(orgId), before + 1);
  assert.equal(tunable(await s.org.get(orgId), 'intent.paceTolerance'), 0.3);
  assert.match((await s.agents.listEvents(s.chief.id)).find((e) => e.kind === 'org_plan' && /^Plan applied: 2 action/.test(e.title))!.title, /veto window is 0/);
  assert.match(String(s.provider.requests[0].messages.find((m) => m.role === 'user')!.content), /it applies at once/);
  // stop at first refusal: the agent cap shrinks between planning and applying
  await s.org.setTunable(orgId, 'capital.vetoWindowMinutes', 30, { why: 'back to the default' });
  s.runtime.reviewCooldownMs = 0;
  await s.runtime.runChiefReview(orgId, ['test 2'], 'manual');
  const p2 = (await s.capital.plans(orgId, { status: 'pending' }))[0];
  assert.equal(parseActions(p2.actions).length, 2);
  await s.mode.setMode(s.ws.id, { mode: 'autonomous', agentCap: before + 1 });
  const members = await s.org.liveMemberCount(orgId);
  const applied = await s.controller.applyPlan(s.ws.id, p2.id);
  assert.equal(applied.status, 'applied');
  const result = JSON.parse(applied.result) as Array<{ tool: string; ok: boolean; output: string }>;
  assert.equal(result.length, 1, 'stopped after the refusal: the tune never ran');
  assert.deepEqual([result[0].tool, result[0].ok], ['org_hire_agent', false]);
  assert.match(result[0].output, /refused: the company already has \d+ member\(s\), the agent cap is \d+/);
  assert.equal(await s.org.liveMemberCount(orgId), members);
  assert.equal(JSON.parse((await s.audit.list(orgId, { action: 'plan_applied' }))[0].payload).stoppedAt, 'org_hire_agent');
  assert.equal((await s.audit.list(orgId, { action: 'plan_action_refused' })).length, 1);
  assert.match((await s.agents.listEvents(s.chief.id)).find((e) => e.kind === 'org_plan' && /stopped at org_hire_agent/.test(e.title))!.title, /^Plan applied: 0 of 2 action\(s\) — stopped at org_hire_agent$/);
  // a window change is a decision row like any tunable
  assert.equal(JSON.parse((await s.audit.list(orgId, { action: 'tunable_set' })).find((r) => r.payload.includes('capital.vetoWindowMinutes'))!.payload).decision, 'set capital.vetoWindowMinutes 0 → 30');
});

test('dry run: POST …/org/plan/dry-run runs a planning turn in which every mutating call is recorded and nothing is applied — no goal, no hire, no memo — the hypothetical envelope is injected as such, and the row comes back as dry_run; a unit lead cannot dry-run', async () => {
  const goalRound: AiStreamEvent[] = [{ type: 'tool_call', id: 'g1', name: 'org_set_goal', input: { title: 'Launch a paid tier' } }, { type: 'done' }];
  const boardRound: AiStreamEvent[] = [{ type: 'tool_call', id: 'b1', name: 'org_read_board', input: {} }, { type: 'done' }];
  const memoRound: AiStreamEvent[] = [{ type: 'tool_call', id: 'm1', name: 'org_strategy_memo', input: { text: 'With $100 I would hire an analyst.' } }, { type: 'done' }];
  const s = await setup([goalRound, boardRound, hireRound, memoRound, answer]);
  const orgId = await enable(s, 'supervised');
  const goalsBefore = (await s.org.goals(orgId)).length;
  const membersBefore = await s.org.liveMemberCount(orgId);
  const { result, plan } = await s.controller.dryRun(s.ws.id, { prompt: 'What would you do with twice the budget?', assume: { monthlyUsd: 100 } });
  assert.equal(result, 'ran');
  assert.ok(plan);
  assert.equal(plan!.status, 'dry_run'); assert.equal(plan!.trigger, 'dry_run'); assert.equal(plan!.applyAt, null); assert.equal(plan!.estimateUsd, 5);
  const actions = parseActions(plan!.actions);
  assert.deepEqual(actions.map((a) => a.tool), ['org_set_goal', 'org_hire_agent', 'org_strategy_memo'], 'reads pass through, every mutation is recorded');
  assert.equal(actions[0].summary, 'set goal (title="Launch a paid tier")');
  assert.equal((await s.org.goals(orgId)).length, goalsBefore, 'no goal created');
  assert.equal(await s.org.liveMemberCount(orgId), membersBefore, 'nobody hired');
  assert.equal((await s.approvals.pending(orgId)).length, 0, 'no approval card either');
  assert.equal((await s.org.get(orgId)).strategyMemo, '', 'no memo stored');
  const prompt = String(s.provider.requests[0].messages.find((m) => m.role === 'user')!.content);
  assert.match(prompt, /## Hypothetical \(dry run\)\n\nThis is a dry run the CEO asked for: nothing you call is applied/);
  assert.match(prompt, /Assume the company envelope were \$100\.00\/month \(it is actually \$50\.00\)\./);
  assert.match(prompt, /The CEO asks: What would you do with twice the budget\?/);
  assert.match(prompt, /## Envelope\n\nCompany: \$100\.00\/month/);
  assert.match(s.provider.requests[0].system, /DRY RUN: nothing you call is applied/);
  const toolResults = s.provider.requests.flatMap((r) => r.messages.filter((m) => m.role === 'tool').map((m) => String(m.content)));
  assert.ok(toolResults.some((t) => /^Recorded \(dry run, nothing applied\): set goal/.test(t)));
  assert.ok(toolResults.some((t) => /The board is empty|\[/.test(t)), 'the board read ran for real');
  const ev = (await s.agents.listEvents(s.chief.id)).find((e) => e.kind === 'org_plan')!;
  assert.match(ev.title, /^Dry run: 3 action\(s\) the chief would take, est\. \$5\.00 — nothing applied$/);
  const acts = (await s.audit.list(orgId, { limit: 50 })).map((r) => r.action);
  assert.ok(acts.includes('planning_dry_run_start') && acts.includes('planning_dry_run_end') && acts.includes('plan_dry_run') && acts.includes('spend_reserve'));
  assert.ok(!acts.includes('planning_start'), 'a dry run is not a planning session');
  assert.equal((await s.controller.plans(s.ws.id, 'dry_run')).length, 1);
  await assert.rejects(s.capital.veto(orgId, plan!.id), /plan is dry_run/);
  assert.equal((await s.capital.applyDue(orgId, new Date())), 0);
  // the session is its own, so the real planning session is untouched
  assert.ok((await s.repo.listSessions(s.ws.id)).some((x) => /· Dry run · /.test(x.name)));
});

// ---- 7. replay ----

test('replay composes a day from the audit chain, runs, signals, approvals and plans — ordered, with what it cost — and verifies that day\'s chain segment; a tampered row breaks it; another day is empty', async () => {
  const s = await setup([hireRound, answer]);
  const orgId = await enable(s, 'supervised');
  const t = await s.tasks.create(orgId, { title: 'Draft issue 12', assigneeAgentId: s.writer.id, class: 'synthesis' });
  s.runtime.cancelWakesFor(orgId, s.writer.id);
  await seedRun(s, orgId, t.id, s.writer.id, 2.5);
  await s.audit.append(orgId, { actor: `agent:${s.writer.id}`, action: 'run_start', refType: 'run', refId: 'r1', payload: { taskId: t.id, reason: 'manual', reviewer: false, model: 'claude-haiku-5-5' } });
  await s.audit.append(orgId, { actor: `agent:${s.writer.id}`, action: 'run_end', refType: 'run', refId: 'r1', payload: { taskId: t.id, status: 'done', outcome: 'progressed', usd: 2.5 } });
  const chiefSession = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.chief.id, name: 'chief chat' });
  await s.runtime.execute(chiefSession, 'org_hire_agent', { templateOrPack: 'Analyst', title: 'Numbers', charter: 'You count.', why: 'metrics' });
  const card = (await s.approvals.pending(orgId))[0];
  await s.approvals.decide(orgId, card.id, 'reject', 'not now', 'user');
  await s.org.setTunable(orgId, 'capital.vetoWindowMinutes', 10, { why: 'quick company' });
  await s.signals.open(orgId, { kind: 'stale_task', severity: 'warn', refType: 'task', refId: t.id, title: 'Stale', addressee: 'owner', addresseeId: s.writer.id });
  const today = new Date().toISOString().slice(0, 10);
  const r = await s.controller.replay(s.ws.id, today);
  assert.equal(r.day, today);
  assert.equal(r.chain.ok, true); assert.equal(r.chain.fromSeq, 1); assert.ok(r.chain.toSeq! >= r.chain.rows - 1);
  assert.deepEqual([r.totals.runs, r.totals.usd, r.totals.decisions, r.totals.signals], [1, 2.5, 2, 1]);
  const kinds = r.entries.map((e) => e.kind);
  assert.ok(kinds.includes('woke') && kinds.includes('ran') && kinds.includes('decided') && kinds.includes('signal') && kinds.includes('change'));
  const woke = r.entries.find((e) => e.kind === 'woke')!;
  assert.match(woke.title, /^Writer woke for "Draft issue 12" \(manual\) on claude-haiku-5-5$/);
  const ran = r.entries.find((e) => e.kind === 'ran')!;
  assert.equal(ran.usd, 2.5); assert.match(ran.title, /^Writer ended "Draft issue 12": progressed$/);
  assert.ok(r.entries.some((e) => e.kind === 'decided' && /^proposed \(hire\): Analyst as Numbers$/.test(e.title)));
  assert.ok(r.entries.some((e) => e.kind === 'decided' && /^rejected hire by .* — not now$/.test(e.title)));
  assert.ok(r.entries.some((e) => e.kind === 'decided' && /^set capital\.vetoWindowMinutes 30 → 10 — quick company \(user\)$/.test(e.title)));
  assert.ok(r.entries.some((e) => e.kind === 'signal' && /^signal stale_task \(warn\) → owner$/.test(e.title)));
  assert.ok(r.entries.some((e) => e.kind === 'change' && /^task create task Draft issue 12 \(user\)$/.test(e.title)));
  for (let i = 1; i < r.entries.length; i++) assert.ok(r.entries[i - 1].at <= r.entries[i].at, 'ordered by time');
  assert.equal(r.entries.filter((e) => e.seq !== null).length, r.entries.length, 'every entry points into the chain');
  // another day: empty, chain trivially fine
  const empty = await s.capital.replay(orgId, '2001-01-01');
  assert.equal(empty.entries.length, 0); assert.equal(empty.chain.rows, 0); assert.equal(empty.chain.ok, true);
  await assert.rejects(s.capital.replay(orgId, 'yesterday'), /day must be YYYY-MM-DD/);
  // tamper with a row of the day: the segment check names it
  const rows = await s.audit.list(orgId, { action: 'run_end' });
  await s.db.update(orgAudit).set({ payload: JSON.stringify({ taskId: t.id, status: 'done', outcome: 'progressed', usd: 0.01 }) }).where(eq(orgAudit.id, rows[0].id));
  const broken = await s.capital.replay(orgId, today);
  assert.equal(broken.chain.ok, false); assert.equal(broken.chain.brokenAt, rows[0].seq); assert.match(broken.chain.reason!, /row content does not match its hash/);
});

// ---- 8. the plan in the brief and the tools on offer ----

test('a pending plan shows in the brief with its veto route; org_costs / org_forecast are offered to leads and the chief, org_set_routing to the chief only; every capital threshold is a registered tunable with a bound', async () => {
  const s = await setup([hireRound, answer]);
  const orgId = await enable(s);
  await s.runtime.runChiefReview(orgId, ['test'], 'manual');
  const b = await s.brief.compose(orgId, { deliver: false });
  assert.match(b.text, /## Plans awaiting your veto\n- hire: Analyst as Numbers, reporting to Chief, \$5\.00\/month — nobody measures — est\. \$5\.00, applies \d{2}:\d{2} UTC \(POST …\/org\/plans\/[0-9a-f-]+\/veto to stop it\)/);
  const alpha = await s.agents.create({ name: 'Alpha' });
  await s.org.addMember(orgId, { agentId: alpha.id, reportsToAgentId: s.writer.id, scopes: [] });
  const writerSession = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.writer.id, name: 'writer chat' });
  const alphaSession = await s.repo.createSession({ workspaceId: s.ws.id, agentId: alpha.id, name: 'alpha chat' });
  const chiefSession = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.chief.id, name: 'chief chat' });
  const names = async (session: Awaited<ReturnType<typeof s.repo.createSession>>) => (await s.runtime.specsFor(session)).map((t) => t.name);
  const lead = await names(writerSession); const member = await names(alphaSession); const chief = await names(chiefSession);
  assert.ok(lead.includes('org_costs') && lead.includes('org_forecast') && !lead.includes('org_set_routing'));
  assert.ok(!member.includes('org_costs') && !member.includes('org_forecast'));
  assert.ok(chief.includes('org_costs') && chief.includes('org_forecast') && chief.includes('org_set_routing'));
  assert.match(await s.runtime.execute(writerSession, 'org_forecast', {}), /^Forecast for/);
  assert.match(await s.runtime.execute(writerSession, 'org_costs', {}), /^Spend this month/);
  assert.ok(s.runtime.isReadOnly('org_costs') && s.runtime.isReadOnly('org_forecast') && !s.runtime.isReadOnly('org_set_routing'));
  for (const k of ['capital.overspendMargin', 'capital.vetoWindowMinutes', 'capital.forecastWindowDays']) { assert.equal(TUNABLES[k].area, 'capital'); assert.ok(TUNABLES[k].min <= TUNABLES[k].default && TUNABLES[k].default <= TUNABLES[k].max); }
  assert.ok((await s.controller.tunables(s.ws.id)).some((t) => t.key === 'capital.vetoWindowMinutes' && t.value === 30));
});
