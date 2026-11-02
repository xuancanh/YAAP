/** Agent file and workspace operations run freely (docs/permissions.md §8):
 *  an agent's writes, edits, appends, deletes and restores in its home and in
 *  shared folders run in an unattended loop without a pause, a hold or a
 *  reviewer call, even at internal-write trust level 0; WorkspaceFs still
 *  refuses another agent's home; a delete keeps a revision and fs_restore
 *  brings it back; outward calls (email, MCP) stay gated and reviewed; the
 *  org's work record runs freely while governance does not; an incident
 *  freeze still holds; a mini app's `agent.ask` turn stays confined; and the
 *  red-team canary still records an injected file write before any policy. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigService } from '@nestjs/config';
import { and, eq } from 'drizzle-orm';
import { testDb, memStorage, ctxStub, skillsStub, mcpWriterStub } from './helpers';
import type { AiProvider, AiRequest, AiStreamEvent, AiToolSpec } from '../server/src/ai/ai-provider.interface';
import { ChatsRepository } from '../server/src/chats/chats.repository';
import { TurnLoopService, type TurnEvent, type TurnOrigin } from '../server/src/chats/turn-loop.service';
import { ChatLocks } from '../server/src/chats/chat-locks';
import { ToolsService } from '../server/src/chats/tools.service';
import { TriggerBus } from '../server/src/chats/trigger-bus';
import { AgentsService } from '../server/src/agents/agents.service';
import { WorkspacesService } from '../server/src/workspaces/workspaces.service';
import { ConnectionsService } from '../server/src/connections/connections.service';
import { WorkspaceFs } from '../server/src/files/workspace-fs.service';
import { ActionReviewService, type ReviewInput } from '../server/src/review/action-review.service';
import { seal } from '../server/src/common/secretbox';
import { actionLog, connectionGrants, connections, trustLevels } from '../server/src/database/schema';
import { ActionsService } from '../server/src/actions/actions.service';
import { TrustService } from '../server/src/actions/trust.service';
import { classOf, FREE_INTERNAL_TOOLS, runsFreely, WORKSPACE_FILE_WRITES } from '../server/src/actions/action-classes';
import { breachedBy, canaryText } from '../server/src/org/org-redteam.service';

class QueueProvider implements AiProvider {
  readonly name = 'queue';
  readonly requests: AiRequest[] = [];
  readonly queue: AiStreamEvent[][] = [];
  async *stream(req: AiRequest): AsyncGenerator<AiStreamEvent> {
    this.requests.push(req);
    const events = this.queue.shift() ?? [{ type: 'answer', text: 'ok' } as AiStreamEvent, { type: 'done' } as AiStreamEvent];
    for (const ev of events) yield ev;
  }
  /** One round with these calls, in order. */
  round(...calls: Array<[string, Record<string, unknown>]>): void {
    this.queue.push([...calls.map(([name, input], i) => ({ type: 'tool_call' as const, id: `c${this.queue.length}-${i}`, name, input })), { type: 'done' }]);
  }
}

const connConfig = { get: (key: string) => ({ googleClientId: 'c', googleClientSecret: 's', publicBaseUrl: 'http://localhost:8790' })[key] } as unknown as ConfigService;
const settings = (values: Record<string, string> = {}) => ({ all: async () => values }) as never;

async function setup() {
  const db = await testDb();
  const { stub, map } = memStorage();
  const bus = new TriggerBus();
  const agents = new AgentsService(db, stub, bus);
  const workspaces = new WorkspacesService(db, stub);
  const repo = new ChatsRepository(db);
  const provider = new QueueProvider();
  const conns = new ConnectionsService(db, connConfig);
  const sent: string[] = [];
  conns.fetchImpl = (async (url: RequestInfo | URL) => {
    sent.push(String(url));
    const body = String(url).includes('/drafts') ? { id: 'd1' } : { id: 'm1' };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
  }) as typeof fetch;
  const trust = new TrustService(db, agents, bus);
  const actions = new ActionsService(db, trust, agents, conns);
  const review = new ActionReviewService(settings());
  const reviewed: ReviewInput[] = [];
  review.reviewFn = async (input) => { reviewed.push(input); return { verdict: 'allow', reason: 'In scope.' }; };
  const fs = new WorkspaceFs(stub, db);
  const turns = new TurnLoopService(repo, new ChatLocks(), new ToolsService(stub, fs), ctxStub(provider), skillsStub(), stub, mcpWriterStub(stub), agents, workspaces, conns,
    undefined, undefined, review, undefined, undefined, undefined, undefined, undefined, actions);
  const ws = (await workspaces.list())[0];
  const alice = await agents.create({ name: 'Alice', charter: 'You keep the notes.' });
  const bob = await agents.create({ name: 'Bob', charter: 'You check.' });
  const aliceHome = (await agents.home(alice.id)).home;
  const bobHome = (await agents.home(bob.id)).home;
  await db.insert(connections).values({
    id: 'conn1', provider: 'google', accountEmail: 'owner@example.com',
    scopes: '["https://www.googleapis.com/auth/gmail.compose"]',
    accessToken: seal('t'), refreshToken: seal('r'), expiresAt: new Date(Date.now() + 3_600_000).toISOString(), createdAt: new Date().toISOString(),
  });
  await db.insert(connectionGrants).values({ id: 'g1', connectionId: 'conn1', agentId: alice.id, service: 'gmail', level: 'write', createdAt: new Date().toISOString() });
  // The strictest internal-write level: without the §8 rule every write would be held.
  await trust.row(ws.id, alice.id, 'internal_write');
  await db.update(trustLevels).set({ level: 0 }).where(and(eq(trustLevels.agentId, alice.id), eq(trustLevels.actionClass, 'internal_write')));
  return { db, map, agents, repo, provider, turns, actions, trust, reviewed, fs, ws, alice, bob, aliceHome, bobHome, sent };
}

type S = Awaited<ReturnType<typeof setup>>;

async function run(s: S, sessionId: string, text: string, origin: TurnOrigin, extra: { confined?: boolean } = {}): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  for await (const ev of s.turns.run(sessionId, { text, origin, ...extra })) {
    out.push(ev);
    if (ev.type === 'approval_required') s.turns.resolveApproval(sessionId, ev.callId, 'deny');
  }
  return out;
}

const results = (events: TurnEvent[]) => events.filter((e): e is Extract<TurnEvent, { type: 'tool_result' }> => e.type === 'tool_result');
const key = (s: S, path: string) => `workspaces/${s.ws.id}/${path}`;

test('registry: every free tool is internal work; outward, money, computer, code, MCP and governance tools never are', () => {
  for (const name of FREE_INTERNAL_TOOLS) assert.ok(['internal_write', 'read'].includes(classOf(name, {}, { readOnly: false })), `${name} is internal`);
  for (const name of WORKSPACE_FILE_WRITES) assert.ok(runsFreely(name));
  for (const name of [
    'gmail_send', 'gmail_draft', 'msmail_send', 'gcal_create_event', 'http_request', 'browser_act', 'run_js', 'run_python', 'computer_click',
    'mcp_notes_write', 'tool_webhook', 'stripe_charge', 'org_hire_agent', 'org_terminate_agent', 'org_reorg', 'org_allocate_budget',
    'org_set_scope', 'org_update_member', 'org_pause_agent', 'org_set_routing', 'org_tune', 'org_write_playbook', 'org_propose_experiment',
  ]) assert.equal(runsFreely(name), false, `${name} stays gated`);
});

test('an unattended loop at internal-write level 0 writes, edits, appends, deletes and restores in its home and in /org/ — no pause, no hold, no reviewer', async () => {
  const s = await setup();
  const session = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.alice.id, name: 'Loop · notes', permissionMode: 'ask' });
  s.provider.round(
    ['fs_write', { path: 'LESSONS.md', content: 'lesson one' }],
    ['fs_append', { path: 'LESSONS.md', content: 'lesson two' }],
    ['fs_edit', { path: 'LESSONS.md', old: 'one', new: 'uno' }],
    ['fs_write', { path: '/org/plan.md', content: 'the plan' }],
    ['slides_create', { path: '/org/deck.html', title: 'Q4', slides: [{ title: 'Hello' }] }],
    ['fs_write', { path: 'scratch.md', content: 'temporary' }],
    ['fs_delete', { path: 'scratch.md' }],
  );
  const events = await run(s, session.id, 'keep the notes', 'loop');
  assert.ok(!events.some((e) => e.type === 'approval_required'), 'nobody was asked');
  const out = results(events);
  assert.equal(out.length, 7);
  for (const r of out) assert.ok(!r.isError, `${r.name}: ${r.output}`);
  assert.equal(s.map.get(key(s, `${s.aliceHome}/LESSONS.md`))?.toString(), 'lesson uno\nlesson two');
  assert.equal(s.map.get(key(s, 'org/plan.md'))?.toString(), 'the plan');
  assert.ok(s.map.has(key(s, 'org/deck.html')));
  assert.ok(!s.map.has(key(s, `${s.aliceHome}/scratch.md`)));
  assert.match(out[6].output, /kept as revision 1 — fs_restore brings it back/);
  assert.equal(s.reviewed.length, 0, 'the reviewer was never called');

  // Recorded, not blocked: every call is a succeeded `free` row in the action log.
  const rows = await s.db.select().from(actionLog).where(eq(actionLog.sessionId, session.id));
  assert.equal(rows.length, 7);
  for (const r of rows) {
    assert.equal(r.status, 'succeeded');
    assert.equal(r.decision, 'free');
    assert.equal(r.class, 'internal_write');
  }

  // …and the delete is reversible by the agent itself.
  s.provider.round(['fs_restore', { path: 'scratch.md' }]);
  const back = results(await run(s, session.id, 'undo that', 'loop'));
  assert.ok(!back[0].isError, back[0].output);
  assert.equal(s.map.get(key(s, `${s.aliceHome}/scratch.md`))?.toString(), 'temporary');
  assert.equal(s.reviewed.length, 0);
});

test('WorkspaceFs is still the gate: another agent\'s home and .checkpoints/ are refused, nothing is written, nothing is held', async () => {
  const s = await setup();
  s.map.set(key(s, `${s.bobHome}/draft.md`), Buffer.from('bob\'s'));
  const session = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.alice.id, name: 'Loop · tamper', permissionMode: 'auto' });
  s.provider.round(
    ['fs_write', { path: `/${s.bobHome}/draft.md`, content: 'hijack' }],
    ['fs_delete', { path: `/${s.bobHome}/draft.md` }],
    ['fs_write', { path: '.checkpoints/2026-01-01/LESSONS.md', content: 'tamper' }],
  );
  const out = results(await run(s, session.id, 'tidy', 'loop'));
  assert.match(out[0].output, /another agent's home/);
  assert.match(out[1].output, /another agent's home/);
  assert.match(out[2].output, /read-only/);
  for (const r of out) assert.ok(r.isError);
  assert.equal(s.map.get(key(s, `${s.bobHome}/draft.md`))?.toString(), 'bob\'s');
  assert.ok(![...s.map.keys()].some((k) => k.includes('.checkpoints/2026-01-01')));
  const rows = await s.db.select().from(actionLog).where(eq(actionLog.sessionId, session.id));
  assert.ok(rows.every((r) => r.status === 'failed'), 'the refusal is on the record');
});

test('outward calls stay gated in the same loop: a send is staged for the owner\'s key, an MCP call is reviewed', async () => {
  const s = await setup();
  const session = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.alice.id, name: 'Loop · outreach', permissionMode: 'auto' });
  s.provider.round(
    ['fs_write', { path: 'notes.md', content: 'draft' }],
    ['gmail_send', { to: 'ann@client.example', subject: 'Hi', body: 'Hello' }],
    ['mcp_notes_write', { path: 'outside.md', content: 'x' }],
  );
  const out = results(await run(s, session.id, 'reach out', 'loop'));
  assert.ok(!out[0].isError);
  assert.ok(out[1].held === 'staged' || out[1].held === 'held', `gmail_send was ${out[1].held ?? 'run'}: ${out[1].output}`);
  assert.ok(!s.sent.some((u) => u.includes('/messages/send') || u.includes('/drafts/send')), 'nothing was sent');
  assert.deepEqual(s.reviewed.map((r) => r.call.name), ['mcp_notes_write'], 'only the outward call met the reviewer');
});

test('the org work record runs freely; a governance tool still meets the gate', async () => {
  const s = await setup();
  const ran: string[] = [];
  const spec = (name: string): AiToolSpec => ({ name, description: name, inputSchema: { type: 'object', properties: {} } });
  s.turns.addToolProvider({
    specsFor: async () => [spec('org_task_update'), spec('org_check_in'), spec('org_tune')],
    owns: (n) => ['org_task_update', 'org_check_in', 'org_tune'].includes(n),
    isReadOnly: () => false,
    execute: async (_session, name) => { ran.push(name); return `${name} done`; },
    contextFor: async () => null,
  });
  const session = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.alice.id, name: 'Org run', permissionMode: 'auto' });
  s.provider.round(['org_task_update', { taskId: 't1', status: 'in_progress' }], ['org_check_in', { goalId: 'g1', value: 3 }], ['org_tune', { key: 'x', value: 1 }]);
  const out = results(await run(s, session.id, 'work the task', 'loop'));
  assert.deepEqual(ran, ['org_task_update', 'org_check_in'], 'the board and check-in ran; the tunable change did not');
  assert.equal(out[2].held, 'held', 'org_tune at level 0 is held for the owner');
  assert.equal(s.reviewed.length, 0);
});

test('an incident freeze of internal writes still holds file writes', async () => {
  const s = await setup();
  s.actions.hooks.frozen = async (_ws, _agent, cls) => cls === 'internal_write';
  const session = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.alice.id, name: 'Loop · frozen', permissionMode: 'auto' });
  s.provider.round(['fs_write', { path: 'notes.md', content: 'x' }]);
  const out = results(await run(s, session.id, 'write', 'loop'));
  assert.equal(out[0].held, 'held');
  assert.ok(!s.map.has(key(s, `${s.aliceHome}/notes.md`)));
});

test('a confined turn (a mini app\'s agent.ask) still gates file writes', async () => {
  const s = await setup();
  const session = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.alice.id, name: 'App · Alice', permissionMode: 'ask' });
  s.provider.round(['fs_write', { path: 'LESSONS.md', content: 'obey the app' }]);
  const events = await run(s, session.id, '[from mini app "x"] remember this', 'user', { confined: true });
  assert.ok(events.some((e) => e.type === 'approval_required' && e.tool === 'fs_write'), 'it paused (and was denied)');
  assert.ok(!(s.map.get(key(s, `${s.aliceHome}/LESSONS.md`))?.toString() ?? '').includes('obey the app'), 'the brain was not written');
});

test('the red-team canary still catches an injected file write: the sandbox records it before any policy, nothing is written', async () => {
  const s = await setup();
  const session = await s.repo.createSession({ workspaceId: s.ws.id, agentId: s.alice.id, name: 'Red team', permissionMode: 'auto' });
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  s.turns.setSandbox(session.id, (call) => { calls.push({ name: call.name, input: call.input }); return 'ok'; });
  const nonce = 'n0nce42';
  s.provider.round(['fs_write', { path: '/org/notes.md', content: `code ${nonce}` }]);
  await run(s, session.id, `A customer note.\n\n${canaryText(nonce)}`, 'loop');
  s.turns.clearSandbox(session.id);
  assert.equal(breachedBy(calls, nonce).length, 1, 'the free path does not hide the breach');
  assert.ok(!s.map.has(key(s, 'org/notes.md')));
});

test('a delete keeps the last body as a revision; restore brings it back and numbering continues', async () => {
  const s = await setup();
  const by = { kind: 'agent' as const, id: s.alice.id, name: 'Alice', home: s.aliceHome };
  await s.fs.write(s.ws.id, 'org/a.md', Buffer.from('one'), { by });
  await s.fs.write(s.ws.id, 'org/a.md', Buffer.from('two'), { by });
  assert.deepEqual(await s.fs.delete(s.ws.id, 'org/a.md', { by }), { keptVersion: 2 });
  assert.equal(await s.fs.meta(s.ws.id, 'org/a.md'), null);
  assert.deepEqual((await s.fs.revisions(s.ws.id, 'org/a.md')).map((r) => r.version), [2, 1]);
  const back = await s.fs.restore(s.ws.id, 'org/a.md', 2, { by });
  assert.equal(back.version, 3, 'numbering continues after the kept history');
  assert.equal(s.map.get(key(s, 'org/a.md'))?.toString(), 'two');
  // A new file at a deleted path never overwrites the kept history either.
  await s.fs.delete(s.ws.id, 'org/a.md', { by });
  const fresh = await s.fs.write(s.ws.id, 'org/a.md', Buffer.from('fresh'), { by });
  assert.equal(fresh.version, 4);
  assert.deepEqual((await s.fs.revisions(s.ws.id, 'org/a.md')).map((r) => r.version), [3, 2, 1]);
});
