/** Improvement proposals and admission control (docs/improvements.md):
 *  capped, evidenced proposals on a target with a model-free change class
 *  (standard applies at once, normal is a decision card, emergency applies
 *  during an open incident and is reviewed after), applied through the
 *  target's own versioning and verified against a metric — a miss opens a
 *  revert proposal; a retro's actions become the top N proposals and only a
 *  concrete repair stays a task; self-started tasks enter within a per-unit
 *  WIP cap and a per-member rate cap, refused with remediation or parked;
 *  wakes from other agents draw on an attention budget; work sources are
 *  measured for the chief, the heads and the UI. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, enable, sessionOf, type S } from './org-governance-harness';
import { OrgProcessesService } from '../server/src/org/org-processes.service';
import { OrgImprovementsService } from '../server/src/org/org-improvements.service';
import { OrgImprovementsTools } from '../server/src/org/org-improvements.tools';
import {
  admissionOf, classify, isServiceRequest, originOf, parseExpected, parseTargetRef, routeActions, sourceShares, verdictOf,
} from '../server/src/org/improvement-model';
import { IMPROVEMENT_TUNABLES, deriveImprovementTunables } from '../server/src/org/improvement-tunables';
import { deriveOperatingSystem } from '../server/src/org/chief-os';
import { checkBoundary } from '../server/src/org/boundary';
import { parseMinutes, type Minutes } from '../server/src/org/org-meetings.service';
import { orgImprovements } from '../server/src/database/schema';
import { eq } from 'drizzle-orm';

function wire(s: S) {
  const processes = new OrgProcessesService(s.db, s.org, s.tasks, s.approvals, s.audit, s.agents, s.units, s.runtime, s.bus);
  const improvements = new OrgImprovementsService(s.db, s.org, s.tasks, s.approvals, s.audit, s.agents, s.meetings, s.units, s.runtime, processes, undefined, s.playbooks);
  const tools = new OrgImprovementsTools(s.org, improvements, s.config, s.runtime, s.turns);
  return { processes, improvements, tools };
}

/** Writer heads Engineering with Editor reporting to it. */
async function company(s: S, mode: 'supervised' | 'autonomous' = 'autonomous') {
  const orgId = await enable(s, mode);
  await s.org.updateMember(orgId, s.writer.id, { title: 'Head of Engineering' });
  await s.org.updateMember(orgId, s.editor.id, { reportsToAgentId: s.writer.id, title: 'Editor' });
  await s.units.syncMembership(orgId);
  return orgId;
}

const tune = async (s: S, orgId: string, values: Record<string, number>) => { for (const [k, v] of Object.entries(values)) await s.org.setTunable(orgId, k, v); };

// ---- 1. the pure model ----

test('model: targets, expected metrics, the change class, retro routing, origins and admission, verdicts, shares', () => {
  assert.deepEqual(parseTargetRef('process: release-checklist'), { kind: 'process', ref: 'release-checklist' });
  assert.deepEqual(parseTargetRef('standard:deliverable'), { kind: 'quality_standard', ref: 'deliverable' });
  assert.equal(parseTargetRef('vibes:x'), null);
  assert.deepEqual(parseExpected('process.deviationRate down by 0.1'), { metric: 'process.deviationRate', direction: 'down', by: 0.1 });
  assert.throws(() => parseExpected('happiness up'), /unknown metric/);
  const base = { target: 'process' as const, category: 'prevent' as const, incidentOpen: false, loosens: false, touchesControls: false, concrete: true };
  assert.equal(classify(base, { standardScope: 1, emergency: 1 }).cls, 'standard');
  assert.equal(classify(base, { standardScope: 0, emergency: 1 }).cls, 'normal', 'a rigour company approves every change');
  assert.equal(classify({ ...base, touchesControls: true }, { standardScope: 2, emergency: 1 }).cls, 'normal', 'a change to MUST items is approved');
  assert.equal(classify({ ...base, target: 'tunable' }, { standardScope: 2, emergency: 1 }).cls, 'normal', 'tunables are never standard');
  assert.equal(classify({ ...base, category: 'mitigate', incidentOpen: true, touchesControls: true }, { standardScope: 0, emergency: 1 }).cls, 'emergency');
  assert.equal(classify({ ...base, category: 'mitigate', incidentOpen: true }, { standardScope: 0, emergency: 0 }).cls, 'normal');
  assert.equal(classify({ ...base, target: 'cadence' }, { standardScope: 1, emergency: 1 }).cls, 'normal');
  assert.equal(classify({ ...base, target: 'cadence' }, { standardScope: 2, emergency: 1 }).cls, 'standard');
  // a retro: one concrete repair stays a task, the rest are ranked and capped
  const plan = routeActions([
    { title: 'Look into why drafts are late', owner: 'Writer', done_when: 'a note' },
    { title: 'Fix the broken link in issue 7', owner: 'Editor', done_when: 'the link works', category: 'repair' },
    { title: 'Add a fact-check step', owner: 'Writer', done_when: 'step exists', category: 'prevent', target: 'process:content-publishing' },
    { title: 'Alert when a draft is two days late', owner: 'Writer', done_when: 'alert fires', category: 'detect' },
    { title: 'Rejected idea', owner: 'Writer', done_when: 'x', verdict: 'rejected' },
  ], { perMeeting: 2, repairTasks: true });
  assert.deepEqual(plan, ['over_cap', 'task', 'proposal', 'proposal', 'skip']);
  assert.deepEqual(routeActions([{ title: 'Fix the broken link', owner: 'Editor', done_when: 'works', category: 'repair' }], { perMeeting: 2, repairTasks: false }), ['proposal'], 'improve.repairTasks 0: every action is a proposal');
  // origins and admission
  const chief = 'c1';
  assert.equal(originOf({ source: 'agent', createdBy: 'agent:c1' }, chief), 'chief');
  assert.equal(originOf({ source: 'agent', createdBy: 'agent:w' }, chief), 'agent');
  assert.equal(originOf({ source: 'process', createdBy: 'process' }, chief), 'process');
  assert.equal(originOf({ source: 'retro', createdBy: 'agent:w' }, chief), 'retro');
  assert.equal(originOf({ source: 'chat', createdBy: 'user' }, chief), 'human');
  assert.ok(isServiceRequest({ source: 'service' }) && isServiceRequest({ serviceId: 'svc-1' }) && isServiceRequest({ brief: { constraints: 'service: design-review' } }), 'service requests, tolerant of fields that do not exist yet');
  assert.equal(admissionOf({ source: 'agent', createdBy: 'agent:w', projectKind: 'unsorted' }, chief).self, true);
  assert.equal(admissionOf({ source: 'agent', createdBy: 'agent:w', projectKind: 'project' }, chief).self, false, 'work under a project bet is planned');
  assert.equal(admissionOf({ source: 'agent', createdBy: 'agent:w', parentTaskId: 't1' }, chief).self, false, 'a subtask of admitted work');
  assert.equal(admissionOf({ source: 'service', createdBy: 'agent:w' }, chief).self, false);
  assert.equal(admissionOf({ source: 'proposal', createdBy: 'improvement:x' }, chief).self, false);
  // verdicts
  assert.equal(verdictOf({ metric: 'process.deviationRate', direction: 'down', by: 0.1 }, 0.4, 0.25), 'pass');
  assert.equal(verdictOf({ metric: 'process.deviationRate', direction: 'down', by: 0.1 }, 0.4, 0.35), 'fail');
  assert.equal(verdictOf({ metric: 'quality.firstPassYield', direction: 'up', by: 0 }, 0.7, 0.7), 'pass', 'by 0: must not get worse');
  assert.equal(verdictOf(null, 1, 2), 'unverifiable');
  const sh = sourceShares([
    { origin: 'retro', projectKind: 'operating', createdAt: '', status: 'todo', unitId: null },
    { origin: 'agent', projectKind: 'unsorted', createdAt: '', status: 'todo', unitId: null },
    { origin: 'plan', projectKind: 'project', createdAt: '', status: 'todo', unitId: null },
    { origin: 'process', projectKind: 'operating', createdAt: '', status: 'done', unitId: null },
  ]);
  assert.equal(sh.total, 4); assert.equal(sh.selfShare, 0.5); assert.equal(sh.systemShare, 0.75); assert.equal(sh.retroShare, 0.25);
});

test('tunables: derived from values and culture within bounds; a control culture approves every change and keeps self-started work small; the boundary reserves them', () => {
  const formal = deriveOperatingSystem({ values: 'Process, compliance and audit', culture: 'formal approvals and control' });
  const fast = deriveOperatingSystem({ values: 'Experiment boldly, move fast', culture: 'iterate and explore' });
  const val = (os: ReturnType<typeof deriveOperatingSystem>, k: string) => os.tunables.find((t) => t.key === k)?.value;
  for (const k of Object.keys(IMPROVEMENT_TUNABLES)) assert.ok(fast.tunables.some((t) => t.key === k), `derived ${k}`);
  assert.equal(val(formal, 'improve.standardScope'), 0);
  assert.equal(val(fast, 'improve.standardScope'), 2);
  assert.ok(val(formal, 'admission.selfWip')! < val(fast, 'admission.selfWip')!);
  assert.equal(val(formal, 'admission.overCap'), 0);
  assert.equal(val(fast, 'admission.overCap'), 1);
  for (const t of deriveImprovementTunables({ stage: 'scale', cultureType: 'clan', speed: true, rigor: true })) { const d = IMPROVEMENT_TUNABLES[t.key]; assert.ok(t.value >= d.min && t.value <= d.max, t.key); }
  for (const k of ['improve.perMeeting', 'admission.selfWip', 'attention.agentWakesPerHour']) assert.equal(checkBoundary({ kind: 'tunable', key: k }, 'chief').outcome, 'card', `${k} is proposed, not set alone`);
});

// ---- 2. proposals: refusals, caps, standard and normal changes, verification and revert ----

test('a proposal needs evidence and a hypothesis; a standard change by the owner applies as a new process version; a normal one is a decision card; the per-target cap refuses a second', async () => {
  const s = await setup();
  const orgId = await company(s);
  const { processes, improvements } = wire(s);
  const p = await processes.instantiate(orgId, 'weekly-review-pack');
  const def = await processes.activeDef(orgId, p);
  await assert.rejects(improvements.createProposal(orgId, { title: 'Shorter pack', target: `process:${p.name}`, evidence: [], hypothesis: 'x' }, `agent:${s.chief.id}`), /needs evidence/);
  await assert.rejects(improvements.createProposal(orgId, { title: 'Shorter pack', target: `process:${p.name}`, evidence: ['PR-1 took 3 days'], hypothesis: '' }, `agent:${s.chief.id}`), /needs a hypothesis/);
  // the chief owns company processes: a wording change is standard and applies at once
  const std = await improvements.createProposal(orgId, {
    title: 'Clarify the pack', target: `process:${p.name}`, evidence: ['runs PR-1, PR-2 asked what the pack is for'], hypothesis: 'A clear purpose cuts questions.',
    change: { def: { ...def, description: 'The weekly numbers, the risks and the asks, in one page.' } }, expected: 'process.cycleHours down', category: 'prevent',
  }, `agent:${s.chief.id}`);
  assert.equal(std.proposal.changeClass, 'standard');
  assert.equal(std.proposal.status, 'applied', std.text);
  assert.match(std.proposal.appliedRef, /process version 2/);
  assert.equal((await processes.get(orgId, p.name)).version, 2, 'applied through the process\'s own versioning');
  assert.equal((await processes.versions(orgId, p.id))[0].author, `improvement:${std.proposal.key}`);
  assert.ok(std.proposal.verifyAt, 'a verification window');
  // a second proposal on the same target waits until the first settles
  await assert.rejects(improvements.createProposal(orgId, { title: 'Another', target: `process:${p.name}`, evidence: ['x'], hypothesis: 'y' }, `agent:${s.editor.id}`), /improve\.maxOpenPerTarget/);
  // a specialist's change to the company's process is normal: a card to its manager
  const p2 = await processes.instantiate(orgId, 'release-checklist');
  const def2 = await processes.activeDef(orgId, p2);
  const norm = await improvements.createProposal(orgId, {
    title: 'Ask for the changelog first', target: `process:${p2.name}`, evidence: ['ENG-3 shipped without notes'], hypothesis: 'Notes written first are never forgotten.',
    change: { def: { ...def2, description: 'Changelog first.' } }, category: 'prevent',
  }, `agent:${s.editor.id}`);
  assert.equal(norm.proposal.changeClass, 'normal');
  assert.equal(norm.proposal.status, 'proposed');
  const card = (await s.approvals.list(orgId)).find((a) => a.id === norm.proposal.approvalId)!;
  assert.equal(card.kind, 'improvement');
  assert.equal(card.holder, `agent:${s.writer.id}`, 'routed to the proposer\'s manager');
  await s.approvals.decide(orgId, card.id, 'approve', 'go', 'user');
  const after = await improvements.get(orgId, norm.proposal.id);
  assert.equal(after.status, 'applied');
  assert.equal((await processes.get(orgId, p2.name)).version, 2);
  // a rejected card rejects the proposal
  const tun = await improvements.createProposal(orgId, { title: 'Fewer proposals per retro', target: 'tunable:improve.perMeeting', evidence: ['IM-1 and IM-2 were never verified'], hypothesis: 'Fewer changes, each measured.', change: { value: 1 } }, `agent:${s.writer.id}`);
  const tcard = (await s.approvals.list(orgId)).find((a) => a.id === tun.proposal.approvalId)!;
  assert.match(tcard.reserved, /CEO|boundary/, 'a tunable change is the CEO\'s');
  await s.approvals.decide(orgId, tcard.id, 'reject', 'not now', 'user');
  assert.equal((await improvements.get(orgId, tun.proposal.id)).status, 'rejected');
});

test('verification: a met metric verifies; a missed one opens a revert proposal that rolls the process back and marks the original reverted; an unanswered proposal expires', async () => {
  const s = await setup();
  const orgId = await company(s);
  const { processes, improvements } = wire(s);
  const p = await processes.instantiate(orgId, 'weekly-review-pack');
  const def = await processes.activeDef(orgId, p);
  let value = 0.5;
  improvements.measure = async () => value;
  const r = await improvements.createProposal(orgId, { title: 'Cut a section', target: `process:${p.name}`, evidence: ['deviation 50% on the risks step'], hypothesis: 'Nobody reads it.', change: { def: { ...def, description: 'shorter' } }, expected: 'process.deviationRate down by 0.1' }, `agent:${s.chief.id}`);
  assert.equal(r.proposal.baseline, 0.5);
  value = 0.45; // missed: only 0.05 better
  const later = new Date(Date.now() + 40 * 86_400_000);
  improvements.now = () => later;
  await improvements.sweep(orgId);
  const revert = (await improvements.list(orgId)).find((x) => x.revertOf === r.proposal.id)!;
  assert.ok(revert, 'a revert proposal');
  assert.equal(revert.origin, 'verification');
  assert.match(JSON.parse(revert.change).rollbackTo.toString(), /^1$/);
  assert.equal((await improvements.get(orgId, r.proposal.id)).status, 'applied', 'still applied until the revert lands');
  assert.equal(JSON.parse((await improvements.get(orgId, r.proposal.id)).verification).outcome, 'fail');
  if (revert.status === 'proposed') await s.approvals.decide(orgId, revert.approvalId!, 'approve', '', 'user');
  assert.equal((await improvements.get(orgId, r.proposal.id)).status, 'reverted');
  assert.equal((await processes.get(orgId, p.name)).version, 3, 'rolled back as a new version');
  // a met metric verifies
  const p2 = await processes.instantiate(orgId, 'release-checklist');
  const d2 = await processes.activeDef(orgId, p2);
  improvements.now = () => new Date();
  value = 0.4;
  const ok = await improvements.createProposal(orgId, { title: 'Tighter', target: `process:${p2.name}`, evidence: ['x'], hypothesis: 'y', change: { def: { ...d2, description: 'z' } }, expected: 'process.deviationRate down by 0.1' }, `agent:${s.chief.id}`);
  value = 0.2;
  improvements.now = () => later;
  await improvements.sweep(orgId);
  assert.equal((await improvements.get(orgId, ok.proposal.id)).status, 'verified');
  // expiry
  improvements.now = () => new Date();
  const q = await improvements.createProposal(orgId, { title: 'Prose only', evidence: ['lessons repeat'], hypothesis: 'h' }, `agent:${s.editor.id}`);
  assert.equal(q.proposal.status, 'proposed');
  improvements.now = () => later;
  await improvements.sweep(orgId);
  assert.equal((await improvements.get(orgId, q.proposal.id)).status, 'expired');
});

test('emergency: a mitigation while its incident is open applies at once with an after-the-fact review; rejected in review, it is reverted', async () => {
  const s = await setup();
  const orgId = await company(s);
  const { improvements } = wire(s);
  await tune(s, orgId, { 'improve.standardScope': 0 });
  const { incident } = await s.incidents.open(orgId, { kind: 'manual', title: 'Posts go out unchecked', detail: 'x', severity: 'minor', detectedBy: 'owner' });
  const retro = (await s.meetings.cadences(orgId)).find((c) => c.kind === 'retro')!;
  const r = await improvements.createProposal(orgId, { title: 'Pause the retro until fixed', target: 'cadence:retro', evidence: [`incident:${incident.id}`], hypothesis: 'Stop the bleeding.', change: { enabled: false }, category: 'mitigate', incidentId: incident.id }, `agent:${s.writer.id}`);
  assert.equal(r.proposal.changeClass, 'emergency');
  assert.equal(r.proposal.status, 'applied');
  assert.equal(r.proposal.reviewPending, 1);
  assert.equal((await s.meetings.cadences(orgId)).find((c) => c.id === retro.id)!.enabled, 0);
  await s.approvals.decide(orgId, r.proposal.approvalId!, 'reject', 'too blunt', 'user');
  assert.equal((await improvements.get(orgId, r.proposal.id)).status, 'reverted');
  assert.equal((await s.meetings.cadences(orgId)).find((c) => c.id === retro.id)!.enabled, retro.enabled, 'the cadence is back');
});

// ---- 3. the minutes executor ----

test('a retro emits its top proposals instead of raw tasks; a concrete repair stays a task; the rest are kept as not raised; a refused task is parked as a proposal', async () => {
  const s = await setup();
  const orgId = await company(s);
  const { improvements } = wire(s);
  const root = await s.units.rootUnit(orgId);
  const m = await s.meetings.create(orgId, { kind: 'retro', unitId: root.id, facilitatorAgentId: s.chief.id });
  const minutes: Minutes = { ...parseMinutes(null), actions: [
    { title: 'Look into late drafts', owner: 'Writer', done_when: 'a note', outcome: '', by: s.writer.id },
    { title: 'Fix the broken link in issue 7', owner: 'Editor', done_when: 'the link works', outcome: '', by: s.editor.id, category: 'repair' },
    { title: 'Raise the deliverable bar', owner: 'Writer', done_when: 'bar raised', outcome: 'Fewer reworks', by: s.writer.id, category: 'prevent', evidence: 'ENG-1 reworked twice', expected: 'quality.reworkRate down' },
    { title: 'Alert on late drafts', owner: 'Writer', done_when: 'alert', outcome: '', by: s.writer.id, category: 'detect' },
  ] };
  const before = (await s.tasks.list(orgId)).length;
  const out = await s.meetings.materialise(orgId, m, minutes);
  const a = out.minutes.actions;
  assert.ok(a[1].taskId, 'the concrete repair is a task');
  assert.ok(a[2].proposalId && a[3].proposalId, 'the top two are proposals');
  assert.equal(a[0].disposition, 'over_cap');
  assert.match(a[0].note!, /improve\.perMeeting/);
  assert.equal((await s.tasks.list(orgId)).length, before + 1, 'one task, not four');
  const prop = await improvements.get(orgId, a[2].proposalId!);
  assert.equal(prop.origin, 'retro');
  assert.match(prop.evidence, /ENG-1 reworked twice/);
  assert.match(s.meetings.renderMinutes(m, out.minutes, new Map()), /proposal IM-\d/);
  // the admission cap refuses the repair task: it is parked as a proposal instead
  await tune(s, orgId, { 'admission.selfWip': 0 });
  const m2 = await s.meetings.create(orgId, { kind: 'retro', unitId: root.id, facilitatorAgentId: s.chief.id });
  const out2 = await s.meetings.materialise(orgId, m2, { ...parseMinutes(null), actions: [{ title: 'Fix the typo on the pricing page', owner: 'Editor', done_when: 'fixed', outcome: '', by: s.editor.id, category: 'repair' }] });
  const x = out2.minutes.actions[0];
  assert.ok(!x.taskId);
  assert.ok(x.proposalId, `parked as a proposal (${x.note ?? ''})`);
});

// ---- 4. admission control and the attention budget ----

test('admission: self-started tasks beyond the unit\'s cap are refused with remediation (or parked); process steps, subtasks, project work and the chief\'s are not counted', async () => {
  const s = await setup();
  const orgId = await company(s);
  const { improvements } = wire(s);
  await tune(s, orgId, { 'admission.selfWip': 2, 'admission.selfPerDay': 10, 'admission.overCap': 0 });
  const by = `agent:${s.editor.id}`;
  const t1 = await s.tasks.create(orgId, { title: 'Tidy the style guide', createdBy: by, assigneeAgentId: s.editor.id });
  await s.tasks.create(orgId, { title: 'Write a checklist about checklists', createdBy: by, assigneeAgentId: s.editor.id });
  await assert.rejects(s.tasks.create(orgId, { title: 'A third meta task', createdBy: by, assigneeAgentId: s.editor.id }), (err: Error) => /refused: .* 2 of 2 open self-started tasks \(admission\.selfWip\)/.test(err.message) && /org_improvement_propose/.test(err.message) && /service request/.test(err.message));
  // legitimate entries pass
  await s.tasks.create(orgId, { title: 'Subtask', createdBy: by, parentTaskId: t1.id, assigneeAgentId: s.editor.id });
  await s.tasks.create(orgId, { title: 'Chief triage', createdBy: `agent:${s.chief.id}` });
  await s.tasks.create(orgId, { title: 'From the CEO', createdBy: 'user' });
  await s.tasks.create(orgId, { title: 'A service request', createdBy: by, source: 'service' });
  // parked instead of refused
  await tune(s, orgId, { 'admission.overCap': 1 });
  const parked = await s.tasks.create(orgId, { title: 'Parked meta task', createdBy: by, assigneeAgentId: s.editor.id });
  assert.equal(parked.status, 'backlog');
  assert.equal(parked.assigneeAgentId, null, 'nobody is woken for it');
  // measured
  const w = await improvements.workSources(orgId, { days: 7 });
  assert.ok(w.byOrigin.agent >= 3 && w.byOrigin.chief === 1 && w.byOrigin.human === 1 && w.byOrigin.service === 1, JSON.stringify(w.byOrigin));
  assert.equal(w.admission.refused, 1);
  assert.equal(w.admission.parked, 1);
  assert.ok(w.selfShare! > 0);
});

test('attention budget: wakes from other agents beyond the hour\'s budget are deferred, never dropped; people\'s and the chief\'s are not counted; the chief and heads see work sources in context', async () => {
  const s = await setup();
  const orgId = await company(s);
  const { improvements, tools } = wire(s);
  await tune(s, orgId, { 'attention.agentWakesPerHour': 2 });
  const ev = (by: string) => ({ orgId, taskId: 't', agentId: s.editor.id, reason: 'comment' as const, by });
  assert.equal(await improvements.attention(ev(`agent:${s.writer.id}`)), 0);
  assert.equal(await improvements.attention(ev(`agent:${s.writer.id}`)), 0);
  assert.ok((await improvements.attention(ev(`agent:${s.writer.id}`))) > 0, 'the third waits');
  assert.equal(await improvements.attention(ev('user')), 0, 'a person is never deferred');
  assert.equal(await improvements.attention(ev(`agent:${s.chief.id}`)), 0, 'the chief is not counted');
  assert.equal(await improvements.attention({ ...ev(`agent:${s.writer.id}`), reason: 'review' as never }), 0, 'reviews are not counted');
  await s.tasks.create(orgId, { title: 'Some work', createdBy: `agent:${s.editor.id}` });
  const chiefCtx = await tools.contextFor(await sessionOf(s, s.chief.id));
  assert.match(chiefCtx ?? '', /Work sources \(7d\): \d+ new task/);
  assert.equal(await tools.contextFor(await sessionOf(s, s.editor.id)), null, 'a specialist gets no extra context');
  const listed = await tools.execute(await sessionOf(s, s.editor.id), 'org_improvements', { sources: true });
  assert.match(listed, /Self-started work per unit/);
  const raised = await tools.execute(await sessionOf(s, s.editor.id), 'org_improvement_propose', { title: 'Shorter standups', target: 'cadence:standup', evidence: ['standups ran 40 minutes'], hypothesis: 'Async status first.', change: { cron: '30 9 * * 1,3,5' } });
  assert.match(raised, /IM-1 proposed \(normal change/);
  const row = (await s.db.select().from(orgImprovements).where(eq(orgImprovements.orgId, orgId)))[0];
  assert.equal(row.owner, `agent:${s.chief.id}`, 'the root unit\'s cadence is the chief\'s');
});
