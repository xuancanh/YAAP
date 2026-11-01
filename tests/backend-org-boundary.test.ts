/** The self-modification boundary as data (docs/boundary.md, execution-plan
 *  item 31, C8): one table maps every self-change to alone | experiment |
 *  propose | never with its reason; every existing self-change path
 *  consults it (one test per path family); `never` by an agent is a critical
 *  finding and a minor boundary_violation incident; `propose` is a card for
 *  the CEO even in autonomous mode; `experiment` routes to an experiments
 *  service when one is bound; the CEO is bound only by the audit chain. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BOUNDARY, BOUNDARY_VERDICTS, checkBoundary, ruleFor, type ChangeKind } from '../server/src/org/boundary';
import { setup, enable, sessionOf } from './org-governance-harness';

const KINDS: ChangeKind[] = ['tunable', 'cadence', 'routing', 'playbook', 'charter', 'role', 'hire', 'reorg', 'terminate', 'scope_widen', 'scope_narrow', 'budget', 'constitution', 'caps', 'external_floor', 'trust_ceiling', 'audit_settings', 'audit_chain', 'kill_switch', 'frozen_classes', 'delegation', 'eval_cases', 'member_identity', 'member_model', 'member_heartbeat', 'member_folder'];

test('the table covers every family with a verdict and a reason; tunables classify by key prefix; GET …/org/boundary returns it', async () => {
  for (const k of KINDS) {
    const r = ruleFor({ kind: k });
    assert.ok(BOUNDARY_VERDICTS.includes(r.verdict), k);
    assert.ok(r.reason.length > 10, `${k} has a reason`);
  }
  for (const v of BOUNDARY_VERDICTS) assert.ok(BOUNDARY.some((r) => r.verdict === v), `some row is ${v}`);
  assert.equal(ruleFor({ kind: 'tunable', key: 'intent.paceTolerance' }).verdict, 'alone');
  assert.equal(ruleFor({ kind: 'tunable', key: 'audit.ownerSpotChecks' }).verdict, 'never');
  assert.equal(ruleFor({ kind: 'tunable', key: 'actions.externalPerHour' }).verdict, 'propose');
  assert.equal(ruleFor({ kind: 'tunable', key: 'trust.promoteAfterClean' }).verdict, 'propose');
  assert.equal(ruleFor({ kind: 'reorg', withinUnit: true }).verdict, 'alone');
  assert.equal(ruleFor({ kind: 'reorg', withinUnit: false }).verdict, 'experiment');
  assert.equal(ruleFor({ kind: 'budget', withinEnvelope: false }).verdict, 'propose');
  assert.equal(ruleFor({ kind: 'charter' }).verdict, 'experiment');
  assert.equal(ruleFor({ kind: 'kill_switch' }).verdict, 'never');
  // pure decisions
  assert.equal(checkBoundary({ kind: 'tunable', key: 'audit.x' }, 'chief').outcome, 'refuse');
  assert.equal(checkBoundary({ kind: 'tunable', key: 'audit.x' }, 'user').outcome, 'proceed', 'the CEO is not bound');
  assert.equal(checkBoundary({ kind: 'audit_chain' }, 'user').outcome, 'refuse', 'the audit chain binds everyone');
  assert.equal(checkBoundary({ kind: 'charter' }, 'agent:a', { experiments: true }).outcome, 'experiment');
  assert.equal(checkBoundary({ kind: 'charter' }, 'agent:a').outcome, 'card');
  const s = await setup();
  await enable(s);
  const out = await s.controller.table(s.ws.id);
  assert.equal(out.rules.length, BOUNDARY.length);
  assert.ok(out.rules.every((r) => r.verdict && r.reason && r.match));
});

test('tunables: org_tune consults the boundary — alone applies in autonomous mode, propose becomes a card for the CEO even in autonomous mode; the CEO sets the same key directly', async () => {
  const s = await setup();
  const orgId = await enable(s, 'autonomous');
  const chief = await sessionOf(s, s.chief.id);
  const ok = await s.runtime.execute(chief, 'org_tune', { key: 'intent.paceTolerance', value: 0.2, why: 'noisy metric' });
  assert.match(ok, /intent\.paceTolerance set to 0\.2/);
  assert.ok(s.checks.some((c) => c.change.kind === 'tunable' && c.change.key === 'intent.paceTolerance' && c.outcome === 'proceed'));
  const card = await s.runtime.execute(chief, 'org_tune', { key: 'trust.promoteAfterClean', value: 5, why: 'faster promotion', recommend: 'approve', alternatives: ['keep 10'] });
  assert.match(card, /Not yours to change alone: .*may only be proposed.*approval/);
  const pending = await s.approvals.pending(orgId);
  const a = pending.find((x) => x.kind === 'tune')!;
  assert.equal(JSON.parse(a.payload).boundary, 'propose');
  assert.equal(a.defaultAction, 'deny', 'a boundary card never defaults to approve');
  assert.deepEqual(JSON.parse(a.alternatives), ['keep 10']);
  assert.equal((await s.org.get(orgId)).tunables.includes('trust.promoteAfterClean'), false, 'nothing changed');
  // the CEO is not bound
  await s.org.setTunable(orgId, 'trust.promoteAfterClean', 5, { actor: 'user' });
  assert.match((await s.org.get(orgId)).tunables, /trust\.promoteAfterClean/);
});

test('never: an agent touching the auditor\'s settings is refused, audited, a critical finding for the CEO and one minor boundary_violation incident (deduplicated while open)', async () => {
  const s = await setup();
  const orgId = await enable(s, 'autonomous');
  const chief = await sessionOf(s, s.chief.id);
  await assert.rejects(s.runtime.execute(chief, 'org_tune', { key: 'audit.ownerSpotChecks', value: 0, why: 'fewer cards' }), /never an agent's to change/);
  await assert.rejects(s.org.update(orgId, { auditCadenceDays: 60 }, 'chief'), /never an agent's/);
  await assert.rejects(s.org.setStatus(orgId, 'paused', 'chief'), /never an agent's/, 'the kill switch');
  const inc = (await s.incidents.list(orgId)).filter((i) => i.kind === 'boundary_violation');
  assert.equal(inc.length, 3, 'one per rule');
  assert.ok(inc.every((i) => i.severity === 'minor' && i.agentId === s.chief.id));
  await assert.rejects(s.runtime.execute(chief, 'org_tune', { key: 'audit.ownerSpotChecks', value: 1, why: 'again' }));
  assert.equal((await s.incidents.list(orgId)).filter((i) => i.kind === 'boundary_violation').length, 3, 'the same rule joins the open incident');
  const sig = (await s.signals.list(orgId, { kind: 'audit_finding' })).filter((x) => x.refType === 'boundary');
  assert.ok(sig.length >= 1 && sig.every((x) => x.severity === 'critical' && x.addresseeKind === 'ceo'));
  assert.ok((await s.audit.list(orgId, { action: 'boundary_violation' })).length >= 3);
  assert.equal((await s.org.get(orgId)).auditCadenceDays, 7, 'nothing changed');
  assert.equal((await s.audit.verify(orgId)).ok, true);
});

test('structure: a reorg within one unit applies; across units it is an experiment — a card until an experiments service exists, then refused naming org_propose_experiment; hires and terminations consult it too', async () => {
  const s = await setup();
  const orgId = await enable(s, 'autonomous');
  const chief = await sessionOf(s, s.chief.id);
  const analyst = await s.agents.create({ name: 'Analyst', charter: 'Numbers.' });
  await s.org.addMember(orgId, { agentId: analyst.id, title: 'Analyst', reportsToAgentId: s.writer.id });
  // within the root unit: Editor under Writer (both report to the chief)
  const ok = await s.runtime.execute(chief, 'org_reorg', { changes: [{ op: 'retitle', agent: 'Editor', title: 'Copy editor' }], why: 'clarity' });
  assert.match(ok, /^Reorg applied/);
  // across units: the analyst (Writer's unit) moves under Editor (root unit member)
  const card = await s.runtime.execute(chief, 'org_reorg', { changes: [{ op: 'move', agent: 'Analyst', reportsTo: 'Editor' }], why: 'numbers belong with editing' });
  assert.match(card, /changes only through an experiment; until experiments exist it goes to the CEO as a card/);
  assert.equal((await s.org.member(orgId, analyst.id))!.reportsToAgentId, s.writer.id, 'not moved');
  assert.equal(JSON.parse((await s.approvals.pending(orgId)).find((a) => a.kind === 'reorg')!.payload).boundary, 'experiment');
  s.boundary.setExperiments({ available: () => true });
  await assert.rejects(s.runtime.execute(chief, 'org_reorg', { changes: [{ op: 'move', agent: 'Analyst', reportsTo: 'Editor' }], why: 'again' }), /propose one with org_propose_experiment/);
  // terminating a lead reshapes two units → experiment
  await assert.rejects(s.runtime.execute(chief, 'org_terminate_agent', { agent: 'Writer', why: 'x' }), /propose one with org_propose_experiment/);
  s.boundary.setExperiments(undefined);
  await s.runtime.execute(chief, 'org_hire_agent', { templateOrPack: 'Helper', title: 'Helper', charter: 'You help.', why: 'more hands' });
  for (const k of ['reorg', 'terminate', 'hire']) assert.ok(s.checks.some((c) => c.change.kind === k), `${k} consulted`);
});

test('budget: allocations inside the envelope are the chief\'s; the company envelope is a card for the CEO in autonomous mode; the CEO raises it directly', async () => {
  const s = await setup();
  const orgId = await enable(s, 'autonomous');
  const chief = await sessionOf(s, s.chief.id);
  const ok = await s.runtime.execute(chief, 'org_allocate_budget', { scope: 'agent', agent: 'Writer', monthlyUsd: 5, why: 'drafts' });
  assert.match(ok, /agent envelope of Writer set to \$5\.00/);
  const card = await s.runtime.execute(chief, 'org_allocate_budget', { scope: 'company', monthlyUsd: 80, why: 'growth' });
  assert.match(card, /the company envelope \(\$50\.00\/month\) is the CEO's to set/);
  const a = (await s.approvals.pending(orgId)).find((x) => x.kind === 'budget_raise')!;
  assert.equal(JSON.parse(a.payload).boundary, 'propose');
  assert.equal(a.defaultAction, 'deny');
  await assert.rejects(s.org.setBudget(orgId, { scope: 'company', refId: orgId, monthlyUsd: 90, actor: 'chief' }), /propose it/, 'the low-level fence');
  await s.org.update(orgId, { monthlyBudgetUsd: 90 }, 'user');
  assert.equal((await s.org.get(orgId)).monthlyBudgetUsd, 90);
  assert.ok(s.checks.some((c) => c.change.kind === 'budget' && c.outcome === 'card'));
});

test('routing, cadence, playbook activation and charter acceptance consult the boundary; an agent cannot accept a charter (experiment)', async () => {
  const s = await setup();
  const orgId = await enable(s, 'autonomous');
  const chief = await sessionOf(s, s.chief.id);
  await s.runtime.execute(chief, 'org_set_routing', { class: 'research', tier: 'cheap', why: 'cheap is enough' });
  const root = await s.units.rootUnit(orgId);
  await s.meetings.setCadence(orgId, { unitId: root.id, kind: 'standup', cron: '0 9 * * 1-5', why: 'daily', actor: 'chief', decidedBy: 'chief' });
  const { playbook } = await s.playbooks.write(orgId, { title: 'Weekly issue', body: '---\nname: weekly-issue\n---\nWrite it.', why: 'repeatable', authorAgentId: s.writer.id });
  await s.playbooks.activate(orgId, playbook.id, 'user');
  await s.org.acceptCharter(orgId, s.writer.id, 'user');
  await assert.rejects(s.org.acceptCharter(orgId, s.writer.id, 'chief'), /experiment|propose/);
  for (const k of ['routing', 'cadence', 'playbook', 'charter']) assert.ok(s.checks.some((c) => c.change.kind === k), `${k} consulted`);
});

test('scopes and trust ceilings consult the boundary: widening within holdings is the chief\'s; trust ceilings are the owner\'s (an agent actor is routed to a proposal)', async () => {
  const s = await setup();
  const orgId = await enable(s, 'autonomous');
  const chief = await sessionOf(s, s.chief.id);
  const out = await s.runtime.execute(chief, 'org_set_scope', { agent: 'Writer', scopes: ['tool:fs_read', 'tool:web_search'], why: 'research' });
  assert.match(out, /widened|narrowed/);
  assert.ok(s.checks.some((c) => c.change.kind === 'scope_widen' || c.change.kind === 'scope_narrow'));
  await s.trust.setCeilings(s.ws.id, { external_reversible: 2 });
  assert.ok(s.checks.some((c) => c.change.kind === 'trust_ceiling' && c.outcome === 'proceed'), 'the owner passes');
  const d = await s.org.boundaryDecide(orgId, { kind: 'trust_ceiling' }, 'chief');
  assert.equal(d.outcome, 'card');
});

test('the CEO is not bound (except the audit chain): audit settings, the kill switch and a never-tunable apply for the owner, and nothing is logged as a violation', async () => {
  const s = await setup();
  const orgId = await enable(s);
  await s.org.update(orgId, { auditCadenceDays: 14 }, 'user');
  await s.org.setTunable(orgId, 'audit.ownerSpotChecks', 0, { actor: 'user' });
  await s.org.setStatus(orgId, 'paused', 'user');
  await s.org.setStatus(orgId, 'active', 'user');
  assert.equal((await s.org.get(orgId)).auditCadenceDays, 14);
  assert.equal((await s.incidents.list(orgId)).filter((i) => i.kind === 'boundary_violation').length, 0);
  assert.equal((await s.audit.list(orgId, { action: 'boundary_violation' })).length, 0);
  await assert.rejects(s.org.gate(orgId, { kind: 'audit_chain' }, 'user'), /never anyone's/);
});

test('the chief changes a report\'s settings: identity alone; model gated (card in supervised, applies in autonomous, switches chats); folder only by proposal', async () => {
  const s = await setup();
  const { agentTypes, chatSessions } = await import('../server/src/database/schema');
  const { eq } = await import('drizzle-orm');
  await s.db.insert(agentTypes).values({ id: 'tFast', name: 'Fast', provider: 'deepseek', model: 'deepseek-chat', models: '[]', baseUrl: null, apiKey: '', persona: '', enabled: 1, createdAt: new Date().toISOString() } as never);

  // supervised: identity applies, a model change is a card, the card applies the model
  const orgId = await enable(s, 'supervised');
  let chief = await sessionOf(s, s.chief.id);
  const writerChat = await sessionOf(s, s.writer.id);
  const id = await s.runtime.execute(chief, 'org_update_member', { agent: 'Writer', role: 'Lead writer', emoji: '✍️', colors: ['#112233', '#445566'], why: 'clearer seat' });
  assert.match(id, /Updated Writer: identity/);
  assert.equal((await s.agents.get(s.writer.id)).role, 'Lead writer');
  const card = await s.runtime.execute(chief, 'org_update_member', { agent: 'Writer', agentType: 'Fast', why: 'cheaper drafts' });
  assert.match(card, /Model change proposed/);
  assert.equal((await s.agents.get(s.writer.id)).agentTypeId ?? null, null, 'nothing changes before approval');
  const pending = (await s.approvals.pending(orgId)).find((a) => a.kind === 'member_settings');
  assert.ok(pending);
  await s.approvals.decide(orgId, pending!.id, 'approve');
  const after = await s.agents.get(s.writer.id);
  assert.equal(after.agentTypeId, 'tFast');
  assert.equal(after.model, 'deepseek-chat');
  assert.equal((await s.db.select().from(chatSessions).where(eq(chatSessions.id, writerChat.id)))[0].agentTypeId, 'tFast', 'existing chats switch');

  // the folder is always a proposal; an unknown type is refused; the chief cannot change itself
  const folder = await s.runtime.execute(chief, 'org_update_member', { agent: 'Editor', workspaceFolder: 'drafts', why: 'needs drafts' });
  assert.match(folder, /Not yours to change alone/);
  assert.equal((await s.agents.get(s.editor.id)).workspaceFolder, '');
  await assert.rejects(s.runtime.execute(chief, 'org_update_member', { agent: 'Editor', agentType: 'Nope', why: 'x' }), /no enabled agent type/);
  await assert.rejects(s.runtime.execute(chief, 'org_update_member', { agent: 'Chief', role: 'Boss', why: 'x' }));
  await assert.rejects(s.runtime.execute(chief, 'org_update_member', { agent: 'Editor', why: 'nothing' }), /nothing to change/);

  // autonomous: the model change applies at once and is audited as a decision
  await s.mode.setMode(s.ws.id, { mode: 'autonomous' });
  chief = await sessionOf(s, s.chief.id);
  const auto = await s.runtime.execute(chief, 'org_update_member', { agent: 'Editor', agentType: 'Fast', model: 'deepseek-reasoner', applyToChats: false, why: 'reasoning drafts' });
  assert.match(auto, /Updated Editor: model/);
  const ed = await s.agents.get(s.editor.id);
  assert.equal(ed.agentTypeId, 'tFast');
  assert.equal(ed.model, 'deepseek-reasoner');
  assert.ok(s.checks.some((c) => c.change.kind === 'member_model' && c.outcome === 'proceed'));
});
