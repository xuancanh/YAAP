/**
 * DatabaseModule — bootstraps a single Drizzle ORM connection for the process.
 *
 * Postgres (node-postgres Pool) via DATABASE_URL; migrations run on every
 * boot and are idempotent (see migrator.ts). Global so repositories in any
 * feature module can inject DRIZZLE_DB without re-importing this module.
 *
 * Tests use PGlite (in-memory Postgres) through the same Drizzle pg dialect
 * and the same migrator, so repository code has exactly one query path.
 */
import { Module, Global, Logger, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema';
import { runPgMigrations } from './migrator';
import { DRIZZLE_DB } from './database.constants';
import { scopeDb } from '../accounts/scoped-db';

export type DrizzleDb = NodePgDatabase<typeof schema>;

/** The one pool behind DRIZZLE_DB, kept module-scoped so the module class
 *  can drain it on shutdown (the factory-local pool is otherwise
 *  unreachable once the provider resolves). */
let pgPool: Pool | null = null;

const drizzleProvider = {
  provide: DRIZZLE_DB,
  inject: [ConfigService],
  useFactory: async (config: ConfigService): Promise<DrizzleDb> => {
    const logger = new Logger('DatabaseModule');
    const pool = new Pool({
      connectionString: config.get<string>('databaseUrl')!,
      // Cap concurrent clients (this is also the pg default — set explicitly
      // so it doesn't silently change under us).
      max: 10,
      // Fail fast when the pool is exhausted or the DB is unreachable
      // instead of queueing connect requests forever (default: no timeout).
      connectionTimeoutMillis: 5000,
      // Server-side kill for runaway queries (default: no limit).
      statement_timeout: 30000,
    });
    pgPool = pool;
    // node-postgres emits 'error' on idle-client failures (DB restart,
    // network blip); without a listener the EventEmitter throws and kills
    // the process.
    pool.on('error', (err) => {
      logger.error(`idle pg client error: ${err.message}`);
    });
    // Migrations hold a session-level advisory lock, so they need one
    // dedicated client — pool.query could scatter lock/unlock across
    // sessions.
    const client = await pool.connect();
    try {
      await runPgMigrations(client, logger);
    } finally {
      client.release();
    }
    // Every repository sees the account-scoped handle (accounts/scoped-db.ts):
    // the tenant boundary is a property of DRIZZLE_DB, not of each query.
    return scopeDb(drizzle(pool, { schema }));
  },
};

@Global()
@Module({
  providers: [drizzleProvider],
  exports: [DRIZZLE_DB],
})
export class DatabaseModule implements OnApplicationShutdown {
  /** Drain the pool on shutdown. onApplicationShutdown runs after every
   *  provider's onModuleDestroy (e.g. TurnLoopService aborting in-flight
   *  turns), so those turns can still write their final turn/session state
   *  before the pool goes away. */
  async onApplicationShutdown(): Promise<void> {
    await pgPool?.end();
    pgPool = null;
  }
}
