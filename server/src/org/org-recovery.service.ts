/**
 * OrgRecovery — the company's part of the restart recovery
 * (chats/restart-recovery.service.ts, docs/architecture.md "Restarts and
 * recovery"). On boot, per account:
 *
 *  - release: every org run still `running` belonged to the dead process —
 *    it ends `interrupted` (so the one-run-per-task guard no longer skips
 *    the task as busy); every task claim is released (no run is alive to
 *    hold one: a task in progress stays in progress, a claimed one goes back
 *    to todo); every budget reservation is released (reservations are held
 *    only for runs in flight — a leaked one blocked spend headroom until the
 *    month turned); meetings stuck in progress are closed with a note;
 *  - hold: a task run stopped mid-action with an outcome nobody knows is not
 *    replayed — the task is blocked on the CEO to check it;
 *  - resumeRest: a run that died before its turn began (so no interrupted
 *    turn re-runs it) is re-queued for its assignee — once: the run is
 *    marked `resumed` and only `running`/pending runs are ever taken.
 *
 * Interrupted runs never count as failures: no breaker, no no-progress
 * count, no circular signature, no run_failed (OrgRuntimeService.runTask).
 */
import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { currentAccountId } from '../accounts/account-context';
import { RestartRecoveryService, type InterruptedTurn } from '../chats/restart-recovery.service';
import { OrgTasksService, type TaskStatus } from './org-tasks.service';
import { OrgRuntimeService } from './org-runtime.service';
import { OrgAuditService } from './org-audit.service';
import { OrgMeetingRuntime } from './org-meeting-runtime.service';

type Row = Record<string, unknown>;
const rowsOf = (res: unknown): Row[] => ((res as { rows?: Row[] }).rows ?? (Array.isArray(res) ? (res as Row[]) : []));
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

interface DeadRun { id: string; orgId: string; taskId: string; agentId: string; sessionId: string | null; startedAt: string }

@Injectable()
export class OrgRecoveryService implements OnModuleInit {
  private readonly logger = new Logger(OrgRecoveryService.name);
  /** accountId → the runs this boot found dead, until resumeRest. */
  private readonly dead = new Map<string, DeadRun[]>();
  /** Sessions whose task was held (blocked on the CEO) this boot. */
  private readonly heldSessions = new Set<string>();

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly recovery: RestartRecoveryService,
    private readonly tasks: OrgTasksService,
    private readonly runtime: OrgRuntimeService,
    private readonly audit: OrgAuditService,
    private readonly config: ConfigService,
    @Optional() private readonly meetings?: OrgMeetingRuntime,
  ) {}

  onModuleInit(): void {
    if (this.config.get<boolean>('companiesEnabled') === false) return;
    this.recovery.addParticipant({
      name: 'org',
      release: (now) => this.release(now),
      hold: (turn) => this.hold(turn),
      resumeRest: (_now, handled, seen) => this.resumeRest(handled, seen),
    });
  }

  async release(now: Date): Promise<{ runs: number; claims: number; reservedUsd: number; meetings: number }> {
    const account = currentAccountId();
    const at = now.toISOString();
    // Runs: `running` ones died with the process; `interrupted` ones whose
    // outcome is still `interrupted` were drained at shutdown and not yet
    // recovered (`recovering`: a boot that died before resuming them). All
    // become `recovering` here until resumeRest settles them.
    const runs = rowsOf(await this.db.execute(sql`
      UPDATE org_runs SET "status" = 'interrupted', "outcome" = 'recovering', "endedAt" = COALESCE("endedAt", ${at})
      WHERE "accountId" = ${account} AND ("status" = 'running' OR ("status" = 'interrupted' AND "outcome" IN ('interrupted', 'recovering')))
      RETURNING "id", "orgId", "taskId", "agentId", "sessionId", "startedAt"
    `)).map((r): DeadRun => ({ id: str(r.id), orgId: str(r.orgId), taskId: str(r.taskId), agentId: str(r.agentId), sessionId: str(r.sessionId) || null, startedAt: str(r.startedAt) }));
    this.dead.set(account, runs);
    for (const r of runs) {
      await this.audit.append(r.orgId, { actor: 'system', action: 'run_interrupted', refType: 'run', refId: r.id, payload: { taskId: r.taskId, agentId: r.agentId } }).catch(() => undefined);
    }

    // Claims: no run is alive, so none may hold a task.
    const claimed = rowsOf(await this.db.execute(sql`
      SELECT "id", "orgId", "status", "claimedBy" FROM org_tasks WHERE "accountId" = ${account} AND "claimedBy" IS NOT NULL
    `));
    for (const t of claimed) {
      const to = str(t.status) === 'in_progress' ? 'in_progress' : str(t.status) === 'claimed' ? 'todo' : str(t.status);
      await this.tasks.release(str(t.orgId), str(t.id), str(t.claimedBy), to as TaskStatus).catch((err: unknown) => this.logger.warn(`could not release the claim on task ${str(t.id)}: ${err instanceof Error ? err.message : err}`));
    }

    // Reservations: held only for runs in flight; none are.
    const budgets = rowsOf(await this.db.execute(sql`
      SELECT "id", "orgId", "scope", "refId", "reservedUsd" AS "held" FROM org_budgets WHERE "accountId" = ${account} AND "reservedUsd" > 0
    `));
    if (budgets.length > 0) await this.db.execute(sql`UPDATE org_budgets SET "reservedUsd" = 0 WHERE "id" IN (${sql.join(budgets.map((b) => sql`${str(b.id)}`), sql`, `)})`);
    const byOrg = new Map<string, { usd: number; scopes: string[] }>();
    for (const b of budgets) {
      const e = byOrg.get(str(b.orgId)) ?? { usd: 0, scopes: [] };
      e.usd += Number(b.held) || 0;
      e.scopes.push(`${str(b.scope)}${str(b.refId) ? `:${str(b.refId).slice(0, 8)}` : ''}`);
      byOrg.set(str(b.orgId), e);
    }
    let reservedUsd = 0;
    for (const [orgId, e] of byOrg) {
      reservedUsd += e.usd;
      await this.audit.append(orgId, { actor: 'system', action: 'spend_release', refType: 'org', refId: orgId, payload: { usd: Number(e.usd.toFixed(6)), scopes: e.scopes, reason: 'released after a restart: no run holds it' } }).catch(() => undefined);
    }

    // Meetings stuck in progress.
    const stuck = rowsOf(await this.db.execute(sql`SELECT "id", "orgId" FROM org_meetings WHERE "accountId" = ${account} AND "status" = 'running'`));
    for (const m of stuck) {
      if (this.meetings) await this.meetings.closeInterrupted(str(m.orgId), str(m.id)).catch((err: unknown) => this.logger.warn(`could not close meeting ${str(m.id)}: ${err instanceof Error ? err.message : err}`));
      else await this.db.execute(sql`UPDATE org_meetings SET "status" = 'cancelled', "endedAt" = ${at} WHERE "id" = ${str(m.id)}`);
    }
    if (runs.length + claimed.length + budgets.length + stuck.length > 0) {
      this.logger.log(`released after a restart: ${runs.length} run(s), ${claimed.length} claim(s), $${reservedUsd.toFixed(2)} reserved, ${stuck.length} meeting(s)`);
    }
    return { runs: runs.length, claims: claimed.length, reservedUsd, meetings: stuck.length };
  }

  /** Block an org task whose run stopped mid-action on the CEO: check it. */
  async hold(turn: InterruptedTurn): Promise<void> {
    const s = turn.session;
    if (!s || s.taskKind !== 'org' || !s.taskId) return;
    const res = rowsOf(await this.db.execute(sql`SELECT "orgId", "status" FROM org_tasks WHERE "id" = ${s.taskId} AND "accountId" = ${currentAccountId()} LIMIT 1`))[0];
    if (!res || ['done', 'cancelled'].includes(str(res.status))) return;
    const tools = [...new Set(turn.unknown.map((a) => a.tool))].slice(0, 3).join(', ');
    const reason = `Interrupted by a server restart while calling ${tools}: check whether it went through, then unblock the task (or rerun the run from the Work log).`;
    await this.tasks.update(str(res.orgId), s.taskId, { status: 'blocked', blockedOn: { kind: 'ceo', reason } }, 'system');
    this.heldSessions.add(s.id);
  }

  async resumeRest(handled: Set<string>, seen: Set<string>): Promise<number> {
    const account = currentAccountId();
    const runs = this.dead.get(account) ?? [];
    this.dead.delete(account);
    let requeued = 0;
    for (const r of runs) {
      const sid = r.sessionId ?? '';
      let outcome = 'none';
      if (sid && (handled.has(sid) || this.heldSessions.has(sid))) outcome = this.heldSessions.has(sid) ? 'held' : 'resumed';
      else if (!sid || !seen.has(sid)) {
        // No turn of its own to re-run: re-queue the task for its assignee.
        const t = await this.tasks.get(r.orgId, r.taskId).catch(() => null);
        if (t && t.assigneeAgentId === r.agentId && ['todo', 'in_progress'].includes(t.status)) {
          this.runtime.wake({ orgId: r.orgId, taskId: r.taskId, agentId: r.agentId, reason: 'rewake' });
          outcome = 'resumed';
          requeued++;
        }
      }
      await this.db.execute(sql`UPDATE org_runs SET "outcome" = ${outcome} WHERE "id" = ${r.id}`).catch(() => undefined);
      if (outcome === 'resumed') await this.audit.append(r.orgId, { actor: 'system', action: 'run_resumed', refType: 'task', refId: r.taskId, payload: { runId: r.id, agentId: r.agentId, note: 'resumed after a restart' } }).catch(() => undefined);
    }
    for (const sid of [...this.heldSessions]) if (runs.some((r) => r.sessionId === sid)) this.heldSessions.delete(sid);
    return requeued;
  }
}
