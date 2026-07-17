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

  list() {
    return this.db.select().from(agentTypes).all().map(redact);
  }

  create(input: { name: string; provider: string; model: string; models?: string[]; baseUrl?: string; apiKey?: string; persona?: string }) {
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
    this.db.insert(agentTypes).values(row).run();
    return redact(row);
  }

  update(id: string, patch: Partial<{ name: string; provider: string; model: string; models: string[]; baseUrl: string; apiKey: string; persona: string; enabled: boolean }>) {
    const found = this.db.select().from(agentTypes).where(eq(agentTypes.id, id)).get();
    if (!found) throw new NotFoundException(`agent type ${id}`);
    const set: Record<string, unknown> = { ...patch };
    if (patch.models) set.models = JSON.stringify(patch.models);
    if (patch.enabled !== undefined) set.enabled = patch.enabled ? 1 : 0;
    this.db.update(agentTypes).set(set).where(eq(agentTypes.id, id)).run();
    return redact(this.db.select().from(agentTypes).where(eq(agentTypes.id, id)).get()!);
  }

  remove(id: string) {
    this.db.delete(agentTypes).where(eq(agentTypes.id, id)).run();
    return { ok: true };
  }

  /** Server-internal: full row including the API key, for request-time use. */
  resolve(id: string): AgentTypeRow | undefined {
    return this.db.select().from(agentTypes).where(eq(agentTypes.id, id)).get();
  }
}
