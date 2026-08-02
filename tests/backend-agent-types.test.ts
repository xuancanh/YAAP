/** Agent types (§9): API keys sealed at rest via secretbox, redacted in
 *  API-facing results, opened back to plaintext for provider use (FR-13.3). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { AgentTypesService } from '../server/src/agent-types/agent-types.service';
import { agentTypes } from '../server/src/database/schema';
import { testDb } from './helpers';

/** secretbox reads TOKEN_ENCRYPTION_KEY at call time, so set it per test. */
function withEncryptionKey(fn: () => Promise<void>) {
  return async () => {
    process.env.TOKEN_ENCRYPTION_KEY = 'test-encryption-key';
    try {
      await fn();
    } finally {
      delete process.env.TOKEN_ENCRYPTION_KEY;
    }
  };
}

async function rawKey(db: Awaited<ReturnType<typeof testDb>>, id: string): Promise<string | null> {
  const rows = await db.select().from(agentTypes).where(eq(agentTypes.id, id)).limit(1);
  return rows[0]?.apiKey ?? null;
}

test('create seals the API key at rest; responses stay redacted; resolve opens it', withEncryptionKey(async () => {
  const db = await testDb();
  const types = new AgentTypesService(db);

  const created = await types.create({ name: 'Claude', provider: 'anthropic', model: 'claude-sonnet-4', apiKey: 'sk-secret' });
  assert.ok(!(created as Record<string, unknown>).apiKey);
  assert.equal(created.hasApiKey, true);

  const stored = await rawKey(db, created.id);
  assert.ok(stored!.startsWith('sealed:'), `expected sealed: value, got ${stored}`);
  assert.ok(!stored!.includes('sk-secret'));

  // list() redacts too
  const listed = (await types.list()).find((t) => t.id === created.id)!;
  assert.ok(!(listed as Record<string, unknown>).apiKey);
  assert.equal(listed.hasApiKey, true);

  // provider-facing resolution returns the original plaintext
  assert.equal((await types.resolve(created.id))!.apiKey, 'sk-secret');
}));

test('update seals a new key and lazily re-seals on keyless updates', withEncryptionKey(async () => {
  const db = await testDb();
  const types = new AgentTypesService(db);
  const created = await types.create({ name: 'GPT', provider: 'openai', model: 'gpt-5', apiKey: 'sk-one' });

  await types.update(created.id, { apiKey: 'sk-two' });
  const stored = await rawKey(db, created.id);
  assert.ok(stored!.startsWith('sealed:'));
  assert.equal((await types.resolve(created.id))!.apiKey, 'sk-two');

  // updating something unrelated keeps the key working
  await types.update(created.id, { persona: 'be terse' });
  assert.equal((await types.resolve(created.id))!.apiKey, 'sk-two');
}));

test('legacy plaintext rows still resolve, and re-seal on next update', withEncryptionKey(async () => {
  const db = await testDb();
  const types = new AgentTypesService(db);
  await db.insert(agentTypes).values({
    id: 'legacy1', name: 'Legacy', provider: 'openai', model: 'gpt-4',
    models: '[]', apiKey: 'sk-legacy-plain', persona: '', enabled: 1, createdAt: new Date().toISOString(),
  });

  // pre-secretbox value passes through open() untouched
  assert.equal((await types.resolve('legacy1'))!.apiKey, 'sk-legacy-plain');

  // a keyless update lazily seals the stored value
  await types.update('legacy1', { persona: 'p' });
  assert.ok((await rawKey(db, 'legacy1'))!.startsWith('sealed:'));
  assert.equal((await types.resolve('legacy1'))!.apiKey, 'sk-legacy-plain');
}));

test('without TOKEN_ENCRYPTION_KEY the key is stored as marked plaintext and still resolves', async () => {
  delete process.env.TOKEN_ENCRYPTION_KEY;
  const db = await testDb();
  const types = new AgentTypesService(db);
  const created = await types.create({ name: 'Local', provider: 'openai', model: 'gpt-5', apiKey: 'sk-dev' });

  assert.equal(await rawKey(db, created.id), 'plain:sk-dev');
  assert.equal((await types.resolve(created.id))!.apiKey, 'sk-dev');
});
