/** Capacity (docs/autonomous-org-first-principles.md C4, execution-plan
 *  item 31): the WIP limit on assignment (with the chief's audited
 *  override) and on claiming; expected duration per task class from
 *  history on the board API and in org_capacity; dependencies as a graph
 *  (cycles refused, `waiting` until done, the dependant woken); deadlines
 *  ranking the heartbeat and overdue signals to the owner, then the lead. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { orgTasks } from '../server/src/database/schema';
import { setup, enable, sessionOf } from './org-governance-harness';
import type { OrgWakeEvent } from '../server/src/chats/trigger-bus';

const brief = { outcome: 'x', done_when: 'y' };

test('WIP: assigning beyond the limit is refused with the member\'s open list; the chief overrides with a reason (audited); a lead cannot override', async () => {
  const s = await setup();
  const orgId = await enable(s, 'autonomous');
  await s.org.setTunable(orgId, 'capacity.wipPerMember', 2, { actor: 'user' });
  await s.tasks.create(orgId, { title: 'Issue 1', brief, assigneeAgentId: s.writer.id });
  await s.tasks.create(orgId, { title: 'Issue 2', brief, assigneeAgentId: s.writer.id });
  const third = await s.tasks.create(orgId, { title: 'Issue 3', brief });
  const chief = await sessionOf(s, s.chief.id);
  await assert.rejects(s.runtime.execute(chief, 'org_assign', { taskId: third.id, agent: 'Writer' }), /already holds 2 open task\(s\), the WIP limit is 2 .*Issue 1.*Issue 2.*pass override with a reason/);
  assert.equal((await s.tasks.get(orgId, third.id)).assigneeAgentId, null);
  const out = await s.runtime.execute(chief, 'org_assign', { taskId: third.id, agent: 'Writer', override: 'launch week, Writer has capacity' });
  assert.match(out, /assigned to Writer/);
  const rows = await s.audit.list(orgId, { action: 'wip_override' });
  assert.equal(rows.length, 1);
  assert.match(rows[0].payload, /launch week/);
  // org_create_task with an assignee goes through the same limit
  await assert.rejects(s.runtime.execute(chief, 'org_create_task', { title: 'Issue 4', outcome: 'x', done_when: 'y', assignee: 'Writer' }), /WIP limit is 2/);
  await assert.rejects(s.tasks.checkWip(orgId, s.writer.id, { actor: `agent:${s.editor.id}`, override: 'please', limit: 2 }), /only the chief of staff may override/);
  // the CEO is not bound
  const t5 = await s.tasks.create(orgId, { title: 'Issue 5', brief });
  await s.tasks.assign(orgId, t5.id, s.writer.id, 'user');
});

test('WIP on claiming: a member with as many active tasks as the limit does not claim another (skipped:wip, audited)', async () => {
  const s = await setup();
  const orgId = await enable(s);
  await s.org.setTunable(orgId, 'capacity.wipPerMember', 1, { actor: 'user' });
  const a = await s.tasks.create(orgId, { title: 'Active one', brief, assigneeAgentId: s.writer.id });
  await s.db.update(orgTasks).set({ status: 'in_progress' }).where(eq(orgTasks.id, a.id));
  const b = await s.tasks.create(orgId, { title: 'Next one', brief, assigneeAgentId: s.writer.id });
  assert.equal(await s.runtime.runTask(orgId, b.id, s.writer.id, 'manual'), 'skipped:wip');
  assert.equal((await s.tasks.get(orgId, b.id)).status, 'todo');
  assert.equal((await s.audit.list(orgId, { action: 'claim_refused' })).length, 1);
});

test('expected duration per class and member from history (median runs and hours), on the board API and in org_capacity', async () => {
  const s = await setup();
  const orgId = await enable(s);
  for (const [i, runs] of [[1, 1], [2, 3], [3, 2]] as const) {
    const t = await s.tasks.create(orgId, { title: `Research ${i}`, brief, assigneeAgentId: s.writer.id, class: 'research' });
    for (let r = 0; r < runs; r++) { const run = await s.tasks.startRun(orgId, { taskId: t.id, agentId: s.writer.id, wakeReason: 'manual' }); await s.tasks.endRun(run.id, { status: 'done', outcome: 'progressed' }); }
    const created = new Date(Date.now() - i * 2 * 3_600_000).toISOString();
    await s.db.update(orgTasks).set({ status: 'done', createdAt: created, updatedAt: new Date().toISOString() }).where(eq(orgTasks.id, t.id));
  }
  const exp = await s.capacity.expectations(orgId);
  const mine = exp.get(`${s.writer.id}|research`)!;
  assert.equal(mine.runs, 2);
  assert.equal(mine.samples, 3);
  assert.ok(mine.hours! > 3.5 && mine.hours! < 4.5, `median ≈ 4h, got ${mine.hours}`);
  const open = await s.tasks.create(orgId, { title: 'Research 4', brief, assigneeAgentId: s.writer.id, class: 'research' });
  const other = await s.tasks.create(orgId, { title: 'Research 5', brief, assigneeAgentId: s.editor.id, class: 'research' });
  const board = await s.tasks.annotate(orgId, [open, other]);
  assert.equal((board[0].expected as { basis: string; runs: number }).basis, 'member');
  assert.equal((board[1].expected as { basis: string }).basis, 'class', 'the class across members when the member has no history');
  const cap = await s.controller.capacityOf(s.ws.id);
  const w = cap.members.find((m) => m.agentId === s.writer.id)!;
  assert.equal(w.open, 1); assert.equal(w.wip, 3); assert.ok(w.expectedHours! > 3);
  assert.equal(cap.byClass.research.runs, 2);
  const text = await s.tools.execute(await sessionOf(s, s.writer.id), 'org_capacity', {});
  assert.match(text, /WIP limit 3 open task\(s\) per member/);
  assert.match(text, /research ≈ 2 run\(s\)/);
});

test('dependencies: unknown ids, self-dependency and cycles are refused on write', async () => {
  const s = await setup();
  const orgId = await enable(s);
  const a = await s.tasks.create(orgId, { title: 'A', brief });
  const b = await s.tasks.create(orgId, { title: 'B', brief, dependsOn: [a.id] });
  const c = await s.tasks.create(orgId, { title: 'C', brief, dependsOn: [b.id.slice(0, 8)] });
  assert.deepEqual(JSON.parse(c.dependsOn), [b.id], 'a prefix resolves');
  await assert.rejects(s.tasks.update(orgId, a.id, { dependsOn: [c.id] }), /cycle \(/);
  await assert.rejects(s.tasks.update(orgId, a.id, { dependsOn: [a.id] }), /cannot depend on itself/);
  await assert.rejects(s.tasks.create(orgId, { title: 'D', brief, dependsOn: ['nope'] }), /matches 0 tasks/);
});

test('waiting: a task with an unmet dependency waits and cannot be claimed; completing the dependency moves it to todo and wakes its owner (TriggerBus)', async () => {
  const s = await setup();
  const orgId = await enable(s);
  const wakes: OrgWakeEvent[] = [];
  s.bus.onOrgWake((ev) => wakes.push(ev));
  const research = await s.tasks.create(orgId, { title: 'Research sources', brief, assigneeAgentId: s.editor.id });
  const chief = await sessionOf(s, s.chief.id);
  const out = await s.runtime.execute(chief, 'org_create_task', { title: 'Write the issue', outcome: 'x', done_when: 'y', assignee: 'Writer', dependsOn: [research.id], dueAt: new Date(Date.now() + 86_400_000).toISOString() });
  assert.match(out, /waiting on its dependencies created in waiting/);
  const write = (await s.tasks.list(orgId)).find((t) => t.title === 'Write the issue')!;
  assert.equal(write.status, 'waiting');
  assert.ok(write.dueAt);
  assert.ok(!wakes.some((w) => w.taskId === write.id), 'a waiting task wakes nobody');
  assert.equal(await s.runtime.runTask(orgId, write.id, s.writer.id, 'manual'), 'skipped:status_waiting');
  assert.deepEqual((await s.tasks.annotate(orgId, [write]))[0].waitingOn, [research.id]);
  await s.tasks.requestReview(orgId, research.id, { fromAgentId: s.editor.id });
  await s.tasks.review(orgId, research.id, { verdict: 'accept', byAgentId: s.chief.id });
  const after = await s.tasks.get(orgId, write.id);
  assert.equal(after.status, 'todo');
  assert.ok(wakes.some((w) => w.taskId === write.id && w.agentId === s.writer.id && w.reason === 'dependency'));
  assert.equal((await s.audit.list(orgId, { action: 'task_unblocked' })).length, 1);
});

test('deadlines: the heartbeat ranks overdue, then due soon, ahead of the rest; overdue is a signal to the owner, then to the lead; both resolve when the task is done', async () => {
  const s = await setup();
  const orgId = await enable(s);
  const analyst = await s.agents.create({ name: 'Analyst', charter: 'Numbers.' });
  await s.org.addMember(orgId, { agentId: analyst.id, title: 'Analyst', reportsToAgentId: s.writer.id });
  const now = new Date();
  await s.tasks.create(orgId, { title: 'Someday', brief, assigneeAgentId: analyst.id });
  await s.tasks.create(orgId, { title: 'Due soon', brief, assigneeAgentId: analyst.id, dueAt: new Date(now.getTime() + 2 * 3_600_000).toISOString() });
  const late = await s.tasks.create(orgId, { title: 'Late', brief, assigneeAgentId: analyst.id, dueAt: new Date(now.getTime() - 30 * 3_600_000).toISOString() });
  const reasons = await s.runtime.heartbeatReasons(analyst.id, now);
  assert.match(reasons[0], /^OVERDUE .*"Late"/);
  assert.match(reasons[1], /^due within 24h .*"Due soon"/);
  assert.match(reasons[2], /"Someday"/);
  const r = await s.capacity.sweepDue(orgId, now);
  assert.equal(r.owner, 1); assert.equal(r.lead, 1, '30h late > 24h: the lead is told too');
  const owner = (await s.signals.list(orgId, { kind: 'task_overdue' }))[0];
  assert.equal(owner.addresseeId, analyst.id);
  const lead = (await s.signals.list(orgId, { kind: 'task_overdue_lead' }))[0];
  assert.equal(lead.addresseeId, s.writer.id, 'the lead of the analyst\'s unit');
  await s.tasks.update(orgId, late.id, { status: 'done' });
  const r2 = await s.capacity.sweepDue(orgId, now);
  assert.equal(r2.resolved, 2);
});
