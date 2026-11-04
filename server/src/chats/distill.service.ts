/**
 * DistillService — FR-11.4: distill a chat session's completed work into
 * serialized, size-bounded appends to the owning agent's file brain. The LLM
 * writes one journal entry and, when it learned something durable, one
 * lesson; both appends are capped by AgentsService.
 */
import { Injectable, BadRequestException, NotFoundException, Optional } from '@nestjs/common';
import { ChatsRepository, ChatSession } from './chats.repository';
import { TurnContextService } from './turn-context.service';
import { AgentsService } from '../agents/agents.service';
import { AgentMemoryService, SHARED_AUDIENCE, privateAudience, sourceForSession } from '../agents/agent-memory.service';
import { streamSignal } from '../ai/provider-timeout';
import { currentAccountId } from '../accounts/account-context';
import { SharedService } from '../shared/shared.service';

/**
 * Who may later read what this session taught (docs/shared-agents.md §4).
 * Only in a workspace with members does anything become private; then:
 * content fetched through a member's connection makes the lesson that
 * member's (unless a flow rule already opens their connection content to the
 * initiator), a member's private session makes it theirs, and a shared
 * session with nothing private in it is shared.
 */
export function audienceForSession(
  session: Pick<ChatSession, 'initiatedBy' | 'shared'>,
  connectionOwners: string[],
  opts: { hasMembers: boolean; ownerActor: string; allowedConnectionSources?: ReadonlySet<string> },
): string {
  if (!opts.hasMembers) return SHARED_AUDIENCE;
  const initiator = session.initiatedBy || opts.ownerActor;
  const foreign = connectionOwners.filter((o) => o !== initiator && !(opts.allowedConnectionSources?.has(o) ?? false));
  if (foreign.length > 0) return privateAudience(foreign[0]);
  if (session.shared !== 1) return privateAudience(initiator);
  const own = connectionOwners.find((o) => o === initiator);
  return own ? privateAudience(own) : SHARED_AUDIENCE;
}

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
    /** Optional so test constructors without shared workspaces keep working. */
    @Optional() private readonly shared?: SharedService,
  ) {}

  /** Actors whose connections fed this session, from the turns' tool records. */
  private async connectionOwners(sessionId: string): Promise<string[]> {
    const owners = new Set<string>();
    for (const t of await this.repo.listTurns(sessionId)) {
      try {
        for (const c of JSON.parse(t.toolCalls || '[]') as Array<{ usedConnectionOf?: string }>) {
          if (c.usedConnectionOf) owners.add(c.usedConnectionOf);
        }
      } catch { /* malformed record: ignore */ }
    }
    return [...owners];
  }

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
      const hasMembers = this.shared ? await this.shared.hasMembers(session.workspaceId).catch(() => false) : false;
      const ownerActor = currentAccountId();
      const initiator = session.initiatedBy || ownerActor;
      const allowed = hasMembers && this.shared ? await this.shared.allowedSources(session.workspaceId, initiator, 'connections') : undefined;
      const audience = audienceForSession(session, await this.connectionOwners(sessionId), { hasMembers, ownerActor, allowedConnectionSources: allowed });
      const res = await this.memory.record(session.agentId, lesson, { source, sessionId: sessionId, audience });
      quarantined = res.lesson.trusted === 0;
      if (quarantined) {
        await this.agents.addEvent(session.agentId, {
          kind: 'info',
          title: `Learned something from ${source === 'app' ? 'a mini app' : 'a chat channel'} — review before it is used`,
          body: lesson,
          sessionId,
          // The owner's feed lists it as an agent note to review (feed-registry.ts).
          payload: JSON.stringify({ feed: 'agent_note' }),
        }).catch(() => {});
      }
    }
    return { ok: Boolean(journal || lesson), journal, lesson, quarantined };
  }
}
