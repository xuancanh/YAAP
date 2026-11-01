/**
 * AgentTypesService — reusable provider/model/persona presets (§9).
 * API keys are stored server-side, sealed at rest via secretbox (AES-256-GCM
 * when TOKEN_ENCRYPTION_KEY is set, marked plaintext otherwise), and stripped
 * from every response (FR-13.3); clients only learn whether a key is set.
 * resolve() hands consumers the opened plaintext, as before.
 */
import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { agentTypes } from '../database/schema';
import { newId, nowIso } from '../common/ids.util';
import { seal, open } from '../common/secretbox';
import { currentAccountId } from '../accounts/account-context';

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
      accountId: currentAccountId(),
      id: newId(),
      name: input.name,
      provider: input.provider,
      model: input.model,
      models: JSON.stringify(input.models ?? []),
      baseUrl: input.baseUrl ?? null,
      // No key given: inherit the account's existing key for this provider,
      // so the Account pane's one key per provider covers later presets too.
      apiKey: input.apiKey ? seal(input.apiKey) : await this.inheritedKey(input.provider),
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
    // Seal keys at rest; re-sealing the (opened) existing key on any update
    // lazily upgrades legacy plaintext/plain: rows.
    if (patch.apiKey !== undefined) set.apiKey = patch.apiKey ? seal(patch.apiKey) : null;
    else if (found.apiKey) set.apiKey = seal(found.apiKey);
    await this.db.update(agentTypes).set(set).where(eq(agentTypes.id, id));
    return redact((await this.resolve(id))!);
  }

  async remove(id: string) {
    await this.db.delete(agentTypes).where(eq(agentTypes.id, id));
    return { ok: true };
  }

  /** The sealed key a new preset of `provider` starts with: the account's
   *  existing key for that provider, re-sealed, or null. */
  private async inheritedKey(provider: string): Promise<string | null> {
    const key = await this.resolveKeyForProvider(provider);
    return key ? seal(key) : null;
  }

  /** Server-internal: the opened key of the first enabled agent type of a
   *  provider that has one (voice transcription/TTS borrow the OpenAI key
   *  when no dedicated TRANSCRIPTION_API_KEY is set). Null when none. */
  async resolveKeyForProvider(provider: string): Promise<string | null> {
    const rows = await this.db.select().from(agentTypes).where(eq(agentTypes.provider, provider));
    const row = rows.find((r) => r.apiKey && r.enabled === 1) ?? rows.find((r) => r.apiKey);
    return row?.apiKey ? open(row.apiKey) : null;
  }

  /** Server-internal: full row with the API key opened to plaintext, for request-time use. */
  async resolve(id: string): Promise<AgentTypeRow | undefined> {
    const rows = await this.db.select().from(agentTypes).where(eq(agentTypes.id, id)).limit(1);
    const row = rows[0];
    return row ? { ...row, apiKey: row.apiKey ? open(row.apiKey) : null } : undefined;
  }
}
