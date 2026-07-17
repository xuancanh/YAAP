/**
 * Chat backend tests — services instantiated directly against an in-memory
 * SQLite database (no Nest bootstrap), matching the reference app's fast
 * backend-test style.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../server/src/database/schema';
import { runSqliteMigrations } from '../server/src/database/migrator';
import { ChatsRepository } from '../server/src/chats/chats.repository';
import { ChatsService } from '../server/src/chats/chats.service';
import { TurnLoopService, TurnEvent } from '../server/src/chats/turn-loop.service';
import { EchoAiProvider } from '../server/src/ai/echo-ai.provider';

function setup() {
  const sqlite = new Database(':memory:');
  runSqliteMigrations(sqlite, { log: () => {} });
  const db = drizzle(sqlite, { schema });
  const repo = new ChatsRepository(db);
  const chats = new ChatsService(repo);
  const turns = new TurnLoopService(repo, new EchoAiProvider());
  return { repo, chats, turns };
}

async function collect(gen: AsyncGenerator<TurnEvent>): Promise<TurnEvent[]> {
  const events: TurnEvent[] = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

test('session CRUD, archive and restore', () => {
  const { chats } = setup();
  const s = chats.create({ workspaceId: 'ws1', name: 'Hello' });
  assert.equal(chats.list('ws1').length, 1);
  assert.equal(chats.list('ws2').length, 0);

  chats.archive(s.id);
  assert.equal(chats.list('ws1').length, 0);
  assert.equal(chats.list('ws1', true).length, 1);

  chats.restore(s.id);
  assert.equal(chats.list('ws1').length, 1);

  const updated = chats.update(s.id, { pinned: true, tags: ['work'], draft: 'wip' });
  assert.equal(updated.pinned, 1);
  assert.deepEqual(JSON.parse(updated.tags), ['work']);
  assert.equal(updated.draft, 'wip');

  chats.remove(s.id);
  assert.equal(chats.list('ws1').length, 0);
});

test('a turn streams, persists transcript and accumulates usage', async () => {
  const { chats, turns, repo } = setup();
  const s = chats.create({ workspaceId: 'ws1' });

  const events = await collect(turns.run(s.id, { text: 'hello world' }));
  assert.ok(events.some((e) => e.type === 'turn'));
  assert.ok(events.some((e) => e.type === 'answer'));
  assert.ok(events.some((e) => e.type === 'done'));

  const messages = repo.listMessages(s.id);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[1].role, 'assistant');
  assert.ok(messages[1].content.includes('hello world'));

  const [turn] = repo.listTurns(s.id);
  assert.equal(turn.status, 'done');
  assert.ok(turn.tokensOut > 0);
  assert.ok(chats.get(s.id).tokensOut > 0);
});

test('token ceiling refuses the turn before any provider call (FR-2.6)', async () => {
  const { chats, turns } = setup();
  const s = chats.create({ workspaceId: 'ws1', tokenCeiling: 1 });
  await collect(turns.run(s.id, { text: 'first' }));
  await assert.rejects(collect(turns.run(s.id, { text: 'second' })), /token ceiling/);
});

test('provider history excludes tool and thinking rows (FR-8.1)', async () => {
  const { chats, repo } = setup();
  const s = chats.create({ workspaceId: 'ws1' });
  repo.appendMessage({ sessionId: s.id, turnId: 't1', role: 'user', content: 'q' });
  repo.appendMessage({ sessionId: s.id, turnId: 't1', role: 'thinking', content: 'hmm' });
  repo.appendMessage({ sessionId: s.id, turnId: 't1', role: 'tool', content: 'result', toolName: 'read' });
  repo.appendMessage({ sessionId: s.id, turnId: 't1', role: 'assistant', content: 'a' });
  const history = repo.providerHistory(s.id, null);
  assert.deepEqual(history.map((m) => m.role), ['user', 'assistant']);
});

test('/clear wipes transcript and compaction state; /export renders markdown', async () => {
  const { chats, turns, repo } = setup();
  const s = chats.create({ workspaceId: 'ws1', name: 'Doc chat' });
  await collect(turns.run(s.id, { text: 'export me' }));

  const md = chats.exportMarkdown(s.id);
  assert.ok(md.startsWith('# Doc chat'));
  assert.ok(md.includes('## User'));
  assert.ok(md.includes('export me'));

  chats.clear(s.id);
  assert.equal(repo.listMessages(s.id).length, 0);
  assert.equal(chats.get(s.id).compactSummary, '');
});

test('stop aborts an in-flight turn and retains the partial (FR-5.4)', async () => {
  const { chats, turns, repo } = setup();
  const s = chats.create({ workspaceId: 'ws1' });
  const gen = turns.run(s.id, { text: 'one two three four five six seven eight nine ten' });
  const events: TurnEvent[] = [];
  for await (const ev of gen) {
    events.push(ev);
    if (events.filter((e) => e.type === 'answer').length === 2) turns.stop(s.id);
  }
  const [turn] = repo.listTurns(s.id);
  assert.equal(turn.status, 'stopped');
  const messages = repo.listMessages(s.id);
  assert.equal(messages.at(-1)?.role, 'assistant');
});
