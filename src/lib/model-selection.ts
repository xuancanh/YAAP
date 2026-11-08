/**
 * Automatic model selection in the UI (docs/agent-types.md "Model
 * selection"): the mode labels and how a decision reads on a run.
 */
import type { ModelDecision } from './api';

export const MODEL_MODE_LABEL: Record<string, string> = {
  '': 'Inherit',
  auto: 'Auto (by task complexity)',
  fixed: 'Fixed model',
};

/** A run's decision from its JSON column ('' / malformed = none). */
export function parseDecisionJson(raw: string | null | undefined): ModelDecision | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as ModelDecision;
    return v && typeof v.tier === 'string' && typeof v.model === 'string' ? v : null;
  } catch { return null; }
}

/** "Auto · strong · claude-opus-5-5" — the short label of a decision. */
export function decisionLabel(d: ModelDecision): string {
  return `Auto · ${d.tier} · ${d.model}`;
}

/** The reasons, one per line, for a tooltip or a detail block. */
export function decisionReasons(d: ModelDecision): string {
  return [`score ${d.score}`, ...d.reasons].join('\n');
}
