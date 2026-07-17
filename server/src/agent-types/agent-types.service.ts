/**
 * AgentTypesService — reusable provider/model/persona presets (§9).
 * API keys are stored server-side and stripped from every response
 * (FR-13.3); clients only learn whether a key is set.
 */
import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { agentTypes } from '../database/schema';
import { newId, nowIso } from '../common/ids.util';

type AgentTypeRow = typeof agentTypes.$inferSelect;

const redact = ({ apiKey, ...rest }: AgentTypeRow) => ({ ...rest, hasApiKey: !!apiKey });

@Injectable()
export class AgentTypesService {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}

  async list() {
    const rows = await this.db.select().from(agentTypes);
    return rows.map(redact);
  }

  async create(input: { name: string; provider: string; model: string; models?: string[]; baseUrl?: string; apiKey?: string; persona?: string }) {
    const row = {
      id: newId(),
      name: input.name,
      provider: input.provider,
      model: input.model,
      models: JSON.stringify(input.models ?? []),
      baseUrl: input.baseUrl ?? null,
      apiKey: input.apiKey ?? null,
      persona: input.persona ?? '',
      enabled: 1,
      createdAt: nowIso(),
    };
    await this.db.insert(agentTypes).values(row);
    return redact(row);
  }

  async update(id: string, patch: Partial<{ name: string; provider: string; model: string; models: string[]; baseUrl: string; apiKey: string; persona: string; enabled: boolean }>) {
    const found = await this.resolve(id);
    if (!found) throw new NotFoundException(`agent type ${id}`);
    const set: Record<string, unknown> = { ...patch };
    if (patch.models) set.models = JSON.stringify(patch.models);
    if (patch.enabled !== undefined) set.enabled = patch.enabled ? 1 : 0;
    await this.db.update(agentTypes).set(set).where(eq(agentTypes.id, id));
    return redact((await this.resolve(id))!);
  }

  async remove(id: string) {
    await this.db.delete(agentTypes).where(eq(agentTypes.id, id));
    return { ok: true };
  }

  /** Server-internal: full row including the API key, for request-time use. */
  async resolve(id: string): Promise<AgentTypeRow | undefined> {
    const rows = await this.db.select().from(agentTypes).where(eq(agentTypes.id, id)).limit(1);
    return rows[0];
  }
}
