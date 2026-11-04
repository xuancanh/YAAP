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
import { backfillTaskKeys } from '../common/task-keys';
import { backfillWorkTracking } from './work-tracking-backfill';
import { repairAgentModels } from './model-repair';
import { personalityForId } from '../agents/personalities';

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
  {
    id: '0025-registry',
    up: async (db) => {
      // The market registry (docs/registry.md). accountId is present from
      // the start so the tenancy work (item 7) finds nothing to backfill.
      await db.query(`CREATE TABLE IF NOT EXISTS registry_items (
        "id" TEXT PRIMARY KEY,
        "accountId" TEXT NOT NULL DEFAULT 'single',
        "kind" TEXT NOT NULL,
        "slug" TEXT NOT NULL,
        "name" TEXT NOT NULL,
        "description" TEXT NOT NULL DEFAULT '',
        "version" INTEGER NOT NULL DEFAULT 1,
        "publisherName" TEXT NOT NULL DEFAULT '',
        "manifest" TEXT NOT NULL DEFAULT '{}',
        "capabilities" TEXT NOT NULL DEFAULT '{}',
        "scanReport" TEXT NOT NULL DEFAULT '{}',
        "installs" INTEGER NOT NULL DEFAULT 0,
        "ratingUp" INTEGER NOT NULL DEFAULT 0,
        "ratingDown" INTEGER NOT NULL DEFAULT 0,
        "published" INTEGER NOT NULL DEFAULT 1,
        "source" TEXT NOT NULL DEFAULT 'local',
        "remoteUrl" TEXT NOT NULL DEFAULT '',
        "sourceRef" TEXT NOT NULL DEFAULT '',
        "publishedAt" TEXT NOT NULL,
        "updatedAt" TEXT NOT NULL
      )`);
      // One listing per (account, kind, slug): a re-publish bumps the version.
      await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_registry_items_slug ON registry_items ("accountId", "kind", "slug")`);
      await db.query(`CREATE TABLE IF NOT EXISTS registry_installs (
        "id" TEXT PRIMARY KEY,
        "accountId" TEXT NOT NULL DEFAULT 'single',
        "itemId" TEXT NOT NULL,
        "version" INTEGER NOT NULL DEFAULT 1,
        "agentId" TEXT,
        "skillId" TEXT,
        "appId" TEXT,
        "installedAt" TEXT NOT NULL
      )`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_registry_installs_item ON registry_installs ("itemId")`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_registry_installs_agent ON registry_installs ("agentId")`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_registry_installs_skill ON registry_installs ("skillId")`);
      await db.query(`CREATE TABLE IF NOT EXISTS registry_ratings (
        "id" TEXT PRIMARY KEY,
        "accountId" TEXT NOT NULL DEFAULT 'single',
        "itemId" TEXT NOT NULL,
        "installId" TEXT NOT NULL DEFAULT '',
        "turnId" TEXT NOT NULL DEFAULT '',
        "rating" TEXT NOT NULL,
        "note" TEXT NOT NULL DEFAULT '',
        "createdAt" TEXT NOT NULL
      )`);
      // A re-rated turn updates its row instead of doubling the counters.
      await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_registry_ratings_install_turn ON registry_ratings ("installId", "turnId") WHERE "turnId" <> ''`);
    },
  },
  {
    id: '0026-organizations',
    up: async (db) => {
      // Autonomous company (docs/autonomous-company.md, execution plan item 14).
      // Every table carries accountId with the single-tenant default so item 7
      // (tenancy) can backfill without a second migration.
      await db.query(`
        CREATE TABLE IF NOT EXISTS organizations (
          "id" TEXT PRIMARY KEY,
          "accountId" TEXT NOT NULL DEFAULT 'single',
          "workspaceId" TEXT NOT NULL,
          "name" TEXT NOT NULL,
          "mission" TEXT NOT NULL DEFAULT '',
          "ceoUserNote" TEXT NOT NULL DEFAULT '',
          "chiefOfStaffAgentId" TEXT,
          "status" TEXT NOT NULL DEFAULT 'active',
          "monthlyBudgetUsd" REAL NOT NULL DEFAULT 0,
          "maxDepth" INTEGER NOT NULL DEFAULT 3,
          "maxDirectReports" INTEGER NOT NULL DEFAULT 5,
          "briefHour" INTEGER NOT NULL DEFAULT 8,
          "lastBriefAt" TEXT,
          "lastBrief" TEXT NOT NULL DEFAULT '',
          "createdAt" TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS org_members (
          "id" TEXT PRIMARY KEY,
          "accountId" TEXT NOT NULL DEFAULT 'single',
          "orgId" TEXT NOT NULL,
          "agentId" TEXT NOT NULL,
          "title" TEXT NOT NULL DEFAULT '',
          "reportsToAgentId" TEXT,
          "depth" INTEGER NOT NULL DEFAULT 1,
          "sponsor" TEXT NOT NULL DEFAULT 'user',
          "scopes" TEXT NOT NULL DEFAULT '[]',
          "status" TEXT NOT NULL DEFAULT 'active',
          "charterHash" TEXT NOT NULL DEFAULT '',
          "joinedAt" TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_org_members_org_agent ON org_members ("orgId", "agentId");
        CREATE TABLE IF NOT EXISTS org_goals (
          "id" TEXT PRIMARY KEY,
          "accountId" TEXT NOT NULL DEFAULT 'single',
          "orgId" TEXT NOT NULL,
          "title" TEXT NOT NULL,
          "description" TEXT NOT NULL DEFAULT '',
          "status" TEXT NOT NULL DEFAULT 'active',
          "ownerAgentId" TEXT,
          "createdAt" TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS org_projects (
          "id" TEXT PRIMARY KEY,
          "accountId" TEXT NOT NULL DEFAULT 'single',
          "orgId" TEXT NOT NULL,
          "goalId" TEXT,
          "title" TEXT NOT NULL,
          "status" TEXT NOT NULL DEFAULT 'active',
          "ownerAgentId" TEXT,
          "createdAt" TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS org_tasks (
          "id" TEXT PRIMARY KEY,
          "accountId" TEXT NOT NULL DEFAULT 'single',
          "orgId" TEXT NOT NULL,
          "projectId" TEXT,
          "parentTaskId" TEXT,
          "title" TEXT NOT NULL,
          "brief" TEXT NOT NULL DEFAULT '{}',
          "status" TEXT NOT NULL DEFAULT 'backlog',
          "assigneeAgentId" TEXT,
          "claimedBy" TEXT,
          "claimedAt" TEXT,
          "reviewerAgentId" TEXT,
          "reviewRounds" INTEGER NOT NULL DEFAULT 0,
          "blockers" TEXT NOT NULL DEFAULT '[]',
          "fileScope" TEXT NOT NULL DEFAULT '[]',
          "noProgressCount" INTEGER NOT NULL DEFAULT 0,
          "lastRunAt" TEXT,
          "createdBy" TEXT NOT NULL DEFAULT 'user',
          "createdAt" TEXT NOT NULL,
          "updatedAt" TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_org_tasks_org ON org_tasks ("orgId", "status");
        CREATE TABLE IF NOT EXISTS org_runs (
          "id" TEXT PRIMARY KEY,
          "accountId" TEXT NOT NULL DEFAULT 'single',
          "orgId" TEXT NOT NULL,
          "taskId" TEXT NOT NULL,
          "agentId" TEXT NOT NULL,
          "sessionId" TEXT,
          "wakeReason" TEXT NOT NULL DEFAULT 'manual',
          "status" TEXT NOT NULL DEFAULT 'running',
          "outcome" TEXT NOT NULL DEFAULT '',
          "tokensIn" INTEGER NOT NULL DEFAULT 0,
          "tokensOut" INTEGER NOT NULL DEFAULT 0,
          "usd" REAL NOT NULL DEFAULT 0,
          "reservedUsd" REAL NOT NULL DEFAULT 0,
          "startedAt" TEXT NOT NULL,
          "endedAt" TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_org_runs_task ON org_runs ("taskId");
        CREATE TABLE IF NOT EXISTS org_budgets (
          "id" TEXT PRIMARY KEY,
          "accountId" TEXT NOT NULL DEFAULT 'single',
          "orgId" TEXT NOT NULL,
          "scope" TEXT NOT NULL,
          "refId" TEXT NOT NULL,
          "monthlyUsd" REAL NOT NULL DEFAULT 0,
          "reservedUsd" REAL NOT NULL DEFAULT 0,
          "spentUsd" REAL NOT NULL DEFAULT 0,
          "month" TEXT NOT NULL DEFAULT '',
          "warnedAt" TEXT
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_org_budgets_scope ON org_budgets ("orgId", "scope", "refId");
        CREATE TABLE IF NOT EXISTS org_grants (
          "id" TEXT PRIMARY KEY,
          "accountId" TEXT NOT NULL DEFAULT 'single',
          "orgId" TEXT NOT NULL,
          "agentId" TEXT NOT NULL,
          "kind" TEXT NOT NULL,
          "value" TEXT NOT NULL,
          "grantedBy" TEXT NOT NULL DEFAULT 'user',
          "createdAt" TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_org_grants_agent ON org_grants ("orgId", "agentId");
        CREATE TABLE IF NOT EXISTS org_approvals (
          "id" TEXT PRIMARY KEY,
          "accountId" TEXT NOT NULL DEFAULT 'single',
          "orgId" TEXT NOT NULL,
          "kind" TEXT NOT NULL,
          "payload" TEXT NOT NULL DEFAULT '{}',
          "requestedBy" TEXT NOT NULL DEFAULT '',
          "recommendation" TEXT NOT NULL DEFAULT '',
          "status" TEXT NOT NULL DEFAULT 'pending',
          "decidedAt" TEXT,
          "decisionNote" TEXT NOT NULL DEFAULT '',
          "expiresAt" TEXT,
          "createdAt" TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_org_approvals_org ON org_approvals ("orgId", "status");
        CREATE TABLE IF NOT EXISTS org_audit (
          "id" TEXT PRIMARY KEY,
          "accountId" TEXT NOT NULL DEFAULT 'single',
          "orgId" TEXT NOT NULL,
          "seq" INTEGER NOT NULL,
          "actor" TEXT NOT NULL,
          "action" TEXT NOT NULL,
          "refType" TEXT NOT NULL DEFAULT '',
          "refId" TEXT NOT NULL DEFAULT '',
          "payload" TEXT NOT NULL DEFAULT '{}',
          "prevHash" TEXT NOT NULL DEFAULT '',
          "hash" TEXT NOT NULL,
          "createdAt" TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_org_audit_seq ON org_audit ("orgId", "seq");
        CREATE TABLE IF NOT EXISTS org_messages (
          "id" TEXT PRIMARY KEY,
          "accountId" TEXT NOT NULL DEFAULT 'single',
          "orgId" TEXT NOT NULL,
          "taskId" TEXT,
          "fromAgentId" TEXT,
          "runId" TEXT,
          "text" TEXT NOT NULL,
          "createdAt" TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_org_messages_org ON org_messages ("orgId", "createdAt");
      `);
    },
  },
  {
    id: '0023-accounts',
    up: async (db) => {
      // Tenancy (docs/accounts.md, execution-plan item 7). The account tables
      // first, then every existing table gains "accountId" with the single
      // account as its backfill value — ensureAccountColumns() below does the
      // ALTERs, and keeps doing them on every boot for tables created later.
      await db.query(`CREATE TABLE IF NOT EXISTS accounts (
        "id" TEXT PRIMARY KEY,
        "email" TEXT NOT NULL DEFAULT '',
        "name" TEXT NOT NULL DEFAULT '',
        "status" TEXT NOT NULL DEFAULT 'pending',
        "plan" TEXT NOT NULL DEFAULT 'free',
        "createdAt" TEXT NOT NULL,
        "lastSeenAt" TEXT
      )`);
      await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_email ON accounts ("email") WHERE "email" <> ''`);
      await db.query(`CREATE TABLE IF NOT EXISTS account_sessions (
        "id" TEXT PRIMARY KEY,
        "accountId" TEXT NOT NULL,
        "tokenHash" TEXT NOT NULL,
        "expiresAt" TEXT NOT NULL,
        "userAgent" TEXT NOT NULL DEFAULT '',
        "createdAt" TEXT NOT NULL
      )`);
      await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_account_sessions_token ON account_sessions ("tokenHash")`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_account_sessions_account ON account_sessions ("accountId")`);
      await db.query(`CREATE TABLE IF NOT EXISTS account_login_tokens (
        "id" TEXT PRIMARY KEY,
        "accountId" TEXT NOT NULL,
        "email" TEXT NOT NULL,
        "tokenHash" TEXT NOT NULL,
        "expiresAt" TEXT NOT NULL,
        "usedAt" TEXT,
        "createdAt" TEXT NOT NULL
      )`);
      await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_account_login_tokens_token ON account_login_tokens ("tokenHash")`);
      await db.query(`CREATE TABLE IF NOT EXISTS account_usage (
        "accountId" TEXT NOT NULL,
        "month" TEXT NOT NULL,
        "tokensIn" INTEGER NOT NULL DEFAULT 0,
        "tokensOut" INTEGER NOT NULL DEFAULT 0,
        "usdMicros" INTEGER NOT NULL DEFAULT 0,
        "hostedUsdMicros" INTEGER NOT NULL DEFAULT 0,
        "turns" INTEGER NOT NULL DEFAULT 0,
        "updatedAt" TEXT NOT NULL,
        PRIMARY KEY ("accountId", "month")
      )`);
      // The single account: owner of every row that exists today, and the
      // only account AUTH_MODE=single ever uses. BYO plan, no ceilings — a
      // self-hosted install is its own platform.
      await db.query(
        `INSERT INTO accounts ("id", "email", "name", "status", "plan", "createdAt") VALUES ($1, '', 'Single user', 'active', 'byo', $2) ON CONFLICT ("id") DO NOTHING`,
        [SINGLE_ACCOUNT_ID, new Date().toISOString()],
      );
      await ensureAccountColumns(db);
      // app_settings was keyed by "key" alone; settings are per account now.
      const pk = await db.query(
        `SELECT 1 FROM information_schema.key_column_usage WHERE table_name = 'app_settings' AND column_name = 'accountId' AND constraint_name = 'app_settings_pkey'`,
      );
      if (pk.rows.length === 0) {
        await db.query('ALTER TABLE app_settings DROP CONSTRAINT IF EXISTS app_settings_pkey');
        await db.query('ALTER TABLE app_settings ADD PRIMARY KEY ("accountId", "key")');
      }
      // Skill names are unique per account scope, not globally: every
      // account seeds its own built-ins.
      await db.query('DROP INDEX IF EXISTS idx_skills_scope_agent_name');
      await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_account_scope_agent_name ON skills ("accountId", COALESCE("workspaceId", ''), COALESCE("agentId", ''), "name")`);
    },
  },
  {
    id: '0027-shared-agents',
    up: async (db) => {
      // Shared workspaces (docs/shared-agents.md, execution-plan item 8) and
      // the autonomous company's phase D (humans in an organisation).
      // Idempotent: every statement is IF NOT EXISTS / hasColumn-guarded.
      await db.query(`CREATE TABLE IF NOT EXISTS workspace_members (
        "accountId" TEXT NOT NULL DEFAULT 'single',
        "id" TEXT PRIMARY KEY,
        "workspaceId" TEXT NOT NULL,
        "memberAccountId" TEXT NOT NULL,
        "role" TEXT NOT NULL DEFAULT 'member',
        "displayName" TEXT NOT NULL DEFAULT '',
        "email" TEXT NOT NULL DEFAULT '',
        "invitedBy" TEXT NOT NULL DEFAULT '',
        "joinedAt" TEXT NOT NULL
      )`);
      await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_members_ws_member ON workspace_members ("workspaceId", "memberAccountId")`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_workspace_members_member ON workspace_members ("memberAccountId")`);
      await db.query(`CREATE TABLE IF NOT EXISTS workspace_invites (
        "accountId" TEXT NOT NULL DEFAULT 'single',
        "id" TEXT PRIMARY KEY,
        "workspaceId" TEXT NOT NULL,
        "email" TEXT NOT NULL,
        "role" TEXT NOT NULL DEFAULT 'member',
        "tokenHash" TEXT NOT NULL,
        "invitedBy" TEXT NOT NULL DEFAULT '',
        "expiresAt" TEXT NOT NULL,
        "acceptedAt" TEXT,
        "acceptedBy" TEXT NOT NULL DEFAULT '',
        "createdAt" TEXT NOT NULL
      )`);
      await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_invites_token ON workspace_invites ("tokenHash")`);
      await db.query(`CREATE TABLE IF NOT EXISTS workspace_flow_rules (
        "accountId" TEXT NOT NULL DEFAULT 'single',
        "id" TEXT PRIMARY KEY,
        "workspaceId" TEXT NOT NULL,
        "fromMember" TEXT NOT NULL,
        "toMember" TEXT NOT NULL DEFAULT '*',
        "effect" TEXT NOT NULL DEFAULT 'allow',
        "kind" TEXT NOT NULL,
        "createdAt" TEXT NOT NULL
      )`);
      await db.query(`CREATE TABLE IF NOT EXISTS member_channels (
        "accountId" TEXT NOT NULL DEFAULT 'single',
        "id" TEXT PRIMARY KEY,
        "workspaceId" TEXT NOT NULL,
        "memberAccountId" TEXT NOT NULL,
        "kind" TEXT NOT NULL,
        "address" TEXT NOT NULL,
        "createdAt" TEXT NOT NULL
      )`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_member_channels_address ON member_channels ("kind", "address")`);
      await db.query(`CREATE TABLE IF NOT EXISTS org_humans (
        "accountId" TEXT NOT NULL DEFAULT 'single',
        "id" TEXT PRIMARY KEY,
        "orgId" TEXT NOT NULL,
        "memberAccountId" TEXT NOT NULL,
        "role" TEXT NOT NULL DEFAULT 'observer',
        "createdAt" TEXT NOT NULL
      )`);
      await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_org_humans_org_member ON org_humans ("orgId", "memberAccountId")`);
      const add = async (table: string, column: string, ddl: string) => {
        if (!(await hasColumn(db, table, column))) await db.query(`ALTER TABLE ${table} ADD COLUMN "${column}" ${ddl}`);
      };
      await add('connection_grants', 'memberAccountId', "TEXT NOT NULL DEFAULT ''");
      await add('agent_lessons', 'audience', "TEXT NOT NULL DEFAULT 'shared'");
      await add('chat_sessions', 'initiatedBy', "TEXT NOT NULL DEFAULT ''");
      await add('chat_sessions', 'shared', 'INTEGER NOT NULL DEFAULT 0');
      await add('chat_messages', 'authorAccountId', "TEXT NOT NULL DEFAULT ''");
      await add('agent_events', 'forMemberAccountId', "TEXT NOT NULL DEFAULT ''");
      await add('workspaces', 'profilePrivate', "TEXT NOT NULL DEFAULT '{}'");
      await add('org_approvals', 'decidedBy', "TEXT NOT NULL DEFAULT ''");
    },
  },
  {
    id: '0028-org-mode',
    up: async (db) => {
      // Workspace is the company (docs/group-chat.md §5, execution-plan item
      // 16): the organization folds into the workspace. Idempotent.
      const add = async (table: string, column: string, ddl: string) => {
        if (!(await hasColumn(db, table, column))) await db.query(`ALTER TABLE ${table} ADD COLUMN "${column}" ${ddl}`);
      };
      await add('workspaces', 'orgMode', "TEXT NOT NULL DEFAULT 'off'");
      await add('workspaces', 'chiefOfStaffAgentId', 'TEXT');
      await add('workspaces', 'orgMonthlyUsd', 'REAL NOT NULL DEFAULT 0');
      await add('workspaces', 'orgAgentCap', 'INTEGER NOT NULL DEFAULT 12');
      // One organization per workspace: keep the oldest, archive the rest
      // (their rows and tables stay; archived orgs never run).
      await db.query(`UPDATE organizations SET "status" = 'archived'
        WHERE "status" <> 'archived' AND "id" NOT IN (
          SELECT DISTINCT ON ("workspaceId") "id" FROM organizations WHERE "status" <> 'archived' ORDER BY "workspaceId", "createdAt" ASC, "id" ASC
        )`);
      await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_organizations_workspace_live ON organizations ("workspaceId") WHERE "status" <> 'archived'`);
      // Workspaces that already had an organization keep today's behaviour:
      // supervised mode, the org's chief and envelope.
      await db.query(`UPDATE workspaces w SET
          "orgMode" = 'supervised',
          "chiefOfStaffAgentId" = o."chiefOfStaffAgentId",
          "orgMonthlyUsd" = o."monthlyBudgetUsd"
        FROM organizations o
        WHERE o."workspaceId" = w."id" AND o."status" <> 'archived' AND w."orgMode" = 'off'`);
    },
  },
  {
    id: '0029-group-chat',
    up: async (db) => {
      // Group chat (docs/group-chat.md §1, execution-plan item 15): channels,
      // their members, messages and read cursors; task ↔ message linkage on
      // both task tables; `#general` backfilled into every existing
      // workspace. Idempotent: IF NOT EXISTS / hasColumn-guarded / NOT EXISTS.
      await db.query(`CREATE TABLE IF NOT EXISTS channels (
        "accountId" TEXT NOT NULL DEFAULT 'single',
        "id" TEXT PRIMARY KEY,
        "workspaceId" TEXT NOT NULL,
        "slug" TEXT NOT NULL,
        "name" TEXT NOT NULL,
        "topic" TEXT NOT NULL DEFAULT '',
        "kind" TEXT NOT NULL DEFAULT 'public',
        "createdBy" TEXT NOT NULL DEFAULT 'system',
        "folder" TEXT NOT NULL DEFAULT '',
        "dailyTokenBudget" INTEGER NOT NULL DEFAULT 0,
        "archivedAt" TEXT,
        "createdAt" TEXT NOT NULL
      )`);
      await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_ws_slug ON channels ("workspaceId", "slug")`);
      await db.query(`CREATE TABLE IF NOT EXISTS channel_members (
        "accountId" TEXT NOT NULL DEFAULT 'single',
        "id" TEXT PRIMARY KEY,
        "channelId" TEXT NOT NULL,
        "memberKind" TEXT NOT NULL,
        "memberId" TEXT NOT NULL,
        "role" TEXT NOT NULL DEFAULT 'member',
        "notify" TEXT NOT NULL DEFAULT 'mentions',
        "unprompted" INTEGER NOT NULL DEFAULT 0,
        "joinedAt" TEXT NOT NULL
      )`);
      await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_members_unique ON channel_members ("channelId", "memberKind", "memberId")`);
      await db.query(`CREATE TABLE IF NOT EXISTS channel_messages (
        "accountId" TEXT NOT NULL DEFAULT 'single',
        "id" TEXT PRIMARY KEY,
        "channelId" TEXT NOT NULL,
        "threadRootId" TEXT,
        "authorKind" TEXT NOT NULL,
        "authorId" TEXT NOT NULL DEFAULT '',
        "text" TEXT NOT NULL DEFAULT '',
        "attachments" TEXT NOT NULL DEFAULT '[]',
        "mentions" TEXT NOT NULL DEFAULT '[]',
        "taskId" TEXT,
        "runId" TEXT,
        "unprompted" INTEGER NOT NULL DEFAULT 0,
        "editedAt" TEXT,
        "createdAt" TEXT NOT NULL
      )`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_channel_messages_channel ON channel_messages ("channelId", "createdAt")`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_channel_messages_thread ON channel_messages ("threadRootId")`);
      // Same FTS shape as chat_messages (0006): the workspace search joins in.
      await db.query(`CREATE INDEX IF NOT EXISTS idx_channel_messages_fts ON channel_messages USING GIN (to_tsvector('english', "text"))`);
      await db.query(`CREATE TABLE IF NOT EXISTS channel_reads (
        "accountId" TEXT NOT NULL DEFAULT 'single',
        "id" TEXT PRIMARY KEY,
        "channelId" TEXT NOT NULL,
        "memberAccountId" TEXT NOT NULL,
        "lastReadMessageId" TEXT NOT NULL DEFAULT '',
        "lastReadAt" TEXT NOT NULL
      )`);
      await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_reads_unique ON channel_reads ("channelId", "memberAccountId")`);
      const add = async (table: string, column: string, ddl: string) => {
        if (!(await hasColumn(db, table, column))) await db.query(`ALTER TABLE ${table} ADD COLUMN "${column}" ${ddl}`);
      };
      await add('agent_tasks', 'channelId', 'TEXT');
      await add('agent_tasks', 'messageId', 'TEXT');
      await add('org_tasks', 'channelId', 'TEXT');
      await add('org_tasks', 'messageId', 'TEXT');
      // #general for every workspace that lacks one (new workspaces get it
      // from WorkspacesService.create → GroupChatService.ensureGeneral).
      await db.query(`
        INSERT INTO channels ("accountId", "id", "workspaceId", "slug", "name", "topic", "kind", "createdBy", "folder", "createdAt")
        SELECT w."accountId", md5(random()::text || w."id"), w."id", 'general', 'general',
               'Everyone in this workspace — people and agents.', 'public', 'system', 'channels/general', $1
        FROM workspaces w
        WHERE NOT EXISTS (SELECT 1 FROM channels c WHERE c."workspaceId" = w."id" AND c."slug" = 'general')
      `, [new Date().toISOString()]);
    },
  },
  {
    id: '0030-org-units',
    up: async (db) => {
      // Units (docs/group-chat.md §7, execution-plan item 17): a board, a
      // channel and a goal tracker per org level. Idempotent.
      await db.query(`CREATE TABLE IF NOT EXISTS org_units (
        "accountId" TEXT NOT NULL DEFAULT 'single',
        "id" TEXT PRIMARY KEY,
        "orgId" TEXT NOT NULL,
        "leadAgentId" TEXT NOT NULL,
        "parentUnitId" TEXT,
        "name" TEXT NOT NULL,
        "slug" TEXT NOT NULL,
        "channelId" TEXT,
        "archivedAt" TEXT,
        "createdAt" TEXT NOT NULL
      )`);
      await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_org_units_lead ON org_units ("orgId", "leadAgentId")`);
      const add = async (table: string, column: string, ddl: string) => {
        if (!(await hasColumn(db, table, column))) await db.query(`ALTER TABLE ${table} ADD COLUMN "${column}" ${ddl}`);
      };
      await add('org_tasks', 'unitId', 'TEXT');
      await add('org_tasks', 'unitExplicit', 'INTEGER NOT NULL DEFAULT 0');
      await add('org_goals', 'unitId', 'TEXT');
      await add('org_goals', 'parentGoalId', 'TEXT');
      await backfillOrgUnits(db);
    },
  },
  {
    id: '0031-org-intent',
    up: async (db) => {
      // Intent (docs/company-vision.md §2, execution-plan item 18): goals
      // gain a kind (vision | objective | key_result) and the key-result
      // fields; check-ins get a table; the organization keeps the CEO's rules
      // and the chief's latest strategy memo. Idempotent.
      const add = async (table: string, column: string, ddl: string) => {
        if (!(await hasColumn(db, table, column))) await db.query(`ALTER TABLE ${table} ADD COLUMN "${column}" ${ddl}`);
      };
      await add('org_goals', 'kind', `TEXT NOT NULL DEFAULT 'objective'`);
      await add('org_goals', 'metric', `TEXT NOT NULL DEFAULT ''`);
      await add('org_goals', 'targetValue', 'REAL');
      await add('org_goals', 'currentValue', 'REAL');
      await add('org_goals', 'startValue', 'REAL');
      await add('org_goals', 'unitLabel', `TEXT NOT NULL DEFAULT ''`);
      await add('org_goals', 'dueAt', 'TEXT');
      await add('org_goals', 'confidence', 'REAL');
      await add('org_goals', 'atRisk', 'INTEGER NOT NULL DEFAULT 0');
      await add('org_goals', 'atRiskReason', `TEXT NOT NULL DEFAULT ''`);
      await add('org_goals', 'lastCheckInAt', 'TEXT');
      await add('org_goals', 'checkInCadenceDays', 'INTEGER NOT NULL DEFAULT 7');
      await db.query(`CREATE TABLE IF NOT EXISTS org_checkins (
        "accountId" TEXT NOT NULL DEFAULT 'single',
        "id" TEXT PRIMARY KEY,
        "orgId" TEXT NOT NULL,
        "goalId" TEXT NOT NULL,
        "actor" TEXT NOT NULL DEFAULT 'user',
        "currentValue" REAL,
        "confidence" REAL,
        "note" TEXT NOT NULL DEFAULT '',
        "createdAt" TEXT NOT NULL
      )`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_org_checkins_goal ON org_checkins ("goalId", "createdAt")`);
      await add('organizations', 'rules', `TEXT NOT NULL DEFAULT ''`);
      await add('organizations', 'strategyMemo', `TEXT NOT NULL DEFAULT ''`);
      await add('organizations', 'strategyMemoAt', 'TEXT');
      // The operating profile and the tunables column (docs/company-vision.md §1b).
      await add('organizations', 'values', `TEXT NOT NULL DEFAULT ''`);
      await add('organizations', 'culture', `TEXT NOT NULL DEFAULT ''`);
      await add('organizations', 'tunables', `TEXT NOT NULL DEFAULT '{}'`);
    },
  },
  {
    id: '0032-org-meetings',
    up: async (db) => {
      // Rituals (docs/company-vision.md §3, execution-plan item 19): meetings
      // as channel threads with minutes, the decision log (§6) and the
      // per-unit cadences. Idempotent; cadence defaults are inserted by
      // OrgMeetingsService when a unit appears (and on the tick), not here.
      await db.query(`CREATE TABLE IF NOT EXISTS org_meetings (
        "accountId" TEXT NOT NULL DEFAULT 'single',
        "id" TEXT PRIMARY KEY,
        "orgId" TEXT NOT NULL,
        "unitId" TEXT,
        "channelId" TEXT,
        "threadRootId" TEXT,
        "kind" TEXT NOT NULL DEFAULT 'adhoc',
        "title" TEXT NOT NULL DEFAULT '',
        "agenda" TEXT NOT NULL DEFAULT '',
        "facilitatorAgentId" TEXT,
        "attendees" TEXT NOT NULL DEFAULT '[]',
        "status" TEXT NOT NULL DEFAULT 'scheduled',
        "scheduledFor" TEXT,
        "startedAt" TEXT,
        "endedAt" TEXT,
        "rounds" INTEGER NOT NULL DEFAULT 0,
        "usd" REAL NOT NULL DEFAULT 0,
        "minutes" TEXT NOT NULL DEFAULT '',
        "createdBy" TEXT NOT NULL DEFAULT 'system',
        "createdAt" TEXT NOT NULL
      )`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_org_meetings_org ON org_meetings ("orgId", "status")`);
      await db.query(`CREATE TABLE IF NOT EXISTS org_decisions (
        "accountId" TEXT NOT NULL DEFAULT 'single',
        "id" TEXT PRIMARY KEY,
        "orgId" TEXT NOT NULL,
        "unitId" TEXT,
        "meetingId" TEXT,
        "approvalId" TEXT,
        "title" TEXT NOT NULL,
        "decision" TEXT NOT NULL DEFAULT '',
        "alternatives" TEXT NOT NULL DEFAULT '',
        "rationale" TEXT NOT NULL DEFAULT '',
        "decidedBy" TEXT NOT NULL DEFAULT '',
        "refType" TEXT NOT NULL DEFAULT '',
        "refId" TEXT NOT NULL DEFAULT '',
        "createdAt" TEXT NOT NULL
      )`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_org_decisions_org ON org_decisions ("orgId")`);
      await db.query(`CREATE TABLE IF NOT EXISTS org_cadences (
        "accountId" TEXT NOT NULL DEFAULT 'single',
        "id" TEXT PRIMARY KEY,
        "orgId" TEXT NOT NULL,
        "unitId" TEXT NOT NULL,
        "kind" TEXT NOT NULL,
        "cron" TEXT NOT NULL,
        "enabled" INTEGER NOT NULL DEFAULT 1,
        "lastRunAt" TEXT,
        "nextRunAt" TEXT,
        "createdAt" TEXT NOT NULL
      )`);
      await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_org_cadences_unit_kind ON org_cadences ("orgId", "unitId", "kind")`);
    },
  },
  {
    id: '0033-org-assurance',
    up: async (db) => {
      // Assurance (docs/company-vision.md §5, execution-plan item 20):
      // model-free signals, daily SLO samples, the auditor's runs. Idempotent.
      await db.query(`CREATE TABLE IF NOT EXISTS org_signals (
        "accountId" TEXT NOT NULL DEFAULT 'single',
        "id" TEXT PRIMARY KEY,
        "orgId" TEXT NOT NULL,
        "unitId" TEXT,
        "kind" TEXT NOT NULL,
        "severity" TEXT NOT NULL DEFAULT 'info',
        "refType" TEXT NOT NULL DEFAULT '',
        "refId" TEXT NOT NULL DEFAULT '',
        "title" TEXT NOT NULL,
        "detail" TEXT NOT NULL DEFAULT '',
        "addresseeKind" TEXT NOT NULL DEFAULT 'chief',
        "addresseeId" TEXT NOT NULL DEFAULT '',
        "dayKey" TEXT NOT NULL,
        "status" TEXT NOT NULL DEFAULT 'open',
        "ackNote" TEXT NOT NULL DEFAULT '',
        "ackedAt" TEXT,
        "resolvedAt" TEXT,
        "createdAt" TEXT NOT NULL
      )`);
      await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_org_signals_dedup ON org_signals ("orgId", "kind", "refId", "dayKey")`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_org_signals_org_status ON org_signals ("orgId", "status")`);
      await db.query(`CREATE TABLE IF NOT EXISTS org_slo_samples (
        "accountId" TEXT NOT NULL DEFAULT 'single',
        "id" TEXT PRIMARY KEY,
        "orgId" TEXT NOT NULL,
        "dayKey" TEXT NOT NULL,
        "metrics" TEXT NOT NULL DEFAULT '{}',
        "createdAt" TEXT NOT NULL
      )`);
      await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_org_slo_samples_day ON org_slo_samples ("orgId", "dayKey")`);
      await db.query(`CREATE TABLE IF NOT EXISTS org_audits (
        "accountId" TEXT NOT NULL DEFAULT 'single',
        "id" TEXT PRIMARY KEY,
        "orgId" TEXT NOT NULL,
        "auditorAgentId" TEXT NOT NULL,
        "trigger" TEXT NOT NULL DEFAULT 'cadence',
        "startedAt" TEXT NOT NULL,
        "endedAt" TEXT,
        "sampled" TEXT NOT NULL DEFAULT '{}',
        "findings" TEXT NOT NULL DEFAULT '[]',
        "summary" TEXT NOT NULL DEFAULT '',
        "singleModel" INTEGER NOT NULL DEFAULT 0,
        "model" TEXT NOT NULL DEFAULT '',
        "usd" REAL NOT NULL DEFAULT 0,
        "status" TEXT NOT NULL DEFAULT 'running',
        "createdAt" TEXT NOT NULL
      )`);
      const add = async (table: string, column: string, ddl: string) => {
        if (!(await hasColumn(db, table, column))) await db.query(`ALTER TABLE ${table} ADD COLUMN "${column}" ${ddl}`);
      };
      await add('organizations', 'auditorAgentId', 'TEXT');
      await add('organizations', 'auditCadenceDays', 'INTEGER NOT NULL DEFAULT 7');
      await add('organizations', 'auditUsdCap', 'REAL NOT NULL DEFAULT 2');
      // Per-org tunables (docs/company-vision.md §1b): JSON { key: number }; item 18 adds the same column idempotently.
      await add('organizations', 'tunables', "TEXT NOT NULL DEFAULT '{}'");
    },
  },
  {
    id: '0034-heartbeat-connection-cards',
    up: async (db) => {
      // Gated heartbeats (docs/company-vision.md §13, execution-plan item 21):
      // one state row per agent, workspace-level heartbeat defaults, and a
      // `heartbeat` loop on every existing agent that has none. Idempotent.
      await db.query(`CREATE TABLE IF NOT EXISTS heartbeat_state (
        "accountId" TEXT NOT NULL DEFAULT 'single',
        "agentId" TEXT PRIMARY KEY,
        "lastBeatAt" TEXT,
        "lastReason" TEXT NOT NULL DEFAULT '',
        "lastRunAt" TEXT,
        "nextDueAt" TEXT,
        "beatsSkipped" INTEGER NOT NULL DEFAULT 0,
        "runsDay" TEXT NOT NULL DEFAULT '',
        "runsToday" INTEGER NOT NULL DEFAULT 0,
        "updatedAt" TEXT NOT NULL
      )`);
      const add = async (table: string, column: string, ddl: string) => {
        if (!(await hasColumn(db, table, column))) await db.query(`ALTER TABLE ${table} ADD COLUMN "${column}" ${ddl}`);
      };
      await add('workspaces', 'heartbeatDefaults', `TEXT NOT NULL DEFAULT '{}'`);
      // Every existing agent gets a heartbeat at boot through the defaults:
      // enabled, workspace cadence, workspace caps.
      await add('agents', 'heartbeatEnabled', 'INTEGER NOT NULL DEFAULT 1');
      await add('agents', 'heartbeatCron', `TEXT NOT NULL DEFAULT ''`);
      await add('agents', 'heartbeatDailyRunCap', 'INTEGER');
      await add('agents', 'heartbeatStaleMinutes', 'INTEGER');
    },
  },
  {
    id: '0035-org-capital',
    up: async (db) => {
      // Capital and the CEO seat (docs/company-vision.md §7–§8, execution-plan
      // item 23): the task class for cost roll-ups and routing, model routing
      // per class on the organization, allocations per objective (what an
      // envelope buys) and plan previews with a veto window. Idempotent.
      const add = async (table: string, column: string, ddl: string) => {
        if (!(await hasColumn(db, table, column))) await db.query(`ALTER TABLE ${table} ADD COLUMN "${column}" ${ddl}`);
      };
      await add('org_tasks', 'class', `TEXT NOT NULL DEFAULT 'general'`);
      await add('organizations', 'routing', `TEXT NOT NULL DEFAULT '{}'`);
      await db.query(`CREATE TABLE IF NOT EXISTS org_allocations (
        "accountId" TEXT NOT NULL DEFAULT 'single',
        "id" TEXT PRIMARY KEY,
        "orgId" TEXT NOT NULL,
        "goalId" TEXT NOT NULL,
        "unitId" TEXT,
        "scope" TEXT NOT NULL DEFAULT '',
        "refId" TEXT NOT NULL DEFAULT '',
        "monthlyUsd" REAL NOT NULL DEFAULT 0,
        "rationale" TEXT NOT NULL DEFAULT '',
        "createdBy" TEXT NOT NULL DEFAULT 'user',
        "createdAt" TEXT NOT NULL
      )`);
      await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_org_allocations_goal ON org_allocations ("orgId", "goalId")`);
      await db.query(`CREATE TABLE IF NOT EXISTS org_plans (
        "accountId" TEXT NOT NULL DEFAULT 'single',
        "id" TEXT PRIMARY KEY,
        "orgId" TEXT NOT NULL,
        "trigger" TEXT NOT NULL DEFAULT 'manual',
        "summary" TEXT NOT NULL DEFAULT '',
        "actions" TEXT NOT NULL DEFAULT '[]',
        "estimateUsd" REAL NOT NULL DEFAULT 0,
        "status" TEXT NOT NULL DEFAULT 'pending',
        "vetoWindowMinutes" INTEGER NOT NULL DEFAULT 30,
        "result" TEXT NOT NULL DEFAULT '[]',
        "createdAt" TEXT NOT NULL,
        "applyAt" TEXT,
        "appliedAt" TEXT,
        "decidedBy" TEXT NOT NULL DEFAULT ''
      )`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_org_plans_org_status ON org_plans ("orgId", "status")`);
    },
  },
  {
    id: '0036-org-blueprints',
    up: async (db) => {
      // Blueprints (docs/company-vision.md §9, execution-plan item 24):
      // companies imported from a COMPANY.json and their measured outcomes,
      // anonymous outcome counters on registry items, and the hybrid human
      // roles — an employee reports to a lead and can own a task. Idempotent.
      const add = async (table: string, column: string, ddl: string) => {
        if (!(await hasColumn(db, table, column))) await db.query(`ALTER TABLE ${table} ADD COLUMN "${column}" ${ddl}`);
      };
      await add('org_tasks', 'assigneeHumanId', 'TEXT');
      await add('org_tasks', 'reviewerHumanId', 'TEXT');
      await add('org_humans', 'reportsToAgentId', 'TEXT');
      await add('org_humans', 'title', `TEXT NOT NULL DEFAULT ''`);
      await add('registry_installs', 'orgId', 'TEXT');
      await db.query(`CREATE TABLE IF NOT EXISTS org_blueprint_imports (
        "accountId" TEXT NOT NULL DEFAULT 'single',
        "id" TEXT PRIMARY KEY,
        "orgId" TEXT NOT NULL,
        "workspaceId" TEXT NOT NULL,
        "itemId" TEXT NOT NULL DEFAULT '',
        "name" TEXT NOT NULL,
        "mode" TEXT NOT NULL DEFAULT 'supervised',
        "monthlyUsd" REAL NOT NULL DEFAULT 0,
        "approvalId" TEXT,
        "firstKeyResultAt" TEXT,
        "envelopeAt" TEXT,
        "importedAt" TEXT NOT NULL
      )`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_org_blueprint_imports_org ON org_blueprint_imports ("orgId")`);
      await db.query(`CREATE TABLE IF NOT EXISTS registry_outcomes (
        "accountId" TEXT NOT NULL DEFAULT 'single',
        "id" TEXT PRIMARY KEY,
        "itemId" TEXT NOT NULL,
        "kind" TEXT NOT NULL,
        "createdAt" TEXT NOT NULL
      )`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_registry_outcomes_item ON registry_outcomes ("itemId")`);
    },
  },
  {
    id: '0037-org-memory',
    up: async (db) => {
      // Memory (docs/company-vision.md §6, execution-plan item 22): playbooks
      // as agent-authored skills with a review and versions. Lessons land in
      // agent_lessons, charter changes in org_approvals, retros in
      // org_meetings — all existing tables. Idempotent.
      await db.query(`CREATE TABLE IF NOT EXISTS org_playbooks (
        "accountId" TEXT NOT NULL DEFAULT 'single',
        "id" TEXT PRIMARY KEY,
        "orgId" TEXT NOT NULL,
        "skillId" TEXT,
        "name" TEXT NOT NULL,
        "title" TEXT NOT NULL,
        "body" TEXT NOT NULL DEFAULT '',
        "ownerAgentId" TEXT,
        "roles" TEXT NOT NULL DEFAULT '[]',
        "status" TEXT NOT NULL DEFAULT 'draft',
        "version" INTEGER NOT NULL DEFAULT 1,
        "sourceTaskId" TEXT,
        "reviewTaskId" TEXT,
        "outcomes" TEXT NOT NULL DEFAULT '{}',
        "why" TEXT NOT NULL DEFAULT '',
        "createdAt" TEXT NOT NULL,
        "updatedAt" TEXT NOT NULL
      )`);
      await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_org_playbooks_name ON org_playbooks ("orgId", "name")`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_org_decisions_meeting ON org_decisions ("orgId", "meetingId")`);
    },
  },
  {
    id: '0038-agents-workspace',
    up: async (db) => {
      // Workspace-owned agents (execution-plan item 26): every agent belongs
      // to exactly one workspace. Backfill rule for existing rows — the
      // workspace of the one live organization the agent is a member of when
      // it is a member of exactly one; otherwise the account's default
      // workspace (its oldest row, the one WorkspacesService ensures). An
      // account with no workspace keeps '' until its first workspace exists.
      // Idempotent: only rows still at '' are touched.
      if (!(await hasColumn(db, 'agents', 'workspaceId'))) {
        await db.query(`ALTER TABLE agents ADD COLUMN "workspaceId" TEXT NOT NULL DEFAULT ''`);
      }
      await db.query(`CREATE INDEX IF NOT EXISTS idx_agents_workspace ON agents ("workspaceId")`);
      await backfillAgentWorkspaces(db);
    },
  },
  {
    id: '0039-org-sensing',
    up: async (db) => {
      // Sensing and executable acceptance (docs/sensing.md, execution-plan
      // item 27): metric sources with provenance-stamped samples, key results
      // bound to a source, model-free task checks and their results.
      // Idempotent.
      await db.query(`CREATE TABLE IF NOT EXISTS org_metric_sources (
        "accountId" TEXT NOT NULL DEFAULT 'single',
        "id" TEXT PRIMARY KEY,
        "orgId" TEXT NOT NULL,
        "name" TEXT NOT NULL,
        "kind" TEXT NOT NULL,
        "config" TEXT NOT NULL DEFAULT '{}',
        "secrets" TEXT NOT NULL DEFAULT '{}',
        "tokenHash" TEXT NOT NULL DEFAULT '',
        "unit" TEXT NOT NULL DEFAULT '',
        "pollMinutes" INTEGER NOT NULL DEFAULT 60,
        "status" TEXT NOT NULL DEFAULT 'pending_approval',
        "lastValue" REAL,
        "lastFetchedAt" TEXT,
        "lastError" TEXT NOT NULL DEFAULT '',
        "failures" INTEGER NOT NULL DEFAULT 0,
        "nextPollAt" TEXT,
        "approvalId" TEXT,
        "activatedAt" TEXT,
        "createdBy" TEXT NOT NULL DEFAULT 'user',
        "createdAt" TEXT NOT NULL
      )`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_org_metric_sources_org ON org_metric_sources ("orgId")`);
      await db.query(`CREATE TABLE IF NOT EXISTS org_metric_samples (
        "accountId" TEXT NOT NULL DEFAULT 'single',
        "id" TEXT PRIMARY KEY,
        "sourceId" TEXT NOT NULL,
        "value" REAL NOT NULL,
        "observedAt" TEXT NOT NULL,
        "fetchedAt" TEXT NOT NULL,
        "provenance" TEXT NOT NULL DEFAULT '{}',
        "createdAt" TEXT NOT NULL
      )`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_org_metric_samples_source ON org_metric_samples ("sourceId", "observedAt")`);
      if (!(await hasColumn(db, 'org_goals', 'metricSourceId'))) await db.query(`ALTER TABLE org_goals ADD COLUMN "metricSourceId" TEXT`);
      if (!(await hasColumn(db, 'org_goals', 'lastMeasuredAt'))) await db.query(`ALTER TABLE org_goals ADD COLUMN "lastMeasuredAt" TEXT`);
      if (!(await hasColumn(db, 'org_tasks', 'checks'))) await db.query(`ALTER TABLE org_tasks ADD COLUMN "checks" TEXT NOT NULL DEFAULT '[]'`);
      if (!(await hasColumn(db, 'org_tasks', 'acceptedBy'))) await db.query(`ALTER TABLE org_tasks ADD COLUMN "acceptedBy" TEXT NOT NULL DEFAULT ''`);
      await db.query(`CREATE TABLE IF NOT EXISTS org_task_checks (
        "accountId" TEXT NOT NULL DEFAULT 'single',
        "id" TEXT PRIMARY KEY,
        "orgId" TEXT NOT NULL,
        "taskId" TEXT NOT NULL,
        "checkIndex" INTEGER NOT NULL,
        "status" TEXT NOT NULL DEFAULT 'pending',
        "detail" TEXT NOT NULL DEFAULT '',
        "evidence" TEXT NOT NULL DEFAULT '{}',
        "ranAt" TEXT NOT NULL
      )`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_org_task_checks_task ON org_task_checks ("taskId", "checkIndex")`);
    },
  },
  {
    id: '0040-org-trust',
    up: async (db) => {
      // The external-action contract and the trust ledger
      // (docs/actions-and-trust.md, execution-plan item 28): the action log
      // with its idempotency key, the ledger's records and levels, and the
      // owner's ceilings per class on the workspace. Idempotent.
      if (!(await hasColumn(db, 'workspaces', 'trustCeilings'))) {
        await db.query(`ALTER TABLE workspaces ADD COLUMN "trustCeilings" TEXT NOT NULL DEFAULT '{}'`);
      }
      await db.query(`CREATE TABLE IF NOT EXISTS action_log (
        "accountId" TEXT NOT NULL DEFAULT 'single',
        "id" TEXT PRIMARY KEY,
        "key" TEXT NOT NULL,
        "workspaceId" TEXT NOT NULL,
        "agentId" TEXT NOT NULL DEFAULT '',
        "sessionId" TEXT NOT NULL,
        "orgId" TEXT,
        "tool" TEXT NOT NULL,
        "class" TEXT NOT NULL,
        "channel" TEXT NOT NULL DEFAULT '',
        "inputHash" TEXT NOT NULL,
        "input" TEXT NOT NULL DEFAULT '{}',
        "status" TEXT NOT NULL DEFAULT 'started',
        "decision" TEXT NOT NULL DEFAULT '',
        "level" INTEGER,
        "keys" TEXT NOT NULL DEFAULT '{}',
        "stagedRef" TEXT NOT NULL DEFAULT '',
        "result" TEXT NOT NULL DEFAULT '',
        "resultHash" TEXT NOT NULL DEFAULT '',
        "dedupeCount" INTEGER NOT NULL DEFAULT 0,
        "revertedAt" TEXT,
        "note" TEXT NOT NULL DEFAULT '',
        "createdAt" TEXT NOT NULL,
        "finishedAt" TEXT
      )`);
      await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_action_log_key ON action_log ("accountId", "key")`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_action_log_ws_class ON action_log ("workspaceId", "class", "createdAt")`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_action_log_agent ON action_log ("agentId", "createdAt")`);
      await db.query(`CREATE TABLE IF NOT EXISTS trust_records (
        "accountId" TEXT NOT NULL DEFAULT 'single',
        "id" TEXT PRIMARY KEY,
        "workspaceId" TEXT NOT NULL,
        "agentId" TEXT NOT NULL,
        "actionClass" TEXT NOT NULL,
        "outcome" TEXT NOT NULL,
        "refType" TEXT NOT NULL DEFAULT '',
        "refId" TEXT NOT NULL DEFAULT '',
        "at" TEXT NOT NULL
      )`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_trust_records_agent ON trust_records ("workspaceId", "agentId", "actionClass", "at")`);
      await db.query(`CREATE TABLE IF NOT EXISTS trust_levels (
        "accountId" TEXT NOT NULL DEFAULT 'single',
        "id" TEXT PRIMARY KEY,
        "workspaceId" TEXT NOT NULL,
        "agentId" TEXT NOT NULL,
        "actionClass" TEXT NOT NULL,
        "level" INTEGER NOT NULL DEFAULT 0,
        "ceiling" INTEGER NOT NULL DEFAULT 0,
        "cleanCount" INTEGER NOT NULL DEFAULT 0,
        "rejectStreak" INTEGER NOT NULL DEFAULT 0,
        "lastIncidentAt" TEXT,
        "lastChangedAt" TEXT,
        "reason" TEXT NOT NULL DEFAULT '',
        "createdAt" TEXT NOT NULL
      )`);
      await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_trust_levels_unique ON trust_levels ("workspaceId", "agentId", "actionClass")`);
    },
  },
  {
    id: '0041-org-incidents',
    up: async (db) => {
      // Incidents, degradation and audit independence (docs/incidents.md,
      // execution-plan item 29): the incident record with its containment
      // steps, one open row per (org, kind, refId); the action classes a
      // critical incident froze; the CEO's spot checks of the auditor, its
      // precision/recall and the rotation flag; the fallback a degraded
      // provider used on a turn. Idempotent.
      await db.query(`CREATE TABLE IF NOT EXISTS org_incidents (
        "accountId" TEXT NOT NULL DEFAULT 'single',
        "id" TEXT PRIMARY KEY,
        "orgId" TEXT NOT NULL,
        "workspaceId" TEXT NOT NULL DEFAULT '',
        "kind" TEXT NOT NULL,
        "severity" TEXT NOT NULL DEFAULT 'minor',
        "status" TEXT NOT NULL DEFAULT 'open',
        "title" TEXT NOT NULL,
        "detail" TEXT NOT NULL DEFAULT '',
        "agentId" TEXT,
        "actionClass" TEXT,
        "refType" TEXT NOT NULL DEFAULT '',
        "refId" TEXT NOT NULL DEFAULT '',
        "detectedBy" TEXT NOT NULL DEFAULT 'system',
        "containment" TEXT NOT NULL DEFAULT '[]',
        "postmortemMeetingId" TEXT,
        "openedAt" TEXT NOT NULL,
        "containedAt" TEXT,
        "resolvedAt" TEXT,
        "resolution" TEXT NOT NULL DEFAULT ''
      )`);
      await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_org_incidents_open ON org_incidents ("orgId", "kind", "refId") WHERE "status" <> 'resolved'`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_org_incidents_org_status ON org_incidents ("orgId", "status")`);
      const add = async (table: string, column: string, ddl: string) => {
        if (!(await hasColumn(db, table, column))) await db.query(`ALTER TABLE ${table} ADD COLUMN "${column}" ${ddl}`);
      };
      await add('organizations', 'frozenClasses', "TEXT NOT NULL DEFAULT '[]'");
      await add('org_audits', 'spotChecks', "TEXT NOT NULL DEFAULT '[]'");
      await add('org_audits', 'precision', 'REAL');
      await add('org_audits', 'recall', 'REAL');
      await add('org_audits', 'noRotation', 'INTEGER NOT NULL DEFAULT 0');
      await add('chat_turns', 'degraded', 'TEXT');
    },
  },
  {
    id: '0042-chat-compact-baseline',
    up: async (db) => {
      // The token ceiling counts tokens since the last compaction, so a
      // compacted chat is no longer refused forever. Existing compacted chats
      // keep their history; their baseline starts at 0 (they may be refused
      // once more, until the next compaction resets it).
      if (!(await hasColumn(db, 'chat_sessions', 'tokensAtCompact'))) {
        await db.query(`ALTER TABLE chat_sessions ADD COLUMN "tokensAtCompact" INTEGER NOT NULL DEFAULT 0`);
      }
    },
  },
  {
    id: '0043-org-experiments',
    up: async (db) => {
      // Experiments and the prediction ledger (docs/experiments.md,
      // execution-plan item 30): changes declared as hypotheses with a
      // measured metric, a window and a revert rule; forecasts scored
      // model-free for calibration. Idempotent.
      await db.query(`CREATE TABLE IF NOT EXISTS org_experiments (
        "accountId" TEXT NOT NULL DEFAULT 'single',
        "id" TEXT PRIMARY KEY,
        "orgId" TEXT NOT NULL,
        "unitId" TEXT,
        "title" TEXT NOT NULL,
        "hypothesis" TEXT NOT NULL DEFAULT '',
        "changeKind" TEXT NOT NULL,
        "change" TEXT NOT NULL DEFAULT '{}',
        "metricSourceId" TEXT,
        "direction" TEXT NOT NULL DEFAULT 'up',
        "expectedEffect" REAL NOT NULL DEFAULT 0,
        "effectKind" TEXT NOT NULL DEFAULT 'relative',
        "windowDays" INTEGER NOT NULL DEFAULT 14,
        "design" TEXT NOT NULL DEFAULT 'before_after',
        "slice" TEXT NOT NULL DEFAULT '{}',
        "baseline" TEXT NOT NULL DEFAULT '{}',
        "result" TEXT NOT NULL DEFAULT '{}',
        "status" TEXT NOT NULL DEFAULT 'proposed',
        "revertRule" TEXT NOT NULL DEFAULT '{}',
        "extensions" INTEGER NOT NULL DEFAULT 0,
        "proposedBy" TEXT NOT NULL DEFAULT 'user',
        "approvalId" TEXT,
        "changeApprovalId" TEXT,
        "startedAt" TEXT,
        "endsAt" TEXT,
        "lastCheckAt" TEXT,
        "decidedAt" TEXT,
        "decisionId" TEXT,
        "createdAt" TEXT NOT NULL
      )`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_org_experiments_org_status ON org_experiments ("orgId", "status")`);
      await db.query(`CREATE TABLE IF NOT EXISTS org_predictions (
        "accountId" TEXT NOT NULL DEFAULT 'single',
        "id" TEXT PRIMARY KEY,
        "orgId" TEXT NOT NULL,
        "agentId" TEXT NOT NULL,
        "subjectKind" TEXT NOT NULL,
        "subjectId" TEXT NOT NULL DEFAULT '',
        "question" TEXT NOT NULL DEFAULT '',
        "forecast" TEXT NOT NULL DEFAULT '{}',
        "origin" TEXT NOT NULL DEFAULT 'tool',
        "resolvesAt" TEXT,
        "outcome" TEXT NOT NULL DEFAULT '{}',
        "resolvedAt" TEXT,
        "score" REAL,
        "status" TEXT NOT NULL DEFAULT 'open',
        "createdAt" TEXT NOT NULL
      )`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_org_predictions_agent ON org_predictions ("orgId", "agentId", "status")`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_org_predictions_subject ON org_predictions ("orgId", "subjectKind", "subjectId")`);
    },
  },
  {
    id: '0044-org-evals-boundary',
    up: async (db) => {
      // Evals, the self-modification boundary, capacity and the owner's seat
      // (docs/evals.md, docs/boundary.md, docs/owners-seat.md, execution-plan
      // item 31): golden-set cases and eval runs per role; delegated
      // approvals; value events from measured key-result movement; task
      // dependencies and deadlines; key-result value; the decision-card
      // fields on approvals. The boundary itself is code (boundary.ts), not a
      // table. Idempotent.
      await db.query(`CREATE TABLE IF NOT EXISTS org_eval_cases (
        "accountId" TEXT NOT NULL DEFAULT 'single',
        "id" TEXT PRIMARY KEY,
        "orgId" TEXT NOT NULL,
        "roleKey" TEXT NOT NULL,
        "taskSnapshot" TEXT NOT NULL DEFAULT '{}',
        "expected" TEXT NOT NULL DEFAULT '{}',
        "sourceTaskId" TEXT,
        "source" TEXT NOT NULL DEFAULT 'manual',
        "createdAt" TEXT NOT NULL,
        "retiredAt" TEXT
      )`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_org_eval_cases_role ON org_eval_cases ("orgId", "roleKey")`);
      await db.query(`CREATE TABLE IF NOT EXISTS org_eval_runs (
        "accountId" TEXT NOT NULL DEFAULT 'single',
        "id" TEXT PRIMARY KEY,
        "orgId" TEXT NOT NULL,
        "roleKey" TEXT NOT NULL,
        "kind" TEXT NOT NULL DEFAULT 'candidate',
        "candidate" TEXT NOT NULL DEFAULT '{}',
        "versionHash" TEXT NOT NULL DEFAULT '',
        "cases" TEXT NOT NULL DEFAULT '[]',
        "results" TEXT NOT NULL DEFAULT '[]',
        "passRate" REAL,
        "baselinePassRate" REAL,
        "baselineRunId" TEXT,
        "verdict" TEXT NOT NULL DEFAULT '',
        "usd" REAL NOT NULL DEFAULT 0,
        "requestedBy" TEXT NOT NULL DEFAULT 'user',
        "startedAt" TEXT NOT NULL,
        "endedAt" TEXT,
        "status" TEXT NOT NULL DEFAULT 'running'
      )`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_org_eval_runs_role ON org_eval_runs ("orgId", "roleKey")`);
      await db.query(`CREATE TABLE IF NOT EXISTS org_delegations (
        "accountId" TEXT NOT NULL DEFAULT 'single',
        "id" TEXT PRIMARY KEY,
        "orgId" TEXT NOT NULL,
        "kind" TEXT NOT NULL,
        "maxUsd" REAL,
        "delegateType" TEXT NOT NULL,
        "delegateRef" TEXT NOT NULL,
        "createdBy" TEXT NOT NULL DEFAULT 'user',
        "createdAt" TEXT NOT NULL,
        "revokedAt" TEXT
      )`);
      await db.query(`CREATE TABLE IF NOT EXISTS org_value_events (
        "accountId" TEXT NOT NULL DEFAULT 'single',
        "id" TEXT PRIMARY KEY,
        "orgId" TEXT NOT NULL,
        "goalId" TEXT NOT NULL,
        "objectiveId" TEXT,
        "unitId" TEXT,
        "kind" TEXT NOT NULL DEFAULT 'movement',
        "sampleId" TEXT,
        "fromValue" REAL,
        "toValue" REAL,
        "delta" REAL NOT NULL DEFAULT 0,
        "valueUsd" REAL NOT NULL DEFAULT 0,
        "at" TEXT NOT NULL,
        "createdAt" TEXT NOT NULL
      )`);
      await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_org_value_events_ref ON org_value_events ("goalId", "kind", "sampleId")`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_org_value_events_org ON org_value_events ("orgId", "at")`);
      const add = async (table: string, column: string, ddl: string) => {
        if (!(await hasColumn(db, table, column))) await db.query(`ALTER TABLE ${table} ADD COLUMN "${column}" ${ddl}`);
      };
      await add('org_tasks', 'dependsOn', "TEXT NOT NULL DEFAULT '[]'");
      await add('org_tasks', 'dueAt', 'TEXT');
      await add('org_goals', 'valuePerUnit', 'REAL');
      await add('org_goals', 'valueOnAchieve', 'REAL');
      await add('org_goals', 'valueNote', "TEXT NOT NULL DEFAULT ''");
      await add('org_approvals', 'recommendedAction', "TEXT NOT NULL DEFAULT ''");
      await add('org_approvals', 'alternatives', "TEXT NOT NULL DEFAULT '[]'");
      await add('org_approvals', 'reversibility', "TEXT NOT NULL DEFAULT ''");
      await add('org_approvals', 'confidence', 'REAL');
      await add('org_approvals', 'deadline', 'TEXT');
      await add('org_approvals', 'defaultAction', "TEXT NOT NULL DEFAULT ''");
      await add('org_approvals', 'decidedVia', "TEXT NOT NULL DEFAULT ''");
    },
  },
  {
    id: '0045-agent-type',
    up: async (db) => {
      // An agent's model is chosen from an agent type (provider + key + base
      // URL); its chats, channel replies, loops and org runs run on it unless a
      // chat picked another model by hand.
      if (!(await hasColumn(db, 'agents', 'agentTypeId'))) {
        await db.query(`ALTER TABLE agents ADD COLUMN "agentTypeId" TEXT`);
      }
    },
  },
  {
    id: '0046-chat-context-tokens',
    up: async (db) => {
      // The context the last model call carried (input + output of its last
      // round, as the provider reported it): the token ceiling and the chat's
      // meter measure this, not cumulative spend, and auto-compaction keeps it
      // below the ceiling.
      if (!(await hasColumn(db, 'chat_sessions', 'contextTokens'))) {
        await db.query(`ALTER TABLE chat_sessions ADD COLUMN "contextTokens" INTEGER NOT NULL DEFAULT 0`);
      }
      // 'context' (the default): the ceiling limits one call's context and
      // auto-compaction keeps chats under it. 'spend': a loop's token budget —
      // cumulative tokens since the last /clear, refused when spent.
      if (!(await hasColumn(db, 'chat_sessions', 'ceilingKind'))) {
        await db.query(`ALTER TABLE chat_sessions ADD COLUMN "ceilingKind" TEXT NOT NULL DEFAULT 'context'`);
      }
    },
  },  {
    id: '0047-workspace-files',
    up: async (db) => {
      // The workspace filesystem (docs/filesystem.md): per-file metadata for
      // every write through WorkspaceFs — version, size, who made and who
      // last changed it — and the revision index (the previous bodies live
      // in storage under .revisions/). Objects written outside WorkspaceFs
      // still list from storage; they simply have no row yet. Idempotent.
      await db.query(`CREATE TABLE IF NOT EXISTS workspace_files (
        "accountId" TEXT NOT NULL DEFAULT 'single',
        "id" TEXT PRIMARY KEY,
        "workspaceId" TEXT NOT NULL,
        "path" TEXT NOT NULL,
        "version" INTEGER NOT NULL DEFAULT 1,
        "size" INTEGER NOT NULL DEFAULT 0,
        "contentType" TEXT NOT NULL DEFAULT '',
        "updatedByKind" TEXT NOT NULL DEFAULT 'system',
        "updatedById" TEXT NOT NULL DEFAULT '',
        "updatedByName" TEXT NOT NULL DEFAULT '',
        "updatedAt" TEXT NOT NULL,
        "createdByKind" TEXT NOT NULL DEFAULT 'system',
        "createdById" TEXT NOT NULL DEFAULT '',
        "createdAt" TEXT NOT NULL
      )`);
      await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_files_path ON workspace_files ("workspaceId", "path")`);
      await db.query(`CREATE TABLE IF NOT EXISTS workspace_file_revisions (
        "accountId" TEXT NOT NULL DEFAULT 'single',
        "id" TEXT PRIMARY KEY,
        "workspaceId" TEXT NOT NULL,
        "path" TEXT NOT NULL,
        "version" INTEGER NOT NULL,
        "size" INTEGER NOT NULL DEFAULT 0,
        "updatedByKind" TEXT NOT NULL DEFAULT 'system',
        "updatedById" TEXT NOT NULL DEFAULT '',
        "updatedByName" TEXT NOT NULL DEFAULT '',
        "updatedAt" TEXT NOT NULL
      )`);
      await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_file_revisions_version ON workspace_file_revisions ("workspaceId", "path", "version")`);
    },
  },
  {
    id: '0048-follows',
    up: async (db) => {
      // Follows (docs/follows.md): who follows which channel thread, org task
      // or agent kanban task — agents and people alike — and the compact
      // "new since you last looked" state each follower carries. An unfollow
      // is `mutedAt` (the row stays) so auto-follow never resubscribes.
      await db.query(`CREATE TABLE IF NOT EXISTS follows (
        "accountId" TEXT NOT NULL DEFAULT 'single',
        "id" TEXT PRIMARY KEY,
        "workspaceId" TEXT NOT NULL,
        "followerKind" TEXT NOT NULL,
        "followerId" TEXT NOT NULL,
        "targetKind" TEXT NOT NULL,
        "targetId" TEXT NOT NULL,
        "reason" TEXT NOT NULL DEFAULT 'manual',
        "title" TEXT NOT NULL DEFAULT '',
        "link" TEXT NOT NULL DEFAULT '',
        "createdAt" TEXT NOT NULL,
        "mutedAt" TEXT,
        "lastSeenAt" TEXT,
        "unseenCount" INTEGER NOT NULL DEFAULT 0,
        "lastActivityAt" TEXT,
        "lastActivity" TEXT NOT NULL DEFAULT '',
        "lastActorName" TEXT NOT NULL DEFAULT '',
        "attentionAt" TEXT,
        "attention" TEXT NOT NULL DEFAULT '',
        "wokeAt" TEXT,
        "closedAt" TEXT
      )`);
      await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_follows_unique ON follows ("followerKind", "followerId", "targetKind", "targetId")`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_follows_target ON follows ("targetKind", "targetId")`);
    },
  },
  {
    id: '0049-meeting-minutes',
    up: async (db) => {
      // Minutes at the end of every meeting (docs/meetings.md): the markdown
      // document written to the workspace tree and its summary, kept on the
      // meeting row so lists and the calendar read them without parsing the
      // minutes JSON or the file. Idempotent.
      if (!(await hasColumn(db, 'org_meetings', 'minutesPath'))) {
        await db.query(`ALTER TABLE org_meetings ADD COLUMN "minutesPath" TEXT`);
      }
      if (!(await hasColumn(db, 'org_meetings', 'summary'))) {
        await db.query(`ALTER TABLE org_meetings ADD COLUMN "summary" TEXT NOT NULL DEFAULT ''`);
      }
      await db.query(`CREATE INDEX IF NOT EXISTS idx_org_meetings_channel ON org_meetings ("channelId")`);
    },
  },
  {
    id: '0050-meeting-room',
    up: async (db) => {
      // The meeting room (docs/meetings.md "During"): the live state of a
      // meeting — agenda items and the current one, rounds and their cap,
      // who spoke / passed / is speaking, the people present, the parking
      // lot, agenda proposals, the pre-read, verdicts on proposals and
      // answers to questions — as JSON on the row; and the tokens its turns
      // and minutes call used, so the cost reads in tokens as well as USD.
      // Idempotent.
      if (!(await hasColumn(db, 'org_meetings', 'room'))) {
        await db.query(`ALTER TABLE org_meetings ADD COLUMN "room" TEXT NOT NULL DEFAULT ''`);
      }
      if (!(await hasColumn(db, 'org_meetings', 'tokensIn'))) {
        await db.query(`ALTER TABLE org_meetings ADD COLUMN "tokensIn" INTEGER NOT NULL DEFAULT 0`);
      }
      if (!(await hasColumn(db, 'org_meetings', 'tokensOut'))) {
        await db.query(`ALTER TABLE org_meetings ADD COLUMN "tokensOut" INTEGER NOT NULL DEFAULT 0`);
      }
      await db.query(`CREATE INDEX IF NOT EXISTS idx_org_meetings_thread ON org_meetings ("threadRootId")`);
    },
  },  {
    id: '0051-chat-auto-archive',
    up: async (db) => {
      // Auto-archive of finished-task chats (docs/chat-archiving.md): the
      // task a chat works on (an org task or a kanban task), the chat's own
      // auto-archive setting (null = follow the agent / workspace default,
      // 0 = off, n = days after the task is finished) and the agent's default
      // for its new task chats. Then the existing per-task org sessions
      // (`Org · <org> · <task title>`) are linked to their task through the
      // runs that used them. An index for the paged chat list (the rail).
      // Idempotent.
      const add = async (table: string, column: string, ddl: string) => {
        if (!(await hasColumn(db, table, column))) await db.query(`ALTER TABLE ${table} ADD COLUMN "${column}" ${ddl}`);
      };
      await add('chat_sessions', 'autoArchiveDays', 'INTEGER');
      await add('chat_sessions', 'taskKind', 'TEXT');
      await add('chat_sessions', 'taskId', 'TEXT');
      await add('agents', 'chatAutoArchiveDays', 'INTEGER');
      await db.query(`CREATE INDEX IF NOT EXISTS idx_chat_sessions_rail ON chat_sessions ("workspaceId", "agentId", "updatedAt")`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_chat_sessions_task ON chat_sessions ("taskId")`);
      await db.query(`
        UPDATE chat_sessions s SET "taskKind" = 'org', "taskId" = t."id"
          FROM org_runs r
          JOIN org_tasks t ON t."id" = r."taskId"
          JOIN organizations o ON o."id" = t."orgId"
         WHERE r."sessionId" = s."id"
           AND s."taskId" IS NULL
           AND s."name" = 'Org · ' || o."name" || ' · ' || LEFT(t."title", 48)
      `);
    },
  },
  {
    id: '0052-task-keys',
    up: async (db) => {
      // Task keys (docs/tasks-keys.md): Jira-style `ENG-12` names. A prefix
      // per board (org_units.taskKey, agents.taskKey), one counter row per
      // prefix and workspace (task_key_counters; the next number is one
      // atomic UPDATE … RETURNING), and the key on every task — backfilled
      // board by board in creation order. Idempotent.
      if (!(await hasColumn(db, 'org_units', 'taskKey'))) await db.query(`ALTER TABLE org_units ADD COLUMN "taskKey" TEXT`);
      if (!(await hasColumn(db, 'agents', 'taskKey'))) await db.query(`ALTER TABLE agents ADD COLUMN "taskKey" TEXT`);
      if (!(await hasColumn(db, 'org_tasks', 'key'))) await db.query(`ALTER TABLE org_tasks ADD COLUMN "key" TEXT`);
      if (!(await hasColumn(db, 'agent_tasks', 'key'))) await db.query(`ALTER TABLE agent_tasks ADD COLUMN "key" TEXT`);
      await db.query(`
        CREATE TABLE IF NOT EXISTS task_key_counters (
          "accountId" TEXT NOT NULL DEFAULT 'single',
          "scopeId" TEXT NOT NULL,
          "prefix" TEXT NOT NULL,
          "ownerKind" TEXT NOT NULL,
          "ownerId" TEXT NOT NULL,
          "next" INTEGER NOT NULL DEFAULT 0,
          "createdAt" TEXT NOT NULL,
          PRIMARY KEY ("scopeId", "prefix")
        )
      `);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_task_key_counters_owner ON task_key_counters ("ownerId")`);
      await backfillTaskKeys(db);
      await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_org_tasks_key ON org_tasks ("orgId", "key")`);
      await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_tasks_key ON agent_tasks ("agentId", "key")`);
    },
  },
  {
    id: '0053-change-records',
    up: async (db) => {
      // The generic change record and model-visible provenance
      // (docs/plugins.md §4.8, §5.6, §8.3), and the plugin-call columns of
      // action_log: the canonical operation, its interface version,
      // provider and binding scope, the approval asked/decided pair with
      // its closed outcome, and the metered cost. The plan's `jobs` table
      // is deferred: verify windows wait on change_records.deadlineAt.
      // Idempotent.
      await db.query(`
        CREATE TABLE IF NOT EXISTS change_records (
          "accountId" TEXT NOT NULL DEFAULT 'single',
          "id" TEXT PRIMARY KEY,
          "workspaceId" TEXT NOT NULL,
          "kind" TEXT NOT NULL,
          "interfaceVersionId" TEXT,
          "providerId" TEXT,
          "bindingScope" TEXT,
          "ref" TEXT NOT NULL DEFAULT '',
          "bind" TEXT NOT NULL DEFAULT '{}',
          "title" TEXT NOT NULL DEFAULT '',
          "state" TEXT NOT NULL DEFAULT 'proposed',
          "proposer" TEXT NOT NULL,
          "taskId" TEXT,
          "reviews" TEXT NOT NULL DEFAULT '[]',
          "requirement" TEXT NOT NULL DEFAULT 'trust',
          "approvalId" TEXT,
          "keys" TEXT NOT NULL DEFAULT '{}',
          "applyActionId" TEXT,
          "verify" TEXT NOT NULL DEFAULT '{}',
          "rollbackActionId" TEXT,
          "deadlineAt" TEXT,
          "history" TEXT NOT NULL DEFAULT '[]',
          "createdAt" TEXT NOT NULL,
          "updatedAt" TEXT NOT NULL
        )
      `);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_change_records_ws ON change_records ("workspaceId", "state")`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_change_records_deadline ON change_records ("deadlineAt")`);
      await db.query(`
        CREATE TABLE IF NOT EXISTS context_provenance (
          "accountId" TEXT NOT NULL DEFAULT 'single',
          "id" TEXT PRIMARY KEY,
          "workspaceId" TEXT NOT NULL,
          "sessionId" TEXT NOT NULL,
          "turnId" TEXT,
          "sourceKind" TEXT NOT NULL,
          "pluginId" TEXT NOT NULL,
          "pluginVersion" TEXT NOT NULL,
          "contributionId" TEXT NOT NULL,
          "contentHash" TEXT NOT NULL,
          "bytes" INTEGER NOT NULL,
          "untrusted" INTEGER NOT NULL DEFAULT 0,
          "createdAt" TEXT NOT NULL
        )
      `);
      await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_context_provenance_dedupe ON context_provenance ("sessionId", "sourceKind", "contentHash")`);
      const cols: Array<[string, string]> = [
        ['operation', 'TEXT'], ['interfaceVersion', 'TEXT'], ['providerId', 'TEXT'], ['bindingScope', 'TEXT'],
        ['pluginVersion', 'TEXT'], ['packageDigest', 'TEXT'], ['definitionHash', 'TEXT'], ['credentialRef', 'TEXT'],
        ['changeId', 'TEXT'], ['tainted', 'INTEGER'], ['approvalRequestId', 'TEXT'], ['approvalAskedAt', 'TEXT'],
        ['approvalDecidedAt', 'TEXT'], ['approvalOutcome', 'TEXT'], ['costUsd', 'REAL'], ['costState', 'TEXT'],
      ];
      for (const [c, ddl] of cols) if (!(await hasColumn(db, 'action_log', c))) await db.query(`ALTER TABLE action_log ADD COLUMN "${c}" ${ddl}`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_action_log_operation ON action_log ("workspaceId", "operation")`);
    },
  },
  {
    id: '0054-plugins-interfaces',
    up: async (db) => {
      // Plugins, interfaces, providers, bindings, owner policies,
      // conformance runs, the registrar's effects, per-agent grants and the
      // plugin audit chain (docs/plugins.md §8.1, Phase 1), and the
      // workspace's plugin settings. Secrets, connections, shares, settings
      // layers, webhook deliveries and environments come with the phases
      // that use them. Idempotent.
      if (!(await hasColumn(db, 'workspaces', 'pluginSettings'))) await db.query(`ALTER TABLE workspaces ADD COLUMN "pluginSettings" TEXT NOT NULL DEFAULT '{}'`);
      const tables: Array<[string, string, string[]]> = [
        ['plugins', `"id" TEXT PRIMARY KEY, "pluginId" TEXT NOT NULL, "name" TEXT NOT NULL, "publisherId" TEXT NOT NULL,
          "tier" TEXT NOT NULL, "roles" TEXT NOT NULL DEFAULT '[]', "registryItemId" TEXT, "createdAt" TEXT NOT NULL`,
        ['CREATE UNIQUE INDEX IF NOT EXISTS idx_plugins_identity ON plugins ("accountId", "pluginId")']],
        ['plugin_versions', `"id" TEXT PRIMARY KEY, "pluginId" TEXT NOT NULL, "version" TEXT NOT NULL, "manifest" TEXT NOT NULL,
          "manifestHash" TEXT NOT NULL, "archiveSha256" TEXT NOT NULL, "files" TEXT NOT NULL DEFAULT '{}',
          "definitions" TEXT NOT NULL DEFAULT '{}', "coreRange" TEXT NOT NULL, "scanReport" TEXT NOT NULL DEFAULT '[]',
          "source" TEXT NOT NULL DEFAULT 'first_party', "createdAt" TEXT NOT NULL, "revokedAt" TEXT, "revokeReason" TEXT`,
        ['CREATE UNIQUE INDEX IF NOT EXISTS idx_plugin_versions_hash ON plugin_versions ("accountId", "pluginId", "archiveSha256")']],
        ['plugin_installs', `"id" TEXT PRIMARY KEY, "workspaceId" TEXT NOT NULL, "pluginId" TEXT NOT NULL, "versionId" TEXT NOT NULL,
          "pendingVersionId" TEXT, "pendingNote" TEXT NOT NULL DEFAULT '{}', "status" TEXT NOT NULL DEFAULT 'installed',
          "suspendedReason" TEXT NOT NULL DEFAULT '', "approvedDiff" TEXT NOT NULL DEFAULT '[]', "settings" TEXT NOT NULL DEFAULT '{}',
          "kitInstallId" TEXT, "installedBy" TEXT NOT NULL DEFAULT '', "createdAt" TEXT NOT NULL, "activatedAt" TEXT, "updatedAt" TEXT NOT NULL`,
        ['CREATE UNIQUE INDEX IF NOT EXISTS idx_plugin_installs_ws ON plugin_installs ("workspaceId", "pluginId")']],
        ['interfaces', `"id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "ownerNamespace" TEXT NOT NULL, "ownerPluginId" TEXT NOT NULL,
          "latestVersion" TEXT NOT NULL, "createdAt" TEXT NOT NULL`,
        ['CREATE UNIQUE INDEX IF NOT EXISTS idx_interfaces_name ON interfaces ("accountId", "name")']],
        ['interface_versions', `"id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "version" TEXT NOT NULL, "major" INTEGER NOT NULL,
          "definition" TEXT NOT NULL, "definitionHash" TEXT NOT NULL, "pluginVersionId" TEXT NOT NULL, "suite" TEXT NOT NULL DEFAULT '{}',
          "deprecatedAt" TEXT, "sunsetAt" TEXT, "createdAt" TEXT NOT NULL`,
        ['CREATE UNIQUE INDEX IF NOT EXISTS idx_interface_versions_v ON interface_versions ("accountId", "name", "version", "definitionHash")']],
        ['interface_providers', `"id" TEXT PRIMARY KEY, "workspaceId" TEXT NOT NULL, "installId" TEXT NOT NULL, "interface" TEXT NOT NULL,
          "range" TEXT NOT NULL, "resolvedVersion" TEXT NOT NULL DEFAULT '', "resources" TEXT NOT NULL DEFAULT '[]',
          "conformanceRunId" TEXT, "status" TEXT NOT NULL DEFAULT 'unverified', "createdAt" TEXT NOT NULL`,
        ['CREATE UNIQUE INDEX IF NOT EXISTS idx_interface_providers_install ON interface_providers ("installId", "interface")']],
        ['interface_bindings', `"id" TEXT PRIMARY KEY, "workspaceId" TEXT NOT NULL, "interface" TEXT NOT NULL, "major" INTEGER NOT NULL,
          "scopeKind" TEXT NOT NULL, "scopeRef" TEXT NOT NULL DEFAULT '', "providerId" TEXT NOT NULL, "setBy" TEXT NOT NULL DEFAULT '',
          "createdAt" TEXT NOT NULL`,
        ['CREATE UNIQUE INDEX IF NOT EXISTS idx_interface_bindings_scope ON interface_bindings ("workspaceId", "interface", "major", "scopeKind", "scopeRef")']],
        ['interface_policies', `"id" TEXT PRIMARY KEY, "workspaceId" TEXT NOT NULL, "operation" TEXT NOT NULL DEFAULT '',
          "changeKind" TEXT NOT NULL DEFAULT '', "resourcePattern" TEXT NOT NULL DEFAULT '', "match" TEXT NOT NULL DEFAULT '{}',
          "require" TEXT NOT NULL, "why" TEXT NOT NULL DEFAULT '', "setBy" TEXT NOT NULL DEFAULT '', "createdAt" TEXT NOT NULL`,
        ['CREATE INDEX IF NOT EXISTS idx_interface_policies_ws ON interface_policies ("workspaceId")']],
        ['conformance_runs', `"id" TEXT PRIMARY KEY, "workspaceId" TEXT NOT NULL, "providerId" TEXT NOT NULL, "installId" TEXT NOT NULL,
          "pluginVersionId" TEXT NOT NULL, "interfaceVersionId" TEXT NOT NULL, "mode" TEXT NOT NULL, "startedAt" TEXT NOT NULL,
          "finishedAt" TEXT, "result" TEXT NOT NULL DEFAULT 'error', "cases" TEXT NOT NULL DEFAULT '[]', "envId" TEXT`,
        ['CREATE INDEX IF NOT EXISTS idx_conformance_runs_provider ON conformance_runs ("providerId")']],
        ['plugin_effects', `"id" TEXT PRIMARY KEY, "workspaceId" TEXT NOT NULL, "installId" TEXT NOT NULL, "seq" INTEGER NOT NULL,
          "kind" TEXT NOT NULL, "ref" TEXT NOT NULL, "inverse" TEXT NOT NULL, "external" INTEGER NOT NULL DEFAULT 0, "finalizer" TEXT,
          "state" TEXT NOT NULL DEFAULT 'live', "createdAt" TEXT NOT NULL, "unwoundAt" TEXT`,
        ['CREATE INDEX IF NOT EXISTS idx_plugin_effects_install ON plugin_effects ("installId", "seq")']],
        ['plugin_grants', `"id" TEXT PRIMARY KEY, "workspaceId" TEXT NOT NULL, "installId" TEXT NOT NULL, "connectionId" TEXT,
          "agentId" TEXT NOT NULL, "level" TEXT NOT NULL, "extras" INTEGER NOT NULL DEFAULT 0, "memberAccountId" TEXT, "createdAt" TEXT NOT NULL`,
        ['CREATE UNIQUE INDEX IF NOT EXISTS idx_plugin_grants_agent ON plugin_grants ("installId", "agentId")']],
        ['plugin_audit', `"id" TEXT PRIMARY KEY, "workspaceId" TEXT NOT NULL, "seq" INTEGER NOT NULL, "actor" TEXT NOT NULL,
          "action" TEXT NOT NULL, "refType" TEXT NOT NULL DEFAULT '', "refId" TEXT NOT NULL DEFAULT '', "payload" TEXT NOT NULL DEFAULT '{}',
          "prevHash" TEXT NOT NULL DEFAULT '', "hash" TEXT NOT NULL, "createdAt" TEXT NOT NULL`,
        ['CREATE UNIQUE INDEX IF NOT EXISTS idx_plugin_audit_seq ON plugin_audit ("workspaceId", "seq")']],
      ];
      for (const [table, columns, indexes] of tables) {
        await db.query(`CREATE TABLE IF NOT EXISTS ${table} ("accountId" TEXT NOT NULL DEFAULT 'single', ${columns})`);
        for (const ix of indexes) await db.query(ix);
      }
    },
  },
  {
    id: '0060-work-tracking',
    up: async (db) => {
      // Work tracking (docs/work-tracking.md): projects become the required
      // middle level (lead, key results, brief, dates, milestones, appetite,
      // lane, health), every task records its source, one structured
      // blocker, checklist steps and its done event (task_transitions,
      // startedAt / doneAt), the heartbeat back-off and circular-behaviour
      // state; health updates get their own table; the kanban of company
      // members merges into the org board (agent_tasks.mergedInto). Then the
      // backfill (work-tracking-backfill.ts). Idempotent.
      const add = async (table: string, column: string, ddl: string) => {
        if (!(await hasColumn(db, table, column))) await db.query(`ALTER TABLE ${table} ADD COLUMN "${column}" ${ddl}`);
      };
      await add('org_projects', 'key', 'TEXT');
      await add('org_projects', 'goalIds', `TEXT NOT NULL DEFAULT '[]'`);
      await add('org_projects', 'leadHumanId', 'TEXT');
      await add('org_projects', 'unitId', 'TEXT');
      await add('org_projects', 'kind', `TEXT NOT NULL DEFAULT 'project'`);
      await add('org_projects', 'brief', `TEXT NOT NULL DEFAULT '{}'`);
      await add('org_projects', 'startDate', 'TEXT');
      await add('org_projects', 'targetDate', 'TEXT');
      await add('org_projects', 'milestones', `TEXT NOT NULL DEFAULT '[]'`);
      await add('org_projects', 'appetiteDays', 'INTEGER NOT NULL DEFAULT 0');
      await add('org_projects', 'appetiteUsd', 'REAL NOT NULL DEFAULT 0');
      await add('org_projects', 'lane', `TEXT NOT NULL DEFAULT 'later'`);
      await add('org_projects', 'rank', 'INTEGER NOT NULL DEFAULT 0');
      await add('org_projects', 'health', `TEXT NOT NULL DEFAULT ''`);
      await add('org_projects', 'healthReason', `TEXT NOT NULL DEFAULT ''`);
      await add('org_projects', 'healthAsk', `TEXT NOT NULL DEFAULT ''`);
      await add('org_projects', 'healthAt', 'TEXT');
      await add('org_projects', 'hill', 'REAL');
      await add('org_projects', 'updateCadenceDays', 'INTEGER');
      await add('org_projects', 'breakerAt', 'TEXT');
      await add('org_projects', 'appetiteWarnedAt', 'TEXT');
      await add('org_projects', 'createdBy', `TEXT NOT NULL DEFAULT 'user'`);
      await add('org_projects', 'updatedAt', 'TEXT');
      // source: added empty so the backfill can tell untouched rows, then defaulted.
      await add('org_tasks', 'source', `TEXT NOT NULL DEFAULT ''`);
      await add('org_tasks', 'blockedOn', `TEXT NOT NULL DEFAULT ''`);
      await add('org_tasks', 'steps', `TEXT NOT NULL DEFAULT '[]'`);
      await add('org_tasks', 'startedAt', 'TEXT');
      await add('org_tasks', 'doneAt', 'TEXT');
      await add('org_tasks', 'blockedSeconds', 'INTEGER NOT NULL DEFAULT 0');
      await add('org_tasks', 'wakeSig', `TEXT NOT NULL DEFAULT ''`);
      await add('org_tasks', 'wakeCount', 'INTEGER NOT NULL DEFAULT 0');
      await add('org_tasks', 'nextWakeAt', 'TEXT');
      await add('org_tasks', 'failSig', `TEXT NOT NULL DEFAULT ''`);
      await add('org_tasks', 'failRepeats', 'INTEGER NOT NULL DEFAULT 0');
      await add('org_tasks', 'wakesPausedAt', 'TEXT');
      await add('agent_tasks', 'mergedInto', 'TEXT');
      await db.query(`
        CREATE TABLE IF NOT EXISTS org_project_updates (
          "accountId" TEXT NOT NULL DEFAULT 'single',
          "id" TEXT PRIMARY KEY,
          "orgId" TEXT NOT NULL,
          "projectId" TEXT NOT NULL,
          "health" TEXT NOT NULL,
          "reason" TEXT NOT NULL DEFAULT '',
          "ask" TEXT NOT NULL DEFAULT '',
          "body" TEXT NOT NULL DEFAULT '',
          "hill" REAL,
          "diff" TEXT NOT NULL DEFAULT '{}',
          "by" TEXT NOT NULL DEFAULT '',
          "createdAt" TEXT NOT NULL
        )
      `);
      await db.query(`
        CREATE TABLE IF NOT EXISTS task_transitions (
          "accountId" TEXT NOT NULL DEFAULT 'single',
          "id" TEXT PRIMARY KEY,
          "orgId" TEXT NOT NULL,
          "taskId" TEXT NOT NULL,
          "fromStatus" TEXT NOT NULL DEFAULT '',
          "toStatus" TEXT NOT NULL,
          "actor" TEXT NOT NULL DEFAULT '',
          "reason" TEXT NOT NULL DEFAULT '',
          "backfilled" INTEGER NOT NULL DEFAULT 0,
          "at" TEXT NOT NULL
        )
      `);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_org_project_updates_project ON org_project_updates ("projectId", "createdAt")`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_task_transitions_task ON task_transitions ("taskId", "at")`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_task_transitions_org ON task_transitions ("orgId", "toStatus", "at")`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_org_tasks_project ON org_tasks ("projectId")`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_org_projects_org ON org_projects ("orgId", "kind")`);
      await backfillWorkTracking(db);
      await db.query(`ALTER TABLE org_tasks ALTER COLUMN "source" SET DEFAULT 'agent'`);
      await db.query(`UPDATE org_tasks SET "source" = 'agent' WHERE "source" = ''`);
    },
  },
  {
    id: '0070-decision-routing',
    up: async (db) => {
      // Decisions go to the direct manager first (docs/owners-seat.md §7):
      // who holds a pending card now ('ceo' | 'agent:<id>' | 'human:<id>'),
      // since when and until when the hop may wait, the hops it took (JSON),
      // why it is CEO-reserved ('' = a manager may decide it) and its
      // urgency. A member may report to a person for decisions
      // (org_members.reportsToHumanId, an org_humans memberAccountId).
      // Existing cards stay with the CEO (the column default). Idempotent.
      const add = async (table: string, column: string, ddl: string) => {
        if (!(await hasColumn(db, table, column))) await db.query(`ALTER TABLE ${table} ADD COLUMN "${column}" ${ddl}`);
      };
      await add('org_approvals', 'holder', `TEXT NOT NULL DEFAULT 'ceo'`);
      await add('org_approvals', 'holderSince', 'TEXT');
      await add('org_approvals', 'hopDeadline', 'TEXT');
      await add('org_approvals', 'chain', `TEXT NOT NULL DEFAULT '[]'`);
      await add('org_approvals', 'reserved', `TEXT NOT NULL DEFAULT ''`);
      await add('org_approvals', 'urgency', `TEXT NOT NULL DEFAULT 'normal'`);
      await add('org_members', 'reportsToHumanId', 'TEXT');
      await db.query(`CREATE INDEX IF NOT EXISTS idx_org_approvals_holder ON org_approvals ("orgId", "status", "holder")`);
    },
  },
  {
    id: '0080-session-kind',
    up: async (db) => {
      // Chat vs work (docs/work-log.md): a session is a conversation with
      // people ('chat') or the agent's own run ('work'). Backfilled from the
      // signals sessions already carry — the run name prefixes (`Loop · `,
      // `Org · `, `Red team · `, `Eval · `, `App · `), a channel's hidden
      // `#slug · Agent` working session or its `channel` tag, an org task
      // link, and a session an org run used — the same rule as
      // classifySession (server/src/chats/session-kind.ts). Only rows still
      // at the default are touched, so a re-run never undoes a later change.
      // Idempotent.
      if (!(await hasColumn(db, 'chat_sessions', 'kind'))) await db.query(`ALTER TABLE chat_sessions ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'chat'`);
      await db.query(`
        UPDATE chat_sessions s SET "kind" = 'work'
         WHERE s."kind" = 'chat'
           AND (s."name" LIKE 'Loop · %' OR s."name" LIKE 'Org · %' OR s."name" LIKE 'Red team · %'
             OR s."name" LIKE 'Eval · %' OR s."name" LIKE 'App · %'
             OR (s."name" LIKE '#%' AND s."name" LIKE '% · %')
             OR s."tags" LIKE '%"channel"%'
             OR s."taskKind" = 'org'
             OR EXISTS (SELECT 1 FROM org_runs r WHERE r."sessionId" = s."id"))
      `);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_chat_sessions_kind ON chat_sessions ("workspaceId", "kind", "agentId", "updatedAt")`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_chat_turns_session_created ON chat_turns ("sessionId", "createdAt")`);
    },
  },
  {
    id: '0081-turn-source',
    up: async (db) => {
      // Intervening in a work session (docs/work-log.md): who sent each turn
      // — 'person' when someone typed it, else its origin — so the Work log
      // labels a person's message as theirs; and the run a Rerun re-runs.
      // Old turns stay '' (unknown). Idempotent.
      if (!(await hasColumn(db, 'chat_turns', 'source'))) await db.query(`ALTER TABLE chat_turns ADD COLUMN "source" TEXT NOT NULL DEFAULT ''`);
      if (!(await hasColumn(db, 'chat_turns', 'rerunOf'))) await db.query(`ALTER TABLE chat_turns ADD COLUMN "rerunOf" TEXT`);
    },
  },
  {
    id: '0082-sub-channels',
    up: async (db) => {
      // Sub-channels (docs/group-chat.md §9): a temporary child channel for a
      // meeting or a discussion. Every existing channel is an ordinary,
      // open one ('channel', no parent); old thread meetings stay as they are
      // (no parentChannelId). Idempotent.
      const add = async (table: string, column: string, ddl: string) => {
        if (!(await hasColumn(db, table, column))) await db.query(`ALTER TABLE ${table} ADD COLUMN "${column}" ${ddl}`);
      };
      await add('channels', 'parentChannelId', 'TEXT');
      await add('channels', 'channelKind', `TEXT NOT NULL DEFAULT 'channel'`);
      await add('channels', 'purpose', `TEXT NOT NULL DEFAULT ''`);
      await add('channels', 'status', `TEXT NOT NULL DEFAULT 'open'`);
      await add('channels', 'closedAt', 'TEXT');
      await add('channels', 'closedBy', 'TEXT');
      await add('channels', 'outcome', `TEXT NOT NULL DEFAULT ''`);
      await add('channels', 'meetingId', 'TEXT');
      await add('channels', 'taskId', 'TEXT');
      await add('channels', 'projectId', 'TEXT');
      await add('channels', 'linkMessageId', 'TEXT');
      await add('channels', 'originMessageId', 'TEXT');
      await add('channels', 'lastActivityAt', 'TEXT');
      await add('org_meetings', 'parentChannelId', 'TEXT');
      await db.query(`CREATE INDEX IF NOT EXISTS idx_channels_parent ON channels ("workspaceId", "parentChannelId", "status")`);
    },
  },
  {
    id: '0083-agent-type-models',
    up: async (db) => {
      // Model discovery per agent type (docs/agent-types.md): when the list
      // was last fetched from the provider, and the owner's per-tier picks.
      // Idempotent.
      if (!(await hasColumn(db, 'agent_types', 'modelsFetchedAt'))) await db.query(`ALTER TABLE agent_types ADD COLUMN "modelsFetchedAt" TEXT`);
      if (!(await hasColumn(db, 'agent_types', 'tierModels'))) await db.query(`ALTER TABLE agent_types ADD COLUMN "tierModels" TEXT NOT NULL DEFAULT '{}'`);
    },
  },
  {
    id: '0084-task-mentions',
    up: async (db) => {
      // Mentions in task comments (docs/work-tracking.md "Mentions"): the
      // resolved `@mentions` of a comment, and which person wrote it ('' for
      // agents and the system), so a human comment ends an agent chain.
      // Old comments stay '[]' / ''. Idempotent.
      if (!(await hasColumn(db, 'org_messages', 'mentions'))) await db.query(`ALTER TABLE org_messages ADD COLUMN "mentions" TEXT NOT NULL DEFAULT '[]'`);
      if (!(await hasColumn(db, 'org_messages', 'fromUserId'))) await db.query(`ALTER TABLE org_messages ADD COLUMN "fromUserId" TEXT NOT NULL DEFAULT ''`);
    },
  },
  {
    id: '0085-org-archive',
    up: async (db) => {
      // Archiving a company (docs/owners-seat.md "Archive or delete the
      // company"): when and by whom, and the state restore puts back (the
      // org's status, the workspace's mode and the unit channels the archive
      // closed) as JSON. Idempotent.
      if (!(await hasColumn(db, 'organizations', 'archivedAt'))) await db.query(`ALTER TABLE organizations ADD COLUMN "archivedAt" TEXT`);
      if (!(await hasColumn(db, 'organizations', 'archivedBy'))) await db.query(`ALTER TABLE organizations ADD COLUMN "archivedBy" TEXT NOT NULL DEFAULT ''`);
      if (!(await hasColumn(db, 'organizations', 'archiveState'))) await db.query(`ALTER TABLE organizations ADD COLUMN "archiveState" TEXT NOT NULL DEFAULT '{}'`);
    },
  },
  {
    id: '0086-plugin-registry',
    up: async (db) => {
      // The plugin registry and Foundry's Plugins shelf (docs/plugins.md §7,
      // §8; docs/foundry.md §9): a package's listing (description, publisher
      // display name, where it came from — first_party | local | registry —
      // the one workspace a local package is visible to, whether it is
      // listed, its install count) and, per immutable version, the pin
      // beside the archive digest (a source commitSha), the registry's
      // conformance results per provided interface, the capability summary,
      // the changelog, who published it and who recalled it. Recall itself
      // is the existing revokedAt / revokeReason. Idempotent.
      const add = async (table: string, column: string, ddl: string) => {
        if (!(await hasColumn(db, table, column))) await db.query(`ALTER TABLE ${table} ADD COLUMN "${column}" ${ddl}`);
      };
      await add('plugins', 'description', `TEXT NOT NULL DEFAULT ''`);
      await add('plugins', 'publisherName', `TEXT NOT NULL DEFAULT ''`);
      await add('plugins', 'source', `TEXT NOT NULL DEFAULT 'first_party'`);
      await add('plugins', 'workspaceId', `TEXT NOT NULL DEFAULT ''`);
      await add('plugins', 'listed', `INTEGER NOT NULL DEFAULT 1`);
      await add('plugins', 'installs', `INTEGER NOT NULL DEFAULT 0`);
      await add('plugins', 'updatedAt', `TEXT`);
      await add('plugin_versions', 'commitSha', `TEXT NOT NULL DEFAULT ''`);
      await add('plugin_versions', 'conformance', `TEXT NOT NULL DEFAULT '[]'`);
      await add('plugin_versions', 'capabilities', `TEXT NOT NULL DEFAULT '{}'`);
      await add('plugin_versions', 'changelog', `TEXT NOT NULL DEFAULT ''`);
      await add('plugin_versions', 'publishedBy', `TEXT NOT NULL DEFAULT ''`);
      await add('plugin_versions', 'revokedBy', `TEXT NOT NULL DEFAULT ''`);
      // Local packages from before this migration belong to the workspace that loaded them.
      await db.query(`UPDATE plugins p SET "source" = 'local', "workspaceId" = COALESCE((SELECT MIN(i."workspaceId") FROM plugin_installs i WHERE i."pluginId" = p."pluginId" AND i."accountId" = p."accountId"), '')
        WHERE p."tier" = 'local' AND p."source" = 'first_party'`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_plugin_versions_plugin ON plugin_versions ("accountId", "pluginId")`);
    },
  },
  {
    id: '0087-project-teams',
    up: async (db) => {
      // Heads and cross-functional project teams (docs/work-tracking.md
      // "Project teams", docs/autonomous-skills-review.md "Why heads don't
      // hire"): an explicit head flag on a member (a head whose title is not
      // a catalog head's still staffs its unit); a project's team drawn from
      // any unit (a member, its role on the project and its allocation in
      // percent; `pending` until the member's manager approves the
      // allocation); and the project's channel and standup cadence.
      // Idempotent.
      const add = async (table: string, column: string, ddl: string) => {
        if (!(await hasColumn(db, table, column))) await db.query(`ALTER TABLE ${table} ADD COLUMN "${column}" ${ddl}`);
      };
      await add('org_members', 'isHead', 'INTEGER NOT NULL DEFAULT 0');
      await add('org_projects', 'channelId', 'TEXT');
      await add('org_projects', 'standupCron', `TEXT NOT NULL DEFAULT ''`);
      await add('org_projects', 'standupNextAt', 'TEXT');
      await add('org_projects', 'standupLastAt', 'TEXT');
      await db.query(`
        CREATE TABLE IF NOT EXISTS org_project_members (
          "accountId" TEXT NOT NULL DEFAULT 'single',
          "id" TEXT PRIMARY KEY,
          "orgId" TEXT NOT NULL,
          "projectId" TEXT NOT NULL,
          "agentId" TEXT,
          "humanId" TEXT,
          "role" TEXT NOT NULL DEFAULT '',
          "allocation" INTEGER NOT NULL DEFAULT 0,
          "status" TEXT NOT NULL DEFAULT 'active',
          "approvalId" TEXT,
          "addedBy" TEXT NOT NULL DEFAULT '',
          "joinedAt" TEXT NOT NULL,
          "leftAt" TEXT
        )
      `);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_org_project_members_project ON org_project_members ("projectId", "status")`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_org_project_members_agent ON org_project_members ("orgId", "agentId", "status")`);
    },
  },
  {
    id: '0088-agent-personality',
    up: async (db) => {
      // Agent personalities (docs/agent-writing.md "Personalities"): the
      // agent's personality id from the catalog (agents/personalities.ts),
      // 'none' for a neutral voice, null until assigned. Existing agents get
      // the deterministic pick from their id, the same one a null resolves
      // to at read time. Idempotent.
      if (!(await hasColumn(db, 'agents', 'personality'))) await db.query(`ALTER TABLE agents ADD COLUMN "personality" TEXT`);
      const rows = (await db.query(`SELECT "id" FROM agents WHERE "personality" IS NULL`)).rows as Array<{ id: string }>;
      for (const r of rows) await db.query(`UPDATE agents SET "personality" = $1 WHERE "id" = $2 AND "personality" IS NULL`, [personalityForId(r.id), r.id]);
    },
  },
];

/** The 0038 backfill, also callable on its own (see the migration's rule). */
export async function backfillAgentWorkspaces(db: Queryable): Promise<number> {
  // RETURNING rather than rowCount: PGlite's exec path reports rows only.
  const res = await db.query(`
    UPDATE agents a SET "workspaceId" = COALESCE(
      (SELECT MIN(o."workspaceId") FROM org_members m
         JOIN organizations o ON o."id" = m."orgId"
        WHERE m."agentId" = a."id" AND m."status" <> 'terminated' AND o."status" <> 'archived'
       HAVING COUNT(DISTINCT o."workspaceId") = 1),
      (SELECT w."id" FROM workspaces w WHERE w."accountId" = a."accountId" ORDER BY w."createdAt" ASC, w."id" ASC LIMIT 1)
    )
    WHERE a."workspaceId" = ''
      AND EXISTS (SELECT 1 FROM workspaces w2 WHERE w2."accountId" = a."accountId")
    RETURNING a."id"
  `);
  return res.rows.length;
}

/**
 * Units backfill (migration 0030, also callable on its own): for every live
 * organization, a root unit for the chief (named after the org, slug
 * `company`, channel `#company` — created with every agent of the account
 * and every person of the workspace when missing) and a unit for every
 * member that has direct reports (`#<lead-slug>`, members = lead + reports +
 * the owner and the org's CEO/board humans); then `org_tasks.unitId` and
 * `org_goals.unitId` by the default rule for rows that have none: the unit
 * led by the assignee's (owner's) manager, the root unit for the chief, for
 * root-level members and for unowned rows. Pure SQL, idempotent.
 */
export async function backfillOrgUnits(db: Queryable): Promise<{ units: number }> {
  const now = new Date().toISOString();
  const orgs = (await db.query(`SELECT "id", "accountId", "workspaceId", "name", "chiefOfStaffAgentId" FROM organizations WHERE "status" <> 'archived'`)).rows as Array<{ id: string; accountId: string; workspaceId: string; name: string; chiefOfStaffAgentId: string | null }>;
  let created = 0;
  const slugOf = (name: string) => name.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'unit';
  const rid = (seed: string) => `${seed}-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`.replace(/[^a-z0-9-]/g, '').slice(0, 48);
  for (const org of orgs) {
    if (!org.chiefOfStaffAgentId) continue;
    const members = (await db.query(`SELECT "agentId", "reportsToAgentId", "status" FROM org_members WHERE "orgId" = $1`, [org.id])).rows as Array<{ agentId: string; reportsToAgentId: string | null; status: string }>;
    const live = members.filter((m) => m.status !== 'terminated');
    const humans = new Set<string>([org.accountId]);
    for (const h of (await db.query(`SELECT "memberAccountId" FROM org_humans WHERE "orgId" = $1 AND "role" IN ('ceo', 'board')`, [org.id])).rows as Array<{ memberAccountId: string }>) humans.add(h.memberAccountId);
    const ensureChannel = async (slug: string, name: string, topic: string, agentIds: string[], humanIds: string[], everyone: boolean): Promise<{ id: string; slug: string }> => {
      let s = slug; let n = 2;
      for (;;) {
        const rows = (await db.query(`SELECT "id" FROM channels WHERE "workspaceId" = $1 AND "slug" = $2`, [org.workspaceId, s])).rows as Array<{ id: string }>;
        if (rows.length > 0) { if (slug === 'company') return { id: rows[0].id, slug: s }; s = `${slug}-${n++}`; continue; }
        break;
      }
      const id = rid('ch');
      await db.query(`INSERT INTO channels ("accountId", "id", "workspaceId", "slug", "name", "topic", "kind", "createdBy", "folder", "createdAt") VALUES ($1, $2, $3, $4, $5, $6, 'public', 'system', $7, $8)`, [org.accountId, id, org.workspaceId, s, name, topic, `channels/${s}`, now]);
      const agentsIn = everyone ? ((await db.query(`SELECT "id" FROM agents WHERE "accountId" = $1`, [org.accountId])).rows as Array<{ id: string }>).map((a) => a.id) : agentIds;
      const humansIn = new Set(humanIds);
      if (everyone) for (const m of (await db.query(`SELECT "memberAccountId" FROM workspace_members WHERE "workspaceId" = $1`, [org.workspaceId])).rows as Array<{ memberAccountId: string }>) humansIn.add(m.memberAccountId);
      for (const a of new Set(agentsIn)) await db.query(`INSERT INTO channel_members ("accountId", "id", "channelId", "memberKind", "memberId", "role", "notify", "unprompted", "joinedAt") VALUES ($1, $2, $3, 'agent', $4, 'member', 'mentions', 0, $5)`, [org.accountId, rid('cm'), id, a, now]);
      for (const h of humansIn) await db.query(`INSERT INTO channel_members ("accountId", "id", "channelId", "memberKind", "memberId", "role", "notify", "unprompted", "joinedAt") VALUES ($1, $2, $3, 'human', $4, $5, 'mentions', 0, $6)`, [org.accountId, rid('cm'), id, h, h === org.accountId ? 'owner' : 'member', now]);
      return { id, slug: s };
    };
    const existing = (await db.query(`SELECT "id", "leadAgentId", "archivedAt" FROM org_units WHERE "orgId" = $1`, [org.id])).rows as Array<{ id: string; leadAgentId: string; archivedAt: string | null }>;
    const unitOfLead = new Map(existing.map((u) => [u.leadAgentId, u.id]));
    // root
    let rootId = (await db.query(`SELECT "id" FROM org_units WHERE "orgId" = $1 AND "parentUnitId" IS NULL AND "archivedAt" IS NULL`, [org.id])).rows.map((r) => (r as { id: string }).id)[0];
    if (!rootId) {
      const ch = await ensureChannel('company', 'company', 'Company announcements: hires, reorgs, budgets, the brief.', [], [...humans], true);
      rootId = unitOfLead.get(org.chiefOfStaffAgentId) ?? rid('unit');
      if (unitOfLead.has(org.chiefOfStaffAgentId)) await db.query(`UPDATE org_units SET "parentUnitId" = NULL, "archivedAt" = NULL, "channelId" = COALESCE("channelId", $2) WHERE "id" = $1`, [rootId, ch.id]);
      else { await db.query(`INSERT INTO org_units ("accountId", "id", "orgId", "leadAgentId", "parentUnitId", "name", "slug", "channelId", "archivedAt", "createdAt") VALUES ($1, $2, $3, $4, NULL, $5, 'company', $6, NULL, $7)`, [org.accountId, rootId, org.id, org.chiefOfStaffAgentId, org.name, ch.id, now]); created++; }
      unitOfLead.set(org.chiefOfStaffAgentId, rootId);
    }
    // a unit per lead with live reports
    const leads = [...new Set(live.filter((m) => m.reportsToAgentId && m.reportsToAgentId !== org.chiefOfStaffAgentId).map((m) => m.reportsToAgentId!))].filter((l) => live.some((m) => m.agentId === l));
    const takenSlugs = new Set(((await db.query(`SELECT "slug" FROM org_units WHERE "orgId" = $1`, [org.id])).rows as Array<{ slug: string }>).map((r) => r.slug));
    for (const lead of leads) {
      if (unitOfLead.has(lead)) { await db.query(`UPDATE org_units SET "archivedAt" = NULL WHERE "id" = $1`, [unitOfLead.get(lead)]); continue; }
      const leadName = ((await db.query(`SELECT "name" FROM agents WHERE "id" = $1`, [lead])).rows[0] as { name: string } | undefined)?.name ?? lead.slice(0, 8);
      let slug = slugOf(leadName); for (let n = 2; takenSlugs.has(slug); n++) slug = `${slugOf(leadName)}-${n}`;
      takenSlugs.add(slug);
      const reports = live.filter((m) => m.reportsToAgentId === lead).map((m) => m.agentId);
      const ch = await ensureChannel(slug, slug, `Unit channel of ${leadName}'s team.`, [lead, ...reports], [...humans], false);
      const id = rid('unit');
      await db.query(`INSERT INTO org_units ("accountId", "id", "orgId", "leadAgentId", "parentUnitId", "name", "slug", "channelId", "archivedAt", "createdAt") VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, NULL, $8)`, [org.accountId, id, org.id, lead, `${leadName}'s team`, ch.slug, ch.id, now]);
      unitOfLead.set(lead, id); created++;
    }
    // parents: the unit led by the lead's nearest unit-leading manager
    const managerOf = new Map(members.map((m) => [m.agentId, m.reportsToAgentId]));
    const unitFor = (agentId: string | null | undefined): string => {
      let cur = agentId ? managerOf.get(agentId) ?? null : null;
      for (let i = 0; cur && i < 10; i++) { const u = unitOfLead.get(cur); if (u) return u; cur = managerOf.get(cur) ?? null; }
      return rootId!;
    };
    for (const [lead, id] of unitOfLead) if (id !== rootId) await db.query(`UPDATE org_units SET "parentUnitId" = $2 WHERE "id" = $1`, [id, unitFor(lead)]);
    // tasks and goals by the default rule
    for (const t of (await db.query(`SELECT "id", "assigneeAgentId" FROM org_tasks WHERE "orgId" = $1 AND "unitId" IS NULL`, [org.id])).rows as Array<{ id: string; assigneeAgentId: string | null }>) {
      await db.query(`UPDATE org_tasks SET "unitId" = $2 WHERE "id" = $1`, [t.id, t.assigneeAgentId ? unitFor(t.assigneeAgentId) : rootId]);
    }
    for (const g of (await db.query(`SELECT "id", "ownerAgentId" FROM org_goals WHERE "orgId" = $1 AND "unitId" IS NULL`, [org.id])).rows as Array<{ id: string; ownerAgentId: string | null }>) {
      await db.query(`UPDATE org_goals SET "unitId" = $2 WHERE "id" = $1`, [g.id, g.ownerAgentId ? unitFor(g.ownerAgentId) : rootId]);
    }
  }
  return { units: created };
}

/** Mirrors accounts/account-context.ts SINGLE_ACCOUNT; spelled out here so
 *  the migrator stays dependency-free. */
const SINGLE_ACCOUNT_ID = 'single';

/** Tables that are the account boundary itself rather than inside it. Keep in
 *  step with accounts/scoped-db.ts UNSCOPED_TABLES (minus the ones that
 *  carry accountId as a plain column anyway). */
const TABLES_WITHOUT_ACCOUNT_COLUMN = new Set(['__migrations', 'accounts']);

/**
 * Every application table carries "accountId" (docs/accounts.md §3). This
 * walks the live schema and adds the column + index wherever they are
 * missing, backfilling existing rows to the single account via the DEFAULT.
 * Idempotent and run on every boot after the tracked migrations, so a table
 * created by a later migration on another branch is fenced without anyone
 * remembering to write the ALTER — they only add `...accountScoped()` to its
 * schema.ts definition (the reflection test insists on that half).
 */
export async function ensureAccountColumns(db: Queryable): Promise<string[]> {
  const res = await db.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
  );
  const added: string[] = [];
  for (const { table_name: table } of res.rows as Array<{ table_name: string }>) {
    if (TABLES_WITHOUT_ACCOUNT_COLUMN.has(table) || !/^[a-z_][a-z0-9_]*$/.test(table)) continue;
    if (!(await hasColumn(db, table, 'accountId'))) {
      await db.query(`ALTER TABLE "${table}" ADD COLUMN "accountId" TEXT NOT NULL DEFAULT '${SINGLE_ACCOUNT_ID}'`);
      added.push(table);
    }
    await db.query(`CREATE INDEX IF NOT EXISTS "idx_${table}_account" ON "${table}" ("accountId")`);
  }
  return added;
}

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
    // Account column sweep on every boot (not a tracked migration): tables
    // created by migrations that landed after 0023 get fenced here.
    const fenced = await ensureAccountColumns(db);
    if (fenced.length > 0) logger.log(`added accountId to ${fenced.join(', ')}`);
    // Data repair on every boot (not a tracked migration): turns are created
    // 'running' and finalized in-process, so a crash mid-turn orphans them.
    // Reap them to 'error' so they stop rendering as live.
    const reaped = await db.query(`UPDATE chat_turns SET "status" = 'error' WHERE "status" = 'running'`);
    const reapedCount = (reaped as { rowCount?: number }).rowCount ?? 0;
    if (reapedCount > 0) logger.log(`reaped ${reapedCount} orphaned running turn(s)`);
    // Model repair on every boot (docs/agent-types.md "Backfill"): agents
    // and pinned chat sessions on a model their agent type does not serve
    // (e.g. claude-* on a DeepSeek type) move to the type's default.
    const repaired = await repairAgentModels(db);
    if (repaired.agents + repaired.sessions > 0) logger.log(`repaired models: ${repaired.agents} agent(s), ${repaired.sessions} chat session(s) moved to their agent type's default model`);
  } finally {
    await db.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
  }
}
