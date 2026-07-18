/**
 * ToolsService — the tool families offered to the model inside the turn loop
 * (FR-3.3, first slice): workspace-file tools over the S3 store, and a raw
 * HTTP tool. Each tool declares `readOnly`, which drives the Ask-mode policy
 * (FR-4.2): read-only runs automatically, everything else pauses for
 * approval. Unknown tools and malformed arguments throw — refused, never
 * executed (FR-3.4).
 *
 * MCP-discovered tools and skills (§10) will register into this same shape.
 */
import { Injectable } from '@nestjs/common';
import { StorageService } from '../storage/storage.service';
import { workspaceFileKey, workspacePrefix, relativePath, agentFileKey, agentPrefix, agentRelativePath } from '../storage/storage.keys';
import { AiToolSpec } from '../ai/ai-provider.interface';
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

/** Where a chat's file tools operate: a durable agent works in its own
 *  working folder (agents/<id>/, which includes its brain files); direct
 *  chats use the shared workspace store. */
export interface FileRoot { kind: 'workspace' | 'agent'; id: string }

export function fileRootKey(root: FileRoot, path: string): string {
  return root.kind === 'agent' ? agentFileKey(root.id, path) : workspaceFileKey(root.id, path);
}
function rootPrefix(root: FileRoot): string {
  return root.kind === 'agent' ? agentPrefix(root.id) : workspacePrefix(root.id);
}
function rootRelative(root: FileRoot, key: string): string {
  return root.kind === 'agent' ? agentRelativePath(root.id, key) : relativePath(root.id, key);
}
/** Checkpoints are the rollback safety net; the agent must not be able to
 *  erase its own history (phase 3 invariant). */
function assertMutablePath(root: FileRoot, path: string): void {
  if (root.kind === 'agent' && path.replace(/^\/+/, '').startsWith('.checkpoints/')) {
    throw new Error('the .checkpoints/ folder is read-only — it is your rollback history');
  }
}

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

/** Reject obviously internal targets so the model cannot probe the host's
 *  network through the raw HTTP tool (basic SSRF guard; a full allowlist is
 *  follow-up policy work). */
function assertPublicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('invalid arguments: "url" is not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('only http/https URLs are allowed');
  }
  const host = url.hostname.toLowerCase();
  if (
    host === 'localhost' || host === '0.0.0.0' || host.endsWith('.local') ||
    /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host === '::1' || host === '[::1]'
  ) {
    throw new Error('requests to private/internal hosts are not allowed');
  }
  return url;
}

@Injectable()
export class ToolsService {
  private readonly tools: ChatTool[];

  constructor(private readonly storage: StorageService) {
    this.tools = [
      {
        name: 'fs_list',
        description: 'List files in your file store (your own working folder when you are a durable agent). Returns one "path (size bytes)" per line.',
        inputSchema: { type: 'object', properties: { prefix: { type: 'string', description: 'Optional path prefix filter' } } },
        readOnly: true,
        execute: async (root, input) => {
          const prefix = typeof input.prefix === 'string' && input.prefix.length > 0
            ? fileRootKey(root, input.prefix)
            : rootPrefix(root);
          const objects = await this.storage.list(prefix);
          if (objects.length === 0) return '(no files)';
          return objects.map((o) => `${rootRelative(root, o.key)} (${o.size} bytes)`).join('\n');
        },
      },
      {
        name: 'fs_read',
        description: 'Read a text file from your file store.',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        readOnly: true,
        execute: async (root, input) => {
          const body = await this.storage.get(fileRootKey(root, str(input, 'path')));
          if (body === null) return `file not found: ${input.path}`;
          const text = body.toString('utf8');
          return text.length > READ_CAP ? `${text.slice(0, READ_CAP)}\n…(truncated)` : text;
        },
      },
      {
        name: 'fs_write',
        description: 'Write (create or overwrite) a text file in your file store.',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' }, content: { type: 'string' } },
          required: ['path', 'content'],
        },
        readOnly: false,
        execute: async (root, input) => {
          const path = str(input, 'path');
          assertMutablePath(root, path);
          const content = typeof input.content === 'string' ? input.content : null;
          if (content === null) throw new Error('invalid arguments: "content" must be a string');
          await this.storage.put(fileRootKey(root, path), Buffer.from(content, 'utf8'), 'text/plain');
          return `wrote ${Buffer.byteLength(content)} bytes to ${path}`;
        },
      },
      {
        name: 'fs_delete',
        description: 'Delete a file from your file store.',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        readOnly: false,
        execute: async (root, input) => {
          const path = str(input, 'path');
          assertMutablePath(root, path);
          await this.storage.delete(fileRootKey(root, path));
          return `deleted ${path}`;
        },
      },
      {
        name: 'fs_search',
        description: 'Search text file contents in your file store. Returns matching lines as "path:line: text".',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string', description: 'Case-insensitive substring to find' } },
          required: ['query'],
        },
        readOnly: true,
        execute: async (root, input) => {
          const query = str(input, 'query').toLowerCase();
          const objects = (await this.storage.list(rootPrefix(root))).slice(0, SEARCH_MAX_FILES);
          const hits: string[] = [];
          for (const obj of objects) {
            if (obj.size > SEARCH_FILE_CAP) continue;
            const body = await this.storage.get(obj.key);
            if (!body || body.includes(0)) continue; // skip binary
            const path = rootRelative(root, obj.key);
            const lines = body.toString('utf8').split('\n');
            for (let i = 0; i < lines.length && hits.length < SEARCH_MAX_HITS; i++) {
              if (lines[i].toLowerCase().includes(query)) {
                hits.push(`${path}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
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
          const url = assertPublicUrl(str(input, 'url'));
          const res = await fetch(url, {
            headers: { 'user-agent': 'Mozilla/5.0 (yaam-chat research tool)' },
            signal: AbortSignal.timeout(20_000),
            redirect: 'follow',
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
        description: 'Create a self-contained HTML slide deck in your file store. Slides: [{ title, bullets?, notes? }]. Arrow keys navigate; "n" toggles notes.',
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
          const path = str(input, 'path');
          assertMutablePath(root, path);
          const { title, slides } = validateSlides(input.title, input.slides);
          const html = renderSlidesHtml(title, slides);
          await this.storage.put(fileRootKey(root, path), Buffer.from(html, 'utf8'), 'text/html');
          return `created a ${slides.length}-slide deck "${title}" at ${path} (${Buffer.byteLength(html)} bytes)`;
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
          const url = assertPublicUrl(str(input, 'url'));
          const method = (str(input, 'method', false) || 'GET').toUpperCase();
          const headers = (input.headers && typeof input.headers === 'object' ? input.headers : {}) as Record<string, string>;
          const res = await fetch(url, {
            method,
            headers,
            body: typeof input.body === 'string' && method !== 'GET' && method !== 'HEAD' ? input.body : undefined,
            signal: AbortSignal.timeout(30_000),
            redirect: 'follow',
          });
          const text = await res.text();
          const capped = text.length > HTTP_CAP ? `${text.slice(0, HTTP_CAP)}\n…(truncated)` : text;
          return `${res.status} ${res.statusText}\n${capped}`;
        },
      },
    ];
  }

  specs(): AiToolSpec[] {
    return this.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  }

  /** undefined = unknown tool. */
  isReadOnly(name: string): boolean | undefined {
    return this.tools.find((t) => t.name === name)?.readOnly;
  }

  /** A bare string is a workspace id (test convenience + back-compat). */
  async execute(root: FileRoot | string, name: string, input: Record<string, unknown>): Promise<string> {
    const tool = this.tools.find((t) => t.name === name);
    if (!tool) throw new Error(`unknown tool: ${name}`);
    return tool.execute(typeof root === 'string' ? { kind: 'workspace', id: root } : root, input);
  }
}

export { assertPublicUrl };
