/** Pure helpers for the Community department and the publish/install cards
 *  (docs/registry.md). Kept free of React so web-tests can pin them. */
import type { RegistryItem, RegistryKind, SkillScanReport } from './api';

export const KIND_LABEL: Record<RegistryKind, string> = { agent: 'Agent', skill: 'Skill', app: 'Mini app' };
export const KIND_GLYPH: Record<RegistryKind, string> = { agent: '🤖', skill: '📘', app: '🧩' };

/** "87% 👍 (15)" or null when nobody rated it yet. */
export function ratingLabel(up: number, down: number): string | null {
  const total = up + down;
  if (total <= 0) return null;
  return `${Math.round((up / total) * 100)}% 👍 (${total})`;
}

/** Warnings only — blocking flags never reach a listing (publish refuses). */
export function flagCount(report: SkillScanReport | null | undefined): number {
  return report?.flags?.length ?? 0;
}

/** "1.2k" style installs. */
export function fmtInstalls(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

/** One line of what installing creates, from the summary alone. */
export function installSummary(item: Pick<RegistryItem, 'kind' | 'capabilities'>): string {
  const c = item.capabilities;
  if (item.kind === 'skill') return 'installs as a draft skill';
  if (item.kind === 'app') {
    const elevated = c.appCapabilities?.elevated ?? [];
    return elevated.length ? `mini app · ${elevated.length} capabilit${elevated.length === 1 ? 'y' : 'ies'} to review` : 'mini app · no elevated capabilities';
  }
  const bits = [
    c.loops.length ? `${c.loops.length} loop${c.loops.length === 1 ? '' : 's'} (disabled)` : '',
    c.skills.length ? `${c.skills.length} skill${c.skills.length === 1 ? '' : 's'} (drafts)` : '',
    c.apps.length ? `${c.apps.length} app${c.apps.length === 1 ? '' : 's'}` : '',
  ].filter(Boolean);
  return bits.length ? bits.join(' · ') : 'charter only';
}

/** The remembered display name for publishing, per browser. */
export const PUBLISHER_KEY = 'yaam_publisher_name';
export function loadPublisherName(storage: Pick<Storage, 'getItem'> | null): string {
  try { return storage?.getItem(PUBLISHER_KEY) ?? ''; } catch { return ''; }
}
export function savePublisherName(storage: Pick<Storage, 'setItem'> | null, name: string): void {
  try { storage?.setItem(PUBLISHER_KEY, name); } catch { /* private window */ }
}
