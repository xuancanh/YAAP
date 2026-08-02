/** MCP (§10.3): Streamable-HTTP client, discovery caching, tool exposure,
 *  routing, and the Ask-mode gate for MCP calls. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ConfigService } from '@nestjs/config';
import { McpAuthRequiredError, McpHttpClient } from '../server/src/mcp/mcp-client';
import { McpService } from '../server/src/mcp/mcp.module';
import { discoverAuth } from '../server/src/mcp/mcp-oauth';
import { setAddressLookup } from '../server/src/common/url-guard';
import { mcpServers } from '../server/src/database/schema';
import { open } from '../server/src/common/secretbox';

// offline test run: every hostname "resolves" to a public address
setAddressLookup(async () => [{ address: '93.184.216.34', family: 4 }]);

const mcpConfigStub = {
  get: (key: string) => ({ publicBaseUrl: 'http://localhost:8790' })[key],
} as unknown as ConfigService;
import { ChatsRepository } from '../server/src/chats/chats.repository';
import { ChatsService } from '../server/src/chats/chats.service';
import { TurnLoopService, TurnEvent } from '../server/src/chats/turn-loop.service';
import { ChatLocks } from '../server/src/chats/chat-locks';
import { ToolsService } from '../server/src/chats/tools.service';
import { testDb, memStorage, ctxStub, skillsStub, agentsStub, ScriptedProvider, wsStub } from './helpers';
import { AiStreamEvent } from '../server/src/ai/ai-provider.interface';

/** A tiny in-memory MCP server speaking Streamable HTTP JSON-RPC. */
function fakeMcpServer(tools: Array<{ name: string; description: string }>, callResult = 'it worked') {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const fn = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const req = JSON.parse(String(init?.body)) as { id?: number; method: string; params: Record<string, unknown> };
    calls.push({ method: req.method, params: req.params });
    if (req.method === 'notifications/initialized') return new Response(null, { status: 202 });
    const result =
      req.method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'fake' } }
        : req.method === 'tools/list' ? { tools: tools.map((t) => ({ ...t, inputSchema: { type: 'object', properties: { q: { type: 'string' } } } })) }
          : req.method === 'tools/call' ? { content: [{ type: 'text', text: callResult }] }
            : {};
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' },
    });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

test('client initializes, lists tools, calls tools, and carries the session id', async () => {
  const { fn, calls } = fakeMcpServer([{ name: 'search-issues', description: 'Search the tracker' }]);
  const client = new McpHttpClient('https://mcp.example.com/mcp', fn);
  const tools = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name), ['search-issues']);

  const out = await client.callTool('search-issues', { q: 'bug' });
  assert.equal(out, 'it worked');
  assert.deepEqual(calls.map((c) => c.method), ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
});

test('client parses SSE-framed responses and surfaces JSON-RPC errors', async () => {
  let n = 0;
  const fn = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const req = JSON.parse(String(init?.body)) as { id?: number; method: string };
    n++;
    if (req.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (req.method === 'initialize') {
      return new Response(`data: ${JSON.stringify({ jsonrpc: '2.0', id: req.id, result: {} })}\n\n`, {
        status: 200, headers: { 'content-type': 'text/event-stream' },
      });
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32000, message: 'nope' } }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  const client = new McpHttpClient('https://mcp.example.com/mcp', fn);
  await assert.rejects(client.listTools(), /nope/);
  assert.ok(n >= 3);
});

test('stdio URLs are rejected', () => {
  assert.throws(() => new McpHttpClient('stdio://mcp-fs'), /only http\(s\)/);
});

test('create/update refuse private server URLs (SSRF guard)', async () => {
  const db = await testDb();
  const mcp = new McpService(db, mcpConfigStub);
  for (const url of [
    'http://169.254.169.254/mcp',
    'http://10.0.0.5/mcp',
    'http://[::ffff:127.0.0.1]/mcp',
    'http://[fe80::1]/mcp',
    'http://localhost:8790/mcp',
  ]) {
    await assert.rejects(mcp.create({ name: 'bad', url }), /private\/internal/);
  }
  const server = await mcp.create({ name: 'good', url: 'https://mcp.example.com/mcp' });
  await assert.rejects(mcp.update(server.id, { url: 'http://192.168.1.1/mcp' }), /private\/internal/);
  assert.equal((await mcp.listPublic())[0].url, 'https://mcp.example.com/mcp', 'rejected update leaves the URL unchanged');
});

test('OAuth discovery refuses metadata pointing at internal targets', async () => {
  const fetchImpl = (async (url: RequestInfo | URL) => {
    const u = String(url);
    if (u.includes('oauth-protected-resource')) {
      return new Response(JSON.stringify({ authorization_servers: ['https://auth.example.com'] }), { status: 200 });
    }
    return new Response(JSON.stringify({
      authorization_endpoint: 'https://auth.example.com/authorize',
      token_endpoint: 'http://169.254.169.254/token',
    }), { status: 200 });
  }) as unknown as typeof fetch;
  await assert.rejects(
    discoverAuth('https://mcp.example.com/mcp', '', fetchImpl),
    /private\/internal/,
  );
});

test('discover caches tools on the row; specs and routing use the cache', async () => {
  const db = await testDb();
  const mcp = new McpService(db, mcpConfigStub);
  const { fn } = fakeMcpServer([{ name: 'get-weather', description: 'Weather lookup' }], 'sunny, 21C');
  mcp.clientFactory = (url) => new McpHttpClient(url, fn);

  const server = await mcp.create({ name: 'Weather API', url: 'https://mcp.example.com/mcp' });
  const { tools } = await mcp.discover(server.id);
  assert.equal(tools.length, 1);

  const specs = await mcp.toolSpecs();
  assert.equal(specs.length, 1);
  assert.equal(specs[0].name, 'mcp_weather_api_get_weather');
  assert.match(specs[0].description, /\[MCP · Weather API\]/);

  assert.equal(await mcp.execute('mcp_weather_api_get_weather', { q: 'hanoi' }), 'sunny, 21C');
  await assert.rejects(mcp.execute('mcp_weather_api_no_such', {}), /unknown tool/);

  // disabled servers offer nothing
  await mcp.update(server.id, { enabled: false });
  assert.equal((await mcp.toolSpecs()).length, 0);
});

test('turn loop offers MCP tools and gates them behind approval in Ask mode (FR-10.3/4.2)', async () => {
  const db = await testDb();
  const mcp = new McpService(db, mcpConfigStub);
  const { fn } = fakeMcpServer([{ name: 'send-alert', description: 'Pages someone' }], 'alert sent');
  mcp.clientFactory = (url) => new McpHttpClient(url, fn);
  const server = await mcp.create({ name: 'pager', url: 'https://mcp.example.com/mcp' });
  await mcp.discover(server.id);

  const repo = new ChatsRepository(db);
  const chats = new ChatsService(repo, agentsStub());
  const mcpRound: AiStreamEvent[] = [
    { type: 'tool_call', id: 'm1', name: 'mcp_pager_send_alert', input: { q: 'wake up' } },
    { type: 'done' },
  ];
  const finalRound: AiStreamEvent[] = [{ type: 'answer', text: 'paged.' }, { type: 'done' }];
  const provider = new ScriptedProvider([mcpRound, finalRound]);
  const { stub } = memStorage();
  const turns = new TurnLoopService(repo, new ChatLocks(), new ToolsService(stub), ctxStub(provider), skillsStub(), stub, mcp, agentsStub(), wsStub());

  const s = await chats.create({ workspaceId: 'ws1' }); // ask mode default
  let paused = false;
  const events: TurnEvent[] = [];
  for await (const ev of turns.run(s.id, { text: 'page the on-call' })) {
    events.push(ev);
    if (ev.type === 'approval_required') {
      paused = true;
      assert.equal(ev.tool, 'mcp_pager_send_alert');
      turns.resolveApproval(s.id, ev.callId, 'allow-once');
    }
  }
  assert.ok(paused, 'MCP call paused for approval in Ask mode');
  assert.ok(provider.requests[0].tools!.some((t) => t.name === 'mcp_pager_send_alert'));
  const result = events.find((e) => e.type === 'tool_result');
  assert.ok(result && !result.isError);
  assert.equal(result.output, 'alert sent');
});

test('client sends bearer tokens and raises a typed error on 401 (M4)', async () => {
  const auths: Array<string | null> = [];
  const fn = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string>;
    auths.push(headers.authorization ?? null);
    if (!headers.authorization) {
      return new Response('unauthorized', {
        status: 401,
        headers: { 'www-authenticate': 'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"' },
      });
    }
    const req = JSON.parse(String(init?.body)) as { id?: number; method: string };
    if (req.method === 'notifications/initialized') return new Response(null, { status: 202 });
    const result = req.method === 'tools/list' ? { tools: [] } : {};
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  const anon = new McpHttpClient('https://mcp.example.com/mcp', fn);
  await assert.rejects(anon.listTools(), (err: unknown) => {
    assert.ok(err instanceof McpAuthRequiredError);
    assert.match(err.wwwAuthenticate, /resource_metadata/);
    return true;
  });

  const authed = new McpHttpClient('https://mcp.example.com/mcp', fn, async () => 'tok-42');
  await authed.listTools();
  assert.ok(auths.some((a) => a === 'Bearer tok-42'));
});

test('OAuth 2.1 flow: discovery, dynamic registration, PKCE exchange, sealed tokens (M4)', async () => {
  const db = await testDb();
  const svc = new McpService(db, mcpConfigStub);
  const server = await svc.create({ name: 'Linear', url: 'https://mcp.linear.app/mcp' });

  // the MCP server itself always answers 401 until a token arrives
  svc.clientFactory = (url, getToken) => new McpHttpClient(url, (async (_u: RequestInfo | URL, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string>;
    if (!headers.authorization) {
      return new Response('unauthorized', { status: 401, headers: { 'www-authenticate': 'Bearer resource_metadata="https://mcp.linear.app/.well-known/oauth-protected-resource/mcp"' } });
    }
    const req = JSON.parse(String(init?.body)) as { id?: number; method: string };
    if (req.method === 'notifications/initialized') return new Response(null, { status: 202 });
    const result = req.method === 'tools/list' ? { tools: [{ name: 'list_issues', description: 'x' }] } : {};
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch, getToken);

  // the discovery/registration/token HTTP surface
  const hits: Array<{ url: string; body?: string }> = [];
  svc.fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    hits.push({ url: u, body: init?.body ? String(init.body) : undefined });
    if (u.includes('oauth-protected-resource')) {
      return new Response(JSON.stringify({ resource: 'https://mcp.linear.app/mcp', authorization_servers: ['https://auth.linear.app'] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('oauth-authorization-server')) {
      return new Response(JSON.stringify({
        authorization_endpoint: 'https://auth.linear.app/authorize',
        token_endpoint: 'https://auth.linear.app/token',
        registration_endpoint: 'https://auth.linear.app/register',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('/register')) {
      return new Response(JSON.stringify({ client_id: 'client-abc' }), { status: 201, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('/token')) {
      return new Response(JSON.stringify({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;

  const { url } = await svc.oauthStart(server.id);
  const authorize = new URL(url);
  assert.equal(authorize.origin + authorize.pathname, 'https://auth.linear.app/authorize');
  assert.equal(authorize.searchParams.get('client_id'), 'client-abc');
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorize.searchParams.get('resource'), 'https://mcp.linear.app/mcp');
  const state = authorize.searchParams.get('state')!;

  await assert.rejects(svc.oauthCallback('code-1', 'forged'), /unknown or expired/);
  await svc.oauthCallback('code-1', state);

  // the exchange carried the PKCE verifier and the resource indicator
  const tokenHit = hits.find((h) => h.url.includes('/token'))!;
  assert.match(tokenHit.body!, /code_verifier=/);
  assert.match(tokenHit.body!, /resource=https%3A%2F%2Fmcp.linear.app%2Fmcp/);

  // tokens are sealed on the row and redacted from the public listing
  const [row] = await db.select().from(mcpServers);
  assert.equal(open(row.authAccessToken), 'at-1');
  assert.equal(open(row.authRefreshToken), 'rt-1');
  const pub = (await svc.listPublic())[0] as Record<string, unknown>;
  assert.equal(pub.authStatus, 'connected');
  assert.ok(!('authAccessToken' in pub) && !('authRefreshToken' in pub) && !('authClientSecret' in pub));

  // discovery now succeeds with the bearer token flowing through
  const { tools } = await svc.discover(server.id);
  assert.deepEqual(tools.map((t) => t.name), ['list_issues']);
});
