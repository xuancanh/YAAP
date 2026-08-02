/**
 * StatusService — readiness probe behind GET /api/status. The route doubles
 * as the liveness probe (AuthGuard leaves it open), so checks must stay cheap:
 * the only dependency probed is Postgres via `SELECT 1` on the pooled Drizzle
 * handle, capped at 2s. S3 is deliberately not probed — StorageService already
 * tolerates an unreachable bucket at boot, and a head-bucket round trip would
 * slow every liveness hit.
 */
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';

const DB_PROBE_TIMEOUT_MS = 2000;

@Injectable()
export class StatusService {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}

  /** Resolves true when Postgres answers `SELECT 1` within the timeout. */
  async databaseUp(): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try {
      // .then(true, false) so a late DB error after the timeout wins the race
      // can't surface as an unhandled rejection.
      const probe = this.db.execute(sql`SELECT 1`).then(
        () => true,
        () => false,
      );
      const timeout = new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), DB_PROBE_TIMEOUT_MS);
      });
      return await Promise.race([probe, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}
