/**
 * Boot-time migrations for Postgres.
 *
 * Strategy (borrowed from smart-knowledge-app): every migration is an
 * idempotent function that inspects the live schema (information_schema)
 * before changing anything, tracked in a `__migrations` table. Safe to run on
 * every boot. Never raw DDL + try/catch — silent error swallowing is how
 * columns end up missing in production.
 *
 * Runs against anything with a pg-shaped `query()` — the node-postgres Pool
 * in production, PGlite in tests.
 */
export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

type Migration = { id: string; up: (db: Queryable) => Promise<void> };

async function hasColumn(db: Queryable, table: string, column: string): Promise<boolean> {
  const res = await db.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
    [table, column],
  );
  return res.rows.length > 0;
}

const MIGRATIONS: Migration[] = [
  {
    id: '0001-initial',
    up: async (db) => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS workspaces (
          "id" TEXT PRIMARY KEY,
          "name" TEXT NOT NULL,
          "color" TEXT NOT NULL DEFAULT '#F5C451',
          "memory" TEXT NOT NULL DEFAULT '',
          "createdAt" TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS agents (
          "id" TEXT PRIMARY KEY,
          "name" TEXT NOT NULL,
          "charter" TEXT NOT NULL DEFAULT '',
          "provider" TEXT NOT NULL DEFAULT 'anthropic',
          "model" TEXT NOT NULL DEFAULT '',
          "homeDir" TEXT,
          "dashboard" TEXT NOT NULL DEFAULT '',
          "loops" TEXT NOT NULL DEFAULT '[]',
          "pendingFeedback" TEXT NOT NULL DEFAULT '[]',
          "createdAt" TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS agent_types (
          "id" TEXT PRIMARY KEY,
          "name" TEXT NOT NULL,
          "provider" TEXT NOT NULL,
          "model" TEXT NOT NULL,
          "models" TEXT NOT NULL DEFAULT '[]',
          "baseUrl" TEXT,
          "apiKey" TEXT,
          "persona" TEXT NOT NULL DEFAULT '',
          "enabled" INTEGER NOT NULL DEFAULT 1,
          "createdAt" TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS chat_sessions (
          "id" TEXT PRIMARY KEY,
          "workspaceId" TEXT NOT NULL,
          "agentId" TEXT,
          "agentTypeId" TEXT,
          "name" TEXT NOT NULL DEFAULT '',
          "autoTitle" TEXT NOT NULL DEFAULT '',
          "cwd" TEXT,
          "model" TEXT NOT NULL DEFAULT '',
          "thinkingEffort" TEXT NOT NULL DEFAULT 'off',
          "permissionMode" TEXT NOT NULL DEFAULT 'ask',
          "approvals" TEXT NOT NULL DEFAULT '{}',
          "skillSourceIds" TEXT NOT NULL DEFAULT '[]',
          "pinned" INTEGER NOT NULL DEFAULT 0,
          "tags" TEXT NOT NULL DEFAULT '[]',
          "archivedAt" TEXT,
          "draft" TEXT NOT NULL DEFAULT '',
          "tokenCeiling" INTEGER NOT NULL DEFAULT 200000,
          "compactSummary" TEXT NOT NULL DEFAULT '',
          "compactCutoff" TEXT,
          "tokensIn" INTEGER NOT NULL DEFAULT 0,
          "tokensOut" INTEGER NOT NULL DEFAULT 0,
          "createdAt" TEXT NOT NULL,
          "updatedAt" TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS chat_turns (
          "id" TEXT PRIMARY KEY,
          "sessionId" TEXT NOT NULL,
          "seq" INTEGER NOT NULL,
          "input" TEXT NOT NULL,
          "attachments" TEXT NOT NULL DEFAULT '[]',
          "model" TEXT NOT NULL DEFAULT '',
          "status" TEXT NOT NULL DEFAULT 'running',
          "toolCalls" TEXT NOT NULL DEFAULT '[]',
          "tokensIn" INTEGER NOT NULL DEFAULT 0,
          "tokensOut" INTEGER NOT NULL DEFAULT 0,
          "rating" TEXT,
          "ratingNote" TEXT,
          "taskHandoff" TEXT,
          "error" TEXT,
          "createdAt" TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS chat_messages (
          "id" TEXT PRIMARY KEY,
          "sessionId" TEXT NOT NULL,
          "turnId" TEXT NOT NULL,
          "seq" INTEGER NOT NULL,
          "role" TEXT NOT NULL,
          "content" TEXT NOT NULL DEFAULT '',
          "toolName" TEXT,
          "createdAt" TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON chat_sessions ("workspaceId");
        CREATE INDEX IF NOT EXISTS idx_turns_session ON chat_turns ("sessionId", "seq");
        CREATE INDEX IF NOT EXISTS idx_messages_session ON chat_messages ("sessionId", "seq");
      `);
      // Guard example for future column additions:
      if (!(await hasColumn(db, 'chat_sessions', 'draft'))) {
        await db.query(`ALTER TABLE chat_sessions ADD COLUMN "draft" TEXT NOT NULL DEFAULT ''`);
      }
    },
  },
  {
    id: '0002-skills',
    up: async (db) => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS skills (
          "id" TEXT PRIMARY KEY,
          "workspaceId" TEXT,
          "name" TEXT NOT NULL,
          "description" TEXT NOT NULL DEFAULT '',
          "instructions" TEXT NOT NULL DEFAULT '',
          "enabled" INTEGER NOT NULL DEFAULT 1,
          "builtin" INTEGER NOT NULL DEFAULT 0,
          "createdAt" TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_scope_name
          ON skills (COALESCE("workspaceId", ''), "name");
      `);
    },
  },
  {
    id: '0003-ui-design',
    up: async (db) => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS mcp_servers (
          "id" TEXT PRIMARY KEY,
          "name" TEXT NOT NULL,
          "url" TEXT NOT NULL,
          "enabled" INTEGER NOT NULL DEFAULT 1,
          "tools" TEXT NOT NULL DEFAULT '[]',
          "createdAt" TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS app_settings (
          "key" TEXT PRIMARY KEY,
          "value" TEXT NOT NULL
        );
      `);
      if (!(await hasColumn(db, 'agents', 'emoji'))) {
        await db.query(`ALTER TABLE agents ADD COLUMN "emoji" TEXT NOT NULL DEFAULT '\u{1F916}'`);
      }
      if (!(await hasColumn(db, 'agents', 'colors'))) {
        await db.query(`ALTER TABLE agents ADD COLUMN "colors" TEXT NOT NULL DEFAULT '["#8b8cf0","#5cc2f2"]'`);
      }
      if (!(await hasColumn(db, 'agents', 'role'))) {
        await db.query(`ALTER TABLE agents ADD COLUMN "role" TEXT NOT NULL DEFAULT ''`);
      }
    },
  },
  {
    id: '0004-agent-apps',
    up: async (db) => {
      if (!(await hasColumn(db, 'agents', 'apps'))) {
        await db.query(`ALTER TABLE agents ADD COLUMN "apps" TEXT NOT NULL DEFAULT '[]'`);
      }
    },
  },
  {
    id: '0005-agent-tasks',
    up: async (db) => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS agent_tasks (
          "id" TEXT PRIMARY KEY,
          "agentId" TEXT NOT NULL,
          "title" TEXT NOT NULL,
          "note" TEXT NOT NULL DEFAULT '',
          "status" TEXT NOT NULL DEFAULT 'todo',
          "origin" TEXT NOT NULL DEFAULT 'user',
          "sessionId" TEXT,
          "createdAt" TEXT NOT NULL,
          "updatedAt" TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_agent_tasks_agent ON agent_tasks ("agentId", "status");
      `);
    },
  },
  {
    id: '0006-recall-profile',
    up: async (db) => {
      // full-text recall over the transcript (search_history tool)
      await db.query(`CREATE INDEX IF NOT EXISTS idx_messages_fts ON chat_messages
        USING GIN (to_tsvector('english', "content"))`);
      if (!(await hasColumn(db, 'chat_sessions', 'distilledAt'))) {
        await db.query(`ALTER TABLE chat_sessions ADD COLUMN "distilledAt" TEXT`);
      }
      if (!(await hasColumn(db, 'workspaces', 'profile'))) {
        await db.query(`ALTER TABLE workspaces ADD COLUMN "profile" TEXT NOT NULL DEFAULT ''`);
      }
      if (!(await hasColumn(db, 'workspaces', 'profilePending'))) {
        await db.query(`ALTER TABLE workspaces ADD COLUMN "profilePending" TEXT NOT NULL DEFAULT '[]'`);
      }
    },
  },
  {
    id: '0007-agent-events',
    up: async (db) => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS agent_events (
          "id" TEXT PRIMARY KEY,
          "agentId" TEXT NOT NULL,
          "kind" TEXT NOT NULL DEFAULT 'loop_run',
          "title" TEXT NOT NULL,
          "body" TEXT NOT NULL DEFAULT '',
          "sessionId" TEXT,
          "readAt" TEXT,
          "createdAt" TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_agent_events_agent ON agent_events ("agentId", "createdAt");
      `);
    },
  },
];

export async function runPgMigrations(db: Queryable, logger: { log: (msg: string) => void }): Promise<void> {
  await db.query('CREATE TABLE IF NOT EXISTS __migrations ("id" TEXT PRIMARY KEY, "appliedAt" TEXT NOT NULL)');
  const res = await db.query('SELECT "id" FROM __migrations');
  const applied = new Set((res.rows as Array<{ id: string }>).map((r) => r.id));
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    await m.up(db);
    await db.query('INSERT INTO __migrations ("id", "appliedAt") VALUES ($1, $2)', [m.id, new Date().toISOString()]);
    logger.log(`applied migration ${m.id}`);
  }
}
