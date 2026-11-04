/** Heads manage: a function head with reports splits, briefs and assigns
 *  execution work before doing it itself (docs/work-tracking.md
 *  `work.headDelegation`): the lead tools in every mode, a title-only head
 *  recognised as a lead, the delegate path in its task wake, next work that
 *  routes backlog to its team, its heartbeat's team board, its reports'
 *  reviews, and the `delegation_gap` signal when it keeps doing their work. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup as harness, enable, sessionOf, call, say, lastUser, type Plan } from './org-governance-harness';
import { OrgNextWorkService } from '../server/src/org/org-next-work.service';
import { isHeadLevelTask, HEAD_PLAYBOOKS } from '../server/src/org/heads';
import { deriveWorkTunables } from '../server/src/org/work-tunables';
import { AUTHORED_PACKS } from '../server/src/market/authored-packs.generated';
import { eq } from 'drizzle-orm';
import { orgUnits } from '../server/src/database/schema';

const brief = { outcome: 'The draft is fixed', done_when: 'The file reads clean' };
const names = (specs: Array<{ name: string }>) => new Set(specs.map((t) => t.name));

/** Writer heads "Content" by title only (isHead 0); Editor reports to it. */
async function setup(plan?: Plan) {
  const s = await harness(plan);
  (s.tasks as unknown as { agents: unknown }).agents = s.agents;
  const orgId = await enable(s);
  await s.org.updateMember(orgId, s.writer.id, { title: 'Head of Content' });
  await s.org.updateMember(orgId, s.editor.id, { reportsToAgentId: s.writer.id });
  const next = new OrgNextWorkService(s.org, s.tasks, s.runtime, s.audit, s.agents, s.workspaces, s.units);
  next.delayMs = 600_000;
  const quiet = () => { for (const a of [s.writer.id, s.editor.id, s.chief.id]) s.runtime.cancelWakesFor(orgId, a); };
  return { ...s, orgId, next, quiet };
}

test('head-level work is told apart from execution work', () => {
  for (const t of ['Write the weekly content report', 'Plan Q3 key results', 'Escalation: ENG-4 blocked', 'Hire a second writer', 'Review the launch copy', 'Set the unit cadence']) assert.ok(isHeadLevelTask({ title: t }), t);
  for (const t of ['Fix the AI price band\'s floor in the claims sheet', 'Draft the landing page copy', 'Measure the report ceiling']) assert.ok(!isHeadLevelTask({ title: t }), t);
  assert.ok(isHeadLevelTask({ title: 'Anything', class: 'review' }));
});

test('a title-only head (isHead 0) is recognised as a lead: offered org_assign and the head tools in task mode and outside it, and may assign its report', async () => {
  const s = await setup();
  const m = (await s.org.member(s.orgId, s.writer.id))!;
  assert.equal(m.isHead, 0, 'head by title only');
  // its unit row gone (it joined before the chart was last synced): the head is still a lead
  await s.db.update(orgUnits).set({ archivedAt: new Date().toISOString() }).where(eq(orgUnits.leadAgentId, s.writer.id));
  assert.equal(await s.units.isLead(s.orgId, s.writer.id), null);
  const task = await s.tasks.create(s.orgId, { title: 'Fix the claims sheet', brief, createdBy: 'chief', assigneeAgentId: s.writer.id });
  const sess = await sessionOf(s, s.writer.id);
  s.runtime.beginAuxRun({ orgId: s.orgId, taskId: task.id, agentId: s.writer.id, runId: 'r', sessionId: sess.id, isChief: false, reviewer: false, progress: false, calls: new Map(), loopDetected: false });
  const inTask = names(await s.runtime.specsFor(sess));
  for (const t of ['org_assign', 'org_create_task', 'org_unit_report', 'org_hire_agent', 'org_decision_queue']) assert.ok(inTask.has(t), `task mode offers ${t}`);
  // the assign permission: its own report, not someone outside its line
  assert.match(await s.runtime.execute(sess, 'org_assign', { taskId: task.id, agent: 'Editor' }), /assigned to Editor/);
  await assert.rejects(s.runtime.execute(sess, 'org_create_task', { title: 'Chief work', ...brief, assignee: 'Chief' }), /outside your unit/);
  s.runtime.endAuxRun(sess.id);
  assert.ok(await s.units.isLead(s.orgId, s.writer.id), 'the head now leads a unit');
  const loop = names(await s.runtime.specsFor(await sessionOf(s, s.writer.id)));
  for (const t of ['org_assign', 'org_set_goal', 'org_hire_agent']) assert.ok(loop.has(t), `a heartbeat or chat offers ${t}`);
  // a specialist still is not offered the lead's set
  assert.ok(!names(await s.runtime.specsFor(await sessionOf(s, s.editor.id))).has('org_assign'));
});

test('a head with a report given an execution task delegates it (scripted run): the wake carries the delegate path and the subtask goes to the report; a head-level task keeps "do the work"', async () => {
  const plan: Plan = (req, round) => {
    const u = lastUser(req);
    if (round === 0 && /split, brief and assign before doing it yourself/.test(u)) return call('org_create_task', { title: 'Fix the price floor in claims.md', outcome: 'The floor matches the cheapest monthly plan', done_when: 'claims.md §4 cites the monthly floor', assignee: 'Editor' });
    if (round === 1 && /created in todo and assigned to Editor/.test(JSON.stringify(req.messages.at(-1)))) return call('org_task_comment', { text: 'Split: Editor fixes claims.md; I review it.' });
    return say('Handed to Editor.');
  };
  const s = await setup(plan);
  const parent = await s.tasks.create(s.orgId, { title: 'Fix the AI price band\'s floor in the claims sheet', brief, createdBy: 'chief', assigneeAgentId: s.writer.id });
  s.quiet();
  assert.equal(await s.runtime.runTask(s.orgId, parent.id, s.writer.id, 'assignment'), 'ran');
  const prompt = lastUser(s.provider.requests[0]);
  assert.match(prompt, /You lead a team \(Editor 0\/\d+ open\): split, brief and assign before doing it yourself/);
  assert.doesNotMatch(prompt, /Do the work described in your context/);
  assert.ok(names(s.provider.requests[0].tools ?? []).has('org_assign'), 'the run offers org_assign');
  const sub = (await s.tasks.list(s.orgId)).find((t) => t.parentTaskId === parent.id)!;
  assert.ok(sub, 'a subtask was created');
  assert.equal(sub.assigneeAgentId, s.editor.id, 'assigned to the report, not the head');
  assert.equal((await s.tasks.get(s.orgId, parent.id)).assigneeAgentId, s.writer.id, 'the parent stays the head\'s');
  // the report's result is reviewed by its head
  s.quiet();
  await s.tasks.claim(s.orgId, sub.id, s.editor.id, 'run-e');
  const inReview = await s.tasks.requestReview(s.orgId, sub.id, { fromAgentId: s.editor.id });
  assert.equal(inReview.reviewerAgentId, s.writer.id, 'the head reviews its report');
  await s.org.setTunable(s.orgId, 'work.headReviewsReports', 0, { actor: 'user' });
  const other = await s.tasks.create(s.orgId, { title: 'Another fix', brief, assigneeAgentId: s.editor.id });
  await s.tasks.claim(s.orgId, other.id, s.editor.id, 'run-o');
  assert.notEqual((await s.tasks.requestReview(s.orgId, other.id, { fromAgentId: s.editor.id })).reviewerAgentId, s.writer.id, 'off: a member of another model family reviews');
  // head-level work: the ordinary prompt
  s.quiet();
  const report = await s.tasks.create(s.orgId, { title: 'Write the weekly content report', brief, createdBy: 'chief', assigneeAgentId: s.writer.id });
  s.quiet();
  const before = s.provider.requests.length;
  await s.runtime.runTask(s.orgId, report.id, s.writer.id, 'assignment');
  assert.match(lastUser(s.provider.requests[before]), /Do the work described in your context with your tools\./);
  // delegation off: the ordinary prompt for execution work too
  await s.org.setTunable(s.orgId, 'work.headDelegation', 0, { actor: 'user' });
  const exec2 = await s.tasks.create(s.orgId, { title: 'Draft the landing page copy', brief, createdBy: 'chief', assigneeAgentId: s.writer.id });
  s.quiet();
  const b2 = s.provider.requests.length;
  await s.runtime.runTask(s.orgId, exec2.id, s.writer.id, 'assignment');
  assert.doesNotMatch(lastUser(s.provider.requests[b2]), /You lead a team/);
});

test('next work: a head with a report that has room never takes execution backlog itself; at work.headDelegation 2 it goes to the best-fit report', async () => {
  const s = await setup();
  await s.units.syncMembership(s.orgId);
  const unit = (await s.units.isLead(s.orgId, s.writer.id))!;
  const t = await s.tasks.create(s.orgId, { title: 'Edit the newsletter drafts for tone', brief: { outcome: 'Drafts edited', done_when: 'Edited' }, createdBy: 'chief', status: 'backlog', unitId: unit.id });
  assert.equal(t.unitId, unit.id);
  s.quiet();
  const cands = await s.next.candidates(await s.org.get(s.orgId), s.writer.id, new Date());
  const c = cands.find((x) => x.task.id === t.id)!;
  assert.ok(c?.delegate, 'a delegate candidate, not self-assign');
  assert.equal(c.selfAssign, false);
  const r1 = await s.next.pull(s.orgId, s.writer.id);
  assert.notEqual(r1.outcome, 'self_assign');
  assert.equal((await s.tasks.get(s.orgId, t.id)).assigneeAgentId, null, 'mode 1: left on the board for the head to brief and assign');
  const section = (await s.next.section(s.writer.id, new Date()))!;
  assert.match(section.text, /backlog \(delegate it to a report\)/);
  await s.org.setTunable(s.orgId, 'work.headDelegation', 2, { actor: 'user' });
  const r2 = await s.next.pull(s.orgId, s.writer.id);
  assert.equal(r2.outcome, 'delegate');
  assert.equal((await s.tasks.get(s.orgId, t.id)).assigneeAgentId, s.editor.id, 'routed to the report whose role fits');
  assert.ok((await s.audit.list(s.orgId, { action: 'next_work_delegate' })).length === 1);
  // delegation off: the head pulls it like any member
  await s.org.setTunable(s.orgId, 'work.headDelegation', 0, { actor: 'user' });
  const t2 = await s.tasks.create(s.orgId, { title: 'Edit the welcome email drafts', brief: { outcome: 'Edited', done_when: 'Edited' }, createdBy: 'chief', status: 'backlog', unitId: unit.id });
  s.quiet();
  const c2 = (await s.next.candidates(await s.org.get(s.orgId), s.writer.id, new Date())).find((x) => x.task.id === t2.id);
  assert.ok(!c2?.delegate);
});

test('the head\'s heartbeat reviews its team\'s board: an idle report while it carries execution work, once a day per state; the staffing line says to delegate', async () => {
  const s = await setup();
  await s.tasks.create(s.orgId, { title: 'Fix the claims sheet', brief, createdBy: 'chief', assigneeAgentId: s.writer.id });
  s.quiet();
  const now = new Date();
  const reasons = await s.runtime.heartbeatReasons(s.writer.id, now);
  const line = reasons.find((r) => r.startsWith('Your team:'));
  assert.ok(line, 'a team-board reason');
  assert.match(line!, /Editor idle while you carry 1 execution task\(s\)/);
  assert.ok(!(await s.runtime.heartbeatReasons(s.writer.id, now)).some((r) => r.startsWith('Your team:')), 'not again for the same state that day');
  const ctx = (await s.runtime.contextFor(await sessionOf(s, s.writer.id)))!;
  assert.match(ctx, /Delegate: you carry 1 execution task\(s\) while Editor has room/);
  assert.match(ctx, /Lead it rather than do it/);
  // a specialist gets none of it
  assert.ok(!(await s.runtime.heartbeatReasons(s.editor.id, now)).some((r) => r.startsWith('Your team:')));
});

test('delegation_gap: a head that starts execution tasks itself while a report sits idle is signalled; head-level work and the tunable threshold hold it back', async () => {
  const s = await setup();
  const a = await s.tasks.create(s.orgId, { title: 'Fix the claims sheet', brief, createdBy: 'chief', assigneeAgentId: s.writer.id });
  const plan = await s.tasks.create(s.orgId, { title: 'Plan the content calendar', brief, createdBy: 'chief', assigneeAgentId: s.writer.id });
  s.quiet();
  await s.tasks.claim(s.orgId, a.id, s.writer.id, 'run-a');
  await s.tasks.claim(s.orgId, plan.id, s.writer.id, 'run-p');
  const gaps = async () => (await s.signals.compute(await s.org.get(s.orgId))).filter((x) => x.kind === 'delegation_gap');
  assert.equal((await gaps()).length, 0, 'one execution task (the plan is head-level) is under the default threshold of 2');
  const b = await s.tasks.create(s.orgId, { title: 'Draft the landing copy', brief, createdBy: 'chief', assigneeAgentId: s.writer.id });
  s.quiet();
  await s.tasks.claim(s.orgId, b.id, s.writer.id, 'run-b');
  const [g] = await gaps();
  assert.ok(g, 'two execution tasks while Editor idles');
  assert.equal(g.addresseeId, s.writer.id, 'addressed to the head');
  assert.match(g.title, /Writer did 2 execution task\(s\) itself in 24h while Editor sat idle/);
  await s.org.setTunable(s.orgId, 'work.delegationSignalTasks', 3, { actor: 'user' });
  assert.equal((await gaps()).length, 0, 'the threshold is the company\'s');
  await s.org.setTunable(s.orgId, 'work.delegationSignalTasks', 2, { actor: 'user' });
  // the report gets work: not idle, no signal
  await s.tasks.create(s.orgId, { title: 'Edit the essay', brief, createdBy: `agent:${s.writer.id}`, assigneeAgentId: s.editor.id });
  assert.equal((await gaps()).length, 0);
  // it opens through the sweep like the other kinds
  assert.ok((await s.signals.sweep(s.orgId)).live >= 0);
});

test('the tunables come from the profile, and the head playbooks and packs carry "lead, don\'t do"', () => {
  const by = (c: string, extra: Record<string, unknown> = {}) => Object.fromEntries(deriveWorkTunables({ stage: 'growth', cultureType: c, speed: false, rigor: false, ...extra } as never).map((t) => [t.key, t.value]));
  assert.equal(by('hierarchy')['work.headDelegation'], 2);
  assert.equal(by('clan')['work.headDelegation'], 1);
  assert.equal(by('hierarchy')['work.delegationSignalTasks'], 1);
  assert.equal(by('clan', { stage: 'early' })['work.delegationSignalTasks'], 3);
  assert.equal(by('clan', { speed: true })['work.delegationWindowHours'], 12);
  assert.match(HEAD_PLAYBOOKS.find((p) => p.name === 'unit-team-management')!.instructions, /^Lead, don't do:/);
  const heads = AUTHORED_PACKS.filter((p) => /^pack-biz-[\w-]+-manager$/.test(p.id));
  assert.ok(heads.length >= 10);
  for (const p of heads) {
    assert.match(p.charter ?? '', /When a task lands on you, you split it into briefed tasks for your reports/, p.id);
    const tm = p.skills!.find((x) => x.name.endsWith('-team-management'))!;
    assert.match(tm.instructions, /^Lead, don't do:/, p.id);
  }
});
