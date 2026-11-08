/**
 * Automatic model selection in the UI (docs/agent-types.md "Model
 * selection"): the mode labels, how a decision reads on a run, and the
 * company's thresholds in plain words. Pure.
 */
import type { ModelDecision, ModelTierName } from './api';

export const MODEL_MODE_LABEL: Record<string, string> = {
  '': 'Inherit',
  auto: 'Auto (by task complexity)',
  fixed: 'Fixed model',
};

/** Short words for the mode switch. */
export const MODEL_MODE_SHORT: Record<string, string> = { '': 'Inherit', auto: 'Auto', fixed: 'Fixed' };

/** The one line that says what Auto does, everywhere it is offered. */
export const AUTO_ONE_LINE = 'Auto scores each task run and chat turn for complexity, risk and budget, then runs it on a cheap, standard or strong model.';
export const FIXED_ONE_LINE = 'Fixed runs every task and turn on the agent’s own model.';

export const TIER_LABEL: Record<ModelTierName, string> = { cheap: 'Cheap', standard: 'Standard', strong: 'Strong' };
export const TIER_HINT: Record<ModelTierName, string> = {
  cheap: 'Quick, simple work: triage, short replies, routine updates.',
  standard: 'Most work: the everyday default.',
  strong: 'Hard or risky work: synthesis, long briefs, releases, money, legal.',
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

/** A decision's reasons sorted for reading: what added to the complexity
 *  score ("+2 class synthesis"), the score line itself, and what moved the
 *  tier or picked the provider afterwards — in the server's order. Pure. */
export function splitReasons(d: Pick<ModelDecision, 'reasons'>): { signals: Array<{ n: number; text: string }>; scoreLine: string | null; adjustments: string[] } {
  const signals: Array<{ n: number; text: string }> = [];
  const adjustments: string[] = [];
  let scoreLine: string | null = null;
  for (const r of d.reasons) {
    const m = /^([+-]\d+) (?!tier)(.+)$/.exec(r);
    if (m && scoreLine === null) signals.push({ n: Number(m[1]), text: m[2] });
    else if (/^score -?\d+ →/.test(r)) scoreLine = r;
    else adjustments.push(r);
  }
  return { signals, scoreLine, adjustments };
}

const tierAt = (n: number | undefined): string => (['cheap', 'standard', 'strong'] as const)[Math.max(0, Math.min(2, Math.round(n ?? 0)))];
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** The company's model thresholds (`model.*` tunables) as plain sentences,
 *  each with the key it comes from. Pure. */
export function policyLines(p: Record<string, number>): Array<{ key: string; label: string; value: string }> {
  const out: Array<{ key: string; label: string; value: string }> = [];
  const has = (k: string) => typeof p[k] === 'number' && Number.isFinite(p[k]);
  if (has('cheapMaxScore')) out.push({ key: 'model.cheapMaxScore', label: 'Use the cheap model', value: `when the work scores ${p.cheapMaxScore} or less` });
  if (has('strongMinScore')) out.push({ key: 'model.strongMinScore', label: 'Use the strong model', value: `when the work scores ${p.strongMinScore} or more` });
  if (has('floorTier') || has('ceilingTier')) out.push({ key: 'model.floorTier · model.ceilingTier', label: 'Allowed range', value: `${tierAt(p.floorTier)} to ${tierAt(has('ceilingTier') ? p.ceilingTier : 2)}` });
  if (has('riskFloorTier')) out.push({ key: 'model.riskFloorTier', label: 'Risky work', value: `never below ${tierAt(p.riskFloorTier)} (releases, production, money, legal, customers)` });
  if (has('retryEscalateAfter')) out.push({ key: 'model.retryEscalateAfter', label: 'After failed attempts', value: `one tier up every ${plural(p.retryEscalateAfter, 'failed or reworked attempt')}` });
  if (has('historyMinRuns')) out.push({ key: 'model.historyMinRuns · historyDowngradeRate · historyEscalateRate', label: 'Track record', value: `after ${plural(p.historyMinRuns, 'run')} of a kind${has('historyDowngradeRate') ? `, ${Math.round(p.historyDowngradeRate * 100)}% success or more drops a tier` : ''}${has('historyEscalateRate') ? `, ${Math.round(p.historyEscalateRate * 100)}% or less raises one` : ''}` });
  if (has('budgetTightPct')) out.push({ key: 'model.budgetTightPct', label: 'Tight budget', value: `one tier down when less than ${p.budgetTightPct}% of the budget is left` });
  if (has('requestCap')) out.push({ key: 'model.requestCap', label: 'Agent requests', value: p.requestCap > 0 ? `an agent may move its own tier by up to ${plural(p.requestCap, 'step')}` : 'recorded, not applied' });
  return out;
}
