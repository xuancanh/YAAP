/**
 * CompactionService — replaces older private provider history with an
 * LLM-written structured summary (FR-7.3).
 *
 * Triggered by /compact or automatically after a turn when the estimated
 * provider input passes the configured threshold. Shares the per-chat busy
 * lock with the turn loop (FR-7.5). The visible transcript is untouched: only
 * compactSummary + compactCutoff change, and history rebuilds from the
 * summary plus messages newer than the cutoff (FR-7.4). The summary is
 * size-bounded (NFR-4).
 */
import { Injectable, ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatsRepository } from './chats.repository';
import { ChatLocks } from './chat-locks';
import { TurnContextService } from './turn-context.service';
import { streamSignal } from '../ai/provider-timeout';

const SUMMARY_CAP = 8_000;
const MIN_MESSAGES = 4;

const COMPACT_SYSTEM = `You compact conversations. Write a dense, structured summary of the conversation so far that a colleague could continue from. Use these sections: Goal, Key facts & decisions, Work completed, Open threads. Be specific; keep names, paths, and numbers. Output only the summary.`;

@Injectable()
export class CompactionService {
  private readonly logger = new Logger(CompactionService.name);

  constructor(
    private readonly repo: ChatsRepository,
    private readonly locks: ChatLocks,
    private readonly context: TurnContextService,
    private readonly config: ConfigService,
  ) {}

  /** /compact — explicit user-triggered compaction. */
  async compact(sessionId: string): Promise<{ ok: boolean; reason?: string; summaryLength?: number }> {
    const session = await this.repo.getSession(sessionId);
    if (!session) throw new NotFoundException(`chat ${sessionId}`);
    if (!this.locks.tryAcquire(sessionId)) throw new ConflictException('chat is busy');
    try {
      const cutoff = session.compactCutoff === null ? null : Number(session.compactCutoff);
      const history = await this.repo.providerHistory(sessionId, Number.isNaN(cutoff as number) ? null : cutoff);
      if (history.length < MIN_MESSAGES) return { ok: false, reason: 'conversation too short to compact' };

      const ctx = await this.context.build(session);
      const transcript = history.map((m) => `${m.role}: ${m.content}`).join('\n\n');
      const prior = session.compactSummary ? `Earlier summary (fold into the new one):\n${session.compactSummary}\n\n` : '';

      let summary = '';
      for await (const ev of ctx.provider.stream({
        model: ctx.model,
        system: COMPACT_SYSTEM,
        messages: [{ role: 'user', content: `${prior}Conversation:\n\n${transcript}` }],
        apiKey: ctx.apiKey,
        baseUrl: ctx.baseUrl,
        signal: streamSignal(),
      })) {
        if (ev.type === 'answer') summary += ev.text;
      }
      summary = summary.trim().slice(0, SUMMARY_CAP);
      if (!summary) return { ok: false, reason: 'empty summary' };

      const all = await this.repo.listMessages(sessionId);
      const maxSeq = all.at(-1)?.seq ?? 0;
      await this.repo.updateSession(sessionId, { compactSummary: summary, compactCutoff: String(maxSeq) });
      return { ok: true, summaryLength: summary.length };
    } finally {
      this.locks.release(sessionId);
    }
  }

  /** Fire-and-forget threshold check, called after a turn completes. Uses a
   *  chars/4 token estimate — no extra LLM call just to measure.
   *
   *  `overheadChars` is the per-round overhead the turn loop measured and
   *  every provider call also carries: the resolved system prompt plus the
   *  full tool-spec JSON (tens of KB once MCP servers are enabled). History
   *  alone underestimates the real provider input, so without it a long turn
   *  can hit the provider's context limit before auto-compact fires.
   *
   *  Post-turn, deliberately: compaction shares the per-chat busy lock with
   *  the turn loop (FR-7.5), so it cannot interleave with an in-flight turn.
   *  The pessimistic estimate makes the check fire early enough that the
   *  NEXT turn starts compacted. */
  async maybeAutoCompact(sessionId: string, overheadChars = 0): Promise<void> {
    try {
      const session = await this.repo.getSession(sessionId);
      if (!session) return;
      const threshold = this.config.get<number>('compactionThresholdTokens') ?? 120_000;
      const cutoff = session.compactCutoff === null ? null : Number(session.compactCutoff);
      const history = await this.repo.providerHistory(sessionId, Number.isNaN(cutoff as number) ? null : cutoff);
      const chars = history.reduce((n, m) => n + m.content.length, 0) + session.compactSummary.length + overheadChars;
      if (chars / 4 < threshold) return;
      await this.compact(sessionId);
    } catch (err) {
      // A turn (or a racing auto-compact) holding the busy lock is normal:
      // the next post-turn check retries. Anything else is worth a warning.
      if (err instanceof ConflictException) return;
      this.logger.warn(`auto-compaction skipped for ${sessionId}: ${err instanceof Error ? err.message : err}`);
    }
  }
}
