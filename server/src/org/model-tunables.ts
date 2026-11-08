/**
 * Model-selection tunables (docs/agent-types.md "Model selection",
 * docs/company-vision.md §7): where the complexity score crosses into the
 * cheap and strong tiers, the floor and ceiling tiers, the floor for risky
 * work, how soon a retry escalates, when a tight envelope downgrades, how
 * an agent's record at a class moves its tier, and how far an agent may
 * move its own tier on request. Registered on the shared registry so
 * `org_tune` and `PUT …/org/tunables` reach them; every starter company
 * derives them from its values and culture (`deriveModelTunables`) — a
 * rigour culture escalates sooner, a frugal one downgrades sooner. The
 * bounds are the safety floor: risky work never runs on the cheap tier.
 *
 * Tiers are numbers here (0 cheap, 1 standard, 2 strong) because tunables
 * are numeric; model-selection.ts maps them back.
 */
import { registerTunables, tunable, type TunableDef } from './org-tunables';
import type { ProfileDiagnosis } from './chief-os';

export const MODEL_TUNABLES: Record<string, TunableDef> = {
  'model.cheapMaxScore': { default: 1, min: 0, max: 6, area: 'capital', description: 'Automatic model selection: a task or message whose complexity score is at or below this runs on the cheap tier.' },
  'model.strongMinScore': { default: 6, min: 2, max: 14, area: 'capital', description: 'Automatic model selection: a complexity score at or above this runs on the strong tier.' },
  'model.floorTier': { default: 0, min: 0, max: 2, area: 'capital', description: 'The lowest tier automatic selection picks (0 cheap, 1 standard, 2 strong).' },
  'model.ceilingTier': { default: 2, min: 0, max: 2, area: 'capital', description: 'The highest tier automatic selection picks (0 cheap, 1 standard, 2 strong); risky work may still reach its own floor.' },
  'model.riskFloorTier': { default: 1, min: 1, max: 2, area: 'capital', description: 'The lowest tier for risky work (external or irreversible actions, money, one-way doors): 1 standard, 2 strong. Never cheap.' },
  'model.retryEscalateAfter': { default: 1, min: 1, max: 5, area: 'capital', description: 'Failed, no-progress or reworked attempts on a task before its next run escalates one tier (twice as many: two tiers).' },
  'model.budgetTightPct': { default: 20, min: 0, max: 80, area: 'capital', description: 'Percent of a capped envelope left below which automatic selection drops one tier (never below the risk floor).' },
  'model.historyDowngradeRate': { default: 0.9, min: 0.5, max: 1, area: 'capital', description: 'An agent whose recent runs of a task class succeed at least this often drops one tier for that class.' },
  'model.historyEscalateRate': { default: 0.5, min: 0, max: 0.9, area: 'capital', description: 'An agent whose recent runs of a task class succeed at most this often rises one tier for that class.' },
  'model.historyMinRuns': { default: 5, min: 2, max: 50, area: 'capital', description: 'Finished runs of a class (last 30 days) before the agent\'s record moves its tier.' },
  'model.requestCap': { default: 1, min: 0, max: 2, area: 'capital', description: 'How many tiers an agent may move its own run off the computed tier with request_model_tier (0 = requests are recorded, not applied).' },
};
registerTunables(MODEL_TUNABLES);

export function modelTunable(org: unknown, key: keyof typeof MODEL_TUNABLES): number {
  return tunable(org as { tunables?: string | null } | null, key);
}

const FRUGAL = /frugal|lean|thrift|cost[- ]?conscious|bootstrap|efficien|scrappy|do more with less/i;

/** The values → mechanism map for model selection. Pure; every value
 *  inside its bound. Rigour or a control culture escalates sooner and
 *  keeps risky work on the strong tier; frugality (a stated value, or an
 *  early company) downgrades sooner; an adhocracy lets agents move their
 *  own tier further. */
export function deriveModelTunables(d: Pick<ProfileDiagnosis, 'stage' | 'cultureType' | 'speed' | 'rigor' | 'values'>): Array<{ key: string; value: number; why: string }> {
  const { stage, cultureType: c, rigor } = d;
  const strict = rigor || c === 'hierarchy';
  const frugal = !strict && ((d.values ?? []).some((v) => FRUGAL.test(v)) || stage === 'early');
  return [
    { key: 'model.cheapMaxScore', value: strict ? 0 : frugal ? 2 : 1, why: strict ? 'rigour: only trivial work runs on the cheap tier' : frugal ? 'frugality: routine work runs on the cheap tier' : 'short, simple work runs on the cheap tier' },
    { key: 'model.strongMinScore', value: strict ? 5 : frugal ? 8 : 6, why: strict ? 'rigour: complex work reaches the strong tier early' : frugal ? 'frugality: the strong tier is kept for the hardest work' : 'complex, criteria-heavy work runs on the strong tier' },
    { key: 'model.floorTier', value: strict ? 1 : 0, why: strict ? 'a control culture: nothing runs below the standard tier' : 'the cheap tier is allowed for simple work' },
    { key: 'model.ceilingTier', value: 2, why: 'the strong tier stays available; the envelope and the score decide when' },
    { key: 'model.riskFloorTier', value: strict ? 2 : 1, why: strict ? 'external, irreversible and money work always runs on the strong tier' : 'risky work never runs below the standard tier' },
    { key: 'model.retryEscalateAfter', value: strict ? 1 : frugal ? 2 : 1, why: strict ? 'a failed attempt is retried one tier up' : frugal ? 'a task gets a second try on the same tier before it escalates' : 'a failed or reworked attempt is retried one tier up' },
    { key: 'model.budgetTightPct', value: frugal ? 35 : strict ? 10 : 20, why: frugal ? 'downgrade once a third of an envelope is left' : strict ? 'quality holds until the last tenth of an envelope' : 'downgrade when a fifth of an envelope is left' },
    { key: 'model.historyDowngradeRate', value: strict ? 0.97 : frugal ? 0.8 : 0.9, why: strict ? 'only a near-perfect record earns a cheaper model' : frugal ? 'a solid record at a class earns a cheaper model' : 'a strong record at a class earns a cheaper model' },
    { key: 'model.historyEscalateRate', value: strict ? 0.7 : frugal ? 0.4 : 0.5, why: strict ? 'a shaky record at a class earns a stronger model quickly' : 'a poor record at a class earns a stronger model' },
    { key: 'model.historyMinRuns', value: stage === 'early' ? 4 : 6, why: stage === 'early' ? 'a small company judges a record on a few runs' : 'a record counts after a handful of runs' },
    { key: 'model.requestCap', value: c === 'adhocracy' ? 2 : c === 'hierarchy' ? 0 : 1, why: c === 'adhocracy' ? 'agents choose their own model within the guardrails' : c === 'hierarchy' ? 'model requests are recorded for the chief, not applied' : 'an agent may move its own run one tier' },
  ].map((t) => { const def = MODEL_TUNABLES[t.key]; return { ...t, value: Math.min(def.max, Math.max(def.min, t.value)) }; });
}
