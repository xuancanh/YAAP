/**
 * Model resolution per agent type (docs/agent-types.md "Models"). Pure: no
 * I/O, so the boot repair in the migrator, the creation paths and the turn
 * loop's self-heal all judge a model the same way.
 *
 * An agent type's known models are its `models` list (configured by the
 * owner, or replaced by the provider's own list on discovery) plus its
 * default `model`. When the list is empty nothing was configured or
 * discovered, so a model is judged by vendor family only: a claude-* model
 * on a type that is plainly DeepSeek is unknown, a model of no recognisable
 * family is given the benefit of the doubt.
 *
 * Picking a model for a new agent: the explicit model if the type knows it
 * (or the owner chose a custom id), else the tier's designated model on the
 * type, else — only for a type with no list of its own, or when the guess is
 * on the list — a vendor-name guess for the tier, else the type's default.
 */

import { PROVIDER_PRESETS } from './provider-presets';

export const TIERS = ['cheap', 'standard', 'strong'] as const;
export type Tier = typeof TIERS[number];

/** The fields of an agent type row the resolution reads. */
export interface ModelTypeLike {
  id?: string;
  name?: string;
  provider: string;
  model: string;
  models?: string | null;
  baseUrl?: string | null;
  tierModels?: string | null;
}

export function isTierName(v: unknown): v is Tier { return typeof v === 'string' && (TIERS as readonly string[]).includes(v); }

function strings(raw: string | null | undefined): string[] {
  try {
    const v = JSON.parse(raw || '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()) : [];
  } catch { return []; }
}

/** The type's own list (configured or discovered), without the default. */
export function configuredModels(t: ModelTypeLike): string[] { return [...new Set(strings(t.models))]; }

/** Every model the type knows: the default first, then the list. */
export function typeModels(t: ModelTypeLike): string[] {
  return [...new Set([t.model, ...configuredModels(t)].filter(Boolean))];
}

/** The owner's per-tier picks on the type. */
export function tierModelsOf(t: ModelTypeLike): Partial<Record<Tier, string>> {
  const out: Partial<Record<Tier, string>> = {};
  try {
    const v = JSON.parse(t.tierModels || '{}') as Record<string, unknown>;
    for (const k of TIERS) if (typeof v?.[k] === 'string' && (v[k] as string).trim()) out[k] = (v[k] as string).trim();
  } catch { /* malformed picks pick nothing */ }
  return out;
}

/** The vendor family a model id belongs to, by name; null when unrecognised. */
export function modelFamily(model: string): string | null {
  const m = model.trim().toLowerCase().replace(/^models\//, '');
  if (/^(anthropic\.)?claude/.test(m)) return 'anthropic';
  if (/^(gpt|chatgpt|o[1-9](-|$)|text-embedding|davinci)/.test(m)) return 'openai';
  if (/^deepseek/.test(m)) return 'deepseek';
  if (/^(gemini|gemma)/.test(m)) return 'gemini';
  if (/^(kimi|moonshot)/.test(m)) return 'kimi';
  if (/^(glm|chatglm)/.test(m)) return 'glm';
  return null;
}

function hostFamily(baseUrl: string | null | undefined): string | null {
  const host = (() => { try { return new URL(baseUrl ?? '').hostname; } catch { return ''; } })();
  if (!host) return null;
  if (host.endsWith('anthropic.com')) return 'anthropic';
  if (host.endsWith('openai.com')) return 'openai';
  if (host.endsWith('deepseek.com')) return 'deepseek';
  if (host.endsWith('googleapis.com')) return 'gemini';
  if (host.endsWith('moonshot.ai') || host.endsWith('moonshot.cn')) return 'kimi';
  if (host.endsWith('bigmodel.cn')) return 'glm';
  return null;
}

/** The vendor family a type serves: by provider name, then its endpoint's
 *  host, then its own default model's name. Null for a gateway nobody can
 *  place (custom endpoint, default of no known family). */
export function typeFamily(t: ModelTypeLike): string | null {
  return declaredFamily(t) ?? modelFamily(t.model);
}

/** The family a type is configured for — its endpoint's host, else its
 *  provider name — never its own default model's name. Null for a custom
 *  or compatible gateway nobody can place. */
export function declaredFamily(t: Pick<ModelTypeLike, 'provider' | 'baseUrl'>): string | null {
  const byProvider: Record<string, string> = { anthropic: 'anthropic', openai: 'openai', deepseek: 'deepseek', gemini: 'gemini', kimi: 'kimi', glm: 'glm' };
  // A named provider with a custom base URL is still judged by the URL first:
  // "openai" pointed at api.deepseek.com serves DeepSeek models.
  return hostFamily(t.baseUrl) ?? byProvider[t.provider] ?? null;
}

/** Whether the type serves `model` as far as anyone can tell. */
export function isKnownModel(t: ModelTypeLike, model: string): boolean {
  const m = model.trim();
  if (!m) return true; // '' = the type's default
  if (t.provider === 'echo') return true;
  if (m === t.model) return true;
  const list = configuredModels(t);
  if (list.length > 0) return list.includes(m);
  const tf = typeFamily(t);
  const mf = modelFamily(m);
  return !(tf && mf && tf !== mf);
}

/** Current vendor model names per family and tier — the last-resort guess
 *  when a type has no list of its own (and the no-type legacy path). One
 *  table with the provider presets (provider-presets.ts). */
const VENDOR_TIER_MODELS: Record<string, Partial<Record<Tier, string>>> = Object.fromEntries(
  Object.entries(PROVIDER_PRESETS).filter(([k]) => ['anthropic', 'openai', 'deepseek', 'gemini'].includes(k)).map(([k, p]) => [k, { ...p.tierModels }]),
);

export function vendorTierModel(family: string | null | undefined, tier: Tier): string | undefined {
  return family ? VENDOR_TIER_MODELS[family]?.[tier] : undefined;
}

/** The family a bare provider name implies (no agent type at hand). */
export function providerFamilyOf(provider: string): string | null {
  if (provider.startsWith('anthropic')) return 'anthropic';
  if (provider === 'openai') return 'openai';
  return ['deepseek', 'gemini', 'kimi', 'glm'].includes(provider) ? provider : null;
}

/** The model a tier resolves to on a type: the owner's designated model,
 *  else a vendor guess that is on the type's list (or any vendor guess when
 *  the type has no list), else the type's default. `standard` without a
 *  designation is the default. */
export function tierModelForType(t: ModelTypeLike, tier: Tier): string {
  const picked = tierModelsOf(t)[tier];
  if (picked && isKnownModel(t, picked)) return picked;
  if (tier !== 'standard') {
    const guess = vendorTierModel(typeFamily(t), tier);
    const list = configuredModels(t);
    if (guess && (list.length > 0 ? list.includes(guess) : modelFamily(guess) === typeFamily(t))) return guess;
  }
  return t.model;
}

/**
 * The model a new agent gets on type `t`: the explicit model when the type
 * knows it (or `custom`), else the tier's model, else the default. Without a
 * type (no agent types configured yet) the explicit model, else the vendor
 * guess for the tier by provider name, else '' (the runtime default).
 */
export function pickModel(t: ModelTypeLike | null | undefined, opts: { model?: string | null; tier?: string | null; custom?: boolean; provider?: string }): string {
  const model = (opts.model ?? '').trim();
  const tier = isTierName(opts.tier) ? opts.tier : null;
  if (!t) return model || (tier && tier !== 'standard' ? vendorTierModel(providerFamilyOf(opts.provider ?? 'anthropic'), tier) ?? '' : '');
  if (model && (opts.custom || isKnownModel(t, model))) return model;
  if (tier) return tierModelForType(t, tier);
  return t.model;
}

/** The refusal text for a model the type does not serve — names the list. */
export function unknownModelMessage(t: ModelTypeLike, model: string): string {
  const list = typeModels(t);
  return `model "${model}" is not served by agent type "${t.name ?? t.provider}" — available: ${list.join(', ') || '(none)'} (default ${t.model}). Refresh the type's models in Settings › Providers & agent types, or choose "custom model id" to use it anyway.`;
}

/**
 * A provider rejecting the model name (docs/agent-types.md "Self-heal").
 * Conservative: a 400/404/422 whose text names the model as the problem —
 * never a transient error, a key error, or a malformed tool call.
 */
export function isModelRejection(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  if (!/\b(400|404|422)\b/.test(msg)) return false;
  if (/api[ _-]?key|unauthori[sz]ed|authentication|permission|credit|quota|rate limit|context length|too many tokens|malformed tool/i.test(msg)) return false;
  return /model[_ ]not[_ ]found|invalid[_ ]model|unknown[_ ]model|unsupported[_ ]model|no such model|not a valid model|supported (api )?model names|model[^.]{0,80}(does not exist|not exist|is not supported|not supported|not available|not found|is invalid)|(does not exist|not supported|not found)[^.]{0,40}model/i.test(msg);
}
