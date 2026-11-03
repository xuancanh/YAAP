/** Decisions go to the direct manager first (docs/owners-seat.md §7): the
 *  route per role (specialist → head → chief → CEO, or a person), the
 *  authority table, decide / send back / escalate with a recommendation,
 *  CEO-reserved pass-through, the hop timeout, no self-approval, the
 *  same-model independent review, the audit of every hop, the manager's
 *  heartbeat, and the CEO's Home showing the chain. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { agentEvents, orgApprovals } from '../server/src/database/schema';
import { authorityFor, chainLine, managerOf, reservedOf, routeDecision, AUTHORITY_TABLE, type AuthorityInput, type DecisionHop } from '../server/src/org/decision-routing';
import { HomeService } from '../server/src/home/home.service';
import { setup, enable, sessionOf, inbox } from './org-governance-harness';

const H = 3_600_000;

/** Chief → Writer (Head of Sales) → Editor (specialist). */
async function company(modeName: 'supervised' | 'autonomous' = 'autonomous') {
  const s = await setup();
  const orgId = await enable(s, modeName);
  await s.org.updateMember(orgId, s.writer.id, { title: 'Head of Sales' });
  await s.org.updateMember(orgId, s.editor.id, { reportsToAgentId: s.writer.id, title: 'SDR' });
  await s.units.syncMembership(orgId);
  return { s, orgId };
}
const card = async (s: Awaited<ReturnType<typeof setup>>, id: string) => (await s.db.select().from(orgApprovals).where(eq(orgApprovals.id, id)))[0];
const hops = (a: { chain: string }) => JSON.parse(a.chain) as DecisionHop[];

test('the route per role: a specialist goes to its head, a head to the chief, the chief to the CEO, a member with a person to that person (pure)', () => {
  const org = { chiefOfStaffAgentId: 'c' };
  const members = [
    { agentId: 'c', reportsToAgentId: null, status: 'active' },
    { agentId: 'h', reportsToAgentId: 'c', status: 'active' },
    { agentId: 's', reportsToAgentId: 'h', status: 'active' },
    { agentId: 'p', reportsToAgentId: 'h', status: 'active', reportsToHumanId: 'acct-anna' },
    { agentId: 'q', reportsToAgentId: 'x', status: 'active' },
    { agentId: 'x', reportsToAgentId: 'c', status: 'paused' },
  ];
  const humans = [{ memberAccountId: 'acct-anna', role: 'employee' }, { memberAccountId: 'acct-obs', role: 'observer' }];
  assert.equal(managerOf('s', members, humans, org), 'agent:h');
  assert.equal(managerOf('h', members, humans, org), 'agent:c');
  assert.equal(managerOf('c', members, humans, org), 'ceo');
  assert.equal(managerOf('p', members, humans, org), 'human:acct-anna');
  assert.equal(managerOf('q', members, humans, org), 'agent:c', 'a paused manager is skipped');
  assert.equal(managerOf('p', members.map((m) => (m.agentId === 'p' ? { ...m, reportsToHumanId: 'acct-obs' } : m)), humans, org), 'agent:h', 'an observer is no manager');
  const r = routeDecision({ org, members, humans, employees: [{ memberAccountId: 'acct-anna', reportsToAgentId: 'h' }], fromAgentId: 'p', kind: 'two_key' });
  assert.deepEqual(r.chain, ['human:acct-anna', 'agent:h', 'agent:c', 'ceo']);
  assert.match(r.reserved, /owner's key/);
  assert.deepEqual(routeDecision({ org, members, humans, fromAgentId: 's', kind: 'escalation' }).chain, ['agent:h', 'agent:c', 'ceo']);
  assert.equal(chainLine([{ at: '', action: 'raised', by: 'agent:s', from: '', to: 'agent:h' }, { at: '', action: 'escalated', by: 'agent:h', from: 'agent:h', to: 'agent:c' }, { at: '', action: 'escalated', by: 'agent:c', from: 'agent:c', to: 'ceo' }], (x) => ({ 'agent:s': 'Writer', 'agent:h': 'Head of Content', 'agent:c': 'Chief' })[x] ?? x), 'Writer → Head of Content → Chief → you');
});

test('the authority table: what a manager may decide alone (pure)', () => {
  const base: AuthorityInput = { kind: 'escalation', payload: {}, reserved: '', selfRequest: false, autonomous: true, trust: 2, inLine: true, unitHeadroomUsd: 10, delegated: false };
  assert.equal(authorityFor(base).decide, true, 'an escalation in its line');
  assert.equal(authorityFor({ ...base, autonomous: false }).decide, true, 'escalations in any mode');
  assert.match(authorityFor({ ...base, selfRequest: true }).reason, /own request/);
  assert.match(authorityFor({ ...base, inLine: false }).reason, /outside your reporting line/);
  assert.match(authorityFor({ ...base, trust: 1 }).reason, /trust/);
  const hire: AuthorityInput = { ...base, kind: 'hire', payload: { monthlyBudgetUsd: 4 } };
  assert.equal(authorityFor(hire).decide, true, 'a hire in its line within its unit headroom');
  assert.match(authorityFor({ ...hire, payload: { monthlyBudgetUsd: 40 } }).reason, /beyond your unit's headroom/);
  assert.match(authorityFor({ ...hire, unitHeadroomUsd: null }).reason, /no unit budget/);
  assert.match(authorityFor({ ...hire, autonomous: false }).reason, /supervised/);
  assert.equal(authorityFor({ ...hire, autonomous: false, human: true, payload: {} }).decide, true, 'a person manager is not bound by the mode');
  assert.match(authorityFor({ ...base, kind: 'scope_widen', withinHoldings: false }).reason, /do not hold yourself/);
  assert.match(authorityFor({ ...base, kind: 'terminate', leadsNobody: false }).reason, /leads others/);
  for (const k of ['two_key', 'strategy', 'external', 'metric_source']) {
    assert.match(authorityFor({ ...base, kind: k, reserved: reservedOf(k, {}) }).reason, /CEO-reserved/, k);
  }
  assert.match(reservedOf('budget_raise', { scope: 'company' }), /beyond the company envelope/);
  assert.equal(reservedOf('budget_raise', { scope: 'agent' }), '');
  assert.match(reservedOf('hire', { boundary: 'propose', boundaryRule: 'member_folder' }), /boundary/);
  assert.match(reservedOf('escalation', { to: 'ceo' }), /only the CEO/);
  assert.equal(authorityFor({ ...base, kind: 'tune' }).decide, false);
  assert.equal(authorityFor({ ...base, kind: 'hire', delegated: true, trust: 0 }).decide, true, 'a delegation to the role');
  assert.ok(AUTHORITY_TABLE.some((r) => r.kind === 'hire' && r.manager === 'decide_if'));
});

test('a specialist\'s escalation goes to its head, who decides it within its authority: the task moves, the hops are audited, the CEO never saw it', async () => {
  const { s, orgId } = await company('autonomous');
  const t = await s.tasks.create(orgId, { title: 'Quote for Acme', createdBy: 'user', assigneeAgentId: s.editor.id });
  await s.tasks.escalate(orgId, t.id, 'Acme wants net-60 terms', `agent:${s.editor.id}`);
  const [a] = await s.decisions.heldBy(orgId, `agent:${s.writer.id}`);
  assert.ok(a, 'the head holds it');
  assert.equal(a.kind, 'escalation');
  assert.ok(a.hopDeadline && Date.parse(a.hopDeadline) - Date.now() > 11 * H, 'a 12 h window by default');
  assert.match(JSON.parse((await s.tasks.get(orgId, t.id)).blockers).at(-1), /^escalated to Writer: /, 'the task names who it waits on');
  assert.equal((await s.approvals.pendingForOwner(orgId)).length, 0, 'nothing waits on the CEO');
  assert.ok((await inbox(s, s.writer.id, 'decision')).some((e) => /Decision for you \(escalation\)/.test(e.title)), 'the head is told');
  // its heartbeat surfaces it with its authority
  const reasons = await s.decisions.heartbeatReasons(s.writer.id);
  assert.match(reasons.join('\n'), /decision for you \[[0-9a-f]{8}\]: escalation/);
  assert.match((await s.decisions.heartbeatContext(s.writer.id))!, /You may decide it/);
  // the head decides through its tool
  const head = await sessionOf(s, s.writer.id);
  assert.match(await s.runtime.execute(head, 'org_decision_queue', {}), /you may decide it/);
  assert.match(await s.runtime.execute(head, 'org_decide', { approvalId: a.id.slice(0, 8), action: 'approve', reasoning: 'net-60 is fine for Acme' }), /Approved/);
  const after = await card(s, a.id);
  assert.equal(after.status, 'approved');
  assert.equal(after.decidedVia, `manager:agent:${s.writer.id}`);
  assert.equal((await s.tasks.get(orgId, t.id)).status, 'todo', 'the task moves again');
  assert.deepEqual(hops(after).map((h) => h.action), ['raised', 'decided']);
  const audited = await s.audit.list(orgId, { action: 'decision_hop' });
  assert.ok(audited.length >= 2, 'every hop is in the audit chain');
});

test('send back: the manager returns a card to the requester with guidance; a non-holder cannot act', async () => {
  const { s, orgId } = await company('autonomous');
  const a = await s.approvals.create(orgId, { kind: 'member_settings', payload: { agentId: s.editor.id, agentName: 'Editor', summary: 'heartbeat every 5 min', patch: {} }, requestedBy: `agent:${s.editor.id}`, recommendation: 'I want to check the inbox more often' });
  assert.equal(a.holder, `agent:${s.writer.id}`);
  await assert.rejects(s.decisions.act(orgId, a.id, `agent:${s.chief.id}`, 'approve'), /not yours to act on/);
  await assert.rejects(s.decisions.act(orgId, a.id, `agent:${s.writer.id}`, 'send_back', {}), /needs guidance/);
  assert.match(await s.decisions.act(orgId, a.id, `agent:${s.writer.id}`, 'send_back', { reasoning: 'every 30 min is enough; batch the inbox' }), /Sent back/);
  const after = await card(s, a.id);
  assert.equal(after.status, 'revision_requested');
  assert.equal(hops(after).at(-1)!.action, 'sent_back');
  assert.ok((await inbox(s, s.editor.id)).some((e) => /Sent back by Writer: every 30 min/.test(e.title)), 'the requester gets the guidance');
});

test('escalate with a recommendation: it climbs to the chief, then the CEO with every recommendation, a fresh deadline and the chief\'s inbox line; the CEO sees the chain on Home', async () => {
  const { s, orgId } = await company('supervised');
  const t = await s.tasks.create(orgId, { title: 'Price change', createdBy: 'user', assigneeAgentId: s.editor.id });
  await s.tasks.escalate(orgId, t.id, 'raise the list price 10%?', `agent:${s.editor.id}`);
  const [a] = await s.decisions.heldBy(orgId, `agent:${s.writer.id}`);
  assert.match(await s.decisions.act(orgId, a.id, `agent:${s.writer.id}`, 'escalate', { recommendation: 'approve', reasoning: 'margins are thin; competitors moved' }), /Escalated to Chief/);
  let now = await card(s, a.id);
  assert.equal(now.holder, `agent:${s.chief.id}`);
  assert.match(JSON.parse((await s.tasks.get(orgId, t.id)).blockers).at(-1), /^escalated to Chief: /);
  assert.match(await s.decisions.act(orgId, a.id, `agent:${s.chief.id}`, 'escalate', { recommendation: 'modify', reasoning: '5% now, 5% next quarter' }), /Escalated to the CEO/);
  now = await card(s, a.id);
  assert.equal(now.holder, 'ceo');
  assert.ok(now.deadline && Date.parse(now.deadline) - Date.now() > 47 * H, 'a fresh deadline at the CEO');
  assert.deepEqual(hops(now).map((h) => [h.action, h.recommendation ?? '']), [['raised', ''], ['escalated', 'approve'], ['escalated', 'modify']]);
  assert.ok((await inbox(s, s.chief.id, 'info')).some((e) => /Approval needed \(escalation\)/.test(e.title)), 'arrival notifies the owner through the chief\'s channel line');
  assert.equal((await s.approvals.pendingForOwner(orgId)).length, 1);
  // Home: the chain with each recommendation
  const home = new HomeService(s.db, s.workspaces, s.agents, s.config, undefined, undefined, undefined, undefined, s.org, s.tasks, s.approvals, s.audit, s.brief);
  const data = await home.home(s.ws.id);
  const need = data.needs.find((n) => n.ref.approvalId === a.id)!;
  assert.equal(need.chain?.line, 'Editor → Writer → Chief → you');
  assert.deepEqual(need.chain?.hops.map((h) => [h.by, h.recommendation]), [['Writer', 'approve'], ['Chief', 'modify']]);
  // the CEO decides; the final hop is recorded
  await s.approvals.decide(orgId, a.id, 'approve', 'go with 5%');
  assert.equal(hops(await card(s, a.id)).at(-1)!.action, 'decided');
});

test('CEO-reserved cards pass through every manager for a recommendation but no manager may decide them', async () => {
  const { s, orgId } = await company('autonomous');
  const a = await s.approvals.create(orgId, { kind: 'budget_raise', payload: { scope: 'company', refId: orgId, monthlyUsd: 500, current: 50 }, requestedBy: `agent:${s.editor.id}`, recommendation: 'we need more envelope' });
  assert.equal(a.holder, `agent:${s.writer.id}`);
  assert.match(a.reserved, /beyond the company envelope/);
  await assert.rejects(s.decisions.act(orgId, a.id, `agent:${s.writer.id}`, 'approve'), /CEO-reserved/);
  await s.decisions.act(orgId, a.id, `agent:${s.writer.id}`, 'escalate', { recommendation: 'deny', reasoning: 'not yet' });
  await assert.rejects(s.decisions.act(orgId, a.id, `agent:${s.chief.id}`, 'reject'), /CEO-reserved/);
  await s.decisions.act(orgId, a.id, `agent:${s.chief.id}`, 'escalate', { recommendation: 'deny' });
  assert.equal((await card(s, a.id)).holder, 'ceo');
  // a held outward action cannot be sent back by a manager: the owner's key decides
  const k = await s.approvals.create(orgId, { kind: 'two_key', payload: { actionId: 'x', tool: 'gmail_send', class: 'external_irreversible', summary: 'mail Acme' }, requestedBy: `agent:${s.editor.id}` });
  assert.equal(k.urgency, 'urgent');
  await assert.rejects(s.decisions.act(orgId, k.id, `agent:${s.writer.id}`, 'send_back', { reasoning: 'no' }), /owner's key/);
});

test('a hop that waits too long climbs on its own with "no recommendation (timed out)"; urgent cards climb sooner; nothing stalls', async () => {
  const { s, orgId } = await company('autonomous');
  const a = await s.approvals.create(orgId, { kind: 'reorg', payload: { changes: [] }, requestedBy: `agent:${s.editor.id}` });
  assert.equal(await s.decisions.timeouts(orgId, new Date(Date.now() + 1 * H)), 0, 'still inside the window');
  assert.equal(await s.decisions.timeouts(orgId, new Date(Date.now() + 13 * H)), 1);
  let now = await card(s, a.id);
  assert.equal(now.holder, `agent:${s.chief.id}`);
  const last = hops(now).at(-1)!;
  assert.equal(last.action, 'timed_out');
  assert.equal(last.reasoning, 'no recommendation (timed out)');
  await s.decisions.timeouts(orgId, new Date(Date.now() + 26 * H));
  now = await card(s, a.id);
  assert.equal(now.holder, 'ceo', 'it reaches the CEO');
  // urgent: two hours per level by default
  const u = await s.approvals.create(orgId, { kind: 'reorg', payload: { changes: [] }, requestedBy: `agent:${s.editor.id}`, urgency: 'urgent' });
  assert.equal(await s.decisions.timeouts(orgId, new Date(Date.now() + 3 * H)), 1);
  assert.equal((await card(s, u.id)).holder, `agent:${s.chief.id}`);
  // a card at a manager does not expire nor take its default before reaching the CEO
  const expired = await s.approvals.expireStale(orgId, new Date(Date.now() + 100 * H));
  assert.equal((await card(s, u.id)).status, 'pending', `held cards do not expire (${expired} expired at the CEO)`);
});

test('no self-approval, and a manager on the requester\'s model family needs an independent yes for money', async () => {
  const { s, orgId } = await company('autonomous');
  // the head (anthropic sonnet) asks for its own envelope; the chief runs on the same family
  const a = await s.approvals.create(orgId, { kind: 'budget_raise', payload: { scope: 'agent', refId: s.writer.id, monthlyUsd: 5, current: 0 }, requestedBy: `agent:${s.writer.id}` });
  assert.equal(a.holder, `agent:${s.chief.id}`);
  await assert.rejects(s.decisions.act(orgId, a.id, `agent:${s.writer.id}`, 'approve'), /not yours/, 'the requester never holds its own card');
  s.decisions.independentFn = async () => ({ verdict: 'deny', reason: 'no plan for the spend' });
  assert.match(await s.decisions.act(orgId, a.id, `agent:${s.chief.id}`, 'approve', { reasoning: 'fine' }), /independent review/);
  let now = await card(s, a.id);
  assert.equal(now.holder, 'ceo', 'not confirmed: it goes up with the recommendation');
  assert.equal(hops(now).at(-1)!.recommendation, 'approve');
  // confirmed: approved and flagged
  const b = await s.approvals.create(orgId, { kind: 'budget_raise', payload: { scope: 'agent', refId: s.writer.id, monthlyUsd: 4, current: 0 }, requestedBy: `agent:${s.writer.id}` });
  s.decisions.independentFn = async () => ({ verdict: 'allow', reason: 'within plan' });
  assert.match(await s.decisions.act(orgId, b.id, `agent:${s.chief.id}`, 'approve', { reasoning: 'fine' }), /flagged/);
  now = await card(s, b.id);
  assert.equal(now.status, 'approved');
  assert.equal(hops(now).at(-1)!.sameModel, true);
  assert.equal((await s.audit.list(orgId, { action: 'decision_independent_review' })).length, 2);
  // pure: the chain never hands a card to the member who raised it
  assert.match(authorityFor({ kind: 'escalation', payload: {}, reserved: '', selfRequest: true, autonomous: true, trust: 3, inLine: true, unitHeadroomUsd: 100, delegated: true }).reason, /own request/);
});

test('a person can be the manager: the card goes to their Inbox and they escalate it to the member they report to', async () => {
  const { s, orgId } = await company('supervised');
  await s.org.setHuman(orgId, { memberAccountId: 'acct-anna', role: 'employee', reportsToAgentId: s.chief.id, title: 'Sales lead' });
  await s.org.updateMember(orgId, s.editor.id, { reportsToHumanId: 'acct-anna' });
  const r = await s.decisions.routeDecision(orgId, s.editor.id, 'escalation');
  assert.equal(r.holder, 'human:acct-anna');
  assert.deepEqual(r.chain.map((x) => x.holder), ['human:acct-anna', `agent:${s.chief.id}`, 'ceo']);
  const a = await s.approvals.create(orgId, { kind: 'reorg', payload: { changes: [] }, requestedBy: `agent:${s.editor.id}` });
  assert.equal(a.holder, 'human:acct-anna');
  const ev = (await s.db.select().from(agentEvents).where(eq(agentEvents.agentId, s.chief.id))).find((e) => e.kind === 'decision');
  assert.equal(ev?.forMemberAccountId, 'acct-anna', 'addressed to the person alone');
  assert.ok(!(await s.agents.listEvents(s.chief.id, 50)).some((e) => e.kind === 'decision'), 'the owner does not see it');
  assert.equal((await s.decisions.describeFor(orgId, 'human:acct-anna')).length, 1);
  await s.decisions.act(orgId, a.id, 'human:acct-anna', 'escalate', { recommendation: 'approve', reasoning: 'ok by me' });
  assert.equal((await card(s, a.id)).holder, `agent:${s.chief.id}`);
  await assert.rejects(s.org.updateMember(orgId, s.editor.id, { reportsToHumanId: 'nobody' }), /standing/);
});
