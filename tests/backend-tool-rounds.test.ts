/** Tool rounds per turn (docs/architecture.md "Ceilings and stops"): no cap
 *  by default — a long task keeps calling tools until it answers; the loop
 *  breaker, budgets and Stop end a runaway turn. MAX_TOOL_ROUNDS > 0 is an
 *  operator's optional hard cap. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentsService } from '../server/src/agents/agents.service';
import { WorkspacesService } from '../server/src/workspaces/workspaces.service';
import { ChatsRepository } from '../server/src/chats/chats.repository';
import { TurnLoopService } from '../server/src/chats/turn-loop.service';
import type { TurnEvent } from '../server/src/chats/turn-loop.service';
import { ChatLocks } from '../server/src/chats/chat-locks';
import { ToolsService } from '../server/src/chats/tools.service';
import type { AiStreamEvent } from '../server/src/ai/ai-provider.interface';
import * as configModule from '../server/src/config/configuration';
import { testDb, memStorage, ctxStub, skillsStub, mcpStub, ScriptedProvider } from './helpers';

/** `n` rounds of a different read each (no repeat for the breaker), then an answer. */
const script = (n: number): AiStreamEvent[][] => [
  ...Array.from({ length: n }, (_, i): AiStreamEvent[] => [{ type: 'tool_call', id: `c${i}`, name: 'fs_list', input: { path: `notes/${i}` } }, { type: 'done' }]),
  [{ type: 'answer', text: 'All done.' }, { type: 'done' }],
];

async function run(rounds: number, maxToolRounds: number) {
  const db = await testDb();
  const { stub } = memStorage();
  const agents = new AgentsService(db, stub);
  const workspaces = new WorkspacesService(db, stub);
  const repo = new ChatsRepository(db);
  const provider = new ScriptedProvider(script(rounds));
  const turns = new TurnLoopService(repo, new ChatLocks(), new ToolsService(stub), ctxStub(provider, { maxToolRounds }), skillsStub(), stub, mcpStub(), agents, workspaces);
  const ws = (await workspaces.list())[0];
  const a = await agents.create({ name: 'Worker', workspaceId: ws.id });
  const session = await repo.createSession({ workspaceId: ws.id, agentId: a.id, name: 'Long task', kind: 'chat' });
  const evs: TurnEvent[] = [];
  for await (const ev of turns.run(session.id, { text: 'go through every folder' })) evs.push(ev);
  return { evs, provider };
}

// The module's default export is the config factory (CJS interop may wrap it once more).
const configuration = (typeof configModule.default === 'function' ? configModule.default : (configModule.default as unknown as { default: typeof configModule.default }).default);

test('the default is no cap on tool rounds', () => {
  const before = process.env.MAX_TOOL_ROUNDS;
  delete process.env.MAX_TOOL_ROUNDS;
  try { assert.equal(configuration().maxToolRounds, 0); } finally { if (before !== undefined) process.env.MAX_TOOL_ROUNDS = before; }
});

test('with no cap a turn runs past the old 24 rounds and finishes with its answer', async () => {
  const { evs, provider } = await run(40, 0);
  assert.equal(evs.filter((e) => e.type === 'tool_result').length, 40);
  assert.equal(evs.some((e) => e.type === 'error'), false);
  assert.ok(evs.some((e) => e.type === 'answer' && e.text.includes('All done.')));
  assert.equal(provider.requests.length, 41);
});

test('an operator cap still stops the turn with the limit error', async () => {
  const { evs } = await run(10, 3);
  assert.equal(evs.filter((e) => e.type === 'tool_result').length, 3);
  assert.ok(evs.some((e) => e.type === 'error' && /tool round limit \(3\) reached/.test(e.message)));
});
