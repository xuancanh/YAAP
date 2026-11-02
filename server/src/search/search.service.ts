/**
 * SearchService — workspace-wide search (FR-8.2): chat sessions by name
 * (ILIKE — substring semantics the session list depends on), transcript
 * messages by content (Postgres FTS via the 0006 GIN tsvector index), and
 * workspace files by name. Results are bounded and snippeted around the
 * first match.
 */
import { Injectable, Inject } from '@nestjs/common';
import { and, eq, ilike, or, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { chatSessions } from '../database/schema';
import { actorId } from '../accounts/account-context';
import { StorageService } from '../storage/storage.service';
import { workspacePrefix, relativePath, isHiddenPath } from '../storage/storage.keys';

const MAX_SESSIONS = 20;
const MAX_MESSAGES = 50;
const MAX_FILES = 20;
const SNIPPET = 160;

export interface SearchResults {
  sessions: Array<{ id: string; name: string; autoTitle: string }>;
  messages: Array<{ sessionId: string; messageId: string; turnId: string; role: string; snippet: string }>;
  files: Array<{ path: string; size: number }>;
  /** Group-chat messages (docs/group-chat.md §6: the same FTS, extended). */
  channelMessages: Array<{ channelId: string; slug: string; messageId: string; threadRootId: string | null; authorKind: string; authorId: string; snippet: string; createdAt: string }>;
}

function snippetAround(content: string, query: string): string {
  const idx = content.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return content.slice(0, SNIPPET);
  const start = Math.max(0, idx - SNIPPET / 2);
  return `${start > 0 ? '…' : ''}${content.slice(start, start + SNIPPET)}${start + SNIPPET < content.length ? '…' : ''}`;
}

@Injectable()
export class SearchService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly storage: StorageService,
  ) {}

  async search(workspaceId: string, query: string): Promise<SearchResults> {
    const q = query.trim();
    if (q.length === 0) return { sessions: [], messages: [], files: [], channelMessages: [] };
    const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;

    const sessions = await this.db.select({
      id: chatSessions.id, name: chatSessions.name, autoTitle: chatSessions.autoTitle,
    }).from(chatSessions)
      .where(and(
        eq(chatSessions.workspaceId, workspaceId),
        or(ilike(chatSessions.name, like), ilike(chatSessions.autoTitle, like)),
      ))
      .limit(MAX_SESSIONS);

    // Full-text over message content (same pattern as
    // ChatsRepository.searchAgentMessages — hits the GIN tsvector index);
    // the join also folds the workspace scoping into the one query.
    const hits = await this.db.execute(sql`
      SELECT m."id" AS "messageId", m."sessionId" AS "sessionId", m."turnId" AS "turnId",
             m."role" AS "role", m."content" AS "content"
      FROM chat_messages m
      JOIN chat_sessions s ON s."id" = m."sessionId"
      WHERE s."workspaceId" = ${workspaceId}
        AND to_tsvector('english', m."content") @@ plainto_tsquery('english', ${q.slice(0, 200)})
      LIMIT ${MAX_MESSAGES}
    `);
    const messages = (hits.rows as Array<{
      messageId: string; sessionId: string; turnId: string; role: string; content: string;
    }>).map((m) => ({
      sessionId: m.sessionId, messageId: m.messageId, turnId: m.turnId, role: m.role,
      snippet: snippetAround(m.content, q),
    }));

    const files = (await this.storage.list(workspacePrefix(workspaceId)))
      .map((o) => ({ path: relativePath(workspaceId, o.key), size: o.size }))
      .filter((f) => !isHiddenPath(f.path) && f.path.toLowerCase().includes(q.toLowerCase()))
      .slice(0, MAX_FILES);

    // Channel messages: the 0029 GIN index, joined to channels for the slug
    // and the workspace. Private channels are included only for members.
    const chanHits = await this.db.execute(sql`
      SELECT m."id" AS "messageId", m."channelId" AS "channelId", c."slug" AS "slug", m."threadRootId" AS "threadRootId",
             m."authorKind" AS "authorKind", m."authorId" AS "authorId", m."text" AS "text", m."createdAt" AS "createdAt"
      FROM channel_messages m
      JOIN channels c ON c."id" = m."channelId"
      WHERE c."workspaceId" = ${workspaceId}
        AND (c."kind" <> 'private' OR EXISTS (
          SELECT 1 FROM channel_members cm WHERE cm."channelId" = c."id" AND cm."memberKind" = 'human' AND cm."memberId" = ${actorId()}))
        AND to_tsvector('english', m."text") @@ plainto_tsquery('english', ${q.slice(0, 200)})
      ORDER BY m."createdAt" DESC
      LIMIT ${MAX_MESSAGES}
    `);
    const channelMessages = (chanHits.rows as Array<{
      messageId: string; channelId: string; slug: string; threadRootId: string | null; authorKind: string; authorId: string; text: string; createdAt: string;
    }>).map((m) => ({
      channelId: m.channelId, slug: m.slug, messageId: m.messageId, threadRootId: m.threadRootId, authorKind: m.authorKind, authorId: m.authorId,
      snippet: snippetAround(m.text, q), createdAt: m.createdAt,
    }));

    return { sessions, messages, files, channelMessages };
  }
}
