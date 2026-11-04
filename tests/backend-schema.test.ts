/** Migrations must be idempotent: running them twice is a no-op. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { runPgMigrations } from '../server/src/database/migrator';
import { pgliteQueryable } from './helpers';

const silent = { log: () => {} };

test('migrations run and are idempotent', async () => {
  const pg = new PGlite();
  const q = pgliteQueryable(pg);
  await runPgMigrations(q, silent);
  await runPgMigrations(q, silent);
  const res = await q.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
  );
  const tables = (res.rows as Array<{ table_name: string }>).map((r) => r.table_name);
  for (const t of ['workspaces', 'agents', 'agent_types', 'chat_sessions', 'chat_turns', 'chat_messages']) {
    assert.ok(tables.includes(t), `missing table ${t}`);
  }
  await pg.close();
});

test('boot marks turns left running by a dead process interrupted, pending recovery', async () => {
  const pg = new PGlite();
  const q = pgliteQueryable(pg);
  await runPgMigrations(q, silent);
  // simulate a crash mid-turn: one turn stuck 'running', one finalized
  await q.query(`INSERT INTO chat_sessions ("id", "workspaceId", "createdAt", "updatedAt")
    VALUES ('s1', 'ws1', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`);
  await q.query(`INSERT INTO chat_turns ("id", "sessionId", "seq", "input", "status", "createdAt") VALUES
    ('t1', 's1', 0, 'stuck', 'running', '2026-01-01T00:00:00Z'),
    ('t2', 's1', 1, 'fine', 'done', '2026-01-01T00:00:00Z')`);

  await runPgMigrations(q, silent); // reboot: the repair sweep runs again

  const res = await q.query(`SELECT "id", "status", "recovery" FROM chat_turns ORDER BY "seq"`);
  assert.deepEqual(res.rows, [
    // a restart or a crash interrupted it — not an agent error; pending recovery
    { id: 't1', status: 'interrupted', recovery: 'pending' },
    { id: 't2', status: 'done', recovery: '' }, // finalized turns untouched
  ]);
  await pg.close();
});

test('0094: turns a restart recorded as errors (the abort message, or the old sweep\'s blank) become interrupted; their loop_errors are read', async () => {
  const pg = new PGlite();
  const q = pgliteQueryable(pg);
  await runPgMigrations(q, silent);
  await q.query(`INSERT INTO chat_sessions ("id", "workspaceId", "createdAt", "updatedAt") VALUES ('s1', 'ws1', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`);
  await q.query(`INSERT INTO chat_turns ("id", "sessionId", "seq", "input", "status", "error", "createdAt") VALUES
    ('t1', 's1', 0, 'a', 'error', 'This operation was aborted', '2026-01-01T00:00:00Z'),
    ('t2', 's1', 1, 'b', 'error', NULL, '2026-01-01T00:00:00Z'),
    ('t3', 's1', 2, 'c', 'error', 'anthropic 401: invalid x-api-key', '2026-01-01T00:00:00Z')`);
  await q.query(`INSERT INTO agent_events ("id", "agentId", "kind", "title", "body", "createdAt") VALUES
    ('e1', 'a1', 'loop_error', 'Loop failed', 'This operation was aborted', '2026-01-01T00:00:00Z'),
    ('e2', 'a1', 'loop_error', 'Loop failed', 'anthropic 429', '2026-01-01T00:00:00Z')`);
  await q.query(`DELETE FROM __migrations WHERE "id" = '0094-turn-recovery'`);
  await runPgMigrations(q, silent); // 0094 again (idempotent), as on the first boot after the upgrade

  const turns = await q.query(`SELECT "id", "status", "recovery" FROM chat_turns ORDER BY "seq"`);
  assert.deepEqual(turns.rows, [
    { id: 't1', status: 'interrupted', recovery: 'none' },
    { id: 't2', status: 'interrupted', recovery: 'none' },
    { id: 't3', status: 'error', recovery: '' }, // a real failure stays one
  ]);
  const events = await q.query(`SELECT "id", "readAt" IS NOT NULL AS "read" FROM agent_events ORDER BY "id"`);
  assert.deepEqual(events.rows, [{ id: 'e1', read: true }, { id: 'e2', read: false }]);
  await pg.close();
});
