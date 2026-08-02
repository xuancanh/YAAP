/**
 * LoopsService — scheduled agent prompts (FR-11.6). Once a minute, every
 * agent's loops are checked against their cron; a firing loop runs a real
 * turn (spending tokens, as the requirement says) inside a dedicated
 * per-loop chat session in the default workspace, and the run is journaled
 * to the agent's file brain (FR-11.4's auto-append).
 *
 * Disabled when LOOPS_ENABLED=false (and never started in tests, which
 * construct services directly).
 *
 * Cron expressions are matched in SERVER-LOCAL time (see cron.util.ts):
 * a loop fires by the host's wall clock, including across DST changes.
 * Keep the host in the timezone you want loops to follow (TZ env var).
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AgentsService } from '../agents/agents.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { ChatsRepository } from './chats.repository';
import { TurnLoopService } from './turn-loop.service';
import { DistillService } from './distill.service';
import { cronMatches } from './cron.util';

interface LoopDef { name: string; cron: string; prompt?: string; enabled?: boolean; model?: string; budgetTokens?: number }

@Injectable()
export class LoopsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LoopsService.name);
  private timer?: ReturnType<typeof setInterval>;
  /** agentId:loopName → last fired minute stamp, so a loop fires once/minute. */
  private readonly lastRun = new Map<string, string>();

  constructor(
    private readonly agents: AgentsService,
    private readonly workspaces: WorkspacesService,
    private readonly repo: ChatsRepository,
    private readonly turns: TurnLoopService,
    private readonly distill: DistillService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    if (this.config.get<boolean>('loopsEnabled') === false) return;
    this.timer = setInterval(() => { void this.tick(new Date()); }, 60_000);
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  /** The interval fire-and-forgets tick, so a rejection here (e.g. the DB
   *  dropping under agents.list()) must be caught — an unhandled rejection
   *  terminates Node ≥15. Per-loop failures are already isolated below. */
  async tick(now: Date): Promise<void> {
    try {
      await this.tickInner(now);
    } catch (err) {
      this.logger.warn(`tick failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async tickInner(now: Date): Promise<void> {
    // auto-distillation (roadmap phase 1): every 10 minutes, distill agent
    // sessions that went idle with undistilled work.
    if (now.getMinutes() % 10 === 0) {
      await this.distillSweep(now).catch((err) => {
        this.logger.warn(`distill sweep failed: ${err instanceof Error ? err.message : err}`);
      });
    }
    const stamp = now.toISOString().slice(0, 16); // minute resolution
    const live = new Set<string>(); // agentId:loopName keys that still exist
    for (const agent of await this.agents.list()) {
      let loops: LoopDef[];
      try { loops = JSON.parse(agent.loops) as LoopDef[]; } catch { continue; }
      for (const loop of loops) {
        if (loop?.enabled === false || !loop?.cron) continue; // paused in the schedule editor, or trigger-less
        const key = `${agent.id}:${loop.name}`;
        live.add(key);
        if (!cronMatches(loop.cron, now)) continue;
        if (this.lastRun.get(key) === stamp) continue;
        this.lastRun.set(key, stamp);
        void this.runLoop(agent.id, agent.name, loop).catch((err) => {
          this.logger.warn(`loop "${loop.name}" for ${agent.name} failed: ${err instanceof Error ? err.message : err}`);
        });
      }
    }
    // Prune stamps of deleted agents/loops so the map cannot grow forever
    // (and a re-added loop is not suppressed by a stale same-minute stamp).
    for (const key of [...this.lastRun.keys()]) {
      if (!live.has(key)) this.lastRun.delete(key);
    }
  }

  /** Distill idle, changed agent sessions into their agents' brains. */
  async distillSweep(now: Date, idleMinutes = 60): Promise<number> {
    const idleBefore = new Date(now.getTime() - idleMinutes * 60_000).toISOString();
    const sessions = await this.repo.sessionsNeedingDistill(idleBefore);
    let distilled = 0;
    for (const s of sessions.slice(0, 5)) { // bounded per sweep
      try {
        const res = await this.distill.distill(s.id);
        if (res.ok) distilled++;
      } catch (err) {
        this.logger.warn(`auto-distill of ${s.id} failed: ${err instanceof Error ? err.message : err}`);
      }
    }
    if (distilled > 0) this.logger.log(`auto-distilled ${distilled} idle session(s)`);
    return distilled;
  }

  /** Run one loop turn in the agent's dedicated loop session. Per-loop model
   *  override and token budget (roadmap phase 2) apply to that session: a
   *  cheap model can heartbeat for pennies, and a budget-hit surfaces in the
   *  agent's activity feed instead of burning tokens silently. */
  async runLoop(agentId: string, agentName: string, loop: LoopDef): Promise<void> {
    const ws = (await this.workspaces.list())[0];
    if (!ws) return;
    const name = `Loop · ${loop.name}`;
    const existing = (await this.repo.listSessions(ws.id)).find((s) => s.agentId === agentId && s.name === name);
    const session = existing ?? await this.repo.createSession({ workspaceId: ws.id, agentId, name, permissionMode: 'auto' });
    const wanted: Record<string, unknown> = {};
    if ((loop.model ?? '') !== session.model) wanted.model = loop.model ?? '';
    if (loop.budgetTokens && loop.budgetTokens !== session.tokenCeiling) wanted.tokenCeiling = loop.budgetTokens;
    if (Object.keys(wanted).length > 0) await this.repo.updateSession(session.id, wanted);

    // The loop chat still busy (a previous run overrunning its period, or a
    // user turn in it) is not a failure: skip silently. Journaling a
    // loop_error every period would bury real failures in noise.
    if (this.turns.isBusy(session.id)) return;

    const prompt = loop.prompt
      ?? `Scheduled loop firing: "${loop.name}". Check your kanban board and your charter, complete this loop's work now using your tools, and keep your dashboard current. Be concise; if there is nothing to do, say so in one line.`;

    let answer = '';
    try {
      for await (const ev of this.turns.run(session.id, { text: prompt, origin: 'loop' })) {
        if (ev.type === 'answer') answer += ev.text;
        if (ev.type === 'error') throw new Error(ev.message);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.agents.addEvent(agentId, {
        kind: 'loop_error',
        title: `Loop "${loop.name}" failed`,
        body: /token ceiling/.test(message)
          ? `Budget reached (${loop.budgetTokens ?? session.tokenCeiling} tokens). Raise the loop budget or clear its conversation.`
          : message,
        sessionId: session.id,
      }).catch(() => {});
      throw err;
    }
    await this.agents.addEvent(agentId, {
      kind: 'loop_run',
      title: `Loop "${loop.name}" ran`,
      body: answer.replace(/\s+/g, ' ').slice(0, 300),
      sessionId: session.id,
    }).catch(() => {});
    await this.agents.appendJournal(agentId,
      `${new Date().toISOString().slice(0, 10)}  Loop "${loop.name}" ran. ${answer.replace(/\s+/g, ' ').slice(0, 200)}`);
    this.logger.log(`loop "${loop.name}" ran for ${agentName}`);
  }
}
