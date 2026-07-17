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
    const pool = new Pool({ connectionString: config.get<string>('databaseUrl')! });
    await runPgMigrations(pool, new Logger('DatabaseModule'));
    return drizzle(pool, { schema });
  },
};

@Global()
@Module({
  providers: [drizzleProvider],
  exports: [DRIZZLE_DB],
})
export class DatabaseModule {}
