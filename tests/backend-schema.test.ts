/** Migrations must be idempotent: running them twice is a no-op. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runSqliteMigrations } from '../server/src/database/migrator';

const silent = { log: () => {} };

test('migrations run and are idempotent', () => {
  const db = new Database(':memory:');
  runSqliteMigrations(db, silent);
  runSqliteMigrations(db, silent);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => (r as { name: string }).name);
  for (const t of ['workspaces', 'agents', 'agent_types', 'chat_sessions', 'chat_turns', 'chat_messages']) {
    assert.ok(tables.includes(t), `missing table ${t}`);
  }
});
