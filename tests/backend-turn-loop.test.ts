/** The tool-using turn loop and the Ask/Auto approval policy (§3–§4). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChatsRepository } from '../server/src/chats/chats.repository';
import { ChatsService } from '../server/src/chats/chats.service';
import { TurnLoopService, TurnEvent } from '../server/src/chats/turn-loop.service';
import { ChatLocks } from '../server/src/chats/chat-locks';
import { ToolsService } from '../server/src/chats/tools.service';
import { testDb, memStorage, ctxStub, skillsStub, agentsStub, mcpStub, ScriptedProvider, wsStub } from './helpers';
import { AiStreamEvent } from '../server/src/ai/ai-provider.interface';
import { ConnectionsService } from '../server/src/connections/connections.service';
import { connections, connectionGrants } from '../server/src/database/schema';
import type { ConfigService } from '@nestjs/config';
import { seal } from '../server/src/common/secretbox';

const writeRound: AiStreamEvent[] = [
  { type: 'answer', text: 'Writing the file. ' },
  { type: 'tool_call', id: 'c1', name: 'fs_write', input: { path: 'notes.md', content: 'hello' } },
  { type: 'usage', inputTokens: 5, outputTokens: 5 },
  { type: 'done' },
];
const finalRound: AiStreamEvent[] = [
  { type: 'answer', text: 'Saved.' },
  { type: 'usage', inputTokens: 5, outputTokens: 2 },
  { type: 'done' },
];

async function setup(rounds: AiStreamEvent[][]) {
  const repo = new ChatsRepository(await testDb());
  const chats = new ChatsService(repo, agentsStub());
  const { stub, map } = memStorage();
  const tools = new ToolsService(stub);
  const provider = new ScriptedProvider(rounds);
  const agents = agentsStub();
  const ws = wsStub();
  const turns = new TurnLoopService(repo, new ChatLocks(), tools, ctxStub(provider), skillsStub(), stub, mcpStub(), agents, ws);
  return { repo, chats, turns, provider, map, agents, ws };
}

async function collect(gen: AsyncGenerator<TurnEvent>, onEvent?: (ev: TurnEvent) => void): Promise<TurnEvent[]> {
  const events: TurnEvent[] = [];
  for await (const ev of gen) { events.push(ev); onEvent?.(ev); }
  return events;
}

test('auto mode: tool executes between rounds and the loop continues', async () => {
  const { repo, chats, turns, provider, map } = await setup([writeRound, finalRound]);
  const s = await chats.create({ workspaceId: 'ws1' });
  await chats.update(s.id, { permissionMode: 'auto' });

  const events = await collect(turns.run(s.id, { text: 'write hello to notes.md' }));

  assert.ok(events.some((e) => e.type === 'tool_call'));
  const result = events.find((e) => e.type === 'tool_result');
  assert.ok(result && !result.isError);
  assert.ok(map.has('workspaces/ws1/notes.md'), 'tool actually wrote to storage');

  // second provider round saw the tool result in history
  const round2 = provider.requests[1];
  assert.ok(round2.messages.some((m) => m.role === 'tool' && m.toolCallId === 'c1'));

  const [turn] = await repo.listTurns(s.id);
  assert.equal(turn.status, 'done');
  const records = JSON.parse(turn.toolCalls) as Array<{ tool: string; approved: string }>;
  assert.equal(records.length, 1);
  assert.equal(records[0].approved, 'auto');

  const roles = (await repo.listMessages(s.id)).map((m) => m.role);
  assert.deepEqual(roles, ['user', 'assistant', 'tool', 'assistant']);
});

test('ask mode: read-only runs, mutation pauses; deny feeds an error result to the model (FR-4.2/4.3)', async () => {
  const readRound: AiStreamEvent[] = [
    { type: 'tool_call', id: 'r1', name: 'fs_list', input: {} },
    { type: 'done' },
  ];
  const { chats, turns, provider } = await setup([readRound, writeRound, finalRound]);
  const s = await chats.create({ workspaceId: 'ws1' });

  const events = await collect(turns.run(s.id, { text: 'go' }), (ev) => {
    if (ev.type === 'approval_required') {
      assert.equal(ev.tool, 'fs_write');
      turns.resolveApproval(s.id, ev.callId, 'deny');
    }
  });

  // fs_list ran without an approval pause
  const listResult = events.find((e) => e.type === 'tool_result' && e.name === 'fs_list');
  assert.ok(listResult && !listResult.isError);
  // fs_write was denied and surfaced as an error result
  const writeResult = events.find((e) => e.type === 'tool_result' && e.name === 'fs_write');
  assert.ok(writeResult?.isError);
  assert.match(writeResult!.output, /Denied by user/);
  // the model received the denial in the next round
  const lastReq = provider.requests.at(-1)!;
  assert.ok(lastReq.messages.some((m) => m.role === 'tool' && m.isError));
});

test('allow-always is remembered per chat and skips the next pause (FR-4.3/4.5)', async () => {
  const { chats, turns, repo } = await setup([writeRound, finalRound, writeRound, finalRound]);
  const s = await chats.create({ workspaceId: 'ws1' });

  let pauses = 0;
  await collect(turns.run(s.id, { text: 'first' }), (ev) => {
    if (ev.type === 'approval_required') { pauses++; turns.resolveApproval(s.id, ev.callId, 'allow-always'); }
  });
  assert.equal(pauses, 1);
  const approvals = JSON.parse((await chats.get(s.id)).approvals) as { exact: string[] };
  assert.equal(approvals.exact.length, 1);

  // identical call in a fresh turn: remembered, no pause
  await collect(turns.run(s.id, { text: 'again' }), (ev) => {
    if (ev.type === 'approval_required') pauses++;
  });
  assert.equal(pauses, 1);
  const [, turn2] = await repo.listTurns(s.id);
  const records = JSON.parse(turn2.toolCalls) as Array<{ approved: string }>;
  assert.equal(records[0].approved, 'remembered');
});

test('unknown tools are never executed (FR-3.4)', async () => {
  const badRound: AiStreamEvent[] = [
    { type: 'tool_call', id: 'x1', name: 'rm_rf_root', input: {} },
    { type: 'done' },
  ];
  const { chats, turns } = await setup([badRound, finalRound]);
  const s = await chats.create({ workspaceId: 'ws1' });
  await chats.update(s.id, { permissionMode: 'auto' });

  const events = await collect(turns.run(s.id, { text: 'go' }), (ev) => {
    // unknown tools still route through ask; deny closes the loop
    if (ev.type === 'approval_required') turns.resolveApproval(s.id, ev.callId, 'allow-once');
  });
  const result = events.find((e) => e.type === 'tool_result');
  assert.ok(result?.isError);
  assert.match(result!.output, /unknown tool/);
});

test('loop-origin turns queue connection mutations for approval instead of executing (M1)', async () => {
  const db = await testDb();
  const repo = new ChatsRepository(db);
  const { stub } = memStorage();
  const tools = new ToolsService(stub);
  const provider = new ScriptedProvider([
    [
      { type: 'tool_call', id: 'g1', name: 'gcal_create_event', input: { title: 'Renewal call', start: '2026-08-10' } },
      { type: 'done' },
    ],
    finalRound,
  ]);
  const agents = agentsStub();
  const connConfig = { get: (key: string) => ({ googleClientId: 'c', googleClientSecret: 's', publicBaseUrl: 'http://localhost:8790' })[key] } as unknown as ConfigService;
  const conns = new ConnectionsService(db, connConfig);
  conns.fetchImpl = (async () => { throw new Error('network must never be touched by a queued call'); }) as typeof fetch;
  await db.insert(connections).values({
    id: 'conn1', provider: 'google', accountEmail: 'u@example.com',
    scopes: '["https://www.googleapis.com/auth/calendar.readonly","https://www.googleapis.com/auth/calendar.events"]',
    accessToken: seal('t'), refreshToken: seal('r'),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(), createdAt: new Date().toISOString(),
  });
  await db.insert(connectionGrants).values({ id: 'g1', connectionId: 'conn1', agentId: 'ag1', level: 'write', createdAt: new Date().toISOString() });

  const turns = new TurnLoopService(repo, new ChatLocks(), tools, ctxStub(provider), skillsStub(), stub, mcpStub(), agents, wsStub(), conns);
  const s = await repo.createSession({ workspaceId: 'ws1', agentId: 'ag1', name: 'Loop · renewals', permissionMode: 'auto' });

  const events = await collect(turns.run(s.id, { text: 'check renewals', origin: 'loop' }));

  // even in Auto mode, the mutation did not execute — it queued
  const result = events.find((e) => e.type === 'tool_result');
  assert.ok(result && !result.isError);
  assert.match(result!.output, /Queued for the user's approval/);
  const evCall = agents.calls.find((c) => c.method === 'addEvent');
  assert.ok(evCall, 'an inbox event was created');
  const evInput = evCall!.args[1] as { kind: string; payload: string };
  assert.equal(evInput.kind, 'action_pending');
  assert.deepEqual(JSON.parse(evInput.payload), { tool: 'gcal_create_event', input: { title: 'Renewal call', start: '2026-08-10' } });
  const [turn] = await repo.listTurns(s.id);
  const records = JSON.parse(turn.toolCalls) as Array<{ approved: string }>;
  assert.equal(records[0].approved, 'queued');

  // the same call in a user-originated Auto turn executes for real
  let hit = '';
  conns.fetchImpl = (async (url: RequestInfo | URL) => {
    hit = String(url);
    return { ok: true, status: 200, json: async () => ({ id: 'e1', summary: 'Renewal call', start: { date: '2026-08-10' }, end: { date: '2026-08-10' } }), text: async () => '' } as unknown as Response;
  }) as typeof fetch;
  const provider2 = new ScriptedProvider([
    [
      { type: 'tool_call', id: 'g2', name: 'gcal_create_event', input: { title: 'Renewal call', start: '2026-08-10' } },
      { type: 'done' },
    ],
    finalRound,
  ]);
  const turns2 = new TurnLoopService(repo, new ChatLocks(), tools, ctxStub(provider2), skillsStub(), stub, mcpStub(), agents, wsStub(), conns);
  const events2 = await collect(turns2.run(s.id, { text: 'yes, book it' }));
  const result2 = events2.find((e) => e.type === 'tool_result');
  assert.ok(result2 && !result2.isError);
  assert.match(result2!.output, /Event created/);
  assert.match(hit, /calendars\/primary\/events/);
});

test('gmail_send pauses even in Auto mode and allow-always is never remembered (M2)', async () => {
  const db = await testDb();
  const repo = new ChatsRepository(db);
  const { stub } = memStorage();
  const tools = new ToolsService(stub);
  const agents = agentsStub();
  const connConfig = { get: (key: string) => ({ googleClientId: 'c', googleClientSecret: 's', publicBaseUrl: 'http://localhost:8790' })[key] } as unknown as ConfigService;
  const conns = new ConnectionsService(db, connConfig);
  await db.insert(connections).values({
    id: 'conn1', provider: 'google', accountEmail: 'u@example.com',
    scopes: '["https://www.googleapis.com/auth/gmail.compose"]',
    accessToken: seal('t'), refreshToken: seal('r'),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(), createdAt: new Date().toISOString(),
  });
  await db.insert(connectionGrants).values({ id: 'g1', connectionId: 'conn1', agentId: 'ag1', service: 'gmail', level: 'write', createdAt: new Date().toISOString() });
  let sends = 0;
  conns.fetchImpl = (async () => {
    sends++;
    return { ok: true, status: 200, json: async () => ({ id: 'm1' }), text: async () => '' } as unknown as Response;
  }) as typeof fetch;

  const sendRound: AiStreamEvent[] = [
    { type: 'tool_call', id: 's1', name: 'gmail_send', input: { to: 'a@b.co', subject: 'Go', body: 'now' } },
    { type: 'done' },
  ];
  const s = await repo.createSession({ workspaceId: 'ws1', agentId: 'ag1', name: 'chat', permissionMode: 'auto' });

  const turns1 = new TurnLoopService(repo, new ChatLocks(), tools, ctxStub(new ScriptedProvider([sendRound, finalRound])), skillsStub(), stub, mcpStub(), agents, wsStub(), conns);
  let pauses = 0;
  await collect(turns1.run(s.id, { text: 'send it' }), (ev) => {
    if (ev.type === 'approval_required') { pauses++; assert.equal(ev.tool, 'gmail_send'); turns1.resolveApproval(s.id, ev.callId, 'allow-always'); }
  });
  assert.equal(pauses, 1, 'auto mode still paused for gmail_send');
  assert.equal(sends, 1, 'approved send executed');
  // allow-always was NOT remembered for a confirm-always tool
  const approvals = JSON.parse((await repo.getSession(s.id))!.approvals || '{}') as { exact?: string[]; tools?: string[] };
  assert.equal(approvals.exact?.length ?? 0, 0);
  assert.equal(approvals.tools?.length ?? 0, 0);

  // an identical call in a fresh turn pauses again
  const turns2 = new TurnLoopService(repo, new ChatLocks(), tools, ctxStub(new ScriptedProvider([sendRound, finalRound])), skillsStub(), stub, mcpStub(), agents, wsStub(), conns);
  await collect(turns2.run(s.id, { text: 'again' }), (ev) => {
    if (ev.type === 'approval_required') { pauses++; turns2.resolveApproval(s.id, ev.callId, 'deny'); }
  });
  assert.equal(pauses, 2);
  assert.equal(sends, 1, 'denied send did not execute');
});

test('concurrent turn on the same chat is refused by the busy lock (FR-7.5)', async () => {
  const { chats, turns } = await setup([writeRound, finalRound]);
  const s = await chats.create({ workspaceId: 'ws1' });

  const gen = turns.run(s.id, { text: 'slow' });
  await gen.next(); // start the turn: lock is held
  await assert.rejects(collect(turns.run(s.id, { text: 'second' })), /busy/);
  turns.stop(s.id);
  await collect(gen);
});

test('agent chats offer self-maintenance tools; save_app gates in ask mode and is never blanket-allowed (§11)', async () => {
  const appRound: AiStreamEvent[] = [
    { type: 'tool_call', id: 'a1', name: 'save_app', input: { name: 'Tracker', html: '<html>x</html>' } },
    { type: 'done' },
  ];
  const { chats, turns, provider, agents } = await setup([appRound, finalRound]);
  const s = await chats.create({ workspaceId: 'ws1', agentId: 'ag1' });

  let paused = 0;
  await collect(turns.run(s.id, { text: 'build me a tracker' }), (ev) => {
    if (ev.type === 'approval_required') {
      paused++;
      assert.equal(ev.tool, 'save_app');
      turns.resolveApproval(s.id, ev.callId, 'allow-tool');
    }
  });

  assert.equal(paused, 1, 'save_app paused for approval in ask mode');
  const toolNames = (provider.requests[0].tools ?? []).map((t) => t.name);
  assert.ok(toolNames.includes('save_app') && toolNames.includes('update_dashboard'));
  assert.deepEqual(agents.calls.map((c) => c.method), ['saveApp']);
  assert.equal(agents.calls[0].args[0], 'ag1');
  // SELF_MOD tools never receive a blanket allow-tool grant (FR-4.5)
  const approvals = JSON.parse((await chats.get(s.id)).approvals) as { tools?: string[] };
  assert.ok(!(approvals.tools ?? []).includes('save_app'));
});

test('agent tools are absent from chats without a durable agent (§11)', async () => {
  const { chats, turns, provider } = await setup([finalRound]);
  const s = await chats.create({ workspaceId: 'ws1' });
  await collect(turns.run(s.id, { text: 'hello' }));
  const toolNames = (provider.requests[0].tools ?? []).map((t) => t.name);
  assert.ok(!toolNames.includes('save_app') && !toolNames.includes('update_dashboard'));
});

test('image attachments become vision parts on the user message (FR-2.2)', async () => {
  const { chats, turns, provider, map } = await setup([finalRound]);
  map.set('workspaces/ws1/uploads/shot.png', Buffer.from([137, 80, 78, 71, 0, 1, 2]));
  map.set('workspaces/ws1/notes.md', Buffer.from('plain text note'));
  const s = await chats.create({ workspaceId: 'ws1' });

  await collect(turns.run(s.id, {
    text: 'look at this',
    attachments: [{ path: 'uploads/shot.png', kind: 'image' }, { path: 'notes.md', kind: 'text' }],
  }));

  const lastUser = provider.requests[0].messages.filter((m) => m.role === 'user').at(-1)!;
  assert.equal(lastUser.images?.length, 1);
  assert.equal(lastUser.images![0].mediaType, 'image/png');
  assert.match(lastUser.content, /plain text note/);
});

test('recall + profile tools: search_history and update_user_profile auto-run in ask mode (phase 1)', async () => {
  const round: AiStreamEvent[] = [
    { type: 'tool_call', id: 'h1', name: 'search_history', input: { query: 'staging keys' } },
    { type: 'tool_call', id: 'p1', name: 'update_user_profile', input: { entry: 'Prefers Friday deploys.' } },
    { type: 'done' },
  ];
  const { chats, turns, ws, repo } = await setup([round, finalRound]);
  const s = await chats.create({ workspaceId: 'ws1', agentId: 'ag1' });
  const old = await repo.createSession({ workspaceId: 'ws1', agentId: 'ag1', name: 'earlier' });
  await repo.appendMessage({ sessionId: old.id, turnId: 't0', role: 'assistant', content: 'the staging keys rotate on Friday' });

  const events = await collect(turns.run(s.id, { text: 'when do we rotate?' }));
  assert.ok(!events.some((e) => e.type === 'approval_required'), 'both tools auto-ran in ask mode');
  const search = events.find((e) => e.type === 'tool_result' && e.name === 'search_history');
  assert.ok(search && !search.isError);
  assert.match(search.output, /staging keys rotate on Friday/);
  const profile = events.find((e) => e.type === 'tool_result' && e.name === 'update_user_profile');
  assert.ok(profile && !profile.isError);
  assert.match(profile.output, /review/);
  assert.equal((ws.proposals[0] as { entry: string }).entry, 'Prefers Friday deploys.');
});
