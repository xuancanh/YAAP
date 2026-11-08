/**
 * Model context windows (tokens), for auto-compaction (FR-7.3). A coarse
 * family table, deliberately conservative: when a model is unknown the
 * default assumes 128k. Matching is by substring on the lowercased model id,
 * first match wins, so more specific entries come first.
 */
const WINDOWS: Array<[RegExp, number]> = [
  [/gpt-4\.1|gemini-(1\.5|2|2\.5)|gemini/, 1_000_000],
  // GPT-6 (1.05M) and the Claude 5 family (1M). Claude 4.x keeps the
  // conservative 200k it always had here; Settings → compactionThresholdTokens
  // caps any of them lower.
  [/gpt-6/, 1_000_000],
  [/claude-(fable|mythos)|claude-(opus|sonnet|haiku)-5/, 1_000_000],
  [/gpt-5/, 400_000],
  [/claude|opus|sonnet|haiku|fable|mythos/, 200_000],
  [/o[134](-mini)?\b|gpt-4o|gpt-4-turbo/, 128_000],
  [/deepseek|kimi|moonshot|glm|qwen/, 128_000],
  [/llama|mistral|mixtral/, 128_000],
  [/^echo$/, 1_000_000],
];
export const DEFAULT_CONTEXT_WINDOW = 128_000;

export function contextWindowFor(model: string | null | undefined): number {
  const m = (model ?? '').toLowerCase();
  if (!m) return DEFAULT_CONTEXT_WINDOW;
  for (const [re, tokens] of WINDOWS) if (re.test(m)) return tokens;
  return DEFAULT_CONTEXT_WINDOW;
}
