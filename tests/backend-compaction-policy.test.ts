/** Auto-compaction policy (FR-7.3): a share of the model's context window by
 *  default, the app settings' on/off switch and percentage, an absolute
 *  override capped below the window, and the env fallback. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactionThreshold, DEFAULT_COMPACT_PCT } from '../server/src/chats/compaction.service';
import { contextWindowFor, DEFAULT_CONTEXT_WINDOW } from '../server/src/ai/context-windows';

test('context windows by model family, conservative default', () => {
  assert.equal(contextWindowFor('claude-sonnet-4-5'), 200_000);
  assert.equal(contextWindowFor('gpt-5.1'), 400_000);
  assert.equal(contextWindowFor('gpt-4o-mini'), 128_000);
  assert.equal(contextWindowFor('deepseek-chat'), 128_000);
  assert.equal(contextWindowFor('gemini-2.5-pro'), 1_000_000);
  assert.equal(contextWindowFor('some-new-model'), DEFAULT_CONTEXT_WINDOW);
  assert.equal(contextWindowFor(''), DEFAULT_CONTEXT_WINDOW);
});

test('default threshold is a share of the window; settings switch and percentage apply with bounds', () => {
  const d = compactionThreshold({}, 'deepseek-chat');
  assert.equal(d.enabled, true);
  assert.equal(d.pct, DEFAULT_COMPACT_PCT);
  assert.equal(d.tokens, Math.floor(128_000 * 0.7));
  assert.equal(compactionThreshold({ autoCompact: 'off' }, 'deepseek-chat').enabled, false);
  assert.equal(compactionThreshold({ compactionThresholdPct: '50' }, 'claude-opus-4-5').tokens, 100_000);
  assert.equal(compactionThreshold({ compactionThresholdPct: '5' }, 'claude-opus-4-5').pct, 30);
  assert.equal(compactionThreshold({ compactionThresholdPct: '99' }, 'claude-opus-4-5').pct, 95);
});

test('an absolute override wins but never exceeds 95% of the window; the env value only lowers the default', () => {
  assert.equal(compactionThreshold({ compactionThresholdTokens: '60000' }, 'claude-opus-4-5').tokens, 60_000);
  assert.equal(compactionThreshold({ compactionThresholdTokens: '900000' }, 'deepseek-chat').tokens, Math.floor(128_000 * 0.95));
  assert.equal(compactionThreshold({ compactionThresholdTokens: '0' }, 'deepseek-chat').tokens, Math.floor(128_000 * 0.7));
  // env 120k is above 70% of a 128k window, so the window share wins
  assert.equal(compactionThreshold({}, 'deepseek-chat', 120_000).tokens, Math.floor(128_000 * 0.7));
  // env 60k is lower, so it applies while no percentage was chosen in the app
  assert.equal(compactionThreshold({}, 'claude-opus-4-5', 60_000).tokens, 60_000);
  assert.equal(compactionThreshold({ compactionThresholdPct: '70' }, 'claude-opus-4-5', 60_000).tokens, 140_000);
});
