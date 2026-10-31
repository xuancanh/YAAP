/**
 * Per-model USD prices — list prices, Oct 2026, override in Settings → Usage
 * (`pricingOverrides`, JSON { "<model id>": { input, output } }).
 *
 * Both numbers are dollars per million tokens, input (prompt) and output
 * (completion). Cache reads/writes, batch discounts, and long-context tiers
 * are deliberately not modelled: the point is to make an always-on agent's
 * bill visible before it arrives, not to reconcile an invoice. Treat the
 * result as an estimate and keep the override hatch for the models (and
 * gateways) this table cannot know about.
 *
 * Lookup order (see `priceFor`): exact id → id without a date suffix → the
 * longest table key the id starts with → the model family. Unknown models
 * price as null, and the UI shows them as unpriced rather than as $0.
 */

export interface ModelPrice {
  /** USD per million input tokens. */
  input: number;
  /** USD per million output tokens. */
  output: number;
}

export type PriceTable = Record<string, ModelPrice>;

const p = (input: number, output: number): ModelPrice => ({ input, output });

export const LIST_PRICES: PriceTable = {
  // --- Anthropic ---
  'claude-opus-4-5': p(5, 25),
  'claude-opus-4-1': p(15, 75),
  'claude-opus-4': p(15, 75),
  'claude-sonnet-4-5': p(3, 15),
  'claude-sonnet-4': p(3, 15),
  'claude-haiku-4-5': p(1, 5),
  'claude-3-7-sonnet': p(3, 15),
  'claude-3-5-sonnet': p(3, 15),
  'claude-3-5-haiku': p(0.8, 4),
  'claude-3-haiku': p(0.25, 1.25),
  // --- OpenAI ---
  'gpt-5.1': p(1.25, 10),
  'gpt-5': p(1.25, 10),
  'gpt-5-mini': p(0.25, 2),
  'gpt-5-nano': p(0.05, 0.4),
  'gpt-4.1': p(2, 8),
  'gpt-4.1-mini': p(0.4, 1.6),
  'gpt-4.1-nano': p(0.1, 0.4),
  'gpt-4o': p(2.5, 10),
  'gpt-4o-mini': p(0.15, 0.6),
  'o3': p(2, 8),
  'o3-mini': p(1.1, 4.4),
  'o4-mini': p(1.1, 4.4),
  // --- DeepSeek ---
  'deepseek-chat': p(0.28, 0.42),
  'deepseek-reasoner': p(0.28, 0.42),
  // --- Kimi (Moonshot) ---
  'kimi-k2-thinking': p(0.6, 2.5),
  'kimi-k2-turbo-preview': p(1.15, 8),
  'kimi-k2': p(0.6, 2.5),
  'moonshot-v1-8k': p(0.2, 2),
  'moonshot-v1-32k': p(1, 3),
  'moonshot-v1-128k': p(2, 5),
  // --- GLM (Zhipu) ---
  'glm-4.6': p(0.6, 2.2),
  'glm-4.5': p(0.6, 2.2),
  'glm-4.5-air': p(0.2, 1.1),
  'glm-4.5-flash': p(0, 0),
  // --- Gemini ---
  'gemini-2.5-pro': p(1.25, 10),
  'gemini-2.5-flash': p(0.3, 2.5),
  'gemini-2.5-flash-lite': p(0.1, 0.4),
  'gemini-2.0-flash': p(0.1, 0.4),
  'gemini-2.0-flash-lite': p(0.075, 0.3),
  // --- the Echo dev provider costs nothing ---
  'echo': p(0, 0),
};

/** Family fallbacks for ids the table does not list (a new dated release,
 *  a gateway alias). Checked after exact and prefix matches, in this order. */
const FAMILY_PRICES: Array<[RegExp, ModelPrice]> = [
  [/^claude-opus/, p(5, 25)],
  [/^claude-sonnet|^claude-3-\d-sonnet/, p(3, 15)],
  [/^claude-haiku|^claude-3-\d-haiku/, p(1, 5)],
  [/^gpt-5.*-nano/, p(0.05, 0.4)],
  [/^gpt-5.*-mini/, p(0.25, 2)],
  [/^gpt-5/, p(1.25, 10)],
  [/^gpt-4\.1-nano/, p(0.1, 0.4)],
  [/^gpt-4\.1-mini/, p(0.4, 1.6)],
  [/^gpt-4\.1/, p(2, 8)],
  [/^gpt-4o-mini/, p(0.15, 0.6)],
  [/^gpt-4o/, p(2.5, 10)],
  [/^o\d-mini/, p(1.1, 4.4)],
  [/^o\d/, p(2, 8)],
  [/^deepseek/, p(0.28, 0.42)],
  [/^kimi/, p(0.6, 2.5)],
  [/^glm-.*-flash/, p(0, 0)],
  [/^glm-.*-air/, p(0.2, 1.1)],
  [/^glm/, p(0.6, 2.2)],
  [/^gemini-.*-flash-lite/, p(0.1, 0.4)],
  [/^gemini-.*-flash/, p(0.3, 2.5)],
  [/^gemini-.*-pro/, p(1.25, 10)],
];

/** Trailing release stamps: -20250514, -2025-05-14, -0905, -latest, -preview. */
const SUFFIX = /(-(\d{8}|\d{4}-\d{2}-\d{2}|\d{4}|latest|preview|exp))+$/;

const normalize = (model: string): string =>
  model.trim().toLowerCase().replace(/^models\//, '').replace(/^.*\//, '');

/** Parse the `pricingOverrides` setting defensively: a malformed override
 *  must not take the whole usage page down, so bad entries are dropped. */
export function parsePriceOverrides(raw: string | null | undefined): PriceTable {
  if (!raw || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: PriceTable = {};
    for (const [model, value] of Object.entries(parsed ?? {})) {
      const v = value as Partial<ModelPrice> | null;
      if (v && typeof v.input === 'number' && typeof v.output === 'number' && v.input >= 0 && v.output >= 0) {
        out[normalize(model)] = { input: v.input, output: v.output };
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** The list table with overrides merged over it. */
export function mergedPriceTable(overrides: PriceTable = {}): PriceTable {
  return { ...LIST_PRICES, ...overrides };
}

export function priceFor(model: string, overrides: PriceTable = {}): ModelPrice | null {
  const id = normalize(model);
  if (!id) return null;
  const table = mergedPriceTable(overrides);
  if (table[id]) return table[id];
  const stripped = id.replace(SUFFIX, '');
  if (table[stripped]) return table[stripped];
  // Longest prefix wins so gpt-4.1-mini-2025-04-14 lands on gpt-4.1-mini, not gpt-4.1.
  const prefix = Object.keys(table)
    .filter((k) => stripped.startsWith(`${k}-`) || stripped.startsWith(`${k}.`))
    .sort((a, b) => b.length - a.length)[0];
  if (prefix) return table[prefix];
  for (const [re, price] of FAMILY_PRICES) if (re.test(stripped)) return price;
  return null;
}

/** USD for a token count at a model's rate; null when the model is unknown. */
export function usdFor(model: string, tokensIn: number, tokensOut: number, overrides: PriceTable = {}): number | null {
  const price = priceFor(model, overrides);
  if (!price) return null;
  return (tokensIn * price.input + tokensOut * price.output) / 1_000_000;
}
