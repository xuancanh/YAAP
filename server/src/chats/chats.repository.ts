/**
 * ChatsRepository — Drizzle persistence for sessions, turns, and the visible
 * transcript. Pure data access; policy (locks, ceilings, approvals) lives in
 * the services above it.
 */
import { Injectable, Inject } from '@nestjs/common';
import { and, asc, eq, gt, gte, inArray, isNull, isNotNull, lt, notLike, or, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { chatMessages, chatSessions, chatTurns, loopState } from '../database/schema';
import { newId, nowIso } from '../common/ids.util';
import { actorId, currentAccountId, currentViewer } from '../accounts/account-context';

export type ChatSession = typeof chatSessions.$inferSelect;
export type LoopStateRow = typeof loopState.$inferSelect;
export type ChatTurn = typeof chatTurns.$inferSelect;
export type ChatMessage = typeof chatMessages.$inferSelect;

/** Transaction handle handed to db.transaction callbacks (node-postgres in
 *  production, PGlite in tests — both implement the same Drizzle API). */
type Tx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

@Injectable()
export class ChatsRepository {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}

  // ---- sessions ----
  /** Sessions of a workspace. A member of a shared workspace sees the shared
   *  ones and their own; the owner sees everything (docs/shared-agents.md §5). */
  async listSessions(workspaceId: string, opts: { archived?: boolean } = {}): Promise<ChatSession[]> {
    const archived = opts.archived ? isNotNull(chatSessions.archivedAt) : isNull(chatSessions.archivedAt);
    const rows = await this.db.select().from(chatSessions)
      .where(and(eq(chatSessions.workspaceId, workspaceId), archived));
    const viewer = currentViewer();
    if (!viewer || viewer.role === 'owner') return rows;
    return rows.filter((s) => s.shared === 1 || s.initiatedBy === viewer.memberAccountId);
  }

  /** The rail's filter (docs/chat-archiving.md "The rail"): a workspace's
   *  direct-message sessions the current actor may see — never a channel's
   *  hidden working session (`#slug · Agent` or tagged `channel`). `agentId`
   *  null = the workspace's agent-less chats; `loops` 'only' = the agent's
   *  loop / heartbeat sessions (`Loop · …`), 'exclude' = everything else. */
  private railWhere(workspaceId: string, opts: { agentId?: string | null; archived?: boolean; loops?: 'only' | 'exclude' | 'any'; q?: string }) {
    const conds = [
      eq(chatSessions.workspaceId, workspaceId),
      opts.archived ? isNotNull(chatSessions.archivedAt) : isNull(chatSessions.archivedAt),
      sql`NOT (${chatSessions.name} LIKE '#%' AND ${chatSessions.name} LIKE '% · %')`,
      sql`${chatSessions.tags} NOT LIKE '%"channel"%'`,
    ];
    if (opts.agentId !== undefined) conds.push(opts.agentId === null ? isNull(chatSessions.agentId) : eq(chatSessions.agentId, opts.agentId));
    if (opts.loops === 'only') conds.push(sql`${chatSessions.name} LIKE 'Loop · %'`);
    if (opts.loops === 'exclude') conds.push(notLike(chatSessions.name, 'Loop · %'));
    const q = (opts.q ?? '').trim().toLowerCase();
    if (q) {
      const pat = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      conds.push(sql`(LOWER(${chatSessions.name}) LIKE ${pat} OR LOWER(${chatSessions.autoTitle}) LIKE ${pat} OR LOWER(${chatSessions.tags}) LIKE ${pat})`);
    }
    const viewer = currentViewer();
    if (viewer && viewer.role !== 'owner') conds.push(or(eq(chatSessions.shared, 1), eq(chatSessions.initiatedBy, viewer.memberAccountId))!);
    return and(...conds);
  }

  /** One page of the rail, newest first with pinned chats on top. The
   *  cursor is the last row's `pinned|updatedAt|id` (opaque to clients). */
  async pageSessions(workspaceId: string, opts: { agentId?: string | null; archived?: boolean; loops?: 'only' | 'exclude' | 'any'; q?: string; limit?: number; cursor?: string | null } = {}): Promise<{ items: ChatSession[]; nextCursor: string | null }> {
    const limit = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 20)));
    const conds = [this.railWhere(workspaceId, opts)];
    const cur = decodeCursor(opts.cursor);
    if (cur) {
      conds.push(sql`(${chatSessions.pinned} < ${cur.pinned} OR (${chatSessions.pinned} = ${cur.pinned} AND (${chatSessions.updatedAt} < ${cur.updatedAt} OR (${chatSessions.updatedAt} = ${cur.updatedAt} AND ${chatSessions.id} < ${cur.id}))))`);
    }
    const rows = await this.db.select().from(chatSessions).where(and(...conds))
      .orderBy(sql`${chatSessions.pinned} DESC`, sql`${chatSessions.updatedAt} DESC`, sql`${chatSessions.id} DESC`)
      .limit(limit + 1);
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return { items, nextCursor: rows.length > limit && last ? encodeCursor(last) : null };
  }

  /** How many rail sessions each agent has (key '' = no agent), split into
   *  chats and loop / heartbeat sessions. */
  async railCounts(workspaceId: string, opts: { archived?: boolean; q?: string } = {}): Promise<Map<string, { chats: number; loops: number }>> {
    const rows = await this.db.select({
      agentId: chatSessions.agentId,
      loops: sql<number>`SUM(CASE WHEN ${chatSessions.name} LIKE 'Loop · %' THEN 1 ELSE 0 END)`,
      total: sql<number>`COUNT(*)`,
    }).from(chatSessions).where(this.railWhere(workspaceId, { ...opts, loops: 'any' })).groupBy(chatSessions.agentId);
    const out = new Map<string, { chats: number; loops: number }>();
    for (const r of rows) out.set(r.agentId ?? '', { chats: Number(r.total) - Number(r.loops), loops: Number(r.loops) });
    return out;
  }

  /** Whether the current actor may open this session at all. */
  canView(session: Pick<ChatSession, 'shared' | 'initiatedBy'>): boolean {
    const viewer = currentViewer();
    if (!viewer || viewer.role === 'owner') return true;
    return session.shared === 1 || session.initiatedBy === viewer.memberAccountId;
  }

  async getSession(id: string): Promise<ChatSession | undefined> {
    const rows = await this.db.select().from(chatSessions).where(eq(chatSessions.id, id)).limit(1);
    return rows[0];
  }

  // ---- loop trigger state (docs/triggers.md) ----

  async getLoopState(agentId: string, loopName: string): Promise<LoopStateRow | undefined> {
    const rows = await this.db.select().from(loopState).where(eq(loopState.loopKey, `${agentId}:${loopName}`)).limit(1);
    return rows[0];
  }

  async listLoopStates(agentId: string): Promise<LoopStateRow[]> {
    return this.db.select().from(loopState).where(eq(loopState.agentId, agentId));
  }

  /** Upsert: a partial patch over the stored row (cursor is replaced whole). */
  async putLoopState(agentId: string, loopName: string, patch: Partial<Pick<LoopStateRow, 'cursor' | 'lastPolledAt' | 'lastFiredAt' | 'lastErrorAt'>>): Promise<void> {
    const loopKey = `${agentId}:${loopName}`;
    const existing = await this.getLoopState(agentId, loopName);
    const now = nowIso();
    if (existing) {
      await this.db.update(loopState).set({ ...patch, updatedAt: now }).where(eq(loopState.loopKey, loopKey));
    } else {
      await this.db.insert(loopState).values({
        loopKey, agentId, loopName,
        cursor: patch.cursor ?? '{}',
        lastPolledAt: patch.lastPolledAt ?? null,
        lastFiredAt: patch.lastFiredAt ?? null,
        lastErrorAt: patch.lastErrorAt ?? null,
        updatedAt: now,
      });
    }
  }

  /** Drop state for loops that no longer exist (renamed or removed). */
  async pruneLoopStates(agentId: string, liveNames: string[]): Promise<void> {
    const rows = await this.listLoopStates(agentId);
    const dead = rows.filter((r) => !liveNames.includes(r.loopName)).map((r) => r.loopKey);
    if (dead.length > 0) await this.db.delete(loopState).where(inArray(loopState.loopKey, dead));
  }

  async createSession(input: Partial<ChatSession> & { workspaceId: string }): Promise<ChatSession> {
    const now = nowIso();
    const row: ChatSession = {
      accountId: currentAccountId(),
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
      tokensAtCompact: 0,
      contextTokens: 0,
      ceilingKind: input.ceilingKind ?? 'context',
      distilledAt: null,
      // A member's new session is private to them until they share it; the
      // owner's sessions record '' and are theirs (members do not see them
      // unless shared either).
      initiatedBy: input.initiatedBy ?? (currentViewer()?.memberAccountId ?? ''),
      shared: input.shared ?? 0,
      autoArchiveDays: input.autoArchiveDays ?? null,
      taskKind: input.taskKind ?? null,
      taskId: input.taskId ?? null,
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
    // seq is allocated by a subquery in the same statement — a read-max-then-
    // insert pair is two round-trips and races when the busy lock is absent.
    const rows = await this.db.insert(chatTurns).values({
      id: newId(),
      sessionId,
      seq: sql`(SELECT COALESCE(MAX("seq"), -1) + 1 FROM chat_turns WHERE "sessionId" = ${sessionId})`,
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
    }).returning();
    return rows[0];
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
        accountId: currentAccountId(),
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
        tokensAtCompact: src.tokensAtCompact,
        contextTokens: src.contextTokens,
        ceilingKind: src.ceilingKind,
        distilledAt: null,
        initiatedBy: currentViewer()?.memberAccountId ?? '',
        shared: 0,
        autoArchiveDays: null,
        taskKind: null,
        taskId: null,
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
  async appendMessage(m: { sessionId: string; turnId: string; role: string; content: string; toolName?: string; authorAccountId?: string }): Promise<ChatMessage> {
    // Same single-statement seq allocation as createTurn. User messages carry
    // their author (the acting member; '' for the owner) for attribution.
    const rows = await this.db.insert(chatMessages).values({
      id: newId(),
      sessionId: m.sessionId,
      turnId: m.turnId,
      seq: sql`(SELECT COALESCE(MAX("seq"), -1) + 1 FROM chat_messages WHERE "sessionId" = ${m.sessionId})`,
      role: m.role,
      content: m.content,
      toolName: m.toolName ?? null,
      authorAccountId: m.authorAccountId ?? (m.role === 'user' ? (currentViewer()?.memberAccountId ?? '') : ''),
      createdAt: nowIso(),
    }).returning();
    return rows[0];
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
    return this.db.select().from(chatMessages)
      .where(and(
        eq(chatMessages.sessionId, sessionId),
        inArray(chatMessages.role, ['user', 'assistant']),
        past,
      ))
      .orderBy(asc(chatMessages.seq));
  }

  /** Sessions whose transcript changed since the last distillation and have
   *  been idle since `idleBefore` (auto-distillation sweep). Loop sessions
   *  journal themselves, so they are excluded. */
  async sessionsNeedingDistill(idleBefore: string, loopBefore?: string): Promise<ChatSession[]> {
    // ISO-8601 text timestamps compare lexicographically, so the whole
    // filter lives in SQL instead of loading every agent session.
    return this.db.select().from(chatSessions)
      .where(and(
        isNotNull(chatSessions.agentId),
        isNull(chatSessions.archivedAt),
        lt(chatSessions.updatedAt, idleBefore),
        or(isNull(chatSessions.distilledAt), lt(chatSessions.distilledAt, chatSessions.updatedAt)),
        // Loop sessions are long-lived and fire on a schedule, so distilling
        // them like a chat would bury the journal under one entry per run.
        // They were excluded outright, which meant scheduled work — the
        // proactive half of the product — left no trace in the agent's own
        // record, while the seeded JOURNAL.md promised it did. Included now,
        // but at most once a day: a rolled-up entry rather than a firehose.
        or(
          notLike(chatSessions.name, 'Loop · %'),
          or(isNull(chatSessions.distilledAt), lt(chatSessions.distilledAt, loopBefore ?? idleBefore)),
        ),
      ));
  }

  /** Sets only distilledAt — deliberately not via updateSession, which bumps
   *  updatedAt and would make the sweep re-distill forever. */
  async markDistilled(sessionId: string): Promise<void> {
    await this.db.update(chatSessions).set({ distilledAt: nowIso() }).where(eq(chatSessions.id, sessionId));
  }

  /** The actor id a '' author stands for: the owner of the account. */
  ownerActor(): string { return currentAccountId(); }

  /** Whether `actor` (actorId()) wrote this message. */
  isAuthor(m: Pick<ChatMessage, 'authorAccountId'>, actor: string = actorId()): boolean {
    return (m.authorAccountId || currentAccountId()) === actor;
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
    const hits = res.rows as Array<{ sessionId: string; sessionName: string; role: string; content: string; createdAt: string }>;
    if (hits.length > 0) return hits;

    // Stem matching misses paraphrase, which is exactly what "they referenced
    // earlier work" looks like: "the invoice thing" never finds "billing
    // dispute". Fall back to substring matching on the query's longest words
    // — cheap, index-free, and better than the silent zero-result the agent
    // currently reads as "we never discussed that" (docs/agent-memory.md §4).
    const words = q.toLowerCase().split(/[^a-z0-9]+/i).filter((w) => w.length >= 4).slice(0, 4);
    if (words.length === 0) return hits;
    const like = sql.join(words.map((w) => sql`m."content" ILIKE ${'%' + w + '%'}`), sql` OR `);
    const fuzzy = await this.db.execute(sql`
      SELECT m."sessionId" AS "sessionId",
             COALESCE(NULLIF(s."name", ''), NULLIF(s."autoTitle", ''), 'untitled') AS "sessionName",
             m."role" AS "role", m."content" AS "content", m."createdAt" AS "createdAt"
      FROM chat_messages m
      JOIN chat_sessions s ON s."id" = m."sessionId"
      WHERE s."agentId" = ${agentId}
        AND m."role" IN ('user', 'assistant')
        AND (${like})
      ORDER BY m."createdAt" DESC
      LIMIT ${limit}
    `);
    return fuzzy.rows as Array<{ sessionId: string; sessionName: string; role: string; content: string; createdAt: string }>;
  }
}

/** The rail cursor: the last row's sort key, base64url so clients treat it as opaque. */
function encodeCursor(s: Pick<ChatSession, 'pinned' | 'updatedAt' | 'id'>): string {
  return Buffer.from(JSON.stringify([s.pinned, s.updatedAt, s.id])).toString('base64url');
}

function decodeCursor(raw: string | null | undefined): { pinned: number; updatedAt: string; id: string } | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (Array.isArray(v) && typeof v[0] === 'number' && typeof v[1] === 'string' && typeof v[2] === 'string') return { pinned: v[0], updatedAt: v[1], id: v[2] };
  } catch { /* a malformed cursor reads as the first page */ }
  return null;
}
