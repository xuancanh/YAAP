/** Multi-session task execution (docs/task-execution.md): a task's own plan
 *  (the process engine's model with one stage) runs in one session, as a
 *  chain of sessions joined by handoff packets, or orchestrated by a master
 *  that runs parallel-safe steps in worker sessions side by side, checks
 *  each against its exit criteria and integrates. Effort scaling keeps
 *  small tasks from fanning out; caps on sessions, parallel workers, depth
 *  and attempts bind; idle rounds block the plan; a restart leaves workers
 *  interrupted and the next round resumes them in their own sessions. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { setup, enable, sessionOf, call, say, lastUser, type S } from './org-governance-harness';
import type { AiRequest } from '../server/src/ai/ai-provider.interface';
import { TaskPlanService, resolveStepModel } from '../server/src/org/task-plan.service';
import { TaskPlanTools, TASK_PLAN_TOOLS } from '../server/src/org/task-plan.tools';
import { checkExit, cycleOf, diffPlan, effortRefusal, handoffSignature, normalizeHandoff, normalizePlan, readySteps, suggestMode, validatePlan } from '../server/src/org/task-plan-model';
import { EXEC_TUNABLES, deriveExecTunables, execTunables } from '../server/src/org/task-exec-tunables';
import { deriveOperatingSystem } from '../server/src/org/chief-os';
import { classOf, runsFreely } from '../server/src/actions/action-classes';
import { organizations, taskPlanSessions, taskPlanSteps } from '../server/src/database/schema';

function wire(s: S) {
  const plans = new TaskPlanService(s.db, s.repo, s.agents, s.org, s.tasks, s.turns, s.runtime);
  const tools = new TaskPlanTools(plans, s.runtime, s.turns);
  return { plans, tools };
}

const T = { splitBriefChars: 2_500, splitCriteria: 4, splitSteps: 4, handoffAt: 0.7, orchestrateMinSignals: 2 };
const workerStep = (req: AiRequest): string | null => /# Worker session: step "[^"]*" \(([a-z0-9_-]+)\)/.exec(req.system ?? '')?.[1] ?? null;
const LONG = `Research three markets and write the comparison. ${'Context. '.repeat(400)}`;
const fourSteps = [
  { id: 'r1', title: 'Market one', goal: 'Size market one', exit: ['size with a source'], parallel: true, tier: 'cheap' },
  { id: 'r2', title: 'Market two', goal: 'Size market two', exit: ['size with a source'], parallel: true },
  { id: 'r3', title: 'Market three', goal: 'Size market three', exit: ['size with a source'], parallel: true },
  { id: 'w', title: 'Write the comparison', goal: 'Compare', exit: ['comparison written', 'sources cited'], dependsOn: ['r1', 'r2', 'r3'] },
];
const drain = async (s: S, sessionId: string, text: string) => { for await (const ev of s.turns.run(sessionId, { text })) void ev; };
const report = (id: string, n = 1) => call('task_step_result', { output: `out-${id}`, criteria: Array.from({ length: n }, () => ({ met: true, evidence: `evidence for ${id}` })), decisions: id === 'w' ? ['use USD'] : [] });

// ---- the pure model ----

test('model: the plan is the engine\'s graph — validation with remediation, cycles refused, readiness strict and dynamic, diffs, exit checks, handoff signatures', () => {
  const bad = normalizePlan({ mode: 'orchestrated', steps: [{ id: 'a', title: 'A', exit: ['x'], dependsOn: ['b'] }, { id: 'b', title: 'B', exit: ['y'], dependsOn: ['a'] }, { id: 'c', title: 'C', dependsOn: ['zz'] }] });
  const problems = validatePlan(bad, { maxSteps: 12 });
  assert.ok(problems.some((p) => /cycle/.test(p.problem)), 'a dependency cycle is refused');
  assert.ok(problems.some((p) => /no exit criteria/.test(p.problem) && /exit:/.test(p.fix)));
  assert.ok(problems.some((p) => /"zz", which is not a step/.test(p.problem)));
  assert.deepEqual(cycleOf(bad), ['a', 'b', 'a']);
  const def = normalizePlan({ mode: 'orchestrated', steps: fourSteps });
  assert.deepEqual(validatePlan(def, { maxSteps: 12 }), []);
  assert.equal(def.steps[0].tier, 'cheap');
  assert.deepEqual(readySteps(def, new Map()), ['r1', 'r2', 'r3']);
  assert.deepEqual(readySteps(def, new Map([['r1', 'done'], ['r2', 'running'], ['r3', 'done']])), [], 'w waits for r2');
  assert.deepEqual(readySteps(def, new Map([['r1', 'done'], ['r2', 'skipped'], ['r3', 'done']])), ['w'], 'a skipped input does not block');
  assert.deepEqual(readySteps(def, new Map([['r1', 'failed'], ['r2', 'done'], ['r3', 'done']])), ['r1'], 'a failed step is ready again');
  const dyn = normalizePlan({ mode: 'orchestrated', dynamic: true, steps: fourSteps });
  assert.deepEqual(readySteps(dyn, new Map([['r1', 'done'], ['r2', 'done'], ['r3', 'done']])), ['w']);
  assert.ok(diffPlan(def, normalizePlan({ steps: [...fourSteps, { id: 'x', title: 'Extra', exit: ['e'] }] }, def)).some((l) => /\+ step x/.test(l)));
  assert.deepEqual(checkExit(['a', 'b'], [{ met: true, evidence: 'here' }, { met: false, evidence: '' }]).gaps, ['"b"']);
  assert.deepEqual(checkExit(['a'], [{ met: true, evidence: '' }]).gaps, ['"a" (no evidence)'], '"met" without evidence is not done');
  const p1 = normalizeHandoff({ state: 'Drafted 3 sections', next: 'Write section 4' });
  assert.equal(handoffSignature(p1), handoffSignature(normalizeHandoff({ state: 'drafted  3 sections', next: 'write section 4' })));
});

test('effort scaling: a small task does not fan out; size signals suggest the mode; the tunables are derived within bounds and registered', () => {
  const small = { briefChars: 200, criteria: 1, noProgress: 0, contextPressure: 0, steps: 0 };
  assert.equal(suggestMode(small, T).mode, 'single');
  assert.equal(suggestMode({ ...small, contextPressure: 0.8 }, T).mode, 'sequential', 'a full context suggests a fresh session');
  assert.equal(suggestMode({ ...small, briefChars: 4_000, criteria: 5 }, T).mode, 'orchestrated');
  const orch = normalizePlan({ mode: 'orchestrated', steps: fourSteps });
  assert.match(effortRefusal(orch, small, T)!, /too small to fan out/);
  assert.equal(effortRefusal(orch, { ...small, briefChars: 3_000 }, T), null, 'a long brief and four steps are two signals');
  assert.match(effortRefusal(normalizePlan({ mode: 'single', steps: fourSteps }), small, T)!, /4 steps for a small task/);
  for (const t of deriveExecTunables({ stage: 'early', cultureType: 'hierarchy', speed: false, rigor: true })) { const d = EXEC_TUNABLES[t.key]; assert.ok(t.value >= d.min && t.value <= d.max, t.key); }
  const fast = deriveOperatingSystem({ values: 'Experiment boldly, move fast', culture: 'iterate and explore' });
  for (const k of Object.keys(EXEC_TUNABLES)) assert.ok(fast.tunables.some((t) => t.key === k), `onboarding derives ${k}`);
  assert.equal(execTunables(null)['exec.maxParallel'], 3, 'outside a company the defaults apply');
  for (const t of TASK_PLAN_TOOLS) { assert.equal(classOf(t.name), 'internal_write'); assert.ok(runsFreely(t.name), `${t.name} is free internal work`); }
  const bytes = JSON.stringify(TASK_PLAN_TOOLS).length;
  assert.ok(bytes < 3_600, `the four tools cost ${bytes} bytes`);
  assert.equal(resolveStepModel(undefined, { provider: 'anthropic', baseModel: 'm' }), '', 'no tier inherits');
  assert.equal(resolveStepModel('cheap', { provider: 'anthropic', baseModel: 'm', pinned: 'pinned-model' }), 'pinned-model', 'the CEO pin wins');
  assert.ok(resolveStepModel('cheap', { provider: 'anthropic', baseModel: 'claude-sonnet-4-5' }));
});

// ---- orchestrated in a private chat ----

test('orchestrated in a chat: the master splits, three parallel workers research with clean contexts, the writer step gets their outputs and the decisions, the master integrates', async () => {
  let active = 0; let peak = 0;
  const s = await setup((req, round) => {
    const step = workerStep(req);
    if (step) {
      if (round === 0) { active++; peak = Math.max(peak, active); return report(step, step === 'w' ? 2 : 1); }
      active--;
      return say(`finished ${step}`);
    }
    if (round === 0) return call('task_plan', { mode: 'orchestrated', steps: fourSteps, reason: 'three independent markets', decide: ['Figures in USD'] });
    if (round === 1 || round === 2) return call('task_step_run', {});
    return say('Here is the comparison.');
  });
  const { plans } = wire(s);
  const chat = await sessionOf(s, s.writer.id);
  await drain(s, chat.id, LONG);
  const plan = (await plans.byScope(`chat:${chat.id}`))!;
  assert.equal(plan.mode, 'orchestrated');
  const steps = Object.fromEntries((await plans.steps(plan.id)).map((r) => [r.stepId, r]));
  for (const id of ['r1', 'r2', 'r3', 'w']) assert.equal(steps[id].status, 'done', `${id} done`);
  assert.equal(steps.w.output, 'out-w');
  const sessions = await plans.sessionRows(plan.id);
  const workers = sessions.filter((r) => r.role === 'worker');
  assert.equal(workers.length, 4, 'one worker session per step');
  assert.ok(workers.every((w) => w.parentSessionId === chat.id && w.depth === 1));
  assert.ok(workers.every((w) => w.tokensIn > 0 && w.usd > 0), 'cost per session');
  assert.ok(steps.r1.usd > 0 && steps.r1.tokensIn > 0, 'cost per step');
  assert.ok(peak >= 2, `parallel-safe steps ran side by side (peak ${peak})`);
  // the writer's worker saw only its card: the research outputs and the decision
  const wReq = s.provider.requests.find((r) => workerStep(r) === 'w')!;
  assert.match(wReq.system ?? '', /out-r1/);
  assert.match(wReq.system ?? '', /Figures in USD/);
  assert.equal(wReq.messages.filter((m) => m.role === 'user').length, 1, 'a clean context: one prompt, no chat history');
  assert.doesNotMatch(JSON.stringify(wReq.messages), /Context\. Context\./, 'the long request stays with the master');
  // the worker is offered only its tools; the plan is the master's
  const wSession = (await s.repo.getSession(workers[0].sessionId))!;
  const names = (await s.turns.offeredTools(wSession)).specs.map((t) => t.name);
  assert.ok(names.includes('task_step_result') && names.includes('task_handoff'));
  assert.ok(!names.includes('task_plan') && !names.includes('task_step_run'), 'workers cannot start workers at depth 1');
  assert.match((await plans.refusal(wSession, 'task_plan', {}))!, /belongs to the master/);
  // the parallel step's decision is proposed; the writer's adopted
  const view = await plans.view(plan);
  assert.ok(view.decisions.some((d) => d.text === 'use USD' && !d.proposed));
  assert.equal(view.versions.length, 1);
  assert.match(lastUser(s.provider.requests.at(-1)!), /Research three markets/);
});

test('effort scaling at the tool: a short request asking for parallel workers is refused with what to do instead', async () => {
  const s = await setup((req, round) => (round === 0 ? call('task_plan', { mode: 'orchestrated', steps: fourSteps }) : say('ok')));
  const { plans } = wire(s);
  const chat = await sessionOf(s, s.writer.id);
  const events: string[] = [];
  for await (const ev of s.turns.run(chat.id, { text: 'Compare three markets quickly.' })) if (ev.type === 'tool_result') events.push(ev.output);
  assert.match(events[0], /too small to fan out/);
  assert.match(events[0], /mode single|mode sequential/);
  assert.equal(await plans.byScope(`chat:${chat.id}`), null, 'no plan was created');
});

// ---- caps, breakers, restarts ----

test('caps: sessions per plan and the idle-round breaker bind; a failing step stops after its attempts', async () => {
  const s = await setup((req, round) => {
    const step = workerStep(req);
    if (step) return round === 0 && step !== 'r3' ? report(step) : say('I looked around.');
    if (round === 0) return call('task_plan', { mode: 'orchestrated', steps: fourSteps });
    return round < 4 ? call('task_step_run', {}) : say('stopping');
  });
  const orgId = await enable(s);
  await s.db.update(organizations).set({ tunables: JSON.stringify({ 'exec.maxSessions': 3, 'exec.idleRounds': 2 }) }).where(eq(organizations.id, orgId));
  const { plans } = wire(s);
  const chat = await sessionOf(s, s.writer.id);
  const outputs: string[] = [];
  for await (const ev of s.turns.run(chat.id, { text: LONG })) if (ev.type === 'tool_result') outputs.push(ev.output);
  const plan = (await plans.byScope(`chat:${chat.id}`))!;
  assert.equal(plan.orgId, null, 'a chat plan is not a company record');
  const steps = Object.fromEntries((await plans.steps(plan.id)).map((r) => [r.stepId, r]));
  assert.equal(steps.r1.status, 'done');
  assert.equal(steps.r2.status, 'done');
  assert.equal(steps.r3.status, 'failed', 'r3 never reported');
  assert.match(outputs[1], /r3: FAILED.*ended without task_step_result/s);
  // round 2: r3 again — the plan has used its 3 sessions
  assert.match(outputs[2], /exec\.maxSessions/);
  assert.equal((await plans.sessionRows(plan.id)).filter((r) => r.role === 'worker').length, 3, 'never more than the cap');
  assert.equal((await plans.get(plan.id))!.status, 'blocked', 'two idle rounds block the plan');
  assert.match(outputs[3], /the plan is blocked/i);
});

test('restart: a worker left running is interrupted at boot and resumed in its own session by the next round; the step is not counted twice', async () => {
  const s = await setup((req, round) => {
    const step = workerStep(req);
    if (step) return round === 0 ? report(step) : say('done');
    if (/^go$/.test(lastUser(req))) return round === 0 ? call('task_step_run', { steps: ['r1'] }) : say('ok');
    return round === 0 ? call('task_plan', { mode: 'sequential', steps: fourSteps.slice(0, 2).map((x) => ({ ...x, parallel: false })) }) : say('planned');
  });
  const { plans } = wire(s);
  const chat = await sessionOf(s, s.writer.id);
  await drain(s, chat.id, LONG);
  const plan = (await plans.byScope(`chat:${chat.id}`))!;
  // a dead process: the step is running in a worker session with a half turn
  const worker = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.writer.id, name: 'Worker · x · r1', kind: 'work', permissionMode: 'auto' });
  await s.db.insert(taskPlanSessions).values({ id: 'w-row', planId: plan.id, sessionId: worker.id, role: 'worker', stepId: 'r1', parentSessionId: chat.id, depth: 1, status: 'running', startedAt: new Date().toISOString() });
  await s.db.update(taskPlanSteps).set({ status: 'running', attempts: 1, sessionId: worker.id }).where(eq(taskPlanSteps.planId, plan.id));
  const released = await plans.releaseInterrupted();
  assert.ok(released.steps >= 1 && released.sessions === 1);
  assert.match(await plans.text(plan.id), /Interrupted by a restart: r1/);
  await drain(s, chat.id, 'go');
  const r1 = (await plans.steps(plan.id)).find((r) => r.stepId === 'r1')!;
  assert.equal(r1.status, 'done');
  assert.equal(r1.sessionId, worker.id, 'resumed in the same session');
  assert.equal(r1.attempts, 1, 'a resume is not a new attempt');
  const resumedPrompt = s.provider.requests.find((r) => workerStep(r) === 'r1')!;
  assert.match(lastUser(resumedPrompt), /server restarted/);
  assert.equal((await plans.sessionRows(plan.id)).filter((r) => r.role === 'worker').length, 1, 'no new worker session');
});

// ---- sequential handoff on a company task ----

test('sequential on a company task: the run hands off, the next run continues in a fresh session re-grounded on the packet; the run-end hook wakes it; a repeated handoff is refused', async () => {
  const s = await setup((req, round) => {
    const sys = req.system ?? '';
    if (/You continue this task in a fresh session/.test(sys)) {
      if (round === 0) return call('task_step_result', { step: 's2', output: 'section 2 written', criteria: [{ met: true, evidence: 'drafts/s2.md' }] });
      return say('part 2 done');
    }
    if (round === 0) return call('task_plan', { mode: 'sequential', steps: [{ id: 's1', title: 'Section 1', exit: ['written'] }, { id: 's2', title: 'Section 2', exit: ['written'], dependsOn: ['s1'] }] });
    if (round === 1) return call('task_step_result', { step: 's1', output: 'section 1 written', criteria: [{ met: true, evidence: 'drafts/s1.md' }] });
    if (round === 2) return call('task_handoff', { state: 'Section 1 is in drafts/s1.md', decisions: ['British spelling'], next: 'Write section 2' });
    if (round === 3) return call('task_handoff', { state: 'Section 1 is in drafts/s1.md', next: 'write section 2' });
    return say('handed off');
  });
  const orgId = await enable(s);
  const { plans } = wire(s);
  const task = await s.tasks.create(orgId, { title: 'Write the long report', brief: { outcome: 'A report', done_when: 'Both sections written' }, assigneeAgentId: s.writer.id });
  s.runtime.cancelWakesFor(orgId, s.writer.id);
  const outputs: string[] = [];
  const offTurns = s.turns.addToolProvider({ specsFor: async () => [], owns: () => false, isReadOnly: () => true, execute: async () => '', contextFor: async () => null, onToolResult: (_s, _c, r) => { outputs.push(r.output); } });
  assert.equal(await s.runtime.runTask(orgId, task.id, s.writer.id, 'manual'), 'ran');
  offTurns();
  const plan = (await plans.forTask(task.id))!;
  assert.equal(plan.orgId, orgId);
  assert.ok(plan.leadSessionId && plan.leadSessionId !== plan.rootSessionId, 'a fresh lead session');
  assert.equal(plan.handoffPending, 1);
  assert.ok(outputs.some((o) => /same as the last one/.test(o)), 'a second identical handoff is refused');
  assert.ok(s.runtime.pendingWakeKeys().some((k) => k.startsWith(task.id)), 'the run-end hook woke the task');
  const lead = (await s.repo.getSession(plan.leadSessionId!))!;
  assert.equal(lead.taskId, task.id, 'the continuation is linked to the task (Work log, recovery)');
  s.runtime.cancelWakesFor(orgId, s.writer.id);
  assert.equal(await s.runtime.runTask(orgId, task.id, s.writer.id, 'rewake'), 'ran');
  const cont = s.provider.requests.find((r) => /You continue this task in a fresh session/.test(r.system ?? ''))!;
  assert.match(cont.system ?? '', /Section 1 is in drafts\/s1\.md/);
  assert.match(cont.system ?? '', /British spelling/);
  assert.match(cont.system ?? '', /Write the long report/, 're-grounded on the brief');
  assert.equal(cont.messages.filter((m) => m.role === 'user').length, 1, 'no history from the first session');
  const after = (await plans.get(plan.id))!;
  assert.equal(after.handoffPending, 0, 'the packet is read once');
  const st = Object.fromEntries((await plans.steps(plan.id)).map((r) => [r.stepId, r.status]));
  assert.deepEqual(st, { s1: 'done', s2: 'done' });
  const runs = await s.tasks.runs(orgId, task.id);
  assert.ok(runs.every((r) => r.outcome !== 'no_progress'), 'a handoff counts as progress');
  // the task's WIP is one task: no board task was created for the plan
  assert.equal((await s.tasks.list(orgId)).length, 1);
});

test('orchestrated on a company task: workers reserve against the envelopes, run under the task\'s run context and cannot hand the task to review', async () => {
  const s = await setup((req, round) => {
    const step = workerStep(req);
    if (step) {
      if (round === 0) return call('org_request_review', { note: 'done' });
      if (round === 1) return report(step);
      return say('ok');
    }
    if (round === 0) return call('task_plan', { mode: 'orchestrated', steps: fourSteps.slice(0, 2).concat([{ ...fourSteps[3], dependsOn: ['r1', 'r2'] }, { id: 'x', title: 'Extra check', exit: ['checked'], dependsOn: ['w'] }]) });
    if (round === 1) return call('task_step_run', { steps: ['r1', 'r2'] });
    return say('integrated');
  });
  const orgId = await enable(s);
  const { plans } = wire(s);
  const task = await s.tasks.create(orgId, { title: 'Market study', brief: { outcome: 'A market study', context: LONG.slice(0, 3_000), done_when: 'Both markets sized; comparison written; sources cited; reviewed' }, assigneeAgentId: s.writer.id });
  s.runtime.cancelWakesFor(orgId, s.writer.id);
  let reserves = 0; let settled = 0;
  const reserve = s.runtime.reserve.bind(s.runtime); const settle = s.runtime.settle.bind(s.runtime);
  s.runtime.reserve = async (...a: Parameters<typeof reserve>) => { reserves++; return reserve(...a); };
  s.runtime.settle = async (...a: Parameters<typeof settle>) => { settled++; return settle(...a); };
  const toolOutputs: Array<{ session: string; name: string; output: string }> = [];
  const off = s.turns.addToolProvider({ specsFor: async () => [], owns: () => false, isReadOnly: () => true, execute: async () => '', contextFor: async () => null, onToolResult: (sess, c, r) => { toolOutputs.push({ session: sess.id, name: c.name, output: r.output }); } });
  assert.equal(await s.runtime.runTask(orgId, task.id, s.writer.id, 'manual'), 'ran');
  off();
  const plan = (await plans.forTask(task.id))!;
  const steps = Object.fromEntries((await plans.steps(plan.id)).map((r) => [r.stepId, r.status]));
  assert.equal(steps.r1, 'done');
  assert.equal(steps.r2, 'done');
  const workerRows = (await plans.sessionRows(plan.id)).filter((r) => r.role === 'worker');
  const refused = (await s.repo.listMessages(workerRows[0].sessionId)).filter((m) => m.role === 'tool').map((m) => m.content);
  assert.ok(refused.some((o) => /org_request_review belongs to the master/.test(o)), 'a worker cannot hand the task to review');
  assert.ok(toolOutputs.some((o) => o.name === 'task_step_run' && /r1: DONE/.test(o.output)));
  assert.notEqual((await s.tasks.get(orgId, task.id)).status, 'in_review');
  const wReq = s.provider.requests.find((r) => workerStep(r) === 'r1')!;
  assert.match(wReq.system ?? '', /# Organisation run/, 'the worker runs under the task\'s run context');
  assert.match(wReq.system ?? '', /Market study/);
  assert.equal(reserves, 3, 'the run and each worker reserve against the envelopes');
  assert.equal(settled, 3, 'and settle from their usage');
  const view = await plans.view(plan);
  assert.ok(view.sessions.some((x) => x.role === 'master' && x.sessionId === plan.rootSessionId));
  assert.equal(view.sessions.filter((x) => x.role === 'worker').length, 2);
});
