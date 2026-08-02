/**
 * DistillService — FR-11.4: distill a chat session's completed work into
 * serialized, size-bounded appends to the owning agent's file brain. The LLM
 * writes one journal entry and, when it learned something durable, one
 * lesson; both appends are capped by AgentsService.
 */
import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { ChatsRepository } from './chats.repository';
import { TurnContextService } from './turn-context.service';
import { AgentsService } from '../agents/agents.service';
import { AgentMemoryService, sourceForSession } from '../agents/agent-memory.service';
import { streamSignal } from '../ai/provider-timeout';

const DISTILL_SYSTEM = `You distill completed work into an agent's file brain. From the conversation, output exactly this format:

JOURNAL: <one dated-style line, max 200 chars, of what was done and the outcome>
LESSON: <one durable, reusable lesson with its cause, max 400 chars — or the word "none" if nothing generalizes>

Output nothing else.`;

@Injectable()
export class DistillService {
  constructor(
    private readonly repo: ChatsRepository,
    private readonly context: TurnContextService,
    private readonly agents: AgentsService,
    private readonly memory: AgentMemoryService,
  ) {}

  async distill(sessionId: string): Promise<{ ok: boolean; journal?: string; lesson?: string; quarantined?: boolean }> {
    const session = await this.repo.getSession(sessionId);
    if (!session) throw new NotFoundException(`chat ${sessionId}`);
    if (!session.agentId) throw new BadRequestException('this chat is not owned by a durable agent');
    const history = await this.repo.providerHistory(sessionId, null);
    // mark up front so the idle sweep never re-scans an unchanged session
    await this.repo.markDistilled(sessionId);
    if (history.length < 2) return { ok: false };

    const ctx = await this.context.build(session);
    const transcript = history.map((m) => `${m.role}: ${m.content}`).join('\n\n').slice(-40_000);
    let out = '';
    for await (const ev of ctx.provider.stream({
      model: ctx.model,
      system: DISTILL_SYSTEM,
      messages: [{ role: 'user', content: `Conversation:\n\n${transcript}` }],
      apiKey: ctx.apiKey,
      baseUrl: ctx.baseUrl,
      signal: streamSignal(),
    })) {
      if (ev.type === 'answer') out += ev.text;
    }

    const journal = /JOURNAL:\s*([^\n]+)/.exec(out)?.[1]?.trim();
    const lessonRaw = /LESSON:\s*([\s\S]+)/.exec(out)?.[1]?.trim();
    const lesson = lessonRaw && lessonRaw.toLowerCase() !== 'none' ? lessonRaw : undefined;

    const date = new Date().toISOString().slice(0, 10);
    if (journal) await this.agents.appendJournal(session.agentId, `${date}  ${journal}`);

    // Provenance decides whether this can ever reach the prompt. A session
    // driven by a mini app or a chat channel is untrusted input by the same
    // reasoning that makes those surfaces Ask-mode with gated tools denied —
    // and a lesson outlives every turn, so it is the more valuable target.
    let quarantined = false;
    if (lesson) {
      const source = sourceForSession(session.name || '');
      const res = await this.memory.record(session.agentId, lesson, { source, sessionId: sessionId });
      quarantined = res.lesson.trusted === 0;
      if (quarantined) {
        await this.agents.addEvent(session.agentId, {
          kind: 'info',
          title: `Learned something from ${source === 'app' ? 'a mini app' : 'a chat channel'} — review before it is used`,
          body: lesson,
          sessionId,
        }).catch(() => {});
      }
    }
    return { ok: Boolean(journal || lesson), journal, lesson, quarantined };
  }
}
