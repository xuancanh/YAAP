/**
 * ChatsRepository — Drizzle persistence for sessions, turns, and the visible
 * transcript. Pure data access; policy (locks, ceilings, approvals) lives in
 * the services above it.
 */
import { Injectable, Inject } from '@nestjs/common';
import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { chatMessages, chatSessions, chatTurns } from '../database/schema';
import { newId, nowIso } from '../common/ids.util';

export type ChatSession = typeof chatSessions.$inferSelect;
export type ChatTurn = typeof chatTurns.$inferSelect;
export type ChatMessage = typeof chatMessages.$inferSelect;

@Injectable()
export class ChatsRepository {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}

  // ---- sessions ----
  listSessions(workspaceId: string, opts: { archived?: boolean } = {}): ChatSession[] {
    const archived = opts.archived
      ? sql`${chatSessions.archivedAt} IS NOT NULL`
      : isNull(chatSessions.archivedAt);
    return this.db.select().from(chatSessions)
      .where(and(eq(chatSessions.workspaceId, workspaceId), archived))
      .all();
  }

  getSession(id: string): ChatSession | undefined {
    return this.db.select().from(chatSessions).where(eq(chatSessions.id, id)).get();
  }

  createSession(input: Partial<ChatSession> & { workspaceId: string }): ChatSession {
    const now = nowIso();
    const row: ChatSession = {
      id: newId(),
      workspaceId: input.workspaceId,
      agentId: input.agentId ?? null,
      agentTypeId: input.agentTypeId ?? null,
      name: input.name ?? '',
      autoTitle: '',
      cwd: input.cwd ?? null,
      model: input.model ?? '',
      thinkingEffort: input.thinkingEffort ?? 'off',
      permissionMode: input.permissionMode ?? 'ask',
      approvals: '{}',
      skillSourceIds: input.skillSourceIds ?? '[]',
      pinned: 0,
      tags: '[]',
      archivedAt: null,
      draft: '',
      tokenCeiling: input.tokenCeiling ?? 200000,
      compactSummary: '',
      compactCutoff: null,
      tokensIn: 0,
      tokensOut: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.db.insert(chatSessions).values(row).run();
    return row;
  }

  updateSession(id: string, patch: Partial<ChatSession>): void {
    this.db.update(chatSessions)
      .set({ ...patch, updatedAt: nowIso() })
      .where(eq(chatSessions.id, id)).run();
  }

  deleteSession(id: string): void {
    this.db.delete(chatMessages).where(eq(chatMessages.sessionId, id)).run();
    this.db.delete(chatTurns).where(eq(chatTurns.sessionId, id)).run();
    this.db.delete(chatSessions).where(eq(chatSessions.id, id)).run();
  }

  // ---- turns ----
  createTurn(sessionId: string, input: { text: string; attachments?: unknown[]; model?: string }): ChatTurn {
    const last = this.db.select({ seq: chatTurns.seq }).from(chatTurns)
      .where(eq(chatTurns.sessionId, sessionId))
      .orderBy(asc(chatTurns.seq)).all().at(-1);
    const row: ChatTurn = {
      id: newId(),
      sessionId,
      seq: (last?.seq ?? -1) + 1,
      input: input.text,
      attachments: JSON.stringify(input.attachments ?? []),
      model: input.model ?? '',
      status: 'running',
      toolCalls: '[]',
      tokensIn: 0,
      tokensOut: 0,
      rating: null,
      ratingNote: null,
      taskHandoff: null,
      error: null,
      createdAt: nowIso(),
    };
    this.db.insert(chatTurns).values(row).run();
    return row;
  }

  updateTurn(id: string, patch: Partial<ChatTurn>): void {
    this.db.update(chatTurns).set(patch).where(eq(chatTurns.id, id)).run();
  }

  listTurns(sessionId: string): ChatTurn[] {
    return this.db.select().from(chatTurns)
      .where(eq(chatTurns.sessionId, sessionId))
      .orderBy(asc(chatTurns.seq)).all();
  }

  // ---- transcript ----
  appendMessage(m: { sessionId: string; turnId: string; role: string; content: string; toolName?: string }): ChatMessage {
    const last = this.db.select({ seq: chatMessages.seq }).from(chatMessages)
      .where(eq(chatMessages.sessionId, m.sessionId))
      .orderBy(asc(chatMessages.seq)).all().at(-1);
    const row: ChatMessage = {
      id: newId(),
      sessionId: m.sessionId,
      turnId: m.turnId,
      seq: (last?.seq ?? -1) + 1,
      role: m.role,
      content: m.content,
      toolName: m.toolName ?? null,
      createdAt: nowIso(),
    };
    this.db.insert(chatMessages).values(row).run();
    return row;
  }

  listMessages(sessionId: string): ChatMessage[] {
    return this.db.select().from(chatMessages)
      .where(eq(chatMessages.sessionId, sessionId))
      .orderBy(asc(chatMessages.seq)).all();
  }

  clearMessages(sessionId: string): void {
    this.db.delete(chatMessages).where(eq(chatMessages.sessionId, sessionId)).run();
  }

  /** Rows that rebuild provider history: user + assistant only (tool and
   *  thinking are excluded — FR-8.1), and only past the compaction cutoff
   *  sequence when one is set (FR-7.4). */
  providerHistory(sessionId: string, cutoffSeq: number | null): ChatMessage[] {
    const past = cutoffSeq === null ? undefined : gt(chatMessages.seq, cutoffSeq);
    return this.db.select().from(chatMessages)
      .where(and(eq(chatMessages.sessionId, sessionId), past))
      .orderBy(asc(chatMessages.seq)).all()
      .filter((m) => m.role === 'user' || m.role === 'assistant');
  }
}
