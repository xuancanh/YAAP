/**
 * The generic change record (docs/plugins.md §4.8): propose → review →
 * gate → apply → verify, or roll back. The core knows no kinds — a kind is
 * a string an interface declares (`<iface>.<kind>`), or `core.manual`, a
 * change a human attests to. The lifecycle, its gates and its deadlines
 * hold the same for every kind:
 *
 *  - a review counts only when the reviewer is not the proposer;
 *  - the apply gate needs a reviewed record, then the requirement (trust,
 *    cosign, two_key, owner_key): above `trust` the owner's key on the
 *    record is the one-shot key the apply call spends;
 *  - an apply or rollback names its record and must hit the pinned `bind`;
 *  - verify checks come from the kind and from plugins' `verifies`; a
 *    check whose interface has no bound provider is `unverifiable` and the
 *    record waits for an attested one; a failed or lapsed check rolls back
 *    unattended (the approval covered apply and rollback together);
 *  - no answer is a no: a gate past its deadline is rejected `unavailable`.
 *
 * Every transition is a plugin-audit row and a `change.transitioned` event.
 * Deadlines live on the row, so a restart resumes the wait (`sweep`).
 */
import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { and, desc, eq, inArray, isNotNull, lte } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { changeRecords } from '../database/schema';
import { newId, nowIso } from '../common/ids.util';
import { actorId, currentAccountId } from '../accounts/account-context';
import { ActionsService } from '../actions/actions.service';
import { isActionClass } from '../actions/action-classes';
import type { Requirement } from './manifest';
import type { ApprovalOutcome } from './policy';
import { matchExpr, parseDuration } from './template';
import { PluginAuditService } from './plugin-audit';
import { pluginsTunable } from './plugins-tunables';

export type ChangeRow = typeof changeRecords.$inferSelect;
export type ChangeState = 'proposed' | 'reviewed' | 'gated' | 'approved' | 'applied' | 'verifying' | 'verified' | 'rolling_back' | 'rolled_back' | 'rejected' | 'abandoned' | 'failed';
export const MANUAL_KIND = 'core.manual';

const NEXT: Record<ChangeState, ChangeState[]> = {
  proposed: ['reviewed', 'abandoned'],
  reviewed: ['proposed', 'gated', 'abandoned'],
  gated: ['approved', 'rejected', 'proposed'],
  approved: ['proposed', 'applied', 'failed'],
  applied: ['verifying', 'verified'],
  verifying: ['verified', 'rolling_back'],
  rolling_back: ['rolled_back', 'failed'],
  verified: [], rolled_back: [], rejected: [], abandoned: [], failed: [],
};

export interface VerifyCheck {
  source: string;
  event?: string;
  match?: string;
  within: string;
  status: 'pending' | 'pass' | 'fail' | 'unverifiable';
  detail?: string;
}
export interface Keys { requestId?: string; askedAt?: string; owner?: { by: string; approve: boolean; at: string }; outcome?: ApprovalOutcome; used?: boolean; by?: string }
export interface Review { by: string; approve: boolean; counts: boolean; at: string; note?: string }

export interface TransitionEvent { type: 'change.transitioned'; workspaceId: string; changeId: string; kind: string; from: ChangeState | null; to: ChangeState; by: string; why: string; at: string }

/** Supplied by the dispatcher: runs the kind's rollback-role operation for a record. */
export type RollbackRunner = (rec: ChangeRow) => Promise<{ ok: boolean; actionId?: string; detail: string } | null>;

function parse<T>(raw: string | null | undefined, fallback: T): T {
  try { return raw ? JSON.parse(raw) as T : fallback; } catch { return fallback; }
}

@Injectable()
export class ChangesService {
  private readonly listeners: Array<(ev: TransitionEvent) => void> = [];
  rollbackRunner?: RollbackRunner;
  /** Supplied by the dispatcher: whether an interface has a healthy bound provider (checks on unbound interfaces are unverifiable). */
  isBound?: (workspaceId: string, iface: string) => Promise<boolean>;

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly audit: PluginAuditService,
    @Optional() private readonly actions?: ActionsService,
  ) {}

  onTransition(fn: (ev: TransitionEvent) => void): () => void {
    this.listeners.push(fn);
    return () => { const i = this.listeners.indexOf(fn); if (i >= 0) this.listeners.splice(i, 1); };
  }

  async get(workspaceId: string, id: string): Promise<ChangeRow> {
    const row = (await this.db.select().from(changeRecords).where(and(eq(changeRecords.id, id), eq(changeRecords.workspaceId, workspaceId)))).at(0);
    if (!row) throw new NotFoundException(`change ${id}`);
    return row;
  }

  async list(workspaceId: string, q: { state?: string; kind?: string; limit?: number } = {}): Promise<ChangeRow[]> {
    const rows = await this.db.select().from(changeRecords).where(eq(changeRecords.workspaceId, workspaceId)).orderBy(desc(changeRecords.createdAt));
    return rows.filter((r) => (!q.state || r.state === q.state) && (!q.kind || r.kind === q.kind)).slice(0, q.limit ?? 100);
  }

  /** Records of a kind whose pinned bind includes these fields (for review and update roles). */
  async findByBind(workspaceId: string, kind: string, bind: Record<string, unknown>): Promise<ChangeRow | null> {
    const rows = await this.db.select().from(changeRecords).where(and(eq(changeRecords.workspaceId, workspaceId), eq(changeRecords.kind, kind))).orderBy(desc(changeRecords.createdAt));
    return rows.find((r) => !['verified', 'rolled_back', 'rejected', 'abandoned', 'failed'].includes(r.state) && bindMatches(parse(r.bind, {}), bind)) ?? null;
  }

  async create(workspaceId: string, p: {
    kind: string; title: string; proposer: string; ref?: string; bind?: Record<string, unknown>; taskId?: string | null;
    interfaceVersionId?: string | null; providerId?: string | null; bindingScope?: string | null; requirement: Requirement; checks?: VerifyCheck[];
  }): Promise<ChangeRow> {
    const now = nowIso();
    const row: ChangeRow = {
      accountId: currentAccountId(), id: newId(), workspaceId, kind: p.kind, interfaceVersionId: p.interfaceVersionId ?? null, providerId: p.providerId ?? null,
      bindingScope: p.bindingScope ?? null, ref: p.ref ?? '', bind: JSON.stringify(p.bind ?? {}), title: p.title.slice(0, 300), state: 'proposed',
      proposer: p.proposer, taskId: p.taskId ?? null, reviews: '[]', requirement: p.requirement, approvalId: null, keys: '{}', applyActionId: null,
      verify: JSON.stringify({ checks: p.checks ?? [] }), rollbackActionId: null, deadlineAt: null, history: '[]', createdAt: now, updatedAt: now,
    };
    await this.db.insert(changeRecords).values(row);
    await this.recordTransition(row, null, 'proposed', p.proposer, 'proposed');
    return (await this.get(workspaceId, row.id));
  }

  private async recordTransition(rec: ChangeRow, from: ChangeState | null, to: ChangeState, by: string, why: string, patch: Partial<ChangeRow> = {}): Promise<ChangeRow> {
    const at = nowIso();
    const history = parse<Array<Record<string, unknown>>>(rec.history, []);
    history.push({ from, to, by, why: why.slice(0, 300), at });
    const next = { ...patch, state: to, history: JSON.stringify(history.slice(-100)), updatedAt: at };
    await this.db.update(changeRecords).set(next).where(eq(changeRecords.id, rec.id));
    await this.audit.append(rec.workspaceId, { actor: by, action: 'change_transitioned', refType: 'change', refId: rec.id, payload: { kind: rec.kind, from, to, why } });
    const ev: TransitionEvent = { type: 'change.transitioned', workspaceId: rec.workspaceId, changeId: rec.id, kind: rec.kind, from, to, by, why, at };
    for (const fn of this.listeners) { try { fn(ev); } catch { /* listeners isolate their own failures */ } }
    return { ...rec, ...next } as ChangeRow;
  }

  /** One lifecycle step; refuses anything the diagram does not allow. */
  async transition(rec: ChangeRow, to: ChangeState, by: string, why: string, patch: Partial<ChangeRow> = {}): Promise<ChangeRow> {
    const from = rec.state as ChangeState;
    if (!NEXT[from]?.includes(to)) throw new BadRequestException(`a ${from} change cannot become ${to}`);
    return this.recordTransition(rec, from, to, by, why, patch);
  }

  // ---- review ----

  async review(workspaceId: string, id: string, p: { by: string; approve: boolean; note?: string }): Promise<ChangeRow> {
    const rec = await this.get(workspaceId, id);
    if (!['proposed', 'reviewed'].includes(rec.state)) throw new BadRequestException(`a ${rec.state} change takes no reviews`);
    const counts = p.by !== rec.proposer;
    const reviews = parse<Review[]>(rec.reviews, []);
    reviews.push({ by: p.by, approve: p.approve, counts, at: nowIso(), ...(p.note ? { note: p.note.slice(0, 500) } : {}) });
    await this.db.update(changeRecords).set({ reviews: JSON.stringify(reviews), updatedAt: nowIso() }).where(eq(changeRecords.id, rec.id));
    const fresh = await this.get(workspaceId, id);
    if (counts && p.approve && rec.state === 'proposed') return this.transition(fresh, 'reviewed', p.by, 'an independent review approved it');
    if (counts && !p.approve && rec.state === 'reviewed') return this.transition(fresh, 'proposed', p.by, 'an independent review asked for changes');
    return fresh;
  }

  // ---- the gate ----

  async requestApply(workspaceId: string, id: string, by: string): Promise<ChangeRow> {
    const rec = await this.get(workspaceId, id);
    if (rec.state === 'approved' || rec.state === 'gated') return rec;
    if (rec.state !== 'reviewed') {
      const why = rec.state === 'proposed' ? 'it has no independent review yet (the proposer\'s own review does not count)' : `it is ${rec.state}`;
      throw new BadRequestException(`the apply gate needs a reviewed change; ${why}`);
    }
    const org = this.actions ? await this.actions.trust.orgOf(workspaceId) : null;
    const deadline = new Date(Date.now() + pluginsTunable(org, 'plugins.gateDeadlineHours') * 3_600_000).toISOString();
    const keys: Keys = { requestId: newId(), askedAt: nowIso() };
    const gated = await this.transition(rec, 'gated', by, `apply requested; requirement ${rec.requirement}`, { keys: JSON.stringify(keys), deadlineAt: deadline });
    await this.audit.append(workspaceId, { actor: by, action: 'approval_asked', refType: 'change', refId: rec.id, payload: { requestId: keys.requestId, requirement: rec.requirement } });
    if (rec.requirement === 'trust') {
      // No key needed on the record: the apply call itself goes through the
      // trust decision of its class.
      keys.outcome = 'allowed-once';
      keys.by = 'trust';
      await this.audit.append(workspaceId, { actor: 'system', action: 'approval_decided', refType: 'change', refId: rec.id, payload: { requestId: keys.requestId, outcome: 'allowed-once', by: 'the trust decision of the apply call' } });
      return this.transition(gated, 'approved', 'system', 'the requirement is the trust decision of the apply call', { keys: JSON.stringify(keys), deadlineAt: null });
    }
    return gated;
  }

  /** The owner's key on a gated record (two_key, owner_key; cosign accepts it too). */
  async key(workspaceId: string, id: string, approve: boolean, note = '', actor = actorId()): Promise<ChangeRow> {
    const isOwner = this.actions ? await this.actions.trust.isOwnerOrCeo(workspaceId, actor) : actor === currentAccountId();
    if (!isOwner) throw new ForbiddenException('only the owner or the CEO holds this key');
    const rec = await this.get(workspaceId, id);
    if (rec.state !== 'gated') throw new BadRequestException(`the change is ${rec.state}, not waiting for a key`);
    const keys = parse<Keys>(rec.keys, {});
    keys.owner = { by: actor, approve, at: nowIso() };
    keys.outcome = approve ? 'allowed-once' : 'rejected';
    await this.audit.append(workspaceId, { actor, action: 'approval_decided', refType: 'change', refId: rec.id, payload: { requestId: keys.requestId, outcome: keys.outcome, note } });
    return this.transition(rec, approve ? 'approved' : 'rejected', actor, approve ? `the owner's key${note ? `: ${note}` : ''}` : `the owner said no${note ? `: ${note}` : ''}`, { keys: JSON.stringify(keys), deadlineAt: null });
  }

  /**
   * The change gate for an apply or rollback call (§4.8): the record exists,
   * is in the state the role needs, and the call's input hits the pinned
   * bind on every field the operation's input carries. `preKeyed` says the
   * record's one-shot owner key covers this call.
   */
  async gate(workspaceId: string, id: unknown, role: 'apply' | 'rollback', kind: string, input: Record<string, unknown>, inputFields: string[]):
    Promise<{ ok: true; rec: ChangeRow; preKeyed: { by: string; requestId: string } | null } | { ok: false; reason: string }> {
    if (typeof id !== 'string' || !id) return { ok: false, reason: `an ${role} names its change record (changeId)` };
    const rec = (await this.db.select().from(changeRecords).where(and(eq(changeRecords.id, id), eq(changeRecords.workspaceId, workspaceId)))).at(0);
    if (!rec) return { ok: false, reason: `no change record ${id}` };
    if (rec.kind !== kind) return { ok: false, reason: `change ${id} is a ${rec.kind}, not a ${kind}` };
    const want = role === 'apply' ? 'approved' : 'rolling_back';
    if (rec.state !== want && !(role === 'rollback' && ['applied', 'verifying'].includes(rec.state))) {
      return { ok: false, reason: `change ${id.slice(0, 8)} is ${rec.state}; ${role === 'apply' ? 'apply needs an approved record (review it, request the apply gate, get the key)' : 'rollback needs an applied record'}` };
    }
    const bind = parse<Record<string, unknown>>(rec.bind, {});
    for (const f of inputFields) {
      if (!(f in bind)) continue;
      if (JSON.stringify(input[f]) !== JSON.stringify(bind[f])) return { ok: false, reason: `the call's ${f} (${JSON.stringify(input[f])}) is not the reviewed target's (${JSON.stringify(bind[f])})` };
    }
    const keys = parse<Keys>(rec.keys, {});
    const preKeyed = role === 'apply' && keys.owner?.approve && !keys.used ? { by: keys.owner.by, requestId: keys.requestId ?? '' } : role === 'rollback' && keys.owner?.approve ? { by: keys.owner.by, requestId: keys.requestId ?? '' } : null;
    return { ok: true, rec, preKeyed };
  }

  async spendKey(rec: ChangeRow): Promise<void> {
    const keys = parse<Keys>(rec.keys, {});
    keys.used = true;
    await this.db.update(changeRecords).set({ keys: JSON.stringify(keys) }).where(eq(changeRecords.id, rec.id));
  }

  // ---- apply, verify, roll back ----

  async applied(workspaceId: string, id: string, p: { by: string; actionId?: string | null; output?: Record<string, unknown> }): Promise<ChangeRow> {
    const rec = await this.get(workspaceId, id);
    const verify = parse<{ checks: VerifyCheck[]; applied?: Record<string, unknown> }>(rec.verify, { checks: [] });
    verify.applied = p.output ?? {};
    const appliedRec = await this.transition(rec, 'applied', p.by, 'the apply-role operation succeeded on the bound target', { applyActionId: p.actionId ?? null, verify: JSON.stringify(verify) });
    await this.spendKey(appliedRec);
    if (verify.checks.length === 0) return this.transition(appliedRec, 'verified', 'system', 'no verify checks declared');
    for (const c of verify.checks) {
      const iface = c.event?.split('.')[0];
      if (c.event && iface && this.isBound && !(await this.isBound(workspaceId, iface))) { c.status = 'unverifiable'; c.detail = `no ${iface} provider is bound; waiting for an attested check`; }
    }
    const within = Math.max(...verify.checks.map((c) => parseDuration(c.within) ?? 3_600_000));
    return this.transition(appliedRec, 'verifying', 'system', `${verify.checks.length} verify check(s) armed`, { verify: JSON.stringify(verify), deadlineAt: new Date(Date.now() + within).toISOString() });
  }

  /** An apply that failed: a conflict means the target moved (back to proposed). */
  async applyFailed(workspaceId: string, id: string, p: { by: string; code: string; detail: string }): Promise<ChangeRow> {
    const rec = await this.get(workspaceId, id);
    if (rec.state !== 'approved') return rec;
    if (p.code === 'conflict') return this.transition(rec, 'proposed', p.by, `the bound target changed (${p.detail}); review it again`, { keys: '{}', deadlineAt: null });
    return this.transition(rec, 'failed', p.by, `apply failed: ${p.code}: ${p.detail}`);
  }

  /** The bound target changed (a new head, say): back to proposed, keys spent. */
  async targetChanged(workspaceId: string, id: string, bind: Record<string, unknown>, by = 'system'): Promise<ChangeRow> {
    const rec = await this.get(workspaceId, id);
    if (!['reviewed', 'gated', 'approved'].includes(rec.state)) {
      await this.db.update(changeRecords).set({ bind: JSON.stringify({ ...parse(rec.bind, {}), ...bind }), updatedAt: nowIso() }).where(eq(changeRecords.id, id));
      return this.get(workspaceId, id);
    }
    return this.transition(rec, 'proposed', by, 'the bound target changed', { bind: JSON.stringify({ ...parse(rec.bind, {}), ...bind }), keys: '{}', deadlineAt: null, reviews: '[]' });
  }

  /** An event from the bus: settle the verify checks it satisfies. */
  async ingestEvent(workspaceId: string, ev: { type: string; payload: Record<string, unknown> }): Promise<ChangeRow[]> {
    const rows = await this.db.select().from(changeRecords).where(and(eq(changeRecords.workspaceId, workspaceId), eq(changeRecords.state, 'verifying')));
    const done: ChangeRow[] = [];
    for (const rec of rows) {
      const verify = parse<{ checks: VerifyCheck[]; applied?: Record<string, unknown> }>(rec.verify, { checks: [] });
      let touched = false;
      for (const c of verify.checks) {
        if (c.status === 'pass' || c.status === 'fail' || c.event !== ev.type || !c.match) continue;
        if (matchExpr(c.match, ev.payload, { applied: verify.applied ?? {}, bind: parse(rec.bind, {}) })) { c.status = 'pass'; touched = true; }
      }
      if (!touched) continue;
      await this.db.update(changeRecords).set({ verify: JSON.stringify(verify) }).where(eq(changeRecords.id, rec.id));
      if (verify.checks.every((c) => c.status === 'pass')) done.push(await this.transition({ ...rec, verify: JSON.stringify(verify) }, 'verified', 'system', `verified by ${ev.type}`, { deadlineAt: null }));
    }
    return done;
  }

  /** A human attests the checks (core.manual, or an unverifiable check). */
  async attest(workspaceId: string, id: string, pass: boolean, note = '', actor = actorId()): Promise<ChangeRow> {
    const rec = await this.get(workspaceId, id);
    if (rec.state !== 'verifying') throw new BadRequestException(`the change is ${rec.state}, not verifying`);
    const verify = parse<{ checks: VerifyCheck[] }>(rec.verify, { checks: [] });
    for (const c of verify.checks) if (c.status !== 'pass') { c.status = pass ? 'pass' : 'fail'; c.detail = `attested by ${actor}${note ? `: ${note}` : ''}`; }
    await this.db.update(changeRecords).set({ verify: JSON.stringify(verify) }).where(eq(changeRecords.id, rec.id));
    const fresh = { ...rec, verify: JSON.stringify(verify) };
    if (pass) return this.transition(fresh, 'verified', actor, `attested${note ? `: ${note}` : ''}`, { deadlineAt: null });
    return this.rollBack(fresh, actor, `a check failed (attested${note ? `: ${note}` : ''})`);
  }

  /** A human attests the apply of a core.manual change. */
  async attestApplied(workspaceId: string, id: string, note = '', actor = actorId()): Promise<ChangeRow> {
    const rec = await this.get(workspaceId, id);
    if (rec.kind !== MANUAL_KIND) throw new BadRequestException('only core.manual changes are applied by attestation; others apply through their operation');
    if (rec.state !== 'approved') throw new BadRequestException(`the change is ${rec.state}, not approved`);
    return this.applied(workspaceId, id, { by: actor, output: { note } });
  }

  /** A human attests a rollback the core could not run itself. */
  async attestRolledBack(workspaceId: string, id: string, ok: boolean, note = '', actor = actorId()): Promise<ChangeRow> {
    const rec = await this.get(workspaceId, id);
    if (rec.state !== 'rolling_back') throw new BadRequestException(`the change is ${rec.state}, not rolling back`);
    return this.finishRollback(rec, ok, actor, note);
  }

  private async rollBack(rec: ChangeRow, by: string, why: string): Promise<ChangeRow> {
    const rolling = await this.transition(rec, 'rolling_back', by, why, { deadlineAt: null });
    const run = this.rollbackRunner ? await this.rollbackRunner(rolling).catch((err: unknown) => ({ ok: false, detail: err instanceof Error ? err.message : String(err) })) : null;
    if (!run) return rolling; // nothing to run: waits for an attested rollback
    return this.finishRollback(rolling, run.ok, 'system', run.detail, (run as { actionId?: string }).actionId);
  }

  private async finishRollback(rec: ChangeRow, ok: boolean, by: string, detail: string, actionId?: string): Promise<ChangeRow> {
    const done = await this.transition(rec, ok ? 'rolled_back' : 'failed', by, ok ? `rolled back${detail ? `: ${detail}` : ''}` : `rollback failed: ${detail}`, { rollbackActionId: actionId ?? null });
    // The trust ledger learns of it: a revert of the proposer's applied change.
    const agent = rec.proposer.startsWith('agent:') ? rec.proposer.slice(6) : null;
    if (agent && this.actions && rec.applyActionId) {
      const row = await this.actions.get(rec.workspaceId, rec.applyActionId).catch(() => null);
      if (row && isActionClass(row.class)) {
        const opened = await this.actions.hooks.revertIncident?.(row, `change ${rec.id.slice(0, 8)} (${rec.kind}) ${ok ? 'rolled back' : 'failed to roll back'}`).catch(() => false);
        if (!opened) await this.actions.trust.record(rec.workspaceId, agent, row.class, ok ? 'reverted' : 'incident', { refType: 'change', refId: rec.id }).catch(() => undefined);
      }
    }
    return done;
  }

  /** Deadlines: gates that got no answer, verify windows that lapsed. Restart-safe. */
  async sweep(now = new Date()): Promise<{ rejected: number; rolledBack: number }> {
    const due = await this.db.select().from(changeRecords).where(and(isNotNull(changeRecords.deadlineAt), lte(changeRecords.deadlineAt, now.toISOString()), inArray(changeRecords.state, ['gated', 'verifying'])));
    let rejected = 0, rolledBack = 0;
    for (const rec of due) {
      if (rec.state === 'gated') {
        const keys = parse<Keys>(rec.keys, {});
        keys.outcome = 'unavailable';
        await this.audit.append(rec.workspaceId, { actor: 'system', action: 'approval_decided', refType: 'change', refId: rec.id, payload: { requestId: keys.requestId, outcome: 'unavailable', why: 'no key before the deadline' } });
        await this.transition(rec, 'rejected', 'system', 'no key before the gate deadline (unavailable means no)', { keys: JSON.stringify(keys), deadlineAt: null });
        rejected += 1;
        continue;
      }
      const verify = parse<{ checks: VerifyCheck[] }>(rec.verify, { checks: [] });
      const open = verify.checks.filter((c) => c.status !== 'pass');
      if (open.length > 0 && open.every((c) => c.status === 'unverifiable')) continue; // waits for an attested check
      for (const c of open) if (c.status === 'pending') { c.status = 'fail'; c.detail = 'the verify window lapsed'; }
      await this.rollBack({ ...rec, verify: JSON.stringify(verify) }, 'system', 'a verify check lapsed');
      await this.db.update(changeRecords).set({ verify: JSON.stringify(verify) }).where(eq(changeRecords.id, rec.id));
      rolledBack += 1;
    }
    return { rejected, rolledBack };
  }
}

/** Whether every field of `want` present in `pinned` matches it. */
export function bindMatches(pinned: Record<string, unknown>, want: Record<string, unknown>): boolean {
  const keys = Object.keys(want).filter((k) => k in pinned);
  return keys.length > 0 && keys.every((k) => JSON.stringify(pinned[k]) === JSON.stringify(want[k]));
}
