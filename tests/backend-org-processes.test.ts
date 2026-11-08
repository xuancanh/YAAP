/** Processes (docs/processes.md): versioned procedure graphs whose steps
 *  are ordinary tasks. Strict stages are walked by the engine with no model
 *  (dead branches skipped, joins waited on, loops bounded and escalated);
 *  dynamic stages let the performer choose available steps, add a logged
 *  ad-hoc one and finish only when the checkpoints are done; MUST items gate
 *  the review with remediation; deviations are logged or waived by the
 *  manager; edits are new versions routed by the boundary and the company's
 *  tunables; strict runs stay pinned while dynamic ones adopt the newest
 *  version; the sweep repairs what a restart left; triggers fire once. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, enable, sessionOf, type S } from './org-governance-harness';
import { OrgProcessesService } from '../server/src/org/org-processes.service';
import { OrgProcessesTools } from '../server/src/org/org-processes.tools';
import {
  computeMetrics, diffProcess, dynamicAvailable, holds, normalizeProcess, strictWalk, touchesControls, validateProcess, type ProcessDef,
} from '../server/src/org/process-model';
import { PROCESS_TEMPLATES, templatesForRhythm } from '../server/src/org/process-templates';
import { PROCESS_TUNABLES, deriveProcessTunables } from '../server/src/org/process-tunables';
import { deriveOperatingSystem } from '../server/src/org/chief-os';
import { checkBoundary } from '../server/src/org/boundary';
import { parseSteps } from '../server/src/org/work-model';
import { orgProcessSteps, orgTasks } from '../server/src/database/schema';
import { eq } from 'drizzle-orm';

function wire(s: S) {
  const processes = new OrgProcessesService(s.db, s.org, s.tasks, s.approvals, s.audit, s.agents, s.units, s.runtime, s.bus);
  const tools = new OrgProcessesTools(s.org, processes, s.tasks, s.agents, s.config, s.runtime, s.turns, s.units);
  return { processes, tools };
}

/** Writer heads Engineering with Editor reporting to it. */
async function company(s: S, mode: 'supervised' | 'autonomous' = 'supervised') {
  const orgId = await enable(s, mode);
  await s.org.updateMember(orgId, s.writer.id, { title: 'Head of Engineering' });
  await s.org.updateMember(orgId, s.editor.id, { reportsToAgentId: s.writer.id, title: 'Editor' });
  await s.units.syncMembership(orgId);
  return orgId;
}

const stepsOf = async (s: S, p: OrgProcessesService, orgId: string, runId: string) => {
  const rows = await p.steps(orgId, runId);
  return Object.fromEntries(rows.filter((r) => r.current).map((r) => [r.nodeId, r]));
};

/** Tick every MUST item of a step task, then hand it to review and accept it. */
async function finishTask(s: S, orgId: string, taskId: string, opts: { outputs?: Record<string, string>; p?: OrgProcessesService } = {}) {
  const t = await s.tasks.get(orgId, taskId);
  for (const x of parseSteps(t.steps).filter((y) => y.from === 'process:must')) await s.tasks.step(orgId, taskId, { done: x.id }, `agent:${t.assigneeAgentId}`);
  for (const [k, v] of Object.entries(opts.outputs ?? {})) await opts.p!.setOutput(orgId, taskId, k, v, `agent:${t.assigneeAgentId}`);
  const r = await s.tasks.requestReview(orgId, taskId, { fromAgentId: t.assigneeAgentId, note: 'done' });
  await s.tasks.review(orgId, taskId, { verdict: 'accept', byAgentId: r.reviewerAgentId === t.assigneeAgentId ? null : r.reviewerAgentId });
}

// ---- 1. the pure model ----

test('model: validation refuses with remediation; the walk skips dead branches and waits on joins; dynamic availability; conditions', () => {
  const bad = normalizeProcess({ title: 'Loop', stages: [{ id: 'a', title: 'A', mode: 'strict' }], nodes: [{ id: 'x', title: 'X', kind: 'task', must: Array.from({ length: 10 }, (_, i) => `m${i}`) }, { id: 'y', title: 'Y', kind: 'task' }], edges: [{ from: 'x', to: 'y' }, { from: 'y', to: 'x' }] });
  const problems = validateProcess(bad, { loopMaxCeiling: 5 });
  assert.ok(problems.some((p) => /closes a loop without loopMax/.test(p.problem) && /set loopMax/.test(p.fix)), 'an unbounded loop is refused with what to do');
  assert.ok(problems.some((p) => /10 MUST\/SHOULD\/MAY items/.test(p.problem)), 'at most nine items per card');
  for (const t of PROCESS_TEMPLATES) assert.deepEqual(validateProcess(normalizeProcess(t.def), { loopMaxCeiling: 10 }), [], `template ${t.id} is valid`);
  const def: ProcessDef = normalizeProcess({ title: 'Branch', nodes: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }, { id: 'c', title: 'C' }, { id: 'd', title: 'D' }], edges: [{ from: 'a', to: 'b', when: 'go == yes' }, { from: 'a', to: 'c', when: 'go != yes' }, { from: 'b', to: 'd' }, { from: 'c', to: 'd' }] });
  assert.deepEqual(strictWalk(def, 'main', new Map(), {}).ready, ['a']);
  const w = strictWalk(def, 'main', new Map([['a', 'done']]), { go: 'yes' });
  assert.deepEqual(w, { ready: ['b'], skip: ['c'] }, 'the branch not taken is skipped');
  assert.deepEqual(strictWalk(def, 'main', new Map([['a', 'done'], ['b', 'active'], ['c', 'skipped']]), { go: 'yes' }).ready, [], 'the join waits for b');
  assert.deepEqual(strictWalk(def, 'main', new Map([['a', 'done'], ['b', 'done'], ['c', 'skipped']]), { go: 'yes' }).ready, ['d'], 'one fired edge is enough after a skip');
  const dyn = normalizeProcess({ title: 'D', stages: [{ id: 's', title: 'S', mode: 'dynamic' }], nodes: [{ id: 'p', title: 'P', required: true }, { id: 'q', title: 'Q', availableWhen: { after: ['p'], vars: ['ok'] } }] });
  assert.deepEqual(dynamicAvailable(dyn, 's', new Map(), {}).map((n) => n.id), ['p']);
  assert.deepEqual(dynamicAvailable(dyn, 's', new Map([['p', 'done']]), { ok: '1' }).map((n) => n.id), ['q']);
  assert.equal(holds('verdict == revise', { verdict: 'Revise' }), true);
  assert.equal(holds('!rollback', {}), true);
  const v2 = normalizeProcess({ ...def, nodes: def.nodes.map((n) => (n.id === 'b' ? { ...n, must: ['new rule'] } : n)) });
  assert.equal(touchesControls(def, v2), true, 'a new MUST item changes what a run must do');
  assert.equal(touchesControls(def, normalizeProcess({ ...def, description: 'wording' })), false);
  assert.ok(diffProcess(def, v2).some((l) => /step b \+ MUST: new rule/.test(l)));
  assert.deepEqual(templatesForRhythm(['release checklist before each release', 'postmortem after every major incident', 'weekly delivery review']).sort(), ['incident-response', 'release-checklist', 'weekly-review-pack']);
});

test('tunables: derived from the profile within bounds; a hierarchy approves edits and blocks, an adhocracy edits freely; the boundary reserves the tunables', () => {
  const formal = deriveOperatingSystem({ values: 'Process, compliance and audit', culture: 'formal approvals and control' });
  const fast = deriveOperatingSystem({ values: 'Experiment boldly, move fast', culture: 'iterate and explore' });
  const val = (os: ReturnType<typeof deriveOperatingSystem>, k: string) => os.tunables.find((t) => t.key === k)?.value;
  for (const k of Object.keys(PROCESS_TUNABLES)) assert.ok(fast.tunables.some((t) => t.key === k), `derived ${k}`);
  assert.equal(val(formal, 'process.editApproval'), 2);
  assert.equal(val(fast, 'process.editApproval'), 0);
  assert.ok(val(formal, 'process.reviseDeviationRate')! < val(fast, 'process.reviseDeviationRate')!);
  assert.equal(val(formal, 'process.adHocSteps'), 0);
  for (const t of deriveProcessTunables({ stage: 'scale', cultureType: 'clan', speed: true, rigor: true })) { const d = PROCESS_TUNABLES[t.key]; assert.ok(t.value >= d.min && t.value <= d.max, t.key); }
  assert.equal(checkBoundary({ kind: 'tunable', key: 'process.editApproval' }, 'chief').outcome, 'card');
  assert.equal(checkBoundary({ kind: 'process', withinUnit: true }, 'agent:x').outcome, 'proceed');
  assert.equal(checkBoundary({ kind: 'process', withinUnit: false }, 'agent:x').outcome, 'card');
});

// ---- 2. a strict run: tasks, the MUST gate, parallel steps, an approval ----

test('a strict run: steps materialise as process tasks; review is refused while a MUST item or a required output is open; parallel steps join on an approval routed to the manager; the run completes', async () => {
  const s = await setup();
  const orgId = await company(s);
  const { processes, tools } = wire(s);
  const eng = (await s.units.ledBy(orgId, s.writer.id))!;
  const p = await processes.instantiate(orgId, 'release-checklist', { unitId: eng.id });
  assert.equal(p.status, 'active');
  assert.equal(p.version, 1);
  const run = await processes.start(orgId, p.name, { initiator: `agent:${s.writer.id}`, title: 'Release v2.3', vars: { release: 'v2.3' } });
  await processes.settle();
  assert.equal(run.ownerAgentId, s.writer.id, 'the owning unit\'s head owns the run');
  let st = await stepsOf(s, processes, orgId, run.id);
  assert.deepEqual(Object.keys(st), ['scope'], 'only the start step');
  const scope = await s.tasks.get(orgId, st.scope.taskId!);
  assert.equal(scope.source, 'process');
  assert.equal(scope.processRunId, run.id);
  assert.equal(scope.processNodeId, 'scope');
  assert.equal(scope.assigneeAgentId, s.writer.id, 'lane owner → the head');
  assert.match(JSON.parse(scope.brief).outcome, /v2\.3/, 'run variables fill the brief');
  assert.deepEqual(parseSteps(scope.steps).map((x) => x.from), ['process:must'], 'MUST items are the checklist');
  // the step card
  const card = (await processes.stepCardFor(orgId, scope.id))!;
  assert.match(card, /Release checklist v1 · run PR-1 "Release v2\.3"/);
  assert.match(card, /MUST — review is refused while one is open/);
  assert.match(card, /changes \(required\)/);
  // the gate: MUST and the required output
  await assert.rejects(s.tasks.requestReview(orgId, scope.id, { fromAgentId: s.writer.id }), (err: Error) => /MUST item\(s\) not met/.test(err.message) && /org_task_steps done=s1/.test(err.message) && /org_step_output \{name: "changes"/.test(err.message));
  // dropping a MUST item does not satisfy it
  await s.tasks.step(orgId, scope.id, { drop: 's1' }, `agent:${s.writer.id}`);
  await assert.rejects(s.tasks.requestReview(orgId, scope.id, { fromAgentId: s.writer.id }), /waived only by the process owner/);
  await s.db.update(orgTasks).set({ steps: JSON.stringify(parseSteps(scope.steps)) }).where(eq(orgTasks.id, scope.id));
  await finishTask(s, orgId, scope.id, { outputs: { changes: 'ENG-1, ENG-2' }, p: processes });
  await processes.settle();
  st = await stepsOf(s, processes, orgId, run.id);
  assert.equal(st.scope.status, 'done');
  assert.ok(st.ci && st.incidents, 'both parallel steps materialised');
  assert.ok(!st.go, 'the approval waits for both');
  // the next card shows the earlier output
  assert.match((await processes.stepCardFor(orgId, st.ci.taskId!))!, /changes = ENG-1, ENG-2 \(from "List what is in the release"\)/);
  await finishTask(s, orgId, st.ci.taskId!);
  await processes.settle();
  assert.ok(!(await stepsOf(s, processes, orgId, run.id)).go, 'still waiting on incidents');
  await finishTask(s, orgId, st.incidents.taskId!);
  await processes.settle();
  st = await stepsOf(s, processes, orgId, run.id);
  const card2 = await s.approvals.get(orgId, st.go.approvalId!);
  assert.equal(card2.kind, 'process_gate');
  assert.match(card2.recommendation, /Release v2\.3/);
  assert.equal(card2.holder, `agent:${s.chief.id}`, 'routed to the run owner\'s manager first');
  await s.approvals.decide(orgId, card2.id, 'approve', 'go', 'user');
  await processes.settle();
  st = await stepsOf(s, processes, orgId, run.id);
  assert.equal(st.go.outcome, 'approved');
  assert.equal((await processes.run(orgId, run.id)).stage, 'ship');
  await finishTask(s, orgId, st.rollback.taskId!, { outputs: { rollback: 'revert v2.3 — Writer' }, p: processes });
  await processes.settle();
  st = await stepsOf(s, processes, orgId, run.id);
  await finishTask(s, orgId, st.note.taskId!);
  await processes.settle();
  const done = await processes.run(orgId, run.id);
  assert.equal(done.status, 'done');
  assert.equal(JSON.parse(done.vars).rollback, 'revert v2.3 — Writer');
  // idempotent: a sweep finds nothing to do, nothing doubles
  const before = (await processes.steps(orgId, run.id)).length;
  await processes.sweep(orgId);
  await processes.sweep(orgId);
  assert.equal((await processes.steps(orgId, run.id)).length, before);
  const m = await processes.metrics(orgId, p.id);
  assert.equal(m.runs, 1);
  assert.equal(m.completionRate, 1);
  // the tools list it
  const listed = await tools.execute(await sessionOf(s, s.chief.id), 'org_processes', {});
  assert.match(listed, /release-checklist "Release checklist" v1 — strict, delivery, active; owner Writer/);
});

// ---- 3. loops are bounded and escalate ----

test('a review loop goes round at most loopMax times, then the run waits on a decision; approving allows one more round', async () => {
  const s = await setup();
  const orgId = await company(s);
  const { processes } = wire(s);
  const p = await processes.instantiate(orgId, 'content-publishing', { unitId: (await s.units.ledBy(orgId, s.writer.id))!.id });
  const run = await processes.start(orgId, p.name, { initiator: 'user', vars: { piece: 'Launch post' } });
  await processes.settle();
  let st = await stepsOf(s, processes, orgId, run.id);
  for (let round = 1; round <= 3; round++) {
    await finishTask(s, orgId, st.draft.taskId!, { outputs: { draft: `/drafts/launch-${round}.md` }, p: processes });
    await processes.settle();
    st = await stepsOf(s, processes, orgId, run.id);
    assert.equal(st.edit.attempt, round);
    assert.equal((await s.tasks.get(orgId, st.edit.taskId!)).assigneeAgentId, s.editor.id, 'lane "editor" → the member titled Editor');
    await finishTask(s, orgId, st.edit.taskId!, { outputs: { verdict: 'revise' }, p: processes });
    await processes.settle();
    st = await stepsOf(s, processes, orgId, run.id);
    if (round < 3) assert.equal(st.draft.attempt, round + 1, `round ${round}: back to draft`);
  }
  const blocked = await processes.run(orgId, run.id);
  assert.equal(blocked.status, 'blocked', 'loopMax 2 exhausted');
  const esc = (await s.approvals.pending(orgId)).find((a) => a.kind === 'process_gate' && JSON.parse(a.payload).escalation === 'loop')!;
  assert.ok(esc, 'an escalation card');
  await s.approvals.decide(orgId, esc.id, 'approve', 'one more go', 'user');
  await processes.settle();
  st = await stepsOf(s, processes, orgId, run.id);
  assert.equal((await processes.run(orgId, run.id)).status, 'running');
  assert.equal(st.draft.attempt, 4, 'one more round');
  const m = await processes.metrics(orgId, p.id);
  assert.ok((m.reworkRate ?? 0) > 0, 'rework is counted');
  assert.ok((await processes.events(orgId, { runId: run.id })).some((e) => e.activity === 'loop_exhausted'));
});

// ---- 4. dynamic stages: the performer chooses ----

test('a dynamic stage: a coordinator task for the performer; it chooses available steps, may add a logged ad-hoc step, and finishes only when the checkpoints are done', async () => {
  const s = await setup();
  const orgId = await company(s);
  const { processes, tools } = wire(s);
  const p = await processes.instantiate(orgId, 'customer-onboarding', { unitId: (await s.units.ledBy(orgId, s.writer.id))!.id });
  const run = await processes.start(orgId, p.name, { initiator: 'user', vars: { customer: 'Acme' } });
  await processes.settle();
  let st = await stepsOf(s, processes, orgId, run.id);
  await finishTask(s, orgId, st.kickoff.taskId!, { outputs: { first_value: 'first invoice sent' }, p: processes });
  await processes.settle();
  st = await stepsOf(s, processes, orgId, run.id);
  const coord = st['@adopt'];
  assert.ok(coord?.taskId, 'the coordinator task');
  const coordTask = await s.tasks.get(orgId, coord.taskId!);
  assert.equal(coordTask.assigneeAgentId, s.writer.id);
  assert.match((await processes.stepCardFor(orgId, coord.taskId!))!, /setup: Set up \(checkpoint — required\)/);
  await assert.rejects(s.tasks.requestReview(orgId, coord.taskId!, { fromAgentId: s.writer.id }), /coordinates the stage/, 'the coordinator is not reviewed');
  await assert.rejects(processes.finishStage(orgId, run.key, `agent:${s.writer.id}`), /checkpoint\(s\) not done: setup "Set up"; value/);
  await assert.rejects(processes.choose(orgId, run.key, { node: 'value' }, `agent:${s.writer.id}`), /not available — it needs "setup" done first/);
  await assert.rejects(processes.choose(orgId, run.key, { node: 'setup' }, `agent:${s.editor.id}`), /only the performer/);
  const session = await sessionOf(s, s.writer.id);
  const chose = await tools.execute(session, 'org_step_choose', { run: run.key, step: 'setup', assignee: 'Editor' });
  assert.match(chose, /Chose setup/);
  st = await stepsOf(s, processes, orgId, run.id);
  const setupTask = await s.tasks.get(orgId, st.setup.taskId!);
  assert.equal(setupTask.assigneeAgentId, s.editor.id);
  assert.equal(setupTask.parentTaskId, coord.taskId, 'a subtask of the coordinator');
  // ad-hoc: logged as a deviation
  await processes.choose(orgId, run.key, { adHoc: { title: 'Import their data', outcome: 'their CSV is in' }, reason: 'they had a legacy export' }, `agent:${s.writer.id}`);
  st = await stepsOf(s, processes, orgId, run.id);
  assert.ok(st['adhoc-1']);
  assert.equal(JSON.parse(st['adhoc-1'].deviations)[0].level, 'ad_hoc');
  await finishTask(s, orgId, st.setup.taskId!);
  await processes.settle();
  assert.match((await s.tasks.messages(orgId, { taskId: coord.taskId! })).map((m) => m.text).join('\n'), /Step "Set up" is done.*Available next: training, value \(checkpoint\)/s, 'the performer is told what is available');
  await processes.choose(orgId, run.key, { node: 'value' }, `agent:${s.writer.id}`);
  st = await stepsOf(s, processes, orgId, run.id);
  await finishTask(s, orgId, st.value.taskId!);
  await processes.settle();
  await assert.rejects(processes.finishStage(orgId, run.key, `agent:${s.writer.id}`), /still under way: Import their data/);
  await finishTask(s, orgId, st['adhoc-1'].taskId!);
  await processes.settle();
  const out = await tools.execute(session, 'org_process_next', { run: run.key, finish: true });
  assert.match(out, /is done/);
  assert.equal((await processes.run(orgId, run.id)).status, 'done');
  // a hierarchy runs only the defined steps
  await s.org.setTunable(orgId, 'process.adHocSteps', 0, { actor: 'user', why: 'test', decidedBy: 'user' });
  const r2 = await processes.start(orgId, p.name, { initiator: 'user', vars: { customer: 'Beta' } });
  await processes.settle();
  const k2 = (await stepsOf(s, processes, orgId, r2.id)).kickoff;
  await finishTask(s, orgId, k2.taskId!, { outputs: { first_value: 'x' }, p: processes });
  await processes.settle();
  await assert.rejects(processes.choose(orgId, r2.key, { adHoc: { title: 'Extra' } }, `agent:${s.writer.id}`), /only the defined steps \(process\.adHocSteps 0\)/);
});

// ---- 5. versions: who may edit, approval by tunable, pinning and adoption, rollback ----

test('edits are new versions with author and reason; the tunable decides apply-or-approve; another unit\'s process is a proposal; strict runs stay pinned, dynamic runs adopt at a choice; rollback is a new version', async () => {
  const s = await setup();
  const orgId = await company(s);
  const { processes } = wire(s);
  const eng = (await s.units.ledBy(orgId, s.writer.id))!;
  const rel = await processes.instantiate(orgId, 'release-checklist', { unitId: eng.id });
  const wbr = await processes.instantiate(orgId, 'weekly-review-pack');
  const strictRun = await processes.start(orgId, rel.name, { initiator: 'user', vars: { release: 'v1' } });
  const def1 = (await processes.activeDef(orgId, rel))!;
  // the head edits its own process: wording applies at once (editApproval 1)
  const wording = await processes.author(orgId, { process: rel.name, def: { ...def1, description: 'Every release, no exceptions.' }, reason: 'clearer description' }, `agent:${s.writer.id}`);
  assert.equal(wording.applied, true);
  assert.equal(wording.process.version, 2);
  assert.equal(wording.version.author, `agent:${s.writer.id}`);
  // a new MUST item waits for the head's manager (the chief)
  const def2 = (await processes.activeDef(orgId, await processes.get(orgId, rel.name)))!;
  const stricter = { ...def2, nodes: def2.nodes.map((n) => (n.id === 'ci' ? { ...n, must: [...(n.must ?? []), 'Security scan is clean'] } : n)) };
  const pending = await processes.author(orgId, { process: rel.name, def: stricter, reason: 'two runs shipped a vulnerable dependency' }, `agent:${s.writer.id}`);
  assert.equal(pending.applied, false);
  const card = await s.approvals.get(orgId, pending.approvalId!);
  assert.equal(card.kind, 'process_change');
  assert.equal(card.holder, `agent:${s.chief.id}`);
  assert.equal((await processes.get(orgId, rel.name)).version, 2, 'not yet');
  await s.approvals.decide(orgId, card.id, 'approve', 'agreed', 'user');
  assert.equal((await processes.get(orgId, rel.name)).version, 3);
  assert.equal((await processes.run(orgId, strictRun.id)).version, 1, 'the strict run stays pinned to v1');
  // a head may not change the company's process alone: a CEO-reserved proposal
  const wdef = (await processes.activeDef(orgId, wbr))!;
  const prop = await processes.author(orgId, { process: wbr.name, def: { ...wdef, description: 'x' }, reason: 'try' }, `agent:${s.writer.id}`);
  assert.equal(prop.applied, false);
  assert.match((await s.approvals.get(orgId, prop.approvalId!)).reserved, /boundary reserves it/);
  // the chief edits the company's process; with editApproval 0 even a control change applies
  await s.org.setTunable(orgId, 'process.editApproval', 0, { actor: 'user', why: 'test', decidedBy: 'user' });
  const dynRun = await processes.start(orgId, wbr.name, { initiator: 'user' });
  await processes.settle();
  const wdef2 = { ...wdef, nodes: wdef.nodes.map((n) => (n.id === 'commentary' ? { ...n, must: ['Every off-target metric has its owner\'s lines'] } : n)) };
  const chiefEdit = await processes.author(orgId, { process: wbr.name, def: wdef2, reason: 'commentary was skipped in half the runs' }, 'chief');
  assert.equal(chiefEdit.applied, true);
  const r = await processes.choose(orgId, dynRun.key, { node: 'scorecard' }, `agent:${s.chief.id}`);
  assert.equal(r.adopted, chiefEdit.process.version, 'the dynamic run adopts the newest version at its next choice');
  // rollback
  const back = await processes.rollback(orgId, rel.name, 1, 'the security scan step blocks every release', 'user');
  assert.equal(back.process.version, 4);
  assert.match(back.version.reason, /^rollback to v1:/);
  assert.equal((await processes.versions(orgId, rel.id)).length, 4, 'every version stays');
  assert.equal(JSON.stringify((await processes.activeDef(orgId, back.process))!.nodes), JSON.stringify(def1.nodes));
  // retire: no new runs
  await processes.retire(orgId, rel.name, 'replaced by CI gates', 'user');
  await assert.rejects(processes.start(orgId, rel.name, { initiator: 'user' }), /is retired/);
});

// ---- 6. deviations ----

test('deviations: a SHOULD skip is logged; a MUST waiver is a card for the performer\'s manager, and approved it lets the review through; deviation rates flag the step', async () => {
  const s = await setup();
  const orgId = await company(s);
  const { processes, tools } = wire(s);
  const p = await processes.instantiate(orgId, 'release-checklist', { unitId: (await s.units.ledBy(orgId, s.writer.id))!.id });
  const run = await processes.start(orgId, p.name, { initiator: 'user', vars: { release: 'v9' } });
  await processes.settle();
  let st = await stepsOf(s, processes, orgId, run.id);
  await finishTask(s, orgId, st.scope.taskId!, { outputs: { changes: 'none' }, p: processes });
  await processes.settle();
  st = await stepsOf(s, processes, orgId, run.id);
  const ci = await s.tasks.get(orgId, st.ci.taskId!);
  // the MUST waiver
  const res = await processes.deviate(orgId, ci.id, { level: 'must', item: 's2', reason: 'CI was down all day', alternative: 'ran the suite locally, logs attached' }, `agent:${s.writer.id}`);
  assert.equal(res.status, 'pending');
  const card = await s.approvals.get(orgId, res.approvalId!);
  assert.equal(card.kind, 'process_deviation');
  assert.equal(card.holder, `agent:${s.chief.id}`);
  await s.tasks.step(orgId, ci.id, { done: 's1' }, `agent:${s.writer.id}`);
  await assert.rejects(s.tasks.requestReview(orgId, ci.id, { fromAgentId: s.writer.id }), /s2\. A flaky run/, 'still refused while pending');
  await s.approvals.decide(orgId, card.id, 'approve', 'ok this once', 'user');
  await processes.settle();
  const r = await s.tasks.requestReview(orgId, ci.id, { fromAgentId: s.writer.id });
  assert.equal(r.status, 'in_review', 'the waived item no longer blocks');
  assert.match((await processes.stepCardFor(orgId, ci.id))!, /\[~\] s2\..*\(waived\)/);
  await s.tasks.review(orgId, ci.id, { verdict: 'accept', byAgentId: r.reviewerAgentId });
  // asking to skip a MUST item at SHOULD level is still a waiver
  const session = await sessionOf(s, s.writer.id);
  const inc = await s.tasks.get(orgId, st.incidents.taskId!);
  assert.match(await tools.execute(session, 'org_process_deviate', { taskId: inc.key, level: 'should', item: 's1', reason: 'r' }), /waived only by the owner of the standard/);
  await s.tasks.step(orgId, inc.id, { done: 's1' }, `agent:${s.writer.id}`);
  await finishTask(s, orgId, inc.id);
  await processes.settle();
  st = await stepsOf(s, processes, orgId, run.id);
  await s.approvals.decide(orgId, st.go.approvalId!, 'approve', '', 'user');
  await processes.settle();
  st = await stepsOf(s, processes, orgId, run.id);
  // a SHOULD skip is logged and the run goes on
  const rb = await s.tasks.get(orgId, st.rollback.taskId!);
  assert.match(await tools.execute(session, 'org_process_deviate', { taskId: rb.key, level: 'should', item: 's2', reason: 'a config-only release', alternative: 'nothing new to flag' }), /logged: SHOULD item s2 skipped/);
  assert.match((await processes.stepCardFor(orgId, rb.id))!, /\[~\] s2\..*\(waived\)/);
  await finishTask(s, orgId, rb.id, { outputs: { rollback: 'revert' }, p: processes });
  await processes.settle();
  const m = await processes.metrics(orgId, p.id);
  assert.equal(m.steps.find((x) => x.nodeId === 'rollback')?.deviations, 1);
  assert.equal(m.steps.find((x) => x.nodeId === 'ci')?.deviations, 1);
  assert.ok((await processes.events(orgId, { runId: run.id })).some((e) => e.activity === 'deviation_approved'));
  const health = computeMetrics([{ status: 'done', startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T02:00:00Z' }], [1, 2, 3].map(() => ({ nodeId: 'ci', status: 'done', attempt: 1, deviations: 1, reviewRounds: 0, slaBreached: false, startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T01:00:00Z' })), { reviseDeviationRate: 0.3 });
  assert.equal(health.health, 'revise');
  assert.match(health.why, /ci deviates in 100% of runs/);
});

// ---- 7. denied tools, restarts, triggers, seeding ----

test('a step\'s denied tools are refused; the sweep repairs a step a restart left without its task; incidents and cadences trigger once; onboarding seeds the library', async () => {
  const s = await setup();
  const orgId = await company(s);
  const { processes } = wire(s);
  const def = normalizeProcess({ title: 'No merging', category: 'operating', nodes: [{ id: 'look', title: 'Look only', deny: ['scm_merge'], lane: 'chief' }, { id: 'after', title: 'After', lane: 'chief' }], edges: [{ from: 'look', to: 'after' }], triggers: [{ kind: 'cadence', cron: '0 9 * * *' }] });
  const proc = (await processes.author(orgId, { name: 'no-merging', def, reason: 'test' }, 'user')).process;
  const run = await processes.start(orgId, proc.name, { initiator: 'user' });
  await processes.settle();
  let st = await stepsOf(s, processes, orgId, run.id);
  assert.deepEqual((await processes.deniedTools(orgId, st.look.taskId!)).deny, ['scm_merge']);
  // a restart between the step row and its task: the sweep finds the orphan task, never a second one
  await s.db.update(orgProcessSteps).set({ taskId: null }).where(eq(orgProcessSteps.id, st.look.id));
  const repaired = await processes.sweep(orgId);
  assert.equal(repaired.repaired, 1);
  st = await stepsOf(s, processes, orgId, run.id);
  assert.equal((await s.tasks.list(orgId)).filter((t) => t.processRunId === run.id && t.processNodeId === 'look').length, 1);
  // a task finished while the server was down: the sweep settles it and advances
  await s.db.update(orgTasks).set({ status: 'done' }).where(eq(orgTasks.id, st.look.taskId!));
  await processes.sweep(orgId);
  assert.ok((await stepsOf(s, processes, orgId, run.id)).after, 'the next step materialised');
  // cadence: fires once per match, deduped
  await processes.cancel(orgId, run.id, 'done testing', 'user');
  const org = await s.org.get(orgId);
  const nine = new Date(); nine.setHours(9, 0, 30, 0); if (nine.getTime() < Date.parse(proc.createdAt)) nine.setDate(nine.getDate() + 1);
  await processes.tick(org, new Date(nine.getTime() + 60_000));
  await processes.tick(org, new Date(nine.getTime() + 120_000));
  await processes.settle();
  assert.equal((await processes.runs(orgId, { processId: proc.id })).filter((r) => JSON.parse(r.trigger).kind === 'cadence').length, 1);
  // incidents: a major one starts incident response once
  const ir = await processes.instantiate(orgId, 'incident-response');
  const incidentId = 'inc-1';
  s.bus.emitOrgIncident({ orgId, incidentId, agentId: null, actionClass: null, severity: 'major', kind: 'owner_complaint' });
  s.bus.emitOrgIncident({ orgId, incidentId, agentId: null, actionClass: null, severity: 'major', kind: 'owner_complaint' });
  await processes.settle();
  const irRuns = await processes.runs(orgId, { processId: ir.id });
  assert.equal(irRuns.length, 1, 'one run per incident');
  const contain = (await stepsOf(s, processes, orgId, irRuns[0].id)).contain;
  assert.equal((await s.tasks.get(orgId, contain.taskId!)).source, 'process');
  s.bus.emitOrgIncident({ orgId, incidentId: 'minor-1', agentId: null, actionClass: null, severity: 'minor', kind: 'tool_errors' });
  await processes.settle();
  assert.equal((await processes.runs(orgId, { processId: ir.id })).length, 1, 'a minor incident is below the trigger');
  // seeding: the library once, function templates for the functions the company has
  const s2 = await setup();
  const org2 = await company(s2);
  const w2 = wire(s2);
  await w2.processes.tick(await s2.org.get(org2), new Date());
  const names = (await w2.processes.list(org2)).map((p) => p.name).sort();
  assert.ok(names.includes('chief-daily-ops') && names.includes('incident-response') && names.includes('release-checklist'), names.join(','));
  assert.ok(!names.includes('hiring-loop'), 'no People function, no hiring loop');
  assert.ok((await w2.processes.events(org2)).some((e) => e.activity === 'version_activated'), 'each seeded process has its first version');
  await w2.processes.tick(await s2.org.get(org2), new Date());
  assert.equal((await w2.processes.list(org2)).length, names.length, 'seeded once');
});
