/**
 * SearchService — workspace-wide search (FR-8.2): chat sessions by name,
 * transcript messages by content (Postgres ILIKE; an index/FTS upgrade can
 * land behind this same API), and workspace files by name. Results are
 * bounded and snippeted around the first match.
 */
import { Injectable, Inject } from '@nestjs/common';
import { and, eq, ilike, inArray, or } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { chatMessages, chatSessions } from '../database/schema';
import { StorageService } from '../storage/storage.service';
import { workspacePrefix, relativePath } from '../storage/storage.keys';

const MAX_SESSIONS = 20;
const MAX_MESSAGES = 50;
const MAX_FILES = 20;
const SNIPPET = 160;

export interface SearchResults {
  sessions: Array<{ id: string; name: string; autoTitle: string }>;
  messages: Array<{ sessionId: string; messageId: string; turnId: string; role: string; snippet: string }>;
  files: Array<{ path: string; size: number }>;
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
    if (q.length === 0) return { sessions: [], messages: [], files: [] };
    const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;

    const sessions = await this.db.select({
      id: chatSessions.id, name: chatSessions.name, autoTitle: chatSessions.autoTitle,
    }).from(chatSessions)
      .where(and(
        eq(chatSessions.workspaceId, workspaceId),
        or(ilike(chatSessions.name, like), ilike(chatSessions.autoTitle, like)),
      ))
      .limit(MAX_SESSIONS);

    const wsSessionIds = (await this.db.select({ id: chatSessions.id }).from(chatSessions)
      .where(eq(chatSessions.workspaceId, workspaceId))).map((r) => r.id);

    const messages = wsSessionIds.length === 0 ? [] : (await this.db.select().from(chatMessages)
      .where(and(inArray(chatMessages.sessionId, wsSessionIds), ilike(chatMessages.content, like)))
      .limit(MAX_MESSAGES))
      .map((m) => ({
        sessionId: m.sessionId, messageId: m.id, turnId: m.turnId, role: m.role,
        snippet: snippetAround(m.content, q),
      }));

    const files = (await this.storage.list(workspacePrefix(workspaceId)))
      .map((o) => ({ path: relativePath(workspaceId, o.key), size: o.size }))
      .filter((f) => f.path.toLowerCase().includes(q.toLowerCase()))
      .slice(0, MAX_FILES);

    return { sessions, messages, files };
  }
}
