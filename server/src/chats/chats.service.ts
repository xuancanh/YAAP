/**
 * ChatsService — chat session lifecycle (§1) and per-session operations that
 * are not the turn loop: rename/pin/tags/archive, drafts, permission mode,
 * /clear, and markdown export (FR-6.7).
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import { ChatsRepository, ChatSession } from './chats.repository';

@Injectable()
export class ChatsService {
  constructor(private readonly repo: ChatsRepository) {}

  list(workspaceId: string, archived = false) {
    return this.repo.listSessions(workspaceId, { archived });
  }

  get(id: string): ChatSession {
    const s = this.repo.getSession(id);
    if (!s) throw new NotFoundException(`chat ${id}`);
    return s;
  }

  create(input: { workspaceId: string; name?: string; cwd?: string; agentId?: string; agentTypeId?: string; model?: string; tokenCeiling?: number }) {
    return this.repo.createSession(input);
  }

  update(id: string, patch: Partial<Pick<ChatSession, 'name' | 'draft' | 'permissionMode' | 'thinkingEffort' | 'model' | 'agentTypeId' | 'tokenCeiling' | 'cwd'>> & { pinned?: boolean; tags?: string[] }) {
    this.get(id);
    const set: Record<string, unknown> = { ...patch };
    if (patch.pinned !== undefined) set.pinned = patch.pinned ? 1 : 0;
    if (patch.tags !== undefined) set.tags = JSON.stringify(patch.tags);
    this.repo.updateSession(id, set);
    return this.get(id);
  }

  archive(id: string) {
    this.get(id);
    this.repo.updateSession(id, { archivedAt: new Date().toISOString() });
    return this.get(id);
  }

  restore(id: string) {
    this.get(id);
    this.repo.updateSession(id, { archivedAt: null });
    return this.get(id);
  }

  remove(id: string) {
    this.get(id);
    this.repo.deleteSession(id);
    return { ok: true };
  }

  transcript(id: string) {
    this.get(id);
    return { messages: this.repo.listMessages(id), turns: this.repo.listTurns(id) };
  }

  /** /clear — wipe transcript and private context (FR-2.4). */
  clear(id: string) {
    this.get(id);
    this.repo.clearMessages(id);
    this.repo.updateSession(id, { compactSummary: '', compactCutoff: null });
    return { ok: true };
  }

  /** /export — the conversation as markdown (FR-6.7). */
  exportMarkdown(id: string): string {
    const s = this.get(id);
    const title = s.name || s.autoTitle || 'Conversation';
    const lines = [`# ${title}`, ''];
    for (const m of this.repo.listMessages(id)) {
      if (m.role === 'thinking') continue;
      const who = m.role === 'user' ? 'User' : m.role === 'tool' ? `Tool (${m.toolName ?? '?'})` : 'Assistant';
      lines.push(`## ${who}`, '', m.content, '');
    }
    return lines.join('\n');
  }

  rateTurn(sessionId: string, turnId: string, rating: 'up' | 'down', note?: string) {
    this.get(sessionId);
    this.repo.updateTurn(turnId, { rating, ratingNote: note ?? null });
    return { ok: true };
  }
}
