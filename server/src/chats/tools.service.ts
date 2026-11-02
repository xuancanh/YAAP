/**
 * ToolsService — the tool families offered to the model inside the turn loop
 * (FR-3.3, first slice): file tools over the workspace filesystem
 * (docs/filesystem.md — homes, shared folders, versions), web research, and a
 * raw HTTP tool. Each tool declares `readOnly`, which drives the Ask-mode policy
 * (FR-4.2): read-only runs automatically, everything else pauses for
 * approval. Unknown tools and malformed arguments throw — refused, never
 * executed (FR-3.4).
 *
 * MCP-discovered tools and skills (§10) will register into this same shape.
 */
import { Injectable, Optional } from '@nestjs/common';
import { StorageService } from '../storage/storage.service';
import { workspaceFileKey } from '../storage/storage.keys';
import { WorkspaceFs, resolvePath, displayPath, ago, type FileRoot, type FsActor, type FileEntry } from '../files/workspace-fs.service';
import { actorId, currentViewer } from '../accounts/account-context';
import { AiToolSpec } from '../ai/ai-provider.interface';
import { fetchPublic } from '../common/url-guard';
import { validateSlides, renderSlidesHtml } from './slides.util';

const READ_CAP = 50_000;
const HTTP_CAP = 20_000;
const SEARCH_FILE_CAP = 200_000;
const SEARCH_MAX_FILES = 200;
const SEARCH_MAX_HITS = 40;
const FETCH_CAP = 30_000;

/** Crude but dependency-free HTML → readable text: drop script/style, strip
 *  tags, collapse whitespace. Good enough for research fetches. */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

// Where a chat's file tools operate, and how paths resolve there, is the
// workspace filesystem's (docs/filesystem.md); re-exported for the turn loop
// and the browser, which store into the same root.
export type { FileRoot } from '../files/workspace-fs.service';
export { fileRootKey } from '../files/workspace-fs.service';

const LIST_CAP = 500;

/** The actor a root writes as: its agent, else the person in the chat. */
function actorOf(root: FileRoot): FsActor {
  return root.actor ?? { kind: 'user', id: actorId(), name: currentViewer()?.displayName || 'user' };
}

/** Optional integer `expectedVersion`. */
function expectedVersion(input: Record<string, unknown>): number | undefined {
  const v = input.expectedVersion;
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new Error('invalid arguments: "expectedVersion" must be a non-negative integer');
  return v;
}

function textArg(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  if (typeof v !== 'string') throw new Error(`invalid arguments: "${key}" must be a string`);
  return v;
}

/** `/path (n bytes)`, plus version and last editor when known. */
function fileLine(f: FileEntry): string {
  return `${displayPath(f.path)} (${f.size} bytes)${f.version ? ` · v${f.version}${f.updatedBy?.name ? ` · ${f.updatedBy.name}` : ''}` : ''}`;
}

const VERSION_HINT = 'Pass expectedVersion (from fs_read\'s header) when changing a file others may edit: if someone wrote it since, the call fails and you re-read and merge instead of overwriting their work.';

interface ChatTool extends AiToolSpec {
  readOnly: boolean;
  execute(root: FileRoot, input: Record<string, unknown>): Promise<string>;
}

function str(input: Record<string, unknown>, key: string, required = true): string {
  const v = input[key];
  if (typeof v === 'string' && v.length > 0) return v;
  if (!required && (v === undefined || v === null)) return '';
  throw new Error(`invalid arguments: "${key}" must be a non-empty string`);
}

@Injectable()
export class ToolsService {
  private readonly tools: ChatTool[];
  private readonly fs: WorkspaceFs;

  constructor(
    private readonly storage: StorageService,
    /** Optional so test constructors from storage alone keep working: they
     *  get an unversioned filesystem over the same storage. */
    @Optional() fs?: WorkspaceFs,
  ) {
    this.fs = fs ?? new WorkspaceFs(storage);
    this.tools = [
      {
        name: 'fs_list',
        description: 'List files in the workspace filesystem. Without a prefix: your home folder (and your assigned folder, if any). "/" lists the top level of the workspace (one line per folder); any other path lists that folder. Paths print absolute (e.g. /org/plan.md) so you can pass them on. Relative paths and ~/ mean your home; /… is the workspace root.',
        inputSchema: { type: 'object', properties: { prefix: { type: 'string', description: 'Folder to list: "/" for the top level, "/org", "~/knowledge", "notes" …' } } },
        readOnly: true,
        execute: async (root, input) => {
          const prefix = typeof input.prefix === 'string' ? input.prefix.trim() : '';
          if (prefix === '/' || (!prefix && !root.home)) return this.listTop(root, prefix === '/');
          const rows = await this.listUnder(root, prefix ? resolvePath(root, prefix) : root.home);
          if (!prefix && root.sharedFolder) rows.push(...await this.listUnder(root, root.sharedFolder));
          if (rows.length === 0) return '(no files)';
          const lines = rows.slice(0, LIST_CAP).map(fileLine);
          if (rows.length > LIST_CAP) lines.push(`…and ${rows.length - LIST_CAP} more — list a subfolder`);
          return lines.join('\n');
        },
      },
      {
        name: 'fs_read',
        description: 'Read a text file. The first line is a header with the file\'s version and last editor, e.g. "[version 4 · last edited by Ada, 2m ago]" — pass that version as expectedVersion to fs_write / fs_edit.',
        inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'notes.md (your home), /org/plan.md (workspace root)' } }, required: ['path'] },
        readOnly: true,
        execute: async (root, input) => {
          const path = resolvePath(root, str(input, 'path'));
          const file = await this.fs.read(root.workspaceId, path);
          if (file === null) return `file not found: ${displayPath(path)}`;
          const text = file.body.toString('utf8');
          const capped = text.length > READ_CAP ? `${text.slice(0, READ_CAP)}\n…(truncated)` : text;
          if (!this.fs.versioned) return capped;
          const header = file.meta
            ? `[version ${file.meta.version} · last edited by ${file.meta.updatedBy.name || file.meta.updatedBy.kind}, ${ago(file.meta.updatedAt)}]`
            : '[version 0 · not yet edited through the file tools]';
          return `${header}\n${capped}`;
        },
      },
      {
        name: 'fs_write',
        description: `Write (create or overwrite) a text file. Relative paths land in your home folder; write shared work to a shared folder such as /org/… or /channels/<slug>/…. You cannot write other agents' homes (/agents/<name>/) or any .checkpoints/ folder. ${VERSION_HINT}`,
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            content: { type: 'string' },
            expectedVersion: { type: 'integer', description: 'The version you read; 0 = the file must not exist yet' },
          },
          required: ['path', 'content'],
        },
        readOnly: false,
        execute: async (root, input) => {
          const path = resolvePath(root, str(input, 'path'));
          const content = typeof input.content === 'string' ? input.content : null;
          if (content === null) throw new Error('invalid arguments: "content" must be a string');
          const meta = await this.fs.write(root.workspaceId, path, Buffer.from(content, 'utf8'), { by: actorOf(root), expectedVersion: expectedVersion(input) });
          return `wrote ${Buffer.byteLength(content)} bytes to ${displayPath(path)}${meta.version ? ` (version ${meta.version})` : ''}`;
        },
      },
      {
        name: 'fs_edit',
        description: `Change part of a text file: replace the exact text "old" (it must occur exactly once — include enough surrounding text) with "new". The collaborative way to edit a shared file without rewriting it. ${VERSION_HINT}`,
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            old: { type: 'string', description: 'Exact text to replace (must match once)' },
            new: { type: 'string', description: 'Replacement text ("" deletes)' },
            expectedVersion: { type: 'integer' },
          },
          required: ['path', 'old', 'new'],
        },
        readOnly: false,
        execute: async (root, input) => {
          const path = resolvePath(root, str(input, 'path'));
          const meta = await this.fs.edit(root.workspaceId, path, textArg(input, 'old'), textArg(input, 'new'), { by: actorOf(root), expectedVersion: expectedVersion(input) });
          return `edited ${displayPath(path)}${meta.version ? ` (now version ${meta.version})` : ''}`;
        },
      },
      {
        name: 'fs_append',
        description: 'Append text to a file (created if missing) — for logs, meeting notes and shared lists several writers add to. Needs no version: appends never overwrite anyone.',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' }, content: { type: 'string' } },
          required: ['path', 'content'],
        },
        readOnly: false,
        execute: async (root, input) => {
          const path = resolvePath(root, str(input, 'path'));
          const content = textArg(input, 'content');
          const meta = await this.fs.append(root.workspaceId, path, content, { by: actorOf(root) });
          return `appended ${Buffer.byteLength(content)} bytes to ${displayPath(path)}${meta.version ? ` (now version ${meta.version})` : ''}`;
        },
      },
      {
        name: 'fs_delete',
        description: 'Delete a file (your home or a shared folder; never another agent\'s home or .checkpoints/).',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        readOnly: false,
        execute: async (root, input) => {
          const path = resolvePath(root, str(input, 'path'));
          await this.fs.delete(root.workspaceId, path, { by: actorOf(root) });
          return `deleted ${displayPath(path)}`;
        },
      },
      {
        name: 'fs_search',
        description: 'Search text file contents. Searches your home (and assigned folder) unless a prefix names another folder ("/" = the whole workspace). Returns matching lines as "/path:line: text".',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Case-insensitive substring to find' },
            prefix: { type: 'string', description: 'Folder to search, e.g. "/org" or "/"' },
          },
          required: ['query'],
        },
        readOnly: true,
        execute: async (root, input) => {
          const query = str(input, 'query').toLowerCase();
          const prefix = typeof input.prefix === 'string' ? input.prefix.trim() : '';
          const scope = prefix ? [resolvePath(root, prefix)] : [root.home, ...(root.sharedFolder ? [root.sharedFolder] : [])];
          const rows: FileEntry[] = [];
          for (const dir of scope) rows.push(...await this.listUnder(root, dir));
          const hits: string[] = [];
          for (const obj of rows.slice(0, SEARCH_MAX_FILES)) {
            if (obj.size > SEARCH_FILE_CAP) continue;
            const body = await this.storage.get(workspaceFileKey(root.workspaceId, obj.path));
            if (!body || body.includes(0)) continue; // skip binary
            const lines = body.toString('utf8').split('\n');
            for (let i = 0; i < lines.length && hits.length < SEARCH_MAX_HITS; i++) {
              if (lines[i].toLowerCase().includes(query)) {
                hits.push(`${displayPath(obj.path)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
              }
            }
            if (hits.length >= SEARCH_MAX_HITS) break;
          }
          return hits.length > 0 ? hits.join('\n') : `no matches for "${input.query}"`;
        },
      },
      {
        name: 'web_search',
        description: 'Search the web. Returns result titles, URLs and snippets. Follow up with web_fetch to read a result.',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
        readOnly: true,
        execute: async (_root, input) => {
          const query = str(input, 'query');
          const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
            headers: { 'user-agent': 'Mozilla/5.0 (yaam-chat research tool)' },
            signal: AbortSignal.timeout(15_000),
          });
          if (!res.ok) return `search failed: ${res.status} ${res.statusText}`;
          const html = await res.text();
          const results: string[] = [];
          const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g;
          for (let m = re.exec(html); m && results.length < 8; m = re.exec(html)) {
            let url = m[1];
            const redirect = /uddg=([^&]+)/.exec(url);
            if (redirect) url = decodeURIComponent(redirect[1]);
            results.push(`${htmlToText(m[2])}\n  ${url}${m[3] ? `\n  ${htmlToText(m[3]).slice(0, 200)}` : ''}`);
          }
          return results.length > 0 ? results.join('\n\n') : 'no results (the search backend may be rate-limiting; try a different query)';
        },
      },
      {
        name: 'web_fetch',
        description: 'Fetch a public web page and return its readable text content (HTML is stripped).',
        inputSchema: {
          type: 'object',
          properties: { url: { type: 'string' } },
          required: ['url'],
        },
        readOnly: true,
        execute: async (_root, input) => {
          const res = await fetchPublic(str(input, 'url'), {
            headers: { 'user-agent': 'Mozilla/5.0 (yaam-chat research tool)' },
            signal: AbortSignal.timeout(20_000),
          });
          if (!res.ok) return `fetch failed: ${res.status} ${res.statusText}`;
          const raw = await res.text();
          const type = res.headers.get('content-type') ?? '';
          const text = type.includes('html') ? htmlToText(raw) : raw;
          return text.length > FETCH_CAP ? `${text.slice(0, FETCH_CAP)}\n…(truncated)` : text;
        },
      },
      {
        name: 'slides_create',
        description: 'Create a self-contained HTML slide deck (relative paths land in your home). Slides: [{ title, bullets?, notes? }]. Arrow keys navigate; "n" toggles notes.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Target path, e.g. slides/quarterly-review.html' },
            title: { type: 'string' },
            slides: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  title: { type: 'string' },
                  bullets: { type: 'array', items: { type: 'string' } },
                  notes: { type: 'string' },
                },
                required: ['title'],
              },
            },
          },
          required: ['path', 'title', 'slides'],
        },
        readOnly: false,
        execute: async (root, input) => {
          const path = resolvePath(root, str(input, 'path'));
          const { title, slides } = validateSlides(input.title, input.slides);
          const html = renderSlidesHtml(title, slides);
          await this.fs.write(root.workspaceId, path, Buffer.from(html, 'utf8'), { by: actorOf(root), contentType: 'text/html' });
          return `created a ${slides.length}-slide deck "${title}" at ${displayPath(path)} (${Buffer.byteLength(html)} bytes)`;
        },
      },
      {
        name: 'http_request',
        description: 'Perform a raw HTTP request to a public URL. Returns status line and response body (truncated).',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            method: { type: 'string', description: 'GET (default), POST, PUT, PATCH, DELETE, HEAD' },
            headers: { type: 'object' },
            body: { type: 'string' },
          },
          required: ['url'],
        },
        readOnly: false,
        execute: async (_root, input) => {
          const method = (str(input, 'method', false) || 'GET').toUpperCase();
          const headers = (input.headers && typeof input.headers === 'object' ? input.headers : {}) as Record<string, string>;
          const res = await fetchPublic(str(input, 'url'), {
            method,
            headers,
            body: typeof input.body === 'string' && method !== 'GET' && method !== 'HEAD' ? input.body : undefined,
            signal: AbortSignal.timeout(30_000),
          });
          const text = await res.text();
          const capped = text.length > HTTP_CAP ? `${text.slice(0, HTTP_CAP)}\n…(truncated)` : text;
          return `${res.status} ${res.statusText}\n${capped}`;
        },
      },
    ];
  }

  /** Every file under a workspace folder ('' = the whole workspace), or the
   *  one file the path names. */
  private async listUnder(root: FileRoot, dir: string): Promise<FileEntry[]> {
    const rows = await this.fs.list(root.workspaceId, dir);
    if (rows.length > 0 || !dir) return rows;
    const parent = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '';
    return (await this.fs.list(root.workspaceId, parent)).filter((f) => f.path === dir);
  }

  /** The top level of the workspace: one line per folder (collapsed), or
   *  every file when a chat with no agent lists its root. */
  private async listTop(root: FileRoot, collapse: boolean): Promise<string> {
    const rows = await this.fs.list(root.workspaceId, '');
    if (rows.length === 0) return '(no files)';
    if (!collapse) {
      const lines = rows.slice(0, LIST_CAP).map(fileLine);
      if (rows.length > LIST_CAP) lines.push(`…and ${rows.length - LIST_CAP} more — fs_list "/" for the top level, then a folder`);
      return lines.join('\n');
    }
    const folders = new Map<string, number>();
    const files: FileEntry[] = [];
    for (const r of rows) {
      const slash = r.path.indexOf('/');
      if (slash < 0) files.push(r);
      else folders.set(r.path.slice(0, slash), (folders.get(r.path.slice(0, slash)) ?? 0) + 1);
    }
    const home = root.home ? root.home.split('/')[0] : '';
    return [
      ...[...folders].map(([name, n]) => `/${name}/ (${n} file${n === 1 ? '' : 's'})${name === home ? ' — your home is inside' : ''}`),
      ...files.map(fileLine),
    ].join('\n');
  }

  specs(): AiToolSpec[] {
    return this.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  }

  /** undefined = unknown tool. */
  isReadOnly(name: string): boolean | undefined {
    return this.tools.find((t) => t.name === name)?.readOnly;
  }

  /** A bare string is a workspace id: a chat with no agent, at the root
   *  (test convenience + back-compat). */
  async execute(root: FileRoot | string, name: string, input: Record<string, unknown>): Promise<string> {
    const tool = this.tools.find((t) => t.name === name);
    if (!tool) throw new Error(`unknown tool: ${name}`);
    return tool.execute(typeof root === 'string' ? { workspaceId: root, home: '' } : root, input);
  }
}
