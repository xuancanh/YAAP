/** The Inbox's History (docs/home.md "Inbox"): `GET /api/workspaces/:id/inbox/history`
 *  composes what used to wait on the owner from the records that hold each
 *  resolution — decided cards (by hand, by default, by a delegate person or
 *  agent role, expired), keys on held and staged actions (attributed through
 *  their two_key card), plans (applied by the window closing = the default,
 *  applied now, vetoed), incidents (contained, resolved), my tasks done and
 *  follows I saw — with the kind / search / date / without-you filters,
 *  cursor pagination and workspace and account scoping. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigService } from '@nestjs/config';
import { actionLog, follows, orgApprovals, orgDelegations, orgIncidents, orgPlans, orgTasks, workspaceMembers } from '../server/src/database/schema';
import { runWithAccount, runWithViewer, type Viewer } from '../server/src/accounts/account-context';
import { AgentsService } from '../server/src/agents/agents.service';
import { WorkspacesService } from '../server/src/workspaces/workspaces.service';
import { TriggerBus } from '../server/src/chats/trigger-bus';
import { OrgAuditService } from '../server/src/org/org-audit.service';
import { OrgService } from '../server/src/org/org.service';
import { InboxHistoryService, actionOutcome, approvalOutcome, decodeCursor, encodeCursor, type HistoryItem } from '../server/src/home/inbox-history.service';
import { InboxController } from '../server/src/home/inbox.controller';
import { testDb, memStorage } from './helpers';

const H = 3_600_000;
const ago = (h: number) => new Date(Date.now() - h * H).toISOString();
let seq = 0;
const id = (p: string) => `${p}${++seq}`;

async function setup() {
  const db = await testDb();
  const { stub } = memStorage();
  const bus = new TriggerBus();
  const agents = new AgentsService(db, stub, bus);
  const workspaces = new WorkspacesService(db, stub);
  const config = { get: (k: string) => (k === 'companiesEnabled' ? true : undefined) } as unknown as ConfigService;
  const audit = new OrgAuditService(db);
  const org = new OrgService(db, agents, audit, bus);
  const ws = (await workspaces.list())[0];
  const o = await org.create({ workspaceId: ws.id, name: 'Acme', mission: 'Ship.', chief: { name: 'Chief', charter: 'You run Acme.' } });
  const controllerAgent = await agents.create({ name: 'Penny', charter: 'You control spend.' });
  const writer = await agents.create({ name: 'Writer', charter: 'You write.' });
  await db.insert(workspaceMembers).values({ id: id('wm'), workspaceId: ws.id, memberAccountId: 'fin-1', role: 'member', displayName: 'Fin', email: 'fin@x', joinedAt: ago(100) });
  const history = new InboxHistoryService(db, config, org);
  return { db, agents, workspaces, audit, org, orgId: o.id, chiefId: o.chiefOfStaffAgentId!, ws, controllerAgent, writer, history, ctrl: new InboxController(history) };
}
type S = Awaited<ReturnType<typeof setup>>;

const card = (s: S, over: Partial<typeof orgApprovals.$inferInsert>) => s.db.insert(orgApprovals).values({
  id: id('a'), orgId: s.orgId, kind: 'tune', payload: JSON.stringify({ key: 'intent.paceTolerance', value: 0.2 }), requestedBy: 'chief', recommendation: 'tighten the pace',
  status: 'approved', decidedAt: ago(1), decidedBy: 'single', createdAt: ago(10), expiresAt: ago(-60), ...over,
}).returning().then((r) => r[0]);
const action = (s: S, over: Partial<typeof actionLog.$inferInsert>) => s.db.insert(actionLog).values({
  id: id('x'), key: id('key'), workspaceId: s.ws.id, agentId: s.writer.id, sessionId: 'sess-1', orgId: s.orgId, tool: 'gmail_send', class: 'external_irreversible',
  inputHash: 'h', status: 'succeeded', keys: JSON.stringify({ why: 'irreversible at level 1' }), createdAt: ago(5), finishedAt: ago(1), ...over,
}).returning().then((r) => r[0]);
const plan = (s: S, over: Partial<typeof orgPlans.$inferInsert>) => s.db.insert(orgPlans).values({
  id: id('p'), orgId: s.orgId, trigger: 'daily', summary: 'Open two tasks', actions: JSON.stringify([{}, {}]), status: 'applied', result: JSON.stringify([{ ok: true }, { ok: true }]),
  createdAt: ago(4), applyAt: ago(3), appliedAt: ago(3), decidedBy: 'system', ...over,
}).returning().then((r) => r[0]);
const task = (s: S, over: Partial<typeof orgTasks.$inferInsert>) => s.db.insert(orgTasks).values({
  id: id('t'), orgId: s.orgId, title: 'Write the launch post', status: 'done', createdAt: ago(20), updatedAt: ago(2), ...over,
}).returning().then((r) => r[0]);
const follow = (s: S, over: Partial<typeof follows.$inferInsert>) => s.db.insert(follows).values({
  id: id('f'), workspaceId: s.ws.id, followerKind: 'user', followerId: 'single', targetKind: 'thread', targetId: id('m'), title: '#general: launch plan',
  link: '#/ws/w/channel/general/m', createdAt: ago(30), lastSeenAt: ago(6), lastActivity: 'replied: ok', lastActorName: 'Ada', ...over,
}).returning().then((r) => r[0]);

async function all(s: S, q: Record<string, string> = {}): Promise<HistoryItem[]> {
  return (await s.ctrl.list(s.ws.id, q.kind, q.q, q.from, q.to, q.cursor, q.limit ?? '100', q.without)).items;
}
const byKey = (items: HistoryItem[], key: string) => items.find((i) => i.key === key);

test('pure: outcome words and the cursor', () => {
  assert.equal(approvalOutcome('approved'), 'approved');
  assert.equal(approvalOutcome('revision_requested'), 'revision_requested');
  assert.equal(approvalOutcome('expired'), 'expired');
  assert.equal(actionOutcome('succeeded'), 'released');
  assert.equal(actionOutcome('denied'), 'denied');
  assert.equal(actionOutcome('held'), null);
  const c = encodeCursor('2026-11-02T08:00:00.000Z', 'a:1|x');
  assert.deepEqual(decodeCursor(c), { at: '2026-11-02T08:00:00.000Z', key: 'a:1|x' });
  assert.throws(() => decodeCursor('garbage'), /bad cursor/);
});

test('approvals and escalations: by hand, by default, by a delegate person or agent role (revocable), expired; two_key cards are left to the key row', async () => {
  const s = await setup();
  const mine = await card(s, { kind: 'hire', payload: JSON.stringify({ name: 'Researcher', title: 'Analyst' }), decidedAt: ago(1) });
  const byDefault = await card(s, { decidedVia: 'default', decidedBy: 'default', decisionNote: 'approved by default at your deadline', decidedAt: ago(2) });
  const deleg = (await s.db.insert(orgDelegations).values({ id: 'd1', orgId: s.orgId, kind: 'budget_raise', maxUsd: 20, delegateType: 'human', delegateRef: 'fin-1', createdAt: ago(50) }).returning())[0];
  const byFin = await card(s, { kind: 'budget_raise', payload: JSON.stringify({ scope: 'agent', refId: s.writer.id, monthlyUsd: 10 }), status: 'rejected', decidedBy: 'fin-1', decidedVia: 'delegate:human:fin-1', decisionNote: 'not now', decidedAt: ago(3) });
  await s.db.insert(orgDelegations).values({ id: 'd2', orgId: s.orgId, kind: 'tune', delegateType: 'role', delegateRef: 'controller', createdAt: ago(50), revokedAt: ago(1) });
  const byRole = await card(s, { decidedBy: `agent:${s.controllerAgent.id}`, decidedVia: 'delegate:role:controller', decidedAt: ago(4) });
  const expired = await card(s, { kind: 'external', payload: JSON.stringify({ description: 'email the list' }), status: 'expired', decidedBy: '', decidedAt: ago(5) });
  const esc = await card(s, { kind: 'escalation', payload: JSON.stringify({ taskId: 'task-9', title: 'Stuck task', reason: 'needs a decision' }), status: 'rejected', decidedAt: ago(6) });
  await card(s, { kind: 'two_key', payload: JSON.stringify({ actionId: 'nope', class: 'money' }), decidedAt: ago(1) });
  await card(s, { status: 'pending', decidedAt: null, decidedBy: '' });

  const items = await all(s);
  assert.equal(items.filter((i) => i.kind === 'approvals' || i.kind === 'escalations').length, 6, 'pending and two_key cards are not listed here');
  const a = byKey(items, `a:${mine.id}`)!;
  assert.equal(a.kind, 'approvals'); assert.equal(a.outcome, 'approved');
  assert.deepEqual(a.by, { kind: 'you', name: 'You', id: 'single' });
  assert.equal(a.withoutYou, false);
  assert.match(a.title, /^hire: Researcher as Analyst/);
  assert.deepEqual(a.link, { type: 'approval', id: mine.id });

  const d = byKey(items, `a:${byDefault.id}`)!;
  assert.equal(d.by.kind, 'default'); assert.equal(d.withoutYou, true); assert.equal(d.outcome, 'approved');
  assert.doesNotMatch(d.detail, /by default at your deadline/, 'the default note is the badge, not a note');

  const f = byKey(items, `a:${byFin.id}`)!;
  assert.deepEqual(f.by, { kind: 'delegate', name: 'Fin', id: 'fin-1' });
  assert.equal(f.outcome, 'rejected'); assert.equal(f.withoutYou, true);
  assert.match(f.detail, /Note: not now/);
  assert.deepEqual(f.undo, { kind: 'revoke_delegation', delegationId: deleg.id, label: 'Revoke budget raise delegation' });

  const r = byKey(items, `a:${byRole.id}`)!;
  assert.deepEqual(r.by, { kind: 'delegate', name: 'Penny (controller)', id: s.controllerAgent.id });
  assert.equal(r.undo, undefined, 'its delegation is already revoked');

  const e = byKey(items, `a:${expired.id}`)!;
  assert.equal(e.outcome, 'expired'); assert.equal(e.by.kind, 'system'); assert.equal(e.withoutYou, false);

  const x = byKey(items, `a:${esc.id}`)!;
  assert.equal(x.kind, 'escalations'); assert.equal(x.title, 'Escalation: Stuck task');
  assert.deepEqual(x.link, { type: 'task', id: 'task-9' });
  assert.match(x.detail, /needs a decision/);
});

test('keys: released, denied and refused on the owner\'s key; a two_key card decided by default or a delegate attributes the key; never-held and still-held actions are not history', async () => {
  const s = await setup();
  const released = await action(s, { keys: JSON.stringify({ why: 'irreversible', owner: { by: 'single', approve: true, note: '' } }), finishedAt: ago(1) });
  const denied = await action(s, { status: 'denied', stagedRef: 'draft-1', keys: JSON.stringify({ why: 'staged', owner: { by: 'single', approve: false, note: 'wrong list' } }), finishedAt: ago(2) });
  const refused = await action(s, { status: 'refused', note: 'rate limit: 5/hour', keys: JSON.stringify({ why: 'irreversible' }), finishedAt: ago(3) });
  const twoKey = await card(s, { kind: 'two_key', payload: JSON.stringify({ class: 'external_reversible' }), status: 'rejected', decidedVia: 'default', decidedBy: 'default', decidedAt: ago(4) });
  const viaCard = await action(s, { status: 'denied', keys: JSON.stringify({ why: 'reversible', approvalId: twoKey.id, owner: { by: 'single', approve: false } }), finishedAt: ago(4) });
  await action(s, { status: 'succeeded', keys: '{}' });
  await action(s, { status: 'held', finishedAt: null });

  const items = await all(s, { kind: 'keys' });
  assert.deepEqual(items.map((i) => i.key), [`k:${released.id}`, `k:${denied.id}`, `k:${refused.id}`, `k:${viaCard.id}`]);
  assert.equal(items[0].outcome, 'released'); assert.equal(items[0].by.kind, 'you');
  assert.equal(items[0].title, 'Run held gmail_send (Writer)');
  assert.deepEqual(items[0].link, { type: 'action', id: released.id, sessionId: 'sess-1' });
  assert.equal(items[1].outcome, 'denied'); assert.equal(items[1].title, 'Send staged gmail_send (Writer)');
  assert.match(items[1].detail, /Note: wrong list/);
  assert.equal(items[2].outcome, 'refused'); assert.equal(items[2].by.name, 'the rate limit');
  assert.match(items[2].detail, /rate limit: 5\/hour/);
  assert.equal(items[3].by.kind, 'default', 'the card\'s default, not the account the key ran as');
  assert.equal(items[3].withoutYou, true);
});

test('plans, incidents, my tasks and follows', async () => {
  const s = await setup();
  const byWindow = await plan(s, { appliedAt: ago(1) });
  const now = await plan(s, { decidedBy: 'user', appliedAt: ago(2) });
  const vetoed = await plan(s, { status: 'vetoed', appliedAt: null, applyAt: ago(-1), createdAt: ago(1), decidedBy: 'user', result: '[]' });
  await s.audit.append(s.orgId, { actor: 'user', action: 'plan_vetoed', refType: 'plan', refId: vetoed.id, payload: { actions: 2, note: 'too early' } });
  await plan(s, { status: 'pending', appliedAt: null });

  const contained = (await s.db.insert(orgIncidents).values({ id: id('i'), orgId: s.orgId, workspaceId: s.ws.id, kind: 'spend_spike', severity: 'major', status: 'contained', title: 'Spend spike', openedAt: ago(9), containedAt: ago(8) }).returning())[0];
  await s.audit.append(s.orgId, { actor: 'user', action: 'incident_contain', refType: 'incident', refId: contained.id, payload: {} });
  const resolved = (await s.db.insert(orgIncidents).values({ id: id('i'), orgId: s.orgId, workspaceId: s.ws.id, kind: 'provider_down', severity: 'minor', status: 'resolved', title: 'Provider down', openedAt: ago(9), resolvedAt: ago(7), resolution: 'recovered' }).returning())[0];
  await s.db.insert(orgIncidents).values({ id: id('i'), orgId: s.orgId, workspaceId: s.ws.id, kind: 'x', status: 'open', title: 'Still open', openedAt: ago(1) });

  const done = await task(s, { assigneeHumanId: 'single', updatedAt: ago(2.5) });
  await s.audit.append(s.orgId, { actor: 'user', action: 'task_update', refType: 'task', refId: done.id, payload: { status: 'done' } });
  const reviewed = await task(s, { title: 'Pricing page', reviewerHumanId: 'single', assigneeAgentId: s.writer.id, acceptedBy: 'check', updatedAt: ago(2.6) });
  await task(s, { assigneeHumanId: 'fin-1' });
  await task(s, { assigneeHumanId: 'single', status: 'in_progress' });

  const seen = await follow(s, { lastSeenAt: ago(6) });
  await follow(s, { lastSeenAt: null });
  await follow(s, { followerId: 'fin-1' });
  const seenTask = await follow(s, { targetKind: 'org_task', targetId: done.id, title: 'Write the launch post', lastSeenAt: ago(6.5) });

  const plans = await all(s, { kind: 'plans' });
  assert.equal(plans.length, 3);
  const w = byKey(plans, `p:${byWindow.id}`)!;
  assert.equal(w.outcome, 'applied'); assert.equal(w.by.kind, 'default'); assert.equal(w.withoutYou, true);
  assert.match(w.detail, /2 of 2 action\(s\) applied/);
  assert.equal(byKey(plans, `p:${now.id}`)!.by.kind, 'you');
  const v = byKey(plans, `p:${vetoed.id}`)!;
  assert.equal(v.outcome, 'vetoed'); assert.match(v.detail, /Note: too early/);
  assert.ok(Date.parse(v.at) > Date.parse(ago(0.1)), 'the veto time is the audit row\'s');
  assert.deepEqual(v.link, { type: 'plan', id: vetoed.id });

  const inc = await all(s, { kind: 'incidents' });
  assert.equal(inc.length, 2);
  assert.equal(byKey(inc, `i:${contained.id}`)!.outcome, 'contained');
  assert.equal(byKey(inc, `i:${contained.id}`)!.by.kind, 'you');
  assert.equal(byKey(inc, `i:${resolved.id}`)!.outcome, 'resolved');
  assert.equal(byKey(inc, `i:${resolved.id}`)!.by.kind, 'system');
  assert.match(byKey(inc, `i:${resolved.id}`)!.detail, /recovered/);

  const mine = await all(s, { kind: 'mytasks' });
  assert.deepEqual(mine.map((i) => i.key), [`t:${done.id}`, `t:${reviewed.id}`]);
  assert.equal(mine[0].outcome, 'done'); assert.equal(mine[0].by.kind, 'you');
  assert.deepEqual(mine[0].undo, { kind: 'reopen_task', taskId: done.id, label: 'Reopen' });
  assert.deepEqual(mine[0].link, { type: 'task', id: done.id });
  assert.equal(mine[1].title, 'Review: Pricing page'); assert.equal(mine[1].by.name, 'the checks');

  const fol = await all(s, { kind: 'following' });
  assert.deepEqual(fol.map((i) => i.key), [`f:thread:${seen.targetId}`, `f:org_task:${seenTask.targetId}`]);
  assert.equal(fol[0].outcome, 'seen'); assert.equal(fol[0].by.kind, 'you');
  assert.deepEqual(fol[0].link, { type: 'thread', id: seen.targetId, href: seen.link });
  assert.deepEqual(fol[1].link, { type: 'task', id: done.id });
  assert.equal(fol[0].detail, 'Ada: replied: ok');
});

test('filters: kind, search, the date window and decided-without-you; pagination walks everything once, newest first', async () => {
  const s = await setup();
  for (let i = 0; i < 7; i++) await card(s, { decidedAt: ago(i * 24 + 1), payload: JSON.stringify({ key: `k${i}`, value: i }), ...(i % 2 ? { decidedVia: 'default', decidedBy: 'default' } : {}) });
  await action(s, { keys: JSON.stringify({ why: 'x', owner: { by: 'single' } }), finishedAt: ago(30) });
  await follow(s, { title: 'Pricing thread', lastSeenAt: ago(50) });
  // two rows at the same instant: the key breaks the tie
  const same = ago(100);
  await card(s, { decidedAt: same }); await card(s, { decidedAt: same });

  const everything = await all(s);
  assert.equal(everything.length, 11);
  assert.deepEqual(everything.map((i) => i.at), everything.map((i) => i.at).slice().sort().reverse());
  assert.equal((await all(s, { kind: 'keys' })).length, 1);
  assert.equal((await all(s, { kind: 'all' })).length, 11);
  await assert.rejects(all(s, { kind: 'nope' }), /kind must be one of/);
  assert.deepEqual((await all(s, { q: 'PRICING' })).map((i) => i.kind), ['following']);
  assert.equal((await all(s, { q: 'k3' })).length, 1);
  assert.equal((await all(s, { from: ago(72) })).length, 5, 'three cards, the key, the follow');
  assert.equal((await all(s, { from: ago(72), to: ago(40) })).length, 2);
  await assert.rejects(all(s, { from: 'yesterday' }), /ISO date/);
  const without = await all(s, { without: '1' });
  assert.equal(without.length, 3);
  assert.ok(without.every((i) => i.withoutYou && i.by.kind === 'default'));

  const seen: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const r = await s.ctrl.list(s.ws.id, undefined, undefined, undefined, undefined, cursor, '3');
    assert.ok(r.items.length <= 3);
    seen.push(...r.items.map((i) => i.key));
    if (!r.nextCursor) break;
    cursor = r.nextCursor;
  }
  assert.deepEqual(seen, everything.map((i) => i.key), 'every row once, in order, ties included');
  await assert.rejects(s.ctrl.list(s.ws.id, undefined, undefined, undefined, undefined, 'bad'), /bad cursor/);
});

test('scoping: another workspace\'s and another account\'s records stay out; a member sees only their own tasks and follows, a viewer gets no undo, and a member is held to their workspace', async () => {
  const s = await setup();
  const other = await s.workspaces.create({ name: 'Side project' });
  await follow(s, { workspaceId: other.id, title: 'elsewhere' });
  await action(s, { workspaceId: other.id, keys: JSON.stringify({ why: 'x', owner: { by: 'single' } }) });
  await follow(s, { title: 'mine' });
  const finTask = await task(s, { assigneeHumanId: 'fin-1' });
  await task(s, { assigneeHumanId: 'single' });
  const deleg = (await s.db.insert(orgDelegations).values({ id: 'd9', orgId: s.orgId, kind: 'tune', delegateType: 'human', delegateRef: 'fin-1', createdAt: ago(50) }).returning())[0];
  await card(s, { decidedBy: 'fin-1', decidedVia: 'delegate:human:fin-1' });
  const ownerDecided = await card(s, { decidedBy: 'single' });

  const owner = await all(s);
  assert.deepEqual(owner.filter((i) => i.kind === 'following').map((i) => i.title), ['mine']);
  assert.equal(owner.filter((i) => i.kind === 'keys').length, 0, 'the other workspace\'s action is not here');
  assert.deepEqual(owner.find((i) => i.undo?.kind === 'revoke_delegation')?.undo, { kind: 'revoke_delegation', delegationId: deleg.id, label: 'Revoke tune delegation' });
  assert.deepEqual((await s.ctrl.list(other.id, undefined, undefined, undefined, undefined, undefined, '100')).items.map((i) => i.title), ['Run held gmail_send (Writer)', 'elsewhere']);

  const member: Viewer = { memberAccountId: 'fin-1', role: 'member', workspaceId: s.ws.id, displayName: 'Fin' };
  const asFin = await runWithViewer('single', member, () => all(s));
  assert.deepEqual(asFin.filter((i) => i.kind === 'mytasks').map((i) => i.key), [`t:${finTask.id}`], 'only my own tasks');
  assert.equal(asFin.filter((i) => i.kind === 'following').length, 0, 'not the owner\'s follows');
  assert.deepEqual(asFin.find((i) => i.key === `a:${ownerDecided.id}`)!.by, { kind: 'person', name: 'Single user', id: 'single' }, 'the owner by their account name');
  assert.equal(asFin.find((i) => i.by.kind === 'delegate')!.by.name, 'You');
  assert.ok(!asFin.some((i) => i.undo?.kind === 'revoke_delegation'), 'only the CEO revokes a delegation');
  assert.ok(asFin.some((i) => i.undo?.kind === 'reopen_task'), 'a member may reopen');
  const viewer: Viewer = { ...member, role: 'viewer' };
  assert.ok(!(await runWithViewer('single', viewer, () => all(s))).some((i) => i.undo), 'a viewer reads only');
  await assert.rejects(runWithViewer('single', member, () => s.ctrl.list(other.id)), /workspace/);

  await assert.rejects(runWithAccount('acct-2', () => s.ctrl.list(s.ws.id)), /workspace/);
});
