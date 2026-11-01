import { describe, expect, it } from 'vitest';
import { flagCount, fmtInstalls, installSummary, loadPublisherName, ratingLabel, savePublisherName } from '../src/lib/registry';

const caps = { tools: [], connections: [], loops: [], skills: [], apps: [] };

describe('registry helpers', () => {
  it('ratingLabel is null until rated, then a percentage with the count', () => {
    expect(ratingLabel(0, 0)).toBeNull();
    expect(ratingLabel(3, 1)).toBe('75% 👍 (4)');
    expect(ratingLabel(0, 2)).toBe('0% 👍 (2)');
  });

  it('flagCount tolerates a missing report', () => {
    expect(flagCount(null)).toBe(0);
    expect(flagCount({ bytes: 1, lines: 1, urls: [], flags: [{ kind: 'urls', detail: 'x', severity: 'warn' }], ok: true, scannedAt: '' })).toBe(1);
  });

  it('fmtInstalls abbreviates thousands', () => {
    expect(fmtInstalls(12)).toBe('12');
    expect(fmtInstalls(1234)).toBe('1.2k');
    expect(fmtInstalls(12_345)).toBe('12k');
  });

  it('installSummary says what an install creates, always inert', () => {
    expect(installSummary({ kind: 'skill', capabilities: caps })).toBe('installs as a draft skill');
    expect(installSummary({ kind: 'app', capabilities: { ...caps, appCapabilities: { free: ['storage'], elevated: ['compute'] } } })).toBe('mini app · 1 capability to review');
    expect(installSummary({ kind: 'agent', capabilities: caps })).toBe('charter only');
    expect(installSummary({ kind: 'agent', capabilities: { ...caps, loops: [{ name: 'd', enabled: false }], skills: [{ name: 's', description: '' }, { name: 't', description: '' }] } }))
      .toBe('1 loop (disabled) · 2 skills (drafts)');
  });

  it('publisher name survives a broken storage', () => {
    const store = new Map<string, string>();
    const fake = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
    savePublisherName(fake, 'Dana');
    expect(loadPublisherName(fake)).toBe('Dana');
    expect(loadPublisherName(null)).toBe('');
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(() => savePublisherName(broken, 'x')).not.toThrow();
    expect(loadPublisherName(broken)).toBe('');
  });
});
