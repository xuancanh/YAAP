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
