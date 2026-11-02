/**
 * A harness run's working directory (docs/coding-harnesses.md §3):
 * materialise one workspace folder into a temp dir, then sync what the CLI
 * changed back through WorkspaceFs as the agent — versioned, attributed,
 * conflict-checked against the version each file had when it was copied
 * out, and refused wherever WorkspaceFs refuses the agent.
 *
 * The CLI never sees the workspace store, the repo or a host path: only
 * this copy. Symlinks, special files and anything outside the folder are
 * never synced back (a symlink to /etc/passwd stays a link in the temp dir).
 */
import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { FileConflictError, FilePermissionError, WorkspaceFs, type FsActor } from '../files/workspace-fs.service';
import { cleanRelativePath, isHiddenPath } from '../storage/storage.keys';

export const WORKDIR_LIMITS = {
  /** Files copied out per run. */
  maxFiles: 2000,
  /** Bytes copied out per run. */
  maxTotalBytes: 100 * 1024 * 1024,
  /** A larger file is not copied out (and so cannot be overwritten). */
  maxFileBytes: 10 * 1024 * 1024,
  /** Changed files synced back per run. */
  maxSyncFiles: 500,
};

/** Never synced back: VCS metadata and dependency trees the CLI installs. */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', '__pycache__']);

export interface Snapshot {
  /** Workspace-relative folder ('agents/ada', 'org/site'). */
  folder: string;
  /** Relative path in the folder → content hash and version at copy-out. */
  files: Map<string, { hash: string; version: number }>;
  /** Relative paths that were too large to copy out (writes refused). */
  skipped: Set<string>;
}

export interface SyncReport {
  written: Array<{ path: string; version: number; created: boolean }>;
  deleted: string[];
  refused: Array<{ path: string; reason: string }>;
  conflicts: Array<{ path: string; reason: string }>;
  skipped: Array<{ path: string; reason: string }>;
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** The workspace path of a relative path in the folder. */
export function inFolder(folder: string, rel: string): string {
  return folder ? `${folder}/${rel}` : rel;
}

export async function materialise(fs: WorkspaceFs, workspaceId: string, folder: string, workDir: string): Promise<Snapshot> {
  const snap: Snapshot = { folder, files: new Map(), skipped: new Set() };
  await mkdir(workDir, { recursive: true });
  const entries = await fs.list(workspaceId, folder);
  let total = 0;
  for (const e of entries) {
    const rel = folder ? e.path.slice(folder.length + 1) : e.path;
    if (!rel || isHiddenPath(e.path)) continue;
    if (snap.files.size >= WORKDIR_LIMITS.maxFiles || e.size > WORKDIR_LIMITS.maxFileBytes || total + e.size > WORKDIR_LIMITS.maxTotalBytes) {
      snap.skipped.add(rel);
      continue;
    }
    const got = await fs.read(workspaceId, e.path);
    if (!got) continue;
    total += got.body.length;
    const dest = join(workDir, ...rel.split('/'));
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, got.body);
    snap.files.set(rel, { hash: sha(got.body), version: got.meta?.version ?? 0 });
  }
  return snap;
}

/** Regular files under `dir` (relative, '/'-joined). Symlinks and special
 *  files are reported, never followed. */
async function walk(dir: string, root: string, out: { files: string[]; odd: string[] }): Promise<void> {
  let names: string[];
  try { names = await readdir(dir); } catch { return; }
  for (const name of names.sort()) {
    const abs = join(dir, name);
    const rel = relative(root, abs).split(sep).join('/');
    const st = await lstat(abs).catch(() => null);
    if (!st) continue;
    if (st.isSymbolicLink()) { out.odd.push(rel); continue; }
    if (st.isDirectory()) { if (!SKIP_DIRS.has(name)) await walk(abs, root, out); continue; }
    if (st.isFile()) out.files.push(rel); else out.odd.push(rel);
  }
}

export async function syncBack(fs: WorkspaceFs, workspaceId: string, workDir: string, snap: Snapshot, actor: FsActor): Promise<SyncReport> {
  const report: SyncReport = { written: [], deleted: [], refused: [], conflicts: [], skipped: [] };
  const found = { files: [] as string[], odd: [] as string[] };
  await walk(workDir, workDir, found);
  for (const rel of found.odd) report.skipped.push({ path: inFolder(snap.folder, rel), reason: 'not a regular file (symlink or special file) — not synced' });
  const present = new Set<string>();
  let synced = 0;
  for (const rawRel of found.files) {
    let rel: string;
    try { rel = cleanRelativePath(rawRel); } catch { report.skipped.push({ path: rawRel, reason: 'invalid path' }); continue; }
    if (!rel) continue;
    present.add(rel);
    const target = inFolder(snap.folder, rel);
    if (isHiddenPath(target)) { report.refused.push({ path: target, reason: 'internal path' }); continue; }
    if (snap.skipped.has(rel)) { report.refused.push({ path: target, reason: 'too large to copy out, so it may not be overwritten by a run' }); continue; }
    const st = await lstat(join(workDir, ...rel.split('/')));
    if (st.size > WORKDIR_LIMITS.maxFileBytes) { report.skipped.push({ path: target, reason: `larger than ${WORKDIR_LIMITS.maxFileBytes / 1024 / 1024} MB` }); continue; }
    const body = await readFile(join(workDir, ...rel.split('/')));
    const before = snap.files.get(rel);
    if (before && before.hash === sha(body)) continue;
    if (synced >= WORKDIR_LIMITS.maxSyncFiles) { report.skipped.push({ path: target, reason: `more than ${WORKDIR_LIMITS.maxSyncFiles} changed files` }); continue; }
    synced++;
    try {
      const meta = await fs.write(workspaceId, target, body, {
        by: actor,
        // Conflict-checked against what was copied out: a file someone else
        // changed during the run is reported, never clobbered.
        ...(fs.versioned ? { expectedVersion: before?.version ?? 0 } : {}),
      });
      report.written.push({ path: target, version: meta.version, created: !before });
    } catch (err) {
      if (err instanceof FilePermissionError) report.refused.push({ path: target, reason: err.message });
      else if (err instanceof FileConflictError) report.conflicts.push({ path: target, reason: err.message });
      else report.skipped.push({ path: target, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  // Deletions: copied out, gone now. Reversible (WorkspaceFs keeps the body
  // as a revision), and refused where the agent may not write.
  for (const [rel] of snap.files) {
    if (present.has(rel)) continue;
    const target = inFolder(snap.folder, rel);
    // A file under a skipped dir (node_modules/.git) was not walked: keep it.
    if (rel.split('/').some((seg) => SKIP_DIRS.has(seg))) continue;
    try {
      await fs.delete(workspaceId, target, { by: actor });
      report.deleted.push(target);
    } catch (err) {
      if (err instanceof FilePermissionError) report.refused.push({ path: target, reason: err.message });
      else report.skipped.push({ path: target, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return report;
}
