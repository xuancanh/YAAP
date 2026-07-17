/**
 * Object-key helpers for the workspace bucket.
 *
 * Every workspace's files live under one prefix so listing, quota, and
 * deletion are a single prefix operation. User-supplied paths are validated
 * strictly (no traversal, no absolute paths, printable segments only) —
 * object keys are the security boundary between workspaces.
 */
const SEGMENT = /^[A-Za-z0-9._-]+$/;

/** Validate a user-supplied relative path: no traversal, printable segments. */
function cleanSegments(path: string): string {
  const segments = path.split('/').filter((s) => s.length > 0);
  if (segments.length === 0) throw new Error('empty path');
  for (const seg of segments) {
    if (seg === '.' || seg === '..' || !SEGMENT.test(seg)) {
      throw new Error(`invalid path segment: ${seg}`);
    }
  }
  return segments.join('/');
}

export function workspacePrefix(workspaceId: string): string {
  return `workspaces/${workspaceId}/`;
}

/** Scope a user-supplied relative path under the workspace prefix. */
export function workspaceFileKey(workspaceId: string, path: string): string {
  return workspacePrefix(workspaceId) + cleanSegments(path);
}

/** The workspace-relative path of a full object key. */
export function relativePath(workspaceId: string, key: string): string {
  return key.slice(workspacePrefix(workspaceId).length);
}

/** Durable-agent file brains live under their own prefix (FR-11.3). */
export function agentPrefix(agentId: string): string {
  return `agents/${agentId}/`;
}

export function agentFileKey(agentId: string, path: string): string {
  return agentPrefix(agentId) + cleanSegments(path);
}

export function agentRelativePath(agentId: string, key: string): string {
  return key.slice(agentPrefix(agentId).length);
}
