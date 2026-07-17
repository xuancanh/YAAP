/**
 * AgentsService — durable agent identities (§11): global persistent agents
 * with a charter, provider/model defaults, and an optional file-brain home
 * folder. The brain (LESSONS.md / JOURNAL.md / knowledge/) and mini apps are
 * follow-up work; this scaffold owns the profile CRUD and pending feedback.
 */
import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { eq, inArray } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { agents, chatSessions, chatTurns } from '../database/schema';
import { newId, nowIso } from '../common/ids.util';
import { StorageService } from '../storage/storage.service';
import { agentFileKey, agentPrefix } from '../storage/storage.keys';

@Injectable()
export class AgentsService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly storage: StorageService,
  ) {}

  list() {
    return this.db.select().from(agents);
  }

  async get(id: string) {
    const rows = await this.db.select().from(agents).where(eq(agents.id, id)).limit(1);
    if (!rows[0]) throw new NotFoundException(`agent ${id}`);
    return rows[0];
  }

  async create(input: { name: string; charter?: string; provider?: string; model?: string; homeDir?: string; emoji?: string; colors?: [string, string]; role?: string; loops?: unknown[] }) {
    const id = newId();
    const row = {
      id,
      name: input.name,
      emoji: input.emoji ?? '\u{1F916}',
      colors: JSON.stringify(input.colors ?? ['#8b8cf0', '#5cc2f2']),
      role: input.role ?? '',
      charter: input.charter ?? '',
      provider: input.provider ?? 'anthropic',
      model: input.model ?? '',
      homeDir: input.homeDir ?? `agents/${id}`,
      dashboard: '',
      loops: JSON.stringify(input.loops ?? []),
      pendingFeedback: '[]',
      createdAt: nowIso(),
    };
    await this.db.insert(agents).values(row);
    await this.seedBrain(row.id, row.name);
    return row;
  }

  /** Seed the transparent file brain (FR-11.3) so the fs view has structure
   *  from day one. */
  private async seedBrain(id: string, name: string): Promise<void> {
    const files: Array<[string, string]> = [
      ['LESSONS.md', `# LESSONS.md\n\n${name} has not recorded lessons yet.\nCompleted work distills into size-bounded appends here.\n`],
      ['JOURNAL.md', `# JOURNAL.md\n\nFreshly created. The journal fills as ${name} completes scheduled and interactive work.\n`],
      ['knowledge/README.md', `# knowledge/\n\nUser- and agent-maintained reference files live here.\n`],
    ];
    for (const [path, content] of files) {
      await this.storage.put(agentFileKey(id, path), Buffer.from(content, 'utf8'), 'text/markdown').catch(() => {});
    }
  }

  async update(id: string, patch: Partial<{ name: string; charter: string; provider: string; model: string; homeDir: string; dashboard: string }>) {
    await this.get(id);
    await this.db.update(agents).set(patch).where(eq(agents.id, id));
    return this.get(id);
  }

  async remove(id: string) {
    await this.db.delete(agents).where(eq(agents.id, id));
    await this.storage.deletePrefix(agentPrefix(id)).catch(() => {});
    return { ok: true };
  }

  /** Chats owned + 👍/👎 totals across this agent's sessions (agent home). */
  async stats(id: string) {
    await this.get(id);
    const sessions = await this.db.select({ id: chatSessions.id }).from(chatSessions)
      .where(eq(chatSessions.agentId, id));
    const ids = sessions.map((s) => s.id);
    let up = 0; let down = 0;
    if (ids.length > 0) {
      const turns = await this.db.select({ rating: chatTurns.rating }).from(chatTurns)
        .where(inArray(chatTurns.sessionId, ids));
      for (const t of turns) {
        if (t.rating === 'up') up++;
        if (t.rating === 'down') down++;
      }
    }
    const rating = up + down > 0 ? Math.round((up / (up + down)) * 100) : null;
    return { chats: ids.length, up, down, rating };
  }

  /** AGENT.json export: profile, loops, dashboard (FR-11.7). */
  async exportJson(id: string) {
    const a = await this.get(id);
    return {
      name: a.name, emoji: a.emoji, colors: JSON.parse(a.colors), role: a.role,
      charter: a.charter, provider: a.provider, model: a.model,
      loops: JSON.parse(a.loops), dashboard: a.dashboard,
    };
  }

  /** Record a 👍/👎 on a turn owned by this agent; surfaced to the model on
   *  its next reply, then cleared (FR-6.5). */
  async addFeedback(id: string, feedback: { rating: 'up' | 'down'; note?: string; turnId: string }) {
    const agent = await this.get(id);
    const pending = JSON.parse(agent.pendingFeedback) as unknown[];
    pending.push({ ...feedback, at: nowIso() });
    await this.db.update(agents).set({ pendingFeedback: JSON.stringify(pending) }).where(eq(agents.id, id));
    return { ok: true };
  }

  /** Drain pending feedback for injection into the agent's next turn. */
  async takeFeedback(id: string): Promise<unknown[]> {
    const agent = await this.get(id);
    const pending = JSON.parse(agent.pendingFeedback) as unknown[];
    if (pending.length > 0) {
      await this.db.update(agents).set({ pendingFeedback: '[]' }).where(eq(agents.id, id));
    }
    return pending;
  }
}
