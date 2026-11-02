/**
 * Agent homes (docs/filesystem.md "Layout"): every agent lives at
 * `agents/<handle>/` inside its workspace's tree, so its brain (LESSONS.md,
 * JOURNAL.md, knowledge/), its mini-app state and its checkpoints are files
 * of the workspace like any other — listed, searched and deleted with it.
 *
 * Plain functions over (db, storage) rather than a service: AgentsService,
 * AgentMemoryService, the app bridge and WorkspacesService all need the
 * home of an agent they only know by row, and every one of them is built in
 * tests from exactly those two handles.
 *
 * A row whose homeDir is null or still the old default `agents/<id>` has not
 * been moved yet: its files sit under the legacy bucket-root prefix
 * `agents/<id>/`. The boot migration moves every such agent that has a
 * workspace; `ensureAgentHome` moves one lazily if it is ever reached first.
 */
import { and, eq, like } from 'drizzle-orm';
import type { DrizzleDb } from '../database/database.module';
import { agents, workspaceFileRevisions, workspaceFiles } from '../database/schema';
import type { StorageService } from '../storage/storage.service';
import { legacyAgentPrefix, revisionKey, workspaceFileKey } from '../storage/storage.keys';
import { unscoped } from '../accounts/scoped-db';

export interface AgentHome {
  /** '' only for an agent with no workspace (and so still at its legacy prefix). */
  workspaceId: string;
  /** Workspace-relative home folder, `agents/<handle>`; '' when legacy. */
  home: string;
  /** The storage prefix every key of the home starts with (trailing slash). */
  prefix: string;
}

type HomeRow = { id: string; name: string; workspaceId: string; homeDir: string | null };

const HANDLE_MAX = 40;
const HOME_RE = /^agents\/[a-z0-9-]{1,48}$/;

/** `Fieldy, the Scout!` → `fieldy-the-scout`; nothing usable → `agent`. */
export function handleSlugify(name: string): string {
  const slug = name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, HANDLE_MAX).replace(/-+$/g, '');
  return slug || 'agent';
}

/** Done = a handle home, not the pre-filesystem default (docs/filesystem.md "Migration"). */
export function isMigratedHome(a: { id: string; homeDir: string | null }): boolean {
  return !!a.homeDir && HOME_RE.test(a.homeDir) && a.homeDir !== `agents/${a.id}`;
}

/** The handle out of a home folder: `agents/ada` → `ada`. */
export function handleOf(homeDir: string): string {
  return homeDir.slice('agents/'.length);
}

/** A free `agents/<handle>` in `workspaceId`: the name slugified, `-2`, `-3`…
 *  on collision with another agent's home there. */
export async function allocateHome(db: DrizzleDb, workspaceId: string, name: string, exceptAgentId?: string): Promise<string> {
  const rows = await db.select({ id: agents.id, homeDir: agents.homeDir }).from(agents).where(eq(agents.workspaceId, workspaceId));
  const taken = new Set(rows.filter((r) => r.id !== exceptAgentId).map((r) => r.homeDir));
  const base = handleSlugify(name);
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? '' : `-${n}`;
    const candidate = `agents/${base.slice(0, HANDLE_MAX - suffix.length).replace(/-+$/g, '')}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** The home of an agent row as it stands (no migration). */
export function homeOfRow(row: { id: string; workspaceId: string; homeDir: string | null }): AgentHome {
  if (row.workspaceId && isMigratedHome(row)) {
    return { workspaceId: row.workspaceId, home: row.homeDir!, prefix: `${workspaceFileKey(row.workspaceId, row.homeDir!)}/` };
  }
  return { workspaceId: row.workspaceId, home: '', prefix: legacyAgentPrefix(row.id) };
}

/** The storage key of `path` inside a home (validated like every user path). */
export function homeKey(home: AgentHome, path: string): string {
  // workspaceFileKey does the validation; the probe workspace id is discarded
  return home.prefix + workspaceFileKey('x', path).slice('workspaces/x/'.length);
}

/** Copy every object under `from` to the same relative key under `to`. */
async function copyPrefix(storage: StorageService, from: string, to: string): Promise<number> {
  let n = 0;
  for (const o of await storage.list(from)) {
    const body = await storage.get(o.key);
    if (body === null) continue;
    await storage.put(`${to}${o.key.slice(from.length)}`, body);
    n++;
  }
  return n;
}

const inflight = new Map<string, Promise<AgentHome>>();

/** Move one agent's legacy brain into a fresh home in its workspace.
 *  Order per the doc: copy, set homeDir, then delete the old prefix — a
 *  crash in between leaves both copies, never neither. */
async function migrateHome(db: DrizzleDb, storage: StorageService, row: HomeRow, workspaceId: string): Promise<{ home: AgentHome; files: number }> {
  const homeDir = await allocateHome(db, workspaceId, row.name, row.id);
  const prefix = `${workspaceFileKey(workspaceId, homeDir)}/`;
  const files = await copyPrefix(storage, legacyAgentPrefix(row.id), prefix);
  await db.update(agents).set({ homeDir }).where(eq(agents.id, row.id));
  await storage.deletePrefix(legacyAgentPrefix(row.id));
  return { home: { workspaceId, home: homeDir, prefix }, files };
}

/** The agent's home, moving it out of the legacy prefix first when it has a
 *  workspace and was not moved yet (the boot migration normally got there). */
export async function ensureAgentHome(db: DrizzleDb, storage: StorageService, row: HomeRow): Promise<AgentHome> {
  const current = homeOfRow(row);
  if (current.home || !row.workspaceId) return current;
  const running = inflight.get(row.id);
  if (running) return running;
  const p = migrateHome(db, storage, row, row.workspaceId).then((r) => r.home);
  inflight.set(row.id, p);
  try { return await p; } finally { inflight.delete(row.id); }
}

/** LIKE pattern for everything under a folder (paths are [A-Za-z0-9._-]). */
export function underPattern(dir: string): string {
  return `${dir.replace(/[\\%_]/g, (c) => `\\${c}`)}/%`;
}

/** Drop the metadata rows and kept revisions of every file under `dir`. */
export async function forgetFolder(db: DrizzleDb, storage: StorageService, workspaceId: string, dir: string): Promise<void> {
  const pattern = underPattern(dir);
  const revs = await db.select({ path: workspaceFileRevisions.path, version: workspaceFileRevisions.version }).from(workspaceFileRevisions)
    .where(and(eq(workspaceFileRevisions.workspaceId, workspaceId), like(workspaceFileRevisions.path, pattern)));
  for (const r of revs) await storage.delete(revisionKey(workspaceId, r.path, r.version)).catch(() => {});
  await db.delete(workspaceFileRevisions).where(and(eq(workspaceFileRevisions.workspaceId, workspaceId), like(workspaceFileRevisions.path, pattern)));
  await db.delete(workspaceFiles).where(and(eq(workspaceFiles.workspaceId, workspaceId), like(workspaceFiles.path, pattern)));
}

/** Moving an agent to another workspace moves its home (a new handle there,
 *  unique in the target). History does not travel: revisions and authorship
 *  belong to the workspace that saw the edits. Sets homeDir; the caller sets
 *  workspaceId. */
export async function moveAgentHome(db: DrizzleDb, storage: StorageService, row: HomeRow, toWorkspaceId: string): Promise<AgentHome> {
  const from = await ensureAgentHome(db, storage, row);
  const homeDir = await allocateHome(db, toWorkspaceId, row.name, row.id);
  const prefix = `${workspaceFileKey(toWorkspaceId, homeDir)}/`;
  await copyPrefix(storage, from.prefix, prefix);
  await db.update(agents).set({ homeDir }).where(eq(agents.id, row.id));
  if (from.home) await forgetFolder(db, storage, from.workspaceId, from.home);
  await storage.deletePrefix(from.prefix);
  return { workspaceId: toWorkspaceId, home: homeDir, prefix };
}

/** Agent delete: its home goes with it (and any legacy leftovers). */
export async function deleteAgentHome(db: DrizzleDb, storage: StorageService, row: { id: string; workspaceId: string; homeDir: string | null }): Promise<void> {
  const home = homeOfRow(row);
  if (home.home) {
    await forgetFolder(db, storage, home.workspaceId, home.home);
    await storage.deletePrefix(home.prefix);
  }
  await storage.deletePrefix(legacyAgentPrefix(row.id));
}

/**
 * Boot-time data move (docs/filesystem.md "Migration"): every agent with a
 * workspace whose home is not a handle home yet gets one, and its
 * `agents/<id>/…` objects move into it. Idempotent (a moved agent no longer
 * matches) and across every account. Never throws: a failing agent is
 * counted and retried on the next boot, or lazily on first use.
 */
export async function migrateLegacyHomes(db: DrizzleDb, storage: StorageService, log: (msg: string) => void): Promise<{ agents: number; files: number; failed: number }> {
  const out = { agents: 0, files: 0, failed: 0 };
  const raw = unscoped(db);
  let rows: HomeRow[];
  try {
    rows = await raw.select({ id: agents.id, name: agents.name, workspaceId: agents.workspaceId, homeDir: agents.homeDir }).from(agents);
  } catch (err) {
    log(`agent home migration skipped: ${err instanceof Error ? err.message : String(err)}`);
    return out;
  }
  for (const row of rows) {
    if (!row.workspaceId || isMigratedHome(row)) continue;
    try {
      const { files } = await migrateHome(raw, storage, row, row.workspaceId);
      out.agents++;
      out.files += files;
    } catch {
      out.failed++;
    }
  }
  if (out.agents > 0 || out.failed > 0) {
    log(`moved ${out.agents} agent home(s) (${out.files} file(s)) into their workspaces${out.failed ? `; ${out.failed} failed, retried next boot` : ''}`);
  }
  return out;
}
