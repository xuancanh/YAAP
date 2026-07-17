/** Workspace search (FR-8.2): sessions, transcript messages, files. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SearchService } from '../server/src/search/search.service';
import { ChatsRepository } from '../server/src/chats/chats.repository';
import { testDb, memStorage } from './helpers';

async function setup() {
  const db = await testDb();
  const repo = new ChatsRepository(db);
  const { stub } = memStorage();
  const search = new SearchService(db, stub);
  return { repo, search, storage: stub };
}

test('finds sessions by name, messages by content, files by path — workspace-scoped', async () => {
  const { repo, search, storage } = await setup();
  const mine = await repo.createSession({ workspaceId: 'ws1', name: 'Kubernetes migration' });
  const other = await repo.createSession({ workspaceId: 'ws2', name: 'Kubernetes elsewhere' });
  await repo.appendMessage({ sessionId: mine.id, turnId: 't1', role: 'assistant', content: 'The kubernetes cluster needs three nodes.' });
  await repo.appendMessage({ sessionId: other.id, turnId: 't1', role: 'assistant', content: 'kubernetes in another workspace' });
  await storage.put('workspaces/ws1/notes/kubernetes-plan.md', Buffer.from('# plan'));
  await storage.put('workspaces/ws2/notes/kubernetes-other.md', Buffer.from('# other'));

  const res = await search.search('ws1', 'kubernetes');
  assert.deepEqual(res.sessions.map((s) => s.id), [mine.id]);
  assert.equal(res.messages.length, 1);
  assert.equal(res.messages[0].sessionId, mine.id);
  assert.match(res.messages[0].snippet, /cluster needs three nodes/);
  assert.deepEqual(res.files.map((f) => f.path), ['notes/kubernetes-plan.md']);
});

test('empty query returns nothing; ILIKE wildcards are escaped', async () => {
  const { repo, search } = await setup();
  const s = await repo.createSession({ workspaceId: 'ws1', name: 'plain' });
  await repo.appendMessage({ sessionId: s.id, turnId: 't1', role: 'user', content: 'contains 100% literal percent' });

  assert.deepEqual(await search.search('ws1', '  '), { sessions: [], messages: [], files: [] });
  const res = await search.search('ws1', '100%');
  assert.equal(res.messages.length, 1);
  const none = await search.search('ws1', '10_%');
  assert.equal(none.messages.length, 0);
});
