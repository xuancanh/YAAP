/**
 * The knowledge-base tools (docs/knowledge-base.md): `kb_search`, `kb_read`
 * and `kb_list`, offered to every durable agent whose scope is not empty —
 * in a private chat, a channel, a meeting, a task run or a heartbeat alike
 * (channel parity) — through `TurnLoopService.addToolProvider`. Read-only
 * (classed `read` in actions/action-classes.ts): no approval anywhere.
 *
 * Scoping: an agent searches and reads its own role's knowledge base plus
 * the shared topics it sees, never another role's (that folder is still a
 * readable file under /library/, but it is not the agent's reference).
 *
 * The provider's context is the prompt pointer: one short section naming
 * what the knowledge base holds and when to use it. It also installs the
 * library on the first turn that needs it (fire-and-forget).
 */
import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { TurnLoopService, type ToolProviderHook } from '../chats/turn-loop.service';
import type { ChatSession } from '../chats/chats.repository';
import type { AiToolSpec } from '../ai/ai-provider.interface';
import { KnowledgeService } from './knowledge.service';
import { KB_SEARCH_MAX, findDoc, promptPointer, readPage, renderHits, renderList, renderPage, scopeDocs, scopeIsEmpty, searchKb } from './knowledge';

export const KB_TOOLS: AiToolSpec[] = [
  {
    name: 'kb_search',
    description: 'Search your role\'s knowledge base (curated, read-only reference: frameworks, checklists, templates, metric definitions) and the shared topics you see. Returns ranked docs with a matching line; read one with kb_read. Use it before planning a deliverable in your field, when unsure of a method, or when a checklist may apply.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Plain words, e.g. "weekly report template" or "runway formula".' },
        limit: { type: 'integer', description: `At most this many hits (default ${KB_SEARCH_MAX}).` },
      },
      required: ['query'],
    },
  },
  {
    name: 'kb_read',
    description: 'Read a knowledge-base doc by its path as kb_search or kb_list shows it (e.g. "biz-finance-manager/budget-memo.md" or "_shared/okrs/writing-key-results.md"; /library/… paths work too), in pages. Cite what you use as (KB: <path>).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        page: { type: 'integer', description: 'Page number, from 1 (long docs come in pages).' },
      },
      required: ['path'],
    },
  },
  {
    name: 'kb_list',
    description: 'List every doc in your knowledge base: your role\'s docs and the shared topics, each with its one-line summary.',
    inputSchema: { type: 'object', properties: {} },
  },
];
export const KB_TOOL_NAMES = new Set(KB_TOOLS.map((t) => t.name));

@Injectable()
export class KnowledgeTools implements ToolProviderHook, OnModuleInit {
  private readonly logger = new Logger(KnowledgeTools.name);

  constructor(
    private readonly knowledge: KnowledgeService,
    @Optional() private readonly turns?: TurnLoopService,
  ) {}

  onModuleInit(): void { this.turns?.addToolProvider(this); }

  async specsFor(session: ChatSession): Promise<AiToolSpec[]> {
    if (!session.agentId) return [];
    const scope = await this.knowledge.scopeOf(session.agentId).catch(() => null);
    return scope && !scopeIsEmpty(scope) ? KB_TOOLS : [];
  }

  owns(name: string): boolean { return KB_TOOL_NAMES.has(name); }

  isReadOnly(name: string): boolean { return KB_TOOL_NAMES.has(name); }

  async contextFor(session: ChatSession): Promise<string | null> {
    if (!session.agentId) return null;
    const agentId = session.agentId;
    const scope = await this.knowledge.scopeOf(agentId).catch(() => null);
    if (!scope || scopeIsEmpty(scope)) return null;
    void this.knowledge.ensureInstalled(agentId).catch((err) => this.logger.warn(`knowledge install for ${agentId} failed: ${err instanceof Error ? err.message : err}`));
    return promptPointer(scope);
  }

  async execute(session: ChatSession, name: string, input: Record<string, unknown>): Promise<string> {
    if (!session.agentId) throw new Error(`${name} is only available to durable agents`);
    const scope = await this.knowledge.scopeOf(session.agentId);
    if (scopeIsEmpty(scope)) return 'You have no knowledge base.';
    const docs = scopeDocs(scope);
    if (name === 'kb_list') return renderList(scope);
    if (name === 'kb_search') {
      const query = typeof input.query === 'string' ? input.query.trim() : '';
      if (!query) throw new Error('invalid arguments: "query" must be a non-empty string');
      const limit = typeof input.limit === 'number' && Number.isInteger(input.limit) && input.limit > 0 ? Math.min(input.limit, 20) : KB_SEARCH_MAX;
      return renderHits(searchKb(docs, query, limit), query);
    }
    if (name === 'kb_read') {
      const path = typeof input.path === 'string' ? input.path : '';
      if (!path.trim()) throw new Error('invalid arguments: "path" must be a non-empty string');
      const doc = findDoc(docs, path);
      if (!doc) return `"${path}" is not in your knowledge base. kb_list shows the docs you can read.`;
      const page = input.page === undefined || input.page === null ? 1 : Number(input.page);
      if (!Number.isInteger(page) || page < 1) throw new Error('invalid arguments: "page" must be a positive integer');
      return renderPage(readPage(doc, page));
    }
    throw new Error(`unknown tool: ${name}`);
  }
}
