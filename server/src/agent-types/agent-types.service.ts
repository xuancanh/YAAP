/**
 * AgentTypesService — reusable provider/model/persona presets (§9).
 * API keys are stored server-side, sealed at rest via secretbox (AES-256-GCM
 * when TOKEN_ENCRYPTION_KEY is set, marked plaintext otherwise), and stripped
 * from every response (FR-13.3); clients only learn whether a key is set.
 * resolve() hands consumers the opened plaintext, as before.
 */
import { Injectable, Inject, NotFoundException, BadRequestException, Logger, OnApplicationBootstrap, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { agentTypes, appSettings } from '../database/schema';
import { OPENAI_COMPAT_BASE_URLS } from '../ai/openai-ai.provider';
import { configuredModels, isTierName, tierModelsOf, typeModels, vendorTierModel, typeFamily, TIERS, type Tier } from './model-resolution';
import { newId, nowIso } from '../common/ids.util';
import { DEFAULT_PROVIDERS, PROVIDER_PRESETS } from './provider-presets';
import { seal, open } from '../common/secretbox';
import { currentAccountId } from '../accounts/account-context';

type AgentTypeRow = typeof agentTypes.$inferSelect;

const redact = ({ apiKey, ...rest }: AgentTypeRow) => ({ ...rest, hasApiKey: !!apiKey });

/** How long a model-list fetch may take before discovery gives up. */
export const MODEL_DISCOVERY_TIMEOUT_MS = 8_000;

/** The model listing endpoint for a type, or null when its provider has none
 *  we can call (Echo; a custom type without a base URL). */
export function modelsEndpoint(t: Pick<AgentTypeRow, 'provider' | 'baseUrl'>): { url: string; kind: 'anthropic' | 'openai' } | null {
  const trim = (u: string) => u.replace(/\/+$/, '');
  if (t.provider === 'anthropic' || t.provider === 'anthropic-compatible') {
    return { url: `${trim(t.baseUrl || 'https://api.anthropic.com')}/v1/models?limit=1000`, kind: 'anthropic' };
  }
  if (t.provider === 'echo') return null;
  const base = t.baseUrl || OPENAI_COMPAT_BASE_URLS[t.provider] || '';
  return base ? { url: `${trim(base)}/models`, kind: 'openai' } : null;
}

/** Model ids from a listing response: `{ data: [{ id }] }` (OpenAI-shaped and
 *  Anthropic's), `{ models: [{ name | id }] }` (some gateways); Gemini's
 *  `models/` prefix stripped. Sorted, unique. */
export function parseModelList(body: unknown): string[] {
  const b = body as { data?: unknown; models?: unknown } | null;
  const rows = Array.isArray(b?.data) ? b.data : Array.isArray(b?.models) ? b.models : Array.isArray(body) ? body : [];
  const ids = (rows as unknown[]).map((r) => typeof r === 'string' ? r : (r as { id?: unknown; name?: unknown } | null)?.id ?? (r as { name?: unknown } | null)?.name)
    .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
    .map((x) => x.trim().replace(/^models\//, '').slice(0, 120));
  return [...new Set(ids)].sort();
}

@Injectable()
export class AgentTypesService implements OnApplicationBootstrap {
  private readonly logger = new Logger('AgentTypes');
  /** The fetch discovery uses; tests swap it for a stub. */
  fetchFn: typeof fetch = (...args) => fetch(...args);

  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb, @Optional() private readonly config?: ConfigService) {}

  /** Seed the default providers from the environment (single-user mode only). */
  async onApplicationBootstrap(): Promise<void> {
    if (!this.config || this.config.get<string>('authMode') !== 'single' || this.config.get<boolean>('seedProviderTypes') === false) return;
    const keys = this.config.get<Record<string, string>>('providerSeedKeys') ?? {};
    if (!Object.values(keys).some(Boolean)) return;
    await this.seedDefaults(keys).catch((err: unknown) => this.logger.warn(`seeding default agent types failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  async list() {
    const rows = await this.db.select().from(agentTypes);
    return rows.map(redact);
  }

  async create(input: { name: string; provider: string; model: string; models?: string[]; baseUrl?: string; apiKey?: string; persona?: string; tierModels?: Partial<Record<Tier, string | null>>; modelMode?: string }) {
    const row = {
      accountId: currentAccountId(),
      id: newId(),
      name: input.name,
      provider: input.provider,
      model: input.model,
      models: JSON.stringify(input.models ?? []),
      modelsFetchedAt: null as string | null,
      tierModels: '{}',
      modelMode: checkMode(input.modelMode),
      baseUrl: input.baseUrl ?? null,
      // No key given: inherit the account's existing key for this provider,
      // so the Account pane's one key per provider covers later presets too.
      apiKey: input.apiKey ? seal(input.apiKey) : await this.inheritedKey(input.provider),
      persona: input.persona ?? '',
      enabled: 1,
      createdAt: nowIso(),
    };
    if (input.tierModels) row.tierModels = JSON.stringify(checkTierModels(row, input.tierModels, {}));
    await this.db.insert(agentTypes).values(row);
    return redact(row);
  }

  async update(id: string, patch: Partial<{ name: string; provider: string; model: string; models: string[]; baseUrl: string; apiKey: string; persona: string; enabled: boolean; tierModels: Partial<Record<Tier, string | null>>; modelMode: string }>) {
    const found = await this.resolve(id);
    if (!found) throw new NotFoundException(`agent type ${id}`);
    const { tierModels: tierPatch, ...rest } = patch;
    const set: Record<string, unknown> = { ...rest };
    if (patch.models) set.models = JSON.stringify([...new Set(patch.models.filter((m) => typeof m === 'string' && m.trim()).map((m) => m.trim()))]);
    if (patch.model !== undefined) {
      set.model = patch.model.trim();
      if (!set.model) throw new BadRequestException('the default model cannot be empty');
    }
    // A changed provider or endpoint invalidates a discovered list.
    if ((patch.provider !== undefined && patch.provider !== found.provider) || (patch.baseUrl !== undefined && (patch.baseUrl || null) !== found.baseUrl)) set.modelsFetchedAt = null;
    const next = { ...found, ...(set.models !== undefined ? { models: set.models as string } : {}), ...(set.model !== undefined ? { model: set.model as string } : {}) };
    if (tierPatch) set.tierModels = JSON.stringify(checkTierModels(next, tierPatch, tierModelsOf(found)));
    if (patch.enabled !== undefined) set.enabled = patch.enabled ? 1 : 0;
    if (patch.modelMode !== undefined) set.modelMode = checkMode(patch.modelMode);
    // Seal keys at rest; re-sealing the (opened) existing key on any update
    // lazily upgrades legacy plaintext/plain: rows.
    if (patch.apiKey !== undefined) set.apiKey = patch.apiKey ? seal(patch.apiKey) : null;
    else if (found.apiKey) set.apiKey = seal(found.apiKey);
    await this.db.update(agentTypes).set(set).where(eq(agentTypes.id, id));
    return redact((await this.resolve(id))!);
  }

  /** The provider presets (docs/agent-types.md "Default providers"): what
   *  quick add creates, and which of them the account already has. */
  async presets() {
    const mine = await this.list();
    return Object.values(PROVIDER_PRESETS).map((p) => ({ ...p, env: undefined, existing: mine.filter((t) => t.provider === p.provider).map((t) => t.id), default: (DEFAULT_PROVIDERS as readonly string[]).includes(p.provider) }));
  }

  /** Quick add: a type from a provider preset — its default, list and tier
   *  map — with the key given, else the account's existing key for it. */
  async createFromPreset(provider: string, opts: { apiKey?: string; name?: string; modelMode?: string } = {}) {
    const p = PROVIDER_PRESETS[provider];
    if (!p) throw new BadRequestException(`no preset for provider "${provider}" — known: ${Object.keys(PROVIDER_PRESETS).join(', ')}`);
    return this.create({ name: opts.name?.trim() || p.name, provider: p.provider, model: p.model, models: p.models, tierModels: p.tierModels, apiKey: opts.apiKey || undefined, modelMode: opts.modelMode });
  }

  /**
   * Default providers at boot (single-user mode): for Claude and OpenAI —
   * and DeepSeek — whose key is in the environment (ANTHROPIC_API_KEY,
   * OPENAI_API_KEY, DEEPSEEK_API_KEY) and that the account has no type of
   * yet, create the preset type with that key (sealed). Existing types are
   * never touched. Returns the providers seeded.
   */
  async seedDefaults(env: Record<string, string | undefined> = process.env): Promise<string[]> {
    const mine = await this.list();
    const seeded: string[] = [];
    for (const p of Object.values(PROVIDER_PRESETS)) {
      const key = p.env ? (env[p.env] ?? '').trim() : '';
      if (!key || mine.some((t) => t.provider === p.provider)) continue;
      await this.createFromPreset(p.provider, { apiKey: key });
      seeded.push(p.provider);
    }
    if (seeded.length) this.logger.log(`seeded default agent types from the environment: ${seeded.join(', ')}`);
    return seeded;
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

  // ---- models (docs/agent-types.md "Models") ----

  /** What the type offers: its default, every known model, the per-tier
   *  picks, and when the list last came from the provider. */
  async models(id: string) {
    const t = await this.resolve(id);
    if (!t) throw new NotFoundException(`agent type ${id}`);
    return this.modelsView(t);
  }

  private modelsView(t: AgentTypeRow, extra: Record<string, unknown> = {}) {
    return {
      id: t.id, name: t.name, provider: t.provider,
      default: t.model,
      models: typeModels(t),
      tierModels: tierModelsOf(t),
      fetchedAt: t.modelsFetchedAt ?? null,
      discoverable: !!modelsEndpoint(t),
      ...extra,
    };
  }

  /** Fetch the provider's model list (GET {base}/models, Anthropic's
   *  GET /v1/models) with the type's own key — sent to that endpoint only,
   *  never followed through a redirect. Throws on any failure; never writes. */
  async discover(t: AgentTypeRow): Promise<string[]> {
    const ep = modelsEndpoint(t);
    if (!ep) throw new Error(t.provider === 'echo' ? 'the Echo provider has no model list' : 'this type has no base URL to ask for models');
    const key = t.apiKey ?? await this.resolveKeyForProvider(t.provider);
    const headers: Record<string, string> = ep.kind === 'anthropic'
      ? { 'anthropic-version': '2023-06-01', ...(key ? { 'x-api-key': key } : {}) }
      : key ? { authorization: `Bearer ${key}` } : {};
    const res = await this.fetchFn(ep.url, { method: 'GET', headers, signal: AbortSignal.timeout(MODEL_DISCOVERY_TIMEOUT_MS), redirect: 'error' });
    if (!res.ok) throw new Error(`${t.provider} ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    const list = parseModelList(await res.json());
    if (list.length === 0) throw new Error('the provider listed no models');
    return list;
  }

  /** Refresh the cached list from the provider. On success the list is
   *  replaced; a default the provider does not serve moves to one it does
   *  (the family's standard model when listed, else the first), and tier
   *  picks no longer listed are dropped. On failure the configured list
   *  stays and the error is returned, not thrown. */
  async refreshModels(id: string) {
    const t = await this.resolve(id);
    if (!t) throw new NotFoundException(`agent type ${id}`);
    let list: string[];
    try {
      list = await this.discover(t);
    } catch (err) {
      const error = err instanceof Error ? (err.name === 'TimeoutError' ? `timed out after ${MODEL_DISCOVERY_TIMEOUT_MS / 1000}s` : err.message) : String(err);
      this.logger.warn(`model discovery for ${t.name} failed: ${error}`);
      return this.modelsView(t, { ok: false, error });
    }
    const set: Partial<typeof agentTypes.$inferInsert> = { models: JSON.stringify(list), modelsFetchedAt: nowIso() };
    let defaultChanged: { from: string; to: string } | undefined;
    if (!list.includes(t.model)) {
      const standard = vendorTierModel(typeFamily(t), 'standard');
      const to = standard && list.includes(standard) ? standard : list[0];
      set.model = to;
      defaultChanged = { from: t.model, to };
    }
    const picks = tierModelsOf(t);
    const kept = Object.fromEntries(Object.entries(picks).filter(([, m]) => list.includes(m)));
    if (Object.keys(kept).length !== Object.keys(picks).length) set.tierModels = JSON.stringify(kept);
    await this.db.update(agentTypes).set(set).where(eq(agentTypes.id, id));
    const next = (await this.resolve(id))!;
    return this.modelsView(next, { ok: true, ...(defaultChanged ? { defaultChanged } : {}) });
  }

  /** The enabled type a new agent runs on (docs/agent-types.md "Which
   *  type"): the explicit type (refused when unknown or disabled), else an
   *  enabled type of the requested provider (the app default first), else
   *  the app default, else the first enabled type; undefined when none. */
  async creationType(opts: { agentTypeId?: string | null; provider?: string | null }): Promise<AgentTypeRow | undefined> {
    return resolveCreationType(this.db, opts);
  }

  /** Server-internal: full row with the API key opened to plaintext, for request-time use. */
  async resolve(id: string): Promise<AgentTypeRow | undefined> {
    const rows = await this.db.select().from(agentTypes).where(eq(agentTypes.id, id)).limit(1);
    const row = rows[0];
    return row ? { ...row, apiKey: row.apiKey ? open(row.apiKey) : null } : undefined;
  }
}

/** A type's model mode: '' (the workspace's) | auto | fixed. */
function checkMode(v: string | undefined | null): string {
  if (v === undefined || v === null || v === '') return '';
  if (v !== 'auto' && v !== 'fixed') throw new BadRequestException('modelMode must be auto, fixed or \'\' (inherit the workspace\'s)');
  return v;
}

/** Validate per-tier picks against the type's known models; null/'' unpins. */
function checkTierModels(t: Pick<AgentTypeRow, 'model' | 'models' | 'provider'>, patch: Partial<Record<string, string | null>>, current: Partial<Record<Tier, string>>): Partial<Record<Tier, string>> {
  const next: Partial<Record<Tier, string>> = { ...current };
  const known = typeModels(t);
  const listed = configuredModels(t).length > 0;
  for (const [k, v] of Object.entries(patch)) {
    if (!isTierName(k)) throw new BadRequestException(`"${k}" is not a tier (${TIERS.join(', ')})`);
    if (v === null || v === undefined || v === '') { delete next[k]; continue; }
    if (typeof v !== 'string') throw new BadRequestException(`model for ${k} must be a model id`);
    const m = v.trim();
    if (listed && !known.includes(m)) throw new BadRequestException(`"${m}" is not one of this type's models: ${known.join(', ')}`);
    next[k] = m.slice(0, 120);
  }
  return next;
}

/** See AgentTypesService.creationType; a function so AgentsService (which
 *  has the db, not this service) resolves the same way. */
export async function resolveCreationType(db: DrizzleDb, opts: { agentTypeId?: string | null; provider?: string | null }): Promise<AgentTypeRow | undefined> {
  const rows = (await db.select().from(agentTypes)).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const opened = (r: AgentTypeRow | undefined) => (r ? { ...r, apiKey: r.apiKey ? open(r.apiKey) : null } : undefined);
  if (opts.agentTypeId) {
    const own = rows.find((r) => r.id === opts.agentTypeId);
    if (!own) throw new BadRequestException('unknown agent type');
    if (!own.enabled) throw new BadRequestException(`agent type "${own.name}" is disabled`);
    return opened(own);
  }
  const enabled = rows.filter((r) => r.enabled === 1);
  if (enabled.length === 0) return undefined;
  const def = (await db.select().from(appSettings).where(eq(appSettings.key, 'defaultAgentTypeId')).limit(1))[0]?.value;
  const byProvider = opts.provider ? enabled.find((r) => r.provider === opts.provider && r.id === def) ?? enabled.find((r) => r.provider === opts.provider) : undefined;
  return opened(byProvider ?? enabled.find((r) => r.id === def) ?? enabled[0]);
}
