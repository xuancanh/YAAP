/**
 * Object-key helpers for the workspace bucket.
 *
 * Every workspace's files live under one prefix so listing, quota, and
 * deletion are a single prefix operation. User-supplied paths are validated
 * strictly (no traversal, no absolute paths, printable segments only) —
 * object keys are the security boundary between workspaces.
 */
import { createHash } from 'node:crypto';

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

/** Validate a workspace-relative path and return it normalized (no leading
 *  or trailing slash). '' (the workspace root) is allowed here; keys are not
 *  built from it. */
export function cleanRelativePath(path: string): string {
  return path.split('/').some((s) => s.length > 0) ? cleanSegments(path) : '';
}

/** Where WorkspaceFs keeps previous bodies, inside the workspace prefix.
 *  Never listed, searched, read or written through a path. */
export const REVISIONS_DIR = '.revisions';

/** True for workspace-relative paths that are internal bookkeeping. */
export function isHiddenPath(path: string): boolean {
  return path === REVISIONS_DIR || path.startsWith(`${REVISIONS_DIR}/`);
}

/** Where a kept previous body of `path` lives (docs/filesystem.md
 *  "Revisions"): hashed so a file's history is one flat folder whatever its
 *  depth, and so a move re-keys by rename of one folder. */
export function revisionKey(workspaceId: string, path: string, version: number): string {
  const hash = createHash('sha1').update(path).digest('hex');
  return `${workspacePrefix(workspaceId)}${REVISIONS_DIR}/${hash}/${version}`;
}

/** The pre-filesystem prefix of an agent's file brain (`agents/<id>/`, at
 *  the bucket root). Read only by the boot migration that moves it into the
 *  agent's home (docs/filesystem.md "Migration"). */
export function legacyAgentPrefix(agentId: string): string {
  return `agents/${agentId}/`;
}
