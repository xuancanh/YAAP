/** Migrations must be idempotent: running them twice is a no-op. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { runPgMigrations, Queryable } from '../server/src/database/migrator';

const silent = { log: () => {} };

/** Adapt PGlite to the migrator's pg-Pool-shaped interface: `exec` for
 *  multi-statement DDL (simple protocol), `query` when params are bound. */
export function pgliteQueryable(pg: PGlite): Queryable {
  return {
    query: async (sql: string, params?: unknown[]) => {
      if (params && params.length > 0) return pg.query(sql, params);
      const results = await pg.exec(sql);
      return { rows: results.at(-1)?.rows ?? [] };
    },
  };
}

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
