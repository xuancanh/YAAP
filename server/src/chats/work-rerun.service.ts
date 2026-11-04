/**
 * WorkRerunService — the Work log's **Rerun** (docs/work-log.md
 * "Intervening"): a run that failed or was stopped for a reason fixed since
 * (a provider 400, an outage, a budget or tool-round limit raised) runs
 * again, in the same work session, by the same trigger:
 *
 *  - the heartbeat beats now (the gate of "Beat now": quiet hours, the spend
 *    stop and the daily cap still apply);
 *  - a loop fires now (`LoopsService.runLoop`, the loop's own model and budget);
 *  - an org task run is re-dispatched through the org runtime (a registered
 *    handler: claim, budget reservation, the task's own prompt) — never a
 *    replay of the old prompt;
 *  - anything else (a meeting round, a channel wake, an org session, a
 *    mini-app ask, a person's message) re-sends the run's own input in that
 *    session with the same origin, so the same policy and approvals apply.
 *
 * The new turn carries `rerunOf` (TurnLoopService.markNextTurn). One rerun
 * at a time per session; a session mid-turn is refused. Access: the run must
 * be one the caller can see (WorkLogService.run) in a session they may open
 * (ChatsService.get); viewers never reach a POST.
 */
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AgentsService } from '../agents/agents.service';
import { ChatsRepository, type ChatSession } from './chats.repository';
import { ChatsService } from './chats.service';
import { HeartbeatService } from './heartbeat.service';
import { LoopsService } from './loops.service';
import type { LoopDef } from './loop-def';
import { TurnLoopService, type TurnOrigin, type TurnSource } from './turn-loop.service';
import { WorkLogService, type WorkOutcome, type WorkRunDetail, type WorkTrigger } from './work-log.service';

/** The outcomes a run can be rerun from. */
export const RERUNNABLE: readonly WorkOutcome[] = ['error', 'stopped', 'blocked', 'interrupted'];
/** How long the request waits for the new turn to start before answering. */
const START_WAIT_MS = 8_000;

export interface RerunContext { agentId: string; run: WorkRunDetail; session: ChatSession }
/** A trigger's own way to run again; null = not mine, use the default. */
export type RerunHandler = (ctx: RerunContext) => Promise<string | null>;

export interface RerunResult {
  /** A new turn started (or is starting) for the rerun. */
  started: boolean;
  /** The new run, when it started within the wait. */
  turnId: string | null;
  sessionId: string;
  /** The dispatch's own word: 'ran', 'pending', a skip reason ('cap', 'quiet', 'skipped:closed', …). */
  status: string;
  error?: string;
}

@Injectable()
export class WorkRerunService {
  private readonly logger = new Logger(WorkRerunService.name);
  private readonly handlers = new Map<WorkTrigger, RerunHandler>();
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly log: WorkLogService,
    private readonly chats: ChatsService,
    private readonly repo: ChatsRepository,
    private readonly turns: TurnLoopService,
    private readonly heartbeat: HeartbeatService,
    private readonly loops: LoopsService,
    private readonly agents: AgentsService,
  ) {}

  /** Another module's way to rerun a trigger (the org runtime: task runs). */
  register(trigger: WorkTrigger, handler: RerunHandler): void {
    this.handlers.set(trigger, handler);
  }

  /** Whether a rerun of this session is starting or running now. */
  isRerunning(sessionId: string): boolean { return this.inFlight.has(sessionId); }

  async rerun(agentId: string, turnId: string): Promise<RerunResult> {
    const run = await this.log.run(agentId, turnId); // 404 for a run the caller cannot see
    if (!RERUNNABLE.includes(run.outcome)) throw new BadRequestException(`only a failed, stopped or interrupted run can be rerun (this one is ${run.outcome})`);
    const session = await this.chats.get(run.sessionId); // 404 for a session the caller may not open
    if (this.inFlight.has(session.id)) throw new ConflictException('a rerun of this session is already running');
    if (this.turns.isBusy(session.id)) throw new ConflictException('this session is running a turn now: stop it or wait for it to end');
    this.inFlight.add(session.id);

    let onTurn: (id: string) => void = () => {};
    const started = new Promise<string>((resolve) => { onTurn = resolve; });
    const unmark = this.turns.markNextTurn(session.id, { rerunOf: run.id, onTurn: (id) => onTurn(id) });
    const ctx: RerunContext = { agentId, run, session };
    const op: Promise<{ status: string; error?: string }> = this.dispatch(ctx)
      .then((status) => ({ status }))
      .catch((err: unknown) => {
        const error = err instanceof Error ? err.message : String(err);
        this.logger.warn(`rerun of ${run.id} failed: ${error}`);
        return { status: 'error', error };
      });
    void op.finally(() => { unmark(); this.inFlight.delete(session.id); });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const first = await Promise.race([
      started.then((id) => ({ kind: 'turn' as const, id })),
      op.then((r) => ({ kind: 'done' as const, ...r })),
      new Promise<{ kind: 'wait' }>((resolve) => { timer = setTimeout(() => resolve({ kind: 'wait' }), START_WAIT_MS); }),
    ]);
    clearTimeout(timer);
    if (first.kind === 'turn') return { started: true, turnId: first.id, sessionId: session.id, status: 'running' };
    if (first.kind === 'wait') return { started: true, turnId: null, sessionId: session.id, status: 'pending' };
    // The dispatch settled before a marked turn began: it was refused (a
    // gate, a closed task), it failed, or it ran in a session of its own.
    const ran = first.status === 'ran' || first.status === 'done';
    return { started: ran, turnId: null, sessionId: session.id, status: first.status, ...(first.error ? { error: first.error } : {}) };
  }

  /** Run the trigger again; resolves with its status when the run is over. */
  private async dispatch(ctx: RerunContext): Promise<string> {
    const { agentId, run, session } = ctx;
    const own = this.handlers.get(run.trigger);
    if (own) {
      const status = await own(ctx);
      if (status !== null) return status;
    }
    if (run.trigger === 'heartbeat') {
      const r = await this.heartbeat.beat(agentId, new Date(), { force: true });
      return r.status;
    }
    if (run.trigger === 'loop') {
      const agent = await this.agents.get(agentId);
      const loop = parseLoops((agent as { loops?: string }).loops).find((l) => l.name === run.triggerKey);
      if (!loop) throw new NotFoundException(`loop "${run.triggerKey}" no longer exists`);
      return this.loops.runLoop(agentId, agent.name, loop);
    }
    return this.resend(session, run);
  }

  /** The run's own input again, in its session, with the same origin. */
  private async resend(session: ChatSession, run: WorkRunDetail): Promise<string> {
    const turn = await this.repo.getTurn(run.id);
    if (!turn) throw new NotFoundException(`run ${run.id}`);
    const source = (turn as { source?: string }).source || legacySource(run.trigger);
    const origin: TurnOrigin = source === 'loop' ? 'loop' : source === 'channel' ? 'channel' : 'user';
    let attachments: unknown[] = [];
    try { const a = JSON.parse(turn.attachments || '[]') as unknown; if (Array.isArray(a)) attachments = a; } catch { /* none */ }
    let error = '';
    for await (const ev of this.turns.run(session.id, {
      text: turn.input, attachments, origin, confined: source === 'app', source: source as TurnSource,
    })) {
      if (ev.type === 'error') error = ev.message;
    }
    if (error) throw new Error(error);
    return 'ran';
  }
}

/** The origin a turn from before migration 0081 most likely had. */
function legacySource(trigger: WorkTrigger): TurnSource {
  if (trigger === 'channel') return 'user';
  if (trigger === 'app') return 'app';
  if (trigger === 'other') return 'user';
  return 'loop';
}

function parseLoops(raw: string | null | undefined): LoopDef[] {
  try {
    const v = JSON.parse(raw || '[]') as unknown;
    return Array.isArray(v) ? (v as LoopDef[]).filter((l) => l && typeof l.name === 'string') : [];
  } catch { return []; }
}
