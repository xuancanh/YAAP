/**
 * ChatsService — chat session lifecycle (§1) and per-session operations that
 * are not the turn loop: rename/pin/tags/archive, drafts, permission mode,
 * /clear, and markdown export (FR-6.7).
 */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ChatsRepository, ChatSession } from './chats.repository';
import { nowIso } from '../common/ids.util';
import { AgentsService } from '../agents/agents.service';

@Injectable()
export class ChatsService {
  constructor(
    private readonly repo: ChatsRepository,
    private readonly agents: AgentsService,
  ) {}

  list(workspaceId: string, archived = false) {
    return this.repo.listSessions(workspaceId, { archived });
  }

  async get(id: string): Promise<ChatSession> {
    const s = await this.repo.getSession(id);
    if (!s) throw new NotFoundException(`chat ${id}`);
    return s;
  }

  create(input: { workspaceId: string; name?: string; cwd?: string; agentId?: string; agentTypeId?: string; model?: string; tokenCeiling?: number }) {
    return this.repo.createSession(input);
  }

  async update(id: string, patch: Partial<Pick<ChatSession, 'name' | 'draft' | 'permissionMode' | 'thinkingEffort' | 'model' | 'agentTypeId' | 'tokenCeiling' | 'cwd'>> & { pinned?: boolean; tags?: string[] }) {
    await this.get(id);
    const set: Record<string, unknown> = { ...patch };
    if (patch.pinned !== undefined) set.pinned = patch.pinned ? 1 : 0;
    if (patch.tags !== undefined) set.tags = JSON.stringify(patch.tags);
    await this.repo.updateSession(id, set);
    return this.get(id);
  }

  async archive(id: string) {
    await this.get(id);
    await this.repo.updateSession(id, { archivedAt: new Date().toISOString() });
    return this.get(id);
  }

  async restore(id: string) {
    await this.get(id);
    await this.repo.updateSession(id, { archivedAt: null });
    return this.get(id);
  }

  async remove(id: string) {
    await this.get(id);
    await this.repo.deleteSession(id);
    return { ok: true };
  }

  async transcript(id: string) {
    await this.get(id);
    return {
      messages: await this.repo.listMessages(id),
      turns: await this.repo.listTurns(id),
    };
  }

  /** /clear — wipe transcript and private context (FR-2.4). */
  async clear(id: string) {
    await this.get(id);
    await this.repo.clearMessages(id);
    await this.repo.updateSession(id, { compactSummary: '', compactCutoff: null });
    return { ok: true };
  }

  /** /export — the conversation as markdown (FR-6.7). */
  async exportMarkdown(id: string): Promise<string> {
    const s = await this.get(id);
    const title = s.name || s.autoTitle || 'Conversation';
    const lines = [`# ${title}`, ''];
    for (const m of await this.repo.listMessages(id)) {
      if (m.role === 'thinking') continue;
      const who = m.role === 'user' ? 'User' : m.role === 'tool' ? `Tool (${m.toolName ?? '?'})` : 'Assistant';
      lines.push(`## ${who}`, '', m.content, '');
    }
    return lines.join('\n');
  }

  /** Fork a new session from this one, optionally branching at a turn; the
   *  original stays intact (FR-6.3). The fork row and transcript copy commit
   *  together (see repo.forkSession). */
  async fork(id: string, turnId?: string) {
    const src = await this.get(id);
    let upTo: number | null = null;
    if (turnId) {
      const turn = await this.repo.getTurn(turnId);
      if (!turn || turn.sessionId !== id) throw new NotFoundException(`turn ${turnId}`);
      upTo = turn.seq;
    }
    const forked = await this.repo.forkSession(src, upTo);
    return this.get(forked.id);
  }

  /** Edit & resend / retry: drop this turn and everything after it (FR-6.1/6.2).
   *  Returns the removed turn's input so the client can restore it. */
  async truncateFrom(id: string, turnId: string) {
    await this.get(id);
    const turn = await this.repo.getTurn(turnId);
    if (!turn || turn.sessionId !== id) throw new NotFoundException(`turn ${turnId}`);
    await this.repo.truncateFromTurn(id, turn.seq);
    return { ok: true, input: turn.input };
  }

  /** Promote a turn onto the owning agent's kanban board (FR-6.4). */
  async promoteTurn(id: string, turnId: string) {
    const session = await this.get(id);
    const turn = await this.repo.getTurn(turnId);
    if (!turn || turn.sessionId !== id) throw new NotFoundException(`turn ${turnId}`);
    if (!session.agentId) throw new BadRequestException('only chats owned by a durable agent can promote turns to its board');
    const task = await this.agents.addTask(session.agentId, {
      title: turn.input.replace(/\s+/g, ' ').slice(0, 120),
      note: `Promoted from the chat "${session.name || session.autoTitle || 'untitled'}".`,
      origin: 'promote',
      sessionId: id,
    });
    const handoff = { task: `[${task.id.slice(0, 8)}] ${task.title}`.slice(0, 140), taskId: task.id, at: nowIso() };
    await this.repo.updateTurn(turnId, { taskHandoff: JSON.stringify(handoff) });
    return handoff;
  }

  async rateTurn(sessionId: string, turnId: string, rating: 'up' | 'down', note?: string) {
    const session = await this.get(sessionId);
    await this.repo.updateTurn(turnId, { rating, ratingNote: note ?? null });
    // For durable agents the rating is recorded and surfaced on the next
    // reply (FR-6.5).
    if (session.agentId) {
      await this.agents.addFeedback(session.agentId, { rating, note, turnId }).catch(() => {});
    }
    return { ok: true };
  }
}
