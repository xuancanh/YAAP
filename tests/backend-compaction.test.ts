/** Compaction: summary + cutoff, history rebuild, transcript untouched (§7). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigService } from '@nestjs/config';
import { ChatsRepository } from '../server/src/chats/chats.repository';
import { ChatsService } from '../server/src/chats/chats.service';
import { CompactionService } from '../server/src/chats/compaction.service';
import { ChatLocks } from '../server/src/chats/chat-locks';
import { testDb, ctxStub, agentsStub, ScriptedProvider } from './helpers';
import { AiStreamEvent } from '../server/src/ai/ai-provider.interface';

const summaryRound: AiStreamEvent[] = [
  { type: 'answer', text: 'Goal: test compaction. Key facts: everything works.' },
  { type: 'done' },
];

function configStub(values: Record<string, unknown> = {}): ConfigService {
  return { get: (k: string) => values[k] } as unknown as ConfigService;
}

async function setup() {
  const repo = new ChatsRepository(await testDb());
  const chats = new ChatsService(repo, agentsStub());
  const provider = new ScriptedProvider([summaryRound, summaryRound]);
  const compaction = new CompactionService(repo, new ChatLocks(), ctxStub(provider), configStub());
  return { repo, chats, compaction, provider };
}

async function seedConversation(repo: ChatsRepository, sessionId: string, turns: number) {
  for (let i = 0; i < turns; i++) {
    await repo.appendMessage({ sessionId, turnId: `t${i}`, role: 'user', content: `question ${i}` });
    await repo.appendMessage({ sessionId, turnId: `t${i}`, role: 'assistant', content: `answer ${i}` });
  }
}

test('compact writes a bounded summary and a cutoff; history rebuilds past it (FR-7.3/7.4)', async () => {
  const { repo, chats, compaction } = await setup();
  const s = await chats.create({ workspaceId: 'ws1' });
  await seedConversation(repo, s.id, 3);

  const res = await compaction.compact(s.id);
  assert.equal(res.ok, true);

  const session = await chats.get(s.id);
  assert.match(session.compactSummary, /Goal: test compaction/);
  assert.ok(session.compactCutoff !== null);

  // provider history past the cutoff is empty; the visible transcript is unchanged
  const history = await repo.providerHistory(s.id, Number(session.compactCutoff));
  assert.equal(history.length, 0);
  assert.equal((await repo.listMessages(s.id)).length, 6);

  // new messages after compaction are included again
  await repo.appendMessage({ sessionId: s.id, turnId: 'tX', role: 'user', content: 'newer' });
  const after = await repo.providerHistory(s.id, Number(session.compactCutoff));
  assert.deepEqual(after.map((m) => m.content), ['newer']);
});

test('compaction streams with a timeout signal so a stalled provider cannot hang it', async () => {
  const { repo, chats, compaction, provider } = await setup();
  const s = await chats.create({ workspaceId: 'ws1' });
  await seedConversation(repo, s.id, 3);

  await compaction.compact(s.id);
  assert.ok(provider.requests[0].signal instanceof AbortSignal);
});

test('short conversations refuse to compact', async () => {
  const { repo, chats, compaction } = await setup();
  const s = await chats.create({ workspaceId: 'ws1' });
  await seedConversation(repo, s.id, 1);
  const res = await compaction.compact(s.id);
  assert.equal(res.ok, false);
  assert.match(res.reason!, /too short/);
});

test('auto-compaction only fires past the estimated token threshold', async () => {
  const repo = new ChatsRepository(await testDb());
  const chats = new ChatsService(repo, agentsStub());
  const provider = new ScriptedProvider([summaryRound]);
  const compaction = new CompactionService(
    repo, new ChatLocks(), ctxStub(provider),
    configStub({ compactionThresholdTokens: 10 }), // ~40 chars triggers
  );
  const s = await chats.create({ workspaceId: 'ws1' });
  await seedConversation(repo, s.id, 3); // well past 40 chars

  await compaction.maybeAutoCompact(s.id);
  assert.match((await chats.get(s.id)).compactSummary, /Goal/);

  // below threshold: untouched
  const s2 = await chats.create({ workspaceId: 'ws1' });
  const compaction2 = new CompactionService(
    repo, new ChatLocks(), ctxStub(new ScriptedProvider([summaryRound])),
    configStub({ compactionThresholdTokens: 999999 }),
  );
  await seedConversation(repo, s2.id, 3);
  await compaction2.maybeAutoCompact(s2.id);
  assert.equal((await chats.get(s2.id)).compactSummary, '');
});

test('auto-compaction estimate includes the system-prompt + tool-schema overhead', async () => {
  const repo = new ChatsRepository(await testDb());
  const chats = new ChatsService(repo, agentsStub());
  const provider = new ScriptedProvider([summaryRound, summaryRound]);
  // 1000 tokens ≈ 4000 chars: history alone (~50 chars) stays under, but
  // history + the per-round overhead the turn loop measured (system prompt +
  // tool-spec JSON, 4000 chars here) crosses it.
  const compaction = new CompactionService(
    repo, new ChatLocks(), ctxStub(provider),
    configStub({ compactionThresholdTokens: 1000 }),
  );
  const s = await chats.create({ workspaceId: 'ws1' });
  await seedConversation(repo, s.id, 3);

  await compaction.maybeAutoCompact(s.id); // no overhead passed: under threshold
  assert.equal((await chats.get(s.id)).compactSummary, '');

  await compaction.maybeAutoCompact(s.id, 4000);
  assert.match((await chats.get(s.id)).compactSummary, /Goal/);
});

test('compaction respects the shared busy lock (FR-7.5)', async () => {
  const repo = new ChatsRepository(await testDb());
  const chats = new ChatsService(repo, agentsStub());
  const locks = new ChatLocks();
  const compaction = new CompactionService(repo, locks, ctxStub(new ScriptedProvider([summaryRound])), configStub());
  const s = await chats.create({ workspaceId: 'ws1' });
  await seedConversation(repo, s.id, 3);

  locks.tryAcquire(s.id); // simulate an in-flight turn
  await assert.rejects(compaction.compact(s.id), /busy/);
  locks.release(s.id);
  assert.equal((await compaction.compact(s.id)).ok, true);
});

test('compaction resets the token-ceiling baseline; a forced auto-compact runs below the threshold', async () => {
  const { repo, chats, compaction } = await setup();
  const s = await chats.create({ workspaceId: 'ws1', tokenCeiling: 1000 });
  await seedConversation(repo, s.id, 3);
  await repo.updateSession(s.id, { tokensIn: 900, tokensOut: 300 });
  const before = (await repo.getSession(s.id))!;
  assert.equal(before.tokensIn + before.tokensOut - before.tokensAtCompact >= before.tokenCeiling, true, 'at the ceiling before compaction');
  // tiny history: far below any threshold, but forced because the chat is at its ceiling
  assert.equal(await compaction.maybeAutoCompact(s.id, 0, { force: true }), true);
  const after = (await repo.getSession(s.id))!;
  assert.equal(after.tokensAtCompact, 1200);
  assert.equal(after.tokensIn + after.tokensOut - after.tokensAtCompact, 0, 'a fresh budget after compaction');
  assert.ok(after.compactSummary.length > 0);
});

test('auto-compact off in settings: the threshold check never compacts', async () => {
  const repo = new ChatsRepository(await testDb());
  const chats = new ChatsService(repo, agentsStub());
  const provider = new ScriptedProvider([summaryRound]);
  const settings = { all: async () => ({ autoCompact: 'off' }) } as unknown as import('../server/src/settings/settings.module').SettingsService;
  const compaction = new CompactionService(repo, new ChatLocks(), ctxStub(provider), configStub({ compactionThresholdTokens: 1 }), settings);
  const s = await chats.create({ workspaceId: 'ws1' });
  await seedConversation(repo, s.id, 6);
  assert.equal(await compaction.maybeAutoCompact(s.id, 0), false);
  assert.equal((await repo.getSession(s.id))!.compactSummary, '');
});
