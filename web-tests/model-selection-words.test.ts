/** Automatic model selection in words (docs/agent-types.md "Model
 *  selection"): a decision's reasons split into what the score counted and
 *  what moved the tier after, and the company's thresholds in plain words. */
import { describe, expect, it } from 'vitest';
import { policyLines, splitReasons } from '../src/lib/model-selection';

describe('splitReasons', () => {
  it('separates the score\'s signals, the score line and the later adjustments', () => {
    const r = splitReasons({ reasons: ['+2 class synthesis', '-1 brief < 120 chars', 'score 1 → cheap (cheap ≤ 1, strong ≥ 6)', '+1 tier after 1 failed or reworked attempt(s)', '-1 tier: 20% of the envelope left (tight below 25%)', "the owner's preference: Claude"] });
    expect(r.signals).toEqual([{ n: 2, text: 'class synthesis' }, { n: -1, text: 'brief < 120 chars' }]);
    expect(r.scoreLine).toBe('score 1 → cheap (cheap ≤ 1, strong ≥ 6)');
    expect(r.adjustments).toEqual(['+1 tier after 1 failed or reworked attempt(s)', '-1 tier: 20% of the envelope left (tight below 25%)', "the owner's preference: Claude"]);
  });

  it('a chat decision with no score line keeps its signals', () => {
    const r = splitReasons({ reasons: ['+1 chat turn', 'risk floor standard'] });
    expect(r.signals).toHaveLength(1);
    expect(r.scoreLine).toBeNull();
    expect(r.adjustments).toEqual(['risk floor standard']);
  });
});

describe('policyLines', () => {
  it('reads every threshold as a plain sentence and keeps the key aside', () => {
    const lines = policyLines({ cheapMaxScore: 1, strongMinScore: 6, floorTier: 0, ceilingTier: 2, riskFloorTier: 1, retryEscalateAfter: 2, budgetTightPct: 20, historyDowngradeRate: 0.9, historyEscalateRate: 0.5, historyMinRuns: 5, requestCap: 0 });
    const by = Object.fromEntries(lines.map((l) => [l.label, l.value]));
    expect(by['Use the cheap model']).toBe('when the work scores 1 or less');
    expect(by['Allowed range']).toBe('cheap to strong');
    expect(by['Risky work']).toMatch(/^never below standard/);
    expect(by['After failed attempts']).toBe('one tier up every 2 failed or reworked attempts');
    expect(by['Track record']).toBe('after 5 runs of a kind, 90% success or more drops a tier, 50% or less raises one');
    expect(by['Agent requests']).toBe('recorded, not applied');
    expect(lines.find((l) => l.label === 'Tight budget')?.key).toBe('model.budgetTightPct');
  });

  it('skips what the policy does not carry', () => {
    expect(policyLines({ cheapMaxScore: 2 }).map((l) => l.label)).toEqual(['Use the cheap model']);
  });
});
