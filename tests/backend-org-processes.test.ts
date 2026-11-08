/** Processes (docs/processes.md): versioned procedure graphs whose steps
 *  are ordinary tasks. Strict stages are walked by the engine with no model
 *  (dead branches skipped, joins waited on, loops bounded and escalated);
 *  dynamic stages let the performer choose available steps, add a logged
 *  ad-hoc one and finish only when the checkpoints are done; MUST items gate
 *  the review with remediation; deviations are logged or waived by the
 *  manager; edits are new versions routed by the boundary and the company's
 *  tunables; strict runs stay pinned while dynamic ones adopt the newest
 *  version; the sweep repairs what a restart left; triggers fire once.
 *  The later phases: meeting steps complete when their meeting ends, with
 *  the minutes as outputs; a failed or cancelled run undoes its done steps
 *  in reverse order (a saga); a new version ramps on a share of runs and is
 *  promoted or rolled back on the comparison; repeated work is discovered
 *  as a drafted process for its owner; conformance is measured apart from
 *  outcomes and a step most runs deviate from becomes a revision suggestion. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, enable, sessionOf, type S } from './org-governance-harness';
import { OrgProcessesService } from '../server/src/org/org-processes.service';
import { OrgProcessesTools } from '../server/src/org/org-processes.tools';
import {
  compareCohorts, compensationPlan, computeConformance, computeMetrics, diffProcess, dynamicAvailable, holds, normalizeProcess, strictWalk, touchesControls, validateProcess,
  type ConformanceFacts, type ProcessDef,
} from '../server/src/org/process-model';
import { draftProcess, minePatterns, titleStem, type TaskFact } from '../server/src/org/process-discovery';
import { PROCESS_TEMPLATES, templatesForRhythm } from '../server/src/org/process-templates';
import { PROCESS_TUNABLES, deriveProcessTunables } from '../server/src/org/process-tunables';
import { deriveOperatingSystem } from '../server/src/org/chief-os';
import { checkBoundary } from '../server/src/org/boundary';
import { parseSteps } from '../server/src/org/work-model';
import { orgProcessSteps, orgTasks } from '../server/src/database/schema';
import { eq } from 'drizzle-orm';

function wire(s: S) {
  const processes = new OrgProcessesService(s.db, s.org, s.tasks, s.approvals, s.audit, s.agents, s.units, s.runtime, s.bus, undefined, undefined, s.meetings);
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

// ---- 7. the normal creation path: gates see the category; a refusal fails the step with its reason ----

test('process tasks go through the normal creation path: a gate sees source process and the category; a refusal fails the step and the run says why', async () => {
  const s = await setup();
  const orgId = await company(s);
  const { processes } = wire(s);
  const seen: Array<{ source: unknown; category: unknown }> = [];
  const create = s.tasks.create.bind(s.tasks);
  s.tasks.create = (async (o: string, input: Parameters<typeof create>[1]) => {
    seen.push({ source: input.source, category: input.process?.category });
    if (input.source === 'process' && input.process?.category === 'delivery') throw new Error('refused: the project is not aligned with the CEO yet');
    return create(o, input);
  }) as typeof s.tasks.create;
  const ir = await processes.instantiate(orgId, 'incident-response');
  const r1 = await processes.start(orgId, ir.name, { initiator: 'user', vars: { incident: 'Checkout down' } });
  await processes.settle();
  assert.equal((await processes.run(orgId, r1.id)).status, 'running', 'an operating process passes');
  const rel = await processes.instantiate(orgId, 'release-checklist', { unitId: (await s.units.ledBy(orgId, s.writer.id))!.id });
  const r2 = await processes.start(orgId, rel.name, { initiator: 'user' });
  await processes.settle();
  const failed = await processes.run(orgId, r2.id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.note, /could not be created: refused: the project is not aligned with the CEO yet/);
  assert.deepEqual(seen.map((x) => x.category), ['operating', 'delivery']);
  assert.ok(seen.every((x) => x.source === 'process'));
});

// ---- 8. denied tools, restarts, triggers, seeding ----

test('a step\'s denied tools are refused; the sweep repairs a step a restart left without its task; incidents and cadences trigger once; onboarding seeds the library', async () => {
  const s = await setup();
  const orgId = await company(s);
  const { processes, tools } = wire(s);
  const def = normalizeProcess({ title: 'No merging', category: 'operating', nodes: [{ id: 'look', title: 'Look only', deny: ['scm_merge'], lane: 'chief' }, { id: 'after', title: 'After', lane: 'chief' }], edges: [{ from: 'look', to: 'after' }], triggers: [{ kind: 'cadence', cron: '0 9 * * *' }] });
  const proc = (await processes.author(orgId, { name: 'no-merging', def, reason: 'test' }, 'user')).process;
  const run = await processes.start(orgId, proc.name, { initiator: 'user' });
  await processes.settle();
  let st = await stepsOf(s, processes, orgId, run.id);
  assert.deepEqual((await processes.deniedTools(orgId, st.look.taskId!)).deny, ['scm_merge']);
  const runSession = await sessionOf(s, s.chief.id);
  s.runtime.beginAuxRun({ orgId, taskId: st.look.taskId!, agentId: s.chief.id, runId: 'r-1', sessionId: runSession.id, isChief: true, reviewer: false, progress: false, calls: new Map(), loopDetected: false });
  assert.match((await tools.refuseCall(runSession, { id: 'c1', name: 'scm_merge', input: {} }))!, /^Refused: scm_merge is not used in step "Look only"/);
  assert.equal(await tools.refuseCall(runSession, { id: 'c2', name: 'fs_read', input: {} }), null);
  assert.match((await tools.contextFor(runSession))!, /## Process step — No merging v1/, 'the step card is the run\'s context');
  s.runtime.endAuxRun(runSession.id);
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

// ---- 9. the later phases: the pure halves ----

test('model: meeting and compensation steps validate; the saga undoes latest first; cohorts compare; conformance counts drift apart from outcomes', () => {
  const def = normalizeProcess({
    title: 'Ship', nodes: [
      { id: 'deploy', title: 'Deploy', compensate: 'undeploy' }, { id: 'announce', title: 'Announce', compensate: 'unannounce' },
      { id: 'sync', title: 'Sync', kind: 'meeting', meetingKind: 'adhoc', attendees: ['owner', 'unit'], agenda: 'Go over ${release}' },
      { id: 'undeploy', title: 'Roll the deploy back', compensation: true }, { id: 'unannounce', title: 'Retract the announcement', compensation: true },
    ], edges: [{ from: 'deploy', to: 'announce' }, { from: 'announce', to: 'sync' }],
  });
  assert.deepEqual(validateProcess(def), [], 'a valid saga with a meeting');
  assert.deepEqual(strictWalk(def, 'main', new Map(), {}).ready, ['deploy'], 'compensation steps stand outside the walk');
  const bad = normalizeProcess({ ...def, nodes: [...def.nodes.map((n) => (n.id === 'sync' ? { ...n, meetingKind: 'party' } : n)), { id: 'stray', title: 'Stray', compensation: true }, { id: 'x', title: 'X', compensate: 'deploy' }], edges: [...def.edges, { from: 'sync', to: 'undeploy' }] });
  const problems = validateProcess(bad).map((p) => `${p.where}: ${p.problem}`).join('\n');
  assert.match(problems, /no meeting kind "party"/);
  assert.match(problems, /step stray: no step names this compensation step/);
  assert.match(problems, /compensate names "deploy", which is not marked compensation/);
  assert.match(problems, /an edge touches a compensation step/);
  assert.deepEqual(compensationPlan(def, [{ nodeId: 'deploy', startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T01:00:00Z' }, { nodeId: 'announce', startedAt: '2026-01-01T01:00:00Z', endedAt: '2026-01-01T02:00:00Z' }]).map((x) => `${x.forward}>${x.comp.id}`), ['announce>unannounce', 'deploy>undeploy'], 'reverse order of completion');
  // cohorts
  const m = (over: Partial<ReturnType<typeof computeMetrics>>) => ({ ...computeMetrics([], [], { reviseDeviationRate: 0.3 }), runs: 5, done: 5, completionRate: 1, cycleHoursP50: 10, deviationRate: 0.1, reworkRate: 0.1, health: 'healthy' as const, ...over });
  assert.equal(compareCohorts(m({}), m({ done: 1, runs: 1 }), { minRuns: 3, tolerance: 0.1 }).verdict, 'collecting');
  const worse = compareCohorts(m({}), m({ deviationRate: 0.5, cycleHoursP50: 20 }), { minRuns: 3, tolerance: 0.1 });
  assert.equal(worse.verdict, 'rollback');
  assert.match(worse.why, /worse on cycle time, deviation/);
  assert.equal(compareCohorts(m({}), m({ deviationRate: 0.15, cycleHoursP50: 9 }), { minRuns: 3, tolerance: 0.1 }).verdict, 'promote', 'within tolerance is no worse');
  // conformance
  const f = (runId: string, nodeId: string, over: Partial<ConformanceFacts> = {}): ConformanceFacts => ({ runId, nodeId, strict: true, adHoc: false, status: 'done', deviations: [], outOfOrder: false, ...over });
  const c = computeConformance([f('r1', 'a'), f('r1', 'b', { deviations: [{ level: 'must', status: 'approved' }] }), f('r2', 'a', { deviations: [{ level: 'should', status: 'logged' }] }), f('r2', 'adhoc-1', { adHoc: true, strict: false }), f('r3', 'b', { outOfOrder: true })], { alertBelow: 0.7 });
  assert.equal(c.waivers, 1, 'a waiver is counted');
  assert.equal(c.conformant, 2, 'a waiver is a sanctioned exception, not drift');
  assert.equal(c.shouldSkips + c.adHoc + c.outOfOrder, 3);
  assert.equal(c.conformantRuns, 1);
  assert.equal(c.verdict, 'drifting');
});

test('discovery (pure): recurring work on several days, a repeated sequence, repeated cross-department requests and a repeated ad-hoc step; drafts are valid', () => {
  assert.equal(titleStem('Weekly report: "Acme" ENG-12 v2.3'), 'weekly report');
  const t = (id: string, title: string, day: number, over: Partial<TaskFact> = {}): TaskFact => ({ id, ref: id.toUpperCase(), title, createdAt: `2026-03-${String(10 + day).padStart(2, '0')}T09:00:00Z`, class: null, unitId: 'eng', parentTaskId: null, dependsOn: [], creatorUnitId: null, assigneeTitle: 'Writer', doneWhen: 'sent to the list', ...over });
  const tasks: TaskFact[] = [
    ...[0, 1, 2, 3].map((d) => t(`r${d}`, `Weekly report for client ${d}`, d)),
    ...[0, 0, 0, 0].map((d, i) => t(`b${i}`, `Blog post about topic ${i}`, d)),
    ...[0, 1, 2].flatMap((i) => [t(`p${i}`, `Release prep ${i}`, i, { parentTaskId: `rel${i}` }), t(`q${i}`, `Release notes ${i}`, i, { parentTaskId: `rel${i}`, createdAt: `2026-03-1${i}T10:00:00Z` })]),
    ...[0, 1, 2].map((i) => t(`x${i}`, `Legal review of contract ${i}`, i, { unitId: 'legal', creatorUnitId: 'sales' })),
  ];
  const pats = minePatterns(tasks, [1, 2, 3].map((i) => ({ processId: 'p1', runId: `run${i}`, stage: 'adopt', title: 'Import their data', at: '' })), { minRepeats: 3, covered: () => false });
  const kinds = Object.fromEntries(pats.map((p) => [p.key, p]));
  assert.ok(kinds['recurring:weekly report'], 'recurring on several days');
  assert.equal(kinds['recurring:weekly report'].label, 'Weekly report for client');
  assert.ok(!kinds['recurring:blog post'], 'four tasks made at once are not a routine');
  assert.ok(kinds['sequence:release prep>release notes'], 'the same sequence under three parents');
  assert.ok(!kinds['recurring:release prep'], 'a step of a sequence is not suggested again alone');
  assert.equal(kinds['cross:legal:legal review']?.unitId, 'legal', 'repeated requests of another department');
  assert.equal(kinds['adhoc:p1:import their']?.count, 3);
  for (const p of pats) {
    const d = draftProcess(p);
    if (p.kind === 'adhoc_step') { assert.equal(d, null); continue; }
    assert.ok(d, `draft for ${p.key}`);
    assert.deepEqual(validateProcess(d!), [], `draft for ${p.key} is valid`);
  }
  assert.deepEqual(draftProcess(kinds['sequence:release prep>release notes'])!.edges.map((e) => `${e.from}>${e.to}`), ['release-prep>release-notes']);
  assert.ok(draftProcess(kinds['cross:legal:legal review'])!.triggers.some((x) => x.kind === 'service_request'), 'an intake takes service requests');
  assert.equal(minePatterns(tasks, [], { minRepeats: 3, covered: (x) => x === 'weekly report' }).some((p) => p.key === 'recurring:weekly report'), false, 'a covered stem is not suggested');
});

// ---- 10. meeting steps ----

test('a meeting step holds a meeting of its kind with its lanes and the earlier outputs on the agenda; a restart adopts it; its end makes the minutes outputs; a cancelled meeting fails the step', async () => {
  const s = await setup();
  const orgId = await company(s);
  const { processes } = wire(s);
  const eng = (await s.units.ledBy(orgId, s.writer.id))!;
  const def = normalizeProcess({ title: 'Plan the launch', category: 'delivery', nodes: [
    { id: 'prep', title: 'Prepare the options', outputs: [{ name: 'options', required: true }] },
    { id: 'decide', title: 'Decide the launch', kind: 'meeting', meetingKind: 'planning', lane: 'owner', attendees: ['owner', 'editor'], agenda: 'Pick the launch date for ${launch}' },
    { id: 'follow', title: 'Follow up' },
  ], edges: [{ from: 'prep', to: 'decide' }, { from: 'decide', to: 'follow' }] });
  const p = (await processes.author(orgId, { name: 'launch-plan', def, unitId: eng.id, reason: 'test' }, 'user')).process;
  const run = await processes.start(orgId, p.name, { initiator: 'user', vars: { launch: 'v3' } });
  await processes.settle();
  let st = await stepsOf(s, processes, orgId, run.id);
  await finishTask(s, orgId, st.prep.taskId!, { outputs: { options: 'May 4 or May 11' }, p: processes });
  await processes.settle();
  st = await stepsOf(s, processes, orgId, run.id);
  assert.equal(st.decide.kind, 'meeting');
  const m = await s.meetings.get(orgId, st.decide.meetingId!);
  assert.equal(m.kind, 'planning');
  assert.equal(m.facilitatorAgentId, s.writer.id, 'facilitated by its lane');
  assert.deepEqual(JSON.parse(m.attendees).map((a: { id: string }) => a.id).sort(), [s.writer.id, s.editor.id].sort(), 'attendees by lane');
  assert.match(m.agenda, /Pick the launch date for v3/);
  assert.match(m.agenda, /options: May 4 or May 11 \(from "Prepare the options"\)/, 'the inputs of earlier steps');
  assert.equal(m.unitId, eng.id);
  // a restart between the row and the meeting: the sweep adopts it, never a second one
  await s.db.update(orgProcessSteps).set({ meetingId: null }).where(eq(orgProcessSteps.id, st.decide.id));
  assert.equal((await processes.sweep(orgId)).repaired, 1);
  assert.equal((await stepsOf(s, processes, orgId, run.id)).decide.meetingId, m.id);
  assert.equal((await s.meetings.list(orgId)).filter((x) => x.createdBy === `process:${st.decide.id}`).length, 1);
  await processes.sweep(orgId);
  assert.equal((await stepsOf(s, processes, orgId, run.id)).decide.status, 'active', 'waits while the meeting has not ended');
  // the meeting ends: minutes → outputs, the run goes on
  await s.meetings.update(orgId, m.id, { status: 'done', endedAt: new Date().toISOString(), minutes: JSON.stringify({ summary: 'Launch on May 11.', decisions: [{ title: 'Date', decision: 'May 11', alternatives: 'May 4', rationale: 'docs', by: 'Writer' }, { title: 'Venue', decision: 'Moon', alternatives: '', rationale: '', by: 'Editor', verdict: 'rejected' }], actions: [{ title: 'Book the room', owner: 'Editor', done_when: 'booked', outcome: '', by: 'Writer', taskKey: 'ENG-9' }], risks: [], questions: [] }) });
  await processes.tick(await s.org.get(orgId), new Date());
  await processes.settle();
  st = await stepsOf(s, processes, orgId, run.id);
  assert.equal(st.decide.status, 'done');
  const outs = JSON.parse(st.decide.outputs);
  assert.equal(outs.decide_decisions, 'Date: May 11', 'a rejected proposal is not an output');
  assert.equal(outs.decide_actions, 'Book the room — Editor (ENG-9)');
  assert.equal(outs.decide_summary, 'Launch on May 11.');
  assert.match((await processes.stepCardFor(orgId, st.follow.taskId!))!, /decide_decisions = Date: May 11 \(from "Decide the launch"\)/, 'the next step sees the decisions');
  // a cancelled meeting fails its step (and the run)
  const r2 = await processes.start(orgId, p.name, { initiator: 'user', vars: { launch: 'v4' } });
  await processes.settle();
  await finishTask(s, orgId, (await stepsOf(s, processes, orgId, r2.id)).prep.taskId!, { outputs: { options: 'x' }, p: processes });
  await processes.settle();
  await s.meetings.cancel(orgId, (await stepsOf(s, processes, orgId, r2.id)).decide.meetingId!, 'system', 'no channel');
  await processes.sweep(orgId);
  assert.equal((await processes.run(orgId, r2.id)).status, 'failed');
  assert.match((await processes.run(orgId, r2.id)).note, /its meeting was cancelled/);
});

// ---- 11. compensation: a saga on failure or cancellation ----

test('compensation: a cancelled run undoes its done steps latest first, one at a time, through ordinary tasks; the sweep repairs and resumes; a failed compensation leaves the run partial and tells the owner; a failed run compensates too', async () => {
  const s = await setup();
  const orgId = await company(s);
  const { processes, tools } = wire(s);
  const eng = (await s.units.ledBy(orgId, s.writer.id))!;
  const def = normalizeProcess({ title: 'Ship it', category: 'delivery', nodes: [
    { id: 'deploy', title: 'Deploy ${release}', compensate: 'undeploy' }, { id: 'announce', title: 'Announce', compensate: 'unannounce', lane: 'editor' }, { id: 'verify', title: 'Verify' },
    { id: 'undeploy', title: 'Roll back ${release}', compensation: true, must: ['The previous build is live'] }, { id: 'unannounce', title: 'Retract the announcement', compensation: true, lane: 'editor' },
  ], edges: [{ from: 'deploy', to: 'announce' }, { from: 'announce', to: 'verify' }] });
  const p = (await processes.author(orgId, { name: 'ship-it', def, unitId: eng.id, reason: 'test' }, 'user')).process;
  const run = await processes.start(orgId, p.name, { initiator: 'user', vars: { release: 'v7' } });
  await processes.settle();
  let st = await stepsOf(s, processes, orgId, run.id);
  await finishTask(s, orgId, st.deploy.taskId!);
  await processes.settle();
  await finishTask(s, orgId, (await stepsOf(s, processes, orgId, run.id)).announce.taskId!);
  await processes.settle();
  assert.match(await tools.execute(await sessionOf(s, s.writer.id), 'org_process_cancel', { run: run.key, reason: 'the release was pulled' }), /being undone/);
  await processes.settle();
  let r = await processes.run(orgId, run.id);
  assert.equal(r.status, 'cancelled');
  assert.equal(r.compensation, 'running');
  st = await stepsOf(s, processes, orgId, run.id);
  assert.ok(st['undo:announce'] && !st['undo:deploy'], 'the latest done step first, one at a time');
  const un = await s.tasks.get(orgId, st['undo:announce'].taskId!);
  assert.equal(un.assigneeAgentId, s.editor.id, 'the compensation step\'s lane');
  assert.equal(un.source, 'process');
  assert.match(JSON.parse(un.brief).context, /undo what step "Announce" did/);
  await finishTask(s, orgId, un.id);
  await processes.settle();
  st = await stepsOf(s, processes, orgId, run.id);
  assert.equal(st['undo:announce'].status, 'done');
  assert.ok(st['undo:deploy']?.taskId, 'then the next');
  const undeploy = await s.tasks.get(orgId, st['undo:deploy'].taskId!);
  assert.match(undeploy.title, /Roll back v7/);
  assert.deepEqual(parseSteps(undeploy.steps).map((x) => x.from), ['process:must'], 'its MUST items are the checklist');
  // a restart: the row lost its task — the sweep finds the orphan, never a second one
  await s.db.update(orgProcessSteps).set({ taskId: null }).where(eq(orgProcessSteps.id, st['undo:deploy'].id));
  await processes.sweep(orgId);
  assert.equal((await s.tasks.list(orgId)).filter((t) => t.processNodeId === 'undo:deploy').length, 1);
  assert.equal((await stepsOf(s, processes, orgId, run.id))['undo:deploy'].taskId, undeploy.id);
  // a compensation that cannot be done: partial, the owner is told
  await s.tasks.update(orgId, undeploy.id, { status: 'cancelled' }, 'user');
  await processes.settle();
  r = await processes.run(orgId, run.id);
  assert.equal(r.compensation, 'partial');
  assert.ok((await s.agents.listEvents(s.writer.id, 50)).some((e) => /compensation\(s\) not done/.test(e.title)));
  assert.ok((await processes.events(orgId, { runId: run.id })).some((e) => e.activity === 'compensation_done'));
  // a failed run compensates too
  const r2 = await processes.start(orgId, p.name, { initiator: 'user', vars: { release: 'v8' } });
  await processes.settle();
  await finishTask(s, orgId, (await stepsOf(s, processes, orgId, r2.id)).deploy.taskId!);
  await processes.settle();
  await s.tasks.update(orgId, (await stepsOf(s, processes, orgId, r2.id)).announce.taskId!, { status: 'cancelled' }, 'user');
  await processes.settle();
  const failed = await processes.run(orgId, r2.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.compensation, 'running');
  assert.ok((await stepsOf(s, processes, orgId, r2.id))['undo:deploy'], 'only the done step is undone');
  assert.ok(!(await stepsOf(s, processes, orgId, r2.id))['undo:announce']);
  const m = await processes.metrics(orgId, p.id);
  assert.ok(!m.steps.some((x) => x.nodeId.startsWith('undo:')), 'compensations are not counted as the process\'s steps');
});

// ---- 12. ramped rollout ----

test('a new version of a process with a track record ramps on a share of new runs; the cohorts are compared; the owner rolls back a worse one (others may not); with rampAuto the engine promotes a no-worse one', async () => {
  const s = await setup();
  const orgId = await company(s);
  const { processes, tools } = wire(s);
  const eng = (await s.units.ledBy(orgId, s.writer.id))!;
  for (const [k, v] of [['process.rampPercent', 50], ['process.rampMinRuns', 2], ['process.editApproval', 0]] as const) await s.org.setTunable(orgId, k, v, { actor: 'user', why: 'test', decidedBy: 'user' });
  const def1 = normalizeProcess({ title: 'Triage', category: 'operating', nodes: [{ id: 'work', title: 'Triage the ticket', should: ['Tag it'] }] });
  await processes.author(orgId, { name: 'triage', def: def1, unitId: eng.id, reason: 'test' }, 'user');
  const runOnce = async (deviateOn: number | null) => {
    const r = await processes.start(orgId, 'triage', { initiator: 'user' });
    await processes.settle();
    const st = await stepsOf(s, processes, orgId, r.id);
    if (r.version === deviateOn) await processes.deviate(orgId, st.work.taskId!, { level: 'should', item: 's1', reason: 'nothing to tag' }, `agent:${s.writer.id}`);
    await finishTask(s, orgId, st.work.taskId!);
    await processes.settle();
    return processes.run(orgId, r.id);
  };
  for (let i = 0; i < 3; i++) await runOnce(null);
  const v2 = await processes.author(orgId, { process: 'triage', def: { ...def1, description: 'a lighter card' }, reason: 'try a lighter card' }, `agent:${s.writer.id}`);
  assert.equal(v2.applied, true);
  assert.match(v2.note, /is ramping .*50% of new runs/);
  assert.equal(v2.process.version, 1, 'the stable version stays');
  assert.equal(v2.process.candidateVersionId, v2.version.id);
  assert.equal((await processes.version(orgId, v2.version.id)).status, 'candidate');
  const seen = { 1: 0, 2: 0 } as Record<number, number>;
  for (let i = 0; i < 40 && (seen[2] < 2 || seen[1] < 2); i++) seen[(await runOnce(2)).version]++;
  assert.ok(seen[1] >= 2 && seen[2] >= 2, `both cohorts ran (${JSON.stringify(seen)})`);
  const r = (await processes.rollout(orgId, 'triage'))!;
  assert.equal(r.verdict, 'rollback');
  assert.match(r.why, /worse on deviation/);
  assert.equal(r.rows.find((x) => x.metric === 'deviation')?.candidate, 1);
  await processes.periodic(orgId, new Date());
  assert.equal((await processes.get(orgId, 'triage')).rampVerdict, 'rollback');
  assert.ok((await s.agents.listEvents(s.writer.id, 80)).some((e) => /ramp: worse than v1/.test(e.title)), 'the owner is told');
  assert.ok((await processes.attentionFor(orgId, s.writer.id)).some((l) => /ramp says rollback/.test(l)));
  assert.match(await tools.execute(await sessionOf(s, s.writer.id), 'org_process_metrics', { process: 'triage' }), /Ramp: v2 on 50% of new runs vs v1 — rollback/);
  await assert.rejects(tools.execute(await sessionOf(s, s.editor.id), 'org_process_rollout', { process: 'triage', action: 'rollback' }), /its owner's to decide/);
  assert.match(await tools.execute(await sessionOf(s, s.writer.id), 'org_process_rollout', { process: 'triage', action: 'rollback', reason: 'tags were skipped' }), /v1 takes every new run/);
  assert.equal((await processes.version(orgId, v2.version.id)).status, 'rolled_back');
  assert.equal((await runOnce(null)).version, 1, 'new runs start on the stable version again');
  // the engine decides when the company says so
  await s.org.setTunable(orgId, 'process.rampAuto', 1, { actor: 'user', why: 'test', decidedBy: 'user' });
  const v3 = await processes.author(orgId, { process: 'triage', def: { ...def1, description: 'v3' }, reason: 'clearer', ramp: 50 }, 'user');
  assert.equal(v3.process.candidateVersionId, v3.version.id);
  for (let i = 0; i < 40 && (await processes.runs(orgId, { processId: v3.process.id })).filter((x) => x.versionId === v3.version.id && x.status === 'done').length < 2; i++) await runOnce(null);
  await processes.periodic(orgId, new Date());
  const after = await processes.get(orgId, 'triage');
  assert.equal(after.version, v3.version.version, 'promoted on the evidence');
  assert.equal(after.candidateVersionId, null);
  assert.ok((await processes.events(orgId, { processId: after.id })).some((e) => e.activity === 'ramp_promoted' && e.actor === 'engine'));
});

// ---- 13. conformance apart from outcomes; a revision suggestion ----

test('conformance: SHOULD skips and out-of-order steps count against it, apart from outcomes; a step most runs deviate from becomes a revision suggestion (once) for the owner; both reach the owner\'s context', async () => {
  const s = await setup();
  const orgId = await company(s);
  const { processes, tools } = wire(s);
  const eng = (await s.units.ledBy(orgId, s.writer.id))!;
  const def = normalizeProcess({ title: 'Publish', category: 'delivery', nodes: [{ id: 'write', title: 'Write it' }, { id: 'check', title: 'Check it', should: ['Run the spell check'] }], edges: [{ from: 'write', to: 'check' }] });
  const p = (await processes.author(orgId, { name: 'publish', def, unitId: eng.id, reason: 'test' }, 'user')).process;
  const runIds: string[] = [];
  for (let i = 0; i < 3; i++) {
    const r = await processes.start(orgId, p.name, { initiator: 'user' });
    runIds.push(r.id);
    await processes.settle();
    await finishTask(s, orgId, (await stepsOf(s, processes, orgId, r.id)).write.taskId!);
    await processes.settle();
    const check = (await stepsOf(s, processes, orgId, r.id)).check;
    await processes.deviate(orgId, check.taskId!, { level: 'should', item: 's1', reason: 'no spell checker', alternative: 'read it twice' }, `agent:${s.writer.id}`);
    await finishTask(s, orgId, check.taskId!);
    await processes.settle();
  }
  let c = await processes.conformance(orgId, p.id);
  assert.equal(c.shouldSkips, 3);
  assert.equal(c.outOfOrder, 0, 'the engine kept the order');
  assert.equal(c.verdict, 'drifting');
  assert.equal(c.steps.find((x) => x.nodeId === 'check')?.rate, 0);
  // a step that started before the one it waits on finished is out of order
  const st = await stepsOf(s, processes, orgId, runIds[0]);
  await s.db.update(orgProcessSteps).set({ startedAt: new Date(Date.parse(st.write.endedAt!) - 60_000).toISOString() }).where(eq(orgProcessSteps.id, st.check.id));
  c = await processes.conformance(orgId, p.id);
  assert.equal(c.outOfOrder, 1);
  const m = await processes.metrics(orgId, p.id);
  assert.equal(m.completionRate, 1, 'outcomes are fine — conformance is a separate question');
  assert.equal(m.health, 'revise');
  const made = await processes.suggestRevisions(orgId);
  assert.equal(made.length, 1);
  assert.equal(made[0].kind, 'revise');
  assert.equal(made[0].ownerAgentId, s.writer.id);
  assert.match(made[0].title, /Revise process: Publish — step "Check it"/);
  assert.match(made[0].evidence, /SHOULD s1: no spell checker/);
  const task = await s.tasks.get(orgId, made[0].taskId!);
  assert.equal(task.assigneeAgentId, s.writer.id);
  assert.equal(task.source, 'process');
  assert.equal((await processes.suggestRevisions(orgId)).length, 0, 'once per version and step');
  const lines = await processes.attentionFor(orgId, s.writer.id);
  assert.ok(lines.some((l) => /publish conformance \(apart from outcomes\): \d+% of steps followed the definition/.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => /suggested: Revise process: Publish/.test(l)));
  assert.match(await tools.execute(await sessionOf(s, s.writer.id), 'org_process_metrics', { process: p.name }), /Conformance \(did runs follow the definition\): drifting .*SHOULD skips 3, ad-hoc 0, out of order 1/s);
  // the owner cancels the task with why the step stays: the suggestion is dismissed
  await s.tasks.update(orgId, task.id, { status: 'cancelled' }, `agent:${s.writer.id}`);
  await processes.settle();
  assert.equal((await processes.suggestions(orgId))[0].status, 'dismissed');
});

// ---- 14. discovery from the task history ----

test('discovery: work done by hand on several days becomes a "Draft process" task for the unit\'s head with the evidence and a valid draft, once; dismissing the task dismisses it; the CEO may create the process from the draft', async () => {
  const s = await setup();
  const orgId = await company(s);
  const { processes, tools } = wire(s);
  const eng = (await s.units.ledBy(orgId, s.writer.id))!;
  const day = 86_400_000;
  const make = async (title: string, n: number) => {
    for (let i = 0; i < n; i++) {
      const t = await s.tasks.create(orgId, { title: `${title} ${i + 1}`, unitId: eng.id, assigneeAgentId: s.editor.id, createdBy: `agent:${s.writer.id}`, brief: { outcome: 'x', done_when: 'sent to the client' } });
      await s.db.update(orgTasks).set({ createdAt: new Date(Date.now() - (i + 1) * day).toISOString() }).where(eq(orgTasks.id, t.id));
    }
  };
  await make('Weekly report for client', 4);
  await make('Partner invoice check', 3);
  const made = await processes.discover(orgId);
  assert.deepEqual(made.map((x) => x.kind), ['recurring'], 'four times is a pattern; three is not yet (process.discoveryRepeats 4)');
  const sg = made[0];
  assert.equal(sg.ownerAgentId, s.writer.id, 'the head of the department the work lands in');
  assert.equal(sg.count, 4);
  const draft = JSON.parse(sg.draft) as ProcessDef;
  assert.deepEqual(validateProcess(draft), []);
  assert.equal(draft.nodes[0].lane, 'Editor', 'the lane the work went to');
  assert.equal(draft.nodes[0].doneWhen, 'sent to the client');
  const task = await s.tasks.get(orgId, sg.taskId!);
  assert.equal(task.title, 'Draft process: Weekly report for client');
  assert.equal(task.assigneeAgentId, s.writer.id);
  assert.match(JSON.parse(task.brief).context, /Evidence: .*Weekly report for client 1.*The engine's draft/);
  assert.equal((await processes.discover(orgId)).length, 0, 'suggested once');
  assert.match(await tools.execute(await sessionOf(s, s.writer.id), 'org_processes', { suggestions: true }), /Draft process: Weekly report for client \[recurring, seen 4×; owner Writer/);
  await s.tasks.update(orgId, task.id, { status: 'cancelled' }, `agent:${s.writer.id}`);
  await processes.settle();
  assert.equal((await processes.suggestions(orgId)).find((x) => x.id === sg.id)?.status, 'dismissed');
  await make('Partner invoice check', 1);
  const [second] = await processes.discover(orgId);
  assert.equal(second.title, 'Draft process: Partner invoice check');
  const accepted = await processes.decideSuggestion(orgId, second.id, 'accept', 'yes, every month', 'user');
  assert.equal(accepted.status, 'accepted');
  const created = await processes.get(orgId, accepted.processId!);
  assert.equal(created.title, 'Partner invoice check');
  assert.equal(created.unitId, eng.id);
  assert.equal((await s.tasks.get(orgId, second.taskId!)).status, 'cancelled', 'the owner\'s draft task is moot');
  await make('Quarterly audit pack', 5);
  await s.org.setTunable(orgId, 'process.discoveryRepeats', 0, { actor: 'user', why: 'test', decidedBy: 'user' });
  assert.deepEqual(await processes.discover(orgId), [], 'discovery off');
});

test('the library route sends each template with its definition, for the page\'s preview', async () => {
  const { ProcessesController } = await import('../server/src/org/processes.controller');
  const ctl = new ProcessesController({ orgIdOf: async () => 'o1' } as never, {} as never, {} as never, {} as never, { get: () => true } as never);
  const list = await ctl.templates('ws1');
  assert.equal(list.length, PROCESS_TEMPLATES.length);
  const rel = list.find((t) => t.id === 'release-checklist')!;
  assert.equal(rel.steps, rel.def.nodes.length);
  assert.deepEqual(rel.def.stages.map((x) => x.id), ['check', 'ship']);
});
