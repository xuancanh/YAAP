import { describe, expect, it } from 'vitest';
import { capLine, ceilingPct, usageLine } from '../src/lib/account';

const base = { plan: 'hosted' as const, limits: { maxAgents: 0, maxLoops: 0, hostedKeys: true, hostedUsd: 15 }, usage: { month: '2026-11', tokensIn: 0, tokensOut: 0, usd: 4.5, hostedUsd: 3, turns: 9 } };

describe('ceilingPct', () => {
  it('is the hosted share of the ceiling, clamped, or null without a ceiling', () => {
    expect(ceilingPct(base)).toBe(20);
    expect(ceilingPct({ ...base, usage: { ...base.usage, hostedUsd: 40 } })).toBe(100);
    expect(ceilingPct({ ...base, limits: { ...base.limits, hostedUsd: 0 } })).toBeNull();
  });
});

describe('usageLine / capLine', () => {
  it('reads hosted dollars against the ceiling, else own-key dollars', () => {
    expect(usageLine(base)).toBe('$3.00 of $15.00 hosted this month');
    expect(usageLine({ ...base, plan: 'byo', limits: { ...base.limits, hostedUsd: 0 } })).toBe('$4.50 this month on your keys');
    expect(capLine(2, 3, 'agents')).toBe('2 of 3 agents');
    expect(capLine(2, 0, 'agents')).toBe('2 agents');
  });
});
