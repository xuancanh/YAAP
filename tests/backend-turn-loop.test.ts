/** The tool-using turn loop and the Ask/Auto approval policy (§3–§4). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChatsRepository } from '../server/src/chats/chats.repository';
import { ChatsService } from '../server/src/chats/chats.service';
import { TurnLoopService, TurnEvent } from '../server/src/chats/turn-loop.service';
import { ChatLocks } from '../server/src/chats/chat-locks';
import { ToolsService } from '../server/src/chats/tools.service';
import { testDb, memStorage, ctxStub, skillsStub, agentsStub, mcpStub, ScriptedProvider } from './helpers';
import { AiStreamEvent } from '../server/src/ai/ai-provider.interface';

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
  const turns = new TurnLoopService(repo, new ChatLocks(), tools, ctxStub(provider), skillsStub(), stub, mcpStub(), agents);
  return { repo, chats, turns, provider, map, agents };
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
