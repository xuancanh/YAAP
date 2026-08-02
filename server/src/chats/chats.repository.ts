/**
 * ChatsRepository — Drizzle persistence for sessions, turns, and the visible
 * transcript. Pure data access; policy (locks, ceilings, approvals) lives in
 * the services above it.
 */
import { Injectable, Inject } from '@nestjs/common';
import { and, asc, desc, eq, gt, gte, inArray, isNull, isNotNull, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { chatMessages, chatSessions, chatTurns } from '../database/schema';
import { newId, nowIso } from '../common/ids.util';

export type ChatSession = typeof chatSessions.$inferSelect;
export type ChatTurn = typeof chatTurns.$inferSelect;
export type ChatMessage = typeof chatMessages.$inferSelect;

/** Transaction handle handed to db.transaction callbacks (node-postgres in
 *  production, PGlite in tests — both implement the same Drizzle API). */
type Tx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

@Injectable()
export class ChatsRepository {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}

  // ---- sessions ----
  async listSessions(workspaceId: string, opts: { archived?: boolean } = {}): Promise<ChatSession[]> {
    const archived = opts.archived ? isNotNull(chatSessions.archivedAt) : isNull(chatSessions.archivedAt);
    return this.db.select().from(chatSessions)
      .where(and(eq(chatSessions.workspaceId, workspaceId), archived));
  }

  async getSession(id: string): Promise<ChatSession | undefined> {
    const rows = await this.db.select().from(chatSessions).where(eq(chatSessions.id, id)).limit(1);
    return rows[0];
  }

  async createSession(input: Partial<ChatSession> & { workspaceId: string }): Promise<ChatSession> {
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
      distilledAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.db.insert(chatSessions).values(row);
    return row;
  }

  async updateSession(id: string, patch: Partial<ChatSession>): Promise<void> {
    await this.db.update(chatSessions)
      .set({ ...patch, updatedAt: nowIso() })
      .where(eq(chatSessions.id, id));
  }

  /** Multi-delete in one transaction: a mid-sequence failure must not leave
   *  orphaned turns/messages behind. */
  async deleteSession(id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(chatMessages).where(eq(chatMessages.sessionId, id));
      await tx.delete(chatTurns).where(eq(chatTurns.sessionId, id));
      await tx.delete(chatSessions).where(eq(chatSessions.id, id));
    });
  }

  // ---- turns ----
  async createTurn(sessionId: string, input: { text: string; attachments?: unknown[]; model?: string }): Promise<ChatTurn> {
    const last = await this.db.select({ seq: chatTurns.seq }).from(chatTurns)
      .where(eq(chatTurns.sessionId, sessionId))
      .orderBy(desc(chatTurns.seq)).limit(1);
    const row: ChatTurn = {
      id: newId(),
      sessionId,
      seq: (last[0]?.seq ?? -1) + 1,
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
    await this.db.insert(chatTurns).values(row);
    return row;
  }

  async updateTurn(id: string, patch: Partial<ChatTurn>): Promise<void> {
    await this.db.update(chatTurns).set(patch).where(eq(chatTurns.id, id));
  }

  async listTurns(sessionId: string): Promise<ChatTurn[]> {
    return this.db.select().from(chatTurns)
      .where(eq(chatTurns.sessionId, sessionId))
      .orderBy(asc(chatTurns.seq));
  }

  async getTurn(id: string): Promise<ChatTurn | undefined> {
    const rows = await this.db.select().from(chatTurns).where(eq(chatTurns.id, id)).limit(1);
    return rows[0];
  }

  /** Edit & resend / retry support: drop everything from a turn onward
   *  (the turn records and their transcript rows), atomically. */
  async truncateFromTurn(sessionId: string, turnSeq: number): Promise<void> {
    await this.db.transaction(async (tx) => {
      const doomed = await tx.select({ id: chatTurns.id }).from(chatTurns)
        .where(and(eq(chatTurns.sessionId, sessionId), gte(chatTurns.seq, turnSeq)));
      const ids = doomed.map((r) => r.id);
      if (ids.length > 0) {
        await tx.delete(chatMessages)
          .where(and(eq(chatMessages.sessionId, sessionId), inArray(chatMessages.turnId, ids)));
        await tx.delete(chatTurns)
          .where(and(eq(chatTurns.sessionId, sessionId), gte(chatTurns.seq, turnSeq)));
      }
    });
  }

  /** Fork support: copy turns/messages (optionally up to a turn seq) into a
   *  new session with fresh row ids. */
  async copyInto(sourceId: string, targetId: string, upToTurnSeq: number | null): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.copyIntoTx(tx, sourceId, targetId, upToTurnSeq);
    });
  }

  /** Fork a session row plus its transcript in one transaction, so a
   *  mid-copy failure can't leave a half-populated fork behind. Carries over
   *  the fields ChatsService.fork used to patch in separate writes. */
  async forkSession(src: ChatSession, upToTurnSeq: number | null): Promise<ChatSession> {
    return this.db.transaction(async (tx) => {
      const now = nowIso();
      const row: ChatSession = {
        id: newId(),
        workspaceId: src.workspaceId,
        agentId: src.agentId,
        agentTypeId: src.agentTypeId,
        name: `Fork · ${src.name || src.autoTitle || 'chat'}`,
        autoTitle: '',
        cwd: src.cwd,
        model: src.model,
        thinkingEffort: src.thinkingEffort,
        permissionMode: src.permissionMode,
        approvals: '{}',
        skillSourceIds: '[]',
        pinned: 0,
        tags: JSON.stringify([...(JSON.parse(src.tags) as string[]), 'fork']),
        archivedAt: null,
        draft: '',
        tokenCeiling: src.tokenCeiling,
        compactSummary: src.compactSummary,
        compactCutoff: src.compactCutoff,
        tokensIn: src.tokensIn,
        tokensOut: src.tokensOut,
        distilledAt: null,
        createdAt: now,
        updatedAt: now,
      };
      await tx.insert(chatSessions).values(row);
      await this.copyIntoTx(tx, src.id, row.id, upToTurnSeq);
      return row;
    });
  }

  /** The actual copy, on a transaction handle so callers can compose it with
   *  their own writes (see forkSession). */
  private async copyIntoTx(tx: Tx, sourceId: string, targetId: string, upToTurnSeq: number | null): Promise<void> {
    const turns = (await tx.select().from(chatTurns)
      .where(eq(chatTurns.sessionId, sourceId))
      .orderBy(asc(chatTurns.seq)))
      .filter((t) => upToTurnSeq === null || t.seq <= upToTurnSeq);
    const turnIdMap = new Map<string, string>();
    for (const t of turns) {
      const nid = newId();
      turnIdMap.set(t.id, nid);
      await tx.insert(chatTurns).values({ ...t, id: nid, sessionId: targetId });
    }
    const messages = (await tx.select().from(chatMessages)
      .where(eq(chatMessages.sessionId, sourceId))
      .orderBy(asc(chatMessages.seq)))
      .filter((m) => turnIdMap.has(m.turnId));
    for (const m of messages) {
      await tx.insert(chatMessages).values({
        ...m, id: newId(), sessionId: targetId, turnId: turnIdMap.get(m.turnId)!,
      });
    }
  }

  // ---- transcript ----
  async appendMessage(m: { sessionId: string; turnId: string; role: string; content: string; toolName?: string }): Promise<ChatMessage> {
    const last = await this.db.select({ seq: chatMessages.seq }).from(chatMessages)
      .where(eq(chatMessages.sessionId, m.sessionId))
      .orderBy(desc(chatMessages.seq)).limit(1);
    const row: ChatMessage = {
      id: newId(),
      sessionId: m.sessionId,
      turnId: m.turnId,
      seq: (last[0]?.seq ?? -1) + 1,
      role: m.role,
      content: m.content,
      toolName: m.toolName ?? null,
      createdAt: nowIso(),
    };
    await this.db.insert(chatMessages).values(row);
    return row;
  }

  async listMessages(sessionId: string): Promise<ChatMessage[]> {
    return this.db.select().from(chatMessages)
      .where(eq(chatMessages.sessionId, sessionId))
      .orderBy(asc(chatMessages.seq));
  }

  async clearMessages(sessionId: string): Promise<void> {
    await this.db.delete(chatMessages).where(eq(chatMessages.sessionId, sessionId));
  }

  /** Rows that rebuild provider history: user + assistant only (tool and
   *  thinking are excluded — FR-8.1), and only past the compaction cutoff
   *  sequence when one is set (FR-7.4). */
  async providerHistory(sessionId: string, cutoffSeq: number | null): Promise<ChatMessage[]> {
    const past = cutoffSeq === null ? undefined : gt(chatMessages.seq, cutoffSeq);
    const rows = await this.db.select().from(chatMessages)
      .where(and(eq(chatMessages.sessionId, sessionId), past))
      .orderBy(asc(chatMessages.seq));
    return rows.filter((m) => m.role === 'user' || m.role === 'assistant');
  }

  /** Sessions whose transcript changed since the last distillation and have
   *  been idle since `idleBefore` (auto-distillation sweep). Loop sessions
   *  journal themselves, so they are excluded. */
  async sessionsNeedingDistill(idleBefore: string): Promise<ChatSession[]> {
    const rows = await this.db.select().from(chatSessions)
      .where(and(isNotNull(chatSessions.agentId), isNull(chatSessions.archivedAt)));
    return rows.filter((s) => s.updatedAt < idleBefore
      && (!s.distilledAt || s.distilledAt < s.updatedAt)
      && !s.name.startsWith('Loop · '));
  }

  /** Sets only distilledAt — deliberately not via updateSession, which bumps
   *  updatedAt and would make the sweep re-distill forever. */
  async markDistilled(sessionId: string): Promise<void> {
    await this.db.update(chatSessions).set({ distilledAt: nowIso() }).where(eq(chatSessions.id, sessionId));
  }

  /** Full-text recall over an agent's transcripts (search_history tool):
   *  user/assistant rows of the agent's sessions, ranked newest-first. */
  async searchAgentMessages(agentId: string, query: string, limit = 8): Promise<Array<{
    sessionId: string; sessionName: string; role: string; content: string; createdAt: string;
  }>> {
    const q = query.trim().slice(0, 200);
    if (!q) return [];
    const res = await this.db.execute(sql`
      SELECT m."sessionId" AS "sessionId",
             COALESCE(NULLIF(s."name", ''), NULLIF(s."autoTitle", ''), 'untitled') AS "sessionName",
             m."role" AS "role", m."content" AS "content", m."createdAt" AS "createdAt"
      FROM chat_messages m
      JOIN chat_sessions s ON s."id" = m."sessionId"
      WHERE s."agentId" = ${agentId}
        AND m."role" IN ('user', 'assistant')
        AND to_tsvector('english', m."content") @@ plainto_tsquery('english', ${q})
      ORDER BY m."createdAt" DESC
      LIMIT ${limit}
    `);
    return res.rows as Array<{ sessionId: string; sessionName: string; role: string; content: string; createdAt: string }>;
  }
}
