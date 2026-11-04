/**
 * KnowledgeService — the knowledge base in a workspace (docs/knowledge-base.md).
 *
 * Which knowledge an agent sees follows its pack: `agents.packId` when a pack
 * door set it (a market hire, a company hire, the chief at company start);
 * for agents from before that column, the pack is read from what the agent
 * carries — the chief's or the auditor's seat, else the pack whose playbooks
 * it holds (two or more of them), else a pack of the same name.
 *
 * The library: the docs are installed read-only at `/library/<pack>/…` and
 * `/library/_shared/<topic>/…`, one copy per workspace that every agent of
 * the role shares, written by the system author (WorkspaceFs refuses every
 * other writer under /library/). Installed when an agent of the pack first
 * needs it (hire, first turn) and at boot; refreshed whenever the embedded
 * text changes (a pack's knowledge base is versioned by its content hash);
 * a doc the pack no longer ships is removed (kept as a revision).
 *
 * The tools read the embedded bundle, not the files, so a turn never waits
 * on the bucket and an agent's reach is its scope, not whatever is installed.
 */
import { Inject, Injectable, Logger, OnApplicationBootstrap, Optional } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { agents, organizations, skills, workspaces } from '../database/schema';
import { WorkspaceFs } from '../files/workspace-fs.service';
import { AccountsService } from '../accounts/accounts.service';
import { AUTHORED_PACKS } from '../market/authored-packs.generated';
import { KNOWLEDGE } from './knowledge.generated';
import {
  LIBRARY_DIR, SHARED_DIR, libraryFiles, libraryIndex, libraryPath, scopeDocs, scopeFor, scopeIsEmpty, scopeVersion,
  type KbPack, type KbScope, type KbTopic, type KnowledgeBundle,
} from './knowledge';

const CHIEF_PACK = 'pack-chief-of-staff';
const AUDITOR_PACK = 'pack-auditor';
const SCOPE_TTL_MS = 30_000;
const PACK_SKILLS = new Map(AUTHORED_PACKS.map((p) => [p.id, new Set((p.skills ?? []).map((s) => s.name))]));

type AgentRow = Pick<typeof agents.$inferSelect, 'id' | 'name' | 'workspaceId'> & { packId?: string | null };

/** What the agent page shows: the role's knowledge base and its files. */
export interface AgentKnowledge {
  packId: string | null;
  packName: string | null;
  folder: string | null;
  summary: string;
  docs: Array<{ path: string; file: string; title: string; summary: string }>;
  shared: Array<{ topic: string; docs: Array<{ path: string; file: string; title: string; summary: string }> }>;
  version: string;
}

@Injectable()
export class KnowledgeService implements OnApplicationBootstrap {
  private readonly logger = new Logger(KnowledgeService.name);
  /** The embedded knowledge base (a test seam). */
  bundle: KnowledgeBundle = KNOWLEDGE;
  /** workspaceId → the signature of what was last installed there. */
  private readonly installed = new Map<string, string>();
  private readonly scopes = new Map<string, { scope: KbScope; packId: string | null; at: number }>();
  private readonly inflight = new Map<string, Promise<{ written: string[]; removed: string[] }>>();

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly fs: WorkspaceFs,
    @Optional() private readonly accounts?: AccountsService,
  ) {}

  /** Boot: bring every workspace's library up to the embedded version. In
   *  the background — a slow bucket must not hold the start; never throws. */
  onApplicationBootstrap(): void {
    void this.bootAll().catch((err) => this.logger.warn(`knowledge install at boot failed: ${err instanceof Error ? err.message : err}`));
  }

  async bootAll(): Promise<number> {
    let written = 0;
    const one = async () => {
      const rows = await this.db.select({ workspaceId: agents.workspaceId }).from(agents).catch(() => [] as Array<{ workspaceId: string }>);
      for (const ws of new Set(rows.map((r) => r.workspaceId).filter(Boolean))) {
        written += (await this.installWorkspace(ws).catch((err) => { this.logger.warn(`knowledge install in ${ws} failed: ${err instanceof Error ? err.message : err}`); return { written: [] as string[] }; })).written.length;
      }
    };
    if (this.accounts) await this.accounts.forEachAccount(one);
    else await one();
    if (written) this.logger.log(`knowledge base: wrote ${written} file(s) under /${LIBRARY_DIR}/`);
    return written;
  }

  // ---- which pack, which scope ----

  /** The authored pack an agent was made from, or null (see the header). */
  async packOf(agent: AgentRow): Promise<string | null> {
    if (agent.packId) return agent.packId;
    const ws = agent.workspaceId
      ? (await this.db.select({ chief: workspaces.chiefOfStaffAgentId }).from(workspaces).where(eq(workspaces.id, agent.workspaceId)).limit(1).catch(() => []))[0]
      : undefined;
    if (ws?.chief === agent.id) return CHIEF_PACK;
    const org = agent.workspaceId
      ? (await this.db.select({ chief: organizations.chiefOfStaffAgentId, auditor: organizations.auditorAgentId }).from(organizations).where(eq(organizations.workspaceId, agent.workspaceId)).limit(1).catch(() => []))[0]
      : undefined;
    if (org?.chief === agent.id) return CHIEF_PACK;
    if (org?.auditor === agent.id) return AUDITOR_PACK;
    const own = new Set((await this.db.select({ name: skills.name }).from(skills).where(eq(skills.agentId, agent.id)).catch(() => [])).map((s) => s.name));
    let best: { id: string; n: number; share: number } | null = null;
    for (const [id, names] of PACK_SKILLS) {
      if (names.size === 0) continue;
      let n = 0;
      for (const s of names) if (own.has(s)) n++;
      if (n < Math.min(2, names.size)) continue;
      const share = n / names.size;
      if (!best || n > best.n || (n === best.n && share > best.share)) best = { id, n, share };
    }
    if (best) return best.id;
    return AUTHORED_PACKS.find((p) => p.name === agent.name)?.id ?? null;
  }

  /** The agent's scope: its role's knowledge base and the shared topics it sees. */
  async scopeOf(agentId: string, now = Date.now()): Promise<KbScope> {
    return (await this.resolve(agentId, now)).scope;
  }

  private async resolve(agentId: string, now = Date.now()): Promise<{ scope: KbScope; packId: string | null; workspaceId: string }> {
    const hit = this.scopes.get(agentId);
    const row = (await this.db.select().from(agents).where(eq(agents.id, agentId)).limit(1).catch(() => []))[0] as (AgentRow & typeof agents.$inferSelect) | undefined;
    if (!row) return { scope: { pack: null, topics: [] }, packId: null, workspaceId: '' };
    if (hit && now - hit.at < SCOPE_TTL_MS) return { scope: hit.scope, packId: hit.packId, workspaceId: row.workspaceId };
    const packId = await this.packOf(row);
    const ws = row.workspaceId ? (await this.db.select({ orgMode: workspaces.orgMode }).from(workspaces).where(eq(workspaces.id, row.workspaceId)).limit(1).catch(() => []))[0] : undefined;
    const company = Boolean(ws && ws.orgMode !== 'off');
    const scope = scopeFor(packId, { company }, this.bundle);
    this.scopes.set(agentId, { scope, packId, at: now });
    return { scope, packId, workspaceId: row.workspaceId };
  }

  /** Forget cached scopes (a hire, a seat change, a test). */
  invalidate(agentId?: string): void {
    if (agentId) this.scopes.delete(agentId); else this.scopes.clear();
  }

  // ---- the library ----

  /** Make sure the agent's library is installed in its workspace. */
  async installFor(agentId: string): Promise<{ written: string[]; removed: string[] }> {
    this.invalidate(agentId);
    const { workspaceId } = await this.resolve(agentId);
    if (!workspaceId) return { written: [], removed: [] };
    return this.installWorkspace(workspaceId);
  }

  /** Called on every turn: installs once per process per version, cheaply. */
  async ensureInstalled(agentId: string): Promise<void> {
    const { scope, workspaceId } = await this.resolve(agentId);
    if (!workspaceId || scopeIsEmpty(scope)) return;
    const sig = this.installed.get(workspaceId) ?? '';
    const need = scopeVersion(scope).split(',').filter(Boolean);
    if (need.every((v) => sig.split(',').includes(v))) return;
    await this.installWorkspace(workspaceId);
  }

  /**
   * Install (or refresh) the library of a workspace: the union of its
   * agents' scopes. Writes only files whose text changed, removes docs an
   * installed folder no longer ships, regenerates /library/README.md.
   */
  async installWorkspace(workspaceId: string): Promise<{ written: string[]; removed: string[] }> {
    // One install per workspace at a time: concurrent turns share it.
    const running = this.inflight.get(workspaceId);
    if (running) return running;
    const p = this.installNow(workspaceId).finally(() => this.inflight.delete(workspaceId));
    this.inflight.set(workspaceId, p);
    return p;
  }

  private async installNow(workspaceId: string): Promise<{ written: string[]; removed: string[] }> {
    const rows = await this.db.select().from(agents).where(eq(agents.workspaceId, workspaceId)) as Array<AgentRow>;
    const packs = new Map<string, KbPack>();
    const topics = new Map<string, KbTopic>();
    for (const a of rows) {
      const { scope } = await this.resolve(a.id);
      if (scope.pack) packs.set(scope.pack.folder, scope.pack);
      for (const t of scope.topics) topics.set(t.topic, t);
    }
    const scope: KbScope = { pack: null, topics: [...topics.values()] };
    const target = new Map<string, string>();
    for (const p of packs.values()) for (const [k, v] of libraryFiles({ pack: p, topics: [] })) target.set(k, v);
    for (const [k, v] of libraryFiles(scope)) target.set(k, v);
    const signature = [...[...packs.values()].map((p) => `${p.folder}@${p.version}`), ...scope.topics.map((t) => `${SHARED_DIR}/${t.topic}@${t.version}`)].sort().join(',');
    if (target.size === 0) { this.installed.set(workspaceId, signature); return { written: [], removed: [] }; }
    const by = WorkspaceFs.system;
    const written: string[] = [];
    const removed: string[] = [];
    // Folders this install owns: a doc there that is no longer shipped goes.
    const owned = new Set([...packs.keys()].map((f) => libraryPath(f)).concat(scope.topics.map((t) => libraryPath(`${SHARED_DIR}/${t.topic}`))));
    const existing = await this.fs.list(workspaceId, LIBRARY_DIR).catch(() => []);
    for (const f of existing) {
      const dir = f.path.slice(0, f.path.lastIndexOf('/'));
      if (owned.has(dir) && !target.has(f.path)) {
        await this.fs.delete(workspaceId, f.path, { by }).catch(() => undefined);
        removed.push(f.path);
      }
    }
    for (const [path, text] of target) {
      const cur = await this.fs.read(workspaceId, path).catch(() => null);
      if (cur && cur.body.toString('utf8') === text) continue;
      await this.fs.write(workspaceId, path, Buffer.from(text, 'utf8'), { by, contentType: 'text/markdown' });
      written.push(path);
    }
    // The index lists every folder present, including one from an earlier install.
    const present = new Set((await this.fs.list(workspaceId, LIBRARY_DIR).catch(() => [])).map((f) => f.path.split('/')[1]));
    const allPacks = Object.values(this.bundle.packs).filter((p) => packs.has(p.folder) || present.has(p.folder));
    const sharedPresent = new Set((await this.fs.list(workspaceId, `${LIBRARY_DIR}/${SHARED_DIR}`).catch(() => [])).map((f) => f.path.split('/')[2]));
    const allTopics = Object.values(this.bundle.shared).filter((t) => topics.has(t.topic) || sharedPresent.has(t.topic));
    const index = libraryIndex(allPacks, allTopics);
    const indexPath = `${LIBRARY_DIR}/README.md`;
    const cur = await this.fs.read(workspaceId, indexPath).catch(() => null);
    if (!cur || cur.body.toString('utf8') !== index) {
      await this.fs.write(workspaceId, indexPath, Buffer.from(index, 'utf8'), { by, contentType: 'text/markdown' });
      written.push(indexPath);
    }
    this.installed.set(workspaceId, signature);
    return { written, removed };
  }

  // ---- the agent page ----

  /** Null when the agent is not found (in this account). */
  async forAgent(agentId: string): Promise<AgentKnowledge | null> {
    const { scope, packId, workspaceId } = await this.resolve(agentId);
    if (!workspaceId && !(await this.db.select({ id: agents.id }).from(agents).where(eq(agents.id, agentId)).limit(1).catch(() => [])).length) return null;
    const doc = (d: { path: string; title: string; summary: string }) => ({ path: d.path, file: `/${libraryPath(d.path)}`, title: d.title, summary: d.summary });
    return {
      packId,
      packName: scope.pack?.packName ?? (packId ? AUTHORED_PACKS.find((p) => p.id === packId)?.name ?? null : null),
      folder: scope.pack?.folder ?? null,
      summary: scope.pack?.summary ?? '',
      docs: (scope.pack?.docs ?? []).map(doc),
      shared: scope.topics.map((t) => ({ topic: t.topic, docs: t.docs.map(doc) })),
      version: scopeVersion(scope),
    };
  }

  /** Every doc the agent may search (for the tools). */
  async docsOf(agentId: string) {
    return scopeDocs(await this.scopeOf(agentId));
  }

  /** Agents of a workspace with a given pack (tests, diagnostics). */
  async agentsWithPack(workspaceId: string, packId: string): Promise<string[]> {
    const rows = await this.db.select({ id: agents.id }).from(agents).where(and(eq(agents.workspaceId, workspaceId), eq(agents.packId, packId)));
    return rows.map((r) => r.id);
  }
}
