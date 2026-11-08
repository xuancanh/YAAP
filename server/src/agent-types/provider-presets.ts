/**
 * Provider presets (docs/agent-types.md "Default providers"): the agent
 * types YAAP knows how to set up out of the box, each with its default
 * model, the model list it starts with and a tier map (cheap / standard /
 * strong) for automatic model selection (docs/agent-types.md "Model
 * selection"). Pure data: the boot seeder (env keys), the account key
 * pane, Settings' quick add and the vendor-name guesses in
 * model-resolution.ts all read it, so one table says what "current" means.
 *
 * Model ids, checked Nov 2026:
 *  - Anthropic (Claude 5): Haiku 5.5 / Sonnet 5.5 / Opus 5.5, plus Fable 5.1
 *    for the hardest work (listed, not a tier default — it prices above
 *    Opus and behaves differently). platform.claude.com model overview.
 *  - OpenAI: gpt-6-luna (cost-sensitive, high volume) / gpt-6.1-sol
 *    (balance of intelligence and cost) / gpt-6-astra (flagship for complex
 *    reasoning and coding). developers.openai.com/api/docs/models.
 *  - DeepSeek: deepseek-flash / deepseek-v4-pro (api-docs.deepseek.com).
 * Older ids keep working: they stay priced (pricing.ts) and a type's own
 * list is what it serves.
 */
import type { Tier } from './model-resolution';

export interface ProviderPreset {
  provider: string;
  /** The name the type is created with. */
  name: string;
  /** The default model (= the standard tier unless the map says otherwise). */
  model: string;
  /** The list the type starts with; discovery replaces it. */
  models: string[];
  tierModels: Record<Tier, string>;
  /** The environment variable that seeds it at boot in single-user mode. */
  env?: string;
}

export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  anthropic: {
    provider: 'anthropic', name: 'Claude', env: 'ANTHROPIC_API_KEY',
    model: 'claude-sonnet-5-5',
    models: ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
    tierModels: { cheap: 'claude-haiku-5-5', standard: 'claude-sonnet-5-5', strong: 'claude-opus-5-5' },
  },
  openai: {
    provider: 'openai', name: 'OpenAI', env: 'OPENAI_API_KEY',
    model: 'gpt-6.1-sol',
    models: ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-astra', 'gpt-6-sol', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.1', 'gpt-5-mini'],
    tierModels: { cheap: 'gpt-6-luna', standard: 'gpt-6.1-sol', strong: 'gpt-6-astra' },
  },
  deepseek: {
    provider: 'deepseek', name: 'DeepSeek', env: 'DEEPSEEK_API_KEY',
    model: 'deepseek-flash',
    models: ['deepseek-flash', 'deepseek-v4-pro'],
    tierModels: { cheap: 'deepseek-flash', standard: 'deepseek-flash', strong: 'deepseek-v4-pro' },
  },
  gemini: {
    provider: 'gemini', name: 'Gemini',
    model: 'gemini-2.5-pro',
    models: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.5-flash-lite'],
    tierModels: { cheap: 'gemini-2.5-flash', standard: 'gemini-2.5-pro', strong: 'gemini-2.5-pro' },
  },
  kimi: {
    provider: 'kimi', name: 'Kimi',
    model: 'kimi-k2',
    models: ['kimi-k2', 'kimi-k2-thinking', 'kimi-k2-turbo-preview'],
    tierModels: { cheap: 'kimi-k2', standard: 'kimi-k2', strong: 'kimi-k2-thinking' },
  },
  glm: {
    provider: 'glm', name: 'GLM',
    model: 'glm-4.6',
    models: ['glm-4.5-air', 'glm-4.6', 'glm-4.5'],
    tierModels: { cheap: 'glm-4.5-air', standard: 'glm-4.6', strong: 'glm-4.6' },
  },
};

/** The preset of a provider name (anthropic-compatible and custom have none). */
export function presetFor(provider: string | null | undefined): ProviderPreset | undefined {
  return provider ? PROVIDER_PRESETS[provider] : undefined;
}

/** The preset of a vendor family (model-resolution's family names). */
export function presetForFamily(family: string | null | undefined): ProviderPreset | undefined {
  return family ? PROVIDER_PRESETS[family] : undefined;
}

/** The two providers YAAP supports by default (seeded from their env keys). */
export const DEFAULT_PROVIDERS = ['anthropic', 'openai'] as const;
