/**
 * RestartRecoveryService — what the last process left mid-flight, recovered
 * on boot (docs/architecture.md "Restarts and recovery").
 *
 * A restart drains first (TurnLoopService.drain): the turns still running
 * after the grace period are recorded `interrupted` with recovery `pending`;
 * a crash leaves them `running`, which the boot sweep in the migrator turns
 * into the same thing. Shortly after boot this service, once per account:
 *
 *  1. lets each participant release what dead runs held (the org module:
 *     org runs still `running`, the task claims they hold, the budget
 *     reservations no run holds any more, meetings stuck in progress);
 *  2. claims the pending turns (`recovery` pending → claimed, atomically,
 *     so a turn is recovered at most once per interruption);
 *  3. settles the action-log rows those runs left `started`: an internal
 *     write or a read is `failed` (harmless to repeat), an outward call is
 *     `interrupted` — whether it took effect is unknown, so a later identical
 *     call is told so instead of replaying it (ActionsService.priorOutcome);
 *  4. expires approval requests whose turn died with the process;
 *  5. decides each turn:
 *     - stopped mid-action with an unknown outward outcome (a background
 *       run) → `held`: not replayed; the owner is told and an org task is
 *       blocked on them until they check;
 *     - a heartbeat, a loop or a task run → `resumed`: re-run once by its
 *       trigger through the Work log's Rerun (the new turn's `rerunOf`
 *       points at the interrupted one) — the heartbeat gate, the loop's
 *       budget, the task's claim and reservation all apply again;
 *     - a person's chat → `retry`: the chat shows "Interrupted by a restart"
 *       with a Retry button; nothing re-sends on its own;
 *     - anything else (a channel wake, a meeting round, an org review) →
 *       `none`: its own schedule or the person brings it back;
 *  6. lets participants resume what had no turn (an org run that died
 *     before its turn began is re-queued for its assignee, once);
 * then, across accounts, a heartbeat or loop that fell due while the server
 * was down runs once (catch-up), skipping what step 5 already re-ran.
 *
 * Single-process by design, like the migrator's boot sweep: everything
 * "in flight" at boot belongs to a process that no longer exists.
 */
import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { AccountsService } from '../accounts/accounts.service';
import { currentAccountId, runWithAccount } from '../accounts/account-context';
import { AgentsService } from '../agents/agents.service';
import { EXTERNAL_CLASSES } from '../actions/action-classes';
import { nowIso } from '../common/ids.util';
import { isDraining } from '../common/lifecycle';
import { ChatsRepository, type ChatSession } from './chats.repository';
import { HeartbeatService } from './heartbeat.service';
import { LoopsService } from './loops.service';
import { WorkLogService } from './work-log.service';
import { WorkRerunService } from './work-rerun.service';

/** What the boot did with an interrupted turn (chat_turns.recovery). */
export type RecoveryOutcome = 'resumed' | 'retry' | 'held' | 'none';

/** An outward call that was in flight when the process died. */
export interface UnknownAction { id: string; tool: string; cls: string }

export interface InterruptedTurn {
  id: string;
  sessionId: string;
  createdAt: string;
  source: string;
  session: ChatSession | null;
  /** Outward calls of this run whose outcome nobody knows. */
  unknown: UnknownAction[];
}

/** Another module's part in the recovery (the org module registers one). */
export interface RecoveryParticipant {
  readonly name: string;
  /** Step 1: release what the dead process held. Runs under the account. */
  release?(now: Date): Promise<unknown>;
  /** A background turn stopped mid-action with an unknown outcome: hold its
   *  work (block the org task on the owner). */
  hold?(turn: InterruptedTurn): Promise<void>;
  /** Step 6: resume what had no turn of its own. `handled` holds the
   *  session ids step 5 resumed or held; `seen` every session with an
   *  interrupted turn this boot. */
  resumeRest?(now: Date, handled: Set<string>, seen: Set<string>): Promise<unknown>;
}

export interface RecoveryReport {
  turns: Record<RecoveryOutcome, number>;
  actions: { interrupted: number; failed: number };
  approvalsExpired: number;
  heartbeats: number;
  loops: number;
}

/** What the sweep found, per account, for the resume. */
export interface Swept { report: RecoveryReport; accounts: Map<string, InterruptedTurn[]> }

type Row = Record<string, unknown>;
const rowsOf = (res: unknown): Row[] => ((res as { rows?: Row[] }).rows ?? (Array.isArray(res) ? (res as Row[]) : []));
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

@Injectable()
export class RestartRecoveryService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(RestartRecoveryService.name);
  private readonly participants: RecoveryParticipant[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  /** How long after boot the recovery starts (the app is listening by then). */
  delayMs = 3_000;
  /** The last recovery's report (tests, logs). */
  last: RecoveryReport | null = null;

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly repo: ChatsRepository,
    private readonly agents: AgentsService,
    private readonly log: WorkLogService,
    private readonly reruns: WorkRerunService,
    private readonly heartbeat: HeartbeatService,
    private readonly loops: LoopsService,
    private readonly config: ConfigService,
    @Optional() private readonly accounts?: AccountsService,
  ) {}

  addParticipant(p: RecoveryParticipant): () => void {
    this.participants.push(p);
    return () => { const i = this.participants.indexOf(p); if (i >= 0) this.participants.splice(i, 1); };
  }

  /** The sweep (steps 1–4) runs before the app listens and before any
   *  scheduler ticks, so nothing it releases can belong to a run of this
   *  process; the re-runs (steps 5–6 and the catch-up) start `delayMs` later. */
  async onApplicationBootstrap(): Promise<void> {
    if (process.env.RECOVERY_ON_BOOT === 'false') return;
    const now = new Date();
    const swept = await this.sweep(now).catch((err: unknown) => { this.logger.warn(`restart recovery sweep failed: ${err instanceof Error ? err.message : err}`); return null; });
    if (!swept) return;
    this.timer = setTimeout(() => { void this.resume(swept, now).catch((err: unknown) => this.logger.warn(`restart recovery failed: ${err instanceof Error ? err.message : err}`)); }, this.delayMs);
    this.timer.unref?.();
  }

  onModuleDestroy(): void { clearTimeout(this.timer); }

  /** How far back a missed heartbeat or loop is still caught up (hours). */
  private lookbackMs(): number {
    const h = Number(process.env.RECOVERY_CATCHUP_HOURS);
    return (Number.isFinite(h) && h >= 0 ? Math.min(h, 168) : 24) * 60 * 60_000;
  }

  /** The whole recovery (see the header). Safe to call again: each step only
   *  takes what is still pending. */
  async recover(now: Date = new Date()): Promise<RecoveryReport> {
    return this.resume(await this.sweep(now), now);
  }

  /** Steps 1–4, per account: what each account's resume needs. */
  async sweep(now: Date): Promise<Swept> {
    const report: RecoveryReport = { turns: { resumed: 0, retry: 0, held: 0, none: 0 }, actions: { interrupted: 0, failed: 0 }, approvalsExpired: 0, heartbeats: 0, loops: 0 };
    const accounts = new Map<string, InterruptedTurn[]>();
    const pass = async () => { accounts.set(currentAccountId(), await this.sweepAccount(now, report)); };
    if (!this.accounts) await pass();
    else await this.accounts.forEachAccount(pass);
    return { report, accounts };
  }

  /** Steps 5–6 per account, then the catch-up. */
  async resume(swept: Swept, now: Date): Promise<RecoveryReport> {
    const { report } = swept;
    const beaten = new Set<string>();
    const loopsRun = new Set<string>();
    for (const [account, turns] of swept.accounts) {
      await runWithAccount(account, () => this.resumeAccount(now, turns, report, beaten, loopsRun))
        .catch((err: unknown) => this.logger.warn(`account ${account}: restart recovery failed: ${err instanceof Error ? err.message : err}`));
    }
    if (!isDraining()) {
      report.heartbeats = (await this.heartbeat.catchUp(now, { lookbackMs: this.lookbackMs(), skip: beaten }).catch(() => [])).length;
      report.loops = (await this.loops.catchUp(now, { lookbackMs: this.lookbackMs(), skip: loopsRun }).catch(() => [])).length;
    }
    const t = report.turns;
    if (t.resumed + t.retry + t.held + t.none + report.actions.interrupted + report.approvalsExpired > 0) {
      this.logger.log(`recovered after a restart: ${t.resumed} run(s) resumed, ${t.retry} chat(s) offered a retry, ${t.held} held for a decision, ${t.none} left; ${report.actions.interrupted} outward call(s) of unknown outcome, ${report.approvalsExpired} approval(s) expired`);
    }
    this.last = report;
    return report;
  }

  private async sweepAccount(now: Date, report: RecoveryReport): Promise<InterruptedTurn[]> {
    const account = currentAccountId();
    for (const p of this.participants) {
      await p.release?.(now).catch((err: unknown) => this.logger.warn(`recovery: ${p.name} release failed: ${err instanceof Error ? err.message : err}`));
    }

    // 2. Claim the pending turns, once. A turn still `claimed` was claimed
    // by a process that died before deciding it (a restart within seconds
    // of the last one): nothing re-ran it, so it is taken again.
    const claimed = rowsOf(await this.db.execute(sql`
      UPDATE chat_turns SET "recovery" = 'claimed'
      WHERE "accountId" = ${account} AND "status" = 'interrupted' AND "recovery" IN ('pending', 'claimed')
      RETURNING "id", "sessionId", "createdAt", "source"
    `));

    // 3. The action log: calls left `started` by the dead process.
    const external = EXTERNAL_CLASSES as readonly string[];
    const at = nowIso();
    const actions = rowsOf(await this.db.execute(sql`
      UPDATE action_log SET
        "status" = CASE WHEN "class" IN ('external_reversible', 'external_irreversible', 'money') THEN 'interrupted' ELSE 'failed' END,
        "note" = CASE WHEN "class" IN ('external_reversible', 'external_irreversible', 'money')
          THEN 'In flight when the server restarted: whether it took effect is unknown.'
          ELSE 'Interrupted by a server restart.' END,
        "finishedAt" = ${at}
      WHERE "accountId" = ${account} AND "status" = 'started'
      RETURNING "id", "sessionId", "tool", "class", "createdAt"
    `));
    for (const a of actions) {
      if (external.includes(str(a.class))) report.actions.interrupted++; else report.actions.failed++;
    }

    // 4. Approval requests whose turn died with the process: expired, read.
    const expired = rowsOf(await this.db.execute(sql`
      UPDATE agent_events SET "kind" = 'approval_expired', "readAt" = COALESCE("readAt", ${at})
      WHERE "accountId" = ${account} AND "kind" = 'approval_request'
      RETURNING "id"
    `));
    report.approvalsExpired += expired.length;

    const turns: InterruptedTurn[] = [];
    for (const r of claimed) {
      const sessionId = str(r.sessionId);
      const createdAt = str(r.createdAt);
      turns.push({
        id: str(r.id), sessionId, createdAt, source: str(r.source),
        session: (await this.repo.getSession(sessionId).catch(() => undefined)) ?? null,
        unknown: actions.filter((a) => str(a.sessionId) === sessionId && str(a.createdAt) >= createdAt && external.includes(str(a.class)))
          .map((a) => ({ id: str(a.id), tool: str(a.tool), cls: str(a.class) })),
      });
    }
    return turns;
  }

  private async resumeAccount(now: Date, turns: InterruptedTurn[], report: RecoveryReport, beaten: Set<string>, loopsRun: Set<string>): Promise<void> {
    // 5. Each turn.
    // Only the newest interrupted turn of a session is resumed; older ones (a
    // crash loop) are left.
    const newest = new Map<string, InterruptedTurn>();
    for (const t of turns) { const cur = newest.get(t.sessionId); if (!cur || t.createdAt > cur.createdAt) newest.set(t.sessionId, t); }
    const handled = new Set<string>();
    for (const t of turns) {
      const outcome = newest.get(t.sessionId) === t ? await this.decide(t, beaten, loopsRun).catch((err: unknown) => {
        this.logger.warn(`recovery of turn ${t.id} failed: ${err instanceof Error ? err.message : err}`);
        return 'none' as RecoveryOutcome;
      }) : 'none';
      if (outcome === 'resumed' || outcome === 'held') handled.add(t.sessionId);
      report.turns[outcome]++;
      await this.repo.updateTurn(t.id, { recovery: outcome }).catch(() => undefined);
    }

    // 6. What had no turn of its own.
    const seen = new Set(turns.map((t) => t.sessionId));
    for (const p of this.participants) {
      await p.resumeRest?.(now, handled, seen).catch((err: unknown) => this.logger.warn(`recovery: ${p.name} resume failed: ${err instanceof Error ? err.message : err}`));
    }
  }

  /** One turn's recovery (step 5). */
  private async decide(t: InterruptedTurn, beaten: Set<string>, loopsRun: Set<string>): Promise<RecoveryOutcome> {
    const s = t.session;
    if (!s || s.archivedAt) return 'none';
    // A person's chat: the person decides. A later identical outward call is
    // still told its outcome is unknown (the action row is `interrupted`).
    if (s.kind !== 'work') return 'retry';
    if (!s.agentId) return 'none';
    if (t.unknown.length > 0) {
      await this.holdFor(t, s);
      return 'held';
    }
    if (isDraining() || this.config.get<boolean>('loopsEnabled') === false) return 'none';
    const run = await this.log.run(s.agentId, t.id).catch(() => null);
    if (!run || !['heartbeat', 'loop', 'task'].includes(run.trigger)) return 'none';
    // Marked before it starts: a restart in the middle never re-runs it twice.
    await this.repo.updateTurn(t.id, { recovery: 'resumed' });
    const res = await this.reruns.rerun(s.agentId, t.id);
    if (run.trigger === 'heartbeat') beaten.add(s.agentId);
    if (run.trigger === 'loop') loopsRun.add(`${s.agentId}:${run.triggerKey}`);
    if (!res.started) {
      this.logger.log(`recovery: ${run.label} was not re-run (${res.error || res.status})`);
      return 'none';
    }
    return 'resumed';
  }

  /** Tell the owner, and let participants hold the work (an org task blocks). */
  private async holdFor(t: InterruptedTurn, s: ChatSession): Promise<void> {
    const tools = [...new Set(t.unknown.map((a) => a.tool))];
    const what = tools.slice(0, 3).join(', ');
    await this.agents.addEvent(s.agentId!, {
      kind: 'agent_message',
      title: `Interrupted mid-action by a restart: check whether ${what} went through`,
      body: `The server restarted while this run was calling ${what} (${t.unknown.map((a) => `action ${a.id.slice(0, 8)}`).join(', ')}). Whether ${tools.length === 1 ? 'it' : 'they'} took effect is unknown, so the run was not replayed. Check the result where it would show (the sent folder, the record it writes), then rerun it from the Work log if it did not happen.`,
      sessionId: s.id,
      payload: JSON.stringify({ urgency: 'normal', interrupted: true, turnId: t.id, actionIds: t.unknown.map((a) => a.id) }),
      origin: 'system',
    }).catch(() => undefined);
    for (const p of this.participants) await p.hold?.(t).catch(() => undefined);
  }
}

