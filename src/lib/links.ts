/** Organization deep links (docs/home.md "Links"): `#/ws/<id>/org/<pane>`
 *  opens a Company pane; `#/ws/<id>/org/board?task=<taskId>` opens the board
 *  with that task's drawer. The server writes the same shape for follow
 *  notifications (server/src/follows/follows.service.ts `orgTaskLink`). */

export interface OrgHash { workspaceId: string; pane: string; taskId: string | null }

export function parseOrgHash(hash: string): OrgHash | null {
  const m = /^#\/ws\/([\w-]+)\/org\/(\w+)\/?(?:\?(.*))?$/.exec(hash ?? '');
  if (!m) return null;
  const task = m[3] ? new URLSearchParams(m[3]).get('task') : null;
  return { workspaceId: m[1], pane: m[2], taskId: task && /^[\w-]+$/.test(task) ? task : null };
}

/** The link to one org task: the Company board with its drawer open. */
export function orgTaskHash(workspaceId: string, taskId: string): string {
  return `#/ws/${workspaceId}/org/board?task=${encodeURIComponent(taskId)}`;
}

/** The task a hash opens, if it is a task link. */
export function taskOfHash(hash: string): string | null {
  return parseOrgHash(hash)?.taskId ?? null;
}
