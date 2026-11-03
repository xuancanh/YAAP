/**
 * Model routing by task class (docs/company-vision.md §7, execution-plan
 * item 23). The organization row carries `routing`, a JSON map
 *
 *   { classes: { <class>: cheap | standard | strong }, models: { <tier>: <model id> } }
 *
 * read through `parseRouting`. A run picks its model from the task's class
 * when a routing entry exists and the agent has no model pinned by the CEO
 * (`agents.model`); the pin always wins. Tiers resolve to model ids with the
 * agent type the agent runs on (docs/agent-types.md "Which model"): the
 * CEO's pinned tier model when the type serves it, else the owner's
 * designated tier model on the type, else the type's default (`standard` is
 * the session's own model). Only without a type — no agent types configured
 * — does the vendor-name guess by provider apply (`cheap` is
 * `cheapestModelFor`, `strong` the family's strong model). Pure: no I/O.
 */
import { cheapestModelFor } from '../review/action-review.service';
import { isKnownModel, providerFamilyOf, tierModelForType, vendorTierModel, type ModelTypeLike } from '../agent-types/model-resolution';

export const MODEL_TIERS = ['cheap', 'standard', 'strong'] as const;
export type ModelTier = typeof MODEL_TIERS[number];

export interface OrgRouting {
  classes: Record<string, ModelTier>;
  models: Partial<Record<ModelTier, string>>;
}

export function parseRouting(raw: string | null | undefined): OrgRouting {
  const out: OrgRouting = { classes: {}, models: {} };
  try {
    const v = JSON.parse(raw || '{}') as { classes?: Record<string, unknown>; models?: Record<string, unknown> };
    for (const [k, t] of Object.entries(v?.classes ?? {})) if (isTier(t) && isClass(k)) out.classes[k] = t;
    for (const [k, m] of Object.entries(v?.models ?? {})) if (isTier(k) && typeof m === 'string' && m.trim()) out.models[k] = m.trim().slice(0, 80);
  } catch { /* malformed routing routes nothing */ }
  return out;
}

export function isTier(v: unknown): v is ModelTier { return typeof v === 'string' && (MODEL_TIERS as readonly string[]).includes(v); }
/** A class is a short lowercase slug (the six named ones or another the brief names). */
export function isClass(v: unknown): v is string { return typeof v === 'string' && /^[a-z][a-z0-9_-]{0,23}$/.test(v); }

/** The model a run should use for a task class, or null when no entry
 *  routes that class (the session's own model then applies). */
export function resolveRoute(routing: OrgRouting, cls: string, agent: { provider: string; model: string }, defaultModel: string, baseUrl?: string, type?: ModelTypeLike | null): { tier: ModelTier; model: string } | null {
  const tier = routing.classes[cls];
  if (!tier) return null;
  return { tier, model: tierModel(routing, tier, agent.provider, defaultModel, baseUrl, type) };
}

/** The model a tier resolves to. With the agent's type: a pinned tier model
 *  the type serves, else the type's tier model (`standard`: `defaultModel`
 *  when set). Without one: the pin, else the vendor guess by provider. */
export function tierModel(routing: OrgRouting, tier: ModelTier, provider: string, defaultModel: string, baseUrl?: string, type?: ModelTypeLike | null): string {
  const pinned = routing.models[tier];
  if (type) {
    if (pinned && isKnownModel(type, pinned)) return pinned;
    if (tier === 'standard' && defaultModel && isKnownModel(type, defaultModel)) return defaultModel;
    return tierModelForType(type, tier);
  }
  if (pinned) return pinned;
  if (tier === 'cheap') return cheapestModelFor(provider, baseUrl, defaultModel) || defaultModel;
  if (tier === 'strong') return vendorTierModel(providerFamilyOf(provider), 'strong') ?? defaultModel;
  return defaultModel;
}

/** Merge a patch into a routing map: a class set to null is removed, a tier model set to null is unpinned. */
export function mergeRouting(current: OrgRouting, patch: { classes?: Record<string, unknown>; models?: Record<string, unknown> }): OrgRouting {
  const next: OrgRouting = { classes: { ...current.classes }, models: { ...current.models } };
  for (const [k, t] of Object.entries(patch.classes ?? {})) {
    if (!isClass(k)) throw new Error(`"${k}" is not a task class (lowercase slug, e.g. triage, research, synthesis, review, ops, general)`);
    if (t === null || t === '') { delete next.classes[k]; continue; }
    if (!isTier(t)) throw new Error(`tier for ${k} must be one of ${MODEL_TIERS.join(', ')}`);
    next.classes[k] = t;
  }
  for (const [k, m] of Object.entries(patch.models ?? {})) {
    if (!isTier(k)) throw new Error(`"${k}" is not a tier (${MODEL_TIERS.join(', ')})`);
    if (m === null || m === '') { delete next.models[k]; continue; }
    if (typeof m !== 'string') throw new Error(`model for ${k} must be a model id`);
    next.models[k] = m.trim().slice(0, 80);
  }
  return next;
}

export function describeRouting(r: OrgRouting): string {
  const classes = Object.entries(r.classes).map(([c, t]) => `${c} → ${t}`).join(', ') || 'none (every class runs on its agent\'s model)';
  const models = Object.entries(r.models).map(([t, m]) => `${t}=${m}`).join(', ');
  return `Routing: ${classes}${models ? `; pinned tier models: ${models}` : ''}.`;
}
