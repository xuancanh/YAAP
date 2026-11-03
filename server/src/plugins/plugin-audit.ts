/**
 * The plugin audit chain (docs/plugins.md §5.6): every install, consent,
 * binding, grant, conformance run, update, suspension, effect unwind,
 * change transition and approval pair is one row, hash-chained per
 * workspace like org_audit. A workspace that is an organization also gets
 * the entry on its org_audit chain, through the hook the org module binds
 * on the action contract (`ActionsService.hooks.audit`). Writes are
 * serialised per workspace so `seq` never collides.
 */
import { Inject, Injectable, Optional } from '@nestjs/common';
import { asc, desc, eq } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { pluginAudit } from '../database/schema';
import { newId, nowIso } from '../common/ids.util';
import { currentAccountId } from '../accounts/account-context';
import { sha256 } from '../actions/action-classes';
import { ActionsService } from '../actions/actions.service';

export type PluginAuditRow = typeof pluginAudit.$inferSelect;
export interface PluginAuditEntry { actor: string; action: string; refType?: string; refId?: string; payload?: Record<string, unknown> }

const PAYLOAD_CAP = 8_000;

@Injectable()
export class PluginAuditService {
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    @Optional() private readonly actions?: ActionsService,
  ) {}

  append(workspaceId: string, entry: PluginAuditEntry): Promise<PluginAuditRow> {
    const prev = this.queues.get(workspaceId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(() => this.write(workspaceId, entry));
    this.queues.set(workspaceId, next);
    void next.finally(() => { if (this.queues.get(workspaceId) === next) this.queues.delete(workspaceId); }).catch(() => undefined);
    return next;
  }

  private async write(workspaceId: string, entry: PluginAuditEntry): Promise<PluginAuditRow> {
    const tail = (await this.db.select().from(pluginAudit).where(eq(pluginAudit.workspaceId, workspaceId)).orderBy(desc(pluginAudit.seq)).limit(1)).at(0);
    let payload = JSON.stringify(entry.payload ?? {});
    if (payload.length > PAYLOAD_CAP) payload = JSON.stringify({ truncated: true, head: payload.slice(0, PAYLOAD_CAP - 40) });
    const base = {
      id: newId(), accountId: currentAccountId(), workspaceId,
      seq: (tail?.seq ?? 0) + 1,
      actor: entry.actor.slice(0, 80), action: entry.action.slice(0, 80),
      refType: entry.refType ?? '', refId: entry.refId ?? '', payload,
      prevHash: tail?.hash ?? '', createdAt: nowIso(),
    };
    const row: PluginAuditRow = { ...base, hash: sha256([base.workspaceId, base.seq, base.actor, base.action, base.refType, base.refId, base.payload, base.prevHash, base.createdAt].join('\u0000')) };
    await this.db.insert(pluginAudit).values(row);
    await this.actions?.hooks.audit?.(workspaceId, { actor: row.actor, action: row.action, refType: row.refType, refId: row.refId, payload: entry.payload ?? {} }).catch(() => undefined);
    return row;
  }

  async list(workspaceId: string, opts: { action?: string; refId?: string; limit?: number } = {}): Promise<PluginAuditRow[]> {
    const rows = await this.db.select().from(pluginAudit).where(eq(pluginAudit.workspaceId, workspaceId)).orderBy(asc(pluginAudit.seq));
    return rows.filter((r) => (!opts.action || r.action === opts.action) && (!opts.refId || r.refId === opts.refId)).slice(-(opts.limit ?? 500));
  }

  /** Whether the chain is intact (each row's hash and link). */
  async verify(workspaceId: string): Promise<{ ok: boolean; length: number; brokenAt: number | null }> {
    const rows = await this.db.select().from(pluginAudit).where(eq(pluginAudit.workspaceId, workspaceId)).orderBy(asc(pluginAudit.seq));
    let prev = '';
    for (const r of rows) {
      const h = sha256([r.workspaceId, r.seq, r.actor, r.action, r.refType, r.refId, r.payload, r.prevHash, r.createdAt].join('\u0000'));
      if (r.prevHash !== prev || r.hash !== h) return { ok: false, length: rows.length, brokenAt: r.seq };
      prev = r.hash;
    }
    return { ok: true, length: rows.length, brokenAt: null };
  }
}
