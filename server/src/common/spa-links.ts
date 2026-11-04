/**
 * The SPA's addresses (docs/routes.md), for the links the server writes into
 * notifications, follow targets and meeting minutes: company first, then the
 * place — `/real-jong-cad9a8/channels/general/<messageId>`,
 * `/real-jong-cad9a8/tasks/ENG-12`. Mirrors src/lib/routes.ts.
 *
 * The company segment is the readable slug when the workspace name is at
 * hand (the name, then a 6-character id prefix — the prefix is what
 * resolves it), else the bare workspace id; the app resolves either and
 * shows the slug. Older `#/ws/<id>/…` links in stored rows keep working:
 * the app redirects them on load.
 */

/** The name part of a company slug: lower-case, ASCII, dashes (same as the SPA's `nameSlug`). */
function nameSlug(name: string): string {
  const s = (name ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/g, '');
  return s || 'company';
}

/** The address segment of a workspace: `acme-1f2e3d` with its name, its id without. */
export function companySegment(workspaceId: string, name?: string | null): string {
  if (!name) return encodeURIComponent(workspaceId);
  return `${nameSlug(name)}-${workspaceId.replace(/-/g, '').toLowerCase().slice(0, 6)}`;
}

/** Paths into the app (prefix them with the public app URL for mail and push). */
export const spaPath = {
  home: (workspaceId: string, name?: string | null): string => `/${companySegment(workspaceId, name)}/home`,
  channel: (workspaceId: string, slug: string, messageId?: string | null, name?: string | null): string =>
    `/${companySegment(workspaceId, name)}/channels/${encodeURIComponent(slug)}${messageId ? `/${encodeURIComponent(messageId)}` : ''}`,
  /** A task by its key (ENG-12) or id: Operations › Board with its drawer open. */
  task: (workspaceId: string, keyOrId: string, name?: string | null): string => `/${companySegment(workspaceId, name)}/tasks/${encodeURIComponent(keyOrId)}`,
  meeting: (workspaceId: string, meetingId: string, name?: string | null): string => `/${companySegment(workspaceId, name)}/meetings/${encodeURIComponent(meetingId)}`,
};
