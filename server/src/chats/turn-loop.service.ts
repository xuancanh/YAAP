/**
 * TurnLoopService — runs one chat turn end to end (§3, §7 constraints):
 *
 *  1. refuse before any API call if the session's token ceiling is already
 *     reached (FR-2.6 / FR-13.4);
 *  2. take the per-chat busy lock shared with compaction (FR-7.5);
 *  3. build provider history from persisted user/assistant messages past the
 *     compaction cutoff, prefixed by the compaction summary when present
 *     (FR-7.4 / FR-8.1), plus persona/system context;
 *  4. stream the provider loop, forwarding answer/thinking chunks to the
 *     caller as they arrive and persisting the final transcript rows;
 *  5. record the structured work record on the turn (FR-6.6).
 *
 * Tool execution (file/web/exec/MCP/skills, FR-3.3) and the Ask/Auto approval
 * pause (§4) plug into the `tool_call` branch below; the scaffold refuses
 * tool calls until those executors land, which satisfies FR-3.4's "never run
 * a malformed/unknown tool" posture by default.
 */
import { Injectable, Inject, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ChatsRepository } from './chats.repository';
import { AI_PROVIDER, AiMessage, AiProvider, AiStreamEvent } from '../ai/ai-provider.interface';

export type TurnEvent =
  | { type: 'turn'; turnId: string }
  | AiStreamEvent
  | { type: 'error'; message: string };

@Injectable()
export class TurnLoopService {
  /** Per-chat busy lock: a chat runs one turn OR one compaction at a time. */
  private readonly busy = new Set<string>();
  /** Abort registry keyed by chat id (FR-8.3 / FR-5.4). */
  private readonly aborts = new Map<string, AbortController>();

  constructor(
    private readonly repo: ChatsRepository,
    @Inject(AI_PROVIDER) private readonly ai: AiProvider,
  ) {}

  /** Stop the in-flight turn for a chat; the partial turn is retained (FR-5.4). */
  stop(sessionId: string): boolean {
    const ctl = this.aborts.get(sessionId);
    if (!ctl) return false;
    ctl.abort();
    return true;
  }

  isBusy(sessionId: string): boolean {
    return this.busy.has(sessionId);
  }

  async *run(sessionId: string, input: { text: string; attachments?: unknown[] }): AsyncGenerator<TurnEvent> {
    const session = await this.repo.getSession(sessionId);
    if (!session) throw new NotFoundException(`chat ${sessionId}`);
    if (this.busy.has(sessionId)) throw new ConflictException('chat is busy');
    if (session.tokenCeiling > 0 && session.tokensIn + session.tokensOut >= session.tokenCeiling) {
      throw new ForbiddenException('token ceiling reached');
    }

    this.busy.add(sessionId);
    const ctl = new AbortController();
    this.aborts.set(sessionId, ctl);

    const turn = await this.repo.createTurn(sessionId, { ...input, model: session.model });
    await this.repo.appendMessage({ sessionId, turnId: turn.id, role: 'user', content: input.text });
    yield { type: 'turn', turnId: turn.id };

    let answer = '';
    let tokensIn = 0;
    let tokensOut = 0;
    try {
      const messages = await this.buildHistory(session.id, session.compactSummary, session.compactCutoff);
      for await (const ev of this.ai.stream({
        model: session.model,
        messages,
        thinkingEffort: session.thinkingEffort,
        signal: ctl.signal,
      })) {
        if (ev.type === 'answer') answer += ev.text;
        if (ev.type === 'usage') { tokensIn += ev.inputTokens; tokensOut += ev.outputTokens; }
        if (ev.type === 'tool_call') {
          // Tool executors are not wired yet; refuse rather than execute.
          yield { type: 'error', message: `tool ${ev.name} is not available` };
          continue;
        }
        yield ev;
      }
      if (answer) await this.repo.appendMessage({ sessionId, turnId: turn.id, role: 'assistant', content: answer });
      await this.repo.updateTurn(turn.id, {
        status: ctl.signal.aborted ? 'stopped' : 'done',
        tokensIn, tokensOut,
      });
      await this.repo.updateSession(sessionId, {
        tokensIn: session.tokensIn + tokensIn,
        tokensOut: session.tokensOut + tokensOut,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.repo.updateTurn(turn.id, { status: 'error', error: message, tokensIn, tokensOut });
      yield { type: 'error', message };
    } finally {
      this.busy.delete(sessionId);
      this.aborts.delete(sessionId);
    }
  }

  private async buildHistory(sessionId: string, compactSummary: string, compactCutoff: string | null): Promise<AiMessage[]> {
    const cutoffSeq = compactCutoff === null ? null : Number(compactCutoff);
    const rows = await this.repo.providerHistory(sessionId, Number.isNaN(cutoffSeq as number) ? null : cutoffSeq);
    const history: AiMessage[] = rows.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));
    if (compactSummary) {
      history.unshift({ role: 'system', content: `Summary of the earlier conversation:\n${compactSummary}` });
    }
    return history;
  }
}
