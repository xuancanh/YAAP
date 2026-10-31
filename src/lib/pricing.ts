/** Client-side price lookup over the merged table GET /api/usage/pricing
 *  returns, so dollars can sit next to a token meter without a round trip
 *  per chat. Same precedence as server/src/ai/pricing.ts minus the family
 *  regexes (the server's usage endpoints remain the source of truth for
 *  reports; this is the cheap estimate for live meters). */

export interface ModelPrice { input: number; output: number }
export type PriceTable = Record<string, ModelPrice>;

const SUFFIX = /(-(\d{8}|\d{4}-\d{2}-\d{2}|\d{4}|latest|preview|exp))+$/;
const normalize = (model: string): string => model.trim().toLowerCase().replace(/^models\//, '').replace(/^.*\//, '');

export function priceFor(model: string | null | undefined, table: PriceTable): ModelPrice | null {
  const id = normalize(model ?? '');
  if (!id) return null;
  if (table[id]) return table[id];
  const stripped = id.replace(SUFFIX, '');
  if (table[stripped]) return table[stripped];
  const prefix = Object.keys(table)
    .filter((k) => stripped.startsWith(`${k}-`) || stripped.startsWith(`${k}.`))
    .sort((a, b) => b.length - a.length)[0];
  return prefix ? table[prefix] : null;
}

export function usdFor(model: string | null | undefined, tokensIn: number, tokensOut: number, table: PriceTable): number | null {
  const price = priceFor(model, table);
  if (!price) return null;
  return (tokensIn * price.input + tokensOut * price.output) / 1_000_000;
}

/** "$0.0042" for pennies, "$1.23" otherwise, "—" for unpriced. */
export function fmtUsd(usd: number | null | undefined): string {
  if (usd === null || usd === undefined) return '—';
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 100) return `$${usd.toFixed(2)}`;
  return `$${Math.round(usd).toLocaleString()}`;
}
