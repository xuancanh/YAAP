/** The owner's seat (docs/owners-seat.md, execution-plan item 31, C12):
 *  decision cards with a recommendation, alternatives, reversibility,
 *  confidence, a deadline and a default action the tick applies (never
 *  approve-by-default for irreversible or money); delegated approvals to a
 *  human or an agent role, with the never-delegable families refused; value
 *  events from measured key-result movement; the brief opening with
 *  Outcomes; the no_outcome signal and the chief's shrink note. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { orgApprovals, orgGoals } from '../server/src/database/schema';
import { setup, enable, sessionOf, inbox, type S } from './org-governance-harness';
import { defaultActionFor, reversibilityOf } from '../server/src/org/decision-cards';

const later = (h: number) => new Date(Date.now() + h * 3_600_000);

test('decision cards: an agent\'s proposal carries its recommendation, alternatives and confidence; reversibility, the deadline and the default action are computed — money and irreversible default to deny', async () => {
  const s = await setup();
  const orgId = await enable(s);
  const chief = await sessionOf(s, s.chief.id);
  await s.runtime.execute(chief, 'org_hire_agent', { templateOrPack: 'Helper', title: 'Helper', charter: 'You help.', monthlyBudgetUsd: 5, why: 'more hands', recommend: 'approve', alternatives: ['do nothing: the backlog grows', 'a cheaper part-timer'], confidence: 0.7 });
  await s.runtime.execute(chief, 'org_tune', { key: 'intent.paceTolerance', value: 0.2, why: 'noisy', recommend: 'approve', alternatives: ['keep 0.15'] });
  const pending = await s.approvals.pending(orgId);
  const hire = pending.find((a) => a.kind === 'hire')!;
  assert.equal(hire.recommendedAction, 'approve');
  assert.deepEqual(JSON.parse(hire.alternatives), ['do nothing: the backlog grows', 'a cheaper part-timer']);
  assert.equal(hire.confidence, 0.7);
  assert.equal(hire.reversibility, 'costly');
  assert.equal(hire.defaultAction, 'deny', 'a hire with money never defaults to approve');
  const hours = (Date.parse(hire.deadline!) - Date.parse(hire.createdAt)) / 3_600_000;
  assert.ok(Math.abs(hours - 48) < 0.1 && hire.deadline! < hire.expiresAt!, 'the deadline is before the expiry');
  const tune = pending.find((a) => a.kind === 'tune')!;
  assert.equal(tune.reversibility, 'reversible');
  assert.equal(tune.defaultAction, 'approve');
  assert.equal(tune.confidence, 0.5, 'the system default when none is stated');
  // a system-generated card gets computed fields on the tick
  const t = await s.tasks.create(orgId, { title: 'Stuck', brief: { outcome: 'x', done_when: 'y' }, assigneeAgentId: s.writer.id });
  await s.tasks.escalate(orgId, t.id, 'needs a decision', 'system');
  await s.seat.applyDefaults(orgId);
  const esc = (await s.approvals.pending(orgId)).find((a) => a.kind === 'escalation')!;
  assert.equal(esc.reversibility, 'reversible');
  assert.ok(JSON.parse(esc.alternatives).length >= 1 && esc.deadline);
  // pure: two_key by class, money
  assert.equal(reversibilityOf('two_key', { class: 'external_irreversible' }), 'irreversible');
  assert.equal(defaultActionFor(null, 'two_key', { class: 'external_reversible' }), 'deny', 'not a default-approvable kind');
  assert.equal(defaultActionFor(null, 'budget_raise', {}), 'deny');
});

test('default at the deadline: the tick approves a reversible card with an audit row and an inbox note; irreversible and money cards are denied even if their stored default says approve; the per-kind tunable turns default-approve off', async () => {
  const s = await setup();
  const orgId = await enable(s);
  const tune = await s.approvals.create(orgId, { kind: 'tune', payload: { key: 'intent.paceTolerance', value: 0.25, from: 0.15, why: 'noisy' }, requestedBy: 'chief' });
  const ext = await s.approvals.create(orgId, { kind: 'external', payload: { description: 'email the list' }, requestedBy: 'chief' });
  const money = await s.approvals.create(orgId, { kind: 'budget_raise', payload: { scope: 'agent', refId: s.writer.id, monthlyUsd: 9, current: 0 }, requestedBy: 'chief' });
  assert.equal(ext.defaultAction, 'deny');
  await s.db.update(orgApprovals).set({ defaultAction: 'approve' }).where(eq(orgApprovals.id, ext.id));
  await s.db.update(orgApprovals).set({ defaultAction: 'approve' }).where(eq(orgApprovals.id, money.id));
  assert.equal((await s.seat.applyDefaults(orgId, later(1))).length, 0, 'nothing before the deadline');
  const applied = await s.seat.applyDefaults(orgId, later(49));
  assert.equal(applied.find((x) => x.approvalId === tune.id)!.decision, 'approve');
  assert.equal(applied.find((x) => x.approvalId === ext.id)!.decision, 'reject', 'never default-approve irreversible');
  assert.equal(applied.find((x) => x.approvalId === money.id)!.decision, 'reject', 'never default-approve money');
  assert.match((await s.org.get(orgId)).tunables, /"intent\.paceTolerance":0\.25/);
  const a = await s.approvals.get(orgId, tune.id);
  assert.equal(a.decidedVia, 'default');
  assert.equal(a.decisionNote, 'approved by default at your deadline');
  assert.equal((await s.audit.list(orgId, { action: 'approval_default' })).length, 3);
  assert.ok((await inbox(s, s.chief.id, 'info')).some((e) => e.title.startsWith('Approved by default at your deadline: tune')));
  await s.org.setTunable(orgId, 'seat.defaultApprove.tune', 0, { actor: 'user' });
  const again = await s.approvals.create(orgId, { kind: 'tune', payload: { key: 'intent.paceTolerance', value: 0.3 }, requestedBy: 'chief' });
  assert.equal(again.defaultAction, 'deny');
});

test('delegation to a human: budget raises up to $20 go to a named member; a larger one stays the CEO\'s; the decision is audited and listed in the brief', async () => {
  const s = await setup();
  const orgId = await enable(s);
  await s.org.setHuman(orgId, { memberAccountId: 'fin-1', role: 'employee', title: 'Finance' });
  await s.controller.delegate(s.ws.id, { kind: 'budget_raise', maxUsd: 20, delegateType: 'human', delegateRef: 'fin-1' });
  const small = await s.approvals.create(orgId, { kind: 'budget_raise', payload: { scope: 'agent', refId: s.writer.id, monthlyUsd: 10, current: 0 }, requestedBy: 'chief' });
  const big = await s.approvals.create(orgId, { kind: 'budget_raise', payload: { scope: 'agent', refId: s.writer.id, monthlyUsd: 50, current: 0 }, requestedBy: 'chief' });
  assert.equal(await s.approvals.delegateVia(orgId, small, 'fin-1'), 'delegate:human:fin-1');
  assert.equal(await s.approvals.delegateVia(orgId, big, 'fin-1'), null, 'above maxUsd');
  await assert.rejects(s.seat.decideAsDelegate(orgId, big.id, 'approve', '', 'fin-1', 'human:fin-1'), /no delegation lets you decide/);
  const r = await s.seat.decideAsDelegate(orgId, small.id, 'approve', 'fine', 'fin-1', 'human:fin-1');
  assert.equal(r.approval.status, 'approved');
  assert.equal(r.approval.decidedVia, 'delegate:human:fin-1');
  assert.equal((await s.org.budget(orgId, 'agent', s.writer.id))!.monthlyUsd, 10);
  assert.equal((await s.audit.list(orgId, { action: 'delegated_decision' })).length, 1);
  const b = await s.brief.compose(orgId, { deliver: false });
  assert.match(b.text, /## Decided for you\n- approved by human fin-1: \[budget_raise\]/);
});

test('delegation to an agent role: a controller decides delegated cards on creation (a judgment on another family); "ask" leaves the card to the CEO; the proposer never decides its own card', async () => {
  const s = await setup();
  const orgId = await enable(s);
  const controller = await s.agents.create({ name: 'Ctrl', charter: 'You control spend.', provider: 'openai', model: 'gpt-5' });
  await s.org.addMember(orgId, { agentId: controller.id, title: 'Controller', reportsToAgentId: s.chief.id });
  await s.seat.delegate(orgId, { kind: 'tune', delegateType: 'role', delegateRef: 'controller' }, 'user');
  const seen: string[] = [];
  s.seat.delegateFn = async ({ payload, delegateAgentId }) => { seen.push(delegateAgentId); return Number(payload.value) > 0.3 ? { verdict: 'ask', reason: 'big change' } : { verdict: 'approve', reason: 'within reason' }; };
  const chief = await sessionOf(s, s.chief.id);
  const out = await s.runtime.execute(chief, 'org_tune', { key: 'intent.paceTolerance', value: 0.2, why: 'noisy' });
  assert.match(out, /Tuning proposed/);
  const decided = (await s.approvals.list(orgId)).find((a) => a.kind === 'tune')!;
  assert.equal(decided.status, 'approved');
  assert.equal(decided.decidedVia, 'delegate:role:controller');
  assert.equal(decided.decidedBy, `agent:${controller.id}`);
  assert.deepEqual(seen, [controller.id]);
  await s.runtime.execute(chief, 'org_tune', { key: 'intent.paceTolerance', value: 0.4, why: 'very noisy' });
  assert.equal((await s.approvals.pending(orgId)).filter((a) => a.kind === 'tune').length, 1, 'ask → the CEO');
  assert.ok((await s.audit.list(orgId, { action: 'delegated_review' })).length >= 2);
  // the controller's own card is not decided by itself
  await s.approvals.create(orgId, { kind: 'tune', payload: { key: 'intent.paceTolerance', value: 0.1 }, requestedBy: `agent:${controller.id}` });
  assert.equal(seen.length, 2);
});

test('never delegable: the constitution, caps, the kill switch, the external floor and trust ceilings are refused; a tune card on the external floor is not covered by a tune delegation; only the owner delegates', async () => {
  const s = await setup();
  const orgId = await enable(s);
  for (const k of ['constitution', 'caps', 'kill_switch', 'external_floor', 'trust_ceiling']) {
    await assert.rejects(s.seat.delegate(orgId, { kind: k, delegateType: 'role', delegateRef: 'controller' }, 'user'), /never delegable/, k);
  }
  await assert.rejects(s.seat.delegate(orgId, { kind: 'tune', delegateType: 'role', delegateRef: 'controller' }, 'chief'), /never an agent's/);
  await s.org.setHuman(orgId, { memberAccountId: 'ops-1', role: 'employee' });
  await s.seat.delegate(orgId, { kind: 'tune', delegateType: 'human', delegateRef: 'ops-1' }, 'user');
  const floor = await s.approvals.create(orgId, { kind: 'tune', payload: { key: 'actions.externalPerHour', value: 100, boundary: 'propose' }, requestedBy: 'chief' });
  assert.equal(await s.approvals.delegateVia(orgId, floor, 'ops-1'), null);
  const ok = await s.approvals.create(orgId, { kind: 'tune', payload: { key: 'intent.paceTolerance', value: 0.2 }, requestedBy: 'chief' });
  assert.equal(await s.approvals.delegateVia(orgId, ok, 'ops-1'), 'delegate:human:ops-1');
  const d = (await s.seat.delegations(orgId))[0];
  await s.controller.revoke(s.ws.id, d.id);
  assert.equal(await s.approvals.delegateVia(orgId, ok, 'ops-1'), null, 'revoked');
});

async function measuredKr(s: S, orgId: string, opts: { valuePerUnit?: number; created?: string } = {}) {
  const objective = await s.org.addGoal(orgId, { title: 'Grow the list', kind: 'objective' });
  const kr = await s.intent.setKeyResult(orgId, { title: 'Subscribers', objectiveId: objective.id, metric: 'subscribers', targetValue: 2000, startValue: 100, dueAt: new Date(Date.now() + 90 * 86_400_000).toISOString(), ownerAgentId: s.writer.id });
  const { source } = await s.sensing.create(orgId, { name: 'List size', kind: 'manual_attested', unit: 'subscribers' }, 'user');
  await s.intent.bindSource(orgId, kr.id, source.id, 'user');
  if (opts.created) {
    await s.db.update(orgGoals).set({ createdAt: opts.created }).where(eq(orgGoals.id, kr.id));
    await s.db.update(orgGoals).set({ createdAt: opts.created }).where(eq(orgGoals.id, objective.id));
  }
  if (opts.valuePerUnit !== undefined) await s.seat.setGoalValue(orgId, kr.id, { valuePerUnit: opts.valuePerUnit, valueNote: 'each new subscriber is worth $0.50' }, 'user');
  return { objective, kr, source };
}

test('value accounting: measured movement of a valued key result becomes value events (idempotent); only the owner sets what an outcome is worth', async () => {
  const s = await setup();
  const orgId = await enable(s);
  const { kr, source, objective } = await measuredKr(s, orgId, { valuePerUnit: 0.5 });
  await s.sensing.attest(orgId, source.id, { value: 100, note: 'list export' }, 'user');
  await new Promise((r) => setTimeout(r, 5));
  await s.sensing.attest(orgId, source.id, { value: 140, note: 'list export' }, 'user');
  await s.seat.syncValue(orgId);
  await s.seat.syncValue(orgId);
  const ev = await s.seat.valueEvents(orgId);
  const movement = ev.filter((e) => e.kind === 'movement');
  assert.equal(movement.reduce((a, e) => a + e.valueUsd, 0), 20, '40 subscribers × $0.50');
  assert.ok(movement.every((e) => e.goalId === kr.id && e.objectiveId === objective.id));
  assert.equal(movement.length, 2, 'one per sample after the start value, once');
  await assert.rejects(s.seat.setGoalValue(orgId, kr.id, { valuePerUnit: 5 }, 'chief'), /owner's to say/);
  const out = await s.seat.outcomes(orgId);
  assert.equal(out[0].valueUsd, 20);
  assert.equal(out[0].keyResults[0].movement7d, 40);
});

test('the brief opens with Outcomes (measured movement, value vs spend), then exceptions, then decisions; activity counts come last', async () => {
  const s = await setup();
  const orgId = await enable(s);
  const { source } = await measuredKr(s, orgId, { valuePerUnit: 0.5 });
  await s.sensing.attest(orgId, source.id, { value: 160, note: 'export' }, 'user');
  await s.approvals.create(orgId, { kind: 'tune', payload: { key: 'intent.paceTolerance', value: 0.2 }, requestedBy: 'chief', recommendation: 'noisy metric' });
  const b = await s.brief.compose(orgId, { deliver: false });
  const i = (h: string) => b.text.indexOf(h);
  assert.ok(i('## Outcomes') > 0);
  assert.ok(i('## Outcomes') < i('## Anomalies') && i('## Anomalies') < i('## Decisions needed') && i('## Decisions needed') < i('# Activity') && i('# Activity') < i('## Spend'), b.text);
  assert.match(b.text, /- Grow the list: Subscribers \+60 this week \(now 160 of 2000\) — value realised \$30\.00 vs spend \$0\.00 this month/);
  assert.match(b.text, /1\. \[tune\] .*approve, reversible, confidence 50%; if unanswered by .* UTC: approve/);
});

test('outcome or shrink: a unit whose objectives moved no measured key result for N weeks gets a no_outcome signal and the chief\'s planning prompt is told to shrink it through an experiment or a proposal; movement resolves it', async () => {
  const s = await setup();
  const orgId = await enable(s);
  const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
  const { source, objective } = await measuredKr(s, orgId, { created: old });
  const root = await s.units.rootUnit(orgId);
  await s.db.update(orgGoals).set({ unitId: root.id }).where(eq(orgGoals.id, objective.id));
  await s.sensing.attest(orgId, source.id, { value: 100, note: 'flat', observedAt: new Date(Date.now() - 20 * 86_400_000).toISOString() }, 'user');
  await s.sensing.attest(orgId, source.id, { value: 100, note: 'flat' }, 'user');
  const r = await s.seat.sweepNoOutcome(orgId);
  assert.deepEqual(r.opened, [root.id]);
  const sig = (await s.signals.list(orgId, { kind: 'no_outcome' }))[0];
  assert.equal(sig.addresseeKind, 'chief');
  assert.match(sig.detail, /not an automatic cut/);
  const notes = await s.seat.shrinkNotes(orgId);
  assert.match(notes.join('\n'), /Outcome or shrink[\s\S]*as an experiment or a proposal/);
  assert.equal((await s.org.budgets(orgId)).find((b) => b.scope === 'company')!.monthlyUsd, 50, 'nothing was cut');
  await s.sensing.attest(orgId, source.id, { value: 130, note: 'grew' }, 'user');
  const r2 = await s.seat.sweepNoOutcome(orgId);
  assert.equal(r2.resolved, 1);
});
