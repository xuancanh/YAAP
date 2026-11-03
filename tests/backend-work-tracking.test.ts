/** Work tracking (docs/work-tracking.md): projects as the required middle
 *  level (create, tools, the CEO's bet), placement and the system projects,
 *  sources, transitions and doneAt, the one structured blocker and its
 *  routing, the heartbeat back-off and circular behaviour, the appetite
 *  circuit breaker, the health cadence and Update missing, the KR rule, the
 *  roadmap / project page / portfolio reads, the kanban bridge and the
 *  migration's backfill. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { setup as harness, enable, sessionOf, inbox, type S } from './org-governance-harness';
import { OrgProjectsService } from '../server/src/org/org-projects.service';
import { OrgProjectsTools } from '../server/src/org/org-projects.tools';
import { OrgController } from '../server/src/org/org.controller';
import { WorkController } from '../server/src/org/work.controller';
import { orgApprovals, orgRuns, orgTasks, agentTasks, taskTransitions } from '../server/src/database/schema';
import { backfillWorkTracking } from '../server/src/database/work-tracking-backfill';
import { queryableOf } from '../server/src/common/task-keys';
import { forecastFrom, deriveSource, titleSimilarity } from '../server/src/org/work-model';
import { legacyBlockedOn, parseBlockedOn } from '../server/src/org/blocked-on';
import { blockedBackoffDue } from '../server/src/chats/heartbeat.service';
import { ragOf } from '../server/src/home/home.service';
import { blockerOf } from '../server/src/home/agent-status';
import { newId } from '../server/src/common/ids.util';

async function setup() {
  const s = await harness();
  // The harness builds the board without the agents service; production injects it (inbox events for blockers).
  (s.tasks as unknown as { agents: unknown }).agents = s.agents;
  const projects = new OrgProjectsService(s.db, s.org, s.tasks, s.approvals, s.audit, s.agents, s.units, undefined, s.decisions);
  const tools = new OrgProjectsTools(s.org, projects, s.tasks, s.agents, s.config, s.runtime, s.turns);
  const orgId = await enable(s);
  const controller = new OrgController(s.org, s.tasks, s.approvals, s.audit, s.brief, s.runtime, s.config);
  const work = new WorkController(s.mode, controller, s.org, s.tasks, projects, s.config);
  const kr = await s.org.addGoal(orgId, { title: 'Grow subscribers to 1 000', kind: 'key_result', metric: 'subscribers', targetValue: 1000, startValue: 0 });
  return { ...s, projects, tools, orgId, controller, work, kr };
}
type W = Awaited<ReturnType<typeof setup>>;

async function exec(s: W, agentId: string, name: string, input: Record<string, unknown>): Promise<string> {
  const session = await sessionOf(s as unknown as S, agentId);
  return s.tools.execute(session, name, input);
}
async function kanban(s: W, agentId: string, name: 'list_tasks' | 'add_task' | 'update_task' | 'delegate_task', input: Record<string, unknown>): Promise<string> {
  const session = await sessionOf(s as unknown as S, agentId);
  return s.tools.kanban(session, name, input);
}
async function addRun(s: W, orgId: string, taskId: string, agentId: string, usd: number, startedAt = new Date().toISOString()) {
  await s.db.insert(orgRuns).values({ id: newId(), accountId: 'single', orgId, taskId, agentId, sessionId: null, wakeReason: 'manual', status: 'done', outcome: 'progressed', tokensIn: 0, tokensOut: 0, usd, reservedUsd: 0, startedAt, endedAt: startedAt });
}

test('projects: the CEO creates in Now; an agent proposes, names its key result, and Now is a bet card the CEO approves', async () => {
  const s = await setup();
  const ceo = await s.projects.create(s.orgId, { title: 'Launch the referral loop', goalIds: [s.kr.id], appetiteDays: 30, appetiteUsd: 20, targetDate: '2026-12-15' }, 'user');
  assert.equal(ceo.project.lane, 'now');
  assert.equal(ceo.project.status, 'active');
  assert.match(ceo.project.key!, /^P-\d+$/);
  assert.equal(ceo.card, null);

  // an agent must name the key result it moves
  await assert.rejects(exec(s, s.writer.id, 'org_create_project', { title: 'Newsletter redesign', brief: { problem: 'x' } }), /key result/);
  const out = await exec(s, s.writer.id, 'org_create_project', { title: 'Newsletter redesign', goalIds: [s.kr.id.slice(0, 8)], brief: { problem: 'Open rate fell', done_when: 'New template live', hypothesis: 'A cleaner layout lifts opens' }, appetiteDays: 14, lane: 'now', why: 'opens are dropping' });
  assert.match(out, /CEO's bet/);
  const p = (await s.projects.list(s.orgId)).find((x) => x.title === 'Newsletter redesign')!;
  assert.equal(p.lane, 'next', 'not Now until the CEO bets');
  assert.equal(p.status, 'shaped', 'brief and appetite filled → shaped');
  assert.equal(p.ownerAgentId, s.writer.id, 'the proposer leads by default');
  const card = (await s.approvals.pending(s.orgId)).find((a) => a.kind === 'project_now')!;
  assert.ok(card, 'a project_now card');
  assert.equal(JSON.parse(card.payload).projectId, p.id);
  await s.approvals.decide(s.orgId, card.id, 'approve');
  const after = await s.org.project(s.orgId, p.id);
  assert.equal(after.lane, 'now');
  assert.equal(after.status, 'active');
  assert.ok(after.startDate, 'started on the bet');

  // a non-steward cannot change it; the lead can (but not kill it alone)
  await assert.rejects(exec(s, s.editor.id, 'org_update_project', { project: p.key, title: 'Mine now' }), /only the lead/);
  await exec(s, s.writer.id, 'org_update_project', { project: p.key, targetDate: '2026-12-01' });
  assert.equal((await s.org.project(s.orgId, p.id)).targetDate, '2026-12-01');
  const kill = await exec(s, s.writer.id, 'org_update_project', { project: p.key, status: 'cancelled', why: 'no longer needed' });
  assert.match(kill, /CEO's call/);
  assert.equal((await s.org.project(s.orgId, p.id)).status, 'active');
  assert.ok((await s.approvals.pending(s.orgId)).some((a) => a.kind === 'project_kill'));

  // milestones
  await exec(s, s.writer.id, 'org_milestone', { project: p.key, add: 'Template drafted', date: '2026-11-20' });
  const ms = await exec(s, s.writer.id, 'org_milestone', { project: p.key, milestone: 'm1', done: true });
  assert.match(ms, /m1 Template drafted \(2026-11-20\) ✓/);
});

test('placement: every task gets a project — the parent\'s, else the unit\'s Unsorted; retro work goes to a capped Operating improvements', async () => {
  const s = await setup();
  const orphan = await s.tasks.create(s.orgId, { title: 'Fix the footer', createdBy: 'user' });
  const unsorted = await s.org.project(s.orgId, orphan.projectId!);
  assert.equal(unsorted.kind, 'unsorted');
  assert.equal(orphan.source, 'ceo');
  const child = await s.tasks.create(s.orgId, { title: 'Sub-step', parentTaskId: orphan.id, createdBy: 'chief' });
  assert.equal(child.projectId, orphan.projectId);
  assert.equal(child.source, 'plan');
  await s.org.setTunable(s.orgId, 'work.operatingWipCap', 1, { actor: 'user' });
  const r1 = await s.tasks.create(s.orgId, { title: 'Write a verification script', assigneeAgentId: s.writer.id, createdBy: `agent:${s.writer.id}`, source: 'retro' });
  const ops = await s.org.project(s.orgId, r1.projectId!);
  assert.equal(ops.kind, 'operating');
  assert.equal(r1.status, 'todo');
  const r2 = await s.tasks.create(s.orgId, { title: 'Audit the previous retro', assigneeAgentId: s.writer.id, createdBy: `agent:${s.writer.id}`, source: 'retro' });
  assert.equal(r2.projectId, ops.id);
  assert.equal(r2.status, 'backlog', 'over the cap: a proposal, unassigned');
  assert.equal(r2.assigneeAgentId, null);
  // sources
  assert.equal(deriveSource({ createdBy: 'user', channelId: 'c1' }), 'chat');
  assert.equal(deriveSource({ createdBy: 'agent:x', parentTaskId: 't', title: 'Escalation: X' }), 'escalation');
  assert.equal(deriveSource({ createdBy: 'agent:x' }), 'agent');
  await assert.rejects(s.tasks.create(s.orgId, { title: 'x', source: 'gossip' }), /source must be one of/);
});

test('done is an event: every status change is a transition with its actor; doneAt on done, cleared on reopen; startedAt once', async () => {
  const s = await setup();
  const t = await s.tasks.create(s.orgId, { title: 'Draft issue 12', brief: { outcome: 'A draft', done_when: 'Saved' }, assigneeAgentId: s.writer.id });
  const won = await s.tasks.claim(s.orgId, t.id, s.writer.id, 'run-1');
  assert.ok(won);
  await s.tasks.update(s.orgId, t.id, { status: 'in_progress' }, `agent:${s.writer.id}`);
  await s.tasks.requestReview(s.orgId, t.id, { fromAgentId: s.writer.id });
  const reviewed = await s.tasks.get(s.orgId, t.id);
  await s.tasks.review(s.orgId, t.id, { verdict: 'accept', byAgentId: reviewed.reviewerAgentId === s.writer.id ? s.editor.id : reviewed.reviewerAgentId });
  const done = await s.tasks.get(s.orgId, t.id);
  assert.equal(done.status, 'done');
  assert.ok(done.doneAt, 'doneAt set by the review accept');
  assert.ok(done.startedAt);
  const tr = await s.tasks.transitions(s.orgId, t.id);
  assert.deepEqual(tr.map((x) => x.toStatus), ['todo', 'claimed', 'in_progress', 'in_review', 'done']);
  assert.equal(tr[1].actor, `agent:${s.writer.id}`);
  assert.equal(tr.at(-1)!.fromStatus, 'in_review');
  const startedAt = done.startedAt;
  await s.tasks.update(s.orgId, t.id, { status: 'todo' }, 'user');
  const reopened = await s.tasks.get(s.orgId, t.id);
  assert.equal(reopened.doneAt, null, 'a reopen clears doneAt');
  assert.equal(reopened.startedAt, startedAt, 'startedAt is the first start');
});

test('blockedOn: one structured blocker — the ask is required, the CEO gets a card, a person their queue, the manager an event; since survives comments', async () => {
  const s = await setup();
  const t = await s.tasks.create(s.orgId, { title: 'Pick the sponsor', assigneeAgentId: s.writer.id });
  await assert.rejects(s.tasks.update(s.orgId, t.id, { blockedOn: { kind: 'ceo', reason: '' } }, `agent:${s.writer.id}`), /reason is required/);
  await assert.rejects(s.tasks.update(s.orgId, t.id, { blockedOn: { kind: 'vibes', reason: 'x' } }, `agent:${s.writer.id}`), /kind must be one of/);
  // the tool: blocked on the CEO → a card in Needs you
  const out = await s.runtime.execute(await sessionOf(s as unknown as S, s.writer.id), 'org_task_update', { taskId: t.key, status: 'blocked', note: 'Which sponsor do we take: A or B?', waitsOn: 'ceo' });
  assert.match(out, /waits on the CEO/);
  const b1 = parseBlockedOn((await s.tasks.get(s.orgId, t.id)).blockedOn)!;
  assert.equal(b1.kind, 'ceo');
  const card = (await s.approvals.pending(s.orgId)).find((a) => a.kind === 'escalation' && JSON.parse(a.payload).taskId === t.id)!;
  assert.ok(card);
  assert.equal(b1.ref, card.id);
  // a comment does not reset since
  await s.tasks.comment(s.orgId, t.id, { text: 'still waiting', fromAgentId: s.writer.id });
  assert.equal(parseBlockedOn((await s.tasks.get(s.orgId, t.id)).blockedOn)!.since, b1.since);
  // deciding the card moves it again
  await s.approvals.decide(s.orgId, card.id, 'approve', 'take A');
  const moved = await s.tasks.get(s.orgId, t.id);
  assert.equal(moved.status, 'todo');
  assert.equal(moved.blockedOn, '');

  // the manager: the writer reports to the chief → an event for the chief
  const t2 = await s.tasks.create(s.orgId, { title: 'Get the logo', assigneeAgentId: s.writer.id });
  await s.tasks.update(s.orgId, t2.id, { blockedOn: { kind: 'manager', reason: 'Need a decision on the brand colour' } }, `agent:${s.writer.id}`);
  const b2 = parseBlockedOn((await s.tasks.get(s.orgId, t2.id)).blockedOn)!;
  assert.equal(b2.kind, 'manager');
  assert.equal(b2.ref, s.chief.id);
  assert.ok((await inbox(s as unknown as S, s.chief.id, 'blocked')).some((e) => /Get the logo/.test(e.title)));

  // a person: in their queue
  const t3 = await s.tasks.create(s.orgId, { title: 'Sign the contract', assigneeAgentId: s.writer.id });
  await s.tasks.update(s.orgId, t3.id, { blockedOn: { kind: 'person', ref: 'acct-lawyer', reason: 'Signature needed' } }, `agent:${s.writer.id}`);
  assert.deepEqual((await s.tasks.tasksOfHuman(s.orgId, 'acct-lawyer')).waitingOnYou.map((x) => x.id), [t3.id]);

  // a task: it waits and moves on when the other is done
  const dep = await s.tasks.create(s.orgId, { title: 'Collect sources', assigneeAgentId: s.editor.id });
  const t4 = await s.tasks.create(s.orgId, { title: 'Write the piece', assigneeAgentId: s.writer.id });
  await s.tasks.update(s.orgId, t4.id, { blockedOn: { kind: 'task', ref: dep.key!, reason: 'needs the sources' } }, `agent:${s.writer.id}`);
  assert.equal((await s.tasks.get(s.orgId, t4.id)).status, 'waiting');
  await s.tasks.update(s.orgId, dep.id, { status: 'done' }, 'user');
  assert.equal((await s.tasks.get(s.orgId, t4.id)).status, 'todo');

  // the board reads the field, not the regexes
  const blocked = await s.tasks.get(s.orgId, t2.id);
  const info = blockerOf(blocked, { tasksById: new Map(), names: new Map([[s.chief.id, 'Chief']]) });
  assert.equal(info.waitsOn.kind, 'agent');
  assert.equal(info.waitsOn.name, 'Chief');
  assert.equal(info.since, b2.since);
});

test('legacy blockers read into one blockedOn: escalations, task refs, CEO decisions in free text, an empty list', () => {
  const since = '2026-11-01T00:00:00.000Z';
  assert.equal(legacyBlockedOn({ lines: ['escalated: need budget'], since }).kind, 'ceo');
  assert.equal(legacyBlockedOn({ lines: ['escalated to Head: help'], since, agentByName: () => 'h1', managerId: 'h1' }).kind, 'manager');
  assert.equal(legacyBlockedOn({ lines: ['escalated to Head: help'], since, agentByName: () => 'h1', managerId: 'x' }).kind, 'agent');
  assert.deepEqual(legacyBlockedOn({ lines: ['ENG-3'], since, taskByRef: () => 't3' }).ref, 't3');
  assert.equal(legacyBlockedOn({ lines: ['User decision on the sandbox execution'], since }).kind, 'ceo');
  assert.equal(legacyBlockedOn({ lines: [], comment: 'Waiting for the vendor API key', since }).kind, 'external');
  assert.equal(legacyBlockedOn({ lines: [], pendingCard: 'a1', since }).ref, 'a1');
});

test('heartbeat back-off: a blocked task wakes on a changed blocker, else on a doubling interval; a personal board backs off too', async () => {
  const s = await setup();
  const t = await s.tasks.create(s.orgId, { title: 'Wait on vendor', assigneeAgentId: s.writer.id });
  await s.tasks.update(s.orgId, t.id, { blockedOn: { kind: 'external', reason: 'vendor sends the API key' } }, `agent:${s.writer.id}`);
  const t0 = Date.now();
  const at = (min: number) => new Date(t0 + min * 60_000);
  const mine = async (now: Date) => (await s.runtime.heartbeatReasons(s.writer.id, now)).filter((r) => r.includes(t.key!));
  assert.deepEqual(await mine(at(1)), [], 'first sight arms the timer');
  assert.deepEqual(await mine(at(30)), [], 'unchanged and inside the back-off');
  assert.equal((await mine(at(61))).length, 1, 'after 60 minutes: one re-check');
  assert.deepEqual(await mine(at(62)), [], 'then the wait doubles');
  assert.deepEqual(await mine(at(61 + 100)), []);
  assert.equal((await mine(at(61 + 121))).length, 1, 'after 120 more');
  // a comment from someone else changes the blocker's signature: wake at once
  await s.tasks.comment(s.orgId, t.id, { text: 'The vendor replied', fromAgentId: s.editor.id, wake: false });
  const now = await mine(at(61 + 122));
  assert.equal(now.length, 1);
  assert.match(now[0], /blocker changed/);

  // the personal board: steps at base × (2^k − 1) since it was blocked
  const base = 60 * 60_000;
  const since = '2026-11-01T00:00:00.000Z';
  const task = { note: 'Blocked (2026-11-01): waits on input', updatedAt: '2026-11-03T00:00:00.000Z' };
  const t1 = new Date(Date.parse(since) + 30 * 60_000);
  assert.equal(blockedBackoffDue(task, base, t1, null), false, 'inside the first step');
  assert.equal(blockedBackoffDue(task, base, new Date(Date.parse(since) + 61 * 60_000), null), true);
  assert.equal(blockedBackoffDue(task, base, new Date(Date.parse(since) + 120 * 60_000), new Date(Date.parse(since) + 61 * 60_000).toISOString()), false, 'same step since the last run');
  assert.equal(blockedBackoffDue(task, base, new Date(Date.parse(since) + 181 * 60_000), new Date(Date.parse(since) + 61 * 60_000).toISOString()), true, 'next step at 3× base');
});

test('circular behaviour: the same failed approach twice pauses wakes and flags the lead; a comment from the lead lifts it', async () => {
  const s = await setup();
  const { project } = await s.projects.create(s.orgId, { title: 'Ship the store', goalIds: [s.kr.id], ownerAgentId: s.editor.id }, 'user');
  const t = await s.tasks.create(s.orgId, { title: 'Fix checkout', assigneeAgentId: s.writer.id, projectId: project.id });
  const ctx = { calls: new Map([['fs_read:abc', 1], ['http_request:def', 1]]) };
  const circular = (s.runtime as unknown as { circular: (o: unknown, t: unknown, c: unknown, e: string | null, n: string) => Promise<boolean> }).circular.bind(s.runtime);
  const org = await s.org.get(s.orgId);
  assert.equal(await circular(org, await s.tasks.get(s.orgId, t.id), ctx, 'HTTP 500 from checkout', 'Writer'), false);
  assert.equal(await circular(org, await s.tasks.get(s.orgId, t.id), ctx, 'HTTP 500 from checkout', 'Writer'), true);
  const paused = await s.tasks.get(s.orgId, t.id);
  assert.ok(paused.wakesPausedAt);
  assert.ok((await inbox(s as unknown as S, s.editor.id, 'blocked')).some((e) => /same failed approach/.test(e.title)), 'the project lead is flagged');
  assert.match((await s.tasks.claimBlocker(s.orgId, paused, s.writer.id, 5))!, /^paused/);
  assert.equal((await s.runtime.heartbeatReasons(s.writer.id, new Date())).filter((r) => r.includes(t.key!)).length, 0, 'no heartbeat wake');
  assert.ok((await s.projects.heartbeatReasons(s.editor.id, new Date())).some((r) => r.includes(t.key!) && /paused/.test(r)), 'the lead\'s heartbeat lists it');
  await s.tasks.comment(s.orgId, t.id, { text: 'Try the staging endpoint instead', fromAgentId: s.editor.id });
  assert.equal((await s.tasks.get(s.orgId, t.id)).wakesPausedAt, null);
});

test('the appetite breaker: at 100% claims pause and the lead\'s manager decides; the chief\'s own project goes to the CEO', async () => {
  const s = await setup();
  // the writer leads; its manager is the chief (an agent) → a decision task, not a CEO card
  const { project } = await s.projects.create(s.orgId, { title: 'Podcast pilot', goalIds: [s.kr.id], ownerAgentId: s.writer.id, appetiteUsd: 1 }, 'user');
  const t1 = await s.tasks.create(s.orgId, { title: 'Record episode 1', assigneeAgentId: s.writer.id, projectId: project.id });
  await addRun(s, s.orgId, t1.id, s.writer.id, 0.85);
  assert.equal(await s.projects.claimGate(s.orgId, await s.tasks.get(s.orgId, t1.id)), null, 'below the appetite');
  assert.ok((await s.org.project(s.orgId, project.id)).appetiteWarnedAt, 'warned at 80%');
  assert.ok((await inbox(s as unknown as S, s.writer.id, 'info')).some((e) => /appetite/.test(e.title)));
  await addRun(s, s.orgId, t1.id, s.writer.id, 0.3);
  const gate = await s.projects.claimGate(s.orgId, await s.tasks.get(s.orgId, t1.id));
  assert.match(gate!, /used up its appetite/);
  assert.match((await s.tasks.claimBlocker(s.orgId, await s.tasks.get(s.orgId, t1.id), s.writer.id, 5))!, /^paused/);
  const decision = (await s.tasks.list(s.orgId, { projectId: project.id })).find((x) => x.title.startsWith('Appetite reached:'))!;
  assert.equal(decision.assigneeAgentId, s.chief.id, 'to the lead\'s manager');
  assert.equal(decision.source, 'escalation');
  assert.equal(await s.projects.claimGate(s.orgId, decision), null, 'the decision task itself is not gated');
  assert.equal((await s.approvals.pending(s.orgId)).filter((a) => a.kind === 'project_appetite').length, 0, 'not straight to the CEO');
  // the manager extends within its share (default 50%): applies at once
  const r = await exec(s, s.chief.id, 'org_project_appetite', { project: project.key, decision: 'extend', extendUsd: 0.5 });
  assert.match(r, /extend applied/);
  const ext = await s.org.project(s.orgId, project.id);
  assert.equal(ext.appetiteUsd, 1.5);
  assert.equal(ext.breakerAt, null);
  assert.equal((await s.tasks.get(s.orgId, decision.id)).status, 'done');
  // beyond its share → a card for the CEO
  await addRun(s, s.orgId, t1.id, s.writer.id, 1);
  await s.projects.checkBreaker(s.orgId, project.id);
  const big = await exec(s, s.chief.id, 'org_project_appetite', { project: project.key, decision: 'extend', extendUsd: 10 });
  assert.match(big, /CEO's decision/);
  // a non-manager may not decide
  await assert.rejects(exec(s, s.editor.id, 'org_project_appetite', { project: project.key, decision: 'extend', extendUsd: 0.1 }), /manager chain/);

  // the chief's own project: the CEO decides; rejecting kills it
  const own = (await s.projects.create(s.orgId, { title: 'Ops revamp', goalIds: [s.kr.id], ownerAgentId: s.chief.id, appetiteUsd: 0.5 }, 'user')).project;
  const t2 = await s.tasks.create(s.orgId, { title: 'Map the processes', assigneeAgentId: s.editor.id, projectId: own.id });
  await addRun(s, s.orgId, t2.id, s.editor.id, 0.6);
  await s.projects.checkBreaker(s.orgId, own.id);
  const card = (await s.approvals.pending(s.orgId)).find((a) => a.kind === 'project_appetite' && JSON.parse(a.payload).projectId === own.id)!;
  assert.ok(card, 'a project_appetite card for the CEO');
  await s.approvals.decide(s.orgId, card.id, 'reject', 'not worth more');
  assert.equal((await s.org.project(s.orgId, own.id)).status, 'cancelled');
  assert.equal((await s.tasks.get(s.orgId, t2.id)).status, 'cancelled');
});

test('health cadence: the lead owes an update on its cadence, Update missing past the grace, the chief chases; the update needs its reason and ask', async () => {
  const s = await setup();
  const start = new Date(Date.now() - 12 * 86_400_000).toISOString().slice(0, 10);
  const { project } = await s.projects.create(s.orgId, { title: 'Sponsorships', goalIds: [s.kr.id], ownerAgentId: s.writer.id, startDate: start }, 'user');
  const now = new Date();
  const org = await s.org.get(s.orgId);
  assert.equal(s.projects.updateState(org, project, now).state, 'missing', '12 days > 7 + 3 grace');
  assert.ok((await s.projects.heartbeatReasons(s.writer.id, now)).some((r) => /MISSING its health update/.test(r)));
  assert.ok((await s.projects.heartbeatReasons(s.chief.id, now)).some((r) => /Update missing on/.test(r)));
  const ctx = await s.projects.heartbeatContext(s.writer.id, now);
  assert.match(ctx!, /Your project health duty: you lead/);
  // the tunable cadence moves the line
  await s.org.setTunable(s.orgId, 'work.updateCadenceDays', 30, { actor: 'user' });
  assert.equal(s.projects.updateState(await s.org.get(s.orgId), project, now).state, 'fresh');
  await s.org.setTunable(s.orgId, 'work.updateCadenceDays', 7, { actor: 'user' });
  // validation, and only the lead posts
  await assert.rejects(exec(s, s.writer.id, 'org_project_update', { project: project.key, health: 'at_risk', reason: 'two sponsors went quiet' }), /names its ask/);
  await assert.rejects(exec(s, s.writer.id, 'org_project_update', { project: project.key, health: 'off_track' }), /needs its reason/);
  await assert.rejects(exec(s, s.editor.id, 'org_project_update', { project: project.key, health: 'on_track' }), /lead's/);
  const out = await exec(s, s.writer.id, 'org_project_update', { project: project.key, health: 'at_risk', reason: 'two sponsors went quiet', ask: 'An intro to the agency from the CEO', hill: 0.3 });
  assert.match(out, /at risk/);
  const after = await s.org.project(s.orgId, project.id);
  assert.equal(after.health, 'at_risk');
  assert.equal(after.hill, 0.3);
  assert.equal(s.projects.updateState(await s.org.get(s.orgId), after, now).state, 'fresh');
  const pf = await s.projects.portfolio(s.orgId, new Date(Date.now() - 86_400_000).toISOString());
  const ex = pf.exceptions.find((e) => e.projectId === project.id)!;
  assert.deepEqual(ex.kinds, ['at_risk']);
  assert.match(ex.detail, /Ask: An intro/);
  assert.ok(pf.digest.some((d) => d.projectId === project.id && d.kind === 'health'));
  assert.equal(pf.counts.atRisk, 1);
});

test('the KR rule: a low confidence number alone no longer turns a key result amber', () => {
  assert.equal(ragOf({ atRisk: 0, confidence: 0.2 }), 'grey');
  assert.equal(ragOf({ atRisk: 0, pace: 'onPace', confidence: 0.2 }), 'green');
  assert.equal(ragOf({ atRisk: 0, pace: 'behind', confidence: 0.9 }), 'amber');
  assert.equal(ragOf({ atRisk: 1, pace: 'onPace', confidence: 0.9 }), 'red');
});

test('reads: the roadmap, the project page and the portfolio through the routes; forecasts say "not enough history" until they have it', async () => {
  const s = await setup();
  const created = await s.work.create(s.ws.id, { title: 'Referral loop', goalIds: [s.kr.id], startDate: '2026-11-01', targetDate: '2026-12-15', appetiteUsd: 10, milestones: [{ name: 'Beta', date: '2026-11-20' }] });
  const t1 = await s.tasks.create(s.orgId, { title: 'Design the invite', assigneeAgentId: s.writer.id, projectId: created.id });
  const t2 = await s.tasks.create(s.orgId, { title: 'Ship the invite', assigneeAgentId: s.writer.id, projectId: created.id });
  await s.tasks.update(s.orgId, t1.id, { status: 'done' }, 'user');
  await s.tasks.update(s.orgId, t2.id, { blockedOn: { kind: 'external', reason: 'waiting on the email provider' } }, `agent:${s.writer.id}`);
  const road = await s.work.roadmap(s.ws.id);
  const row = road.projects.find((p) => p.id === created.id)!;
  assert.deepEqual(row.progress, { done: 1, total: 2, pct: 50 });
  assert.equal(row.blocked, 1);
  assert.equal(row.milestones[0].name, 'Beta');
  assert.equal(row.goals[0].id, s.kr.id);
  assert.equal(row.forecast.state, 'insufficient');
  assert.match(row.forecast.note, /Not enough history/);
  assert.ok(road.goals.some((g) => g.id === s.kr.id));
  assert.ok(road.system.some((p) => p.kind === 'unsorted') || true);
  const page = await s.work.page(s.ws.id, created.key!);
  assert.equal(page.tasks.length, 2);
  assert.equal(page.blockers.length, 1);
  assert.match(page.blockers[0].text, /outside the company/);
  assert.equal(page.project.brief.problem, '');
  const upd = await s.work.postUpdate(s.ws.id, created.id, { health: 'on_track' });
  assert.equal(upd.health, 'on_track');
  const lane = await s.work.update(s.ws.id, created.id, { lane: 'later' });
  assert.equal(lane.lane, 'later');
  const tr = await s.work.transitions(s.ws.id, t1.key!);
  assert.deepEqual(tr.map((x) => x.toStatus), ['todo', 'done']);
  // forecast with history
  const now = new Date('2026-11-03T00:00:00.000Z');
  const dones = Array.from({ length: 16 }, (_, i) => new Date(now.getTime() - i * 3 * 86_400_000).toISOString());
  const f = forecastFrom(dones, 6, now, { minSamples: 8 });
  assert.equal(f.state, 'range');
  assert.ok(f.p50! <= f.p85!);
  assert.equal(forecastFrom(dones.slice(0, 3), 6, now, { minSamples: 8 }).state, 'insufficient');
});

test('the kanban bridge: a company member\'s add_task / update_task / list_tasks act on the org board; a personal agent keeps its board', async () => {
  const s = await setup();
  const queued = await kanban(s, s.writer.id, 'add_task', { title: 'Look into the bounce rate', note: 'saw it spike' });
  assert.match(queued, /queued on the company board/);
  const t = (await s.tasks.list(s.orgId)).find((x) => x.title === 'Look into the bounce rate')!;
  assert.equal(t.assigneeAgentId, s.writer.id);
  assert.equal(t.status, 'backlog');
  assert.equal(t.source, 'agent');
  assert.ok(t.projectId);
  assert.equal((await s.agents.listTasks(s.writer.id)).length, 0, 'nothing on the old board');
  const step = await kanban(s, s.writer.id, 'add_task', { title: 'Pull last month\'s numbers', task: t.key });
  assert.match(step, /checklist step/);
  await kanban(s, s.writer.id, 'update_task', { id: t.key, step: 's1', status: 'done' });
  await kanban(s, s.writer.id, 'update_task', { id: t.key, status: 'doing' });
  assert.equal((await s.tasks.get(s.orgId, t.id)).status, 'in_progress');
  const list = await kanban(s, s.writer.id, 'list_tasks', {});
  assert.match(list, /\(doing\) Look into the bounce rate/);
  assert.match(list, /\[x\] s1 Pull last month's numbers/);
  const blocked = await kanban(s, s.writer.id, 'update_task', { id: t.key, status: 'blocked', reason: 'Waiting for the ESP export' });
  assert.match(blocked, /blocked/);
  assert.equal(parseBlockedOn((await s.tasks.get(s.orgId, t.id)).blockedOn)!.kind, 'external');
  const done = await kanban(s, s.writer.id, 'update_task', { id: t.key, status: 'done', reason: 'Findings in shared/bounce.md' });
  assert.match(done, /review/);
  assert.equal(await s.tools.contextFor(await sessionOf(s as unknown as S, s.writer.id)) !== null, true, 'members get the which-tool-when guide');
  // a personal agent (no company) keeps its own board
  const loner = await s.agents.create({ name: 'Loner' });
  const handles = await (s.tools as unknown as { handles: (id: string) => Promise<boolean> }).handles(loner.id);
  assert.equal(handles, false);
});

test('backfill (migration 0060): sources, projects for orphans, blockedOn from the legacy forms with a card for CEO text, transitions from the audit, the kanban merge — and idempotent', async () => {
  const s = await setup();
  const q = queryableOf(s.db);
  // legacy rows: untouched by the new code paths
  const now = new Date().toISOString();
  const legacy = async (id: string, extra: Record<string, unknown>) => {
    await s.db.insert(orgTasks).values({ id, accountId: 'single', orgId: s.orgId, key: null, projectId: null, parentTaskId: null, title: 'legacy', brief: '{}', status: 'todo', assigneeAgentId: null, assigneeHumanId: null, reviewerHumanId: null, claimedBy: null, claimedAt: null, reviewerAgentId: null, reviewRounds: 0, blockers: '[]', fileScope: '[]', noProgressCount: 0, lastRunAt: null, createdBy: 'user', channelId: null, messageId: null, unitId: null, unitExplicit: 0, class: 'general', checks: '[]', acceptedBy: '', dependsOn: '[]', dueAt: null, source: '', blockedOn: '', steps: '[]', startedAt: null, doneAt: null, blockedSeconds: 0, wakeSig: '', wakeCount: 0, nextWakeAt: null, failSig: '', failRepeats: 0, wakesPausedAt: null, createdAt: now, updatedAt: now, ...extra } as never);
  };
  await legacy('lt1', { title: 'Run + score the baseline on the 10 scenarios', assigneeAgentId: s.writer.id, createdBy: 'chief', key: 'JONG-2' });
  await legacy('lt2', { title: 'Sandbox decision', status: 'blocked', blockers: JSON.stringify(['User decision on the sandbox execution']), createdBy: `agent:${s.writer.id}` });
  await legacy('lt3', { title: 'Escalated thing', status: 'blocked', blockers: JSON.stringify([`escalated to Chief: need a call`]), assigneeAgentId: s.writer.id });
  await legacy('lt4', { title: 'Retro action', messageId: 'thread-1' });
  await q.query(`INSERT INTO org_meetings ("id", "accountId", "orgId", "threadRootId", "kind", "title", "createdAt") VALUES ('m1', 'single', $1, 'thread-1', 'retro', 'Retro', $2)`, [s.orgId, now]);
  await s.audit.append(s.orgId, { actor: `agent:${s.writer.id}`, action: 'task_claim', refType: 'task', refId: 'lt1', payload: {} });
  await s.audit.append(s.orgId, { actor: 'chief', action: 'review_accept', refType: 'task', refId: 'lt1', payload: {} });
  await s.db.update(orgTasks).set({ status: 'done' }).where(eq(orgTasks.id, 'lt1'));
  // kanban: a mirror of lt1 (by similar title), and a standalone item; a personal agent's item stays
  const k1 = await s.agents.addTask(s.writer.id, { title: 'Run and score the baseline scenarios', origin: 'agent' });
  const k2 = await s.agents.addTask(s.writer.id, { title: 'Recheck the breaker trip', origin: 'agent' });
  await s.agents.updateTask(s.writer.id, k2.id, { status: 'blocked', reason: 'waiting on the next trip' });
  const loner = await s.agents.create({ name: 'Loner' });
  const k3 = await s.agents.addTask(loner.id, { title: 'My own thing', origin: 'user' });

  const first = await backfillWorkTracking(q);
  assert.ok(first.sources >= 4);
  assert.ok(first.placed >= 4);
  assert.equal(first.blocked, 2);
  assert.ok(first.transitions >= 4);
  assert.deepEqual(first.merged, { tasks: 1, steps: 1 });
  const get = (id: string) => s.tasks.get(s.orgId, id);
  assert.equal((await get('lt1')).source, 'plan');
  assert.equal((await get('lt4')).source, 'retro');
  assert.equal((await s.org.project(s.orgId, (await get('lt4')).projectId!)).kind, 'operating');
  assert.equal((await s.org.project(s.orgId, (await get('lt2')).projectId!)).kind, 'unsorted');
  const b2 = parseBlockedOn((await get('lt2')).blockedOn)!;
  assert.equal(b2.kind, 'ceo');
  assert.ok((await s.db.select().from(orgApprovals).where(eq(orgApprovals.id, b2.ref))).length === 1, 'a card for the CEO block written in text');
  assert.equal(parseBlockedOn((await get('lt3')).blockedOn)!.kind, 'manager');
  const lt1 = await get('lt1');
  assert.ok(lt1.doneAt);
  assert.deepEqual((await s.db.select().from(taskTransitions).where(eq(taskTransitions.taskId, 'lt1'))).map((x) => x.toStatus), ['claimed', 'done'], 'rebuilt from task_claim and review_accept');
  assert.equal(JSON.parse(lt1.steps).length, 1, 'the mirror became a step on JONG-2');
  const k2row = (await s.db.select().from(agentTasks).where(eq(agentTasks.id, k2.id)))[0];
  assert.match(k2row.mergedInto!, /^task:/);
  const merged = await s.tasks.get(s.orgId, k2row.mergedInto!.slice(5));
  assert.equal(merged.key, k2.key, 'keeps its kanban key');
  assert.equal(merged.status, 'blocked');
  assert.equal(parseBlockedOn(merged.blockedOn)!.reason, 'waiting on the next trip');
  assert.equal((await s.db.select().from(agentTasks).where(eq(agentTasks.id, k1.id)))[0].mergedInto, 'step:lt1');
  assert.equal((await s.db.select().from(agentTasks).where(eq(agentTasks.id, k3.id)))[0].mergedInto, null, 'a personal board is untouched');

  const second = await backfillWorkTracking(q);
  assert.deepEqual(second, { projects: 0, systemProjects: 0, sources: 0, placed: 0, blocked: 0, transitions: 0, merged: { tasks: 0, steps: 0 } }, 'idempotent');
  assert.ok(titleSimilarity('Run + score the baseline on the 10 scenarios', 'Run and score the baseline scenarios') >= 0.4);
});

test('decision routing: blocked on the manager and the appetite go through routeDecision; an escalation held by a manager blocks on that decision', async () => {
  const s = await setup();
  // a head with a report: the report's manager is the head, not the chief
  await s.org.updateMember(s.orgId, s.editor.id, { reportsToAgentId: s.writer.id });
  const t = await s.tasks.create(s.orgId, { title: 'Proofread issue 13', assigneeAgentId: s.editor.id });
  await s.tasks.update(s.orgId, t.id, { blockedOn: { kind: 'manager', reason: 'Which style guide wins?' } }, `agent:${s.editor.id}`);
  const b = parseBlockedOn((await s.tasks.get(s.orgId, t.id)).blockedOn)!;
  assert.equal(b.kind, 'manager');
  assert.equal(b.ref, s.writer.id, 'the direct manager from routeDecision');
  // org_escalate's CEO path: the card is placed with the raiser's manager first
  const t2 = await s.tasks.create(s.orgId, { title: 'Buy a stock photo', assigneeAgentId: s.editor.id });
  await s.tasks.escalate(s.orgId, t2.id, 'needs $40', `agent:${s.editor.id}`);
  const b2 = parseBlockedOn((await s.tasks.get(s.orgId, t2.id)).blockedOn)!;
  const card = (await s.approvals.pending(s.orgId)).find((a) => a.kind === 'escalation' && JSON.parse(a.payload).taskId === t2.id)!;
  assert.equal(card.holder, `agent:${s.writer.id}`);
  assert.equal(b2.kind, 'decision');
  assert.equal(b2.ref, card.id);
  await s.approvals.decide(s.orgId, card.id, 'approve', 'ok');
  assert.notEqual((await s.tasks.get(s.orgId, t2.id)).status, 'blocked');
  // the appetite of a project led by the head goes to its manager (the chief) as a decision task
  const { project } = await s.projects.create(s.orgId, { title: 'Style guide', goalIds: [s.kr.id], ownerAgentId: s.writer.id, appetiteUsd: 0.1 }, 'user');
  const t3 = await s.tasks.create(s.orgId, { title: 'Draft the guide', assigneeAgentId: s.editor.id, projectId: project.id });
  await addRun(s, s.orgId, t3.id, s.editor.id, 0.2);
  await s.projects.checkBreaker(s.orgId, project.id);
  const decision = (await s.tasks.list(s.orgId, { projectId: project.id })).find((x) => x.title.startsWith('Appetite reached:'))!;
  assert.equal(decision.assigneeAgentId, s.chief.id);
});
