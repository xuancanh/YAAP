/** Shared test doubles: in-memory storage, PGlite bootstrap, context stubs. */
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '../server/src/database/schema';
import { runPgMigrations, Queryable } from '../server/src/database/migrator';
import type { DrizzleDb } from '../server/src/database/database.module';
import { scopeDb } from '../server/src/accounts/scoped-db';
import type { StorageService } from '../server/src/storage/storage.service';
import type { TurnContextService, TurnContext } from '../server/src/chats/turn-context.service';
import type { SkillsService } from '../server/src/skills/skills.service';
import type { AgentsService } from '../server/src/agents/agents.service';
import type { WorkspacesService } from '../server/src/workspaces/workspaces.service';
import type { McpService } from '../server/src/mcp/mcp.module';
import { AiProvider, AiRequest, AiStreamEvent } from '../server/src/ai/ai-provider.interface';

/** Adapt PGlite to the migrator's pg-Pool-shaped interface: `exec` for
 *  multi-statement DDL (simple protocol), `query` when params are bound. */
export function pgliteQueryable(pg: PGlite): Queryable {
  return {
    query: async (sql: string, params?: unknown[]) => {
      if (params && params.length > 0) return pg.query(sql, params);
      const results = await pg.exec(sql);
      return { rows: results.at(-1)?.rows ?? [] };
    },
  };
}

/** The same account-scoped handle production injects (accounts/scoped-db.ts).
 *  With no account bound — every existing test — queries resolve to the
 *  single account, exactly as AUTH_MODE=single does. */
export async function testDb(): Promise<DrizzleDb> {
  const pg = new PGlite();
  await runPgMigrations(pgliteQueryable(pg), { log: () => {} });
  return scopeDb(drizzle(pg, { schema }) as unknown as DrizzleDb);
}

/** In-memory stand-in for the S3 StorageService (structural match). */
export function memStorage() {
  const map = new Map<string, Buffer>();
  const stub = {
    map,
    async put(key: string, body: Buffer) { map.set(key, Buffer.from(body)); },
    async get(key: string) { return map.get(key) ?? null; },
    async delete(key: string) { map.delete(key); },
    async list(prefix: string) {
      return [...map.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([k, v]) => ({ key: k, size: v.length }));
    },
    async deletePrefix(prefix: string) {
      for (const k of [...map.keys()]) if (k.startsWith(prefix)) map.delete(k);
    },
  };
  return { stub: stub as unknown as StorageService, map };
}

/** TurnContextService stub returning a fixed provider. */
export function ctxStub(provider: AiProvider, overrides: Partial<TurnContext> = {}): TurnContextService {
  return {
    build: async () => ({ provider, model: 'test-model', system: '', maxToolRounds: 24, ...overrides }),
  } as unknown as TurnContextService;
}

/** SkillsService stub offering no skills (turn-loop tests that don't care). */
export function skillsStub(): SkillsService {
  return {
    toolSpecs: async () => [],
    resolveTool: async () => undefined,
    invocation: () => '',
    draftSkill: async () => 'Skill "stub" drafted. The user reviews and approves it before it becomes available; do not assume you can call it yet.',
    recordUse: async () => {},
    proposeRevision: async () => 'Revision proposed.',
  } as unknown as SkillsService;
}

/** McpService stub offering no servers. */
export function mcpStub(): McpService {
  return {
    toolSpecs: async () => [],
    execute: async (name: string) => { throw new Error(`unknown tool: ${name}`); },
  } as unknown as McpService;
}

/** WorkspacesService stub for TurnLoopService tests; records profile
 *  proposals so tests can assert on the consent flow. */
export function wsStub(): WorkspacesService & { proposals: unknown[] } {
  const proposals: unknown[] = [];
  const stub = {
    proposals,
    get: async (id: string) => ({ id, name: 'ws', color: '#fff', memory: '', profile: '', profilePending: '[]', quietHours: '', spendBudgetTokens: 0, spendMonth: '', spendTokens: 0, createdAt: '' }),
    addSpend: async () => {},
    addProfileProposal: async (_id: string, input: unknown) => {
      proposals.push(input);
      return 'Proposed. The user will review it before it enters the profile; do not assume it is remembered yet.';
    },
  };
  return stub as unknown as WorkspacesService & { proposals: unknown[] };
}

/** AgentsService stub for ChatsService / TurnLoopService tests; records
 *  self-maintenance tool calls so tests can assert on them. */
export function agentsStub(): AgentsService & { calls: Array<{ method: string; args: unknown[] }> } {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const stub = {
    calls,
    addFeedback: async () => ({ ok: true }),
    get: async (id: string) => ({ id, name: 'Stub Agent' }),
    updateDashboard: async (...args: unknown[]) => { calls.push({ method: 'updateDashboard', args }); return 'Dashboard updated.'; },
    saveApp: async (...args: unknown[]) => { calls.push({ method: 'saveApp', args }); return 'Mini app saved.'; },
    tasksForModel: async (...args: unknown[]) => { calls.push({ method: 'tasksForModel', args }); return 'The board is empty.'; },
    addTask: async (...args: unknown[]) => {
      calls.push({ method: 'addTask', args });
      return { id: 'task00000000', title: (args[1] as { title: string }).title, status: 'todo' };
    },
    updateTaskByPrefix: async (...args: unknown[]) => {
      calls.push({ method: 'updateTaskByPrefix', args });
      return { id: 'task00000000', title: 't', status: (args[2] as { status?: string }).status ?? 'todo' };
    },
    customToolSpecs: async () => [],
    addEvent: async (...args: unknown[]) => {
      calls.push({ method: 'addEvent', args });
      return { id: 'ev0000000000', ...(args[1] as object) };
    },
    saveCustomTool: async (...args: unknown[]) => { calls.push({ method: 'saveCustomTool', args }); return 'Tool proposed.'; },
    executeCustomTool: async () => { throw new Error('unknown tool'); },
  };
  return stub as unknown as AgentsService & { calls: Array<{ method: string; args: unknown[] }> };
}

/** Provider that plays one scripted event list per stream() call (per round). */
export class ScriptedProvider implements AiProvider {
  readonly name = 'scripted';
  readonly requests: AiRequest[] = [];
  private round = 0;

  constructor(private readonly rounds: AiStreamEvent[][]) {}

  async *stream(req: AiRequest): AsyncGenerator<AiStreamEvent> {
    this.requests.push(req);
    const events = this.rounds[this.round++] ?? [{ type: 'done' } as AiStreamEvent];
    for (const ev of events) yield ev;
  }
}
