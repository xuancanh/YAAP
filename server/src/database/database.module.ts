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
import { Module, Global, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema';
import { runPgMigrations } from './migrator';
import { DRIZZLE_DB } from './database.constants';

export type DrizzleDb = NodePgDatabase<typeof schema>;

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
    return drizzle(pool, { schema });
  },
};

@Global()
@Module({
  providers: [drizzleProvider],
  exports: [DRIZZLE_DB],
})
export class DatabaseModule {}
