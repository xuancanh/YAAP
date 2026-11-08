/** CEO alignment gates (docs/alignment.md): the classes as data, the
 *  criteria and the owner's classification (with the supervised floor),
 *  draft → in alignment → aligned through the CEO's card (approve with
 *  changes, send back, reject), bundles, the task gate (discovery cap,
 *  operating exemptions, the Unsorted cap, moves), material vs cosmetic
 *  change, autonomous auto / chief alignment, the CEO's pull-in and "not
 *  needed", and the spot-checks. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup as harness, enable, sessionOf, inbox } from './org-governance-harness';
import { OrgAlignmentService } from '../server/src/org/org-alignment.service';
import { OrgAlignmentTools } from '../server/src/org/org-alignment.tools';
import { AgentMemoryService } from '../server/src/agents/agent-memory.service';
import { memStorage } from './helpers';
import { OrgProjectsService } from '../server/src/org/org-projects.service';
import {
  ALIGNMENT_CLASS_DEFS, ALIGNMENT_SOURCES, ALIGNMENT_TUNABLES, alignerFor, assessCriteria, deriveAlignmentTunables, floorRequired, isAlignmentExempt, isDiscovery,
  materialChanges, snapshotOfGoal, textDistance,
} from '../server/src/org/alignment';
import { deriveOperatingSystem } from '../server/src/org/chief-os';
import { checkBoundary, ruleFor } from '../server/src/org/boundary';
import { needPresentation } from '../server/src/home/feed-titles';

async function setup(mode: 'supervised' | 'autonomous' = 'supervised') {
  const s = await harness();
  const memory = new AgentMemoryService(s.db, memStorage().stub);
  const alignment = new OrgAlignmentService(s.db, s.org, s.tasks, s.approvals, s.audit, s.agents, s.workspaces, s.intent, s.runtime, s.units, memory);
  const tools = new OrgAlignmentTools(s.org, alignment, s.config, s.runtime, s.turns);
  // The placement rule (every task has a project: the unit's Unsorted), as OrgModule wires it.
  new OrgProjectsService(s.db, s.org, s.tasks, s.approvals, s.audit, s.agents, s.units, undefined, s.decisions);
  const orgId = await enable(s, mode);
  return { ...s, alignment, tools, memory, orgId };
}
type A = Awaited<ReturnType<typeof setup>>;
const agent = (id: string) => `agent:${id}`;
const exec = async (s: A, agentId: string, name: string, input: Record<string, unknown>) => s.tools.execute(await sessionOf(s, agentId), name, input);
const BRIEF = { what: 'Double weekly active readers this quarter', why: 'Retention is flat and readers drive revenue', options: ['Do nothing', 'Paid acquisition instead'], tradeoffs: 'Less time for the redesign', measures: 'Weekly active readers from 1k to 2k by Dec 31', cost: 'Two members for a quarter, $40/month', unlocks: 'The referral project and the onboarding emails' };

test('the classes are data with criteria, rationale and sources; tunables derive from the profile within bounds', () => {
  assert.ok(ALIGNMENT_CLASS_DEFS.length >= 8);
  for (const c of ALIGNMENT_CLASS_DEFS) {
    assert.ok(c.rationale && c.covers && c.examples.length, c.id);
    for (const src of c.sources) assert.ok(ALIGNMENT_SOURCES[src], `${c.id} cites ${src}`);
    assert.ok(ALIGNMENT_TUNABLES[`alignment.required.${c.id}`] && ALIGNMENT_TUNABLES[`alignment.floor.${c.id}`]);
  }
  const control = deriveAlignmentTunables({ stage: 'growth', cultureType: 'hierarchy', speed: false, rigor: true });
  const fast = deriveAlignmentTunables({ stage: 'early', cultureType: 'adhocracy', speed: true, rigor: false });
  const v = (rows: typeof control, k: string) => rows.find((t) => t.key === k)!.value;
  assert.equal(v(control, 'alignment.required.direction'), 2);
  assert.equal(v(fast, 'alignment.required.direction'), 0);
  assert.ok(v(control, 'alignment.tolerance.targetShare') < v(fast, 'alignment.tolerance.targetShare'));
  for (const t of [...control, ...fast]) { const d = ALIGNMENT_TUNABLES[t.key]; assert.ok(t.value >= d.min && t.value <= d.max, t.key); }
  // onboarding derives them too
  assert.ok(deriveOperatingSystem({ values: 'process, compliance', culture: 'formal approval' }).tunables.some((t) => t.key === 'alignment.floor.budget'));
  // mode: supervised is the CEO; autonomous reads the tunable; off is open
  assert.equal(alignerFor(null, 'supervised', 'okr'), 'ceo');
  assert.equal(alignerFor(null, 'autonomous', 'okr'), 'auto');
  assert.equal(alignerFor(null, 'autonomous', 'direction'), 'chief');
  assert.equal(alignerFor(null, 'off', 'direction'), 'auto');
  assert.equal(floorRequired(null, 'supervised', 'okr'), true);
  assert.equal(floorRequired(null, 'supervised', 'projectBet'), false);
  assert.equal(floorRequired(null, 'autonomous', 'okr'), false);
});

test('criteria, material change and exemptions are model-free', () => {
  assert.equal(assessCriteria({ reversibility: 'two_way', blastRadius: 'unit', novelty: 'within' }, 0.2).needs, false);
  const ext = assessCriteria({ externalCommitment: true }, 0.2);
  assert.equal(ext.needs, true); assert.equal(ext.suggestedClass, 'externalCommitment');
  assert.equal(assessCriteria({ costShare: 0.25 }, 0.2).suggestedClass, 'budget');
  assert.equal(assessCriteria({ blastRadius: 'cross_unit', novelty: 'extends' }, 0.2).needs, true);
  const tol = { targetShare: 0.1, days: 14, textShare: 0.5 };
  const kr = { title: 'Grow weekly readers to 2000', kind: 'key_result', metric: 'readers', targetValue: 2000, dueAt: '2026-12-31', parentGoalId: 'o1' };
  assert.deepEqual(materialChanges(snapshotOfGoal(kr), snapshotOfGoal({ ...kr, title: 'Grow weekly readers to 2,000', targetValue: 2100, dueAt: '2027-01-05' }), tol), [], 'cosmetic');
  assert.ok(materialChanges(snapshotOfGoal(kr), snapshotOfGoal({ ...kr, targetValue: 3000 }), tol).some((r) => /target moved/.test(r)));
  assert.ok(materialChanges(snapshotOfGoal(kr), snapshotOfGoal({ ...kr, metric: 'signups' }), tol).some((r) => /metric/.test(r)));
  assert.ok(materialChanges(snapshotOfGoal(kr), snapshotOfGoal({ ...kr, dueAt: '2027-03-01' }), tol).some((r) => /due date/.test(r)));
  assert.ok(textDistance('a b c', 'a b c') === 0);
  assert.equal(isAlignmentExempt({ source: 'incident' }), true);
  assert.equal(isAlignmentExempt({ source: 'process', processCategory: 'operating' }), true);
  assert.equal(isAlignmentExempt({ source: 'process', process: { category: 'delivery' } }), false);
  assert.equal(isAlignmentExempt({ source: 'agent', projectKind: 'operating' }), true);
  assert.equal(isAlignmentExempt({ source: 'agent' }), false);
  assert.equal(isDiscovery({ class: 'discovery' }), true);
  assert.equal(isDiscovery({ brief: { constraints: 'discovery: size the market' } }), true);
  assert.equal(ruleFor({ kind: 'alignment', key: 'ceo' }).verdict, 'propose');
  assert.equal(checkBoundary({ kind: 'alignment', key: 'auto' }, 'chief').outcome, 'proceed');
  assert.equal(checkBoundary({ kind: 'tunable', key: 'alignment.floor.okr' }, 'chief').outcome, 'card');
});

test('supervised: an agent\'s objective is a draft; tasks under it are refused except capped discovery; the CEO aligns it with changes and its key results come along', async () => {
  const s = await setup('supervised');
  const obj = await s.units.addGoal(s.orgId, { title: 'Grow the readership', kind: 'objective' }, agent(s.writer.id));
  const kr = await s.units.addGoal(s.orgId, { title: 'Weekly readers to 2000', kind: 'key_result', parentGoalId: obj.id, metric: 'readers', targetValue: 2000, dueAt: '2026-12-31' }, agent(s.writer.id));
  const p = await s.org.addProject(s.orgId, { title: 'Referral loop', goalIds: [kr.id], kind: 'project' }, 'user');
  const rows = await s.alignment.list(s.orgId);
  assert.equal(rows.find((r) => r.itemId === obj.id)?.state, 'draft');
  assert.equal(rows.find((r) => r.itemId === obj.id)?.needsAlignment, true, 'OKRs are the supervised floor');
  assert.equal(rows.find((r) => r.itemId === p.id)?.state, 'aligned', 'the CEO\'s own project is aligned by being written');

  await assert.rejects(s.tasks.create(s.orgId, { title: 'Build the referral page', projectId: p.id, createdBy: agent(s.writer.id) }), /key result "Weekly readers to 2000" is not aligned with the CEO yet.*org_request_alignment.*discovery/s);
  // discovery up to the cap, then refused
  await s.tasks.create(s.orgId, { title: 'Size the referral opportunity', projectId: p.id, class: 'discovery', createdBy: agent(s.writer.id) });
  await s.tasks.create(s.orgId, { title: 'Interview five readers', projectId: p.id, class: 'discovery', createdBy: agent(s.writer.id) });
  await assert.rejects(s.tasks.create(s.orgId, { title: 'A third look', projectId: p.id, class: 'discovery', createdBy: agent(s.writer.id) }), /discovery cap is reached/);
  // operating work and people are not gated
  await s.tasks.create(s.orgId, { title: 'Fix the outage', projectId: p.id, source: 'incident', createdBy: agent(s.writer.id) });
  await s.tasks.create(s.orgId, { title: 'Process step', projectId: p.id, source: 'agent', createdBy: agent(s.writer.id), processCategory: 'operating', processRunId: 'run-1' } as never);
  await s.tasks.create(s.orgId, { title: 'CEO task', projectId: p.id, createdBy: 'user' });

  // the brief is checked model-free
  await assert.rejects(exec(s, s.writer.id, 'org_request_alignment', { item: obj.id, brief: { what: 'More readers' } }), /brief is missing/);
  const out = await exec(s, s.writer.id, 'org_request_alignment', { item: obj.id, brief: BRIEF });
  assert.match(out, /from the CEO.*with 1 child item/);
  const card = (await s.approvals.pending(s.orgId)).find((a) => a.kind === 'alignment')!;
  assert.ok(card);
  const payload = JSON.parse(card.payload);
  assert.equal(payload.what, BRIEF.what);
  assert.equal(payload.boundaryRule, 'alignment:ceo');
  const pres = needPresentation({ kind: 'approval', subkind: 'alignment', title: '', detail: '', requestedBy: 'Writer', facts: payload } as never);
  assert.match(pres.title, /Align on the objective: Grow the readership/);
  assert.equal((await s.alignment.list(s.orgId)).find((r) => r.itemId === kr.id)?.state, 'in_alignment');

  // a discussion: the CEO comments, the owner hears it and replies
  const v = (await s.alignment.list(s.orgId)).find((r) => r.itemId === obj.id)!;
  await s.alignment.comment(s.orgId, v.id, 'Why not paid acquisition first?', 'user');
  assert.ok((await inbox(s, s.writer.id)).some((e) => /The CEO commented/.test(e.title)));
  await exec(s, s.writer.id, 'org_alignment_comment', { item: obj.id, text: 'Paid costs 5x per reader at our size.' });
  assert.equal((await s.alignment.get(s.orgId, v.id)).thread.filter((e) => e.kind === 'comment').length, 2);

  await s.approvals.decide(s.orgId, card.id, 'approve', 'Cap paid tests at $20');
  const after = await s.alignment.list(s.orgId);
  const o = after.find((r) => r.itemId === obj.id)!;
  assert.equal(o.state, 'aligned');
  assert.equal(o.conditions, 'Cap paid tests at $20');
  assert.equal(o.alignedVia, 'ceo');
  assert.equal(after.find((r) => r.itemId === kr.id)?.state, 'aligned', 'the bundle came along');
  const t = await s.tasks.create(s.orgId, { title: 'Build the referral page', projectId: p.id, createdBy: agent(s.writer.id) });
  assert.ok(t.id);
  assert.ok((await inbox(s, s.writer.id)).some((e) => /^Aligned: objective/.test(e.title)));

  // a cosmetic edit keeps it aligned; a material one re-opens it and gates again
  await s.org.updateGoal(s.orgId, kr.id, { title: 'Weekly readers to 2,000', targetValue: 2050 }, agent(s.writer.id));
  assert.equal((await s.alignment.list(s.orgId)).find((r) => r.itemId === kr.id)?.state, 'aligned');
  await s.org.updateGoal(s.orgId, kr.id, { targetValue: 5000 }, agent(s.writer.id));
  const re = (await s.alignment.list(s.orgId)).find((r) => r.itemId === kr.id)!;
  assert.equal(re.state, 'realign');
  assert.match(re.reopenReasons.join(' '), /target moved/);
  await assert.rejects(s.tasks.create(s.orgId, { title: 'More work', projectId: p.id, createdBy: agent(s.writer.id) }), /changed materially/);
  // the CEO's own edit re-baselines (still realign until aligned — but CEO aligning directly works)
  await s.alignment.ceoAct(s.orgId, re.id, 'approve', '', 'user');
  assert.equal((await s.alignment.get(s.orgId, re.id)).state, 'aligned');
});

test('send back and reject return the item to its owner with the CEO\'s comments', async () => {
  const s = await setup('supervised');
  const obj = await s.units.addGoal(s.orgId, { title: 'Enter the German market', kind: 'objective' }, agent(s.writer.id));
  await exec(s, s.writer.id, 'org_request_alignment', { item: obj.id, brief: BRIEF });
  const card = (await s.approvals.pending(s.orgId)).find((a) => a.kind === 'alignment')!;
  await s.approvals.decide(s.orgId, card.id, 'revise', 'Show the cost of localisation first');
  const v = (await s.alignment.list(s.orgId)).find((r) => r.itemId === obj.id)!;
  assert.equal(v.state, 'draft');
  assert.equal(v.thread.at(-1)?.kind, 'send_back');
  assert.ok((await inbox(s, s.writer.id)).some((e) => /sent back/.test(e.title) && /localisation/.test(e.body ?? '')));
  assert.match(await exec(s, s.writer.id, 'org_alignment', { item: obj.id }), /sent back: Show the cost of localisation/);
  await exec(s, s.writer.id, 'org_request_alignment', { item: obj.id, brief: { ...BRIEF, cost: 'Localisation $3k one-off' } });
  const card2 = (await s.approvals.pending(s.orgId)).find((a) => a.kind === 'alignment')!;
  await s.approvals.decide(s.orgId, card2.id, 'reject', 'Not this year');
  assert.equal((await s.alignment.get(s.orgId, v.id)).state, 'rejected');
});

test('the owner classifies what is not on the floor: not escalated work starts, contradictions are refused, the CEO can pull it in, spot-checks catch under-escalation', async () => {
  const s = await setup('supervised');
  const kr = await s.org.addGoal(s.orgId, { title: 'Readers to 2000', kind: 'key_result', metric: 'readers', targetValue: 2000 }, 'user');
  const p = await s.org.addProject(s.orgId, { title: 'Newsletter template refresh', goalIds: [kr.id], kind: 'project' }, agent(s.writer.id));
  const v = (await s.alignment.list(s.orgId)).find((r) => r.itemId === p.id)!;
  assert.equal(v.needsAlignment, null, 'project bets are not on the supervised floor: the owner decides');
  await assert.rejects(s.tasks.create(s.orgId, { title: 'Draft the template', projectId: p.id, createdBy: agent(s.writer.id) }), /not classified yet.*org_classify_alignment/s);
  await assert.rejects(exec(s, s.writer.id, 'org_classify_alignment', { item: p.key, needsAlignment: false, reasoning: 'It is small and internal, nothing to see.', criteria: { externalCommitment: true } }), /your own criteria say it needs alignment/);
  await assert.rejects(exec(s, s.writer.id, 'org_classify_alignment', { item: kr.id, needsAlignment: false, reasoning: 'It is just a number and a small one.' }), /always need the CEO/);
  const out = await exec(s, s.writer.id, 'org_classify_alignment', { item: p.key, needsAlignment: false, reasoning: 'A two-way door inside my unit: a template we can roll back.', criteria: { reversibility: 'two_way', blastRadius: 'unit', novelty: 'within', costShare: 0.02 } });
  assert.match(out, /does not need alignment/);
  assert.equal((await s.alignment.get(s.orgId, v.id)).state, 'not_required');
  await s.tasks.create(s.orgId, { title: 'Draft the template', projectId: p.id, createdBy: agent(s.writer.id) });

  // a second project that mentions pricing, classified out: the spot-check flags it
  const p2 = await s.org.addProject(s.orgId, { title: 'New pricing page for partners', goalIds: [kr.id], kind: 'project' }, agent(s.writer.id));
  await exec(s, s.writer.id, 'org_classify_alignment', { item: p2.key, needsAlignment: false, reasoning: 'Only a page; we can change it any time.', criteria: { reversibility: 'two_way', blastRadius: 'unit' } });
  const findings = await s.alignment.spotCheck(s.orgId);
  assert.ok(findings.some((f) => f.kind === 'under' && /pricing/i.test(f.why)), JSON.stringify(findings));
  assert.match(await exec(s, s.chief.id, 'org_alignment_audit', {}), /UNDER/);
  await s.alignment.sweep(s.orgId);
  assert.ok((await s.memory.list(s.writer.id)).some((l) => /needing CEO alignment/.test(l.text)), 'the under-escalation became a lesson');

  // the CEO pulls the first one in: it needs alignment now
  const pulled = await s.alignment.ceoAct(s.orgId, v.id, 'pull_in', 'This changes what readers see every week', 'user');
  assert.equal(pulled.state, 'draft');
  assert.equal(pulled.needsAlignment, true);
  assert.ok(pulled.pulledInAt);
  await assert.rejects(s.tasks.create(s.orgId, { title: 'More template work', projectId: p.id, createdBy: agent(s.writer.id) }), /not aligned/);

  // over-escalation: the CEO says an escalation was not needed
  const p3 = await s.org.addProject(s.orgId, { title: 'Fix typos in the archive', goalIds: [kr.id], kind: 'project' }, agent(s.writer.id));
  await exec(s, s.writer.id, 'org_classify_alignment', { item: p3.key, needsAlignment: true, reasoning: 'Better safe than sorry with the archive.', criteria: { reversibility: 'two_way' } });
  await exec(s, s.writer.id, 'org_request_alignment', { item: p3.key, brief: BRIEF });
  const v3 = (await s.alignment.list(s.orgId)).find((r) => r.itemId === p3.id)!;
  await s.alignment.ceoAct(s.orgId, v3.id, 'not_needed', 'Typos are yours to fix', 'user');
  assert.equal((await s.alignment.get(s.orgId, v3.id)).state, 'aligned');
  assert.ok((await s.memory.list(s.writer.id)).some((l) => /decide it yourself/.test(l.text)));
});

test('the Unsorted cap and moves: loose work waits as a proposal; moving a task under an unaligned project is gated', async () => {
  const s = await setup('supervised');
  await s.org.setTunable(s.orgId, 'alignment.unsortedCap', 1, { actor: 'user' });
  const a = await s.tasks.create(s.orgId, { title: 'Loose one', assigneeAgentId: s.writer.id, createdBy: agent(s.writer.id) });
  assert.equal(a.status, 'todo');
  const b = await s.tasks.create(s.orgId, { title: 'Loose two', assigneeAgentId: s.writer.id, createdBy: agent(s.writer.id) });
  assert.equal(b.status, 'backlog');
  assert.equal(b.assigneeAgentId, null);
  const obj = await s.units.addGoal(s.orgId, { title: 'A draft objective', kind: 'objective' }, agent(s.writer.id));
  const p = await s.org.addProject(s.orgId, { title: 'Under the draft', goalIds: [obj.id], kind: 'project' }, 'user');
  await assert.rejects(s.tasks.update(s.orgId, a.id, { projectId: p.id }, agent(s.writer.id)), /not aligned/);
});

test('autonomous: OKRs auto-align (logged for the CEO to review); the direction goes to the chief, who aligns it with org_align; the CEO can override after the fact', async () => {
  const s = await setup('autonomous');
  const obj = await s.units.addGoal(s.orgId, { title: 'Grow the readership', kind: 'objective' }, agent(s.writer.id));
  const o = (await s.alignment.list(s.orgId)).find((r) => r.itemId === obj.id)!;
  assert.equal(o.state, 'aligned');
  assert.equal(o.alignedVia, 'auto');
  assert.equal(o.needsCeoReview, true);
  const vision = await s.org.addGoal(s.orgId, { title: 'The newsletter for indie makers', kind: 'vision' }, agent(s.writer.id));
  assert.equal((await s.alignment.list(s.orgId)).find((r) => r.itemId === vision.id)?.state, 'draft');
  const out = await exec(s, s.writer.id, 'org_request_alignment', { item: 'vision', brief: BRIEF });
  assert.match(out, /from the chief of staff/);
  assert.ok((await s.tasks.list(s.orgId)).some((t) => t.assigneeAgentId === s.chief.id && t.title.startsWith('Align:')));
  assert.equal((await s.approvals.pending(s.orgId)).filter((a) => a.kind === 'alignment').length, 0, 'no CEO card');
  await assert.rejects(exec(s, s.writer.id, 'org_align', { item: 'vision', decision: 'approve' }), /only the chief/);
  assert.match(await exec(s, s.chief.id, 'org_align', { item: 'vision', decision: 'approve', note: 'Keep it B2C' }), /on the CEO's behalf/);
  const v = (await s.alignment.list(s.orgId)).find((r) => r.itemId === vision.id)!;
  assert.equal(v.state, 'aligned'); assert.equal(v.alignedVia, 'chief'); assert.equal(v.needsCeoReview, true);
  assert.ok((await s.tasks.list(s.orgId)).filter((t) => t.title.startsWith('Align:')).every((t) => t.status === 'done'));
  // the CEO reviews after the fact and re-opens it
  const over = await s.alignment.ceoAct(s.orgId, v.id, 'send_back', 'B2B first', 'user');
  assert.equal(over.state, 'realign');
  assert.equal(over.needsCeoReview, false);
});

test('re-alignment cadence: an aligned item past its cadence is due and the owner is told once; an expired card returns to draft', async () => {
  const s = await setup('supervised');
  const obj = await s.units.addGoal(s.orgId, { title: 'Grow the readership', kind: 'objective' }, agent(s.writer.id));
  await exec(s, s.writer.id, 'org_request_alignment', { item: obj.id, brief: BRIEF });
  const card = (await s.approvals.pending(s.orgId)).find((a) => a.kind === 'alignment')!;
  await s.approvals.decide(s.orgId, card.id, 'approve');
  const later = new Date(Date.now() + 100 * 86_400_000);
  assert.equal((await s.alignment.sweep(s.orgId, later)).due, 1);
  assert.equal((await s.alignment.sweep(s.orgId, later)).due, 0, 'told once');
  assert.equal((await s.alignment.list(s.orgId, later)).find((r) => r.itemId === obj.id)?.reviewDue, true);
  const notes = await s.alignment.planningNotes(await s.org.get(s.orgId), (await s.units.rootUnit(s.orgId)).id, true);
  assert.match(notes.join('\n'), /Alignment first/);
});
