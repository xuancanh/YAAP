/**
 * AppDataService — `yaam.data` and `yaam.sql` (docs/miniapp-roadmap.md §5).
 *
 * `storage` is a 64 KB last-write-wins JSON blob. A habit tracker outgrows it
 * in a year, an expense log in a month, and anything that wants to *query*
 * never fit at all. Two shapes answer that, and both are here:
 *
 *  - `data.*` — app-scoped collections with a bounded query surface (filter,
 *    order, limit). There is no SQL string to parse, so there is no injection
 *    surface: the shape is the allowlist, the same principle that lets apps
 *    touch connections at all.
 *  - `sql.engine()` — the SQLite WASM engine, handed over as bytes so an app
 *    can query a `.db` file it keeps in its own folder. This exists *because*
 *    of the CSP: `default-src 'none'` blocks fetching a .wasm by URL, so the
 *    engine cannot arrive the way it does on the open web. Compilation itself
 *    is fine — script-src carries 'unsafe-eval', which covers WebAssembly.
 *
 * Arbitrary SQL against our own Postgres is refused outright (roadmap §7):
 * untrusted model-written code emitting free-form SQL at the primary database
 * is a blast radius no review gate justifies, and collections cover the
 * demand that motivated the ask.
 *
 * Rows live as JSON under the app's own folder, so export/import carries them
 * and the agent can read them with its fs tools — deliberate, the same way
 * `storage` is readable: an app writing data an agent may read is not an app
 * writing instructions an agent will obey.
 */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { StorageService } from '../storage/storage.service';
import { agentFileKey } from '../storage/storage.keys';
import { AppBridgeService } from './app-bridge.service';

/** Per collection. Past this an app wants the SQLite path, not this one. */
const MAX_ROWS = 5_000;
const MAX_BYTES = 4_000_000;
const MAX_LIMIT = 500;
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/i;

export interface DataRow { id: string; [k: string]: unknown }

export interface DataQuery {
  where?: Record<string, unknown>;
  order?: [string, 'asc' | 'desc'];
  limit?: number;
  offset?: number;
}

/** One filter term. Scalars mean equality; objects express the few operators
 *  worth having. Anything else is rejected rather than guessed at. */
function matches(row: DataRow, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([field, cond]) => {
    const v = row[field];
    if (cond === null || typeof cond !== 'object') return v === cond;
    const c = cond as Record<string, unknown>;
    if ('eq' in c) return v === c.eq;
    if ('ne' in c) return v !== c.ne;
    if ('gt' in c) return (v as number) > (c.gt as number);
    if ('gte' in c) return (v as number) >= (c.gte as number);
    if ('lt' in c) return (v as number) < (c.lt as number);
    if ('lte' in c) return (v as number) <= (c.lte as number);
    // only meaningful on text; an object would stringify to [object Object]
    if ('contains' in c) {
      return typeof v === 'string' && v.toLowerCase().includes(String(c.contains).toLowerCase());
    }
    if ('in' in c) return Array.isArray(c.in) && c.in.includes(v);
    throw new BadRequestException(`unsupported filter on "${field}": ${JSON.stringify(cond).slice(0, 80)}`);
  });
}

@Injectable()
export class AppDataService {
  /** Cached engine bytes — read once, handed to every app that asks. */
  private engine?: { js: string; wasmBase64: string };

  constructor(
    private readonly bridge: AppBridgeService,
    private readonly storage: StorageService,
  ) {}

  private key(agentId: string, appId: string, collection: string): string {
    if (!NAME_RE.test(collection)) {
      throw new BadRequestException('collection must be 1-40 chars of letters, digits, _ or -');
    }
    return agentFileKey(agentId, `apps/${appId}/data/${collection}.json`);
  }

  private async load(key: string): Promise<DataRow[]> {
    const body = await this.storage.get(key);
    if (!body) return [];
    try {
      const parsed = JSON.parse(body.toString('utf8')) as unknown;
      return Array.isArray(parsed) ? (parsed as DataRow[]) : [];
    } catch { return []; }
  }

  /** Insert or replace by id. Read-modify-write with no lock: single-user by
   *  design, and the loser of a race loses one row rather than the file. */
  async put(agentId: string, appId: string, collection: string, row: unknown) {
    await this.bridge.gate(agentId, appId, 'data', 'data.put');
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new BadRequestException('row must be an object');
    }
    const key = this.key(agentId, appId, collection);
    const rows = await this.load(key);
    const incoming = { ...(row as Record<string, unknown>) };
    const id = typeof incoming.id === 'string' && incoming.id ? incoming.id : `r${Date.now()}${rows.length}`;
    const next: DataRow = { ...incoming, id };

    const at = rows.findIndex((r) => r.id === id);
    if (at >= 0) rows[at] = next;
    else rows.push(next);

    if (rows.length > MAX_ROWS) {
      throw new BadRequestException(`collection "${collection}" is full (${MAX_ROWS} rows) — use yaam.sql for larger data`);
    }
    const json = JSON.stringify(rows);
    if (json.length > MAX_BYTES) throw new BadRequestException(`collection "${collection}" exceeds ${MAX_BYTES} bytes`);

    await this.storage.put(key, Buffer.from(json), 'application/json');
    return { ok: true, id, rows: rows.length };
  }

  async query(agentId: string, appId: string, collection: string, q: DataQuery = {}) {
    await this.bridge.gate(agentId, appId, 'data', 'data.query');
    const rows = await this.load(this.key(agentId, appId, collection));
    let out = q.where ? rows.filter((r) => matches(r, q.where!)) : rows.slice();

    if (q.order) {
      const [field, dir] = q.order;
      out.sort((a, b) => {
        const x = a[field], y = b[field];
        if (x === y) return 0;
        return ((x as number) > (y as number) ? 1 : -1) * (dir === 'desc' ? -1 : 1);
      });
    }
    const total = out.length;
    const offset = Math.max(0, q.offset ?? 0);
    out = out.slice(offset, offset + Math.min(q.limit ?? MAX_LIMIT, MAX_LIMIT));
    return { rows: out, total, offset };
  }

  async remove(agentId: string, appId: string, collection: string, id: string) {
    await this.bridge.gate(agentId, appId, 'data', 'data.delete');
    const key = this.key(agentId, appId, collection);
    const rows = await this.load(key);
    const next = rows.filter((r) => r.id !== id);
    if (next.length === rows.length) throw new NotFoundException(`row ${id}`);
    await this.storage.put(key, Buffer.from(JSON.stringify(next)), 'application/json');
    return { ok: true, rows: next.length };
  }

  /**
   * The SQLite engine, as bytes. The app evals the glue and calls
   * `initSqlJs({ wasmBinary })` with the decoded wasm — no URL is ever
   * fetched, which is the only way this works behind `default-src 'none'`.
   */
  async sqlEngine(agentId: string, appId: string) {
    await this.bridge.gate(agentId, appId, 'data', 'data.query');
    if (!this.engine) {
      const dist = dirname(require.resolve('sql.js'));
      const [js, wasm] = await Promise.all([
        readFile(join(dist, 'sql-wasm.js'), 'utf8'),
        readFile(join(dist, 'sql-wasm.wasm')),
      ]);
      this.engine = { js, wasmBase64: wasm.toString('base64') };
    }
    return this.engine;
  }
}
