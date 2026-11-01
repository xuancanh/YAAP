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
import { Injectable, ConflictException, Logger, NotFoundException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatsRepository } from './chats.repository';
import { ChatLocks } from './chat-locks';
import { TurnContextService } from './turn-context.service';
import { streamSignal } from '../ai/provider-timeout';
import { contextWindowFor } from '../ai/context-windows';
import { SettingsService } from '../settings/settings.module';

const SUMMARY_CAP = 8_000;
const MIN_MESSAGES = 4;
/** Default share of the model's context window at which auto-compaction fires. */
export const DEFAULT_COMPACT_PCT = 70;
/** Auto-compaction fires at this share of a chat's token ceiling at the latest. */
export const CEILING_SHARE = 0.8;
const PCT_MIN = 30;
const PCT_MAX = 95;

/** The auto-compaction policy, from app settings with bounds:
 *  `autoCompact` on|off (default on), `compactionThresholdPct` (30–95, default
 *  70, of the model's context window), `compactionThresholdTokens` (an
 *  absolute override; 0 or unset = use the percentage; never above 95% of
 *  the window, so a big override cannot defeat the point). */
export function compactionThreshold(settings: Record<string, string>, model: string, envTokens?: number): { enabled: boolean; tokens: number; window: number; pct: number } {
  const window = contextWindowFor(model);
  const enabled = (settings.autoCompact ?? 'on') !== 'off';
  const pctRaw = parseInt(settings.compactionThresholdPct ?? '', 10);
  const pct = Number.isFinite(pctRaw) ? Math.min(PCT_MAX, Math.max(PCT_MIN, pctRaw)) : DEFAULT_COMPACT_PCT;
  const ceiling = Math.floor(window * PCT_MAX / 100);
  const abs = parseInt(settings.compactionThresholdTokens ?? '', 10);
  const tokens = Number.isFinite(abs) && abs > 0
    ? Math.min(abs, ceiling)
    : envTokens && !('compactionThresholdPct' in settings) && envTokens < Math.floor(window * pct / 100) ? envTokens : Math.floor(window * pct / 100);
  return { enabled, tokens, window, pct };
}

const COMPACT_SYSTEM = `You compact conversations. Write a dense, structured summary of the conversation so far that a colleague could continue from. Use these sections: Goal, Key facts & decisions, Work completed, Open threads. Be specific; keep names, paths, and numbers. Output only the summary.`;

@Injectable()
export class CompactionService {
  private readonly logger = new Logger(CompactionService.name);

  constructor(
    private readonly repo: ChatsRepository,
    private readonly locks: ChatLocks,
    private readonly context: TurnContextService,
    private readonly config: ConfigService,
    /** Optional so test constructors keep working; without it the env
     *  threshold and the model window decide. */
    @Optional() private readonly settings?: SettingsService,
  ) {}

  /** Whether auto-compaction is on (Settings → Context & budget). */
  async enabled(): Promise<boolean> {
    const settings = this.settings ? await this.settings.all().catch((): Record<string, string> => ({})) : {};
    return (settings.autoCompact ?? 'on') !== 'off';
  }

  /** Per-round overhead (system prompt + tool specs) last measured for a
   *  session, so the pre-turn check can use it too. */
  private readonly overhead = new Map<string, number>();

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
      // the token ceiling counts from here: compaction gives the chat a fresh budget
      const now = await this.repo.getSession(sessionId);
      // the next call carries the summary instead of the old history; the
      // measured context restarts from the summary's size (refined by the next call)
      await this.repo.updateSession(sessionId, { compactSummary: summary, compactCutoff: String(maxSeq), ...(now && now.ceilingKind === 'spend' ? {} : { tokensAtCompact: now ? now.tokensIn + now.tokensOut : 0 }), contextTokens: Math.ceil(summary.length / 4) });
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
  async maybeAutoCompact(sessionId: string, overheadChars?: number, opts: { force?: boolean } = {}): Promise<boolean> {
    try {
      const session = await this.repo.getSession(sessionId);
      if (!session) return false;
      if (overheadChars !== undefined) this.overhead.set(sessionId, overheadChars);
      const over = overheadChars ?? this.overhead.get(sessionId) ?? 0;
      const settings = this.settings ? await this.settings.all().catch((): Record<string, string> => ({})) : {};
      const ctxModel = session.model || (await this.context.build(session).then((c) => c.model).catch(() => ''));
      const policy = compactionThreshold(settings, ctxModel, this.config.get<number>('compactionThresholdTokens'));
      if (!policy.enabled) return false;
      // Compact before the chat's own ceiling, never at it: the ceiling is a
      // limit on the context, and auto-compaction is what keeps it under.
      const threshold = session.tokenCeiling > 0 && session.ceilingKind !== 'spend' ? Math.min(policy.tokens, Math.floor(session.tokenCeiling * CEILING_SHARE)) : policy.tokens;
      const cutoff = session.compactCutoff === null ? null : Number(session.compactCutoff);
      const history = await this.repo.providerHistory(sessionId, Number.isNaN(cutoff as number) ? null : cutoff);
      const chars = history.reduce((n, m) => n + m.content.length, 0) + session.compactSummary.length + over;
      // the provider-measured size of the last call wins over the chars/4 estimate when larger
      const estimate = Math.max(chars / 4, session.contextTokens ?? 0);
      if (!opts.force && estimate < threshold) return false;
      const r = await this.compact(sessionId);
      return r.ok;
    } catch (err) {
      // A turn (or a racing auto-compact) holding the busy lock is normal:
      // the next check retries. Anything else is worth a warning.
      if (err instanceof ConflictException) return false;
      this.logger.warn(`auto-compaction skipped for ${sessionId}: ${err instanceof Error ? err.message : err}`);
      return false;
    }
  }
}
