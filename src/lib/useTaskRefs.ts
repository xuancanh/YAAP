/** Task key chips in chat text (docs/tasks-keys.md): a resolver for
 *  Markdown's `refs` that turns `ENG-12` (bare or `#task:ENG-12`) into a
 *  chip when the prefix is a board of this workspace — an org unit board
 *  opens the task's drawer, an agent's board its Tasks tab. Unknown
 *  prefixes (GPT-4, UTF-8) stay text. */
import { useCallback, useMemo } from 'react';
import { useApp } from '../store';
import type { RefResolver } from './md';
import { keyPrefix, normalizeTaskKey, unitKeyPrefixes } from './task-keys';

export function useTaskRefs(): RefResolver {
  const app = useApp();
  const orgPrefixes = useMemo(() => unitKeyPrefixes(app.wsOrg?.units ?? []), [app.wsOrg]);
  const { agents, companiesEnabled, openOrgTask, openAgent } = app;
  return useCallback<RefResolver>((kind, id) => {
    if (kind !== 'task') return null;
    const key = normalizeTaskKey(id);
    if (!key) return null;
    const p = keyPrefix(key);
    if (companiesEnabled && orgPrefixes.has(p)) return { label: key, onClick: () => openOrgTask(key) };
    const owner = agents.find((a) => (a.taskKey ?? '').toUpperCase() === p);
    return owner ? { label: key, onClick: () => openAgent(owner.id, 'Tasks') } : null;
  }, [orgPrefixes, agents, companiesEnabled, openOrgTask, openAgent]);
}
