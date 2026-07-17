/**
 * Object-key helpers for the workspace bucket.
 *
 * Every workspace's files live under one prefix so listing, quota, and
 * deletion are a single prefix operation. User-supplied paths are validated
 * strictly (no traversal, no absolute paths, printable segments only) —
 * object keys are the security boundary between workspaces.
 */
const SEGMENT = /^[A-Za-z0-9._-]+$/;

export function workspacePrefix(workspaceId: string): string {
  return `workspaces/${workspaceId}/`;
}

/** Validate a user-supplied relative path and scope it under the workspace
 *  prefix. Throws on traversal or malformed segments. */
export function workspaceFileKey(workspaceId: string, path: string): string {
  const segments = path.split('/').filter((s) => s.length > 0);
  if (segments.length === 0) throw new Error('empty path');
  for (const seg of segments) {
    if (seg === '.' || seg === '..' || !SEGMENT.test(seg)) {
      throw new Error(`invalid path segment: ${seg}`);
    }
  }
  return workspacePrefix(workspaceId) + segments.join('/');
}

/** The workspace-relative path of a full object key. */
export function relativePath(workspaceId: string, key: string): string {
  return key.slice(workspacePrefix(workspaceId).length);
}
