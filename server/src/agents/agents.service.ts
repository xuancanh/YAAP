/**
 * AgentsService — durable agent identities (§11): global persistent agents
 * with a charter, provider/model defaults, and an optional file-brain home
 * folder. The brain (LESSONS.md / JOURNAL.md / knowledge/) and mini apps are
 * follow-up work; this scaffold owns the profile CRUD and pending feedback.
 */
import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { agents } from '../database/schema';
import { newId, nowIso } from '../common/ids.util';

@Injectable()
export class AgentsService {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}

  list() {
    return this.db.select().from(agents);
  }

  async get(id: string) {
    const rows = await this.db.select().from(agents).where(eq(agents.id, id)).limit(1);
    if (!rows[0]) throw new NotFoundException(`agent ${id}`);
    return rows[0];
  }

  async create(input: { name: string; charter?: string; provider?: string; model?: string; homeDir?: string }) {
    const row = {
      id: newId(),
      name: input.name,
      charter: input.charter ?? '',
      provider: input.provider ?? 'anthropic',
      model: input.model ?? '',
      homeDir: input.homeDir ?? null,
      dashboard: '',
      loops: '[]',
      pendingFeedback: '[]',
      createdAt: nowIso(),
    };
    await this.db.insert(agents).values(row);
    return row;
  }

  async update(id: string, patch: Partial<{ name: string; charter: string; provider: string; model: string; homeDir: string; dashboard: string }>) {
    await this.get(id);
    await this.db.update(agents).set(patch).where(eq(agents.id, id));
    return this.get(id);
  }

  async remove(id: string) {
    await this.db.delete(agents).where(eq(agents.id, id));
    return { ok: true };
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
