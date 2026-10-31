import { describe, expect, it } from 'vitest';
import { priceFor, usdFor, fmtUsd } from '../src/lib/pricing';
import { workspaceSpend, fmtTokens } from '../src/lib/util';

const table = {
  'claude-sonnet-4-5': { input: 3, output: 15 },
  'gpt-4.1': { input: 2, output: 8 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
};

describe('client price lookup', () => {
  it('matches exact ids, dated releases, and the longest prefix', () => {
    expect(priceFor('claude-sonnet-4-5', table)).toEqual({ input: 3, output: 15 });
    expect(priceFor('claude-sonnet-4-5-20250929', table)).toEqual({ input: 3, output: 15 });
    expect(priceFor('gpt-4.1-mini-2025-04-14', table)).toEqual({ input: 0.4, output: 1.6 });
    expect(priceFor('openai/gpt-4.1', table)).toEqual({ input: 2, output: 8 });
    expect(priceFor('unknown-model', table)).toBeNull();
    expect(priceFor('', table)).toBeNull();
    expect(priceFor(undefined, table)).toBeNull();
  });

  it('turns tokens into dollars, null when unpriced', () => {
    expect(usdFor('claude-sonnet-4-5', 1_000_000, 1_000_000, table)).toBe(18);
    expect(usdFor('mystery', 10, 10, table)).toBeNull();
  });

  it('formats dollars for meters', () => {
    expect(fmtUsd(null)).toBe('—');
    expect(fmtUsd(0)).toBe('$0.00');
    expect(fmtUsd(0.0042)).toBe('$0.0042');
    expect(fmtUsd(1.234)).toBe('$1.23');
    expect(fmtUsd(1234.5)).toBe('$1,235');
  });
});

describe('workspace spend helpers', () => {
  it('reads the counter only for the current month and flags the stop', () => {
    const now = new Date('2026-10-31T12:00:00Z');
    expect(workspaceSpend({ spendBudgetTokens: 100, spendMonth: '2026-10', spendTokens: 100 }, now)).toEqual({ month: '2026-10', spentTokens: 100, budgetTokens: 100, over: true });
    expect(workspaceSpend({ spendBudgetTokens: 100, spendMonth: '2026-09', spendTokens: 100 }, now).spentTokens).toBe(0);
    expect(workspaceSpend({ spendBudgetTokens: 0, spendMonth: '2026-10', spendTokens: 999 }, now).over).toBe(false);
    expect(workspaceSpend(undefined, now).over).toBe(false);
  });

  it('abbreviates token counts', () => {
    expect(fmtTokens(999)).toBe('999');
    expect(fmtTokens(1234)).toBe('1.2k');
    expect(fmtTokens(2_500_000)).toBe('2.5M');
  });
});
