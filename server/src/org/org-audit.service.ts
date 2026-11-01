/**
 * OrgAuditService — the append-only, hash-chained record of everything that
 * changed an organisation (docs/autonomous-company.md §4.1 `org_audit`).
 *
 * Every row carries `prevHash` (the previous row's hash for the same org, ''
 * for the first) and `hash` = SHA-256 over the row's own fields plus
 * prevHash. `verify()` recomputes the chain so an edited or deleted row is
 * detectable — the operator-editable `agent_events` table is no longer the
 * only record of what agents did (docs/security.md §i, "no signed audit
 * log"). Appends for one org are serialised in-process so two concurrent
 * writers cannot both read the same tail.
 *
 * Payloads are bounded and should carry summaries or hashes, never tool
 * results: results tend to contain the data the audit log exists to protect.
 */
import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { orgAudit } from '../database/schema';
import { newId, nowIso } from '../common/ids.util';
import { currentAccountId } from '../accounts/account-context';

export type OrgAuditRow = typeof orgAudit.$inferSelect;

export interface AuditEntry {
  actor: string;
  action: string;
  refType?: string;
  refId?: string;
  payload?: Record<string, unknown>;
}

const PAYLOAD_CAP = 4_000;

export function auditHash(row: Pick<OrgAuditRow, 'orgId' | 'seq' | 'actor' | 'action' | 'refType' | 'refId' | 'payload' | 'prevHash' | 'createdAt'>): string {
  return createHash('sha256')
    .update([row.orgId, String(row.seq), row.actor, row.action, row.refType, row.refId, row.payload, row.prevHash, row.createdAt].join('\u0000'))
    .digest('hex');
}

@Injectable()
export class OrgAuditService {
  /** Per-org append queue (see header). */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}

  append(orgId: string, entry: AuditEntry): Promise<OrgAuditRow> {
    const prev = this.queues.get(orgId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(() => this.write(orgId, entry));
    this.queues.set(orgId, next);
    void next.finally(() => { if (this.queues.get(orgId) === next) this.queues.delete(orgId); });
    return next;
  }

  private async write(orgId: string, entry: AuditEntry): Promise<OrgAuditRow> {
    const tail = (await this.db.select().from(orgAudit).where(eq(orgAudit.orgId, orgId)).orderBy(desc(orgAudit.seq)).limit(1)).at(0);
    let payload = JSON.stringify(entry.payload ?? {});
    if (payload.length > PAYLOAD_CAP) payload = JSON.stringify({ truncated: true, head: payload.slice(0, PAYLOAD_CAP - 40) });
    const base = {
      id: newId(), accountId: currentAccountId(), orgId,
      seq: (tail?.seq ?? 0) + 1,
      actor: entry.actor.slice(0, 80),
      action: entry.action.slice(0, 80),
      refType: entry.refType ?? '',
      refId: entry.refId ?? '',
      payload,
      prevHash: tail?.hash ?? '',
      createdAt: nowIso(),
    };
    const row: OrgAuditRow = { ...base, hash: auditHash(base) };
    await this.db.insert(orgAudit).values(row);
    return row;
  }

  async list(orgId: string, opts: { limit?: number; action?: string; actor?: string; refId?: string } = {}): Promise<OrgAuditRow[]> {
    const rows = await this.db.select().from(orgAudit).where(eq(orgAudit.orgId, orgId)).orderBy(desc(orgAudit.seq)).limit(Math.min(500, Math.max(1, opts.limit ?? 100)) * 4);
    return rows
      .filter((r) => (!opts.action || r.action === opts.action) && (!opts.actor || r.actor === opts.actor) && (!opts.refId || r.refId === opts.refId))
      .slice(0, Math.min(500, Math.max(1, opts.limit ?? 100)));
  }

  /** Walk the chain oldest → newest. A gap in seq, a prevHash that does not
   *  match the previous row's hash, or a hash that does not recompute all
   *  fail verification and name the first bad seq. */
  async verify(orgId: string): Promise<{ ok: boolean; length: number; brokenAt: number | null; reason?: string }> {
    const rows = await this.db.select().from(orgAudit).where(and(eq(orgAudit.orgId, orgId))).orderBy(orgAudit.seq);
    let prevHash = '';
    let expectSeq = 1;
    for (const r of rows) {
      if (r.seq !== expectSeq) return { ok: false, length: rows.length, brokenAt: r.seq, reason: `sequence gap: expected ${expectSeq}` };
      if (r.prevHash !== prevHash) return { ok: false, length: rows.length, brokenAt: r.seq, reason: 'prevHash does not match the previous row' };
      if (auditHash(r) !== r.hash) return { ok: false, length: rows.length, brokenAt: r.seq, reason: 'row content does not match its hash' };
      prevHash = r.hash;
      expectSeq++;
    }
    return { ok: true, length: rows.length, brokenAt: null };
  }
}
