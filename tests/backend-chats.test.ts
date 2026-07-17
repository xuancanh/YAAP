/**
 * Chat backend tests — services instantiated directly against PGlite
 * (in-memory Postgres) through the same Drizzle pg dialect and the same
 * migrator as production, so there is exactly one query path to test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChatsRepository } from '../server/src/chats/chats.repository';
import { ChatsService } from '../server/src/chats/chats.service';
import { TurnLoopService, TurnEvent } from '../server/src/chats/turn-loop.service';
import { ChatLocks } from '../server/src/chats/chat-locks';
import { ToolsService } from '../server/src/chats/tools.service';
import { EchoAiProvider } from '../server/src/ai/echo-ai.provider';
import { testDb, memStorage, ctxStub, skillsStub, agentsStub } from './helpers';

async function setup() {
  const repo = new ChatsRepository(await testDb());
  const chats = new ChatsService(repo, agentsStub());
  const storageStub = memStorage().stub;
  const tools = new ToolsService(storageStub);
  const turns = new TurnLoopService(repo, new ChatLocks(), tools, ctxStub(new EchoAiProvider()), skillsStub(), storageStub);
  return { repo, chats, turns };
}

async function collect(gen: AsyncGenerator<TurnEvent>): Promise<TurnEvent[]> {
  const events: TurnEvent[] = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

test('session CRUD, archive and restore', async () => {
  const { chats } = await setup();
  const s = await chats.create({ workspaceId: 'ws1', name: 'Hello' });
  assert.equal((await chats.list('ws1')).length, 1);
  assert.equal((await chats.list('ws2')).length, 0);

  await chats.archive(s.id);
  assert.equal((await chats.list('ws1')).length, 0);
  assert.equal((await chats.list('ws1', true)).length, 1);

  await chats.restore(s.id);
  assert.equal((await chats.list('ws1')).length, 1);

  const updated = await chats.update(s.id, { pinned: true, tags: ['work'], draft: 'wip' });
  assert.equal(updated.pinned, 1);
  assert.deepEqual(JSON.parse(updated.tags), ['work']);
  assert.equal(updated.draft, 'wip');

  await chats.remove(s.id);
  assert.equal((await chats.list('ws1')).length, 0);
});

test('a turn streams, persists transcript and accumulates usage', async () => {
  const { chats, turns, repo } = await setup();
  const s = await chats.create({ workspaceId: 'ws1' });

  const events = await collect(turns.run(s.id, { text: 'hello world' }));
  assert.ok(events.some((e) => e.type === 'turn'));
  assert.ok(events.some((e) => e.type === 'answer'));
  assert.ok(events.some((e) => e.type === 'done'));

  const messages = await repo.listMessages(s.id);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[1].role, 'assistant');
  assert.ok(messages[1].content.includes('hello world'));

  const [turn] = await repo.listTurns(s.id);
  assert.equal(turn.status, 'done');
  assert.ok(turn.tokensOut > 0);
  assert.ok((await chats.get(s.id)).tokensOut > 0);
});

test('token ceiling refuses the turn before any provider call (FR-2.6)', async () => {
  const { chats, turns } = await setup();
  const s = await chats.create({ workspaceId: 'ws1', tokenCeiling: 1 });
  await collect(turns.run(s.id, { text: 'first' }));
  await assert.rejects(collect(turns.run(s.id, { text: 'second' })), /token ceiling/);
});

test('provider history excludes tool and thinking rows (FR-8.1)', async () => {
  const { chats, repo } = await setup();
  const s = await chats.create({ workspaceId: 'ws1' });
  await repo.appendMessage({ sessionId: s.id, turnId: 't1', role: 'user', content: 'q' });
  await repo.appendMessage({ sessionId: s.id, turnId: 't1', role: 'thinking', content: 'hmm' });
  await repo.appendMessage({ sessionId: s.id, turnId: 't1', role: 'tool', content: 'result', toolName: 'read' });
  await repo.appendMessage({ sessionId: s.id, turnId: 't1', role: 'assistant', content: 'a' });
  const history = await repo.providerHistory(s.id, null);
  assert.deepEqual(history.map((m) => m.role), ['user', 'assistant']);
});

test('/clear wipes transcript and compaction state; /export renders markdown', async () => {
  const { chats, turns, repo } = await setup();
  const s = await chats.create({ workspaceId: 'ws1', name: 'Doc chat' });
  await collect(turns.run(s.id, { text: 'export me' }));

  const md = await chats.exportMarkdown(s.id);
  assert.ok(md.startsWith('# Doc chat'));
  assert.ok(md.includes('## User'));
  assert.ok(md.includes('export me'));

  await chats.clear(s.id);
  assert.equal((await repo.listMessages(s.id)).length, 0);
  assert.equal((await chats.get(s.id)).compactSummary, '');
});

test('stop aborts an in-flight turn and retains the partial (FR-5.4)', async () => {
  const { chats, turns, repo } = await setup();
  const s = await chats.create({ workspaceId: 'ws1' });
  const gen = turns.run(s.id, { text: 'one two three four five six seven eight nine ten' });
  const events: TurnEvent[] = [];
  for await (const ev of gen) {
    events.push(ev);
    if (events.filter((e) => e.type === 'answer').length === 2) turns.stop(s.id);
  }
  const [turn] = await repo.listTurns(s.id);
  assert.equal(turn.status, 'stopped');
  const messages = await repo.listMessages(s.id);
  assert.equal(messages.at(-1)?.role, 'assistant');
});

test('fork copies the transcript and leaves the original intact (FR-6.3)', async () => {
  const { chats, turns, repo } = await setup();
  const s = await chats.create({ workspaceId: 'ws1', name: 'Original' });
  await collect(turns.run(s.id, { text: 'first message' }));

  const forked = await chats.fork(s.id);
  assert.match(forked.name, /^Fork · Original/);
  assert.deepEqual(JSON.parse(forked.tags), ['fork']);
  assert.equal((await repo.listMessages(forked.id)).length, (await repo.listMessages(s.id)).length);
  assert.equal((await repo.listTurns(forked.id)).length, 1);
  // original untouched
  assert.equal((await chats.get(s.id)).name, 'Original');
});

test('truncateFrom drops a turn and everything after it (FR-6.1/6.2)', async () => {
  const { chats, turns, repo } = await setup();
  const s = await chats.create({ workspaceId: 'ws1' });
  await collect(turns.run(s.id, { text: 'keep me' }));
  await collect(turns.run(s.id, { text: 'edit me' }));

  const [, second] = await repo.listTurns(s.id);
  const res = await chats.truncateFrom(s.id, second.id);
  assert.equal(res.input, 'edit me');
  assert.equal((await repo.listTurns(s.id)).length, 1);
  const roles = (await repo.listMessages(s.id)).map((m) => m.role);
  assert.deepEqual(roles, ['user', 'assistant']);
});

test('auto-title is set from the first message of an unnamed chat (FR-1.3)', async () => {
  const { chats, turns } = await setup();
  const s = await chats.create({ workspaceId: 'ws1' });
  await collect(turns.run(s.id, { text: 'Where does draft text persist across restarts?' }));
  assert.equal((await chats.get(s.id)).autoTitle, 'Where does draft text persist across restarts?');
});
