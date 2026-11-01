/**
 * scopeDb — the Drizzle handle every repository injects as DRIZZLE_DB, with
 * the account boundary applied at the query-builder level (docs/accounts.md
 * §3).
 *
 * Why here and not in ~150 call sites: tenancy was retrofitted onto a
 * single-user data model, and the failure mode of hand-threading a WHERE
 * clause through every repository is one forgotten clause that leaks a
 * tenant's rows. The wrapper makes the scope a property of the handle:
 *
 *  - `select…from(t)`, `update(t).set(…)`, `delete(t)` get
 *    `WHERE t."accountId" = currentAccountId()` AND-ed onto whatever `where`
 *    the caller adds (or no `where` at all);
 *  - `insert(t).values(rows)` stamps `accountId` on every row that does not
 *    set it;
 *  - `transaction(cb)` hands `cb` a scoped transaction handle.
 *
 * A table takes part the moment it has an `accountId` column (the
 * `accountScoped()` spread), so a new table written on another branch is
 * fenced as soon as its schema line lands — no repository change. Tables in
 * UNSCOPED_TABLES are the account infrastructure itself (keyed by account by
 * hand, read before any account is bound).
 *
 * `db.execute(sql…)` is deliberately untouched: raw SQL is the escape hatch,
 * and the few call sites key on ids that are already unique (agentId,
 * sessionId, workspaceId). `unscoped(db)` returns the bare handle for the
 * cross-account lookups channels and webhooks need before they know whose
 * agent a message is for.
 */
import { and, eq, getTableColumns, getTableName, is, type SQL } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { currentAccountId } from './account-context';

/** Account infrastructure: never auto-scoped (see header). */
export const UNSCOPED_TABLES: ReadonlySet<string> = new Set([
  'accounts', 'account_sessions', 'account_login_tokens', 'account_usage',
]);

const UNSCOPED = Symbol.for('yaam.unscopedDb');

type WhereArg = SQL | undefined | ((fields: unknown) => SQL | undefined);
interface WhereBuilder { where(w?: WhereArg): unknown }
interface SelectBuilder { from(source: unknown): WhereBuilder }
interface UpdateBuilder { set(values: unknown): WhereBuilder }
interface InsertBuilder { values(values: unknown): unknown }
type AnyFn = (...args: unknown[]) => unknown;

/** The scope predicate for `table`, or null when it is not account-scoped. */
export function accountScopeOf(table: unknown): SQL | null {
  if (!is(table, PgTable)) return null;
  if (UNSCOPED_TABLES.has(getTableName(table))) return null;
  const col = getTableColumns(table).accountId;
  if (!col) return null;
  return eq(col, currentAccountId());
}

/** Set the scope now, and fold any later `.where(x)` into `scope AND x`. */
function fence(builder: WhereBuilder, scope: SQL): void {
  const original = builder.where.bind(builder);
  original(scope);
  builder.where = (w?: WhereArg) => {
    if (typeof w === 'function') return original((fields: unknown) => and(scope, w(fields)));
    return original(w ? and(scope, w) : scope);
  };
}

function scopeSelect(builder: SelectBuilder): SelectBuilder {
  const from = builder.from.bind(builder);
  builder.from = (source: unknown) => {
    const base = from(source);
    const scope = accountScopeOf(source);
    if (scope) fence(base, scope);
    return base;
  };
  return builder;
}

function scopeUpdate(builder: UpdateBuilder, table: unknown): UpdateBuilder {
  const scope = accountScopeOf(table);
  if (!scope) return builder;
  const set = builder.set.bind(builder);
  builder.set = (values: unknown) => {
    const base = set(values);
    fence(base, scope);
    return base;
  };
  return builder;
}

function scopeInsert(builder: InsertBuilder, table: unknown): InsertBuilder {
  if (!accountScopeOf(table)) return builder;
  const values = builder.values.bind(builder);
  builder.values = (rows: unknown) => {
    const accountId = currentAccountId();
    const stamp = (r: unknown) => {
      const row = r as Record<string, unknown>;
      return row.accountId === undefined ? { ...row, accountId } : row;
    };
    return values(Array.isArray(rows) ? rows.map(stamp) : stamp(rows));
  };
  return builder;
}

/** Wrap a Drizzle database (or transaction) handle. Idempotent. */
export function scopeDb<T extends object>(db: T): T {
  if (UNSCOPED in db) return db;
  return new Proxy(db, {
    get(target, prop) {
      if (prop === UNSCOPED) return target;
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof value !== 'function') return value;
      const fn = value as AnyFn;
      switch (prop) {
        case 'select':
        case 'selectDistinct':
          return (...args: unknown[]) => scopeSelect(fn.apply(target, args) as SelectBuilder);
        case 'insert':
          return (table: unknown) => scopeInsert(fn.call(target, table) as InsertBuilder, table);
        case 'update':
          return (table: unknown) => scopeUpdate(fn.call(target, table) as UpdateBuilder, table);
        case 'delete':
          return (table: unknown) => {
            const base = fn.call(target, table) as WhereBuilder;
            const scope = accountScopeOf(table);
            if (scope) fence(base, scope);
            return base;
          };
        case 'transaction':
          return (cb: (tx: object) => unknown, config?: unknown) =>
            fn.call(target, (tx: object) => cb(scopeDb(tx)), config);
        default:
          return fn.bind(target);
      }
    },
    has(target, prop) {
      return prop === UNSCOPED || Reflect.has(target, prop);
    },
  });
}

/** The bare handle behind a scoped one (or `db` itself when not wrapped).
 *  For the handful of cross-account lookups — resolving which account owns
 *  an agent slug, a paired Telegram chat, a webhook target — and for the
 *  account tables. Every use should say why in a comment. */
export function unscoped<T extends object>(db: T): T {
  return ((db as Record<symbol, unknown>)[UNSCOPED] as T | undefined) ?? db;
}
