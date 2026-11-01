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
  {
    id: '0008-skill-drafts',
    up: async (db) => {
      if (!(await hasColumn(db, 'skills', 'draft'))) {
        await db.query(`ALTER TABLE skills ADD COLUMN "draft" INTEGER NOT NULL DEFAULT 0`);
      }
      if (!(await hasColumn(db, 'skills', 'proposedBy'))) {
        await db.query(`ALTER TABLE skills ADD COLUMN "proposedBy" TEXT NOT NULL DEFAULT ''`);
      }
    },
  },
  {
    id: '0009-agent-scope',
    up: async (db) => {
      if (!(await hasColumn(db, 'skills', 'agentId'))) {
        await db.query(`ALTER TABLE skills ADD COLUMN "agentId" TEXT`);
      }
      if (!(await hasColumn(db, 'agents', 'tools'))) {
        await db.query(`ALTER TABLE agents ADD COLUMN "tools" TEXT NOT NULL DEFAULT '[]'`);
      }
    },
  },
  {
    id: '0010-agent-workspace-folder',
    up: async (db) => {
      if (!(await hasColumn(db, 'agents', 'workspaceFolder'))) {
        await db.query(`ALTER TABLE agents ADD COLUMN "workspaceFolder" TEXT NOT NULL DEFAULT ''`);
      }
    },
  },
  {
    id: '0011-connections',
    up: async (db) => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS connections (
          "id" TEXT PRIMARY KEY,
          "provider" TEXT NOT NULL,
          "accountEmail" TEXT NOT NULL DEFAULT '',
          "scopes" TEXT NOT NULL DEFAULT '[]',
          "accessToken" TEXT NOT NULL DEFAULT '',
          "refreshToken" TEXT NOT NULL DEFAULT '',
          "expiresAt" TEXT NOT NULL DEFAULT '',
          "createdAt" TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS connection_grants (
          "id" TEXT PRIMARY KEY,
          "connectionId" TEXT NOT NULL,
          "agentId" TEXT NOT NULL,
          "level" TEXT NOT NULL DEFAULT 'read',
          "createdAt" TEXT NOT NULL
        );
      `);
    },
  },
  {
    id: '0012-agent-event-actions',
    up: async (db) => {
      if (!(await hasColumn(db, 'agent_events', 'payload'))) {
        await db.query(`ALTER TABLE agent_events ADD COLUMN "payload" TEXT NOT NULL DEFAULT ''`);
      }
    },
  },
  {
    id: '0013-grant-service',
    up: async (db) => {
      if (!(await hasColumn(db, 'connection_grants', 'service'))) {
        await db.query(`ALTER TABLE connection_grants ADD COLUMN "service" TEXT NOT NULL DEFAULT 'calendar'`);
      }
    },
  },
  {
    id: '0014-mcp-oauth',
    up: async (db) => {
      for (const col of ['authAccessToken', 'authRefreshToken', 'authExpiresAt', 'authTokenUrl', 'authClientId', 'authClientSecret']) {
        if (!(await hasColumn(db, 'mcp_servers', col))) {
          await db.query(`ALTER TABLE mcp_servers ADD COLUMN "${col}" TEXT NOT NULL DEFAULT ''`);
        }
      }
    },
  },
  {
    id: '0015-agent-lessons',
    up: async (db) => {
      await db.query(`CREATE TABLE IF NOT EXISTS agent_lessons (
        "id" TEXT PRIMARY KEY,
        "agentId" TEXT NOT NULL,
        "text" TEXT NOT NULL,
        "sourceKind" TEXT NOT NULL DEFAULT 'chat',
        "sourceSessionId" TEXT,
        "trusted" INTEGER NOT NULL DEFAULT 1,
        "pinned" INTEGER NOT NULL DEFAULT 0,
        "useCount" INTEGER NOT NULL DEFAULT 1,
        "createdAt" TEXT NOT NULL,
        "updatedAt" TEXT NOT NULL
      )`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_lessons_agent ON agent_lessons ("agentId")`);
      // Fuzzy matching serves two jobs: near-duplicate detection when a
      // lesson is learned again, and a recall fallback when exact stems miss.
      // Inspected before creating rather than wrapped in try/catch (see the
      // header): PGlite has no pg_trgm, and swallowing the error would hide a
      // genuine failure on a real Postgres that does. Absence is handled at
      // runtime by AgentMemoryService, which falls back to exact matching.
      const trgm = await db.query(`SELECT 1 FROM pg_available_extensions WHERE name = 'pg_trgm'`);
      if (trgm.rows.length > 0) await db.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    },
  },
  {
    id: '0016-quiet-hours',
    up: async (db) => {
      if (!(await hasColumn(db, 'workspaces', 'quietHours'))) {
        await db.query(`ALTER TABLE workspaces ADD COLUMN "quietHours" TEXT NOT NULL DEFAULT ''`);
      }
      if (!(await hasColumn(db, 'agent_events', 'deliverAfter'))) {
        await db.query(`ALTER TABLE agent_events ADD COLUMN "deliverAfter" TEXT`);
      }
      if (!(await hasColumn(db, 'agent_events', 'silent'))) {
        await db.query(`ALTER TABLE agent_events ADD COLUMN "silent" INTEGER NOT NULL DEFAULT 0`);
      }
      if (!(await hasColumn(db, 'agent_events', 'origin'))) {
        await db.query(`ALTER TABLE agent_events ADD COLUMN "origin" TEXT NOT NULL DEFAULT ''`);
      }
    },
  },
  {
    id: '0017-spend-budget',
    up: async (db) => {
      if (!(await hasColumn(db, 'workspaces', 'spendBudgetTokens'))) {
        await db.query(`ALTER TABLE workspaces ADD COLUMN "spendBudgetTokens" INTEGER NOT NULL DEFAULT 0`);
      }
      if (!(await hasColumn(db, 'workspaces', 'spendMonth'))) {
        await db.query(`ALTER TABLE workspaces ADD COLUMN "spendMonth" TEXT NOT NULL DEFAULT ''`);
      }
      if (!(await hasColumn(db, 'workspaces', 'spendTokens'))) {
        await db.query(`ALTER TABLE workspaces ADD COLUMN "spendTokens" INTEGER NOT NULL DEFAULT 0`);
      }
    },
  },
  {
    id: '0018-usage-index',
    up: async (db) => {
      // GET /api/agents/:id/usage walks an agent's sessions, then their turns
      // (idx_turns_session covers the second hop); this covers the first.
      await db.query(`CREATE INDEX IF NOT EXISTS idx_sessions_agent ON chat_sessions ("agentId")`);
    },
  },
  {
    id: '0019-channel-delivery',
    up: async (db) => {
      if (!(await hasColumn(db, 'agent_events', 'channel'))) {
        await db.query(`ALTER TABLE agent_events ADD COLUMN "channel" INTEGER NOT NULL DEFAULT 0`);
      }
      if (!(await hasColumn(db, 'agent_events', 'deliveredAt'))) {
        await db.query(`ALTER TABLE agent_events ADD COLUMN "deliveredAt" TEXT`);
      }
      // The outbound sweep polls for undelivered rows every minute.
      await db.query(`CREATE INDEX IF NOT EXISTS idx_agent_events_undelivered ON agent_events ("deliveredAt") WHERE "deliveredAt" IS NULL`);
    },
  },
  {
    id: '0020-email-channel',
    up: async (db) => {
      if (!(await hasColumn(db, 'agents', 'emailSlug'))) {
        await db.query(`ALTER TABLE agents ADD COLUMN "emailSlug" TEXT NOT NULL DEFAULT ''`);
      }
      // Two agents must never share an address; '' (unassigned) is excluded.
      await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_email_slug ON agents ("emailSlug") WHERE "emailSlug" <> ''`);
      if (!(await hasColumn(db, 'agent_events', 'emailDeliveredAt'))) {
        await db.query(`ALTER TABLE agent_events ADD COLUMN "emailDeliveredAt" TEXT`);
      }
    },
  },
  {
    id: '0021-web-push',
    up: async (db) => {
      if (!(await hasColumn(db, 'agent_events', 'pushDeliveredAt'))) {
        await db.query(`ALTER TABLE agent_events ADD COLUMN "pushDeliveredAt" TEXT`);
      }
      await db.query(`
        CREATE TABLE IF NOT EXISTS push_subscriptions (
          "id" TEXT PRIMARY KEY,
          "endpoint" TEXT NOT NULL,
          "p256dh" TEXT NOT NULL,
          "auth" TEXT NOT NULL,
          "userAgent" TEXT NOT NULL DEFAULT '',
          "createdAt" TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_push_subscriptions_endpoint ON push_subscriptions ("endpoint");
      `);
    },
  },
  {
    id: '0022-loop-state',
    up: async (db) => {
      // Event triggers (docs/triggers.md): per-loop poll cursor + last-fired.
      await db.query(`CREATE TABLE IF NOT EXISTS loop_state (
        "loopKey" TEXT PRIMARY KEY,
        "agentId" TEXT NOT NULL,
        "loopName" TEXT NOT NULL,
        "cursor" TEXT NOT NULL DEFAULT '{}',
        "lastPolledAt" TEXT,
        "lastFiredAt" TEXT,
        "lastErrorAt" TEXT,
        "updatedAt" TEXT NOT NULL
      )`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_loop_state_agent ON loop_state ("agentId")`);
    },
  },
  {
    id: '0022-portability-skill-outcomes',
    up: async (db) => {
      // Which skills a turn loaded, so a rating on the turn reaches them.
      if (!(await hasColumn(db, 'chat_turns', 'skillsUsed'))) {
        await db.query(`ALTER TABLE chat_turns ADD COLUMN "skillsUsed" TEXT NOT NULL DEFAULT '[]'`);
      }
      const skillCols: Array<[string, string]> = [
        ['scanReport', `TEXT NOT NULL DEFAULT ''`],
        ['useCount', 'INTEGER NOT NULL DEFAULT 0'],
        ['upCount', 'INTEGER NOT NULL DEFAULT 0'],
        ['downCount', 'INTEGER NOT NULL DEFAULT 0'],
        ['lastUsedAt', 'TEXT'],
        ['pendingRevision', `TEXT NOT NULL DEFAULT ''`],
        ['history', `TEXT NOT NULL DEFAULT '[]'`],
      ];
      for (const [col, ddl] of skillCols) {
        if (!(await hasColumn(db, 'skills', col))) {
          await db.query(`ALTER TABLE skills ADD COLUMN "${col}" ${ddl}`);
        }
      }
      await db.query(`CREATE TABLE IF NOT EXISTS skill_outcomes (
        "id" TEXT PRIMARY KEY,
        "skillId" TEXT NOT NULL,
        "turnId" TEXT NOT NULL,
        "rating" TEXT NOT NULL,
        "note" TEXT NOT NULL DEFAULT '',
        "createdAt" TEXT NOT NULL
      )`);
      // One row per (skill, turn): re-rating a turn updates, never doubles.
      await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_outcomes_skill_turn ON skill_outcomes ("skillId", "turnId")`);
      // Skill names are unique per *scope*, and since agent-private skills
      // landed (0009) the scope includes the owning agent: two agents may
      // each have their own "close-month" — SkillsService.list/create already
      // reason that way, and an AGENT.json copy of an agent brings its
      // private skills along. The 0002 index ignored agentId and made the
      // copy fail; replace it.
      await db.query('DROP INDEX IF EXISTS idx_skills_scope_name');
      await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_scope_agent_name ON skills (COALESCE("workspaceId", ''), COALESCE("agentId", ''), "name")`);
    },
  },
  {
    id: '0024-computer-control',
    up: async (db) => {
      await db.query(`CREATE TABLE IF NOT EXISTS computer_runners (
        "id" TEXT PRIMARY KEY,
        "name" TEXT NOT NULL,
        "platform" TEXT NOT NULL DEFAULT '',
        "scopes" TEXT NOT NULL DEFAULT '[]',
        "tokenHash" TEXT NOT NULL,
        "paused" INTEGER NOT NULL DEFAULT 0,
        "pairedAt" TEXT NOT NULL,
        "lastSeenAt" TEXT
      )`);
      await db.query(`CREATE TABLE IF NOT EXISTS computer_actions (
        "id" TEXT PRIMARY KEY,
        "runnerId" TEXT NOT NULL,
        "sessionId" TEXT NOT NULL DEFAULT '',
        "tool" TEXT NOT NULL,
        "inputSummary" TEXT NOT NULL DEFAULT '',
        "status" TEXT NOT NULL DEFAULT 'queued',
        "resultSummary" TEXT NOT NULL DEFAULT '',
        "screenshotPath" TEXT NOT NULL DEFAULT '',
        "createdAt" TEXT NOT NULL,
        "completedAt" TEXT
      )`);
      // Settings → Computer lists the last 50 by time.
      await db.query(`CREATE INDEX IF NOT EXISTS idx_computer_actions_created ON computer_actions ("createdAt")`);
    },
  },
];

/** Advisory-lock key serializing migration runs: two instances booting
 *  against the same database would otherwise both pass the hasColumn checks
 *  and race the ALTERs (the second crashes boot). Held on one session, so
 *  callers must pass a dedicated single connection (a pool client, PGlite),
 *  never the pool itself — a pool would put lock/unlock on different
 *  sessions. PGlite implements pg_advisory_lock too (single-connection, so
 *  effectively uncontended). */
const MIGRATION_LOCK_KEY = 727274;

export async function runPgMigrations(db: Queryable, logger: { log: (msg: string) => void }): Promise<void> {
  await db.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
  try {
    await db.query('CREATE TABLE IF NOT EXISTS __migrations ("id" TEXT PRIMARY KEY, "appliedAt" TEXT NOT NULL)');
    const res = await db.query('SELECT "id" FROM __migrations');
    const applied = new Set((res.rows as Array<{ id: string }>).map((r) => r.id));
    for (const m of MIGRATIONS) {
      if (applied.has(m.id)) continue;
      await m.up(db);
      await db.query('INSERT INTO __migrations ("id", "appliedAt") VALUES ($1, $2)', [m.id, new Date().toISOString()]);
      logger.log(`applied migration ${m.id}`);
    }
    // Data repair on every boot (not a tracked migration): turns are created
    // 'running' and finalized in-process, so a crash mid-turn orphans them.
    // Reap them to 'error' so they stop rendering as live.
    const reaped = await db.query(`UPDATE chat_turns SET "status" = 'error' WHERE "status" = 'running'`);
    const reapedCount = (reaped as { rowCount?: number }).rowCount ?? 0;
    if (reapedCount > 0) logger.log(`reaped ${reapedCount} orphaned running turn(s)`);
  } finally {
    await db.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
  }
}
