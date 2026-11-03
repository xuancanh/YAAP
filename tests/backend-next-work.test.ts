/** Next work (docs/work-tracking.md "Pull next" and "Blocked work on the
 *  heartbeat"): a member is woken for its next task when one leaves its
 *  hands — reviews first, then newly unblocked work, then its to-do by lane
 *  and urgency, then fitting backlog under `work.selfAssign` — gated by the
 *  WIP limit, the org's and member's status, and deduped with the other
 *  wakes; the heartbeat re-checks blocked work and names what changed, nudges
 *  a chase past `work.chaseAfterHours`, and carries "Your next work". */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup as harness, enable, inbox, call, say, lastUser, type S } from './org-governance-harness';
import { OrgProjectsService } from '../server/src/org/org-projects.service';
import { OrgNextWorkService, stems } from '../server/src/org/org-next-work.service';
import { heartbeatPrompt } from '../server/src/chats/heartbeat.service';

async function setup(plan?: Parameters<typeof harness>[0]) {
  const s = await harness(plan);
  (s.tasks as unknown as { agents: unknown }).agents = s.agents;
  const projects = new OrgProjectsService(s.db, s.org, s.tasks, s.approvals, s.audit, s.agents, s.units, undefined, s.decisions);
  const orgId = await enable(s);
  const next = new OrgNextWorkService(s.org, s.tasks, s.runtime, s.audit, s.agents, s.workspaces, s.units);
  next.delayMs = 600_000;
  const kr = await s.org.addGoal(orgId, { title: 'Grow subscribers to 1 000', kind: 'key_result', metric: 'subscribers', targetValue: 1000, startValue: 0 });
  const now = (await projects.create(orgId, { title: 'Launch the referral loop', goalIds: [kr.id] }, 'user')).project;
  const later = (await projects.create(orgId, { title: 'Someday redesign', goalIds: [kr.id], lane: 'later' }, 'user')).project;
  return { ...s, projects, orgId, next, now, later };
}
type N = Awaited<ReturnType<typeof setup>>;
const brief = { outcome: 'A draft', done_when: 'Saved' };
const quiet = (s: N) => { s.runtime.cancelWakesFor(s.orgId, s.writer.id); s.runtime.cancelWakesFor(s.orgId, s.editor.id); s.runtime.cancelWakesFor(s.orgId, s.chief.id); };
const wakesOf = (s: N, agentId: string) => s.runtime.pendingWakeKeys().filter((k) => k.endsWith(`:${agentId}`)).map((k) => k.split(':')[0]);
/** Put a task in the writer's hands and hand it to review (it leaves them). */
async function finish(s: N, agentId: string, title = 'Current work') {
  const t = await s.tasks.create(s.orgId, { title, brief, assigneeAgentId: agentId });
  quiet(s);
  await s.tasks.claim(s.orgId, t.id, agentId, `run-${t.id.slice(0, 6)}`);
  await s.tasks.update(s.orgId, t.id, { status: 'in_progress' }, `agent:${agentId}`);
  await s.tasks.requestReview(s.orgId, t.id, { fromAgentId: agentId });
  quiet(s);
  return t;
}

test('finish → the next to-do is claimed: Now before Later, urgent first; the run claims it', async () => {
  const s = await setup((req, round) => (round === 0 && /Current work/.test(lastUser(req)) ? call('org_request_review', { note: 'done_when met' }) : say('ok')));
  const older = await s.tasks.create(s.orgId, { title: 'Later-lane chore', brief, assigneeAgentId: s.writer.id, projectId: s.later.id });
  const plain = await s.tasks.create(s.orgId, { title: 'Now-lane piece', brief, assigneeAgentId: s.writer.id, projectId: s.now.id });
  const urgent = await s.tasks.create(s.orgId, { title: 'Now-lane, due soon', brief, assigneeAgentId: s.writer.id, projectId: s.now.id, dueAt: new Date(Date.now() + 3_600_000).toISOString() });
  const current = await s.tasks.create(s.orgId, { title: 'Current work', brief, assigneeAgentId: s.writer.id, projectId: s.now.id });
  quiet(s);
  // a real run hands the task to review: it left the writer's hands
  assert.equal(await s.runtime.runTask(s.orgId, current.id, s.writer.id, 'manual'), 'ran');
  assert.equal((await s.tasks.get(s.orgId, current.id)).status, 'in_review');
  assert.ok(s.next.pendingAgents().includes(s.writer.id), 'a pull is scheduled for the writer');
  quiet(s);
  const r = (await s.next.flush(s.writer.id))!;
  assert.equal(r.outcome, 'claim');
  assert.equal(r.taskId, urgent.id, 'Now lane and due soon first');
  assert.deepEqual(wakesOf(s, s.writer.id), [urgent.id]);
  await s.runtime.flushAll();
  assert.ok((await s.tasks.transitions(s.orgId, urgent.id)).some((x) => x.toStatus === 'claimed'), 'the woken run claimed it');
  // next: the Now task before the older Later one
  quiet(s);
  await s.tasks.update(s.orgId, urgent.id, { status: 'done' }, `agent:${s.writer.id}`);
  const r2 = (await s.next.flush(s.writer.id))!;
  assert.equal(r2.taskId, plain.id);
  assert.notEqual(r2.taskId, older.id);
});

test('reviews it owes come first, then newly unblocked work, then its to-do', async () => {
  const s = await setup();
  const mine = await s.tasks.create(s.orgId, { title: 'Edit the essay', brief, assigneeAgentId: s.editor.id, projectId: s.now.id });
  const stuck = await s.tasks.create(s.orgId, { title: 'Edit the later piece', brief, assigneeAgentId: s.editor.id, projectId: s.later.id });
  await s.tasks.update(s.orgId, stuck.id, { blockedOn: { kind: 'external', reason: 'the author sends the draft' } }, `agent:${s.editor.id}`);
  const draft = await s.tasks.create(s.orgId, { title: 'Draft for review', brief, assigneeAgentId: s.writer.id });
  await s.tasks.claim(s.orgId, draft.id, s.writer.id, 'run-d');
  await s.tasks.update(s.orgId, draft.id, { reviewerAgentId: s.editor.id }, 'user');
  await s.tasks.requestReview(s.orgId, draft.id, { fromAgentId: s.writer.id });
  assert.equal((await s.tasks.get(s.orgId, draft.id)).reviewerAgentId, s.editor.id);
  await s.tasks.update(s.orgId, stuck.id, { blockedOn: null }, 'user');
  assert.equal((await s.tasks.get(s.orgId, stuck.id)).status, 'todo');
  await finish(s, s.editor.id, 'Editor current');
  const r1 = (await s.next.flush(s.editor.id))!;
  assert.equal(r1.outcome, 'review');
  assert.equal(r1.taskId, draft.id, 'the review it owes first');
  // the review done → the reviewer pulls again: the unblocked task (Later lane) before its Now to-do
  quiet(s);
  await s.tasks.review(s.orgId, draft.id, { verdict: 'accept', byAgentId: s.editor.id });
  assert.ok(s.next.pendingAgents().includes(s.editor.id), 'finishing a review schedules the reviewer');
  const r2 = (await s.next.flush(s.editor.id))!;
  assert.equal(r2.outcome, 'claim');
  assert.equal(r2.taskId, stuck.id, 'newly unblocked first');
  assert.notEqual(r2.taskId, mine.id);
  const cands = await s.next.candidates(await s.org.get(s.orgId), s.editor.id, new Date());
  assert.deepEqual(cands.map((c) => c.kind).slice(0, 2), ['unblocked', 'todo']);
});

test('self-assign per work.selfAssign: unit (default) takes fitting backlog; off asks the manager once; project reaches project work in another unit', async () => {
  const s = await setup();
  const fits = await s.tasks.create(s.orgId, { title: 'Write the pricing newsletter', brief: { outcome: 'An issue on pricing', done_when: 'Sent to review' }, createdBy: 'user', projectId: s.now.id });
  await s.tasks.create(s.orgId, { title: 'Tune the database index', brief, createdBy: 'user', projectId: s.now.id });
  assert.ok(stems('Writer: you write the newsletter').has('write'));
  // nothing of its own: the fitting backlog task, taken in its unit
  const r = await s.next.pull(s.orgId, s.writer.id);
  assert.equal(r.outcome, 'self_assign');
  assert.equal(r.taskId, fits.id);
  const taken = await s.tasks.get(s.orgId, fits.id);
  assert.equal(taken.assigneeAgentId, s.writer.id);
  assert.equal(taken.status, 'todo');
  assert.deepEqual(wakesOf(s, s.writer.id), [fits.id], 'the assignment wake runs it');
  assert.ok((await s.audit.list(s.orgId, { action: 'next_work_self_assign' })).length === 1);

  // off: it asks its manager on the task and in the manager's inbox, once
  const s2 = await setup();
  await s2.org.setTunable(s2.orgId, 'work.selfAssign', 0, { actor: 'user' });
  const t2 = await s2.tasks.create(s2.orgId, { title: 'Write the welcome email', brief, createdBy: 'user', projectId: s2.now.id });
  const a = await s2.next.pull(s2.orgId, s2.writer.id);
  assert.equal(a.outcome, 'ask_manager');
  assert.equal((await s2.tasks.get(s2.orgId, t2.id)).assigneeAgentId, null, 'not taken');
  assert.ok((await s2.tasks.messages(s2.orgId, { taskId: t2.id })).some((m) => m.fromAgentId === s2.writer.id && /assign it with org_assign/.test(m.text)));
  const manager = (await s2.org.member(s2.orgId, s2.writer.id))!.reportsToAgentId!;
  assert.ok((await inbox(s2 as unknown as S, manager, 'info')).some((e) => /is free and could take/.test(e.title)), 'the manager hears of it');
  assert.equal((await s2.next.pull(s2.orgId, s2.writer.id)).outcome, 'none', 'asked once a day, no model call');
  assert.equal(s2.provider.requests.length, 0);

  // project: backlog in another unit, in a project the member works on
  const s3 = await setup();
  const analyst = await s3.agents.create({ name: 'Analyst', charter: 'Numbers.' });
  await s3.org.addMember(s3.orgId, { agentId: analyst.id, title: 'Analyst', reportsToAgentId: s3.editor.id });
  const other = (await s3.units.ledBy(s3.orgId, s3.editor.id)) ?? await s3.units.ensureUnitFor(s3.orgId, s3.editor.id);
  const own = await s3.tasks.create(s3.orgId, { title: 'Survey readers', brief, assigneeAgentId: s3.writer.id, projectId: s3.now.id });
  await s3.tasks.update(s3.orgId, own.id, { status: 'done' }, 'user');
  const there = await s3.tasks.create(s3.orgId, { title: 'Collate the survey answers', brief, createdBy: 'user', projectId: s3.now.id, unitId: other.id });
  quiet(s3);
  const unitOnly = await s3.next.pull(s3.orgId, s3.writer.id);
  assert.equal(unitOnly.outcome, 'ask_manager', 'unit mode: project work in another unit is the manager\'s call');
  assert.equal(unitOnly.taskId, there.id);
  await s3.org.setTunable(s3.orgId, 'work.selfAssign', 2, { actor: 'user' });
  const proj = await s3.next.pull(s3.orgId, s3.writer.id);
  assert.equal(proj.outcome, 'self_assign');
  assert.equal((await s3.tasks.get(s3.orgId, there.id)).assigneeAgentId, s3.writer.id);
});

test('nothing to do: no wake and no model call — from a finish or from the heartbeat', async () => {
  const s = await setup();
  await finish(s, s.writer.id);
  const r = (await s.next.flush(s.writer.id))!;
  assert.equal(r.outcome, 'none');
  assert.deepEqual(wakesOf(s, s.writer.id), []);
  assert.deepEqual(await s.runtime.heartbeatReasons(s.writer.id, new Date()), [], 'the heartbeat stays closed');
  assert.equal(s.provider.requests.length, 0);
});

test('the WIP limit is respected: a full member is not woken to claim more', async () => {
  const s = await setup();
  await s.org.setTunable(s.orgId, 'capacity.wipPerMember', 1, { actor: 'user' });
  const busy = await s.tasks.create(s.orgId, { title: 'In flight', brief, assigneeAgentId: s.writer.id });
  await s.tasks.claim(s.orgId, busy.id, s.writer.id, 'run-b');
  await s.tasks.update(s.orgId, busy.id, { status: 'in_progress' }, `agent:${s.writer.id}`);
  await s.tasks.create(s.orgId, { title: 'Queued', brief, assigneeAgentId: s.writer.id });
  await s.tasks.create(s.orgId, { title: 'Write more backlog', brief, createdBy: 'user' });
  quiet(s);
  const r = await s.next.pull(s.orgId, s.writer.id);
  assert.equal(r.outcome, 'skipped:wip');
  assert.deepEqual(wakesOf(s, s.writer.id), []);
});

test('dedupe and loops: a queued assignment or comment wake wins; the task just handed off is not re-pulled; given-up backlog is never taken back', async () => {
  const s = await setup();
  await finish(s, s.writer.id);
  const assigned = await s.tasks.create(s.orgId, { title: 'Fresh assignment', brief, assigneeAgentId: s.writer.id });
  assert.deepEqual(wakesOf(s, s.writer.id), [assigned.id]);
  assert.equal((await s.next.flush(s.writer.id))!.outcome, 'skipped:pending', 'the assignment wake is already queued');
  assert.deepEqual(wakesOf(s, s.writer.id), [assigned.id], 'no second wake');
  // a comment wake (somebody else on its task) dedupes the same way
  quiet(s);
  await s.tasks.comment(s.orgId, assigned.id, { text: 'Please start with the intro', fromAgentId: s.editor.id });
  assert.equal((await s.next.pull(s.orgId, s.writer.id)).outcome, 'skipped:pending');
  // an @mention wake (on somebody else's task) is a queued wake too
  quiet(s);
  const theirs = await s.tasks.create(s.orgId, { title: 'Editor task', brief, assigneeAgentId: s.editor.id });
  quiet(s);
  s.bus.emitOrgWake({ orgId: s.orgId, taskId: theirs.id, agentId: s.writer.id, reason: 'mention' });
  assert.deepEqual(wakesOf(s, s.writer.id), [theirs.id]);
  assert.equal((await s.next.pull(s.orgId, s.writer.id)).outcome, 'skipped:pending', 'the mention wake wins');

  // the heartbeat's own pull queues the run: plain to-do lines wait behind it
  quiet(s);
  await s.tasks.create(s.orgId, { title: 'Another to-do', brief, assigneeAgentId: s.writer.id });
  quiet(s);
  const reasons = await s.runtime.heartbeatReasons(s.writer.id, new Date());
  assert.equal(wakesOf(s, s.writer.id).length, 1, 'one run queued by the heartbeat pull');
  assert.deepEqual(reasons, [], 'no second, heartbeat turn for the same work');

  // loops: blocked and put back by itself at once — the same task is not pulled again right away
  // (moved by someone else since — unblocked, sent back — it is: see the unblocked test)
  const s2 = await setup();
  const t = await s2.tasks.create(s2.orgId, { title: 'Flaky one', brief, assigneeAgentId: s2.writer.id });
  quiet(s2);
  await s2.tasks.update(s2.orgId, t.id, { blockedOn: { kind: 'external', reason: 'API down' } }, `agent:${s2.writer.id}`);
  await s2.tasks.update(s2.orgId, t.id, { status: 'todo' }, `agent:${s2.writer.id}`);
  assert.equal((await s2.next.flush(s2.writer.id))!.outcome, 'none', 'the task it just left is excluded for a while');
  // backlog it gave up is never taken back
  const gave = await s2.tasks.create(s2.orgId, { title: 'Write the old newsletter', brief, assigneeAgentId: s2.writer.id });
  quiet(s2);
  await s2.tasks.update(s2.orgId, gave.id, { status: 'backlog', assigneeAgentId: null }, `agent:${s2.writer.id}`);
  const cands = await s2.next.candidates(await s2.org.get(s2.orgId), s2.writer.id, new Date(Date.now() + 3_600_000));
  assert.ok(!cands.some((c) => c.task.id === gave.id));
  // breakers schedule nothing: the system blocking a task (loop, no progress, budget)
  const s3 = await setup();
  const b = await s3.tasks.create(s3.orgId, { title: 'Looping', brief, assigneeAgentId: s3.writer.id });
  await s3.tasks.update(s3.orgId, b.id, { status: 'blocked', blockers: ['loop detected'] }, 'system');
  assert.ok(!s3.next.pendingAgents().includes(s3.writer.id));
});

test('a paused org, or a paused member, gets no next-work wakes', async () => {
  const s = await setup();
  await s.tasks.create(s.orgId, { title: 'Waiting to-do', brief, assigneeAgentId: s.writer.id });
  await finish(s, s.writer.id);
  await s.runtime.pause(s.orgId);
  assert.equal((await s.next.flush(s.writer.id))!.outcome, 'skipped:paused');
  assert.deepEqual(wakesOf(s, s.writer.id), []);
  await s.runtime.resume(s.orgId);
  await s.org.setMemberStatus(s.orgId, s.writer.id, 'paused');
  assert.equal((await s.next.pull(s.orgId, s.writer.id)).outcome, 'skipped:member_inactive');
});

test('blocked work on the heartbeat: wakes only when the blocker changed, naming what; past the chase threshold a nudge; the back-off otherwise', async () => {
  const s = await setup();
  const t = await s.tasks.create(s.orgId, { title: 'Needs the editor', brief, assigneeAgentId: s.writer.id });
  await s.tasks.update(s.orgId, t.id, { blockedOn: { kind: 'agent', ref: s.editor.id, reason: 'the editor approves the outline' } }, `agent:${s.writer.id}`);
  const ext = await s.tasks.create(s.orgId, { title: 'Vendor key', brief, assigneeAgentId: s.writer.id });
  await s.tasks.update(s.orgId, ext.id, { blockedOn: { kind: 'external', reason: 'vendor sends the API key', until: new Date(Date.now() + 2 * 3_600_000).toISOString() } }, `agent:${s.writer.id}`);
  quiet(s);
  const t0 = Date.now();
  const at = (min: number) => new Date(t0 + min * 60_000);
  const about = async (key: string, now: Date) => (await s.runtime.heartbeatReasons(s.writer.id, now)).filter((r) => r.includes(key));
  assert.deepEqual(await about(t.key!, at(1)), [], 'first sight arms');
  assert.deepEqual(await about(t.key!, at(5)), [], 'nothing changed: no wake');
  await s.tasks.comment(s.orgId, t.id, { text: 'Outline approved', fromAgentId: s.editor.id, wake: false });
  const changed = await about(t.key!, at(6));
  assert.equal(changed.length, 1);
  assert.match(changed[0], /blocker changed: Editor replied on the task/);
  assert.deepEqual(await about(t.key!, at(7)), [], 'once per change');
  // the external blocker's expected date passes
  assert.deepEqual(await about(ext.key!, at(8)), [], 'armed');
  const due = await about(ext.key!, at(121));
  assert.equal(due.length, 1);
  assert.match(due[0], /expected date .* has passed/);
  // past the chase threshold: one nudge to chase or escalate and pick up other work
  await s.org.setTunable(s.orgId, 'work.chaseAfterHours', 3, { actor: 'user' });
  const nudge = await about(t.key!, at(3 * 60 + 5));
  assert.equal(nudge.length, 1);
  assert.match(nudge[0], /chase Editor with org_task_comment .* or escalate through your manager .*pick up other work meanwhile/);
  assert.deepEqual(await about(t.key!, at(3 * 60 + 6)), [], 'nudged once; then the back-off');
});

test('the heartbeat carries "Your next work": newly unblocked first, the top three, blocked items with what and since when', async () => {
  const s = await setup();
  await s.tasks.create(s.orgId, { title: 'Plain to-do', brief, assigneeAgentId: s.writer.id, projectId: s.now.id });
  const back = await s.tasks.create(s.orgId, { title: 'Back from blocked', brief, assigneeAgentId: s.writer.id, projectId: s.later.id });
  await s.tasks.update(s.orgId, back.id, { blockedOn: { kind: 'external', reason: 'waiting on data' } }, `agent:${s.writer.id}`);
  await s.tasks.update(s.orgId, back.id, { blockedOn: null }, 'user');
  const stuck = await s.tasks.create(s.orgId, { title: 'Still stuck', brief, assigneeAgentId: s.writer.id });
  await s.tasks.update(s.orgId, stuck.id, { blockedOn: { kind: 'agent', ref: s.editor.id, reason: 'needs the style guide' } }, `agent:${s.writer.id}`);
  const sec = (await s.next.section(s.writer.id, new Date()))!;
  assert.equal(sec.title, 'Your next work');
  const lines = sec.text.split('\n');
  assert.match(lines[1], /^1\. unblocked .*Back from blocked/);
  assert.match(lines[2], /^2\. to do .*Plain to-do.*Now/);
  assert.match(sec.text, /Blocked or waiting:\n- .*Still stuck.*waits on Editor: needs the style guide \(since \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
  const prompt = heartbeatPrompt(['task X is to do'], 'You write.', '', '', [`${sec.title}:\n${sec.text}`]);
  assert.match(prompt, /Your next work:\nNext \(in this order\)/);
});
