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
import { workspaceFileKey, workspacePrefix, relativePath } from '../storage/storage.keys';
import { AiToolSpec } from '../ai/ai-provider.interface';

const READ_CAP = 50_000;
const HTTP_CAP = 20_000;

interface ChatTool extends AiToolSpec {
  readOnly: boolean;
  execute(workspaceId: string, input: Record<string, unknown>): Promise<string>;
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
        description: 'List files in the workspace file store. Returns one "path (size bytes)" per line.',
        inputSchema: { type: 'object', properties: { prefix: { type: 'string', description: 'Optional path prefix filter' } } },
        readOnly: true,
        execute: async (ws, input) => {
          const prefix = typeof input.prefix === 'string' && input.prefix.length > 0
            ? workspaceFileKey(ws, input.prefix)
            : workspacePrefix(ws);
          const objects = await this.storage.list(prefix);
          if (objects.length === 0) return '(no files)';
          return objects.map((o) => `${relativePath(ws, o.key)} (${o.size} bytes)`).join('\n');
        },
      },
      {
        name: 'fs_read',
        description: 'Read a text file from the workspace file store.',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        readOnly: true,
        execute: async (ws, input) => {
          const body = await this.storage.get(workspaceFileKey(ws, str(input, 'path')));
          if (body === null) return `file not found: ${input.path}`;
          const text = body.toString('utf8');
          return text.length > READ_CAP ? `${text.slice(0, READ_CAP)}\n…(truncated)` : text;
        },
      },
      {
        name: 'fs_write',
        description: 'Write (create or overwrite) a text file in the workspace file store.',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' }, content: { type: 'string' } },
          required: ['path', 'content'],
        },
        readOnly: false,
        execute: async (ws, input) => {
          const path = str(input, 'path');
          const content = typeof input.content === 'string' ? input.content : null;
          if (content === null) throw new Error('invalid arguments: "content" must be a string');
          await this.storage.put(workspaceFileKey(ws, path), Buffer.from(content, 'utf8'), 'text/plain');
          return `wrote ${Buffer.byteLength(content)} bytes to ${path}`;
        },
      },
      {
        name: 'fs_delete',
        description: 'Delete a file from the workspace file store.',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        readOnly: false,
        execute: async (ws, input) => {
          const path = str(input, 'path');
          await this.storage.delete(workspaceFileKey(ws, path));
          return `deleted ${path}`;
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
        execute: async (_ws, input) => {
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

  async execute(workspaceId: string, name: string, input: Record<string, unknown>): Promise<string> {
    const tool = this.tools.find((t) => t.name === name);
    if (!tool) throw new Error(`unknown tool: ${name}`);
    return tool.execute(workspaceId, input);
  }
}
