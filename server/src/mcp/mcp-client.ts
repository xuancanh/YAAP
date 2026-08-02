/**
 * Minimal MCP client over the Streamable HTTP transport (§10.3): JSON-RPC
 * POSTs to the server URL, accepting both plain-JSON and SSE-framed
 * responses, with the mcp-session-id header carried across calls. Covers the
 * slice the chat needs — initialize, tools/list, tools/call — with an
 * injectable fetch for tests. stdio:// servers are not supported in the web
 * backend (they would mean spawning arbitrary configured commands).
 */
export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface JsonRpcResponse {
  id?: number | string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

const PROTOCOL_VERSION = '2025-03-26';

/** The server answered 401: OAuth is required (MCP authorization spec).
 *  Carries the WWW-Authenticate header so discovery can start from its
 *  resource_metadata hint (RFC 9728). */
export class McpAuthRequiredError extends Error {
  constructor(readonly serverUrl: string, readonly wwwAuthenticate: string) {
    super('mcp server requires authorization — connect it from the Market or Settings');
  }
}

/** The server lost our session (restart): HTTP 404 on a session call, or an
 *  initialize-required style JSON-RPC error. The client re-initializes and
 *  retries the call once, transparently. */
export class McpSessionExpiredError extends Error {}

/** Error messages that mean "this session is gone, initialize again". */
const SESSION_ERROR_RE = /not initialized|requires? initializ|unknown session|invalid session|session (not found|expired|terminated)/i;

export class McpHttpClient {
  private sessionId: string | null = null;
  private initialized = false;
  private nextId = 1;

  constructor(
    private readonly url: string,
    private readonly fetchFn: typeof fetch = fetch,
    /** Resolves the bearer token for this server, or null when none. */
    private readonly getToken: () => Promise<string | null> = async () => null,
  ) {
    if (!/^https?:\/\//.test(url)) {
      throw new Error('only http(s) MCP servers are supported (stdio needs a local runner)');
    }
  }

  private async rpc(method: string, params: Record<string, unknown>, notification = false): Promise<Record<string, unknown>> {
    const id = notification ? undefined : this.nextId++;
    const token = await this.getToken();
    const res = await this.fetchFn(this.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': PROTOCOL_VERSION,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        // initialize must not carry a (possibly stale) session id.
        ...(this.sessionId && method !== 'initialize' ? { 'mcp-session-id': this.sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', ...(id !== undefined ? { id } : {}), method, params }),
      signal: AbortSignal.timeout(20_000),
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    if (res.status === 401) {
      throw new McpAuthRequiredError(this.url, res.headers.get('www-authenticate') ?? '');
    }
    if (res.status === 404 && this.sessionId && method !== 'initialize') {
      throw new McpSessionExpiredError(`mcp ${method}: session gone (404)`);
    }
    if (res.status === 202 || notification) return {};
    if (!res.ok) throw new Error(`mcp ${method} failed: ${res.status} ${(await res.text()).slice(0, 200)}`);

    const type = res.headers.get('content-type') ?? '';
    let payload: JsonRpcResponse | undefined;
    if (type.includes('text/event-stream')) {
      // find the SSE data event carrying our response id
      const text = await res.text();
      for (const chunk of text.split('\n\n')) {
        const data = chunk.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
        if (!data) continue;
        try {
          const parsed = JSON.parse(data) as JsonRpcResponse;
          if (parsed.id === id) { payload = parsed; break; }
        } catch { /* keep scanning */ }
      }
    } else {
      payload = await res.json() as JsonRpcResponse;
    }
    if (!payload) throw new Error(`mcp ${method}: no response for request ${id}`);
    if (payload.error) {
      if (SESSION_ERROR_RE.test(payload.error.message)) {
        throw new McpSessionExpiredError(`mcp ${method}: ${payload.error.message}`);
      }
      throw new Error(`mcp ${method}: ${payload.error.message}`);
    }
    return payload.result ?? {};
  }

  /** Run an rpc; on a session-level failure (server restarted) reset the
   *  cached session, re-initialize, and retry the call once. */
  private async withSessionRecovery<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (err) {
      if (!(err instanceof McpSessionExpiredError)) throw err;
      this.initialized = false;
      this.sessionId = null;
      await this.initialize();
      return await call();
    }
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.rpc('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'yaam-chat', version: '0.1.0' },
    });
    await this.rpc('notifications/initialized', {}, true);
    this.initialized = true;
  }

  async listTools(): Promise<McpToolDef[]> {
    await this.initialize();
    const result = await this.withSessionRecovery(() => this.rpc('tools/list', {}));
    return ((result.tools as McpToolDef[] | undefined) ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
    }));
  }

  /** Returns concatenated text content; throws when the server marks an error. */
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    await this.initialize();
    const result = await this.withSessionRecovery(() => this.rpc('tools/call', { name, arguments: args }));
    const content = (result.content as Array<{ type: string; text?: string }> | undefined) ?? [];
    const text = content.filter((c) => c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n')
      || JSON.stringify(result).slice(0, 2_000);
    if (result.isError) throw new Error(text.slice(0, 500));
    return text;
  }
}
