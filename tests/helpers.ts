/** Shared test doubles: in-memory storage, PGlite bootstrap, context stubs. */
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '../server/src/database/schema';
import { runPgMigrations, Queryable } from '../server/src/database/migrator';
import type { DrizzleDb } from '../server/src/database/database.module';
import type { StorageService } from '../server/src/storage/storage.service';
import type { TurnContextService, TurnContext } from '../server/src/chats/turn-context.service';
import { AiProvider, AiRequest, AiStreamEvent } from '../server/src/ai/ai-provider.interface';

/** Adapt PGlite to the migrator's pg-Pool-shaped interface: `exec` for
 *  multi-statement DDL (simple protocol), `query` when params are bound. */
export function pgliteQueryable(pg: PGlite): Queryable {
  return {
    query: async (sql: string, params?: unknown[]) => {
      if (params && params.length > 0) return pg.query(sql, params);
      const results = await pg.exec(sql);
      return { rows: results.at(-1)?.rows ?? [] };
    },
  };
}

export async function testDb(): Promise<DrizzleDb> {
  const pg = new PGlite();
  await runPgMigrations(pgliteQueryable(pg), { log: () => {} });
  return drizzle(pg, { schema }) as unknown as DrizzleDb;
}

/** In-memory stand-in for the S3 StorageService (structural match). */
export function memStorage() {
  const map = new Map<string, Buffer>();
  const stub = {
    map,
    async put(key: string, body: Buffer) { map.set(key, Buffer.from(body)); },
    async get(key: string) { return map.get(key) ?? null; },
    async delete(key: string) { map.delete(key); },
    async list(prefix: string) {
      return [...map.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([k, v]) => ({ key: k, size: v.length }));
    },
    async deletePrefix(prefix: string) {
      for (const k of [...map.keys()]) if (k.startsWith(prefix)) map.delete(k);
    },
  };
  return { stub: stub as unknown as StorageService, map };
}

/** TurnContextService stub returning a fixed provider. */
export function ctxStub(provider: AiProvider, overrides: Partial<TurnContext> = {}): TurnContextService {
  return {
    build: async () => ({ provider, model: 'test-model', system: '', maxToolRounds: 24, ...overrides }),
  } as unknown as TurnContextService;
}

/** Provider that plays one scripted event list per stream() call (per round). */
export class ScriptedProvider implements AiProvider {
  readonly name = 'scripted';
  readonly requests: AiRequest[] = [];
  private round = 0;

  constructor(private readonly rounds: AiStreamEvent[][]) {}

  async *stream(req: AiRequest): AsyncGenerator<AiStreamEvent> {
    this.requests.push(req);
    const events = this.rounds[this.round++] ?? [{ type: 'done' } as AiStreamEvent];
    for (const ev of events) yield ev;
  }
}
