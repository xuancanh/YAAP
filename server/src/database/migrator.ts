/**
 * Boot-time migrations for the SQLite database.
 *
 * Strategy (borrowed from smart-knowledge-app): every migration is an
 * idempotent function that inspects the live schema (PRAGMA table_info)
 * before changing anything, tracked in a `__migrations` table. Safe to run on
 * every boot. Never raw DDL + try/catch — silent error swallowing is how
 * columns end up missing in production.
 */
import type { Database } from 'better-sqlite3';
import type { Logger } from '@nestjs/common';

type Migration = { id: string; up: (db: Database) => void };

const hasColumn = (db: Database, table: string, column: string): boolean =>
  (db.pragma(`table_info(${table})`) as Array<{ name: string }>).some((c) => c.name === column);

const MIGRATIONS: Migration[] = [
  {
    id: '0001-initial',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS workspaces (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          color TEXT NOT NULL DEFAULT '#F5C451',
          memory TEXT NOT NULL DEFAULT '',
          createdAt TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS agents (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          charter TEXT NOT NULL DEFAULT '',
          provider TEXT NOT NULL DEFAULT 'anthropic',
          model TEXT NOT NULL DEFAULT '',
          homeDir TEXT,
          dashboard TEXT NOT NULL DEFAULT '',
          loops TEXT NOT NULL DEFAULT '[]',
          pendingFeedback TEXT NOT NULL DEFAULT '[]',
          createdAt TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS agent_types (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          models TEXT NOT NULL DEFAULT '[]',
          baseUrl TEXT,
          apiKey TEXT,
          persona TEXT NOT NULL DEFAULT '',
          enabled INTEGER NOT NULL DEFAULT 1,
          createdAt TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS chat_sessions (
          id TEXT PRIMARY KEY,
          workspaceId TEXT NOT NULL,
          agentId TEXT,
          agentTypeId TEXT,
          name TEXT NOT NULL DEFAULT '',
          autoTitle TEXT NOT NULL DEFAULT '',
          cwd TEXT,
          model TEXT NOT NULL DEFAULT '',
          thinkingEffort TEXT NOT NULL DEFAULT 'off',
          permissionMode TEXT NOT NULL DEFAULT 'ask',
          approvals TEXT NOT NULL DEFAULT '{}',
          skillSourceIds TEXT NOT NULL DEFAULT '[]',
          pinned INTEGER NOT NULL DEFAULT 0,
          tags TEXT NOT NULL DEFAULT '[]',
          archivedAt TEXT,
          draft TEXT NOT NULL DEFAULT '',
          tokenCeiling INTEGER NOT NULL DEFAULT 200000,
          compactSummary TEXT NOT NULL DEFAULT '',
          compactCutoff TEXT,
          tokensIn INTEGER NOT NULL DEFAULT 0,
          tokensOut INTEGER NOT NULL DEFAULT 0,
          createdAt TEXT NOT NULL,
          updatedAt TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS chat_turns (
          id TEXT PRIMARY KEY,
          sessionId TEXT NOT NULL,
          seq INTEGER NOT NULL,
          input TEXT NOT NULL,
          attachments TEXT NOT NULL DEFAULT '[]',
          model TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'running',
          toolCalls TEXT NOT NULL DEFAULT '[]',
          tokensIn INTEGER NOT NULL DEFAULT 0,
          tokensOut INTEGER NOT NULL DEFAULT 0,
          rating TEXT,
          ratingNote TEXT,
          taskHandoff TEXT,
          error TEXT,
          createdAt TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS chat_messages (
          id TEXT PRIMARY KEY,
          sessionId TEXT NOT NULL,
          turnId TEXT NOT NULL,
          seq INTEGER NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL DEFAULT '',
          toolName TEXT,
          createdAt TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON chat_sessions (workspaceId);
        CREATE INDEX IF NOT EXISTS idx_turns_session ON chat_turns (sessionId, seq);
        CREATE INDEX IF NOT EXISTS idx_messages_session ON chat_messages (sessionId, seq);
      `);
      // Guard example for future column additions:
      if (!hasColumn(db, 'chat_sessions', 'draft')) {
        db.exec(`ALTER TABLE chat_sessions ADD COLUMN draft TEXT NOT NULL DEFAULT ''`);
      }
    },
  },
];

export function runSqliteMigrations(db: Database, logger: Pick<Logger, 'log'>): void {
  db.exec('CREATE TABLE IF NOT EXISTS __migrations (id TEXT PRIMARY KEY, appliedAt TEXT NOT NULL)');
  const applied = new Set(
    (db.prepare('SELECT id FROM __migrations').all() as Array<{ id: string }>).map((r) => r.id),
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    m.up(db);
    db.prepare('INSERT INTO __migrations (id, appliedAt) VALUES (?, ?)').run(m.id, new Date().toISOString());
    logger.log(`applied migration ${m.id}`);
  }
}
