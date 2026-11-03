/** Models of an agent type, client side (docs/agent-types.md "Models"):
 *  the same list the server judges by — the default first, then the type's
 *  configured or discovered models. */
import type { AgentType, ModelTierName } from './api';

export const MODEL_TIERS: ModelTierName[] = ['cheap', 'standard', 'strong'];

function strings(raw: string | null | undefined): string[] {
  try {
    const v = JSON.parse(raw || '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];
  } catch { return []; }
}

/** Every model the type knows, its default first. */
export function typeModelList(t: Pick<AgentType, 'model' | 'models'> | null | undefined): string[] {
  if (!t) return [];
  return [...new Set([t.model, ...strings(t.models)].filter(Boolean))];
}

/** The owner's per-tier picks on the type. */
export function typeTierModels(t: Pick<AgentType, 'tierModels'> | null | undefined): Partial<Record<ModelTierName, string>> {
  try {
    const v = JSON.parse(t?.tierModels || '{}') as Record<string, unknown>;
    const out: Partial<Record<ModelTierName, string>> = {};
    for (const k of MODEL_TIERS) if (typeof v?.[k] === 'string' && v[k]) out[k] = v[k] as string;
    return out;
  } catch { return {}; }
}

/** The type an agent runs on when none is pinned — the server's order
 *  (TurnContextService.typeFor): an enabled type of the agent's provider
 *  (the default first), the default, the first enabled. */
export function effectiveType(types: AgentType[], agent: { agentTypeId?: string | null; provider: string }, defaultId?: string): AgentType | null {
  const enabled = types.filter((t) => t.enabled);
  const own = agent.agentTypeId ? enabled.find((t) => t.id === agent.agentTypeId) : undefined;
  if (own) return own;
  return enabled.find((t) => t.provider === agent.provider && t.id === defaultId)
    ?? enabled.find((t) => t.provider === agent.provider)
    ?? enabled.find((t) => t.id === defaultId)
    ?? enabled[0]
    ?? null;
}

/** "fetched 3h ago" / "configured by hand". */
export function fetchedLabel(at: string | null | undefined, now = Date.now()): string {
  if (!at) return 'configured by hand — not fetched from the provider yet';
  const mins = Math.max(0, Math.round((now - Date.parse(at)) / 60_000));
  if (mins < 1) return 'fetched from the provider just now';
  if (mins < 60) return `fetched from the provider ${mins}m ago`;
  const h = Math.round(mins / 60);
  return h < 48 ? `fetched from the provider ${h}h ago` : `fetched from the provider ${Math.round(h / 24)}d ago`;
}
