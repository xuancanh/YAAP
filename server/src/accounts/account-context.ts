/**
 * Account context — which tenant the current unit of work belongs to
 * (docs/accounts.md §3).
 *
 * The context is an AsyncLocalStorage store, not a request-scoped Nest
 * provider: services keep their default (singleton) scope, background work
 * (loop ticks, channel sweeps, webhook fires) sets it per account it
 * processes, and anything that awaits inside the context inherits it —
 * timers, promise chains, async generators included.
 *
 *  - HTTP: `accountContextMiddleware` opens an empty store per request;
 *    `AuthGuard` fills it with `bindAccount()` once the strategy has
 *    resolved the caller. Public routes leave it empty.
 *  - Background: `runWithAccount(id, fn)` opens a store with the id set.
 *  - Reads: `currentAccountId()` — the bound id, or SINGLE_ACCOUNT when no
 *    store or no binding exists. That default is what keeps `AUTH_MODE=single`
 *    behaving exactly as before: every row is the single account's row.
 *
 * Two helpers are the one-line adoption path for new tables:
 *  - `accountScoped()` — spread into a pgTable's columns.
 *  - `withAccount(table, cond?)` — the WHERE fragment for hand-written
 *    queries (the scoped db in scoped-db.ts adds it automatically for
 *    Drizzle builders; this is for `db.execute(sql…)` call sites).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { and, eq, type SQL } from 'drizzle-orm';
import { text, type PgColumn } from 'drizzle-orm/pg-core';
import type { NextFunction, Request, Response } from 'express';

/** The one account every row belongs to in AUTH_MODE=single. Also the
 *  backfill value of every pre-tenancy row (migration 0023). */
export const SINGLE_ACCOUNT = 'single';

interface AccountStore { accountId?: string }

const als = new AsyncLocalStorage<AccountStore>();

/** The account the current async context works for. Never empty. */
export function currentAccountId(): string {
  return als.getStore()?.accountId ?? SINGLE_ACCOUNT;
}

/** True when a context was opened (request or runWithAccount) and bound. */
export function hasBoundAccount(): boolean {
  return Boolean(als.getStore()?.accountId);
}

/** Run `fn` with every query scoped to `accountId`. Nested calls are fine;
 *  the innermost wins for its own continuation only. */
export function runWithAccount<T>(accountId: string, fn: () => T): T {
  return als.run({ accountId }, fn);
}

/** Bind the account for the rest of the current context. Returns false when
 *  no store is open (a guard instantiated outside the middleware, e.g. in
 *  unit tests), so callers can decide whether that is an error. */
export function bindAccount(accountId: string): boolean {
  const store = als.getStore();
  if (!store) return false;
  store.accountId = accountId;
  return true;
}

/** Express middleware: one empty store per request for the guard to fill.
 *  Installed first in bootstrap.ts so every handler and everything it awaits
 *  runs inside it. */
export function accountContextMiddleware(_req: Request, _res: Response, next: NextFunction): void {
  als.run({}, () => next());
}

// ---- schema + query helpers ----

/** The tenant column every table carries. Spread into pgTable columns:
 *
 *    export const widgets = pgTable('widgets', { id: text('id').primaryKey(), ...accountScoped(), … });
 *
 *  The migrator's ensureAccountColumns() adds the column and its index to any
 *  table that lacks them on boot, so no migration line is needed; the schema
 *  reflection test (tests/backend-accounts.test.ts) fails loudly when the
 *  schema side is forgotten. */
export function accountScoped() {
  return { accountId: text('accountId').notNull().default(SINGLE_ACCOUNT) };
}

/** WHERE fragment restricting `table` to the current account, AND-ed with
 *  `cond` when given. For hand-written Drizzle queries that bypass the scoped
 *  db (the scoped db adds this automatically). */
export function withAccount(table: { accountId: PgColumn }, cond?: SQL): SQL {
  const scope = eq(table.accountId, currentAccountId());
  return cond ? (and(scope, cond) as SQL) : scope;
}
