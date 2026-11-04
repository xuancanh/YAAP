/**
 * WorkspaceFs — the workspace filesystem (docs/filesystem.md): one tree per
 * workspace under `workspaces/<wsId>/`, agents in their homes at
 * `agents/<handle>/`, everything else shared artifacts.
 *
 * It owns, in one place:
 *  - path resolution for agent tools (relative and `~/` = the home,
 *    `/…` = the workspace root, `shared/…` = the assigned folder, kept for
 *    back-compat) — `resolvePath`;
 *  - the write permission table — `WorkspaceFs.assertCanWrite`;
 *  - writes with metadata (version, author), kept revisions and optimistic
 *    concurrency (`expectedVersion`), plus edit/append/move/delete/restore;
 *  - listing with the metadata merged in;
 *  - `file.changed` on the workspace event stream for every change.
 *
 * Without a database (tool unit tests construct it from storage alone) it
 * degrades to plain storage: no versions, no revisions, no authors.
 */
import { Inject, Injectable, Logger, OnApplicationBootstrap, Optional } from '@nestjs/common';
import { and, desc, eq, like } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { accounts, agents, workspaceFileRevisions, workspaceFiles } from '../database/schema';
import { StorageService } from '../storage/storage.service';
import { cleanRelativePath, isHiddenPath, relativePath, revisionKey, workspaceFileKey, workspacePrefix } from '../storage/storage.keys';
import { contentTypeFor } from '../storage/preview.util';
import { WorkspaceEventBus } from '../groupchat/workspace-events';
import { actorId, currentViewer } from '../accounts/account-context';
import { newId, nowIso } from '../common/ids.util';
import { migrateLegacyHomes, underPattern } from './agent-home';

export type AuthorKind = 'user' | 'agent' | 'system';

export interface FileAuthor { kind: AuthorKind; id: string; name: string }

/** Who is acting. An agent carries its home: the one place under agents/ it may write. */
export interface FsActor extends FileAuthor { home?: string }

/** Where a chat's file tools operate (docs/filesystem.md "Paths an agent
 *  uses"): a shell whose cwd is `home`. */
export interface FileRoot {
  workspaceId: string;
  /** Workspace-relative working folder: `agents/<handle>` for an agent, ''
   *  (the workspace root) for a chat with no agent. */
  home: string;
  /** The agent's assigned workspace folder, still reachable as `shared/…`. */
  sharedFolder?: string;
  /** Who writes through this root; a user when absent. */
  actor?: FsActor;
}

export interface FileMeta {
  path: string;
  version: number;
  size: number;
  contentType: string;
  updatedBy: FileAuthor;
  updatedAt: string;
}

export interface FileEntry {
  path: string;
  size: number;
  lastModified?: string;
  version?: number;
  updatedBy?: FileAuthor;
  owner?: { agentId: string };
}

export interface RevisionEntry { version: number; size: number; updatedBy: FileAuthor; updatedAt: string }

/** `expectedVersion` did not match: someone else wrote the file since. */
export class FileConflictError extends Error {
  constructor(readonly path: string, readonly expected: number, readonly current: FileMeta | null) {
    super(`version conflict on /${path}: you expected version ${expected}, it is at version ${current?.version ?? 0}`
      + `${current ? ` (last edited by ${current.updatedBy.name || current.updatedBy.kind}, ${ago(current.updatedAt)})` : ''}`
      + ' — read it again and merge your change instead of overwriting');
  }
}

/** A write the permission table refuses. */
export class FilePermissionError extends Error {}

/** The newest kept revisions per file. */
export const REVISIONS_KEPT = 20;
const SHARED_PREFIX = 'shared/';

/** `2m ago`-style age for the fs_read header and conflict messages. */
export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (!Number.isFinite(s)) return 'some time ago';
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

/**
 * Resolve a path as an agent writes it to a workspace-relative path ('' =
 * the root). Throws on traversal and on the hidden revisions folder.
 *
 *   notes.md      → <home>/notes.md
 *   ~/notes.md    → <home>/notes.md
 *   /org/plan.md  → org/plan.md
 *   shared/x.md   → <sharedFolder>/x.md   (when a folder is assigned)
 */
export function resolvePath(root: Pick<FileRoot, 'home' | 'sharedFolder'>, input: string): string {
  const raw = (input ?? '').trim();
  let full: string;
  if (raw === '~' || raw.startsWith('~/')) full = [root.home, raw.slice(1)].join('/');
  else if (raw.startsWith('/')) full = raw;
  else if (root.sharedFolder && (raw === 'shared' || raw.startsWith(SHARED_PREFIX))) {
    full = [root.sharedFolder, raw === 'shared' ? '' : raw.slice(SHARED_PREFIX.length)].join('/');
  } else full = [root.home, raw].join('/');
  const clean = cleanRelativePath(full);
  if (isHiddenPath(clean)) throw new Error(`invalid path: ${input}`);
  return clean;
}

/** The absolute form shown to agents and people: `/` + workspace-relative. */
export function displayPath(path: string): string {
  return `/${path}`;
}

/** The storage key of a resolved path in a root. */
export function fileRootKey(root: FileRoot, path: string): string {
  return workspaceFileKey(root.workspaceId, resolvePath(root, path));
}

const SYSTEM: FsActor = { kind: 'system', id: 'system', name: 'system' };

@Injectable()
export class WorkspaceFs implements OnApplicationBootstrap {
  private readonly logger = new Logger(WorkspaceFs.name);
  /** Per-file write queue: check-version-then-write is one step per path
   *  within the process (single-instance deployments; the DB's unique index
   *  still refuses a duplicate create across instances). */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly storage: StorageService,
    @Optional() @Inject(DRIZZLE_DB) private readonly db?: DrizzleDb,
    @Optional() private readonly events?: WorkspaceEventBus,
  ) {}

  /** False without a database: no versions, revisions or authors. */
  get versioned(): boolean {
    return Boolean(this.db);
  }

  /** Boot: move legacy agent brains into their homes. In the background —
   *  a slow bucket must not hold the server's start, and it never throws. */
  onApplicationBootstrap(): void {
    if (!this.db) return;
    void migrateLegacyHomes(this.db, this.storage, (m) => this.logger.log(m))
      .catch((err) => this.logger.warn(`agent home migration failed: ${err instanceof Error ? err.message : err}`));
  }

  // ---- permissions (docs/filesystem.md "Permissions") ----

  /**
   * The one write check. Everyone may write shared artifacts; under
   * `agents/`, an agent only into its own home; `.checkpoints/` of any home
   * is read-only rollback history for everybody; the revisions folder is
   * never a path. System writes (brain upkeep) pass.
   */
  static assertCanWrite(actor: FsActor, path: string): void {
    if (!path) throw new FilePermissionError('a file path is required (not a folder)');
    if (isHiddenPath(path)) throw new FilePermissionError(`/${path} is internal`);
    if (actor.kind === 'system') return;
    const seg = path.split('/');
    // The knowledge base (docs/knowledge-base.md): shipped with the packs,
    // installed and refreshed by the system alone.
    if (seg[0] === 'library') {
      throw new FilePermissionError(`/${path} is the read-only knowledge base, shipped with the agents' packs — keep your own notes in your home's knowledge/ folder or a shared folder such as /org/`);
    }
    if (seg[0] !== 'agents' || seg.length < 2) return;
    const home = `agents/${seg[1]}`;
    if (seg[2] === '.checkpoints') {
      throw new FilePermissionError(`/${home}/.checkpoints/ is read-only — it is rollback history`);
    }
    if (actor.kind === 'agent' && actor.home !== home) {
      throw new FilePermissionError(`/${home}/ is another agent's home — you can read it but not write it; put shared work in a shared folder such as /org/ instead`);
    }
  }

  /** The acting person, for HTTP writes. */
  async userActor(): Promise<FsActor> {
    const viewer = currentViewer();
    if (viewer) return { kind: 'user', id: viewer.memberAccountId, name: viewer.displayName || 'Member' };
    const id = actorId();
    let name = 'Owner';
    if (this.db) {
      const row = (await this.db.select({ name: accounts.name, email: accounts.email }).from(accounts).where(eq(accounts.id, id)).limit(1).catch(() => []))[0];
      name = row?.name?.trim() || (row?.email ? row.email.split('@')[0] : 'Owner');
    }
    return { kind: 'user', id, name };
  }

  // ---- reads ----

  async meta(workspaceId: string, path: string): Promise<FileMeta | null> {
    if (!this.db) return null;
    const row = (await this.db.select().from(workspaceFiles).where(and(eq(workspaceFiles.workspaceId, workspaceId), eq(workspaceFiles.path, path))).limit(1))[0];
    return row ? toMeta(row) : null;
  }

  async read(workspaceId: string, path: string): Promise<{ body: Buffer; meta: FileMeta | null } | null> {
    if (isHiddenPath(path)) return null;
    const body = await this.storage.get(workspaceFileKey(workspaceId, path));
    if (body === null) return null;
    return { body, meta: await this.meta(workspaceId, path) };
  }

  /** Every file under `prefix` (a folder, '' = everything), metadata merged,
   *  homes attributed to their agent. Bookkeeping is never listed. */
  async list(workspaceId: string, prefix = ''): Promise<FileEntry[]> {
    const dir = cleanRelativePath(prefix);
    const objects = await this.storage.list(dir ? `${workspaceFileKey(workspaceId, dir)}/` : workspacePrefix(workspaceId));
    const out: FileEntry[] = [];
    const metas = new Map<string, FileMeta>();
    const owners = new Map<string, string>();
    if (this.db) {
      const where = dir
        ? and(eq(workspaceFiles.workspaceId, workspaceId), like(workspaceFiles.path, underPattern(dir)))
        : eq(workspaceFiles.workspaceId, workspaceId);
      for (const r of await this.db.select().from(workspaceFiles).where(where)) metas.set(r.path, toMeta(r));
      for (const a of await this.db.select({ id: agents.id, homeDir: agents.homeDir }).from(agents).where(eq(agents.workspaceId, workspaceId))) {
        if (a.homeDir) owners.set(a.homeDir, a.id);
      }
    }
    for (const o of objects) {
      const path = relativePath(workspaceId, o.key);
      if (isHiddenPath(path)) continue;
      const meta = metas.get(path);
      const seg = path.split('/');
      const owner = seg[0] === 'agents' && seg.length > 2 ? owners.get(`agents/${seg[1]}`) : undefined;
      out.push({
        path, size: o.size, lastModified: o.lastModified,
        ...(meta ? { version: meta.version, updatedBy: meta.updatedBy } : {}),
        ...(owner ? { owner: { agentId: owner } } : {}),
      });
    }
    return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  /** The most recently written files (metadata only, newest first), for
   *  Home's recent artifacts (docs/home.md). Bookkeeping is never listed. */
  async recent(workspaceId: string, limit = 10): Promise<FileMeta[]> {
    if (!this.db) return [];
    const rows = await this.db.select().from(workspaceFiles).where(eq(workspaceFiles.workspaceId, workspaceId))
      .orderBy(desc(workspaceFiles.updatedAt)).limit(Math.max(1, Math.min(500, limit)) * 2);
    return rows.filter((r) => !isHiddenPath(r.path)).slice(0, limit).map(toMeta);
  }

  async revisions(workspaceId: string, path: string): Promise<RevisionEntry[]> {
    if (!this.db) return [];
    const rows = await this.db.select().from(workspaceFileRevisions)
      .where(and(eq(workspaceFileRevisions.workspaceId, workspaceId), eq(workspaceFileRevisions.path, path)))
      .orderBy(desc(workspaceFileRevisions.version));
    return rows.map((r) => ({ version: r.version, size: r.size, updatedBy: { kind: r.updatedByKind as AuthorKind, id: r.updatedById, name: r.updatedByName }, updatedAt: r.updatedAt }));
  }

  async revision(workspaceId: string, path: string, version: number): Promise<Buffer | null> {
    if (!this.db) return null;
    const row = (await this.db.select({ id: workspaceFileRevisions.id }).from(workspaceFileRevisions)
      .where(and(eq(workspaceFileRevisions.workspaceId, workspaceId), eq(workspaceFileRevisions.path, path), eq(workspaceFileRevisions.version, version))).limit(1))[0];
    return row ? this.storage.get(revisionKey(workspaceId, path, version)) : null;
  }

  // ---- writes ----

  /** Create or overwrite. With `expectedVersion`, refuses (FileConflictError)
   *  unless the file is at exactly that version — 0 for "does not exist or
   *  was never written through here". The previous body becomes a revision. */
  write(workspaceId: string, path: string, body: Buffer, opts: { by: FsActor; contentType?: string; expectedVersion?: number }): Promise<FileMeta> {
    WorkspaceFs.assertCanWrite(opts.by, path);
    return this.locked(workspaceId, path, () => this.writeNow(workspaceId, path, body, opts));
  }

  /** Append text (logs, notes, shared lists): no version needed — appends
   *  from several writers interleave rather than clobber. */
  append(workspaceId: string, path: string, text: string, opts: { by: FsActor }): Promise<FileMeta> {
    WorkspaceFs.assertCanWrite(opts.by, path);
    return this.locked(workspaceId, path, async () => {
      const prev = (await this.storage.get(workspaceFileKey(workspaceId, path)))?.toString('utf8') ?? '';
      const joined = prev && !prev.endsWith('\n') ? `${prev}\n${text}` : `${prev}${text}`;
      return this.writeNow(workspaceId, path, Buffer.from(joined, 'utf8'), { by: opts.by });
    });
  }

  /** Replace the one occurrence of `oldText` with `newText`. Zero or several
   *  occurrences refuse — the caller widens `oldText` until it is unique. */
  edit(workspaceId: string, path: string, oldText: string, newText: string, opts: { by: FsActor; expectedVersion?: number }): Promise<FileMeta> {
    WorkspaceFs.assertCanWrite(opts.by, path);
    if (!oldText) throw new Error('invalid arguments: "old" must be a non-empty string');
    return this.locked(workspaceId, path, async () => {
      const body = await this.storage.get(workspaceFileKey(workspaceId, path));
      if (body === null) throw new Error(`file not found: /${path}`);
      const text = body.toString('utf8');
      const first = text.indexOf(oldText);
      if (first < 0) throw new Error(`"old" was not found in /${path} — fs_read it again; it may have changed`);
      const count = text.split(oldText).length - 1;
      if (count > 1) throw new Error(`"old" occurs ${count} times in /${path} — include more surrounding text so it matches exactly once`);
      const next = text.slice(0, first) + newText + text.slice(first + oldText.length);
      return this.writeNow(workspaceId, path, Buffer.from(next, 'utf8'), { by: opts.by, expectedVersion: opts.expectedVersion });
    });
  }

  /** Delete a file, reversibly: its last body is kept as a revision (with
   *  the revisions before it), so `restore` brings it back. Only the live
   *  object and its metadata row go. Returns the kept version (null when
   *  there was nothing to keep or no database). */
  async delete(workspaceId: string, path: string, opts: { by: FsActor }): Promise<{ keptVersion: number | null }> {
    WorkspaceFs.assertCanWrite(opts.by, path);
    const kept = await this.locked(workspaceId, path, async () => {
      const key = workspaceFileKey(workspaceId, path);
      let keptVersion: number | null = null;
      if (this.db) {
        const body = await this.storage.get(key);
        if (body !== null) {
          const meta = await this.meta(workspaceId, path);
          await this.keepRevision(workspaceId, path, body, meta, nowIso());
          keptVersion = meta?.version ?? 0;
        }
        await this.db.delete(workspaceFiles).where(and(eq(workspaceFiles.workspaceId, workspaceId), eq(workspaceFiles.path, path)));
      }
      await this.storage.delete(key);
      return keptVersion;
    });
    this.emit(workspaceId, path, 0, opts.by, { deleted: true });
    return { keptVersion: kept };
  }

  /** The newest kept revision of a path (0 = none) — a deleted file's last body. */
  async latestRevision(workspaceId: string, path: string): Promise<number> {
    if (!this.db) return 0;
    const row = (await this.db.select({ version: workspaceFileRevisions.version }).from(workspaceFileRevisions)
      .where(and(eq(workspaceFileRevisions.workspaceId, workspaceId), eq(workspaceFileRevisions.path, path)))
      .orderBy(desc(workspaceFileRevisions.version)).limit(1))[0];
    return row?.version ?? 0;
  }

  /** Restore = write the kept body back as a new version (the current one
   *  becomes a revision itself, so a restore is undoable). */
  async restore(workspaceId: string, path: string, version: number, opts: { by: FsActor }): Promise<FileMeta> {
    const body = await this.revision(workspaceId, path, version);
    if (body === null) throw new Error(`no revision ${version} of /${path}`);
    return this.write(workspaceId, path, body, { by: opts.by });
  }

  /** Move a file, or every file under a folder. Refuses to overwrite.
   *  Metadata and revisions follow the file. */
  async move(workspaceId: string, from: string, to: string, opts: { by: FsActor }): Promise<{ moved: number }> {
    WorkspaceFs.assertCanWrite(opts.by, from);
    WorkspaceFs.assertCanWrite(opts.by, to);
    if (from === to) return { moved: 0 };
    if (to.startsWith(`${from}/`)) throw new Error('cannot move a folder into itself');
    const single = await this.storage.get(workspaceFileKey(workspaceId, from));
    const pairs: Array<[string, string]> = single !== null
      ? [[from, to]]
      : (await this.storage.list(`${workspaceFileKey(workspaceId, from)}/`)).map((o) => {
        const rel = relativePath(workspaceId, o.key);
        return [rel, `${to}${rel.slice(from.length)}`] as [string, string];
      });
    if (pairs.length === 0) throw new Error(`file not found: /${from}`);
    for (const [, dest] of pairs) {
      WorkspaceFs.assertCanWrite(opts.by, dest);
      if (await this.storage.get(workspaceFileKey(workspaceId, dest)) !== null) throw new Error(`/${dest} already exists — move it away or pick another name`);
    }
    for (const [src, dest] of pairs) await this.moveOne(workspaceId, src, dest, opts.by);
    return { moved: pairs.length };
  }

  // ---- internals ----

  private async locked<T>(workspaceId: string, path: string, fn: () => Promise<T>): Promise<T> {
    const k = `${workspaceId}:${path}`;
    const prev = this.locks.get(k) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.locks.set(k, next);
    try {
      return await next;
    } finally {
      if (this.locks.get(k) === next) this.locks.delete(k);
    }
  }

  private async writeNow(workspaceId: string, path: string, body: Buffer, opts: { by: FsActor; contentType?: string; expectedVersion?: number }): Promise<FileMeta> {
    const key = workspaceFileKey(workspaceId, path);
    const contentType = opts.contentType || contentTypeFor(path);
    const by: FileAuthor = { kind: opts.by.kind, id: opts.by.id, name: opts.by.name };
    const now = nowIso();
    if (!this.db) {
      await this.storage.put(key, body, contentType);
      return { path, version: 0, size: body.length, contentType, updatedBy: by, updatedAt: now };
    }
    const meta = await this.meta(workspaceId, path);
    if (opts.expectedVersion !== undefined && opts.expectedVersion !== null && (meta?.version ?? 0) !== opts.expectedVersion) {
      throw new FileConflictError(path, opts.expectedVersion, meta);
    }
    // A path whose file was deleted keeps its history: numbering continues
    // after the newest kept revision instead of overwriting it.
    const base = meta?.version ?? await this.latestRevision(workspaceId, path);
    const previous = await this.storage.get(key);
    if (previous !== null) await this.keepRevision(workspaceId, path, previous, meta, now);
    await this.storage.put(key, body, contentType);
    const version = base + 1;
    const set = {
      version, size: body.length, contentType,
      updatedByKind: by.kind, updatedById: by.id, updatedByName: by.name, updatedAt: now,
    };
    if (meta) {
      await this.db.update(workspaceFiles).set(set).where(and(eq(workspaceFiles.workspaceId, workspaceId), eq(workspaceFiles.path, path)));
    } else {
      await this.db.insert(workspaceFiles).values({ id: newId(), workspaceId, path, ...set, createdByKind: by.kind, createdById: by.id, createdAt: now });
    }
    this.emit(workspaceId, path, version, by);
    return { path, version, size: body.length, contentType, updatedBy: by, updatedAt: now };
  }

  /** Keep `body` as the revision of the version it was (0 = from before
   *  metadata), then prune to the newest REVISIONS_KEPT. */
  private async keepRevision(workspaceId: string, path: string, body: Buffer, meta: FileMeta | null, now: string): Promise<void> {
    const db = this.db!;
    const version = meta?.version ?? 0;
    await this.storage.put(revisionKey(workspaceId, path, version), body);
    const by = meta?.updatedBy ?? { kind: 'system', id: '', name: '' };
    await db.delete(workspaceFileRevisions).where(and(eq(workspaceFileRevisions.workspaceId, workspaceId), eq(workspaceFileRevisions.path, path), eq(workspaceFileRevisions.version, version)));
    await db.insert(workspaceFileRevisions).values({
      id: newId(), workspaceId, path, version, size: body.length,
      updatedByKind: by.kind, updatedById: by.id, updatedByName: by.name, updatedAt: meta?.updatedAt ?? now,
    });
    const all = await db.select({ version: workspaceFileRevisions.version }).from(workspaceFileRevisions)
      .where(and(eq(workspaceFileRevisions.workspaceId, workspaceId), eq(workspaceFileRevisions.path, path)))
      .orderBy(desc(workspaceFileRevisions.version));
    for (const old of all.slice(REVISIONS_KEPT)) {
      await this.storage.delete(revisionKey(workspaceId, path, old.version)).catch(() => {});
      await db.delete(workspaceFileRevisions).where(and(eq(workspaceFileRevisions.workspaceId, workspaceId), eq(workspaceFileRevisions.path, path), eq(workspaceFileRevisions.version, old.version)));
    }
  }

  /** Drop a file's metadata and its kept revisions. */
  private async forget(workspaceId: string, path: string): Promise<void> {
    if (!this.db) return;
    for (const r of await this.revisions(workspaceId, path)) {
      await this.storage.delete(revisionKey(workspaceId, path, r.version)).catch(() => {});
    }
    await this.db.delete(workspaceFileRevisions).where(and(eq(workspaceFileRevisions.workspaceId, workspaceId), eq(workspaceFileRevisions.path, path)));
    await this.db.delete(workspaceFiles).where(and(eq(workspaceFiles.workspaceId, workspaceId), eq(workspaceFiles.path, path)));
  }

  private async moveOne(workspaceId: string, from: string, to: string, by: FsActor): Promise<void> {
    const body = await this.storage.get(workspaceFileKey(workspaceId, from));
    if (body === null) return;
    await this.forget(workspaceId, to); // stale rows of a file that is gone
    await this.storage.put(workspaceFileKey(workspaceId, to), body, contentTypeFor(to));
    let version = 0;
    if (this.db) {
      for (const r of await this.revisions(workspaceId, from)) {
        const kept = await this.storage.get(revisionKey(workspaceId, from, r.version));
        if (kept !== null) await this.storage.put(revisionKey(workspaceId, to, r.version), kept);
        await this.storage.delete(revisionKey(workspaceId, from, r.version)).catch(() => {});
      }
      await this.db.update(workspaceFileRevisions).set({ path: to }).where(and(eq(workspaceFileRevisions.workspaceId, workspaceId), eq(workspaceFileRevisions.path, from)));
      const now = nowIso();
      const meta = await this.meta(workspaceId, from);
      if (meta) {
        version = meta.version;
        await this.db.update(workspaceFiles).set({ path: to, updatedByKind: by.kind, updatedById: by.id, updatedByName: by.name, updatedAt: now })
          .where(and(eq(workspaceFiles.workspaceId, workspaceId), eq(workspaceFiles.path, from)));
      }
    }
    await this.storage.delete(workspaceFileKey(workspaceId, from));
    const author = { kind: by.kind, id: by.id, name: by.name };
    this.emit(workspaceId, from, version, author, { deleted: true, movedTo: to });
    this.emit(workspaceId, to, version, author);
  }

  private emit(workspaceId: string, path: string, version: number, by: FileAuthor, extra: { deleted?: boolean; movedTo?: string } = {}): void {
    this.events?.emit({ type: 'file.changed', workspaceId, path, version, by: { kind: by.kind, id: by.id, name: by.name }, ...extra });
  }

  /** The system actor, for brain upkeep. */
  static get system(): FsActor { return SYSTEM; }
}

function toMeta(r: typeof workspaceFiles.$inferSelect): FileMeta {
  return {
    path: r.path, version: r.version, size: r.size, contentType: r.contentType,
    updatedBy: { kind: r.updatedByKind as AuthorKind, id: r.updatedById, name: r.updatedByName },
    updatedAt: r.updatedAt,
  };
}
