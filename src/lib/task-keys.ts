/** Task keys (docs/tasks-keys.md): Jira-style `ENG-12` names. The server
 *  mints them (server/src/common/task-keys.ts); the SPA shows them, links
 *  them and accepts them in deep links. */

import type { OrgUnitNode } from './api';

/** A whole key, case-insensitive. */
export const TASK_KEY_RE = /^([A-Za-z][A-Za-z0-9]{1,5})-(\d{1,7})$/;

export function isTaskKey(s: string | null | undefined): boolean { return TASK_KEY_RE.test((s ?? '').trim()); }

/** `eng-12` → `ENG-12`; null when not key-shaped. */
export function normalizeTaskKey(s: string | null | undefined): string | null {
  const m = TASK_KEY_RE.exec((s ?? '').trim());
  return m ? `${m[1].toUpperCase()}-${Number(m[2])}` : null;
}

/** The prefix of a key (`ENG-12` → `ENG`). */
export function keyPrefix(key: string): string { return key.slice(0, key.lastIndexOf('-')).toUpperCase(); }

/** How a task is named: its key, else the 8-char id prefix (a task from before keys). */
export function taskRef(t: { id: string; key?: string | null }): string { return t.key || t.id.slice(0, 8); }

/** Whether `ref` (a key, an id or an id prefix, as a deep link carries it) names `t`. */
export function matchesTaskRef(t: { id: string; key?: string | null }, ref: string): boolean {
  const key = normalizeTaskKey(ref);
  if (key && (t.key ?? '').toUpperCase() === key) return true;
  return t.id === ref || t.id.startsWith(ref);
}

/** Every board prefix in a unit tree (the org's task keys). */
export function unitKeyPrefixes(units: readonly OrgUnitNode[]): Set<string> {
  const out = new Set<string>();
  const walk = (list: readonly OrgUnitNode[]) => { for (const u of list) { if (u.taskKey) out.add(u.taskKey.toUpperCase()); walk(u.children ?? []); } };
  walk(units);
  return out;
}

/** The key as a small monospace label (board cards, rows, the drawer). */
export const keyStyle = { fontFamily: 'var(--mono)', fontSize: '.85em', color: 'var(--text-dim)', fontWeight: 600, letterSpacing: '.2px' } as const;
