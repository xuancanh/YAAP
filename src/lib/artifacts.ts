/**
 * Artifacts (docs/filesystem.md): the workspace tree as the UI groups it,
 * the file sources the viewer reads and writes through, and the small pure
 * helpers the rich viewer needs (CSV parsing, kind detection, conflicts).
 */
import { api, ApiError, type Agent, type FileAuthor, type FileEntry, type FilePreview, type FileRevision } from './api';

// ---------------------------------------------------------------- the tree

export interface TreeNode {
  /** Last path segment. */
  name: string;
  /** The path the source knows it by (workspace-relative for workspace sources). */
  path: string;
  isFolder: boolean;
  children: TreeNode[];
  entry?: FileEntry;
}

/** Folder markers written by "New folder"; hidden from the tree. */
export const KEEP_FILE = '.keep';

/** `/agents/ada/` → `agents/ada`. */
export const normPath = (p: string | null | undefined): string => (p ?? '').replace(/^\/+/, '').replace(/\/+$/, '');

/**
 * The order /org/'s children are shown in — a mirror of ORG_ORDER in
 * server/src/files/layout.ts (docs/filesystem.md "Layout"): the index, how
 * the company runs, its goals and rhythm, the chief's packs, the ledger, the
 * function folders, then the record mirrors and the archive. Anything else
 * follows, folders first, alphabetically.
 */
export const ORG_ORDER: readonly string[] = [
  'README.md', 'operating-system.md', 'calendar.md', 'goals', 'meetings', 'rituals', 'reports', 'briefs', 'planning',
  'decisions.md', 'scorecard.md', 'issues.md', 'risks.md', 'handoffs.md', 'values.md', 'proposals',
  'sales', 'marketing', 'cs', 'product', 'engineering', 'design', 'data', 'finance', 'people', 'legal', 'ops', 'it-security', 'revops',
  'playbooks', 'experiments', 'evals', 'outcomes.md', 'metrics.md', 'archive',
];
/** The company folder's index, pinned at the top of Shared. */
export const ORG_README = 'org/README.md';

const byFolderThenName = (a: TreeNode, b: TreeNode): number => (a.isFolder === b.isFolder ? a.name.localeCompare(b.name) : a.isFolder ? -1 : 1);
const orgRank = (n: TreeNode): number => { const i = ORG_ORDER.indexOf(n.name); return i < 0 ? ORG_ORDER.length : i; };

/** A nested tree of `entries` under `root` (''/undefined = everything).
 *  Folders first, then files, each alphabetical — except /org/'s children,
 *  which follow ORG_ORDER; `.keep` markers create their folder but never show. */
export function buildTree(entries: FileEntry[], root = ''): TreeNode[] {
  const base = normPath(root);
  const top: TreeNode = { name: '', path: base, isFolder: true, children: [] };
  const folders = new Map<string, TreeNode>();
  for (const e of entries) {
    const path = normPath(e.path);
    if (base && !path.startsWith(`${base}/`)) continue;
    const parts = (base ? path.slice(base.length + 1) : path).split('/');
    let parent = top;
    for (let i = 0; i < parts.length - 1; i++) {
      const fp = [base, ...parts.slice(0, i + 1)].filter(Boolean).join('/');
      let f = folders.get(fp);
      if (!f) {
        f = { name: parts[i], path: fp, isFolder: true, children: [] };
        folders.set(fp, f);
        parent.children.push(f);
      }
      parent = f;
    }
    const name = parts[parts.length - 1];
    if (name === KEEP_FILE || !name) continue;
    parent.children.push({ name, path, isFolder: false, children: [], entry: e });
  }
  const sort = (n: TreeNode) => {
    n.children.sort(n.path === 'org' ? (a, b) => orgRank(a) - orgRank(b) || byFolderThenName(a, b) : byFolderThenName);
    n.children.forEach(sort);
  };
  sort(top);
  return top.children;
}

export interface AgentHome { node: TreeNode; agent: Agent | null; label: string }
export interface GroupedTree { shared: TreeNode[]; agents: AgentHome[]; pinned: TreeNode[] }

/** The Artifacts rail's two groups: **Shared** (every top-level folder but
 *  `agents/`, plus root files) and **Agents** (each `agents/<handle>/`,
 *  matched to its agent by `homeDir`; unmatched homes keep the folder name).
 *  `pinned` holds /org/README.md, the company folder's index, when it exists. */
export function groupTree(nodes: TreeNode[], agents: Agent[]): GroupedTree {
  // /org/ — the company's shared folder, where its records are mirrored
  // (docs/filesystem.md) — leads the Shared group.
  const shared = nodes.filter((n) => !(n.isFolder && n.path === 'agents'))
    .sort((a, b) => Number(b.isFolder && b.path === 'org') - Number(a.isFolder && a.path === 'org'));
  const agentsDir = nodes.find((n) => n.isFolder && n.path === 'agents');
  const homes: AgentHome[] = (agentsDir?.children ?? []).filter((n) => n.isFolder).map((node) => {
    const agent = agents.find((a) => normPath(a.homeDir) === node.path) ?? null;
    return { node, agent, label: agent?.name ?? node.name };
  });
  homes.sort((a, b) => a.label.localeCompare(b.label));
  const readme = nodes.find((n) => n.isFolder && n.path === 'org')?.children.find((n) => !n.isFolder && n.path === ORG_README);
  return { shared, agents: homes, pinned: readme ? [readme] : [] };
}

/** The agent whose home holds `path`, if any (`agents/<handle>/…`). */
export function ownerOf(path: string, agents: Agent[], entry?: FileEntry): Agent | null {
  if (entry?.owner?.agentId) {
    const a = agents.find((x) => x.id === entry.owner!.agentId);
    if (a) return a;
  }
  const p = normPath(path);
  if (!p.startsWith('agents/')) return null;
  const home = p.split('/').slice(0, 2).join('/');
  return agents.find((a) => normPath(a.homeDir) === home) ?? null;
}

/** Every ancestor folder of `path` (not the path itself). */
export const ancestors = (path: string): string[] => {
  const parts = normPath(path).split('/');
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'));
};

/** Direct children of `folder` ('' = root), as tree nodes. */
export function childrenOf(entries: FileEntry[], folder: string): TreeNode[] {
  const f = normPath(folder);
  if (!f) return buildTree(entries);
  const find = (nodes: TreeNode[]): TreeNode | null => {
    for (const n of nodes) {
      if (n.path === f) return n;
      if (n.isFolder && f.startsWith(`${n.path}/`)) return find(n.children);
    }
    return null;
  };
  return find(buildTree(entries))?.children ?? [];
}

// ---------------------------------------------------------- viewer kinds

export type ViewKind = 'markdown' | 'csv' | 'tsv' | 'json' | 'code' | 'text' | 'html' | 'image' | 'pdf' | 'audio' | 'binary';

const CODE_EXT = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs',
  'php', 'sh', 'bash', 'zsh', 'sql', 'css', 'scss', 'less', 'xml', 'yaml', 'yml', 'toml', 'ini', 'env', 'lua', 'r', 'dart',
  'vue', 'svelte', 'graphql', 'proto', 'dockerfile', 'makefile', 'jsonl', 'ndjson',
]);

export const extOf = (name: string): string => {
  const base = name.split('/').pop() ?? name;
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? base.toLowerCase() : base.slice(dot + 1).toLowerCase();
};

/** How the viewer renders a file: by preview kind first, then extension. */
export function viewKind(name: string, preview: Pick<FilePreview, 'kind' | 'contentType'>): ViewKind {
  if (preview.kind === 'image' || preview.kind === 'pdf' || preview.kind === 'audio' || preview.kind === 'binary' || preview.kind === 'html') return preview.kind;
  const ext = extOf(name);
  if (preview.kind === 'markdown' || ext === 'md' || ext === 'markdown' || ext === 'mdx') return 'markdown';
  if (ext === 'csv' || preview.contentType.startsWith('text/csv')) return 'csv';
  if (ext === 'tsv' || preview.contentType.startsWith('text/tab-separated-values')) return 'tsv';
  if (ext === 'json' || preview.contentType.startsWith('application/json')) return 'json';
  if (CODE_EXT.has(ext)) return 'code';
  return 'text';
}

/** Text kinds open in the editor (a truncated preview never does — saving it
 *  would cut the file). */
export const isTextKind = (k: ViewKind): boolean => k === 'markdown' || k === 'csv' || k === 'tsv' || k === 'json' || k === 'code' || k === 'text' || k === 'html';

export const contentTypeFor = (name: string): string => {
  const ext = extOf(name);
  return ({ md: 'text/markdown', markdown: 'text/markdown', csv: 'text/csv', tsv: 'text/tab-separated-values', json: 'application/json', html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', svg: 'image/svg+xml' } as Record<string, string>)[ext] ?? 'text/plain';
};

export const glyphFor = (name: string, isFolder = false): string => {
  if (isFolder) return '📁';
  const ext = extOf(name);
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext)) return '🖼️';
  if (['mp3', 'm4a', 'wav', 'webm', 'ogg', 'aac', 'opus'].includes(ext)) return '🎙️';
  if (ext === 'html' || ext === 'htm') return '🧩';
  if (ext === 'json') return '⚙️';
  if (ext === 'csv' || ext === 'tsv') return '📊';
  if (ext === 'pdf') return '📕';
  if (CODE_EXT.has(ext)) return '📜';
  return '📄';
};

// ------------------------------------------------------------- CSV / TSV

/** RFC 4180-ish: quoted fields, doubled quotes, newlines inside quotes, CRLF. */
export function parseDelimited(text: string, sep = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === sep) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else field += c;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

/** Numbers sort numerically, everything else by locale; blanks last. */
export function compareCells(a: string, b: string): number {
  if (a === b) return 0;
  if (a === '') return 1;
  if (b === '') return -1;
  const na = Number(a.replace(/[,$%\s]/g, ''));
  const nb = Number(b.replace(/[,$%\s]/g, ''));
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

// --------------------------------------------------------------- conflicts

export interface ConflictInfo { version?: number; by?: string }

export const isConflict = (e: unknown): e is ApiError => e instanceof ApiError && e.status === 409;

/** What the 409 body says about the newer version, best effort. */
export function parseConflict(e: unknown): ConflictInfo {
  if (!(e instanceof ApiError)) return {};
  try {
    const b = JSON.parse(e.body) as Record<string, unknown>;
    const inner = (typeof b.message === 'object' && b.message ? b.message : b) as Record<string, unknown>;
    const v = inner.currentVersion ?? inner.version;
    const by = inner.updatedBy as FileAuthor | string | undefined;
    return { version: typeof v === 'number' ? v : undefined, by: typeof by === 'string' ? by : by?.name };
  } catch { return {}; }
}

// ----------------------------------------------------------------- misc

/** UTF-8 safe base64 for text bodies. */
export function textToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function relTime(iso: string | undefined | null, now = Date.now()): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const m = Math.floor((now - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** The author of a `file.changed` event, as a display name. */
export const authorName = (by: FileAuthor | string | null | undefined): string => (typeof by === 'string' ? by : by?.name) || 'Someone';

// ------------------------------------------------------- create actions

/** Ask for a name and create an empty file under `folder`; returns its path. */
export async function createFile(source: FileSource, folder: string, toast: (m: string) => void): Promise<string | null> {
  const prefix = normPath(folder);
  const name = window.prompt(`New file in ${prefix ? `/${prefix}/` : '/'}`, 'notes.md')?.trim();
  if (!name) return null;
  const path = [prefix, normPath(name)].filter(Boolean).join('/');
  try { await source.write(path, ''); toast(`Created ${path.split('/').pop()}`); return path; } catch (e) { toast(e instanceof Error ? e.message.slice(0, 120) : 'Could not create the file'); return null; }
}

/** Folders exist by their contents, so a new one gets a `.keep` marker. */
export async function createFolder(source: FileSource, folder: string, toast: (m: string) => void): Promise<string | null> {
  const prefix = normPath(folder);
  const name = window.prompt(`New folder in ${prefix ? `/${prefix}/` : '/'}`, 'new-folder')?.trim();
  if (!name) return null;
  const path = [prefix, normPath(name)].filter(Boolean).join('/');
  try { await source.write(`${path}/${KEEP_FILE}`, ''); toast(`Created ${path.split('/').pop()}/`); return path; } catch (e) { toast(e instanceof Error ? e.message.slice(0, 120) : 'Could not create the folder'); return null; }
}

// ----------------------------------------------------------------- sources

/** Where the viewer reads and writes. Optional methods are features the
 *  source may lack (the agent routes have no history/move/delete). */
export interface FileSource {
  key: string;
  /** Workspace whose event stream carries this source's `file.changed`. */
  workspaceId?: string;
  list(): Promise<FileEntry[]>;
  preview(path: string): Promise<FilePreview>;
  write(path: string, text: string, expectedVersion?: number): Promise<{ version?: number }>;
  revisions?(path: string): Promise<FileRevision[]>;
  revision?(path: string, version: number): Promise<FilePreview>;
  restore?(path: string, version: number): Promise<unknown>;
  move?(from: string, to: string): Promise<unknown>;
  remove?(path: string): Promise<unknown>;
  /** Map a workspace-relative event path to this source's path (null = not ours). */
  fromWorkspacePath(path: string): string | null;
}

export function workspaceSource(wsId: string): FileSource {
  return {
    key: `ws:${wsId}`,
    workspaceId: wsId,
    list: () => api.wsFiles(wsId),
    preview: (p) => api.wsPreview(wsId, p),
    write: (p, text, expectedVersion) => api.wsWriteFile(wsId, { path: p, contentBase64: textToBase64(text), contentType: contentTypeFor(p), expectedVersion }),
    revisions: (p) => api.wsFileRevisions(wsId, p),
    revision: (p, v) => api.wsFileRevision(wsId, p, v),
    restore: (p, v) => api.wsRestoreFile(wsId, p, v),
    move: (from, to) => api.wsMoveFile(wsId, from, to),
    remove: (p) => api.wsDeleteFile(wsId, p),
    fromWorkspacePath: (p) => normPath(p),
  };
}

/** The legacy agent routes (paths relative to the agent's home). */
export function agentSource(agentId: string, wsId?: string, homeDir?: string | null): FileSource {
  const home = normPath(homeDir);
  return {
    key: `agent:${agentId}`,
    workspaceId: wsId,
    list: () => api.agentFiles(agentId, wsId),
    preview: (p) => api.agentPreview(agentId, p, wsId),
    write: (p, text, expectedVersion) => api.agentWriteFile(agentId, { path: p, contentBase64: textToBase64(text), contentType: contentTypeFor(p), expectedVersion }),
    fromWorkspacePath: (p) => {
      const n = normPath(p);
      return home && n.startsWith(`${home}/`) ? n.slice(home.length + 1) : null;
    },
  };
}
