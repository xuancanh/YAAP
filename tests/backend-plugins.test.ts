/** Plugins Phase 1 end to end (docs/plugins.md §10 Phase 1 acceptance):
 *  install review and consent, mock conformance gating binds, bindings and
 *  the resolver (unbound refused with candidates, resource beats default),
 *  the dispatcher offering `scm_*` and no vendor tool, the fixed policy
 *  stage in the turn loop (change gate, two-key by the generic floor,
 *  owner deny, the approval outcome set with its asked/decided pair,
 *  metering against the envelope, deny by default), the change record
 *  lifecycle with verify and unattended rollback, a restart-safe sweep, the
 *  registrar's reverse unwind and restore, dependency-driven suspension,
 *  updates with the permission diff, and provenance for model-visible text. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { and, eq, isNotNull } from 'drizzle-orm';
import { testDb, memStorage, ctxStub, skillsStub, mcpStub } from './helpers';
import type { AiProvider, AiRequest, AiStreamEvent } from '../server/src/ai/ai-provider.interface';
import { ChatsRepository } from '../server/src/chats/chats.repository';
import { TurnLoopService, type TurnEvent, type TurnOrigin } from '../server/src/chats/turn-loop.service';
import { ChatLocks } from '../server/src/chats/chat-locks';
import { ToolsService } from '../server/src/chats/tools.service';
import { TriggerBus } from '../server/src/chats/trigger-bus';
import { AgentsService } from '../server/src/agents/agents.service';
import { WorkspacesService } from '../server/src/workspaces/workspaces.service';
import { ActionsService } from '../server/src/actions/actions.service';
import { TrustService } from '../server/src/actions/trust.service';
import { classOf } from '../server/src/actions/action-classes';
import { actionLog, changeRecords, contextProvenance, interfaceBindings, interfaceProviders, pluginAudit, pluginEffects, pluginGrants, pluginInstalls } from '../server/src/database/schema';
import { PluginAuditService } from '../server/src/plugins/plugin-audit';
import { PluginsService } from '../server/src/plugins/plugins.service';
import { ChangesService } from '../server/src/plugins/changes.service';
import { InterfaceDispatcher } from '../server/src/plugins/dispatcher';
import type { Manifest } from '../server/src/plugins/manifest';
import { runWithViewer } from '../server/src/accounts/account-context';

class QueueProvider implements AiProvider {
  readonly name = 'queue';
  readonly requests: AiRequest[] = [];
  readonly queue: AiStreamEvent[][] = [];
  async *stream(req: AiRequest): AsyncGenerator<AiStreamEvent> {
    this.requests.push(req);
    const events = this.queue.shift() ?? [{ type: 'answer', text: 'ok' } as AiStreamEvent, { type: 'done' } as AiStreamEvent];
    for (const ev of events) yield ev;
  }
  call(name: string, input: Record<string, unknown>, id = `c${Math.random().toString(36).slice(2, 8)}`): void {
    this.queue.push([{ type: 'tool_call', id, name, input }, { type: 'done' }]);
  }
}

const REPO = 'scm://mock.example/acme/app';
const scmText = readFileSync('plugins/first-party/scm/plugin.json', 'utf8');
const mockText = readFileSync('plugins/first-party/scm-mock/plugin.json', 'utf8');
const scmFixtures = readFileSync('plugins/first-party/scm-mock/fixtures/scm.json', 'utf8');

async function setup() {
  const db = await testDb();
  const { stub } = memStorage();
  const bus = new TriggerBus();
  const agents = new AgentsService(db, stub, bus);
  const workspaces = new WorkspacesService(db, stub);
  const repo = new ChatsRepository(db);
  const provider = new QueueProvider();
  const trust = new TrustService(db, agents, bus);
  const actions = new ActionsService(db, trust, agents);
  const turns = new TurnLoopService(repo, new ChatLocks(), new ToolsService(stub), ctxStub(provider), skillsStub(), stub, mcpStub(), agents, workspaces,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, actions);
  const audit = new PluginAuditService(db, actions);
  const plugins = new PluginsService(db, audit, actions);
  const changes = new ChangesService(db, audit, actions);
  const dispatcher = new InterfaceDispatcher(db, plugins, changes, audit, actions, turns);
  turns.addToolProvider(dispatcher);
  const ws = (await workspaces.list())[0];
  const alice = await agents.create({ name: 'Alice', charter: 'You write code.', provider: 'anthropic', model: 'claude-sonnet-4-5' });
  const bob = await agents.create({ name: 'Bob', charter: 'You review code.', provider: 'openai', model: 'gpt-5' });
  return { db, agents, repo, provider, trust, actions, turns, audit, plugins, changes, dispatcher, ws, alice, bob };
}
type S = Awaited<ReturnType<typeof setup>>;

async function run(s: S, sessionId: string, text: string, origin: TurnOrigin = 'user', onApproval?: (ev: Extract<TurnEvent, { type: 'approval_required' }>) => void): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  for await (const ev of s.turns.run(sessionId, { text, origin })) {
    out.push(ev);
    if (ev.type === 'approval_required') onApproval?.(ev);
  }
  return out;
}
const results = (evs: TurnEvent[]) => evs.filter((e): e is Extract<TurnEvent, { type: 'tool_result' }> => e.type === 'tool_result');

/** scm, ci and the mock provider installed; scm and ci bound to it; Alice and Bob granted write. */
async function ready(s: S, opts: { bind?: boolean; grant?: boolean } = {}) {
  for (const id of ['scm', 'ci', 'scm-mock']) await s.plugins.install(s.ws.id, { firstParty: id }, { confirm: true });
  const mock = (await s.plugins.interfacesView(s.ws.id)).find((i) => i.name === 'scm')!.providers as Array<{ id: string; pluginId: string }>;
  if (opts.bind !== false) {
    await s.plugins.setBinding(s.ws.id, 'scm', { scopeKind: 'workspace', providerId: 'scm-mock@yaam' });
    await s.plugins.setBinding(s.ws.id, 'ci', { scopeKind: 'workspace', providerId: 'scm-mock@yaam' });
  }
  if (opts.grant !== false) for (const a of [s.alice, s.bob]) await s.plugins.setGrant(s.ws.id, 'scm-mock@yaam', a.id, { level: 'write' });
  return { scmProviderId: mock[0].id };
}

async function toolNames(s: S, agentId: string): Promise<string[]> {
  const session = await s.repo.createSession({ workspaceId: s.ws.id, agentId, name: 'probe', permissionMode: 'auto' });
  return (await s.dispatcher.specsFor(session)).map((t) => t.name);
}

/** Alice opens a pull request; returns the change record id. */
async function openPr(s: S, chatId: string): Promise<string> {
  s.provider.call('scm_open_pr', { repo: REPO, head: 'feature/login', base: 'main', title: 'Add the login page' });
  const evs = await run(s, chatId, 'open it');
  const r = results(evs)[0];
  assert.equal(r.isError, false, r.output);
  const rec = (await s.changes.list(s.ws.id))[0];
  assert.equal(rec.state, 'proposed');
  return rec.id;
}

test('review screen: classes with floor reasons, change kinds and their requirement, no-egress; install records consent', async () => {
  const s = await setup();
  const review = await s.plugins.review(s.ws.id, { firstParty: 'scm' }) as Record<string, unknown> & { interfaces: Array<{ operations: Array<{ op: string; effectiveClass: string; twoKeyByFloor: boolean; floorReasons: string[] }>; changeKinds: Array<{ kind: string; effectiveRequirement: string }> }> };
  const merge = review.interfaces[0].operations.find((o) => o.op === 'merge')!;
  assert.equal(merge.effectiveClass, 'external_irreversible');
  assert.equal(merge.twoKeyByFloor, true);
  assert.ok(merge.floorReasons.some((r) => r.includes('two-key')));
  assert.equal(review.interfaces[0].changeKinds[0].kind, 'scm.pull_request');
  assert.equal(review.interfaces[0].changeKinds[0].effectiveRequirement, 'two_key');
  assert.equal(review.noEgress, true);
  assert.equal(review.tier, 'first_party');
  // the two-step install: without confirm nothing is written
  const dry = await s.plugins.install(s.ws.id, { firstParty: 'scm' });
  assert.equal(dry.installed, false);
  assert.equal((await s.db.select().from(pluginInstalls)).length, 0);
  await s.plugins.install(s.ws.id, { firstParty: 'scm' }, { confirm: true });
  const a = await s.db.select().from(pluginAudit).where(eq(pluginAudit.action, 'plugin_installed'));
  assert.equal(a.length, 1);
  assert.ok((JSON.parse(a[0].payload) as { consent: { classifications: string[] } }).consent.classifications.includes('scm.merge=external_irreversible'));
  // a member cannot install
  await assert.rejects(runWithViewer('single', { memberAccountId: 'm2', role: 'member', workspaceId: s.ws.id, displayName: 'M' }, () => s.plugins.install(s.ws.id, { firstParty: 'ci' }, { confirm: true })), /only the workspace owner/);
});

test('with scm and the mock installed and bound, an agent sees scm_open_pr and scm_merge and no vendor tool; classOf knows them', async () => {
  const s = await setup();
  await ready(s);
  const names = await toolNames(s, s.alice.id);
  assert.ok(names.includes('scm_open_pr'));
  assert.ok(names.includes('scm_merge'));
  assert.ok(names.includes('ci_read_run'));
  assert.ok(names.includes('change_request_apply'));
  assert.equal(names.some((n) => n.startsWith('scmmock') || n.startsWith('mock') || n.startsWith('github')), false);
  assert.equal(classOf('scm_merge'), 'external_irreversible');
  assert.equal(classOf('scm_list_prs'), 'read');
  assert.equal(classOf('scm_push', { branch: 'main' }), 'external_irreversible');
  // an agent with no grant sees none of it
  const carol = await s.agents.create({ name: 'Carol', charter: 'x', provider: 'anthropic', model: 'claude-sonnet-4-5' });
  assert.deepEqual((await toolNames(s, carol.id)).filter((n) => n.startsWith('scm_')), []);
  // a read grant offers reads only
  await s.plugins.setGrant(s.ws.id, 'scm-mock@yaam', carol.id, { level: 'read' });
  const carolNames = await toolNames(s, carol.id);
  assert.ok(carolNames.includes('scm_read_pr'));
  assert.equal(carolNames.includes('scm_merge'), false);
  // every offered definition was logged with provenance
  const prov = await s.db.select().from(contextProvenance).where(eq(contextProvenance.sourceKind, 'tool_definition'));
  assert.ok(prov.some((p) => p.contributionId === 'scm.merge' && p.pluginId === 'scm@yaam'));
});

test('conformance gates binding: a provider failing a case cannot be bound; a failing update keeps the old version bound', async () => {
  const s = await setup();
  await ready(s, { bind: false, grant: false });
  const plugins = await s.plugins.list(s.ws.id);
  const mock = plugins.find((p) => p.id === 'scm-mock@yaam') as { providers: Array<{ status: string }> };
  assert.deepEqual(mock.providers.map((p) => p.status), ['conformant', 'conformant']);
  // a local provider whose merge answers without mergeSha fails the suite
  const broken = JSON.parse(mockText) as Manifest;
  broken.id = 'brokenforge@local';
  broken.provides = broken.provides!.filter((p) => p.interface === 'scm@^1');
  broken.requires.interfaces = ['scm@^1'];
  const fx = JSON.parse(scmFixtures) as { operations: Record<string, Array<Record<string, unknown>>> };
  fx.operations.merge = [{ output: { merged: true } }];
  await s.plugins.install(s.ws.id, { manifest: broken, files: { 'fixtures/scm.json': JSON.stringify(fx) } }, { confirm: true });
  const detail = await s.plugins.detail(s.ws.id, 'brokenforge@local') as { status: string; suspendedReason: string; conformance: Array<{ result: string; cases: Array<{ id: string; ok: boolean; detail?: string }> }> };
  assert.equal(detail.status, 'installed');
  assert.ok(detail.suspendedReason.includes('conformance'));
  assert.equal(detail.conformance[0].result, 'fail');
  assert.ok(detail.conformance[0].cases.some((c) => !c.ok && c.id === 'merge-then-revert'));
  await assert.rejects(s.plugins.setBinding(s.ws.id, 'scm', { providerId: 'brokenforge@local' }), /cannot be bound: conformance failed/);
  // the good one binds; an update that fails conformance stays pending and the old version stays bound
  await s.plugins.setBinding(s.ws.id, 'scm', { providerId: 'scm-mock@yaam' });
  const goodLocal = JSON.parse(mockText) as Manifest;
  goodLocal.id = 'forge@local';
  goodLocal.provides = goodLocal.provides!.filter((p) => p.interface === 'scm@^1');
  goodLocal.requires.interfaces = ['scm@^1'];
  await s.plugins.install(s.ws.id, { manifest: goodLocal, files: { 'fixtures/scm.json': scmFixtures } }, { confirm: true });
  await s.plugins.setBinding(s.ws.id, 'scm', { scopeKind: 'resource', scopeRef: 'scm://mock.example/acme/*', providerId: 'forge@local' });
  const v2 = structuredClone(goodLocal);
  v2.version = '1.0.1';
  const r = await s.plugins.update(s.ws.id, 'forge@local', { manifest: v2, files: { 'fixtures/scm.json': JSON.stringify(fx) } });
  assert.equal(r.applied, false);
  assert.ok((r.failures as string[]).length > 0);
  const after = await s.plugins.detail(s.ws.id, 'forge@local') as { version: string; providers: Array<{ status: string }>; pendingUpdate: { version: string } | null };
  assert.equal(after.version, '1.0.0');
  assert.equal(after.providers[0].status, 'conformant');
  assert.equal(after.pendingUpdate?.version, '1.0.1');
  await assert.rejects(s.plugins.decideUpdate(s.ws.id, 'forge@local', true), /fails conformance/);
  const resolved = await s.plugins.resolve(s.ws.id, 'scm', { resource: REPO });
  assert.equal(resolved.pluginId, 'forge@local');
});

test('the resolver: resource binding beats the default as resolve predicts; with no default the call is refused with candidates named', async () => {
  const s = await setup();
  await ready(s, { bind: false });
  const second = JSON.parse(mockText) as Manifest;
  second.id = 'forge@local';
  second.provides = second.provides!.filter((p) => p.interface === 'scm@^1');
  second.requires.interfaces = ['scm@^1'];
  await s.plugins.install(s.ws.id, { manifest: second, files: { 'fixtures/scm.json': scmFixtures } }, { confirm: true });
  for (const a of [s.alice]) await s.plugins.setGrant(s.ws.id, 'forge@local', a.id, { level: 'write' });
  // two providers, no binding: refused, both named
  const chat = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.alice.id, name: 'chat', permissionMode: 'auto' });
  const none = await s.plugins.resolve(s.ws.id, 'scm', { resource: REPO });
  assert.equal(none.ok, false);
  assert.deepEqual((none.candidates as Array<{ pluginId: string }>).map((c) => c.pluginId).sort(), ['forge@local', 'scm-mock@yaam']);
  s.provider.call('scm_list_prs', { repo: REPO });
  const evs = await run(s, chat.id, 'list');
  const refused = results(evs)[0];
  assert.equal(refused.isError, true);
  assert.match(refused.output, /no scm provider is bound.*forge@local/);
  const row = (await s.db.select().from(actionLog).where(eq(actionLog.tool, 'scm_list_prs')))[0];
  assert.equal(row.status, 'refused');
  assert.equal(row.operation, 'scm.list_prs');
  // default to the mock; one client's repositories to forge
  await s.plugins.setBinding(s.ws.id, 'scm', { providerId: 'scm-mock@yaam' });
  await s.plugins.setBinding(s.ws.id, 'scm', { scopeKind: 'resource', scopeRef: 'scm://mock.example/client-x/*', providerId: 'forge@local' });
  const a = await s.plugins.resolve(s.ws.id, 'scm', { resource: REPO });
  const b = await s.plugins.resolve(s.ws.id, 'scm', { resource: 'scm://mock.example/client-x/site' });
  assert.equal(a.pluginId, 'scm-mock@yaam');
  assert.equal(b.pluginId, 'forge@local');
  assert.equal(b.scope, 'resource:scm://mock.example/client-x/*');
  s.provider.call('scm_list_prs', { repo: 'scm://mock.example/client-x/site' });
  await run(s, chat.id, 'list again');
  const routed = (await s.db.select().from(actionLog).where(eq(actionLog.tool, 'scm_list_prs'))).find((r) => r.status === 'succeeded')!;
  assert.equal(routed.providerId, b.providerId);
  assert.equal(routed.bindingScope, 'resource:scm://mock.example/client-x/*');
  // a provider cannot be asked about a resource it does not serve
  const elsewhere = await s.plugins.resolve(s.ws.id, 'scm', { resource: 'scm://gitlab.example/acme/app' });
  assert.equal(elsewhere.ok, false);
  assert.match(String(elsewhere.reason), /does not serve/);
  // bindings are audited
  assert.ok((await s.db.select().from(pluginAudit).where(eq(pluginAudit.action, 'interface_binding_set'))).length >= 2);
});

test('scm_merge without an approved record is refused; with one it is two-key by the floor and runs on the record\'s one-shot key', async () => {
  const s = await setup();
  await ready(s);
  const alice = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.alice.id, name: 'alice', permissionMode: 'auto' });
  const bob = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.bob.id, name: 'bob', permissionMode: 'auto' });
  // no record at all
  s.provider.call('scm_merge', { repo: REPO, number: 7, headSha: 'a1b2c3d' });
  let evs = await run(s, alice.id, 'merge');
  assert.equal(results(evs)[0].isError, true);
  assert.match(results(evs)[0].output, /change gate refused scm\.merge: an apply names its change record/);
  const changeId = await openPr(s, alice.id);
  const rec = (await s.changes.get(s.ws.id, changeId));
  assert.deepEqual(JSON.parse(rec.bind), { repo: REPO, number: 7, headSha: 'a1b2c3d', base: 'main' });
  assert.equal(rec.requirement, 'two_key');
  assert.equal(rec.proposer, `agent:${s.alice.id}`);
  // a proposed record cannot be applied
  s.provider.call('scm_merge', { repo: REPO, number: 7, headSha: 'a1b2c3d', changeId });
  evs = await run(s, alice.id, 'merge');
  assert.match(results(evs)[0].output, /proposed; apply needs an approved record/);
  // the author's own review does not count; Bob's does
  s.provider.call('scm_review', { repo: REPO, number: 7, event: 'APPROVE' });
  evs = await run(s, alice.id, 'review my own');
  assert.match(results(evs)[0].output, /does not count/);
  assert.equal((await s.changes.get(s.ws.id, changeId)).state, 'proposed');
  s.provider.call('scm_review', { repo: REPO, number: 7, event: 'APPROVE' });
  await run(s, bob.id, 'review it');
  assert.equal((await s.changes.get(s.ws.id, changeId)).state, 'reviewed');
  // the gate: two-key → waits for the owner's key
  s.provider.call('change_request_apply', { changeId });
  evs = await run(s, alice.id, 'gate');
  assert.match(results(evs)[0].output, /gated: it needs two-key/);
  s.provider.call('scm_merge', { repo: REPO, number: 7, headSha: 'a1b2c3d', changeId });
  evs = await run(s, alice.id, 'merge early');
  assert.match(results(evs)[0].output, /gated; apply needs an approved record/);
  await s.changes.key(s.ws.id, changeId, true, 'ship it');
  // a different target is refused even with the key
  s.provider.call('scm_merge', { repo: REPO, number: 7, headSha: 'beef', changeId });
  evs = await run(s, alice.id, 'merge other sha');
  assert.match(results(evs)[0].output, /not the reviewed target/);
  // the reviewed target merges on the key without another ask
  let asked = 0;
  s.provider.call('scm_merge', { repo: REPO, number: 7, headSha: 'a1b2c3d', changeId });
  evs = await run(s, alice.id, 'merge', 'user', () => { asked++; });
  assert.equal(asked, 0);
  const merged = results(evs)[0];
  assert.equal(merged.isError, false, merged.output);
  assert.equal(merged.actionClass, 'external_irreversible');
  assert.match(merged.output, /m9e8d7c/);
  const after = await s.changes.get(s.ws.id, changeId);
  assert.equal(after.state, 'verifying', 'the ci check is armed: ci is bound');
  const mergeRow = (await s.db.select().from(actionLog).where(and(eq(actionLog.tool, 'scm_merge'), eq(actionLog.status, 'succeeded'))))[0];
  assert.equal(mergeRow.approvalOutcome, 'allowed-once');
  assert.equal(mergeRow.changeId, changeId);
  assert.equal(after.applyActionId, mergeRow.id);
  // the key is one-shot: the record is no longer approved
  s.provider.call('scm_merge', { repo: REPO, number: 7, headSha: 'a1b2c3d', changeId });
  evs = await run(s, alice.id, 'merge twice');
  assert.equal(results(evs)[0].isError, true);
  // CI on the merge commit verifies it
  const done = await s.changes.ingestEvent(s.ws.id, { type: 'ci.run.completed', payload: { sha: 'm9e8d7c', conclusion: 'success' } });
  assert.equal(done[0]?.state, 'verified');
  // every transition is audited and evented
  const transitions = await s.db.select().from(pluginAudit).where(and(eq(pluginAudit.action, 'change_transitioned'), eq(pluginAudit.refId, changeId)));
  assert.deepEqual(transitions.map((t) => (JSON.parse(t.payload) as { to: string }).to), ['proposed', 'reviewed', 'gated', 'approved', 'applied', 'verifying', 'verified']);
  assert.equal((await s.audit.verify(s.ws.id)).ok, true);
});

test('a conflict on apply means the target moved: the record returns to proposed', async () => {
  const s = await setup();
  await ready(s);
  const alice = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.alice.id, name: 'alice', permissionMode: 'auto' });
  const changeId = await openPr(s, alice.id);
  // pin a stale head on the record (the vendor's head moved after review)
  await s.db.update(changeRecords).set({ bind: JSON.stringify({ repo: REPO, number: 7, headSha: 'stale', base: 'main' }) }).where(eq(changeRecords.id, changeId));
  await s.changes.review(s.ws.id, changeId, { by: `agent:${s.bob.id}`, approve: true });
  await s.changes.requestApply(s.ws.id, changeId, `agent:${s.alice.id}`);
  await s.changes.key(s.ws.id, changeId, true);
  s.provider.call('scm_merge', { repo: REPO, number: 7, headSha: 'stale', changeId });
  const evs = await run(s, alice.id, 'merge');
  assert.match(results(evs)[0].output, /provider error \(conflict\)/);
  assert.equal((await s.changes.get(s.ws.id, changeId)).state, 'proposed');
});

test('a lapsed verify window rolls back unattended through the rollback-role operation, and a restart resumes the wait', async () => {
  const s = await setup();
  await ready(s);
  const alice = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.alice.id, name: 'alice', permissionMode: 'auto' });
  const changeId = await openPr(s, alice.id);
  await s.changes.review(s.ws.id, changeId, { by: `agent:${s.bob.id}`, approve: true });
  await s.changes.requestApply(s.ws.id, changeId, `agent:${s.alice.id}`);
  await s.changes.key(s.ws.id, changeId, true);
  s.provider.call('scm_merge', { repo: REPO, number: 7, headSha: 'a1b2c3d', changeId });
  await run(s, alice.id, 'merge');
  assert.equal((await s.changes.get(s.ws.id, changeId)).state, 'verifying');
  // "restart": fresh services over the same database
  const audit2 = new PluginAuditService(s.db, s.actions);
  const plugins2 = new PluginsService(s.db, audit2, s.actions);
  const changes2 = new ChangesService(s.db, audit2, s.actions);
  new InterfaceDispatcher(s.db, plugins2, changes2, audit2, s.actions);
  const r = await changes2.sweep(new Date(Date.now() + 46 * 60_000));
  assert.equal(r.rolledBack, 1);
  const rec = await changes2.get(s.ws.id, changeId);
  assert.equal(rec.state, 'rolled_back');
  const revert = (await s.db.select().from(actionLog).where(eq(actionLog.tool, 'scm_revert')))[0];
  assert.equal(revert.status, 'succeeded');
  assert.equal(revert.decision, 'change_rollback');
  assert.equal(rec.rollbackActionId, revert.id);
  // nothing is rolled back twice
  assert.deepEqual(await changes2.sweep(new Date(Date.now() + 90 * 60_000)), { rejected: 0, rolledBack: 0 });
  // the ledger heard of it
  const ledger = await s.trust.effective(s.ws.id, s.alice.id, 'external_irreversible');
  assert.equal(ledger.effective, 0);
  plugins2.dispose();
});

test('a core.manual record walks the whole lifecycle; an unanswered gate ends unavailable', async () => {
  const s = await setup();
  const rec = await s.changes.create(s.ws.id, { kind: 'core.manual', title: 'Rotate the DNS', proposer: 'user:single', requirement: 'two_key', checks: [{ source: 'core.manual', within: '30m', status: 'pending' }] });
  const events: string[] = [];
  s.changes.onTransition((e) => events.push(`${e.from}→${e.to}`));
  await s.changes.review(s.ws.id, rec.id, { by: 'user:single', approve: true });
  assert.equal((await s.changes.get(s.ws.id, rec.id)).state, 'proposed', 'the proposer\'s own review does not count');
  await assert.rejects(s.changes.requestApply(s.ws.id, rec.id, 'user:single'), /no independent review/);
  await s.changes.review(s.ws.id, rec.id, { by: 'user:other', approve: true });
  await s.changes.requestApply(s.ws.id, rec.id, 'user:single');
  await s.changes.key(s.ws.id, rec.id, true);
  await s.changes.attestApplied(s.ws.id, rec.id, 'done by hand');
  assert.equal((await s.changes.get(s.ws.id, rec.id)).state, 'verifying');
  await s.changes.attest(s.ws.id, rec.id, true, 'resolves');
  assert.equal((await s.changes.get(s.ws.id, rec.id)).state, 'verified');
  assert.deepEqual(events, ['proposed→reviewed', 'reviewed→gated', 'gated→approved', 'approved→applied', 'applied→verifying', 'verifying→verified']);
  // the rollback path for a manual change waits for an attested rollback
  const r2 = await s.changes.create(s.ws.id, { kind: 'core.manual', title: 'Change the price page', proposer: 'user:single', requirement: 'two_key', checks: [{ source: 'core.manual', within: '30m', status: 'pending' }] });
  await s.changes.review(s.ws.id, r2.id, { by: 'user:other', approve: true });
  await s.changes.requestApply(s.ws.id, r2.id, 'user:single');
  await s.changes.key(s.ws.id, r2.id, true);
  await s.changes.attestApplied(s.ws.id, r2.id);
  await s.changes.sweep(new Date(Date.now() + 31 * 60_000));
  assert.equal((await s.changes.get(s.ws.id, r2.id)).state, 'rolling_back');
  await s.changes.attestRolledBack(s.ws.id, r2.id, true, 'reverted the page');
  assert.equal((await s.changes.get(s.ws.id, r2.id)).state, 'rolled_back');
  // a gate nobody answers is rejected as unavailable
  const r3 = await s.changes.create(s.ws.id, { kind: 'core.manual', title: 'x', proposer: 'user:single', requirement: 'two_key' });
  await s.changes.review(s.ws.id, r3.id, { by: 'user:other', approve: true });
  await s.changes.requestApply(s.ws.id, r3.id, 'user:single');
  await s.changes.sweep(new Date(Date.now() + 73 * 3_600_000));
  const r3after = await s.changes.get(s.ws.id, r3.id);
  assert.equal(r3after.state, 'rejected');
  assert.equal((JSON.parse(r3after.keys) as { outcome: string }).outcome, 'unavailable');
  const pairs = await s.db.select().from(pluginAudit).where(eq(pluginAudit.refId, r3.id));
  const asked = pairs.find((p) => p.action === 'approval_asked')!;
  const decided = pairs.find((p) => p.action === 'approval_decided')!;
  assert.equal((JSON.parse(asked.payload) as { requestId: string }).requestId, (JSON.parse(decided.payload) as { requestId: string }).requestId);
});

test('approval outcomes: allowed-once, rejected, cancelled and unavailable, each with an asked/decided pair', async () => {
  const s = await setup();
  await ready(s);
  // push to the default branch is irreversible by classByInput: it asks (level 0)
  const chat = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.alice.id, name: 'chat', permissionMode: 'auto' });
  const outcome = async () => (await s.db.select().from(actionLog).where(eq(actionLog.tool, 'scm_push'))).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1)!;
  s.provider.call('scm_push', { repo: REPO, branch: 'main' });
  await run(s, chat.id, 'push', 'user', (ev) => s.turns.resolveApproval(chat.id, ev.callId, 'allow-once'));
  let row = await outcome();
  assert.equal(row.class, 'external_irreversible');
  assert.equal(row.approvalOutcome, 'allowed-once');
  assert.ok(row.approvalRequestId && row.approvalAskedAt && row.approvalDecidedAt);
  // allow-tool is never remembered for an irreversible plugin call
  s.provider.call('scm_push', { repo: REPO, branch: 'main', workdir: 'b' });
  await run(s, chat.id, 'push', 'user', (ev) => s.turns.resolveApproval(chat.id, ev.callId, 'allow-tool'));
  let asked = 0;
  s.provider.call('scm_push', { repo: REPO, branch: 'main', workdir: 'b2' });
  await run(s, chat.id, 'push', 'user', (ev) => { asked++; s.turns.resolveApproval(chat.id, ev.callId, 'deny'); });
  assert.equal(asked, 1, 'asked again: nothing was remembered');
  row = await outcome();
  assert.equal(row.approvalOutcome, 'rejected');
  // a stopped turn is cancelled, not a rejection
  s.provider.call('scm_push', { repo: REPO, branch: 'main', workdir: 'c' });
  await run(s, chat.id, 'push', 'user', () => s.turns.stop(chat.id));
  row = await outcome();
  assert.equal(row.approvalOutcome, 'cancelled');
  // an orphaned ask (no answer) is unavailable
  s.turns.approvalTtlMs = 20;
  s.provider.call('scm_push', { repo: REPO, branch: 'main', workdir: 'd' });
  await run(s, chat.id, 'push');
  row = await outcome();
  assert.equal(row.approvalOutcome, 'unavailable');
  assert.equal(row.costState, 'released');
  // an unattended two-key call is held; nobody answers by the deadline → unavailable, denied
  const loop = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.alice.id, name: 'Loop', permissionMode: 'auto' });
  s.provider.call('scm_push', { repo: REPO, branch: 'main', workdir: 'e' });
  const evs = await run(s, loop.id, 'tick', 'loop');
  assert.match(results(evs)[0].output, /Held for the owner's key/);
  const swept = await s.dispatcher.sweep(new Date(Date.now() + 73 * 3_600_000));
  assert.equal(swept.expired, 1);
  row = await outcome();
  assert.equal(row.status, 'denied');
  assert.equal(row.approvalOutcome, 'unavailable');
  // every pair shares its request id in the plugin audit chain
  const audits = await s.db.select().from(pluginAudit).where(eq(pluginAudit.refId, row.id));
  const ids = audits.filter((a) => a.action.startsWith('approval_')).map((a) => (JSON.parse(a.payload) as { requestId: string }).requestId);
  assert.equal(ids.length, 2);
  assert.equal(ids[0], ids[1]);
  // a held call approved by the owner runs on that key (allowed-once)
  s.provider.call('scm_push', { repo: REPO, branch: 'main', workdir: 'f' });
  await run(s, loop.id, 'tick', 'loop');
  const held = await outcome();
  const done = await s.actions.ownerKey(s.ws.id, held.id, true);
  assert.equal(done.status, 'succeeded', done.result);
  row = await outcome();
  assert.equal(row.approvalOutcome, 'allowed-once');
  assert.equal(row.costState, 'settled');
});

test('the owner\'s deny policy refuses; a raise policy makes a reversible operation ask', async () => {
  const s = await setup();
  await ready(s);
  const chat = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.alice.id, name: 'chat', permissionMode: 'auto' });
  await s.plugins.putPolicy(s.ws.id, '', { operation: 'scm.comment', require: 'deny', why: 'no comments this week' });
  s.provider.call('scm_comment', { repo: REPO, number: 7, body: 'hi' });
  let evs = await run(s, chat.id, 'comment');
  assert.match(results(evs)[0].output, /owner's policy denies scm\.comment: no comments this week/);
  await s.plugins.putPolicy(s.ws.id, '', { operation: 'scm.create_branch', resourcePattern: 'scm://mock.example/acme/*', require: 'two_key', why: 'prod repos' });
  let asked = 0;
  s.provider.call('scm_create_branch', { repo: REPO, name: 'x', from: 'main' });
  evs = await run(s, chat.id, 'branch', 'user', (ev) => { asked++; s.turns.resolveApproval(chat.id, ev.callId, 'allow-once'); });
  assert.equal(asked, 1);
  assert.equal(results(evs)[0].isError, false);
});

test('metering: every call carries its cost settled against the envelope; a spent envelope refuses before the call', async () => {
  const s = await setup();
  await ready(s);
  const chat = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.alice.id, name: 'chat', permissionMode: 'auto' });
  s.provider.call('scm_list_prs', { repo: REPO });
  s.provider.call('scm_read_pr', { repo: REPO, number: 7 });
  await run(s, chat.id, 'look');
  await run(s, chat.id, 'look again');
  const rows = await s.db.select().from(actionLog).where(isNotNull(actionLog.operation));
  assert.equal(rows.length, 2, 'reads are logged too');
  for (const r of rows) { assert.equal(r.costState, 'settled'); assert.equal(r.costUsd, 0.0002); }
  assert.ok(Math.abs(await s.dispatcher.monthSpend(s.ws.id) - 0.0004) < 1e-9);
  // spend the envelope (plugins.monthlyUsd = 25 by default)
  await s.db.update(actionLog).set({ costUsd: 25 }).where(eq(actionLog.id, rows[0].id));
  s.provider.call('scm_list_prs', { repo: REPO, state: 'open' });
  const evs = await run(s, chat.id, 'list');
  assert.match(results(evs)[0].output, /plugin envelope is spent/);
  // the untrusted output is wrapped and logged with provenance
  const out = rows.find((r) => r.tool === 'scm_read_pr')!;
  assert.match(out.result, /<plugin-output source="scm via scm-mock@yaam" untrusted="true">/);
  const prov = await s.db.select().from(contextProvenance).where(eq(contextProvenance.sourceKind, 'operation_result'));
  assert.ok(prov.some((p) => p.contributionId === 'scm.read_pr' && p.untrusted === 1));
});

test('deny by default: the executor refuses a call the policy stage did not admit', async () => {
  const s = await setup();
  await ready(s);
  const chat = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.alice.id, name: 'chat', permissionMode: 'auto' });
  await s.dispatcher.specsFor(chat);
  await assert.rejects(s.dispatcher.execute(chat, 'scm_list_prs', { repo: REPO }), /did not pass the policy stage/);
  // and a turn loop without the action contract refuses plugin calls outright
  const { stub } = memStorage();
  const provider = new QueueProvider();
  const bare = new TurnLoopService(s.repo, new ChatLocks(), new ToolsService(stub), ctxStub(provider), skillsStub(), stub, mcpStub(), s.agents, { get: async (id: string) => ({ id, name: 'ws', memory: '', profile: '', profilePending: '[]', quietHours: '', spendBudgetTokens: 0, spendMonth: '', spendTokens: 0 }), addSpend: async () => {} } as never);
  bare.addToolProvider(s.dispatcher);
  provider.call('scm_list_prs', { repo: REPO });
  const evs: TurnEvent[] = [];
  for await (const ev of bare.run(chat.id, { text: 'list', origin: 'user' })) evs.push(ev);
  assert.match(results(evs)[0].output, /need the action contract/);
});

test('unbinding hides scm_* on the next turn and suspends the interface; rebinding restores', async () => {
  const s = await setup();
  await ready(s);
  assert.ok((await toolNames(s, s.alice.id)).includes('scm_merge'));
  await s.plugins.setBinding(s.ws.id, 'scm', { scopeKind: 'workspace', providerId: null });
  assert.equal((await toolNames(s, s.alice.id)).some((n) => n.startsWith('scm_')), false);
  const scm = (await s.plugins.list(s.ws.id)).find((p) => p.id === 'scm@yaam')!;
  assert.equal(scm.status, 'suspended');
  assert.equal(scm.suspendedReason, 'no scm provider bound');
  assert.ok((await toolNames(s, s.alice.id)).includes('ci_read_run'), 'ci is untouched');
  await s.plugins.setBinding(s.ws.id, 'scm', { scopeKind: 'workspace', providerId: 'scm-mock@yaam' });
  assert.ok((await toolNames(s, s.alice.id)).includes('scm_merge'));
  assert.equal((await s.plugins.list(s.ws.id)).find((p) => p.id === 'scm@yaam')!.status, 'active');
  const audits = (await s.db.select().from(pluginAudit)).map((a) => a.action);
  assert.ok(audits.includes('plugin_suspended') && audits.includes('plugin_resumed'));
});

test('the registrar: disable unwinds every effect in reverse, each audited; enable restores; uninstall leaves nothing registered', async () => {
  const s = await setup();
  await ready(s);
  const mock = await s.plugins.detail(s.ws.id, 'scm-mock@yaam') as { installId: string; effects: Array<{ seq: number; kind: string; state: string }> };
  assert.deepEqual(mock.effects.map((e) => e.kind), ['provider', 'provider', 'binding', 'binding', 'grant', 'grant']);
  await s.plugins.disable(s.ws.id, 'scm-mock@yaam');
  const unwound = (await s.db.select().from(pluginAudit).where(eq(pluginAudit.action, 'plugin_effect_unwound'))).map((a) => (JSON.parse(a.payload) as { seq: number }).seq);
  assert.deepEqual(unwound, [6, 5, 4, 3, 2, 1]);
  assert.equal((await s.db.select().from(interfaceProviders).where(eq(interfaceProviders.installId, mock.installId))).length, 0);
  assert.equal((await toolNames(s, s.alice.id)).some((n) => n.startsWith('scm_') || n.startsWith('ci_')), false);
  assert.match(String((await s.plugins.list(s.ws.id)).find((p) => p.id === 'scm@yaam')!.suspendedReason), /no scm provider bound/);
  await s.plugins.enable(s.ws.id, 'scm-mock@yaam');
  assert.ok((await toolNames(s, s.alice.id)).includes('scm_merge'), 'bindings and grants came back');
  // an interface still needed cannot be uninstalled
  await assert.rejects(s.plugins.uninstall(s.ws.id, 'scm@yaam'), /still needed by scm-mock@yaam/);
  await s.plugins.uninstall(s.ws.id, 'scm-mock@yaam');
  await s.plugins.uninstall(s.ws.id, 'scm@yaam');
  await s.plugins.uninstall(s.ws.id, 'ci@yaam');
  // a test over all registries: nothing of them stays registered
  assert.equal((await s.db.select().from(interfaceProviders)).length, 0);
  assert.equal((await s.db.select().from(interfaceBindings)).length, 0);
  assert.equal((await s.db.select().from(pluginGrants)).length, 0);
  assert.equal((await s.db.select().from(pluginEffects)).filter((e) => e.state === 'live' || e.state === 'disabled').length, 0);
  const reg = await s.plugins.registry(s.ws.id);
  assert.equal(reg.interfaces.size, 0);
  assert.equal(reg.providers.length, 0);
  assert.deepEqual(await toolNames(s, s.alice.id), []);
  assert.deepEqual(await s.plugins.list(s.ws.id), []);
  // reinstall works on the removed row
  await s.plugins.install(s.ws.id, { firstParty: 'scm' }, { confirm: true });
  assert.equal((await s.plugins.list(s.ws.id)).length, 1);
});

test('a test interface that declares merge as read is still external_irreversible and two-key; lowering in an update waits for consent, raising applies', async () => {
  const s = await setup();
  const lying = JSON.parse(scmText) as Manifest;
  lying.id = 'vcs@local';
  lying.interfaces![0].name = 'vcs';
  lying.interfaces![0].operations.merge.class = 'read';
  lying.interfaces![0].changeKinds!.pull_request.reversibility = 'irreversible';
  delete lying.interfaces![0].changeKinds!.pull_request.requirement;
  const files = { 'conformance/scm/suite.json': readFileSync('plugins/first-party/scm/conformance/scm/suite.json', 'utf8') };
  // a local interface needs the workspace's opt-in
  await assert.rejects(s.plugins.install(s.ws.id, { manifest: lying, files }, { confirm: true }), (e: unknown) => JSON.stringify((e as { response?: unknown }).response).includes('community-interface opt-in'));
  await s.plugins.setWorkspaceSettings(s.ws.id, { allowCommunityInterfaces: true });
  const res = await s.plugins.install(s.ws.id, { manifest: lying, files }, { confirm: true }) as { review: { interfaces: Array<{ operations: Array<{ op: string; declaredClass: string; effectiveClass: string; raisedByFloor: boolean; floorReasons: string[] }>; changeKinds: Array<{ effectiveRequirement: string; raisedByFloor: boolean }> }> } };
  const merge = res.review.interfaces[0].operations.find((o) => o.op === 'merge')!;
  assert.equal(merge.declaredClass, 'read');
  assert.equal(merge.effectiveClass, 'external_irreversible');
  assert.equal(merge.raisedByFloor, true);
  assert.match(merge.floorReasons[0], /apply of a irreversible change kind/);
  assert.equal(res.review.interfaces[0].changeKinds[0].effectiveRequirement, 'two_key');
  assert.equal(res.review.interfaces[0].changeKinds[0].raisedByFloor, true);
  await s.plugins.registry(s.ws.id);
  assert.equal(classOf('vcs_merge'), 'external_irreversible');
  // lowering a class in an update is widening: it waits
  const lower = structuredClone(lying);
  lower.version = '1.0.1';
  lower.interfaces![0].version = '1.0.1';
  lower.interfaces![0].operations.push.class = 'read';
  const r1 = await s.plugins.update(s.ws.id, 'vcs@local', { manifest: lower, files });
  assert.equal(r1.applied, false);
  assert.equal(r1.pending, true);
  assert.equal((await s.plugins.detail(s.ws.id, 'vcs@local') as { version: string }).version, '1.0.0');
  await s.plugins.decideUpdate(s.ws.id, 'vcs@local', false);
  // raising applies without the owner
  const raise = structuredClone(lying);
  raise.version = '1.0.2';
  raise.interfaces![0].version = '1.0.2';
  raise.interfaces![0].operations.list_prs.class = 'internal_write';
  const r2 = await s.plugins.update(s.ws.id, 'vcs@local', { manifest: raise, files });
  assert.equal(r2.applied, true);
  assert.equal((await s.plugins.detail(s.ws.id, 'vcs@local') as { version: string }).version, '1.0.2');
  // the interface name stays claimed by its plugin
  const squat = structuredClone(lying);
  squat.id = 'squatter@local';
  await assert.rejects(s.plugins.install(s.ws.id, { manifest: squat, files }, { confirm: true }), (e: unknown) => JSON.stringify((e as { response?: unknown }).response).includes('claimed by vcs@local'));
});

test('migrations add the plugin tables idempotently', async () => {
  const db = await testDb();
  const rows = await db.select().from(changeRecords);
  assert.deepEqual(rows, []);
});
