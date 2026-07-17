/**
 * DatabaseModule — bootstraps a single Drizzle ORM connection for the process.
 *
 * SQLite (better-sqlite3) at DATA_DIR/app.sqlite by default; migrations run on
 * every boot and are idempotent (see migrator.ts). Global so repositories in
 * any feature module can inject DRIZZLE_DB without re-importing this module.
 */
import { Module, Global, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import * as schema from './schema';
import { runSqliteMigrations } from './migrator';
import { DRIZZLE_DB } from './database.constants';

export type DrizzleDb = BetterSQLite3Database<typeof schema>;

const drizzleProvider = {
  provide: DRIZZLE_DB,
  inject: [ConfigService],
  useFactory: (config: ConfigService): DrizzleDb => {
    const appDbPath = config.get<string>('appDbPath')!;
    mkdirSync(dirname(appDbPath), { recursive: true });
    const sqlite = new Database(appDbPath);
    sqlite.pragma('journal_mode = WAL');
    runSqliteMigrations(sqlite, new Logger('DatabaseModule'));
    return drizzle(sqlite, { schema });
  },
};

@Global()
@Module({
  providers: [drizzleProvider],
  exports: [DRIZZLE_DB],
})
export class DatabaseModule {}
