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

test('boot reaps orphaned running turns left by a crash mid-turn', async () => {
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

  const res = await q.query(`SELECT "id", "status" FROM chat_turns ORDER BY "seq"`);
  assert.deepEqual(res.rows, [
    { id: 't1', status: 'error' }, // orphaned turn reaped
    { id: 't2', status: 'done' }, // finalized turns untouched
  ]);
  await pg.close();
});
